/**
 * The record of what the app told people, and whether they then did anything.
 *
 * Two promises are tested here because the eventual evaluation is worthless
 * without them: an alert is logged once per email rather than once per day the
 * condition held, and a row never claims a delivery that did not happen. A log
 * that counts nine throttled days as nine alerts, or counts an email the mailer
 * refused as one the reader ignored, produces a follow-through rate that is
 * wrong in the flattering direction.
 */
const test = require('node:test');
const assert = require('node:assert');
const { evaluateAlerts } = require('../price-fetch.js');
const { followThrough, summariseFollowThrough, eventsFor, recordAlertEvent } = require('../alert-log.js');
const m = require('../db-migrations.js');
const { migratedDb, addUser, addTx, addPrice, day } = require('./helpers.js');

const addAlert = (db, userId, ticker, ruleType, threshold, currency = null) =>
  db.prepare('INSERT INTO alerts (user_id,ticker,rule_type,threshold,currency,enabled) VALUES (?,?,?,?,?,1)')
    .run(userId, ticker, ruleType, threshold, currency).lastInsertRowid;

const events = db => db.prepare('SELECT * FROM alert_events ORDER BY id').all();

/** A holding 16% below its €100 average cost, with a dip rule set at 15%. */
function dipping(db) {
  const u = addUser(db, 'owner@example.com');
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: day(1) });
  addPrice(db, { ticker: 'TSLA', date: '2026-02-01', eur: 84, native: 100, currency: 'USD' });
  const alertId = addAlert(db, u, 'TSLA', 'dip_from_avg_cost', 15);
  return { u, alertId };
}

/* ---------- what a row holds ---------- */

test('a rule that fires is written down with everything the reader was shown', async () => {
  const db = migratedDb();
  const { u, alertId } = dipping(db);

  await evaluateAlerts(db, null);

  const [e] = events(db);
  assert.strictEqual(e.user_id, u);
  assert.strictEqual(e.ticker, 'TSLA');
  assert.strictEqual(e.source, 'rule');
  assert.strictEqual(e.alert_type, 'dip_from_avg_cost');
  assert.strictEqual(e.direction, 'buy', 'a dip below cost argues for buying');
  assert.strictEqual(e.alert_id, alertId, 'and points back at the rule that produced it');
  assert.strictEqual(e.threshold, 15);
  assert.strictEqual(e.price_eur, 84);
  assert.strictEqual(e.price_native, 100);
  assert.strictEqual(e.avg_cost_eur, 100);
  assert.strictEqual(JSON.parse(e.detail).dropPct.toFixed(1), '16.0');
});

test('the sell-side rules are recorded as selling, and a level rule as neither', async () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: day(1) });
  addPrice(db, { ticker: 'NVDA', date: '2026-02-01', eur: 180, native: 200, currency: 'USD' });
  addAlert(db, u, 'NVDA', 'gain_from_avg_cost', 75);
  addAlert(db, u, 'NVDA', 'price_above', 150, 'USD');

  await evaluateAlerts(db, null);

  const byType = Object.fromEntries(events(db).map(e => [e.alert_type, e.direction]));
  assert.strictEqual(byType.gain_from_avg_cost, 'sell');
  // "NVDA above 150" is a buy signal for one person and a sell target for the
  // next. The app was never told which, so the log does not pretend to know.
  assert.strictEqual(byType.price_above, 'watch');
});

/* ---------- one email, one row ---------- */

test('a condition that stays true for days is one alert, not one a day', async () => {
  const db = migratedDb();
  dipping(db);

  await evaluateAlerts(db, null);
  await evaluateAlerts(db, null);   // same day: the 24h throttle holds
  await evaluateAlerts(db, null);

  assert.strictEqual(events(db).length, 1,
    'the log counts what was sent, which is what a follow-through rate is a fraction of');
});

/* ---------- delivery is recorded, never assumed ---------- */

test('no mailer means the alert is logged as one nobody was shown', async () => {
  const db = migratedDb();
  dipping(db);
  await evaluateAlerts(db, null);
  assert.strictEqual(events(db)[0].delivery, 'not_sent');
});

test('a send that succeeds is marked sent, and one that throws is marked failed', async () => {
  const sent = migratedDb();
  dipping(sent);
  await evaluateAlerts(sent, { sendMail: async () => ({ accepted: ['owner@example.com'] }) });
  assert.strictEqual(events(sent)[0].delivery, 'sent');
  assert.ok(events(sent)[0].delivered_at, 'and stamped with when that was decided');

  const failed = migratedDb();
  dipping(failed);
  await evaluateAlerts(failed, { sendMail: async () => { throw new Error('smtp down'); } });
  assert.strictEqual(events(failed)[0].delivery, 'failed',
    'a mailer that fell over is not a reader who ignored anything');
});

/* ---------- did they act on it ---------- */

test('a buy in the same holding after a buy alert counts as following it', async () => {
  const db = migratedDb();
  const { u } = dipping(db);
  await evaluateAlerts(db, { sendMail: async () => ({}) });
  const firedMs = Date.parse(events(db)[0].fired_at);

  addTx(db, u, { ticker: 'TSLA', quantity: 5, amount: 420, ts: firedMs + 4 * 864e5 });

  const [row] = followThrough(db, { windowDays: 30 });
  assert.strictEqual(row.followed, true);
  assert.strictEqual(row.action, 'buy');
  assert.strictEqual(row.daysToAction, 4);
  assert.strictEqual(row.amountEur, 420);
});

