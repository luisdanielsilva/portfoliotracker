/**
 * Schema changes that must apply to an existing database, shared by the server
 * and the price-fetch job because either may open the file first.
 *
 * schema.sqlite.sql only uses CREATE TABLE IF NOT EXISTS, so it cannot add a
 * column to a table that already exists — that is what these are for. Every one
 * must be idempotent and safe to run on every boot.
 */

function columnNames(db, table) {
  return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(c => c.name);
}

/**
 * Record what currency a price is actually quoted in.
 *
 * The fetcher used to assume every quote was USD and multiply by a fixed rate to
 * get euros. That is right for a NASDAQ listing and wrong for a European one:
 * ASML.AS and SAP.DE are quoted in EUR, so converting them "to" EUR scaled a
 * correct number by 0.92. Nothing held today is affected, but the bug was live.
 *
 * Existing rows are all USD-quoted, so backfilling 'USD' and copying price_usd
 * into price_native is accurate rather than a guess.
 */
function ensurePriceCurrencyColumns(db) {
  const cols = columnNames(db, 'prices');
  if (!cols.includes('currency')) {
    db.exec("ALTER TABLE prices ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
  }
  if (!cols.includes('price_native')) {
    db.exec('ALTER TABLE prices ADD COLUMN price_native REAL');
    db.exec('UPDATE prices SET price_native = price_usd WHERE price_native IS NULL');
  }
}

/**
 * Give price thresholds a currency, and restate existing ones so they keep
 * meaning what their author meant.
 *
 * Thresholds used to be compared against the euro-converted price, so "TSLA
 * above 350" meant €350. Now that prices are shown and compared in the market's
 * own currency, leaving the number alone would silently redefine that rule as
 * $350 — roughly an 8% shift, and it could fire immediately. Each existing
 * threshold is therefore converted using the ratio actually observed in the
 * price row, not a fresh rate, so the rule keeps its original meaning.
 *
 * Percentage rules (dip_from_avg_cost, change_pct) have no currency: the
 * threshold is a percentage, and a dip is measured against the euro cost basis.
 */
function ensureAlertCurrency(db) {
  if (columnNames(db, 'alerts').includes('currency')) return;
  db.exec('ALTER TABLE alerts ADD COLUMN currency TEXT');

  const priceOf = db.prepare(
    'SELECT currency, price_eur, price_native FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1'
  );
  const update = db.prepare('UPDATE alerts SET threshold = ?, currency = ? WHERE id = ?');
  const rows = db.prepare(
    "SELECT id, ticker, threshold FROM alerts WHERE rule_type IN ('price_above','price_below')"
  ).all();

  for (const row of rows) {
    const p = priceOf.get(row.ticker);
    const currency = p && p.currency ? p.currency : 'USD';
    let threshold = row.threshold;
    if (currency !== 'EUR' && p && p.price_eur > 0 && p.price_native > 0) {
      threshold = parseFloat((row.threshold * (p.price_native / p.price_eur)).toFixed(4));
    }
    update.run(threshold, currency, row.id);
    if (threshold !== row.threshold) {
      console.log(`Alert ${row.id} (${row.ticker}): threshold €${row.threshold} restated as ${threshold} ${currency}`);
    }
  }
}

/**
 * Allow the sell-side rule type.
 *
 * The tool exists to average in below cost *and* to sell near the tops, but every
 * rule was a buy signal. gain_from_avg_cost is the exact mirror of
 * dip_from_avg_cost: it fires when a holding is up X% on what you actually paid,
 * so a take-profit level follows your cost basis instead of being an absolute
 * price that goes stale as you keep buying.
 *
 * SQLite cannot ALTER a CHECK constraint, so the table is rebuilt — the same
 * approach used when dip_from_avg_cost was added.
 */
function ensureGainRuleType(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='alerts'").get();
  if (!row || row.sql.includes('gain_from_avg_cost')) return;

  const hasCurrency = columnNames(db, 'alerts').includes('currency');
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE alerts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ticker TEXT NOT NULL,
        rule_type TEXT NOT NULL CHECK(rule_type IN ('price_above','price_below','change_pct','dip_from_avg_cost','gain_from_avg_cost')),
        threshold REAL NOT NULL,
        currency TEXT,
        enabled BOOLEAN DEFAULT 1,
        last_triggered_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO alerts_new (id,user_id,ticker,rule_type,threshold,currency,enabled,last_triggered_at,created_at)
        SELECT id,user_id,ticker,rule_type,threshold,${hasCurrency ? 'currency' : 'NULL'},enabled,last_triggered_at,created_at FROM alerts;
      DROP TABLE alerts;
      ALTER TABLE alerts_new RENAME TO alerts;
      CREATE INDEX IF NOT EXISTS idx_user_ticker_alert ON alerts(user_id, ticker);
      CREATE INDEX IF NOT EXISTS idx_enabled ON alerts(enabled);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_unique ON alerts(user_id, ticker, rule_type, threshold);
      COMMIT;
    `);
    const problems = db.pragma('foreign_key_check');
    if (problems.length) throw new Error('foreign key check failed after alerts rebuild');
    console.log('Migrated alerts table to support gain_from_avg_cost');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Allow the trailing rule type.
 *
 * drop_from_high fires when a price falls X% below its high over the past year —
 * the 52-week high, the standard reference for "how far off the top is this". It is
 * the one rule that protects a gain: a target tied to cost basis says nothing once a
 * holding has run up, and a fixed price level goes stale as the stock moves.
 */
function ensureDropFromHighRuleType(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='alerts'").get();
  if (!row || row.sql.includes('drop_from_high')) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE alerts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ticker TEXT NOT NULL,
        rule_type TEXT NOT NULL CHECK(rule_type IN ('price_above','price_below','change_pct','dip_from_avg_cost','gain_from_avg_cost','drop_from_high')),
        threshold REAL NOT NULL,
        currency TEXT,
        enabled BOOLEAN DEFAULT 1,
        last_triggered_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO alerts_new (id,user_id,ticker,rule_type,threshold,currency,enabled,last_triggered_at,created_at)
        SELECT id,user_id,ticker,rule_type,threshold,currency,enabled,last_triggered_at,created_at FROM alerts;
      DROP TABLE alerts;
      ALTER TABLE alerts_new RENAME TO alerts;
      CREATE INDEX IF NOT EXISTS idx_user_ticker_alert ON alerts(user_id, ticker);
      CREATE INDEX IF NOT EXISTS idx_enabled ON alerts(enabled);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_unique ON alerts(user_id, ticker, rule_type, threshold);
      COMMIT;
    `);
    const problems = db.pragma('foreign_key_check');
    if (problems.length) throw new Error('foreign key check failed after alerts rebuild');
    console.log('Migrated alerts table to support drop_from_high');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** Highest close over the trailing window, in the market's own currency. */
const HIGH_WINDOW_DAYS = 365;
function recentHigh(db, ticker, days = HIGH_WINDOW_DAYS) {
  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const row = db.prepare(`
    SELECT price_native AS peak, price_eur AS peakEur, price_date AS peakDate
    FROM prices WHERE ticker = ? AND price_date >= ? AND price_native IS NOT NULL
    ORDER BY price_native DESC LIMIT 1
  `).get(ticker, from);
  return row && row.peak ? row : null;
}


/**
 * Settings and state for the Algorithm tab's own alerts.
 *
 * These alerts are deliberately not rows in `alerts`. That table is the one the
 * user builds by hand, one rule per holding, and it is theirs to fill with
 * whatever they like. The algorithm's alert is fixed behaviour that applies to
 * every holding at once — putting it in the same list would invite editing the
 * thing that is meant not to be edited, and would make "delete all my alerts"
 * silently switch the algorithm off too.
 *
 * Two timings are the user's, because they are about how often they want to hear
 * from it rather than about what the signal means:
 *   algo_hold_days     — how many consecutive readings before it counts
 *   algo_cooldown_days — how long the same holding then stays quiet (calendar days)
 */
function ensureAlgorithmAlertSettings(db) {
  // Since the split there is no users table on the financial side — the settings
  // moved to user_settings and the identity lives in another file entirely. The
  // column work below only applies to a pre-split database.
  const hasUsers = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'"
  ).get();
  const cols = hasUsers ? columnNames(db, 'users') : ['algo_hold_days', 'algo_cooldown_days', 'algo_alerts_enabled', 'last_seen_at'];
  if (!cols.includes('algo_hold_days')) {
    db.exec('ALTER TABLE users ADD COLUMN algo_hold_days INTEGER NOT NULL DEFAULT 3');
  }
  if (!cols.includes('algo_cooldown_days')) {
    db.exec('ALTER TABLE users ADD COLUMN algo_cooldown_days INTEGER NOT NULL DEFAULT 60');
  }
  // When this account was last actually here. The only login signal before this
  // was sessions.created_at, which the daily credential purge deletes — so who is
  // dormant was being forgotten as fast as it was learned. Recorded now because
  // it cannot be recovered later: the decision to fetch prices less often for
  // nobody's benefit needs to know who nobody is.
  if (!cols.includes('last_seen_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_seen_at DATETIME');
  }
  if (!cols.includes('algo_alerts_enabled')) {
    db.exec('ALTER TABLE users ADD COLUMN algo_alerts_enabled INTEGER NOT NULL DEFAULT 1');
  }

  // Every change to the two timings, kept so the signal history can be read
  // against the settings that were in force at the time. Without this, a chart
  // showing "it emailed here, and not there" is unreadable — the reason is
  // usually that the rules changed in between, and nothing recorded that.
  db.exec(`
    CREATE TABLE IF NOT EXISTS algo_settings_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      field TEXT NOT NULL,
      old_value INTEGER,
      new_value INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_algo_settings_user ON algo_settings_log(user_id, changed_at DESC);
  `);

  // One row per holding per time it spoke. The cooldown reads the newest row;
  // keeping the history means "why did I not hear about this?" is answerable.
  db.exec(`
    CREATE TABLE IF NOT EXISTS algo_alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      ticker TEXT NOT NULL,
      fired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      signal_date DATE NOT NULL,
      tier TEXT NOT NULL,
      direction TEXT NOT NULL,
      confidence REAL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_algo_log_user_ticker ON algo_alert_log(user_id, ticker, fired_at DESC);
  `);
}


