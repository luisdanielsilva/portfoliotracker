/**
 * Which tickers the daily job actually asks about.
 *
 * The rule exists to stop paying for prices nobody is in a position to read. The
 * trap it must not fall into is silencing an alert: those exist precisely for
 * people who are not logging in, so an alert has to keep its ticker on the daily
 * schedule no matter how dormant its owner is.
 */
const test = require('node:test');
const assert = require('node:assert');
const { tickerTier, priceGapDays, HOT_SEEN_DAYS, resolveDbPath } = require('../price-fetch.js');
const { migratedDb, addUser, addTx, addPrice, day } = require('./helpers.js');

const NOW = new Date('2026-09-14T12:00:00.000Z');
const daysAgo = n => new Date(NOW.getTime() - n * 864e5).toISOString();

function holder(db, { seenDaysAgo, ticker = 'AAA' }) {
  const u = addUser(db, `u${Math.random().toString(36).slice(2)}@example.com`);
  if (seenDaysAgo !== null) {
    db.identity.prepare('UPDATE users SET last_seen_at = ? WHERE user_key = ?').run(daysAgo(seenDaysAgo), u);
  }
  addTx(db, u, { ticker, quantity: 1, amount: 100, ts: day(1) });
  return u;
}

test('a holder who was here recently keeps their ticker on the daily schedule', () => {
  const db = migratedDb();
  holder(db, { seenDaysAgo: 1 });
  assert.strictEqual(tickerTier(db, 'AAA', NOW, db.identity), 'hot');
});

test('a ticker whose only holders are dormant goes cold', () => {
  const db = migratedDb();
  holder(db, { seenDaysAgo: HOT_SEEN_DAYS + 5 });
  assert.strictEqual(tickerTier(db, 'AAA', NOW, db.identity), 'cold');
});

test('a holder who has never signed in does not keep a ticker hot', () => {
  const db = migratedDb();
  holder(db, { seenDaysAgo: null });
  assert.strictEqual(tickerTier(db, 'AAA', NOW, db.identity), 'cold');
});

test('one active holder is enough, however dormant the others are', () => {
  const db = migratedDb();
  holder(db, { seenDaysAgo: 90 });
  holder(db, { seenDaysAgo: 0 });
  assert.strictEqual(tickerTier(db, 'AAA', NOW, db.identity), 'hot');
});

test('an alert keeps a ticker daily even when every holder is dormant', () => {
  // The whole point of an alert is to reach somebody who is not looking. If
  // dormancy could switch off its prices, the alert would quietly stop working
  // for exactly the person it was written for.
  const db = migratedDb();
  const u = holder(db, { seenDaysAgo: 400 });
  assert.strictEqual(tickerTier(db, 'AAA', NOW, db.identity), 'cold', 'precondition: dormant');
  db.prepare("INSERT INTO alerts (user_id,ticker,rule_type,threshold,enabled) VALUES (?,?,?,?,1)")
    .run(u, 'AAA', 'price_below', 10);
  assert.strictEqual(tickerTier(db, 'AAA', NOW, db.identity), 'hot');
});

test('a disabled alert does not keep a ticker daily', () => {
  const db = migratedDb();
  const u = holder(db, { seenDaysAgo: 400 });
  db.prepare("INSERT INTO alerts (user_id,ticker,rule_type,threshold,enabled) VALUES (?,?,?,?,0)")
    .run(u, 'AAA', 'price_below', 10);
  assert.strictEqual(tickerTier(db, 'AAA', NOW, db.identity), 'cold');
});

test('the algorithm alert alone does not make everything hot', () => {
  // It is enabled by default on every account, so counting it would make every
  // ticker hot and the rule pointless.
  const db = migratedDb();
  const u = holder(db, { seenDaysAgo: 400 });
  assert.strictEqual(db.prepare('SELECT algo_alerts_enabled AS e FROM user_settings WHERE user_id = ?').get(u).e, 1,
    'precondition: it really is on by default');
  assert.strictEqual(tickerTier(db, 'AAA', NOW, db.identity), 'cold');
});

test('the gap is measured from the newest stored price', () => {
  const db = migratedDb();
  assert.strictEqual(priceGapDays(db, 'AAA', NOW), Infinity, 'never fetched');
  addPrice(db, { ticker: 'AAA', date: '2026-09-10', eur: 10, native: 10 });
  addPrice(db, { ticker: 'AAA', date: '2026-09-12', eur: 11, native: 11 });
  // Midnight on the 12th to noon on the 14th is two and a half days — stored
  // dates have no time of day, so the gap is deliberately fractional rather than
  // rounded to something tidier than the truth.
  assert.strictEqual(priceGapDays(db, 'AAA', NOW), 2.5);
});

/**
 * The daily job is started by a root-owned systemd unit that names DB_PATH
 * explicitly. When the databases were split, that unit went on pointing at the
 * pre-split file — and the job would have kept succeeding every morning, writing
 * prices into a database nothing reads, with no symptom but a portfolio that
 * quietly stopped moving. This is the guard against that.
 */
test('the job refuses to write into a pre-split database', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const p = require('node:path');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'pt-split-'));

  const old = p.join(dir, 'data.db');
  const split = p.join(dir, 'portfolio.db');
  new Database(old).exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
  new Database(split).exec('CREATE TABLE transactions (id INTEGER PRIMARY KEY, user_id TEXT)');

  const before = process.env.DB_PATH;
  try {
    process.env.DB_PATH = old;
    assert.strictEqual(resolveDbPath(), split, 'a pre-split target must be redirected to the split one');

    process.env.DB_PATH = split;
    assert.strictEqual(resolveDbPath(), split, 'a correct target is left alone');

    const missing = p.join(dir, 'nothing.db');
    process.env.DB_PATH = missing;
    assert.strictEqual(resolveDbPath(), missing, 'a path that does not exist is somebody else\'s error to report');
  } finally {
    if (before === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
