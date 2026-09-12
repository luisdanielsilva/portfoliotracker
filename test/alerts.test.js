/**
 * Alert semantics. Each of these is a rule the app makes a promise about, and two were
 * once wrong in production: change_pct was offered in the UI and never evaluated, and the
 * digest's recipient fell back to the operator when an owner address was missing.
 */
const test = require('node:test');
const assert = require('node:assert');
const { evaluateAlerts, alertSubject, renderAlertDigest, renderAlertDigestText } = require('../price-fetch.js');
const { ensureDropFromHighRuleType, ensureGainRuleType, ensurePriceCurrencyColumns, recentHigh } = require('../db-migrations.js');
const { freshDb, addUser, addTx, addPrice, day } = require('./helpers.js');

function dbWithRules() {
  const db = freshDb();
  ensurePriceCurrencyColumns(db); ensureGainRuleType(db); ensureDropFromHighRuleType(db);
  return db;
}
const addAlert = (db, userId, ticker, ruleType, threshold, currency = null) =>
  db.prepare('INSERT INTO alerts (user_id,ticker,rule_type,threshold,currency,enabled) VALUES (?,?,?,?,?,1)')
    .run(userId, ticker, ruleType, threshold, currency).lastInsertRowid;

async function fired(db) {
  const before = db.prepare('SELECT id FROM alerts WHERE last_triggered_at IS NOT NULL').all().length;
  await evaluateAlerts(db, null);           // null mailer: nothing is sent
  return db.prepare('SELECT id FROM alerts WHERE last_triggered_at IS NOT NULL').all().length - before;
}

test('a dip fires below your average cost, measured in euros', async () => {
  const db = dbWithRules(); const u = addUser(db);
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: day(1) });   // €100 average
  addPrice(db, { ticker: 'TSLA', date: '2026-02-01', eur: 84, native: 100 }); // 16% down
  addAlert(db, u, 'TSLA', 'dip_from_avg_cost', 15);
  assert.equal(await fired(db), 1);
});

test('a dip does not fire above the threshold', async () => {
  const db = dbWithRules(); const u = addUser(db);
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: day(1) });
  addPrice(db, { ticker: 'TSLA', date: '2026-02-01', eur: 90, native: 100 }); // only 10% down
  addAlert(db, u, 'TSLA', 'dip_from_avg_cost', 15);
  assert.equal(await fired(db), 0);
});

test('a target fires above your average cost — the sell side', async () => {
  const db = dbWithRules(); const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: day(1) });
  addPrice(db, { ticker: 'NVDA', date: '2026-02-01', eur: 180, native: 200 });
  addAlert(db, u, 'NVDA', 'gain_from_avg_cost', 75);
  assert.equal(await fired(db), 1);
});

test('a price level is compared in the market’s own currency, not in euros', async () => {
  const db = dbWithRules(); const u = addUser(db);
  addTx(db, u, { ticker: 'AMD', quantity: 1, amount: 100, ts: day(1) });
  // $95 native, €82 in euros. A rule for "below $100" must fire; it must not be read as €100.
  addPrice(db, { ticker: 'AMD', date: '2026-02-01', eur: 82, native: 95, currency: 'USD' });
  addAlert(db, u, 'AMD', 'price_below', 100, 'USD');
  assert.equal(await fired(db), 1);
  const db2 = dbWithRules(); const u2 = addUser(db2);
  addTx(db2, u2, { ticker: 'AMD', quantity: 1, amount: 100, ts: day(1) });
  addPrice(db2, { ticker: 'AMD', date: '2026-02-01', eur: 82, native: 95, currency: 'USD' });
  addAlert(db2, u2, 'AMD', 'price_below', 90, 'USD');   // $95 is not below $90
  assert.equal(await fired(db2), 0);
});

test('a trailing rule measures against the high of the past year', async () => {
  const db = dbWithRules(); const u = addUser(db);
  addTx(db, u, { ticker: 'ORCL', quantity: 1, amount: 100, ts: day(1) });
  const today = new Date().toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  addPrice(db, { ticker: 'ORCL', date: recent, eur: 300, native: 350, currency: 'USD' }); // the peak
  addPrice(db, { ticker: 'ORCL', date: today,  eur: 200, native: 240, currency: 'USD' }); // −31%
  assert.equal(Math.round(recentHigh(db, 'ORCL').peak), 350);
  addAlert(db, u, 'ORCL', 'drop_from_high', 20);
  assert.equal(await fired(db), 1);
});

test('a disabled rule never fires', async () => {
  const db = dbWithRules(); const u = addUser(db);
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: day(1) });
  addPrice(db, { ticker: 'TSLA', date: '2026-02-01', eur: 50, native: 60 });
  const id = addAlert(db, u, 'TSLA', 'dip_from_avg_cost', 15);
  db.prepare('UPDATE alerts SET enabled = 0 WHERE id = ?').run(id);
  assert.equal(await fired(db), 0);
});

test('the same rule does not fire twice within 24 hours', async () => {
  const db = dbWithRules(); const u = addUser(db);
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: day(1) });
  addPrice(db, { ticker: 'TSLA', date: '2026-02-01', eur: 50, native: 60 });
  addAlert(db, u, 'TSLA', 'dip_from_avg_cost', 15);
  await evaluateAlerts(db, null);
  const firstFire = db.prepare('SELECT last_triggered_at t FROM alerts').get().t;
  await evaluateAlerts(db, null);
  assert.equal(db.prepare('SELECT last_triggered_at t FROM alerts').get().t, firstFire, 'throttle must hold');
});

test('the digest names every kind of rule it carries', () => {
  const items = [
    { kind: 'dip',  ticker: 'TSLA', price: 84,  avgCost: 100, dropPct: 16 },
    { kind: 'gain', ticker: 'NVDA', price: 180, avgCost: 100, gainPct: 80, threshold: 75 },
    { kind: 'high', ticker: 'ORCL', price: 240, peak: 350, dropPct: 31.4, threshold: 20, currency: 'USD' },
    { kind: 'price_below', ticker: 'AMD', price: 95, threshold: 100, currency: 'USD' }
  ];
  const html = renderAlertDigest(items);
  for (const t of ['TSLA', 'NVDA', 'ORCL', 'AMD']) assert.ok(html.includes(t), `${t} missing from the digest`);
  assert.match(alertSubject(items), /4 alerts/);
  const text = renderAlertDigestText(items);
  for (const t of ['TSLA', 'NVDA', 'ORCL', 'AMD']) assert.ok(text.includes(t), `${t} missing from the text part`);
});