/**
 * The log of alerts actually given — see alert-log.js for what counts as one.
 *
 * Created here as well as in schema.sqlite.sql because a database that already
 * exists never re-runs the schema file, and both the server and the price job
 * may be the process that opens it first.
 *
 * `algo_alert_log` is the same record for the algorithm alone, and it is folded
 * in rather than left behind: without the carry-forward the algorithm's cooldown
 * would read an empty table on the first boot after this change and could email
 * a holding that was meant to stay quiet for another two months. Matching on
 * (user, ticker, fired_at) makes the copy safe to run on every boot.
 */
function ensureAlertEventLog(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('rule','algo')),
      alert_type TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('buy','sell','watch')),
      alert_id INTEGER,
      fired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      signal_date DATE,
      price_native REAL,
      price_eur REAL,
      currency TEXT,
      threshold REAL,
      avg_cost_eur REAL,
      detail TEXT,
      delivery TEXT NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','sent','not_sent','failed')),
      delivered_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_alert_events_user ON alert_events(user_id, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_events_user_ticker ON alert_events(user_id, ticker, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_events_source ON alert_events(source, fired_at DESC);
  `);

  const legacy = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'algo_alert_log'"
  ).get();
  if (!legacy) return;

  // Older rows carry no price — they were written before the log had one — so
  // those columns stay null rather than being filled in from today's prices.
  // They arrive as 'pending' for the same reason: the old table recorded that an
  // alert was raised and never what became of the email, and 'pending' is what
  // this column means by "unknown". Marking them 'sent' would be inventing a
  // delivery that nothing here witnessed.
  const copied = db.prepare(`
    INSERT INTO alert_events
      (user_id, ticker, source, alert_type, direction, fired_at, signal_date, detail, delivery)
    SELECT CAST(l.user_id AS TEXT), l.ticker, 'algo', 'algo',
           CASE lower(l.direction) WHEN 'sell' THEN 'sell' ELSE 'buy' END,
           l.fired_at, l.signal_date,
           json_object('tier', l.tier, 'confidence', l.confidence, 'carriedFrom', 'algo_alert_log'),
           'pending'
    FROM algo_alert_log l
    WHERE NOT EXISTS (
      SELECT 1 FROM alert_events e
       WHERE e.source = 'algo' AND e.user_id = CAST(l.user_id AS TEXT)
         AND e.ticker = l.ticker AND e.fired_at = l.fired_at
    )
  `).run().changes;
  if (copied) console.log(`alert_events: carried ${copied} row(s) forward from algo_alert_log`);
}


/**
 * Stocks somebody follows without owning — candidates to buy, or positions they
 * have left and still want to hear about.
 *
 * The only interesting column is the reference price. Two of the four alert
 * rules — Dip and Target — are measured against what you paid, and on a stock
 * you never bought there is no such number. Rather than deny those rules to a
 * watched stock, the watchlist records a price to measure from: whatever it cost
 * the day it was added, a figure typed by hand, or, when a position is closed,
 * the average cost actually paid. `reference_source` says which of the three it
 * is, because "€174" means something different in each case and a reader months
 * later cannot tell them apart from the number alone.
 *
 * Deliberately *not* here: a holding's cost basis. A stock that is both held and
 * watched resolves to its cost basis, always — see referenceFor() in
 * reference-price.js. Storing a second number for a held stock would create two
 * answers to one question, and the wrong one would eventually win.
 */
function ensureWatchlist(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      reference_price_eur REAL,
      reference_price_native REAL,
      currency TEXT,
      reference_source TEXT NOT NULL DEFAULT 'spotted'
        CHECK(reference_source IN ('spotted','typed','carried')),
      note TEXT,
      added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_unique ON watchlist(user_id, ticker);
    CREATE INDEX IF NOT EXISTS idx_watchlist_ticker ON watchlist(ticker);
  `);
}


/**
 * A single counter bumped whenever anything the computed views depend on
 * changes. It is what makes caching those views safe across processes: a cache
 * entry is keyed by this number, so a write in one process retires every other
 * process's copy without any of them having to talk to each other.
 *
 * Coarse on purpose — one number for the whole database rather than one per
 * user. Over-invalidating costs a recomputation; under-invalidating serves
 * somebody yesterday's portfolio.
 */
function ensureDataVersion(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT OR IGNORE INTO data_version (id, version) VALUES (1, 1)').run();
}

module.exports = {
  ensurePriceCurrencyColumns, ensureAlertCurrency, ensureGainRuleType,
  ensureDropFromHighRuleType, ensureAlgorithmAlertSettings, ensureAlertEventLog, ensureDataVersion,
  ensureWatchlist,
  recentHigh, HIGH_WINDOW_DAYS, columnNames
};