test('the trade has to be in the direction the alert argued for, and inside the window', async () => {
  const db = migratedDb();
  const { u } = dipping(db);
  await evaluateAlerts(db, { sendMail: async () => ({}) });
  const firedMs = Date.parse(events(db)[0].fired_at);

  addTx(db, u, { ticker: 'TSLA', quantity: 5, amount: 420, type: 'sell', ts: firedMs + 2 * 864e5 });
  assert.strictEqual(followThrough(db, { windowDays: 30 })[0].followed, false,
    'selling is not acting on an alert that said the holding is cheap');

  addTx(db, u, { ticker: 'TSLA', quantity: 5, amount: 420, ts: firedMs + 45 * 864e5 });
  assert.strictEqual(followThrough(db, { windowDays: 30 })[0].followed, false, 'six weeks later is not a response');
  assert.strictEqual(followThrough(db, { windowDays: 60 })[0].followed, true, 'unless you say the window is that long');
});

test('a trade before the alert never counts, however close it is', async () => {
  const db = migratedDb();
  const { u } = dipping(db);
  await evaluateAlerts(db, { sendMail: async () => ({}) });
  const firedMs = Date.parse(events(db)[0].fired_at);
  addTx(db, u, { ticker: 'TSLA', quantity: 5, amount: 420, ts: firedMs - 864e5 });
  assert.strictEqual(followThrough(db, { windowDays: 30 })[0].followed, false);
});

test('by default only alerts that actually reached somebody are scored', async () => {
  const db = migratedDb();
  const { u } = dipping(db);
  await evaluateAlerts(db, null);                    // logged, never sent
  addTx(db, u, { ticker: 'TSLA', quantity: 5, amount: 420, ts: Date.now() + 864e5 });

  assert.strictEqual(followThrough(db).length, 0,
    'an email that never left cannot be one the reader followed or ignored');
  assert.strictEqual(followThrough(db, { onlyDelivered: false }).length, 1);
});

test('the summary counts how often each kind of alert was acted on', () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  const base = Date.UTC(2026, 3, 1);
  const ids = [0, 1, 2].map(i => recordAlertEvent(db, {
    userId: u, ticker: 'TSLA', source: 'rule', alertType: 'dip_from_avg_cost',
    firedAt: new Date(base + i * 100 * 864e5).toISOString(), priceEur: 84
  }));
  db.prepare("UPDATE alert_events SET delivery = 'sent'").run();
  addTx(db, u, { ticker: 'TSLA', quantity: 1, amount: 84, ts: base + 2 * 864e5 });

  const [group] = summariseFollowThrough(followThrough(db, { windowDays: 30 }));
  assert.strictEqual(ids.length, 3);
  assert.strictEqual(group.alertType, 'dip_from_avg_cost');
  assert.strictEqual(group.given, 3);
  assert.strictEqual(group.followed, 1);
  assert.strictEqual(Math.round(group.followRatePct), 33);
  assert.strictEqual(group.meanDaysToAction, 2);
});

test('a user sees only their own alerts', async () => {
  const db = migratedDb();
  const { u } = dipping(db);
  const other = addUser(db, 'someone.else@example.com');
  await evaluateAlerts(db, null);

  assert.strictEqual(eventsFor(db, u).length, 1);
  assert.strictEqual(eventsFor(db, other).length, 0);
  assert.strictEqual(eventsFor(db, u, { ticker: 'NVDA' }).length, 0);
});

/* ---------- the old log is carried forward, not abandoned ---------- */

test('rows written before the unified log survive the migration', () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  db.prepare(
    `INSERT INTO algo_alert_log (user_id, ticker, fired_at, signal_date, tier, direction, confidence)
     VALUES (?,?,?,?,?,?,?)`
  ).run(u, 'NVDA', '2026-09-01T09:00:00.000Z', '2026-09-01', 'VeryStrong', 'Buy', 91.5);

  m.ensureAlertEventLog(db);
  m.ensureAlertEventLog(db);   // idempotent: every boot runs it

  const carried = db.prepare("SELECT * FROM alert_events WHERE source = 'algo'").all();
  assert.strictEqual(carried.length, 1, 'copied once, not once per boot');
  assert.strictEqual(carried[0].direction, 'buy');
  assert.strictEqual(JSON.parse(carried[0].detail).tier, 'VeryStrong');
  assert.strictEqual(carried[0].delivery, 'pending',
    'the old table never recorded what became of the email, and this does not invent it');
});

test('the algorithm cooldown reads the carried-forward history', () => {
  const db = migratedDb();
  const u = addUser(db, 'owner@example.com');
  const { daysSinceLastAlert } = require('../algo-alerts.js');
  const firedAt = new Date(Date.now() - 10 * 864e5).toISOString();
  db.prepare(
    `INSERT INTO algo_alert_log (user_id, ticker, fired_at, signal_date, tier, direction, confidence)
     VALUES (?,?,?,?,?,?,?)`
  ).run(u, 'NVDA', firedAt, firedAt.slice(0, 10), 'VeryStrong', 'Buy', 90);
  m.ensureAlertEventLog(db);

  const since = daysSinceLastAlert(db, u, 'NVDA', new Date());
  assert.ok(since >= 9.9 && since <= 10.1,
    'otherwise the first boot after the change re-emails everything inside its quiet period');
});
