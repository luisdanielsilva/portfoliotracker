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

module.exports = { ensurePriceCurrencyColumns, columnNames };
