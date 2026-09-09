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

module.exports = { ensurePriceCurrencyColumns, ensureAlertCurrency, columnNames };
