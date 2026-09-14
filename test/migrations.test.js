/**
 * Migrations run on every boot, so running twice must be indistinguishable from running
 * once. One of them also restates existing alert thresholds into a new currency — that
 * kind of migration is the most dangerous sort, because a mistake silently changes what a
 * user's rule means rather than failing.
 */
const test = require('node:test');
const assert = require('node:assert');
const m = require('../db-migrations.js');
const { freshDb, addUser, addPrice } = require('./helpers.js');

const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const cols = (db, t) => m.columnNames(db, t).sort().join(',');

test('every migration is idempotent — running twice changes nothing', () => {
  const db = freshDb();
  const run = () => { m.ensurePriceCurrencyColumns(db); m.ensureAlertCurrency(db); m.ensureGainRuleType(db); m.ensureDropFromHighRuleType(db); };
  run();
  const after1 = { tables: tables(db).join(','), prices: cols(db, 'prices'), alerts: cols(db, 'alerts') };
  run();
  const after2 = { tables: tables(db).join(','), prices: cols(db, 'prices'), alerts: cols(db, 'alerts') };
  assert.deepEqual(after2, after1);
});

test('the alerts rebuild keeps the rules that were already there', () => {
  const db = freshDb(); const u = addUser(db);
  m.ensurePriceCurrencyColumns(db);
  db.prepare("INSERT INTO alerts (user_id,ticker,rule_type,threshold,enabled) VALUES (?,?,?,?,1)").run(u, 'TSLA', 'price_below', 350);
  m.ensureAlertCurrency(db); m.ensureGainRuleType(db); m.ensureDropFromHighRuleType(db);
  const rows = db.prepare('SELECT ticker, rule_type, threshold FROM alerts').all();
  assert.equal(rows.length, 1, 'a table rebuild must not lose rules');
  assert.equal(rows[0].ticker, 'TSLA');
});


/**
 * The alerts table as it was *before* currency was added.
 *
 * Since the database split, schema.sqlite.sql ships the post-migration shape, so
 * a fresh database makes ensureAlertCurrency a no-op and the test below would
 * pass without exercising anything. Rebuilding the old shape keeps the test about
 * the migration rather than about the schema.
 */
function withLegacyAlerts(db) {
  db.exec(`
    DROP TABLE IF EXISTS alerts;
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      rule_type TEXT NOT NULL CHECK(rule_type IN ('price_above','price_below','change_pct','dip_from_avg_cost','gain_from_avg_cost','drop_from_high')),
      threshold REAL NOT NULL,
      enabled BOOLEAN DEFAULT 1,
      last_triggered_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

test('restating a threshold into the market currency preserves what the rule meant', () => {
  const db = withLegacyAlerts(freshDb()); const u = addUser(db);
  m.ensurePriceCurrencyColumns(db);
  // "TSLA above 350" was written when thresholds meant euros. The price row says €301.65
  // is $350 — so in dollars the same rule is "above 406.09", not "above 350".
  addPrice(db, { ticker: 'TSLA', date: '2026-02-01', eur: 301.65, native: 350, currency: 'USD' });
  db.prepare("INSERT INTO alerts (user_id,ticker,rule_type,threshold,enabled) VALUES (?,?,?,?,1)").run(u, 'TSLA', 'price_above', 350);
  m.ensureAlertCurrency(db);
  const a = db.prepare('SELECT threshold, currency FROM alerts').get();
  assert.equal(a.currency, 'USD');
  assert.ok(a.threshold > 350, 'a euro threshold must be converted up, not relabelled');
  assert.ok(Math.abs(a.threshold - 406.09) < 0.5, `expected about 406.09, got ${a.threshold}`);
});

test('a percentage rule is left alone — it has no currency to restate', () => {
  const db = withLegacyAlerts(freshDb()); const u = addUser(db);
  m.ensurePriceCurrencyColumns(db);
  addPrice(db, { ticker: 'TSLA', date: '2026-02-01', eur: 301.65, native: 350, currency: 'USD' });
  db.prepare("INSERT INTO alerts (user_id,ticker,rule_type,threshold,enabled) VALUES (?,?,?,?,1)").run(u, 'TSLA', 'dip_from_avg_cost', 15);
  m.ensureAlertCurrency(db);
  const a = db.prepare('SELECT threshold, currency FROM alerts').get();
  assert.equal(a.threshold, 15);
  assert.equal(a.currency, null);
});

test('recentHigh reads the highest close inside the window and ignores what is older', () => {
  const db = freshDb();
  m.ensurePriceCurrencyColumns(db);
  const ago = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
  addPrice(db, { ticker: 'X', date: ago(400), eur: 900, native: 900 });  // outside the year
  addPrice(db, { ticker: 'X', date: ago(100), eur: 500, native: 500 });  // the real high
  addPrice(db, { ticker: 'X', date: ago(1),   eur: 300, native: 300 });
  assert.equal(m.recentHigh(db, 'X').peak, 500);
  assert.equal(m.recentHigh(db, 'NOPE'), null);
});

test('a EUR-quoted holding is not converted a second time', () => {
  const db = freshDb();
  m.ensurePriceCurrencyColumns(db);
  addPrice(db, { ticker: 'ASML.AS', date: '2026-02-01', eur: 1474.20, native: 1474.20, currency: 'EUR' });
  const row = db.prepare('SELECT price_eur, price_native, currency FROM prices WHERE ticker = ?').get('ASML.AS');
  assert.equal(row.price_eur, row.price_native, 'a euro-quoted price must equal its native price');
});
