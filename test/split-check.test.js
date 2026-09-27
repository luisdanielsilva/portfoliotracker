/**
 * split-check.js, entirely offline: a fake `yf` stands in for Yahoo so these
 * tests can run in CI and in `npm test` without ever reaching the network.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  CLEAN_MAX, isCleanSplit, fetchSplits, diffAgainstRecorded, evidenceFor, recordSplit, _clearCache
} = require('../split-check.js');
const { migratedDb, addUser, addTx, addSplit, day } = require('./helpers.js');

/** A fake Yahoo that answers one ticker's split history from a fixed table. */
function fakeYf(table, { onCall } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    chart: async (ticker, opts) => {
      calls++;
      if (onCall) onCall(ticker, opts);
      const events = table[ticker] || [];
      return {
        events: { splits: events.map(e => ({ date: e.date, numerator: e.n, denominator: e.d })) },
        quotes: (table[ticker + ':months'] || []).map(m => ({ date: new Date(m.month + '-01T00:00:00Z'), low: m.low, high: m.high }))
      };
    }
  };
}

test('isCleanSplit', () => {
  assert.equal(isCleanSplit(5, 1), true);
  assert.equal(isCleanSplit(3, 1), true);
  assert.equal(isCleanSplit(10, 1), true);
  assert.equal(isCleanSplit(3, 2), true);
  assert.equal(isCleanSplit(1, 10), true);
  assert.equal(isCleanSplit(CLEAN_MAX, 1), true);

  assert.equal(isCleanSplit(1324, 1000), false, 'the WarnerMedia spin-off — reduces to 331:250');
  assert.equal(isCleanSplit(1, 1), false, 'a no-op is not a split');
  assert.equal(isCleanSplit(0, 1), false);
});

test('diffAgainstRecorded: exact and near-exact dates count as recorded, a month off does not', () => {
  const events = [
    { date: '2020-08-31', n: 5, d: 1, ratio: 5, clean: true },
    { date: '2022-08-25', n: 3, d: 1, ratio: 3, clean: true },
    { date: '2024-06-10', n: 10, d: 1, ratio: 10, clean: true }
  ];
  const recorded = [{ date: '2020-08-31' }, { date: '2022-08-26' }];   // exact, and one day off
  const marked = diffAgainstRecorded(events, recorded);
  assert.equal(marked.find(e => e.date === '2020-08-31').recorded, true);
  assert.equal(marked.find(e => e.date === '2022-08-25').recorded, true, 'one day off must still count, or the unique index would let a duplicate through');
  assert.equal(marked.find(e => e.date === '2024-06-10').recorded, false, 'a month off is a different, unrecorded event');
});

test('evidenceFor: rows priced as-traded (unadjusted) point to as-traded', () => {
  // Modeled on the real TSLA history: a 2019 trade at roughly $250, against a
  // monthly bar whose low/high midpoint is Yahoo's fully split-adjusted ~$17
  // (a combined 15x from the 5:1 and 3:1 splits still to come).
  const events = [
    { date: '2020-08-31', n: 5, d: 1, ratio: 5, clean: true },
    { date: '2022-08-25', n: 3, d: 1, ratio: 3, clean: true }
  ];
  const months = [{ month: '2019-06', low: 16, high: 18 }];
  const rows = [{ date: '2019-06-15', price: 250 }];
  const result = evidenceFor(rows, events, months, events[0]);
  assert.equal(result, 'as-traded');
});

test('evidenceFor: rows already restated to the split-adjusted price point to restated', () => {
  const events = [{ date: '2020-08-31', n: 5, d: 1, ratio: 5, clean: true }];
  const months = [{ month: '2019-06', low: 16, high: 18 }];
  const rows = [{ date: '2019-06-15', price: 17 }];   // the broker already applied the 5:1 itself
  const result = evidenceFor(rows, events, months, events[0]);
  assert.equal(result, 'restated');
});

test('evidenceFor: no qualifying rows is unknown, not a guess', () => {
  const events = [{ date: '2020-08-31', n: 5, d: 1, ratio: 5, clean: true }];
  const months = [{ month: '2020-08', low: 400, high: 500 }];
  assert.equal(evidenceFor([], events, months, events[0]), 'unknown', 'no rows at all');
  assert.equal(
    evidenceFor([{ date: '2020-08-15', price: 450 }], events, months, events[0]),
    'unknown',
    'a row only in the split month itself is excluded'
  );
});

