/**
 * Average cost per share. Three real defects lived in this calculation:
 *
 *   - splits were applied to purchases made *after* the split, tripling them;
 *   - getAvgCostPerShare ignored splits entirely while the snapshots did not, so the same
 *     holding read as 8 shares at €200.10 in one place and 10 at €160.08 in another;
 *   - a fully sold position kept reporting an average cost.
 */
const test = require('node:test');
const assert = require('node:assert');
const { getAvgCostPerShare } = require('../portfolio.js');
const { freshDb, addUser, addTx, addSplit, day } = require('./helpers.js');

test('one purchase: the average is what you paid per share', () => {
  const db = freshDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: day(1) });
  const r = getAvgCostPerShare(db, u, 'TSLA');
  assert.equal(r.quantity, 10);
  assert.equal(r.avgCostEUR, 100);
});

test('buying lower pulls the average down — the premise the whole app rests on', () => {
  const db = freshDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: day(1) });  // €100
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 700,  ts: day(2) });  // €70
  const r = getAvgCostPerShare(db, u, 'TSLA');
  assert.equal(r.quantity, 20);
  assert.equal(r.avgCostEUR, 85);
});

test('a split multiplies only the shares held when it happened', () => {
  const db = freshDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 3000, ts: day(1) });   // before
  addSplit(db, { ticker: 'TSLA', date: '2026-01-05', ratio: 3 });
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: day(10) });  // after
  const r = getAvgCostPerShare(db, u, 'TSLA');
  // 10 pre-split shares become 30; the later 10 are already post-split terms
  assert.equal(r.quantity, 40, 'the later purchase must not be multiplied too');
  assert.equal(r.avgCostEUR, 100, '€4,000 across 40 shares');
});

test('selling reduces quantity and cost together', () => {
  const db = freshDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: day(1) });
  addTx(db, u, { ticker: 'TSLA', quantity: 4,  amount: 400,  type: 'sell', ts: day(2) });
  const r = getAvgCostPerShare(db, u, 'TSLA');
  assert.equal(r.quantity, 6);
  assert.equal(r.avgCostEUR, 100);
});

test('a fully exited position reports nothing rather than a stale average', () => {
  const db = freshDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: day(1) });
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1400, type: 'sell', ts: day(2) });
  assert.equal(getAvgCostPerShare(db, u, 'TSLA'), null);
});

test('one user cannot see another user’s holdings', () => {
  const db = freshDb(); const a = addUser(db, 'a@example.com'); const b = addUser(db, 'b@example.com');
  addTx(db, a, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: day(1) });
  assert.equal(getAvgCostPerShare(db, b, 'TSLA'), null);
});

test('a ticker never bought returns nothing', () => {
  const db = freshDb(); const u = addUser(db);
  assert.equal(getAvgCostPerShare(db, u, 'NVDA'), null);
});

/**
 * The case that decides which tickers the daily price fetch asks for.
 *
 * A raw sum of buys minus sells says this position is closed. It is not: the buy
 * happened before a 3-for-1, so it is three shares in today's terms and only one
 * was sold. Getting this wrong stops fetching prices for something still owned.
 */
test('a position bought before a split and sold after it is still held', () => {
  const db = freshDb();
  const u = addUser(db);
  addSplit(db, { ticker: 'TSLA', date: '2026-03-01', ratio: 3 });
  addTx(db, u, { ticker: 'TSLA', quantity: 1, amount: 900, ts: Date.UTC(2026, 0, 10) });   // becomes 3
  addTx(db, u, { ticker: 'TSLA', quantity: 1, amount: 400, type: 'sell', ts: Date.UTC(2026, 3, 10) });

  const held = getAvgCostPerShare(db, u, 'TSLA');
  assert.ok(held, 'raw arithmetic would call this closed; it is not');
  assert.strictEqual(Math.round(held.quantity), 2, 'three shares after the split, one sold');
});

