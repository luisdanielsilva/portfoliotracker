/**
 * Issue #12's one-off migration: re-derive every `prices` row from Yahoo and
 * reconcile the table to hold each row's own final close under its own date.
 *
 * All fictional tickers and prices; a fake `yf` throughout, no network.
 */
const test = require('node:test');
const assert = require('node:assert');
const { migratedDb: migratedDbBase, addPrice, addUser, addTx, addSplit, day } = require('./helpers.js');
const { ensureDataVersion } = require('../db-migrations.js');
function migratedDb() { const db = migratedDbBase(); ensureDataVersion(db); return db; }
const { finalBars, makeRateLookup } = require('../backfill-history.js');
const {
  planReconcile, applyPlan, rollback, gatherBars, main,
  tickerLatestValueDeltas, portfolioEffectsByUser, findOpenEdgeRows, printPlan,
  writeChangeLogAtomic, gzipBackup, changeLogMatchesDb, serviceIsActive, isKnownNonSession
} = require('../redate-prices.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

function setRate(db, date, rate, currency = 'USD') {
  db.prepare(`INSERT INTO exchange_rates (from_currency, to_currency, rate, date) VALUES (?, 'EUR', ?, ?)`)
    .run(currency, rate, date);
}

function dbRowsOf(db) {
  return db.prepare('SELECT id, ticker, price_date, price_native, price_usd, price_eur, currency, source FROM prices ORDER BY ticker, price_date').all();
}

// Includes `id` (not just the other columns) so a rollback test can actually
// catch a row that was deleted and silently reinserted under a *different*
// id — `rollback()` reinserts deleted rows with their original, explicit id
// (see `reinsertDeleted` in redate-prices.js), and a dump that dropped `id`
// could not tell that apart from "restored, but as a new row".
function dump(db) {
  return db.prepare('SELECT id, ticker, price_date, price_native, price_usd, price_eur, currency, source FROM prices ORDER BY ticker, price_date').all();
}

/** A chart response with a US-shaped meta and the given (date,close) bars, final as of `now`. */
function chartOf(bars, { currency = 'USD', lastSessionEnd } = {}) {
  return {
    meta: {
      currency,
      exchangeTimezoneName: 'America/New_York',
      currentTradingPeriod: lastSessionEnd ? { regular: { start: lastSessionEnd.start, end: lastSessionEnd.end } } : undefined
    },
    quotes: bars.map(([date, close]) => ({ date: new Date(date + 'T20:00:00.000Z'), close }))
  };
}

test('a job-dated Tue row holding Monday\'s close is updated to Tuesday\'s own close', () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.90); setRate(db, '2026-09-22', 0.91);
  // Job wrote Tuesday's row but with Monday's close (the bug).
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' }); // should be 105

  const bars = finalBars(chartOf([['2026-09-21', 100], ['2026-09-22', 105]]), new Date('2026-09-23T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  assert.strictEqual(plan.updates.length, 1);
  assert.strictEqual(plan.updates[0].date, '2026-09-22');
  assert.strictEqual(plan.updates[0].after.native, 105);
  assert.ok(Math.abs(plan.updates[0].after.eur - 105 * 0.91) < 0.0001);
});

test('a weekend row is deleted when Yahoo has sessions either side of it', () => {
  const db = migratedDb();
  setRate(db, '2026-09-18', 0.9);
  addPrice(db, { ticker: 'AAA', date: '2026-09-18', eur: 90, native: 100, currency: 'USD' }); // Friday
  addPrice(db, { ticker: 'AAA', date: '2026-09-19', eur: 90, native: 100, currency: 'USD' }); // Saturday copy
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' }); // Monday

  const bars = finalBars(
    chartOf([['2026-09-18', 100], ['2026-09-21', 100]]),
    new Date('2026-09-22T12:00:00Z')
  );
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  assert.strictEqual(plan.deletes.length, 1);
  assert.strictEqual(plan.deletes[0].date, '2026-09-19');
  assert.strictEqual(plan.updates.length, 0, 'Friday and Monday already hold their own close');
});

test('a European intraday row stored as a close is corrected to the final close', () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 1, 'EUR');
  // The timer's first-hour print for Monday, stored as if it were a close.
  addPrice(db, { ticker: 'EUCO.PA', date: '2026-09-21', eur: 50.30, native: 50.30, currency: 'EUR' });

  const bars = finalBars(
    { meta: { currency: 'EUR', exchangeTimezoneName: 'Europe/Paris' }, quotes: [{ date: new Date('2026-09-21T15:30:00Z'), close: 49.80 }] },
    new Date('2026-09-22T12:00:00Z')
  );
  const plan = planReconcile(dbRowsOf(db), { 'EUCO.PA': bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  assert.strictEqual(plan.updates.length, 1);
  assert.strictEqual(plan.updates[0].after.native, 49.80);
});

test('a missing session inside the stored range is inserted', () => {
  const db = migratedDb();
  setRate(db, '2026-09-18', 0.9); setRate(db, '2026-09-22', 0.91);
  addPrice(db, { ticker: 'AAA', date: '2026-09-18', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' });

  // Yahoo also has a session on the 21st that never got stored.
  const bars = finalBars(
    chartOf([['2026-09-18', 100], ['2026-09-21', 101], ['2026-09-22', 100]]),
    new Date('2026-09-23T12:00:00Z')
  );
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  assert.strictEqual(plan.inserts.length, 1);
  assert.strictEqual(plan.inserts[0].date, '2026-09-21');
  assert.strictEqual(plan.inserts[0].native, 101);
});

test('a session outside [min,max] of the stored rows is not inserted', () => {
  const db = migratedDb();
  setRate(db, '2026-09-18', 0.9);
  addPrice(db, { ticker: 'AAA', date: '2026-09-18', eur: 90, native: 100, currency: 'USD' });

  // Yahoo has an earlier session too, but the migration must never extend coverage.
  const bars = finalBars(
    chartOf([['2026-09-15', 95], ['2026-09-18', 100]]),
    new Date('2026-09-19T12:00:00Z')
  );
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  assert.strictEqual(plan.inserts.length, 0);
});

test('an untouched row keeps price_eur byte-identical', () => {
  const db = migratedDb();
  setRate(db, '2026-09-18', 0.9);
  // A restated euro value that would not come out of a fresh rate x native calc,
  // exactly like the 2026-09-16 restatement this must not disturb.
  addPrice(db, { ticker: 'AAA', date: '2026-09-18', eur: 91.234, native: 100, currency: 'USD' });

  const bars = finalBars(chartOf([['2026-09-18', 100]]), new Date('2026-09-19T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.deletes.length, 0);
  assert.strictEqual(db.prepare('SELECT price_eur FROM prices WHERE ticker=?').get('AAA').price_eur, 91.234);
});

test('a difference before --since is reported OUT OF WINDOW, and applyPlan refuses', () => {
  const db = migratedDb();
  setRate(db, '2026-01-05', 0.9);
  addPrice(db, { ticker: 'AAA', date: '2026-01-05', eur: 90, native: 100, currency: 'USD' }); // should be 90 native

  const bars = finalBars(chartOf([['2026-01-05', 90]]), new Date('2026-01-06T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-06-01' });

  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.outOfWindow.length, 1);
  const before = dump(db);
  assert.throws(() => applyPlan(db, plan), /OUT OF WINDOW|before --since|refusing/i);
  assert.deepEqual(dump(db), before, 'nothing written by the throw');
});

test('Yahoo returning nothing for one ticker aborts the whole run, nothing written', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-18', 0.9);
  addPrice(db, { ticker: 'AAA', date: '2026-09-18', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'BBB', date: '2026-09-18', eur: 90, native: 100, currency: 'USD' });

  const before = dump(db);
  const yf = { chart: async (ticker) => {
    if (ticker === 'BBB') throw new Error('network error');
    return chartOf([['2026-09-18', 100]]);
  } };

  const code = await main({ db, yf, argv: [], now: new Date('2026-09-19T12:00:00Z'), log: () => {} });
  assert.strictEqual(code, 1);
  assert.deepEqual(dump(db), before);
});

test('a dry run leaves the DB identical and data_version unchanged', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9); setRate(db, '2026-09-22', 0.91);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' }); // wrong, should be 105

  const before = dump(db);
  const versionBefore = db.prepare('SELECT version FROM data_version WHERE id=1').get().version;
  const yf = { chart: async () => chartOf([['2026-09-21', 100], ['2026-09-22', 105]]) };

  const code = await main({ db, yf, argv: [], now: new Date('2026-09-23T12:00:00Z'), log: () => {} });
  assert.strictEqual(code, 0);
  assert.deepEqual(dump(db), before, 'a dry run must not write');
  assert.strictEqual(db.prepare('SELECT version FROM data_version WHERE id=1').get().version, versionBefore);
});

test('apply bumps data_version exactly once, and a second plan is empty', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9); setRate(db, '2026-09-22', 0.91);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' });

  const versionBefore = db.prepare('SELECT version FROM data_version WHERE id=1').get().version;
  const yf = { chart: async () => chartOf([['2026-09-21', 100], ['2026-09-22', 105]]) };
  const now = new Date('2026-09-23T12:00:00Z');

  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'pt-redate-'));
  const code = await main({ db, yf, argv: ['--apply'], now, log: () => {}, backupDirDefault: dir });
  assert.strictEqual(code, 0);
  assert.strictEqual(db.prepare('SELECT version FROM data_version WHERE id=1').get().version, versionBefore + 1);
  assert.strictEqual(db.prepare('SELECT price_native FROM prices WHERE ticker=? AND price_date=?').get('AAA', '2026-09-22').price_native, 105);

  // idempotent: planning again finds nothing left to change
  const dbRows = dbRowsOf(db);
  const bars = finalBars(chartOf([['2026-09-21', 100], ['2026-09-22', 105]]), now);
  const plan2 = planReconcile(dbRows, { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });
  assert.strictEqual(plan2.updates.length + plan2.deletes.length + plan2.inserts.length, 0);

  require('fs').rmSync(dir, { recursive: true, force: true });
});

