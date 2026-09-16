#!/usr/bin/env node
/**
 * One-time split of data.db into identity.db and portfolio.db.
 *
 * WHY. Today a single file holds both the email addresses and everything those
 * people own. Separating them means a leak of one file is not a leak of both —
 * exactly the accident of 2026-09-11, when the whole directory was briefly served
 * over HTTPS, would have exposed holdings with no names attached. It also makes
 * deleting a person one row rather than a hunt, and makes the financial data
 * shareable for debugging without carrying anyone's address along with it.
 *
 * It is NOT a defence against losing the server: both files sit on the same disk,
 * in the same process, in the same backup, under the same passphrase.
 *
 * THE KEY IS RANDOM, NOT A HASH OF THE EMAIL. Addresses are guessable, so a hash
 * of one is not pseudonymous — anybody holding the financial file could test
 * sha256("someone@gmail.com") against every row until it matched. A UUID cannot
 * be reversed because it is not derived from anything.
 *
 * SAFETY. This only ever reads data.db. The two new files are written fresh, and
 * the original is left exactly as it was, so the rollback is to point DB_PATH
 * back at it and restart.
 *
 *   node split-databases.js            # writes identity.db and portfolio.db
 *   node split-databases.js --verify   # re-checks an existing split
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const APP_DIR = __dirname;
const SOURCE = process.env.DB_PATH || path.join(APP_DIR, 'data.db');
const IDENTITY = path.join(APP_DIR, 'identity.db');
const PORTFOLIO = path.join(APP_DIR, 'portfolio.db');

const IDENTITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_user_key ON users(user_key);

CREATE TABLE IF NOT EXISTS login_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_token_hash ON login_tokens(token_hash);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_user ON sessions(user_id);
`;

/**
 * user_id here is the opaque key, as TEXT. Deliberately keeping the column name
 * means every existing query against these tables keeps working untouched — the
 * value changes from a sequential integer to a random string, nothing else.
 *
 * There are no foreign keys to users, because users is not in this file. That is
 * the point: delete the identity row and what is left here is already anonymous.
 */
const PORTFOLIO_SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  quantity REAL NOT NULL,
  amount_eur REAL NOT NULL,
  currency TEXT DEFAULT 'EUR',
  exchange_rate REAL DEFAULT 1,
  tx_type TEXT NOT NULL CHECK(tx_type IN ('buy','sell')),
  ts INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK(rule_type IN ('price_above','price_below','change_pct','dip_from_avg_cost','gain_from_avg_cost','drop_from_high')),
  threshold REAL NOT NULL,
  currency TEXT,
  enabled BOOLEAN DEFAULT 1,
  last_triggered_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_ticker_alert ON alerts(user_id, ticker);
CREATE INDEX IF NOT EXISTS idx_enabled ON alerts(enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_unique ON alerts(user_id, ticker, rule_type, threshold);

-- The algorithm's two timings used to be columns on users. They are preferences
-- about alerting, not identity, so they belong on this side of the line.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  algo_alerts_enabled INTEGER NOT NULL DEFAULT 1,
  algo_hold_days INTEGER NOT NULL DEFAULT 3,
  algo_cooldown_days INTEGER NOT NULL DEFAULT 60
);

CREATE TABLE IF NOT EXISTS algo_alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  fired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  signal_date DATE NOT NULL,
  tier TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_algo_log_user_ticker ON algo_alert_log(user_id, ticker, fired_at DESC);

