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