test('a concurrent write between plan and apply throws, and the DB is unchanged', () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });

  const bars = finalBars(chartOf([['2026-09-21', 105]]), new Date('2026-09-22T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });
  assert.strictEqual(plan.updates.length, 1);

  // Somebody else wrote to the row after the plan was built, before apply runs.
  db.prepare('UPDATE prices SET price_native = 999, price_eur = 899.1 WHERE ticker=?').run('AAA');
  const before = dump(db);

  assert.throws(() => applyPlan(db, plan), /concurrent write/);
  assert.deepEqual(dump(db), before, 'the transaction must roll back everything, not partially apply');
});

test('rollback restores the exact prior dump', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9); setRate(db, '2026-09-22', 0.91);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-19', eur: 90, native: 100, currency: 'USD' }); // weekend copy, will be deleted

  const before = dump(db);
  const bars = finalBars(chartOf([['2026-09-18', 100], ['2026-09-21', 100], ['2026-09-22', 105]]), new Date('2026-09-23T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });
  const changeLog = applyPlan(db, plan);
  assert.notDeepEqual(dump(db), before, 'precondition: apply actually changed something');

  rollback(db, changeLog);
  assert.deepEqual(dump(db), before);
});

test('rollback refuses if a row no longer equals its logged "after"', () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });

  const bars = finalBars(chartOf([['2026-09-21', 105]]), new Date('2026-09-22T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });
  const changeLog = applyPlan(db, plan);

  // Something else changed the row again after the migration applied.
  db.prepare('UPDATE prices SET price_native = 777, price_eur = 700 WHERE ticker=?').run('AAA');
  const before = dump(db);

  assert.throws(() => rollback(db, changeLog), /no longer matches/);
  assert.deepEqual(dump(db), before);
});

