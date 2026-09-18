/**
 * The watchlist, and the one rule that keeps it safe: holdings win.
 *
 * Dip and Target used to resolve against exactly one number — the average cost
 * of a position. Now they resolve through referenceFor(), which can also return
 * a watch price. Everything here exists to pin the precedence: if a stock is
 * held, its cost basis answers, and the watchlist is never consulted. Get that
 * backwards and shipping the watchlist would silently restate somebody's live
 * alerts against a number they never paid.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { migratedDb, addUser, addTx, addWatch, day } = require('./helpers');
const { referenceFor, watchedTickers, allWatchedTickers, hasWatchlist } = require('../reference-price');

/** 10 shares at €100 each. */
function buyTen(db, user, ticker = 'ORCL') {
  addTx(db, user, { ticker, quantity: 10, amount: 1000, ts: day(2) });
}

test('a held stock resolves to its cost basis', () => {
  const db = migratedDb();
  const u = addUser(db);
  buyTen(db, u);

  const ref = referenceFor(db, u, 'ORCL');
  assert.strictEqual(ref.basis, 'avg_cost');
  assert.strictEqual(ref.eur, 100);
});

test('a held stock ignores a watchlist row entirely', () => {
  const db = migratedDb();
  const u = addUser(db);
  buyTen(db, u);
  // Someone watched it before buying it, and the watch price is nothing like
  // what they went on to pay. The alert must still fire off what they paid.
  addWatch(db, u, { ticker: 'ORCL', referenceEur: 250 });

  const ref = referenceFor(db, u, 'ORCL');
  assert.strictEqual(ref.basis, 'avg_cost');
  assert.strictEqual(ref.eur, 100, 'the watch price must not win over a real cost basis');
});

test('a watched stock resolves to its reference price', () => {
  const db = migratedDb();
  const u = addUser(db);
  addWatch(db, u, { ticker: 'GOOGL', referenceEur: 142.5, source: 'spotted' });

  const ref = referenceFor(db, u, 'GOOGL');
  assert.strictEqual(ref.basis, 'spotted');
  assert.strictEqual(ref.eur, 142.5);
});

test('reference_source travels with the number', () => {
  const db = migratedDb();
  const u = addUser(db);
  addWatch(db, u, { ticker: 'AAPL', referenceEur: 200, source: 'typed' });
  addWatch(db, u, { ticker: 'META', referenceEur: 300, source: 'carried' });

  // A watch price and a cost basis are both euros per share and are not the
  // same fact. alert_events has one column for either, so the label is the only
  // thing that stops follow-through reporting a cost that was never paid.
  assert.strictEqual(referenceFor(db, u, 'AAPL').basis, 'typed');
  assert.strictEqual(referenceFor(db, u, 'META').basis, 'carried');
});

test('a watched stock with no reference price has nothing to measure from', () => {
  const db = migratedDb();
  const u = addUser(db);
  addWatch(db, u, { ticker: 'NFLX', referenceEur: null });

  // Not an error — Price level and Trailing still work for it. But Dip and
  // Target must not invent a number.
  assert.strictEqual(referenceFor(db, u, 'NFLX'), null);
});

test('a stock that is neither held nor watched resolves to nothing', () => {
  const db = migratedDb();
  const u = addUser(db);
  assert.strictEqual(referenceFor(db, u, 'TSLA'), null);
});

test('a closed position falls through to its watchlist row', () => {
  const db = migratedDb();
  const u = addUser(db);
  buyTen(db, u);
  addTx(db, u, { ticker: 'ORCL', quantity: 10, amount: 1200, type: 'sell', ts: day(5) });
  // This is the 'carried' case: sold out, still followed, and the reference is
  // what they actually paid while they held it.
  addWatch(db, u, { ticker: 'ORCL', referenceEur: 100, source: 'carried' });

  const ref = referenceFor(db, u, 'ORCL');
  assert.strictEqual(ref.basis, 'carried');
  assert.strictEqual(ref.eur, 100);
});

test('one person\'s watchlist is not another\'s', () => {
  const db = migratedDb();
  const a = addUser(db, 'a@example.com');
  const b = addUser(db, 'b@example.com');
  addWatch(db, a, { ticker: 'GOOGL', referenceEur: 142 });

  assert.strictEqual(referenceFor(db, b, 'GOOGL'), null);
  assert.deepStrictEqual(watchedTickers(db, a), ['GOOGL']);
  assert.deepStrictEqual(watchedTickers(db, b), []);
});

test('the daily job sees every watched ticker across all users, once', () => {
  const db = migratedDb();
  const a = addUser(db, 'a@example.com');
  const b = addUser(db, 'b@example.com');
  addWatch(db, a, { ticker: 'GOOGL', referenceEur: 142 });
  addWatch(db, b, { ticker: 'GOOGL', referenceEur: 150 });
  addWatch(db, b, { ticker: 'AAPL', referenceEur: 200 });

  // The fetch universe is per ticker, not per person: two people watching the
  // same stock is one Yahoo request, not two.
  assert.deepStrictEqual(allWatchedTickers(db), ['AAPL', 'GOOGL']);
});