CREATE TABLE IF NOT EXISTS algo_settings_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  field TEXT NOT NULL,
  old_value INTEGER,
  new_value INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_algo_settings_user ON algo_settings_log(user_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  price_eur REAL NOT NULL,
  price_usd REAL,
  price_native REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  price_date DATE NOT NULL,
  source TEXT DEFAULT 'yahoo_finance',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_ticker_date ON prices(ticker, price_date);
CREATE INDEX IF NOT EXISTS idx_ticker_date ON prices(ticker, price_date DESC);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  date DATE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_rate ON exchange_rates(from_currency, to_currency, date);

CREATE TABLE IF NOT EXISTS stock_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  split_date DATE NOT NULL,
  ratio REAL NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_split ON stock_splits(ticker, split_date);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS data_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
`;

const columnsOf = (db, table) =>
  db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(c => c.name);

function copyTable(src, dst, table, { rewriteUserId = null } = {}) {
  const srcCols = columnsOf(src, table);
  const dstCols = columnsOf(dst, table);
  const cols = srcCols.filter(c => dstCols.includes(c));
  if (!cols.length) return 0;
  const rows = src.prepare(`SELECT ${cols.map(c => `"${c}"`).join(',')} FROM ${table}`).all();
  if (!rows.length) return 0;
  const insert = dst.prepare(
    `INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`
  );
  const run = dst.transaction(list => {
    for (const row of list) {
      if (rewriteUserId) {
        const mapped = rewriteUserId(row.user_id);
        if (mapped === undefined) continue;      // orphan row, no owner
        row.user_id = mapped;
      }
      insert.run(row);
    }
  });
  run(rows);
  return dst.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

function main() {
  const verifyOnly = process.argv.includes('--verify');

  if (!verifyOnly) {
    for (const f of [IDENTITY, PORTFOLIO]) {
      if (fs.existsSync(f)) {
        console.error(`Refusing to overwrite ${path.basename(f)} — move it aside first.`);
        process.exit(1);
      }
    }
  }

  const src = new Database(SOURCE, { readonly: true });
  const identity = new Database(IDENTITY);
  const portfolio = new Database(PORTFOLIO);
  for (const db of [identity, portfolio]) {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  }

  if (!verifyOnly) {
    identity.exec(IDENTITY_SCHEMA);
    portfolio.exec(PORTFOLIO_SCHEMA);

    // 1. identities, each given a key that is not derived from anything
    const users = src.prepare('SELECT * FROM users ORDER BY id').all();
    const keyOf = new Map();
    const insUser = identity.prepare(
      'INSERT INTO users (id, user_key, email, created_at, last_seen_at) VALUES (?,?,?,?,?)'
    );
    identity.transaction(() => {
      for (const u of users) {
        const key = crypto.randomUUID();
        keyOf.set(u.id, key);
        insUser.run(u.id, key, u.email, u.created_at, u.last_seen_at ?? null);
      }
    })();
    console.log(`identity.db : ${users.length} user(s)`);

    copyTable(src, identity, 'sessions');
    copyTable(src, identity, 'login_tokens');
    console.log(`              ${identity.prepare('SELECT COUNT(*) c FROM sessions').get().c} session(s), `
      + `${identity.prepare('SELECT COUNT(*) c FROM login_tokens').get().c} login token(s)`);

    // 2. financial data, re-keyed
    const rewrite = id => keyOf.get(id);
    for (const t of ['transactions', 'alerts', 'algo_alert_log', 'algo_settings_log']) {
      const n = copyTable(src, portfolio, t, { rewriteUserId: rewrite });
      console.log(`portfolio.db: ${String(n).padStart(6)} ${t}`);
    }
    for (const t of ['prices', 'exchange_rates', 'stock_splits', 'job_runs']) {
      const n = copyTable(src, portfolio, t);
      console.log(`portfolio.db: ${String(n).padStart(6)} ${t}`);
    }

    // 3. the per-user settings that used to live on the users row
    const insSettings = portfolio.prepare(
      'INSERT OR REPLACE INTO user_settings (user_id, algo_alerts_enabled, algo_hold_days, algo_cooldown_days) VALUES (?,?,?,?)'
    );
    portfolio.transaction(() => {
      for (const u of users) {
        insSettings.run(keyOf.get(u.id), u.algo_alerts_enabled ?? 1, u.algo_hold_days ?? 3, u.algo_cooldown_days ?? 60);
      }
    })();
    portfolio.prepare('INSERT OR IGNORE INTO data_version (id, version) VALUES (1, ?)')
      .run(src.prepare('SELECT version FROM data_version WHERE id=1').get()?.version ?? 1);
  }

  /* ---- verification: every row must have survived and still belong to someone ---- */
  const problems = [];
  const idCount = t => identity.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const pfCount = t => portfolio.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

  for (const [table, before, after] of [
    ['users', src.prepare('SELECT COUNT(*) c FROM users').get().c, idCount('users')],
    ['sessions', src.prepare('SELECT COUNT(*) c FROM sessions').get().c, idCount('sessions')],
    ['transactions', src.prepare('SELECT COUNT(*) c FROM transactions').get().c, pfCount('transactions')],
    ['alerts', src.prepare('SELECT COUNT(*) c FROM alerts').get().c, pfCount('alerts')],
    ['prices', src.prepare('SELECT COUNT(*) c FROM prices').get().c, pfCount('prices')]
  ]) {
    if (before !== after) problems.push(`${table}: ${before} before, ${after} after`);
  }

  const keys = new Set(identity.prepare('SELECT user_key FROM users').all().map(r => r.user_key));
  for (const t of ['transactions', 'alerts', 'user_settings']) {
    const orphans = portfolio.prepare(`SELECT DISTINCT user_id FROM ${t}`).all()
      .filter(r => !keys.has(r.user_id)).length;
    if (orphans) problems.push(`${t}: ${orphans} row-group(s) with no matching identity`);
  }

  // the money itself has to reconcile, per person
  const byKey = {};
  for (const r of portfolio.prepare('SELECT user_id, COUNT(*) n, SUM(amount_eur) total FROM transactions GROUP BY user_id').all()) byKey[r.user_id] = r;
  for (const r of src.prepare('SELECT user_id, COUNT(*) n, SUM(amount_eur) total FROM transactions GROUP BY user_id').all()) {
    const key = identity.prepare('SELECT user_key FROM users WHERE id = ?').get(r.user_id)?.user_key;
    const after = key && byKey[key];
    if (!after || after.n !== r.n || Math.abs((after.total || 0) - (r.total || 0)) > 0.005) {
      problems.push(`user ${r.user_id}: ${r.n} tx / €${r.total} became ${after ? after.n + ' tx / €' + after.total : 'nothing'}`);
    }
  }

  // and no email may have leaked across the line
  const pfTables = portfolio.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of pfTables) {
    if (columnsOf(portfolio, t).some(c => /email/i.test(c))) problems.push(`${t} has an email column on the financial side`);
  }

  console.log('');
  if (problems.length) {
    console.error('✗ VERIFICATION FAILED');
    problems.forEach(p => console.error('  ' + p));
    process.exit(1);
  }
  console.log('✓ verified: row counts match, every row has an owner, per-user totals reconcile,');
  console.log('  and no email column exists anywhere in portfolio.db');
  console.log(`\n  ${SOURCE} is untouched — the rollback is to point DB_PATH back at it.`);
}

// Same guard as recompute-eur.js, and for a louder reason: requiring this file would
// re-run a database split.
if (require.main === module) main();