test('require(\'../redate-prices\') has no side effects', () => {
  // A real regression this guards against: the CLI block used to run
  // unconditionally, which would try to open a database, read DB_PATH, hit
  // the network via yahoo-finance2, or call process.exit — any of which
  // would break every other test file that merely imports this module.
  // `require.main === module` is what prevents that; assert the *effects*
  // of the guard holding, not just that the file is still non-empty.
  delete require.cache[require.resolve('../redate-prices.js')];
  const origDbPath = process.env.DB_PATH;
  delete process.env.DB_PATH; // the CLI block would refuse immediately if this ran
  const origExit = process.exit;
  let exitCalled = false;
  process.exit = () => { exitCalled = true; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-require-side-effects-'));
  const filesBefore = fs.readdirSync(dir);
  const cwdBefore = process.cwd();
  try {
    process.chdir(dir);
    const m = require('../redate-prices.js');
    assert.ok(m && typeof m.planReconcile === 'function' && typeof m.applyPlan === 'function');
  } finally {
    process.chdir(cwdBefore);
    process.exit = origExit;
    if (origDbPath !== undefined) process.env.DB_PATH = origDbPath;
  }
  assert.strictEqual(exitCalled, false, 'requiring the module must never call process.exit');
  assert.deepEqual(fs.readdirSync(dir), filesBefore, 'requiring the module must not write any file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gatherBars fetches only tickers actually in prices, over their stored range', async () => {
  const db = migratedDb();
  addPrice(db, { ticker: 'AAA', date: '2026-09-18', eur: 90, native: 100, currency: 'USD' });
  const seen = [];
  const yf = { chart: async (ticker, opts) => { seen.push({ ticker, opts }); return chartOf([['2026-09-18', 100]]); } };

  const { barsByTicker, failed } = await gatherBars(db, yf, ['AAA'], new Date('2026-09-19T12:00:00Z'), { delayMs: 0 });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].ticker, 'AAA');
  assert.strictEqual(failed.length, 0);
  assert.ok(barsByTicker.AAA.bars.length >= 1);
});

/**
 * Issue #12 follow-up (bug 2): the "latest value" decomposition must measure
 * against each ticker's latest Yahoo-CONFIRMED FINAL session, not the DB's raw
 * `MAX(price_date)` row — while a session is open, the raw max is one of the
 * trailing rows the bracket guard correctly leaves untouched, and comparing
 * against it used to read as a false "+0.00 / +0.00" (nothing to see here)
 * instead of "this run happened too early to judge".
 *
 * `tickerLatestValueDeltas` is exercised directly with hand-built `dbRows` /
 * `barsByTicker` / `plan` fixtures here (rather than through `planReconcile`)
 * so the two purely rate-driven and purely close-driven contributions can be
 * isolated cleanly, independent of what `planReconcile` itself would produce
 * for a given DB state.
 */
test('tickerLatestValueDeltas (a): a rate-only shift and a close-only shift sum with zero residual, per ticker', () => {
  // RDT: the row a reader currently sees is dated *before* the ticker's latest
  // confirmed final session and holds a bogus EUR figure (the "job-dated"
  // artifact); the correct value for the final session has the *same* native
  // close, just under its own date/rate — a pure rate-date effect.
  const dbRows = [
    { id: 1, ticker: 'RDT', price_date: '2026-09-19', price_native: 100, price_usd: 100, price_eur: 87, currency: 'USD', source: 'yahoo_finance' },
    // CHG: the row a reader sees *is* the latest final session, but holds an
    // intraday print instead of the real close — a pure close-changed effect.
    { id: 2, ticker: 'CHG', price_date: '2026-09-18', price_native: 50.30, price_usd: null, price_eur: 50.30, currency: 'EUR', source: 'yahoo_finance' }
  ];
  const barsByTicker = {
    RDT: { currency: 'USD', bars: [{ date: '2026-09-18', close: 100 }] },
    CHG: { currency: 'EUR', bars: [{ date: '2026-09-18', close: 49.80 }] }
  };
  const plan = {
    updates: [
      { id: 2, ticker: 'CHG', date: '2026-09-18', before: { native: 50.30, eur: 50.30 }, after: { native: 49.80, eur: 49.80, currency: 'EUR' } }
    ],
    inserts: [
      { ticker: 'RDT', date: '2026-09-18', native: 100, eur: 90, usd: 100, currency: 'USD' }
    ],
    deletes: [], outOfWindow: []
  };
  const rateFor = () => 0.90;

  const { byTicker } = tickerLatestValueDeltas(dbRows, barsByTicker, plan, rateFor);

  const rdt = byTicker.get('RDT'), chg = byTicker.get('CHG');
  assert.ok(rdt && chg, 'both tickers produced a per-share delta');
  assert.ok(Math.abs(rdt.rateDateEffect - 3.00) < 0.01, `RDT rateDateEffect was ${rdt.rateDateEffect}`);
  assert.ok(Math.abs(rdt.closeChangedEffect) < 0.01, 'RDT is a pure rate-date effect');
  assert.ok(Math.abs(chg.closeChangedEffect - -0.50) < 0.01, `CHG closeChangedEffect was ${chg.closeChangedEffect}`);
  assert.ok(Math.abs(chg.rateDateEffect) < 0.01, 'CHG is a pure close-changed effect');
  assert.ok(Math.abs(rdt.delta - (rdt.rateDateEffect + rdt.closeChangedEffect)) < 0.01);
  assert.ok(Math.abs(rdt.residual) < 0.01, `RDT residual was ${rdt.residual}`);
  assert.ok(Math.abs(chg.residual) < 0.01, `CHG residual was ${chg.residual}`);
});

test('tickerLatestValueDeltas (b): trailing open-edge rows still give a correct, non-zero per-ticker delta, and are reported', () => {
  const db = migratedDb();
  setRate(db, '2026-09-18', 0.90);
  // Friday's close is correctly stored; Saturday carries a bogus forward copy,
  // and nothing has been written yet for the following week — the run happens
  // before Monday's session exists at all, so Monday is not yet judgeable.
  addPrice(db, { ticker: 'AAA', date: '2026-09-18', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-19', eur: 87, native: 100, currency: 'USD' }); // bogus weekend copy
  addPrice(db, { ticker: 'AAA', date: '2026-09-20', eur: 87, native: 100, currency: 'USD' }); // another trailing row

  const dbRows = dbRowsOf(db);
  const bars = finalBars(chartOf([['2026-09-18', 100]]), new Date('2026-09-19T08:00:00Z')); // only Friday is final so far
  const barsByTicker = { AAA: bars };
  const rateFor = makeRateLookup(db);
  const plan = planReconcile(dbRows, barsByTicker, { rateFor, since: '2026-01-01' });

  const lines = [];
  const { openEdgeCount } = printPlan((s) => lines.push(s), plan, dbRows, barsByTicker, rateFor, db);

  assert.strictEqual(openEdgeCount, 2, 'both trailing rows (09-19 and 09-20) are left untouched');
  const warning = lines.find(l => l.includes('⚠'));
  assert.ok(warning, 'a warning line was printed');
  assert.match(warning, /⚠ 2 row\(s\) on or after 2026-09-19 left untouched/);
  assert.match(warning, /not final yet/);
  assert.match(warning, /22:30.*07:30 Lisbon/);

  const { byTicker } = tickerLatestValueDeltas(dbRows, barsByTicker, plan, rateFor);
  const aaa = byTicker.get('AAA');
  assert.ok(aaa, 'AAA produced a per-share delta, not a false "nothing to see here"');
  assert.ok(Math.abs(aaa.delta) > 0.01, 'the delta is non-zero, not a false "+0.00"');
  assert.ok(Math.abs(aaa.residual) < 0.01);
});

test('tickerLatestValueDeltas (c): nothing to change gives no per-ticker entries and prints no warning', () => {
  const db = migratedDb();
  setRate(db, '2026-09-18', 0.90);
  addPrice(db, { ticker: 'AAA', date: '2026-09-18', eur: 90, native: 100, currency: 'USD' });

  const dbRows = dbRowsOf(db);
  const bars = finalBars(chartOf([['2026-09-18', 100]]), new Date('2026-09-19T12:00:00Z'));
  const barsByTicker = { AAA: bars };
  const rateFor = makeRateLookup(db);
  const plan = planReconcile(dbRows, barsByTicker, { rateFor, since: '2026-01-01' });

  const { byTicker, openEdge } = tickerLatestValueDeltas(dbRows, barsByTicker, plan, rateFor);
  assert.strictEqual(byTicker.size, 0);
  assert.strictEqual(openEdge.rows.length, 0);

  const lines = [];
  printPlan((s) => lines.push(s), plan, dbRows, barsByTicker, rateFor, db);
  assert.ok(!lines.some(l => l.includes('⚠')), 'no open-edge warning when there is nothing left dangling');
});

/**
 * Bug 2 follow-up: the acceptance criterion (plan Q1) is a PORTFOLIO'S latest
 * EUR value, holdings-weighted — not one share of every ticker the run
 * touched. `portfolioEffectsByUser` is exercised here with real users and
 * transactions (via `replayPosition`, so splits are applied exactly the way
 * the app applies them), against hand-built `tickerLatestValueDeltas`-shaped
 * fixtures so the weighting itself is isolated from `planReconcile`.
 */
test('portfolioEffectsByUser: 10 shares of a rate-date-only ticker gives 10x the per-share rate effect', () => {
  const db = migratedDb();
  const user = addUser(db, 'ten@example.com');
  addTx(db, user, { ticker: 'RDT', quantity: 10, amount: 800, type: 'buy', ts: day(1) });

  const byTicker = new Map([
    ['RDT', { ticker: 'RDT', delta: 30, rateDateEffect: 3, closeChangedEffect: 0, residual: 0 }]
  ]);

  const { lines } = portfolioEffectsByUser(db, byTicker, null);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].heldCount, 1);
  assert.ok(Math.abs(lines[0].rateDateEffect - 30) < 0.01, `rateDateEffect was ${lines[0].rateDateEffect}`);
  assert.ok(Math.abs(lines[0].closeChangedEffect) < 0.01);
  assert.ok(Math.abs(lines[0].total - 300) < 0.01, `total was ${lines[0].total}`);
});

test('portfolioEffectsByUser: 3 shares of a close-changed-only ticker gives 3x the per-share close effect', () => {
  const db = migratedDb();
  const user = addUser(db, 'three@example.com');
  addTx(db, user, { ticker: 'CHG', quantity: 3, amount: 150, type: 'buy', ts: day(1) });

  const byTicker = new Map([
    ['CHG', { ticker: 'CHG', delta: -0.5, rateDateEffect: 0, closeChangedEffect: -0.5, residual: 0 }]
  ]);

  const { lines } = portfolioEffectsByUser(db, byTicker, null);
  assert.strictEqual(lines.length, 1);
  assert.ok(Math.abs(lines[0].rateDateEffect) < 0.01);
  assert.ok(Math.abs(lines[0].closeChangedEffect - -1.5) < 0.01, `closeChangedEffect was ${lines[0].closeChangedEffect}`);
  assert.ok(Math.abs(lines[0].total - -1.5) < 0.01, `total was ${lines[0].total}`);
});

test('portfolioEffectsByUser: a changed ticker nobody holds contributes 0', () => {
  const db = migratedDb();
  const user = addUser(db, 'nobody-holds-this@example.com');
  addTx(db, user, { ticker: 'AAA', quantity: 5, amount: 500, type: 'buy', ts: day(1) });

  const byTicker = new Map([
    ['RDT', { ticker: 'RDT', delta: 30, rateDateEffect: 30, closeChangedEffect: 0, residual: 0 }]
  ]);

  const { lines } = portfolioEffectsByUser(db, byTicker, null);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].hasEffect, false, 'AAA is held but untouched by this run, RDT is touched but not held');
  assert.strictEqual(lines[0].total, 0);
});

