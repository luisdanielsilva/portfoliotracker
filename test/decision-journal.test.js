/**
 * The decision journal (#28). What it must get right is the link — this trade
 * answered that alert — and the two scores, because those are the numbers the
 * user will read years from now to judge their own decisions.
 */
const test = require('node:test');
const assert = require('node:assert');
const { decisionJournal } = require('../decision-journal.js');
const { recordAlertEvent } = require('../alert-log.js');
const { migratedDb, addUser, addTx, addPrice, addSplit } = require('./helpers.js');

const D = (y, m, d) => Date.UTC(y, m - 1, d, 12);
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const NOW = D(2026, 9, 27);

function remindDaily(db, u, ticker, fromMs, days, extra = {}) {
  for (let i = 0; i < days; i++) {
    recordAlertEvent(db, {
      userId: u, ticker, source: 'rule', alertType: 'dip_from_avg_cost', alertId: 1,
      firedAt: new Date(fromMs + i * 864e5).toISOString(), priceEur: 80, priceNative: 90, currency: 'USD',
      avgCostEur: 100, detail: { basis: 'avg_cost' }, ...extra
    });
  }
  db.prepare("UPDATE alert_events SET delivery = 'sent' WHERE delivery = 'pending'").run();
}

const holding = (j, t) => j.holdings.find(h => h.ticker === t);

test('a buy during a dip episode is linked to it, with the average before and after', () => {
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'ORCL', quantity: 10, amount: 1000, ts: D(2025, 1, 10) });   // €100
  remindDaily(db, u, 'ORCL', D(2026, 9, 19), 5);
  addTx(db, u, { ticker: 'ORCL', quantity: 10, amount: 800, ts: D(2026, 9, 22) });    // €80
  addPrice(db, { ticker: 'ORCL', date: iso(NOW), eur: 95, currency: 'USD' });

  const h = holding(decisionJournal(db, u, { now: NOW }), 'ORCL');
  const buy = h.trades[1];
  assert.strictEqual(buy.avgBefore, 100);
  assert.strictEqual(buy.avgAfter, 90);
  assert.strictEqual(buy.avgChangeEUR, -10, 'the purchase lowered the average by €10');
  assert.strictEqual(buy.alerts.length, 1, 'five reminders, one alert');
  assert.strictEqual(buy.alerts[0].reminders, 5);
  assert.strictEqual(buy.alerts[0].daysToTrade, 3);
  assert.strictEqual(h.trades[0].alerts.length, 0, 'the first buy came before any alert');
  assert.strictEqual(h.ignored.length, 0, 'an answered alert is not also an ignored one');
  assert.strictEqual(h.totals.lowered, 1);
});

test('a buy is scored today and a year on: worth now minus what it cost', () => {
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'SPY', quantity: 5, amount: 1000, ts: D(2024, 3, 1) });
  addPrice(db, { ticker: 'SPY', date: '2025-02-28', eur: 230 });   // the close on or before 1 Mar 2025
  addPrice(db, { ticker: 'SPY', date: '2025-03-03', eur: 999 });   // after the anniversary: must not be used
  addPrice(db, { ticker: 'SPY', date: iso(NOW), eur: 300 });

  const [buy] = holding(decisionJournal(db, u, { now: NOW }), 'SPY').trades;
  assert.strictEqual(buy.today.resultEur, 500);
  assert.strictEqual(buy.today.resultPct, 0.5);
  assert.strictEqual(buy.oneYear.date, '2025-02-28');
  assert.strictEqual(buy.oneYear.resultEur, 150);
});

test('a sale is scored the other way: what it fetched minus what the shares would be worth', () => {
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: D(2019, 1, 10) });
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 2000, type: 'sell', ts: D(2019, 12, 9) });
  addPrice(db, { ticker: 'TSLA', date: '2020-12-08', eur: 600 });
  addPrice(db, { ticker: 'TSLA', date: iso(NOW), eur: 3000 });

  const h = holding(decisionJournal(db, u, { now: NOW }), 'TSLA');
  const sale = h.trades[1];
  assert.strictEqual(sale.realisedGain, 1000);
  assert.strictEqual(sale.today.resultEur, 2000 - 30000, 'the honest number: €28,000 left on the table');
  assert.strictEqual(sale.oneYear.resultEur, 2000 - 6000);
  assert.strictEqual(sale.avgAfter, null, 'nothing held after it');
});

test('scores are in today\'s share units, so a split does not distort them', () => {
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 1, amount: 600, ts: D(2026, 1, 2) });
  addSplit(db, { ticker: 'NVDA', date: '2026-03-01', ratio: 3 });
  addPrice(db, { ticker: 'NVDA', date: iso(NOW), eur: 250 });     // split-adjusted, as prices are
  const [buy] = holding(decisionJournal(db, u, { now: NOW }), 'NVDA').trades;
  assert.strictEqual(buy.quantity, 3);
  assert.strictEqual(buy.today.resultEur, 150);
});

test('less than a year old: no one-year score yet, rather than a wrong one', () => {
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'MSFT', quantity: 5, amount: 1500, ts: D(2026, 7, 17) });
  addPrice(db, { ticker: 'MSFT', date: iso(NOW), eur: 450 });
  const [buy] = holding(decisionJournal(db, u, { now: NOW }), 'MSFT').trades;
  assert.strictEqual(buy.oneYear, null);
  assert.strictEqual(buy.oneYearDate, '2027-07-17');
});

test('an alert with no trade after it is listed with what the price did since', () => {
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'VOW.DE', quantity: 7, amount: 700, ts: D(2025, 1, 10) });
  remindDaily(db, u, 'VOW.DE', D(2026, 6, 1), 3);
  addPrice(db, { ticker: 'VOW.DE', date: iso(NOW), eur: 99, native: 108, currency: 'USD' });

  const h = holding(decisionJournal(db, u, { now: NOW }), 'VOW.DE');
  assert.strictEqual(h.ignored.length, 1);
  assert.strictEqual(h.ignored[0].reminders, 3);
  assert.ok(Math.abs(h.ignored[0].changeSincePct - 0.2) < 1e-12, '90 → 108 in the market\'s own currency');
  assert.strictEqual(h.ignored[0].open, false, 'months ago: the window has closed');
});

test('an email that never left is not an alert the reader ignored', () => {
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'NOW', quantity: 1, amount: 100, ts: D(2026, 5, 19) });
  recordAlertEvent(db, { userId: u, ticker: 'NOW', source: 'rule', alertType: 'dip_from_avg_cost',
    firedAt: new Date(D(2026, 9, 1)).toISOString(), priceEur: 80 });   // left pending
  assert.strictEqual(holding(decisionJournal(db, u, { now: NOW }), 'NOW').ignored.length, 0);
});

test('one user never sees another\'s decisions', () => {
  const db = migratedDb(); const a = addUser(db, 'a@example.com'); const b = addUser(db, 'b@example.com');
  addTx(db, a, { ticker: 'TSLA', quantity: 1, amount: 100, ts: D(2026, 1, 1) });
  remindDaily(db, a, 'TSLA', D(2026, 9, 1), 2);
  assert.deepStrictEqual(decisionJournal(db, b, { now: NOW }).holdings, []);
});