test('fetchSplits: a second call within the TTL does not call yf again', async () => {
  _clearCache();
  const yf = fakeYf({
    TSLA: [{ date: '2020-08-31', n: 5, d: 1 }, { date: '2022-08-25', n: 3, d: 1 }],
    'TSLA:months': [{ month: '2019-06', low: 16, high: 18 }]
  });
  const first = await fetchSplits(yf, 'TSLA');
  assert.equal(yf.calls, 1);
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0].clean, true);

  const second = await fetchSplits(yf, 'TSLA');
  assert.equal(yf.calls, 1, 'the cache must be used within the TTL');
  assert.deepEqual(second, first);
});

test('fetchSplits: dates come back as YYYY-MM-DD and the ratio is numerator/denominator', async () => {
  _clearCache();
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });
  const { events } = await fetchSplits(yf, 'NVDA');
  assert.equal(events[0].date, '2021-07-20');
  assert.equal(events[0].ratio, 4);
  assert.equal(events[0].clean, true);
});

/* ---------------------------------------------------------------- recordSplit */

test('recordSplit: inserts Yahoo\'s own ratio and date — the function takes no ratio parameter at all', async () => {
  _clearCache();
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2015,0,1) });
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });

  const result = await recordSplit(db, yf, u, 'nvda', '2021-07-22');   // lower-case, a few days off the exact date
  assert.equal(result.ok, true);
  assert.equal(result.status, 201);

  const row = db.prepare('SELECT * FROM stock_splits WHERE ticker = ?').get('NVDA');
  assert.equal(row.split_date, '2021-07-20', 'the stored date is Yahoo\'s, not the one asked for');
  assert.equal(row.ratio, 4);
  assert.equal(row.source, 'yahoo');
  assert.equal(row.added_by, u);
  assert.match(row.description, /4-for-1/);
});

test('recordSplit: refuses a non-clean event, like the T spin-off', async () => {
  _clearCache();
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'T', quantity: 10, amount: 1000, ts: Date.UTC(2015,0,1) });
  const yf = fakeYf({ T: [{ date: '2022-04-11', n: 1324, d: 1000 }] });

  const result = await recordSplit(db, yf, u, 'T', '2022-04-11');
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_splits').get().c, 0);
});

test('recordSplit: refuses a date Yahoo does not report', async () => {
  _clearCache();
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2015,0,1) });
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });

  const result = await recordSplit(db, yf, u, 'NVDA', '2019-01-01');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('recordSplit: refuses a user with no pre-split transaction', async () => {
  _clearCache();
  const db = migratedDb(); const u = addUser(db);
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });

  const noHolding = await recordSplit(db, yf, u, 'NVDA', '2021-07-20');
  assert.equal(noHolding.status, 409, 'never held it at all');

  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: day(500) });
  // buy dated well after the split
  const laterOnly = await recordSplit(db, yf, u, 'NVDA', '2021-07-20');
  assert.equal(laterOnly.status, 409, 'only a post-split buy is not evidence of a pre-split holding');
});

test('recordSplit: an already-recorded split returns alreadyRecorded and never calls Yahoo', async () => {
  _clearCache();
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'TSLA', quantity: 10, amount: 1000, ts: Date.UTC(2015,0,1) });
  addSplit(db, { ticker: 'TSLA', date: '2020-08-31', ratio: 5 });

  const yf = fakeYf({});
  yf.chart = async () => { throw new Error('must not be called'); };

  const result = await recordSplit(db, yf, u, 'TSLA', '2020-09-02');   // 2 days off the recorded row
  assert.equal(result.ok, true);
  assert.equal(result.alreadyRecorded, true);
});

test('recordSplit: after an insert, getAvgCostPerShare gives quantity x ratio and the same total cost', async () => {
  _clearCache();
  const { getAvgCostPerShare } = require('../portfolio.js');
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2015,0,1) });
  const before = getAvgCostPerShare(db, u, 'NVDA');

  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });
  await recordSplit(db, yf, u, 'NVDA', '2021-07-20');

  const after = getAvgCostPerShare(db, u, 'NVDA');
  assert.equal(after.quantity, before.quantity * 4);
  assert.ok(Math.abs(after.avgCostEUR * after.quantity - before.avgCostEUR * before.quantity) < 1e-6,
    'total cost must be unchanged by a split');
});