test('portfolioEffectsByUser: a sold-out user contributes 0 (no line at all)', () => {
  const db = migratedDb();
  const user = addUser(db, 'sold-out@example.com');
  addTx(db, user, { ticker: 'RDT', quantity: 10, amount: 800, type: 'buy', ts: day(1) });
  addTx(db, user, { ticker: 'RDT', quantity: 10, amount: 900, type: 'sell', ts: day(2) });

  const byTicker = new Map([
    ['RDT', { ticker: 'RDT', delta: 30, rateDateEffect: 3, closeChangedEffect: 0, residual: 0 }]
  ]);

  const { lines } = portfolioEffectsByUser(db, byTicker, null);
  assert.strictEqual(lines.length, 0, 'a user who holds nothing at all gets no line');
});

test('portfolioEffectsByUser: a split between the trade and today uses the post-split quantity', () => {
  const db = migratedDb();
  const user = addUser(db, 'split@example.com');
  // Bought 5 shares before a 2-for-1 split: 10 shares today.
  addTx(db, user, { ticker: 'RDT', quantity: 5, amount: 400, type: 'buy', ts: day(1) });
  addSplit(db, { ticker: 'RDT', date: '2026-01-05', ratio: 2 });

  const byTicker = new Map([
    ['RDT', { ticker: 'RDT', delta: 30, rateDateEffect: 3, closeChangedEffect: 0, residual: 0 }]
  ]);

  const { lines } = portfolioEffectsByUser(db, byTicker, null);
  assert.strictEqual(lines.length, 1);
  assert.ok(Math.abs(lines[0].total - 300) < 0.01, `total was ${lines[0].total} — expected 10 (post-split) x 30`);
});

test('portfolioEffectsByUser: two users give two separate lines', () => {
  const db = migratedDb();
  const alice = addUser(db, 'alice@example.com');
  const bob = addUser(db, 'bob@example.com');
  addTx(db, alice, { ticker: 'RDT', quantity: 10, amount: 800, type: 'buy', ts: day(1) });
  addTx(db, bob, { ticker: 'RDT', quantity: 4, amount: 320, type: 'buy', ts: day(1) });

  const byTicker = new Map([
    ['RDT', { ticker: 'RDT', delta: 30, rateDateEffect: 3, closeChangedEffect: 0, residual: 0 }]
  ]);

  const { lines } = portfolioEffectsByUser(db, byTicker, null);
  assert.strictEqual(lines.length, 2);
  const byUser = Object.fromEntries(lines.map(l => [l.userId, l]));
  assert.ok(Math.abs(byUser[alice].total - 300) < 0.01);
  assert.ok(Math.abs(byUser[bob].total - 120) < 0.01);
});