test('a position sold down to nothing reports as closed', () => {
  const db = freshDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'AAA', quantity: 5, amount: 500, ts: Date.UTC(2026, 0, 10) });
  addTx(db, u, { ticker: 'AAA', quantity: 5, amount: 600, type: 'sell', ts: Date.UTC(2026, 2, 10) });
  assert.strictEqual(getAvgCostPerShare(db, u, 'AAA'), null,
    'the daily fetch uses this to stop asking for prices nobody needs');
});

/* ---- what it cost while it was still held ----
 *
 * The reference a sold-out position carries onto the watchlist. It is recomputed
 * from the history rather than remembered at the moment of sale, because the
 * offer to keep watching can be accepted long afterwards — and because a number
 * the browser sends back is a number the browser could have changed.
 */
const { lastHeldAvgCost } = require('../portfolio.js');

test('a closed position still knows what it cost while it was held', () => {
  const db = freshDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'ORCL', quantity: 10, amount: 1000, ts: day(2) });
  addTx(db, u, { ticker: 'ORCL', quantity: 10, amount: 1400, type: 'sell', ts: day(9) });

  assert.strictEqual(getAvgCostPerShare(db, u, 'ORCL'), null, 'nothing is held now');
  assert.strictEqual(lastHeldAvgCost(db, u, 'ORCL').avgCostEUR, 100,
    'but €100 a share is what was paid, and what a dip should measure from');
});

test('averaging across several buys survives the position being closed', () => {
  const db = freshDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'ORCL', quantity: 10, amount: 1000, ts: day(2) });   // €100
  addTx(db, u, { ticker: 'ORCL', quantity: 10, amount: 1600, ts: day(4) });   // €160
  addTx(db, u, { ticker: 'ORCL', quantity: 20, amount: 3000, type: 'sell', ts: day(9) });

  assert.strictEqual(lastHeldAvgCost(db, u, 'ORCL').avgCostEUR, 130, '€2600 over 20 shares');
});

test('a partial sale does not end the position, so there is nothing to carry', () => {
  const db = freshDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'ORCL', quantity: 10, amount: 1000, ts: day(2) });
  addTx(db, u, { ticker: 'ORCL', quantity: 4, amount: 560, type: 'sell', ts: day(9) });

  assert.strictEqual(lastHeldAvgCost(db, u, 'ORCL'), null,
    'still held — the live cost basis is the answer, not a carried one');
  assert.ok(getAvgCostPerShare(db, u, 'ORCL'));
});

test('a split is applied to the carried cost too', () => {
  const db = freshDb(); const u = addUser(db);
  // One share at €600, then 3-for-1: three shares at €200 each.
  addTx(db, u, { ticker: 'NVDA', quantity: 1, amount: 600, ts: day(2) });
  addSplit(db, { ticker: 'NVDA', date: '2026-01-05', ratio: 3 });
  addTx(db, u, { ticker: 'NVDA', quantity: 3, amount: 900, type: 'sell', ts: day(9) });

  assert.strictEqual(getAvgCostPerShare(db, u, 'NVDA'), null);
  assert.strictEqual(lastHeldAvgCost(db, u, 'NVDA').avgCostEUR, 200,
    'the carried reference must be in post-split shares, like every other figure');
});

test('a ticker never held has no carried cost', () => {
  const db = freshDb(); const u = addUser(db);
  assert.strictEqual(lastHeldAvgCost(db, u, 'GOOGL'), null);
});

test('a position reopened after being closed uses the live basis, not the old one', () => {
  const db = freshDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'ORCL', quantity: 10, amount: 1000, ts: day(2) });
  addTx(db, u, { ticker: 'ORCL', quantity: 10, amount: 1400, type: 'sell', ts: day(9) });
  addTx(db, u, { ticker: 'ORCL', quantity: 5, amount: 1000, ts: day(12) });   // bought back

  assert.strictEqual(lastHeldAvgCost(db, u, 'ORCL'), null, 'held again, so nothing to carry');
  assert.ok(getAvgCostPerShare(db, u, 'ORCL'), 'the live basis answers instead');
});
