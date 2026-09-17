/**
 * The Algorithm tab's alerts.
 *
 * Two promises are made to the user about these and both are tested here: that
 * the only thing they will ever be emailed is a very strong buy, and that a
 * holding which keeps saying so does not keep emailing. The second is the one
 * that decides whether the feature is usable or is trained into the spam folder.
 */
const test = require('node:test');
const assert = require('node:assert');
const A = require('../algo-alerts.js');
const signals = require('../algorithm.js');
const { evaluateAlerts } = require('../price-fetch.js');
const { migratedDb, addUser, addTx, addPrice, day } = require('./helpers.js');

/** A price series ending in a deep, sustained dip: the last day ranks at the bottom. */
function buildCheap(db, ticker, days = 800, endingOn = Date.UTC(2026, 2, 10)) {
  const start = endingOn - (days - 1) * 864e5;
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 864e5).toISOString().slice(0, 10);
    // A long rise, then a collapse — so the recent prices are the lowest in every window.
    const price = i < days - 40 ? 100 + i * 0.25 : 40 - (i - (days - 40)) * 0.2;
    addPrice(db, { ticker, date, eur: price, native: price, currency: 'USD' });
  }
  return new Date(start + (days - 1) * 864e5);
}

/** A series ending at its all-time high: every window reads very strong sell. */
function buildDear(db, ticker, days = 800, endingOn = Date.UTC(2026, 2, 10)) {
  const start = endingOn - (days - 1) * 864e5;
  for (let i = 0; i < days; i++) {
    addPrice(db, {
      ticker, date: new Date(start + i * 864e5).toISOString().slice(0, 10),
      eur: 50 + i * 0.3, native: 50 + i * 0.3, currency: 'USD'
    });
  }
  return new Date(start + (days - 1) * 864e5);
}

/** Carry a cheap series forward by more days, still falling. */
function extendCheap(db, ticker, extraDays) {
  const last = db.prepare('SELECT price_date d, price_native p FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1').get(ticker);
  let t = Date.parse(last.d), price = last.p;
  for (let i = 1; i <= extraDays; i++) {
    price -= 0.2;
    addPrice(db, { ticker, date: new Date(t + i * 864e5).toISOString().slice(0, 10), eur: price, native: price, currency: 'USD' });
  }
  return new Date(t + extraDays * 864e5);
}

function seriesOf(db, ticker) {
  return db.prepare(
    'SELECT price_date AS date, price_native AS close FROM prices WHERE ticker = ? ORDER BY price_date'
  ).all(ticker);
}

/* ---------- the hold requirement ---------- */

test('a signal must hold for the configured number of readings', () => {
  const db = migratedDb(); addUser(db);
  buildCheap(db, 'DIP');
  const scored = signals.scoreSeries(seriesOf(db, 'DIP'));

  assert.ok(A.sustainedSignal(scored, 1), 'one day is enough when hold is 1');
  assert.ok(A.sustainedSignal(scored, 5), 'the dip here is deep enough to hold for 5');

  // Break the run by making the final day unremarkable, and it stops counting.
  const broken = scored.slice();
  broken[broken.length - 1] = { ...broken[broken.length - 1], complete: true,
    early: { direction: 'None', tier: null, confidencePct: 0 } };
  assert.strictEqual(A.sustainedSignal(broken, 3), null, 'a break on the last day cancels it');
});

test('an expensive holding never produces an alert, however long it holds', () => {
  const db = migratedDb(); addUser(db);
  buildDear(db, 'TOP');
  const scored = signals.scoreSeries(seriesOf(db, 'TOP'));
  const today = scored.filter(d => d.complete).pop();

  assert.strictEqual(today.early.direction, 'Sell', 'precondition: this really is a sell reading');
  assert.strictEqual(today.early.tier, 'VeryStrong', 'precondition: at the top tier');
  for (const hold of [1, 3, 10]) {
    assert.strictEqual(A.sustainedSignal(scored, hold), null,
      `a very strong SELL must never qualify (hold ${hold})`);
  }
});

/* ---------- the cooldown ---------- */

test('the same holding is not emailed twice inside the quiet period', () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  addTx(db, u, { ticker: 'DIP', quantity: 10, amount: 1000, ts: day(1) });
  const asOf = buildCheap(db, 'DIP');
  db.prepare('UPDATE user_settings SET algo_hold_days = 3, algo_cooldown_days = 60 WHERE user_id = ?').run(u);

  const first = A.evaluateAlgorithmSignals(db, asOf);
  assert.strictEqual(first.get('owner@example.com').length, 1, 'fires the first time');
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM alert_events WHERE source = 'algo'").get().c, 1,
    'and is written down');

  const sameDay = A.evaluateAlgorithmSignals(db, asOf);
  assert.strictEqual(sameDay.size, 0, 'silent immediately afterwards');

  const in59 = A.evaluateAlgorithmSignals(db, new Date(asOf.getTime() + 59 * 864e5));
  assert.strictEqual(in59.size, 0, 'still silent one day short of the period');

  const in61 = A.evaluateAlgorithmSignals(db, new Date(asOf.getTime() + 61 * 864e5));
  assert.strictEqual(in61.size, 0, 'but by then the prices are stale, which also stops it');
});