test('portfolioEffectsByUser: masks the email when an identity db is available, else falls back to the key prefix', () => {
  const db = migratedDb();
  const user = addUser(db, 'labeltest@example.com');
  addTx(db, user, { ticker: 'RDT', quantity: 1, amount: 80, type: 'buy', ts: day(1) });
  const byTicker = new Map([['RDT', { ticker: 'RDT', delta: 1, rateDateEffect: 1, closeChangedEffect: 0, residual: 0 }]]);

  const withIdentity = portfolioEffectsByUser(db, byTicker, db.identity);
  assert.strictEqual(withIdentity.lines[0].label, 'la***@example.com');

  const withoutIdentity = portfolioEffectsByUser(db, byTicker, null);
  assert.strictEqual(withoutIdentity.lines[0].label, user.slice(0, 8));
});

test('findOpenEdgeRows reports the earliest trailing date across tickers', () => {
  const barsByTicker = {
    AAA: { bars: [{ date: '2026-09-18', close: 100 }] },
    BBB: { bars: [{ date: '2026-09-17', close: 50 }] }
  };
  const dbRows = [
    { ticker: 'AAA', price_date: '2026-09-19', price_native: 100, price_eur: 90 },
    { ticker: 'BBB', price_date: '2026-09-18', price_native: 50, price_eur: 45 },
    { ticker: 'BBB', price_date: '2026-09-17', price_native: 50, price_eur: 45 } // this one is not trailing
  ];
  const { rows, date } = findOpenEdgeRows(dbRows, barsByTicker);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(date, '2026-09-18');
});

/* ================================================================
 * B1: the change log is written BEFORE the transaction, as "pending", and
 * rewritten "applied" only once the commit is durable. A crash between the
 * commit and that rewrite must leave a "pending" log that rollback() still
 * trusts (after checking the DB really was migrated); a transaction that
 * never commits must leave nothing applied and a log that says so.
 * ================================================================ */

function scratchDir(prefix = 'pt-redate-b1-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('B1: --apply writes the log pending before the transaction, then applied after it commits', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9); setRate(db, '2026-09-22', 0.91);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' });

  const yf = { chart: async () => chartOf([['2026-09-21', 100], ['2026-09-22', 105]]) };
  const now = new Date('2026-09-23T12:00:00Z');
  const dir = scratchDir();

  const seenWrites = [];
  const writeChangeLog = (logPath, data) => {
    seenWrites.push(JSON.parse(JSON.stringify(data)));
    writeChangeLogAtomic(logPath, data);
  };

  const code = await main({ db, yf, argv: ['--apply'], now, log: () => {}, backupDirDefault: dir, delayMs: 0, writeChangeLog });
  assert.strictEqual(code, 0);

  assert.strictEqual(seenWrites.length, 2, 'the log is written twice: pending, then applied');
  assert.strictEqual(seenWrites[0].status, 'pending');
  assert.strictEqual(seenWrites[1].status, 'applied');
  assert.strictEqual(seenWrites[0].updates.length, 1, 'the pending log already has the planned row');

  const logFile = fs.readdirSync(dir).find(f => f.startsWith('redate-prices-'));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, logFile), 'utf-8'));
  assert.strictEqual(onDisk.status, 'applied', 'the file on disk ends up applied, not pending');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('B1: a crash after the commit but before the log is marked applied leaves a usable pending log', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9); setRate(db, '2026-09-22', 0.91);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' });
  const before = dump(db);

  const yf = { chart: async () => chartOf([['2026-09-21', 100], ['2026-09-22', 105]]) };
  const now = new Date('2026-09-23T12:00:00Z');
  const dir = scratchDir();

  let call = 0;
  const writeChangeLog = (logPath, data) => {
    call++;
    if (call === 1) { writeChangeLogAtomic(logPath, data); return; } // the pending write: succeeds
    throw new Error('simulated crash writing the "applied" status'); // the second write: "crashes"
  };

  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let code;
  try {
    code = await main({ db, yf, argv: ['--apply'], now, log: () => {}, backupDirDefault: dir, delayMs: 0, writeChangeLog });
  } finally {
    console.error = origError;
  }

  assert.strictEqual(code, 1, 'the run must not report success when it cannot confirm the log was updated');
  assert.ok(errors.some(e => e.includes('WAS MIGRATED')), 'a loud message says the DB really was migrated');
  assert.notDeepEqual(dump(db), before, 'the transaction really did commit — this is not a "nothing written" case');

  const logFile = fs.readdirSync(dir).find(f => f.startsWith('redate-prices-'));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, logFile), 'utf-8'));
  assert.strictEqual(onDisk.status, 'pending', 'the file on disk is stuck at "pending" — exactly what crashed');

  // rollback() must still trust this pending log, because the DB backs it up.
  rollback(db, onDisk);
  assert.deepEqual(dump(db), before, 'rollback from the crashed pending log restores exactly');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('B1: an abort mid-transaction (concurrent write) leaves nothing written and the log is not "applied"', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  const before = dump(db);

  // The plan is built against today's stored value, but applyPlan re-checks
  // it once it actually runs — flip it first so the optimistic check aborts.
  const yf = { chart: async () => chartOf([['2026-09-21', 105]]) };
  const now = new Date('2026-09-22T12:00:00Z');
  const dir = scratchDir();

  const realDbBackup = db.backup.bind(db);
  db.backup = async (dest) => {
    // Simulate another writer landing between the backup and the transaction,
    // the same race the optimistic per-row check exists to catch.
    db.prepare('UPDATE prices SET price_native = 999, price_eur = 899.1 WHERE ticker = ?').run('AAA');
    return realDbBackup(dest);
  };

  const code = await main({ db, yf, argv: ['--apply'], now, log: () => {}, backupDirDefault: dir, delayMs: 0 });
  assert.strictEqual(code, 1);

  const logFile = fs.readdirSync(dir).find(f => f.startsWith('redate-prices-'));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, logFile), 'utf-8'));
  assert.strictEqual(onDisk.status, 'aborted', 'the log must not be left looking "applied" after an abort');

  assert.throws(() => rollback(db, onDisk), /nothing to roll back/i);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('B1: rollback refuses a pending log whose transaction never committed ("nothing to roll back")', () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9); setRate(db, '2026-09-22', 0.91);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' });

  const bars = finalBars(chartOf([['2026-09-21', 100], ['2026-09-22', 105]]), new Date('2026-09-23T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  // Written as if by --apply, but the transaction underneath never actually ran.
  const pendingLog = { status: 'pending', createdAt: new Date().toISOString(), updates: plan.updates, deletes: plan.deletes, inserts: plan.inserts };
  assert.throws(() => rollback(db, pendingLog), /nothing to roll back/i);
});