test('the same stock cannot be watched twice by one person', () => {
  const db = migratedDb();
  const u = addUser(db);
  addWatch(db, u, { ticker: 'GOOGL', referenceEur: 142 });
  assert.throws(() => addWatch(db, u, { ticker: 'GOOGL', referenceEur: 150 }),
    /UNIQUE constraint failed/);
});

test('reference_source is constrained to the three kinds that mean something', () => {
  const db = migratedDb();
  const u = addUser(db);
  assert.throws(() => addWatch(db, u, { ticker: 'GOOGL', referenceEur: 1, source: 'guessed' }),
    /CHECK constraint failed/);
});

test('the migration is idempotent, because every boot runs it', () => {
  const db = migratedDb();
  const m = require('../db-migrations.js');
  const u = addUser(db);
  addWatch(db, u, { ticker: 'GOOGL', referenceEur: 142 });

  m.ensureWatchlist(db);
  m.ensureWatchlist(db);

  assert.strictEqual(referenceFor(db, u, 'GOOGL').eur, 142, 'a re-run must not drop rows');
});

test('a database from before the watchlist still resolves holdings', () => {
  // A restore from a backup taken before this shipped has no watchlist table.
  // The daily job has to run against it rather than throw.
  const { freshDb } = require('./helpers');
  const db = freshDb();
  const m = require('../db-migrations.js');
  m.ensurePriceCurrencyColumns(db);
  db.exec('DROP TABLE IF EXISTS watchlist');
  const u = addUser(db);
  buyTen(db, u);

  assert.strictEqual(hasWatchlist(db), false);
  assert.strictEqual(referenceFor(db, u, 'ORCL').basis, 'avg_cost');
  assert.strictEqual(referenceFor(db, u, 'GOOGL'), null);
  assert.deepStrictEqual(allWatchedTickers(db), []);
});

/* ---- the fetch universe ----
 *
 * The highest-risk line in the whole change. If the union is wrong, a watched
 * stock silently never gets a price, and every alert on it sits in the list
 * looking armed while being incapable of firing — which is the exact failure
 * the watchlist was built to end.
 */
const { fetchUniverse } = require('../price-fetch.js');

test('the universe is held plus watched, with no duplicates', () => {
  const db = migratedDb();
  const u = addUser(db);
  buyTen(db, u, 'ORCL');
  buyTen(db, u, 'MSFT');
  addWatch(db, u, { ticker: 'GOOGL', referenceEur: 142 });
  addWatch(db, u, { ticker: 'ORCL', referenceEur: 90 });   // held AND watched

  const uni = fetchUniverse(db);
  assert.deepStrictEqual(uni.tickers, ['GOOGL', 'MSFT', 'ORCL'],
    'a stock both held and watched is fetched once, not twice');
  assert.deepStrictEqual(uni.watchOnly, ['GOOGL']);
  assert.deepStrictEqual(uni.dropped, []);
});

test('a sold-out position stays out of the universe unless it is watched', () => {
  const db = migratedDb();
  const u = addUser(db);
  buyTen(db, u, 'ORCL');
  addTx(db, u, { ticker: 'ORCL', quantity: 10, amount: 1200, type: 'sell', ts: day(5) });
  buyTen(db, u, 'AAPL');
  addTx(db, u, { ticker: 'AAPL', quantity: 10, amount: 1200, type: 'sell', ts: day(5) });
  addWatch(db, u, { ticker: 'AAPL', referenceEur: 100, source: 'carried' });

  const uni = fetchUniverse(db);
  assert.deepStrictEqual(uni.tickers, ['AAPL'], 'the watched one is still fetched');
  assert.deepStrictEqual(uni.dropped, ['ORCL'], 'the other is still dropped');
  assert.deepStrictEqual(uni.watchOnly, ['AAPL']);
});

test('one person watching is enough to fetch for everyone', () => {
  const db = migratedDb();
  const a = addUser(db, 'a@example.com');
  const b = addUser(db, 'b@example.com');
  buyTen(db, a, 'ORCL');
  addWatch(db, b, { ticker: 'GOOGL', referenceEur: 142 });

  // Prices are not per person — the table is keyed by ticker alone.
  assert.deepStrictEqual(fetchUniverse(db).tickers, ['GOOGL', 'ORCL']);
});

test('an empty watchlist leaves the universe exactly as it was', () => {
  const db = migratedDb();
  const u = addUser(db);
  buyTen(db, u, 'ORCL');

  const uni = fetchUniverse(db);
  assert.deepStrictEqual(uni.tickers, ['ORCL']);
  assert.deepStrictEqual(uni.watchOnly, []);
});