test('a shorter quiet period lets it speak again sooner', () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  addTx(db, u, { ticker: 'DIP', quantity: 10, amount: 1000, ts: day(1) });
  const asOf = buildCheap(db, 'DIP');
  db.prepare('UPDATE user_settings SET algo_hold_days = 3, algo_cooldown_days = 7 WHERE user_id = ?').run(u);

  A.evaluateAlgorithmSignals(db, asOf);
  // Move the world on eight days — prices included, or the freshness guard would
  // stop it for a reason that has nothing to do with the quiet period.
  const later = extendCheap(db, 'DIP', 8);
  const again = A.evaluateAlgorithmSignals(db, later);
  assert.strictEqual(again.get('owner@example.com').length, 1, 'speaks again once the period has passed');
});

/* ---------- guards ---------- */

test('a stale price file is not scored', () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  addTx(db, u, { ticker: 'DIP', quantity: 10, amount: 1000, ts: day(1) });
  const asOf = buildCheap(db, 'DIP');
  const late = new Date(asOf.getTime() + (A.MAX_PRICE_AGE_DAYS + 2) * 864e5);
  assert.strictEqual(A.evaluateAlgorithmSignals(db, late).size, 0);
});

test('a holding with almost no history is skipped rather than guessed at', () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  addTx(db, u, { ticker: 'NEW', quantity: 1, amount: 10, ts: day(1) });
  addPrice(db, { ticker: 'NEW', date: '2026-09-10', eur: 10, native: 10 });
  assert.strictEqual(A.evaluateAlgorithmSignals(db, new Date('2026-09-11')).size, 0);
});

test('switching the algorithm alerts off silences them', () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  addTx(db, u, { ticker: 'DIP', quantity: 10, amount: 1000, ts: day(1) });
  const asOf = buildCheap(db, 'DIP');
  db.prepare('UPDATE user_settings SET algo_alerts_enabled = 0 WHERE user_id = ?').run(u);
  assert.strictEqual(A.evaluateAlgorithmSignals(db, asOf).size, 0);
});

test('one user never receives another user\'s holdings', () => {
  const db = migratedDb();
  const a = addUser(db, 'a@example.com');
  addUser(db, 'b@example.com');
  addTx(db, a, { ticker: 'DIP', quantity: 10, amount: 1000, ts: day(1) });
  const asOf = buildCheap(db, 'DIP');
  const out = A.evaluateAlgorithmSignals(db, asOf);
  assert.deepStrictEqual([...out.keys()], ['a@example.com']);
});

/* ---------- standings ---------- */

test('the standings list both directions and leave out the silent', () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  addTx(db, u, { ticker: 'DIP', quantity: 10, amount: 1000, ts: day(1) });
  addTx(db, u, { ticker: 'TOP', quantity: 10, amount: 1000, ts: day(1) });
  buildCheap(db, 'DIP');
  buildDear(db, 'TOP');

  const rows = A.standingsFor(db, u);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].direction, 'Buy', 'buys are listed first — they are the actionable side');
  assert.strictEqual(rows[1].direction, 'Sell');
  assert.ok(rows.every(r => r.tier), 'every row carries a strength');
});

/* ---------- the digest it produces ---------- */

test('the algorithm item reaches the digest in both formats', async () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  addTx(db, u, { ticker: 'DIP', quantity: 10, amount: 1000, ts: day(1) });
  buildCheap(db, 'DIP');

  const items = A.evaluateAlgorithmSignals(db, new Date(
    db.prepare('SELECT MAX(price_date) d FROM prices').get().d));
  const item = items.get('owner@example.com')[0];
  assert.strictEqual(item.kind, 'algo');
  assert.strictEqual(item.tier, 'VeryStrong');

  const { renderAlertDigest, renderAlertDigestText, alertSubject } = require('../price-fetch.js');
  const html = renderAlertDigest([item]);
  assert.ok(html.includes('very strong buy'), 'the html says what it is');
  assert.ok(html.includes('DIP'));
  const text = renderAlertDigestText([item]);
  assert.ok(text.includes('very strong buy'), 'so does the plain-text part');
  assert.match(alertSubject([item]), /unusually cheap/);
});

test('a standings-only digest does not announce zero alerts', () => {
  const { renderAlertDigest, renderAlertDigestText, alertSubject } = require('../price-fetch.js');
  const standings = [{ ticker: 'AAA', direction: 'Sell', tier: 'Signal', confidence: 33 }];
  assert.match(alertSubject([]), /where your holdings stand/i);
  const html = renderAlertDigest([], standings);
  assert.ok(!html.includes('0 alerts triggered'), 'never says "0 alerts triggered"');
  assert.ok(html.includes('Where things stand this week'));
  assert.ok(renderAlertDigestText([], standings).includes('AAA'));
});

test('ordinals read like English', () => {
  const { ordinal } = require('../price-fetch.js');
  assert.deepStrictEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 100].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '100th']);
});

/* ---------- end to end ---------- */

test('evaluateAlerts merges the algorithm item with the hand-built rules', async () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  addTx(db, u, { ticker: 'DIP', quantity: 10, amount: 1000, ts: day(1) });
  // Ends today, because moving only the last row would leave a six-month gap and
  // the short window would then hold a single price — complete, but meaningless.
  buildCheap(db, 'DIP', 800, Date.now());

  await evaluateAlerts(db, null);          // null mailer: nothing leaves the process
  const logged = db.prepare(
    "SELECT ticker, direction, delivery, json_extract(detail,'$.tier') tier FROM alert_events WHERE source = 'algo'"
  ).all();
  assert.strictEqual(logged.length, 1, 'the firing was recorded');
  assert.strictEqual(logged[0].direction, 'buy');
  assert.strictEqual(logged[0].tier, 'VeryStrong');
  assert.strictEqual(logged[0].delivery, 'not_sent', 'and nothing claims an email that never left');
});