test('changeLogMatchesDb: true only once every logged row is actually in place', () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9); setRate(db, '2026-09-22', 0.91);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' });

  const bars = finalBars(chartOf([['2026-09-21', 100], ['2026-09-22', 105]]), new Date('2026-09-23T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });
  assert.strictEqual(changeLogMatchesDb(db, plan), false, 'not applied yet');

  const changeLog = applyPlan(db, plan);
  assert.strictEqual(changeLogMatchesDb(db, changeLog), true, 'now it matches');
});

/* ================================================================
 * B2: the backup --apply writes must be gzipped under backup-db.sh's own
 * naming convention, so its --restore path resolves the same destination
 * this script would and never hands gunzip an uncompressed file.
 * ================================================================ */

test('B2: gzipBackup produces a byte-identical round trip', async () => {
  const dir = scratchDir('pt-redate-b2-');
  const raw = path.join(dir, 'source.bin');
  const original = Buffer.from('a fictional sqlite file, repeated '.repeat(500), 'utf-8');
  fs.writeFileSync(raw, original);

  const gz = `${raw}.gz`;
  await gzipBackup(raw, gz);

  assert.ok(!fs.existsSync(raw), 'the raw file is removed once gzipped');
  assert.ok(fs.existsSync(gz));
  const restored = zlib.gunzipSync(fs.readFileSync(gz));
  assert.ok(restored.equals(original), 'gunzip of the backup reproduces the original bytes exactly');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('B2: --apply names the backup portfolio.db.pre-redate-<stamp>.gz, matching backup-db.sh\'s --restore parsing', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9); setRate(db, '2026-09-22', 0.91);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' });

  const yf = { chart: async () => chartOf([['2026-09-21', 100], ['2026-09-22', 105]]) };
  const now = new Date('2026-09-23T12:00:00Z');
  const dir = scratchDir('pt-redate-b2-');

  const code = await main({ db, yf, argv: ['--apply'], now, log: () => {}, backupDirDefault: dir, delayMs: 0 });
  assert.strictEqual(code, 0);

  const files = fs.readdirSync(dir);
  const backupFile = files.find(f => f.startsWith('portfolio.db.pre-redate-'));
  assert.ok(backupFile, 'a backup file was written');
  assert.ok(backupFile.endsWith('.gz'), 'the backup is gzipped, not raw');
  assert.ok(!files.includes(backupFile.slice(0, -3)), 'no uncompressed copy is left behind');

  // backup-db.sh's restore_backup derives the destination as `${base%%.db.*}.db`.
  const base = backupFile;
  const derived = base.replace(/\.db\..*$/, '.db');
  assert.strictEqual(derived, 'portfolio.db', 'backup-db.sh --restore would target portfolio.db, not truncate something else');

  // And it must actually be valid gzip holding the real backup bytes.
  const restored = zlib.gunzipSync(fs.readFileSync(path.join(dir, backupFile)));
  assert.ok(restored.length > 0);
  assert.deepEqual(restored.subarray(0, 16).toString('utf8', 0, 15), 'SQLite format 3');

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ================================================================
 * S1: serviceIsActive must treat a Type=oneshot unit's "activating" (and
 * "reloading") state as busy, using `systemctl show -p ActiveState --value`
 * rather than `systemctl is-active` (which exits non-zero for "activating").
 * ================================================================ */

function withFakeSystemctl(state, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-fake-systemctl-'));
  const scriptPath = path.join(dir, 'systemctl');
  fs.writeFileSync(scriptPath, `#!/bin/sh
if [ "$1" = "show" ] && [ "$2" = "-p" ] && [ "$3" = "ActiveState" ] && [ "$4" = "--value" ] && [ -n "$5" ]; then
  echo "${state}"
  exit 0
fi
exit 1
`, { mode: 0o755 });
  const origPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${origPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('S1: serviceIsActive treats active, activating and reloading as busy', () => {
  for (const state of ['active', 'activating', 'reloading']) {
    withFakeSystemctl(state, () => {
      assert.strictEqual(serviceIsActive('portfolio-price-fetch.service'), true, `"${state}" must count as busy`);
    });
  }
});

test('S1: serviceIsActive treats inactive/failed/deactivating as not busy', () => {
  for (const state of ['inactive', 'failed', 'deactivating']) {
    withFakeSystemctl(state, () => {
      assert.strictEqual(serviceIsActive('portfolio-price-fetch.service'), false, `"${state}" must not count as busy`);
    });
  }
});

test('S1: serviceIsActive is false, not throwing, when systemctl is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-no-systemctl-'));
  const origPath = process.env.PATH;
  process.env.PATH = dir; // a PATH with no systemctl on it at all
  try {
    assert.strictEqual(serviceIsActive('portfolio-price-fetch.service'), false);
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ================================================================
 * S6: a bracketed delete must be labelled "weekend/holiday" only when the
 * date really is one — a real weekday with no Yahoo bar (a data gap) gets a
 * distinct label so the dry run's human reviewer notices it. A known market
 * holiday (e.g. US Labor Day) must NOT be mislabelled as a plain data gap.
 * ================================================================ */

test('S6: a Saturday/Sunday delete is labelled weekend/holiday, not flagged', () => {
  const db = migratedDb();
  setRate(db, '2026-09-18', 0.9);
  addPrice(db, { ticker: 'AAA', date: '2026-09-18', eur: 90, native: 100, currency: 'USD' }); // Friday
  addPrice(db, { ticker: 'AAA', date: '2026-09-19', eur: 90, native: 100, currency: 'USD' }); // Saturday
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' }); // Monday

  const bars = finalBars(chartOf([['2026-09-18', 100], ['2026-09-21', 100]]), new Date('2026-09-22T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  assert.strictEqual(plan.deletes.length, 1);
  assert.strictEqual(plan.deletes[0].weekdayGap, false);
  assert.match(plan.deletes[0].reason, /weekend\/holiday/);
});

test('S6: a real US market holiday (Labor Day) is NOT mislabelled as a weekday gap', () => {
  assert.strictEqual(isKnownNonSession('2026-09-07'), true, '2026-09-07 is US Labor Day');

  const db = migratedDb();
  setRate(db, '2026-09-04', 0.9);
  addPrice(db, { ticker: 'AMD', date: '2026-09-04', eur: 90, native: 100, currency: 'USD' }); // Friday before
  addPrice(db, { ticker: 'AMD', date: '2026-09-07', eur: 90, native: 100, currency: 'USD' }); // Labor Day (Monday)
  addPrice(db, { ticker: 'AMD', date: '2026-09-08', eur: 90, native: 100, currency: 'USD' }); // Tuesday after

  const bars = finalBars(chartOf([['2026-09-04', 100], ['2026-09-08', 100]]), new Date('2026-09-09T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AMD: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  assert.strictEqual(plan.deletes.length, 1);
  assert.strictEqual(plan.deletes[0].date, '2026-09-07');
  assert.strictEqual(plan.deletes[0].weekdayGap, false, 'a known holiday must not be flagged as a data gap');
  assert.match(plan.deletes[0].reason, /weekend\/holiday/);
});

test('S6: a real weekday with no Yahoo session at all is flagged distinctly as a gap', () => {
  const db = migratedDb();
  setRate(db, '2026-09-15', 0.9); // a Tuesday, not a holiday
  addPrice(db, { ticker: 'AAA', date: '2026-09-14', eur: 90, native: 100, currency: 'USD' }); // Monday
  addPrice(db, { ticker: 'AAA', date: '2026-09-15', eur: 90, native: 100, currency: 'USD' }); // Tuesday: Yahoo has no bar
  addPrice(db, { ticker: 'AAA', date: '2026-09-16', eur: 90, native: 100, currency: 'USD' }); // Wednesday

  const bars = finalBars(chartOf([['2026-09-14', 100], ['2026-09-16', 100]]), new Date('2026-09-17T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  assert.strictEqual(plan.deletes.length, 1);
  assert.strictEqual(plan.deletes[0].date, '2026-09-15');
  assert.strictEqual(plan.deletes[0].weekdayGap, true, '2026-09-15 is a plain Tuesday, not a known holiday');
  assert.match(plan.deletes[0].reason, /weekday/i);

  const lines = [];
  printPlan((s) => lines.push(s), plan, dbRowsOf(db), { AAA: bars }, makeRateLookup(db), db);
  assert.ok(lines.some(l => l.includes('weekday gap')), 'the dry run flags it distinctly in the log');
  assert.ok(lines.some(l => /Plan:.*1 weekday gap/.test(l)), 'the summary line counts weekday gaps');
});

/* ================================================================
 * Currency-mismatch guard nit: never guess across a currency mismatch.
 * ================================================================ */

test('a row whose stored currency no longer matches Yahoo\'s is left untouched and flagged', () => {
  const db = migratedDb();
  setRate(db, '2026-09-18', 0.9, 'GBP');
  // Stored in pence (GBp); Yahoo now reports pounds (GBP) for the same ticker.
  addPrice(db, { ticker: 'BP', date: '2026-09-18', eur: 900, native: 10000, currency: 'GBp' });

  const bars = finalBars(
    { meta: { currency: 'GBP', exchangeTimezoneName: 'Europe/London' }, quotes: [{ date: new Date('2026-09-18T16:30:00Z'), close: 100 }] },
    new Date('2026-09-19T12:00:00Z')
  );
  const plan = planReconcile(dbRowsOf(db), { BP: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.deletes.length, 0);
  assert.strictEqual(plan.currencyMismatches.length, 1);
  assert.strictEqual(plan.currencyMismatches[0].dbCurrency, 'GBp');
  assert.strictEqual(plan.currencyMismatches[0].yahooCurrency, 'GBP');
});

/* ================================================================
 * NULL price_native guard nit: `null - x` coerces to `x` in JS, so a stored
 * NULL must never be treated as "already correct" by the tolerance check —
 * it always needs Yahoo's real close written over it.
 * ================================================================ */

test('a NULL price_native is always corrected, not silently left as "already equal"', () => {
  const db = migratedDb();
  setRate(db, '2026-09-18', 0.9);
  // price_eur is NOT NULL in the schema; only price_native (what the tolerance
  // check reads) is the concern this test is about.
  db.prepare(`
    INSERT INTO prices (ticker, price_eur, price_usd, price_native, currency, price_date, source)
    VALUES ('AAA', 0, NULL, NULL, 'USD', '2026-09-18', 'test')
  `).run();

  const bars = finalBars(chartOf([['2026-09-18', 0]]), new Date('2026-09-19T12:00:00Z'));
  // A close of 0 is the one value that would slip past a naive `null - x`
  // coercion (0 - 0 === 0), so this specifically exercises the guard rather
  // than just relying on "any positive close differs from null by a lot".
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });

  assert.strictEqual(plan.updates.length, 1, 'a NULL stored price must always be treated as needing correction');
  assert.strictEqual(plan.updates[0].after.native, 0);
});

/* ================================================================
 * CLI argument validation (nit): a missing or malformed value must be
 * rejected, not silently ignored or fallen through to a dry run.
 * ================================================================ */

test('CLI: --since with a missing value is rejected', async () => {
  const db = migratedDb();
  const lines = [];
  const code = await main({ db, yf: { chart: async () => { throw new Error('must not be reached'); } }, argv: ['--since'], now: new Date(), log: (s) => lines.push(s) });
  assert.strictEqual(code, 1);
  assert.ok(lines.some(l => /--since needs a value/.test(l)));
});

test('CLI: --since with a malformed value is rejected', async () => {
  const db = migratedDb();
  const lines = [];
  const code = await main({ db, yf: { chart: async () => { throw new Error('must not be reached'); } }, argv: ['--since', 'yesterday'], now: new Date(), log: (s) => lines.push(s) });
  assert.strictEqual(code, 1);
  assert.ok(lines.some(l => /not YYYY-MM-DD/.test(l)));
});

test('CLI: --backup-dir with a missing value is rejected', async () => {
  const db = migratedDb();
  const lines = [];
  const code = await main({ db, yf: { chart: async () => { throw new Error('must not be reached'); } }, argv: ['--backup-dir'], now: new Date(), log: (s) => lines.push(s) });
  assert.strictEqual(code, 1);
  assert.ok(lines.some(l => /--backup-dir needs a value/.test(l)));
});

test('CLI: a bare --rollback with no file does not quietly fall through to a dry run', async () => {
  const db = migratedDb();
  const lines = [];
  const code = await main({ db, yf: { chart: async () => { throw new Error('must not be reached'); } }, argv: ['--rollback'], now: new Date(), log: (s) => lines.push(s) });
  assert.strictEqual(code, 1);
  assert.ok(lines.some(l => /--rollback needs a value/.test(l)));
});

test('CLI: an unknown argument is rejected', async () => {
  const db = migratedDb();
  const lines = [];
  const code = await main({ db, yf: { chart: async () => { throw new Error('must not be reached'); } }, argv: ['--bogus'], now: new Date(), log: (s) => lines.push(s) });
  assert.strictEqual(code, 1);
  assert.ok(lines.some(l => /unknown argument/.test(l)));
});

/* ================================================================
 * main() --apply refuses OUT OF WINDOW, end to end through the CLI (not just
 * applyPlan directly) — and leaves the database untouched.
 * ================================================================ */

test('main --apply refuses when the plan has an OUT-OF-WINDOW change, and writes nothing', async () => {
  const db = migratedDb();
  setRate(db, '2026-01-05', 0.9);
  addPrice(db, { ticker: 'AAA', date: '2026-01-05', eur: 90, native: 100, currency: 'USD' }); // should be 90 native, wrong

  const yf = { chart: async () => chartOf([['2026-01-05', 90]]) };
  const now = new Date('2026-01-06T12:00:00Z');
  const dir = scratchDir('pt-redate-oow-');
  const before = dump(db);

  const code = await main({ db, yf, argv: ['--apply', '--since', '2026-06-01'], now, log: () => {}, backupDirDefault: dir, delayMs: 0 });
  assert.strictEqual(code, 1);
  assert.deepEqual(dump(db), before, 'nothing written when refusing OUT OF WINDOW');
  assert.deepEqual(fs.readdirSync(dir), [], 'no backup or change log written on refusal');

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ================================================================
 * End-to-end: --apply through the CLI, then --rollback through the CLI
 * reading the actual change-log file it wrote (not the in-memory object) —
 * this is the path an operator actually runs.
 * ================================================================ */

test('main --apply then main --rollback <file> round-trips through the real backup and change-log files', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9); setRate(db, '2026-09-22', 0.91);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' }); // wrong, should be 105

  const yf = { chart: async () => chartOf([['2026-09-21', 100], ['2026-09-22', 105]]) };
  const now = new Date('2026-09-23T12:00:00Z');
  const dir = scratchDir('pt-redate-roundtrip-');
  const before = dump(db);

  const applyCode = await main({ db, yf, argv: ['--apply'], now, log: () => {}, backupDirDefault: dir, delayMs: 0 });
  assert.strictEqual(applyCode, 0);
  assert.notDeepEqual(dump(db), before, 'precondition: apply actually changed something');

  const files = fs.readdirSync(dir);
  const backupFile = files.find(f => f.startsWith('portfolio.db.pre-redate-') && f.endsWith('.gz'));
  const logFile = files.find(f => f.startsWith('redate-prices-') && f.endsWith('.json'));
  assert.ok(backupFile, 'the backup file exists on disk');
  assert.ok(logFile, 'the change-log file exists on disk');

  const logPath = path.join(dir, logFile);
  const loggedChanges = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
  assert.strictEqual(loggedChanges.status, 'applied');

  const rollbackCode = await main({ db, yf, argv: ['--rollback', logPath], now, log: () => {}, backupDirDefault: dir });
  assert.strictEqual(rollbackCode, 0);
  assert.deepEqual(dump(db), before, 'rollback through the CLI, reading the real file, restores exactly');

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ================================================================
 * File permissions nit: the backup and change-log directory and files hold
 * real prices and (via the identity lookup) point at real users — they must
 * not be created world- or group-readable, even when the containing
 * directory did not already exist.
 * ================================================================ */

test('--apply creates the backup directory 0700 and writes the backup/log files 0600', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.9); setRate(db, '2026-09-22', 0.91);
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-22', eur: 90.9, native: 100, currency: 'USD' });

  const yf = { chart: async () => chartOf([['2026-09-21', 100], ['2026-09-22', 105]]) };
  const now = new Date('2026-09-23T12:00:00Z');
  const parent = scratchDir('pt-redate-perms-');
  const dir = path.join(parent, 'nested', 'backups'); // must not already exist

  const code = await main({ db, yf, argv: ['--apply'], now, log: () => {}, backupDirDefault: dir, delayMs: 0 });
  assert.strictEqual(code, 0);

  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, 'the backup directory must be created 0700');
  for (const f of fs.readdirSync(dir)) {
    assert.strictEqual(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, `${f} must be 0600`);
  }

  fs.rmSync(parent, { recursive: true, force: true });
});

/* ================================================================
 * Concurrency guard nit: applyPlan's optimistic check must also catch a
 * concurrent DELETE (someone else already removed the row) and a concurrent
 * INSERT collision (someone else already wrote the date this plan means to
 * insert), not just a concurrent UPDATE.
 * ================================================================ */

test('a concurrent delete of a row this plan means to delete throws, and the DB is unchanged', () => {
  const db = migratedDb();
  setRate(db, '2026-09-18', 0.9);
  addPrice(db, { ticker: 'AAA', date: '2026-09-18', eur: 90, native: 100, currency: 'USD' }); // Friday
  addPrice(db, { ticker: 'AAA', date: '2026-09-19', eur: 90, native: 100, currency: 'USD' }); // Saturday, will be deleted
  addPrice(db, { ticker: 'AAA', date: '2026-09-21', eur: 90, native: 100, currency: 'USD' }); // Monday

  const bars = finalBars(chartOf([['2026-09-18', 100], ['2026-09-21', 100]]), new Date('2026-09-22T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });
  assert.strictEqual(plan.deletes.length, 1);

  // Somebody else already removed the row the plan means to delete.
  db.prepare("DELETE FROM prices WHERE ticker='AAA' AND price_date='2026-09-19'").run();
  const before = dump(db);

  assert.throws(() => applyPlan(db, plan), /concurrent write/);
  assert.deepEqual(dump(db), before, 'the transaction must roll back everything');
});

test('a concurrent insert colliding with a planned insert throws, and the DB is unchanged', () => {
  const db = migratedDb();
  setRate(db, '2026-09-17', 0.9); setRate(db, '2026-09-19', 0.9);
  addPrice(db, { ticker: 'AAA', date: '2026-09-17', eur: 90, native: 100, currency: 'USD' });
  addPrice(db, { ticker: 'AAA', date: '2026-09-19', eur: 90, native: 100, currency: 'USD' });

  // A session on the 18th is missing from the DB, inside [min,max] — planned as an insert.
  const bars = finalBars(chartOf([['2026-09-17', 100], ['2026-09-18', 102], ['2026-09-19', 100]]), new Date('2026-09-20T12:00:00Z'));
  const plan = planReconcile(dbRowsOf(db), { AAA: bars }, { rateFor: makeRateLookup(db), since: '2026-01-01' });
  assert.strictEqual(plan.inserts.length, 1);
  assert.strictEqual(plan.inserts[0].date, '2026-09-18');

  // Somebody else (the daily job, a manual backfill) already wrote that date.
  addPrice(db, { ticker: 'AAA', date: '2026-09-18', eur: 1, native: 1, currency: 'USD' });
  const before = dump(db);

  assert.throws(() => applyPlan(db, plan)); // UNIQUE(ticker, price_date) violation
  assert.deepEqual(dump(db), before, 'the transaction must roll back everything, including the earlier update/delete statements');
});