test('recordSplit: a bad ticker or date is refused before anything else runs', async () => {
  _clearCache();
  const db = migratedDb(); const u = addUser(db);
  const yf = fakeYf({});
  yf.chart = async () => { throw new Error('must not be called'); };

  assert.equal((await recordSplit(db, yf, u, '../../etc', '2021-07-20')).status, 400);
  assert.equal((await recordSplit(db, yf, u, 'NVDA', 'not-a-date')).status, 400);
});

test('recordSplit: a Yahoo fetch failure is a 502 with a generic message, not the raw error text', async () => {
  _clearCache();
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2015, 0, 1) });
  const yf = { chart: async () => { throw new Error('ECONNRESET: some yahoo-finance2 internal detail'); } };

  const result = await recordSplit(db, yf, u, 'NVDA', '2021-07-20');
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.doesNotMatch(result.error, /ECONNRESET|internal detail/, 'the raw yahoo-finance2 message must not reach the client');
});

test('recordSplit: an unknown-ticker Yahoo error is told apart from "Yahoo unavailable"', async () => {
  _clearCache();
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'ZZZZ', quantity: 10, amount: 1000, ts: Date.UTC(2015, 0, 1) });
  const yf = { chart: async () => { throw new Error('Quote not found for ticker symbol: ZZZZ'); } };

  const result = await recordSplit(db, yf, u, 'ZZZZ', '2021-07-20');
  assert.equal(result.status, 404);
  assert.match(result.error, /no data/i);
});

test('recordSplit: the dedupe check re-runs against Yahoo\'s date, not the client\'s — a request 8 days from a recorded row is still refused if Yahoo\'s own date is only 5 days off', async () => {
  // The scenario from the review: a manual row sits 5 days before Yahoo's
  // event (Y-5). A request dated Y+3 is 8 days from that row, so a dedupe
  // check against only the client's date would miss it and insert a
  // duplicate at Y. The check must be repeated against `match.date` (Y).
  _clearCache();
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2015, 0, 1) });
  addSplit(db, { ticker: 'NVDA', date: '2021-07-15', ratio: 4 });   // Y-5, hand-entered
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });   // Y

  const result = await recordSplit(db, yf, u, 'NVDA', '2021-07-23');   // Y+3
  assert.equal(result.ok, true);
  assert.equal(result.alreadyRecorded, true, 'Y is only 5 days from the recorded Y-5 row');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_splits').get().c, 1, 'no duplicate row was inserted');
});

test('recordSplit: the "held before" check re-runs against Yahoo\'s date, not the client\'s — a post-split-only buyer cannot pass it by choosing a later request date', async () => {
  // The only transaction is at Y+1, strictly after Yahoo's own split date (Y).
  // A request dated Y+3 must still be refused, even though Y+1 is before Y+3.
  _clearCache();
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2021, 6, 21) });   // Y+1
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });   // Y

  const result = await recordSplit(db, yf, u, 'NVDA', '2021-07-23');   // Y+3
  assert.equal(result.ok, false);
  assert.equal(result.status, 409, 'the only transaction is after Yahoo\'s own split date, not before it');
});

test('recordSplit: a UNIQUE-constraint race at insert maps to alreadyRecorded, not a 500', async () => {
  _clearCache();
  const db = migratedDb(); const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2015, 0, 1) });
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });

  // Two requests for the same event, close enough together that both pass
  // every check that reads `stock_splits` before either one has inserted.
  const [a, b] = await Promise.all([
    recordSplit(db, yf, u, 'NVDA', '2021-07-20'),
    recordSplit(db, yf, u, 'NVDA', '2021-07-21')
  ]);
  const results = [a, b];
  results.forEach(r => assert.equal(r.ok, true, 'neither call may surface as a 500'));
  assert.equal(results.filter(r => r.status === 201).length, 1, 'exactly one insert succeeds');
  assert.equal(results.filter(r => r.alreadyRecorded).length, 1, 'the other is told it is already recorded');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_splits').get().c, 1);
});

test('_clearCache: a cleared cache is refetched from yf', async () => {
  _clearCache();
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });
  await fetchSplits(yf, 'NVDA');
  assert.equal(yf.calls, 1);
  await fetchSplits(yf, 'NVDA');
  assert.equal(yf.calls, 1, 'still cached');
  _clearCache();
  await fetchSplits(yf, 'NVDA');
  assert.equal(yf.calls, 2, 'the clear must force a refetch');
});
