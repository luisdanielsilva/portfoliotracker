/**
 * Issue #33: an `exchange_rates` row holds the rate at the end of the FX session it is
 * dated by — Yahoo's next start-of-day snapshot — and `redate-rates.js` brings existing
 * rows into line, re-converting `price_eur` only where a date's rate changed.
 *
 * Fictional tickers and rates throughout; a fake `yf`, no network.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migratedDb: migratedDbBase, addPrice, addUser, addTx, day } = require('./helpers.js');
const { ensureDataVersion } = require('../db-migrations.js');
const {
  fxRatesFromChart, isFxSession, previousFxSession, isDayStart, backfillRates, makeRateLookup, lookupRate,
  reconvertPrices
} = require('../backfill-history.js');
const { fetchExchangeRates, renderRunReport } = require('../price-fetch.js');
const {
  planRates, planPrices, planAll, applyPlan, rollback, changeLogMatchesDb, main, rateTables
} = require('../redate-rates.js');

function migratedDb() { const db = migratedDbBase(); ensureDataVersion(db); return db; }

/** The UTC instant that is 00:00 in London on `dateStr` — 23:00Z the day before in summer. */
function londonMidnight(dateStr) {
  const gmt = new Date(`${dateStr}T00:00:00Z`);
  return isDayStart(gmt, 'Europe/London') ? gmt : new Date(gmt.getTime() - 3600e3);
}

/** A Yahoo-shaped `EUR<CUR>=X` chart: `[date, usdPerEur]` start-of-day snapshots, plus an optional live bar. */
function fxChart(snaps, { live } = {}) {
  const quotes = snaps.map(([d, close]) => ({ date: londonMidnight(d), open: close, close }));
  if (live) quotes.push({ date: new Date(live[0]), open: live[1], close: live[1] });
  return { meta: { currency: 'USD', exchangeTimezoneName: 'Europe/London' }, quotes };
}

const inv = x => parseFloat((1 / x).toFixed(6));

function setRate(db, date, rate, currency = 'USD') {
  return Number(db.prepare(`INSERT INTO exchange_rates (from_currency, to_currency, rate, date) VALUES (?, 'EUR', ?, ?)`)
    .run(currency, rate, date).lastInsertRowid);
}
const ratesOf = db => db.prepare('SELECT id, from_currency, date, rate, created_at FROM exchange_rates ORDER BY from_currency, date').all();
const pricesOf = db => db.prepare('SELECT id, ticker, price_date, price_native, price_eur, currency FROM prices ORDER BY ticker, price_date').all();

// ------------------------------------------------------------- the filing rule

test('isDayStart: London midnight is 23:00Z in summer and 00:00Z in winter', () => {
  assert.strictEqual(isDayStart('2026-09-21T23:00:00.000Z', 'Europe/London'), true);
  assert.strictEqual(isDayStart('2026-09-22T00:00:00.000Z', 'Europe/London'), false);
  assert.strictEqual(isDayStart('2026-01-13T00:00:00.000Z', 'Europe/London'), true);
});

test('FX sessions are weekdays other than 25 December and 1 January', () => {
  assert.strictEqual(isFxSession('2026-09-25'), true);   // Friday
  assert.strictEqual(isFxSession('2026-09-26'), false);  // Saturday
  assert.strictEqual(isFxSession('2025-12-25'), false);  // Thursday, Christmas
  assert.strictEqual(isFxSession('2026-01-01'), false);  // Thursday, New Year
  assert.strictEqual(previousFxSession('2026-09-28'), '2026-09-25', 'Monday → Friday');
  assert.strictEqual(previousFxSession('2026-01-02'), '2025-12-31', 'skips New Year');
  assert.strictEqual(previousFxSession('2025-12-26'), '2025-12-24', 'skips Christmas');
});

test('a snapshot is filed under the session it ends — Tuesday\'s under Monday, Monday\'s under Friday', () => {
  const { rates, pending } = fxRatesFromChart(fxChart([
    ['2026-09-24', 1.10], ['2026-09-25', 1.11], ['2026-09-28', 1.12], ['2026-09-29', 1.13]
  ]));
  assert.deepStrictEqual(rates, [
    { date: '2026-09-23', rate: inv(1.10) },
    { date: '2026-09-24', rate: inv(1.11) },
    { date: '2026-09-25', rate: inv(1.12) },   // Monday's opening snapshot is Friday's close
    { date: '2026-09-28', rate: inv(1.13) }
  ]);
  assert.strictEqual(pending, '2026-09-29', 'the newest snapshot\'s own day has no rate yet');
});

test('the rule is the same in winter, when London midnight is 00:00Z — the old UTC slice only disagreed in summer', () => {
  const { rates } = fxRatesFromChart(fxChart([['2026-01-13', 1.16], ['2026-01-14', 1.17]]));
  assert.deepStrictEqual(rates.map(r => r.date), ['2026-01-12', '2026-01-13']);
});

test('the live bar Yahoo appends for the current day is an intraday quote, and is dropped', () => {
  const { rates, droppedLive } = fxRatesFromChart(fxChart(
    [['2026-09-29', 1.13], ['2026-09-30', 1.134]],
    { live: ['2026-09-30T21:05:56.000Z', 1.1337] }
  ));
  assert.strictEqual(droppedLive, 1);
  assert.deepStrictEqual(rates, [{ date: '2026-09-28', rate: inv(1.13) }, { date: '2026-09-29', rate: inv(1.134) }]);
});

test('a gap in Yahoo\'s bars does not shift the rates either side of it', () => {
  // No bar labelled Wednesday: Tuesday has no snapshot at its end, and Thursday's
  // snapshot is still Wednesday's close — not Tuesday's.
  const { rates } = fxRatesFromChart(fxChart([['2026-09-22', 1.10], ['2026-09-24', 1.12]]));
  assert.deepStrictEqual(rates.map(r => r.date), ['2026-09-21', '2026-09-23']);
});

test('across New Year, 2 January\'s snapshot is 31 December\'s close; a holiday bar, if Yahoo has one, wins', () => {
  assert.deepStrictEqual(fxRatesFromChart(fxChart([['2025-12-31', 1.17], ['2026-01-02', 1.18]])).rates,
    [{ date: '2025-12-30', rate: inv(1.17) }, { date: '2025-12-31', rate: inv(1.18) }]);
  // A bar labelled 1 January is taken with the market shut: it is 31 December's close exactly.
  assert.deepStrictEqual(fxRatesFromChart(fxChart([['2026-01-01', 1.175], ['2026-01-02', 1.18]])).rates,
    [{ date: '2025-12-31', rate: inv(1.175) }]);
});

// ------------------------------------------------------------------- the writers

test('backfillRates writes each rate under its own session through the shared statement; dry run writes nothing', async () => {
  const db = migratedDb();
  const yf = { chart: async (symbol) => { assert.strictEqual(symbol, 'EURUSD=X'); return fxChart([['2026-09-28', 1.12], ['2026-09-29', 1.13]]); } };
  const dry = await backfillRates(db, yf, 'USD', { from: '2026-09-20', to: '2026-10-01', dryRun: true });
  assert.strictEqual(dry.written, 2);
  assert.strictEqual(ratesOf(db).length, 0);

  setRate(db, '2026-09-25', 0.5); // a wrong rate already there is rewritten, not duplicated
  const r = await backfillRates(db, yf, 'USD', { from: '2026-09-20', to: '2026-10-01' });
  assert.deepStrictEqual(r.last, { date: '2026-09-28', rate: inv(1.13) });
  assert.deepStrictEqual(ratesOf(db).map(x => [x.date, x.rate]), [['2026-09-25', inv(1.12)], ['2026-09-28', inv(1.13)]]);
});

test('the daily job no longer files a rate under the day it ran', async () => {
  const db = migratedDb();
  const now = new Date('2026-09-30T08:00:00Z'); // 09:00 Lisbon
  const yf = {
    chart: async () => fxChart([['2026-09-28', 1.12], ['2026-09-29', 1.13], ['2026-09-30', 1.134]], { live: ['2026-09-30T08:00:00Z', 1.1349] }),
    quote: async () => { throw new Error('the job must not ask for a live quote any more'); }
  };
  const { rates, warnings } = await fetchExchangeRates(yf, db, ['USD', 'EUR'], now);
  assert.deepStrictEqual(warnings, [], 'up to date: the newest rate is the session before today');
  const rows = ratesOf(db);
  assert.ok(!rows.some(r => r.date === '2026-09-30'), 'today has no end-of-day rate yet, so no row');
  assert.deepStrictEqual(rows.map(r => [r.date, r.rate]),
    [['2026-09-25', inv(1.12)], ['2026-09-28', inv(1.13)], ['2026-09-29', inv(1.134)]]);
  assert.strictEqual(rates.USD, inv(1.134));
});

test('when Yahoo fails, the job keeps the stored rates and writes nothing', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-28', 0.88);
  const yf = { chart: async () => { throw new Error('rate limited'); } };
  const { rates, warnings } = await fetchExchangeRates(yf, db, ['USD'], new Date('2026-09-30T08:00:00Z'));
  assert.strictEqual(rates.USD, 0.88);
  assert.match(warnings[0], /USD rate unavailable \(rate limited\)/);
  assert.strictEqual(ratesOf(db).length, 1);
});

test('a rate that comes back behind is a warning, in the log and in the run report', async () => {
  const db = migratedDb();
  // Tuesday 09:00 Lisbon: Monday's rate is due (Tuesday's opening snapshot), but Yahoo
  // has only got as far as Monday's opening snapshot — Friday's rate.
  const yf = { chart: async () => fxChart([['2026-09-25', 1.12], ['2026-09-28', 1.13]]) };
  const { warnings } = await fetchExchangeRates(yf, db, ['USD'], new Date('2026-09-29T08:00:00Z'));
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /USD rate is behind: newest is 2026-09-25, expected 2026-09-28/);
  const html = renderRunReport('success', { reason: 'ok', successCount: 1, tickerCount: 1, fxWarnings: warnings });
  assert.match(html, /Exchange rate/);
  assert.match(html, /newest is 2026-09-25/);
});

test('refreshing the rates re-converts every ticker\'s recent closes whose rate changed, cold ones included', async () => {
  const db = migratedDb();
  setRate(db, '2026-09-28', 0.88);
  // A manual run on Tuesday evening wrote Tuesday's close at Monday's rate (Tuesday's
  // was not known yet). COLD is a ticker the next morning's run will not fetch.
  addPrice(db, { ticker: 'COLD', date: '2026-09-29', eur: 88, native: 100 });
  addPrice(db, { ticker: 'COLD', date: '2026-09-28', eur: 88, native: 100 });
  addPrice(db, { ticker: 'EUROPE', date: '2026-09-29', eur: 50, native: 50, currency: 'EUR' });
  addPrice(db, { ticker: 'OLD', date: '2026-08-03', eur: 1, native: 100 }); // outside the window: left alone

  const yf = { chart: async () => fxChart([['2026-09-29', 1 / 0.88], ['2026-09-30', 1 / 0.882]]) };
  const { reconverted } = await fetchExchangeRates(yf, db, ['USD'], new Date('2026-09-30T08:00:00Z'));
  assert.strictEqual(reconverted, 1);
  assert.deepStrictEqual(pricesOf(db).map(p => [p.ticker, p.price_date, p.price_eur]), [
    ['COLD', '2026-09-28', 88], ['COLD', '2026-09-29', 88.2], ['EUROPE', '2026-09-29', 50], ['OLD', '2026-08-03', 1]
  ]);
  assert.strictEqual(reconvertPrices(db, { since: '2026-09-01' }), 0, 'converges: a second pass changes nothing');
});

test('recompute-eur reads Yahoo\'s FX bars through the shared writer, not its own UTC slice', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'recompute-eur.js'), 'utf-8');
  assert.match(src, /backfillRates\(/);
  assert.doesNotMatch(src, /q\.date\.toISOString\(\)\.slice\(0, 10\)/, 'a UTC slice files every summer rate on the wrong day');
});

// ------------------------------------------------------------- redate-rates: plan

/** Reference rates as `fxRatesFromChart` returns them, straight from `[date, rate]` pairs. */
const ref = (pairs, pending = null) => ({ USD: { rates: pairs.map(([date, rate]) => ({ date, rate })), pending, droppedLive: 0 } });

test('planRates: a day-late row is updated, a weekend row deleted, a missing Friday inserted', () => {
  const db = migratedDb();
  // Friday and Monday hold the wrong rates, and there is a row for Sunday.
  setRate(db, '2026-01-08', 0.86); setRate(db, '2026-01-09', 0.861); setRate(db, '2026-01-11', 0.862); setRate(db, '2026-01-12', 0.863);
  const reference = ref([['2026-01-08', 0.86], ['2026-01-09', 0.862], ['2026-01-12', 0.864]]);
  const plan = planRates(ratesOf(db), reference);

  assert.deepStrictEqual(plan.updates.map(u => [u.date, u.before.rate, u.after.rate]), [['2026-01-09', 0.861, 0.862], ['2026-01-12', 0.863, 0.864]]);
  assert.match(plan.updates[0].reason, /neither/);
  assert.deepStrictEqual(plan.deletes.map(d => d.date), ['2026-01-11']);
  assert.deepStrictEqual(plan.inserts, []);
  assert.deepStrictEqual(plan.implausible, []);
});

test('planRates: the reason names what a row held, which is the evidence for the re-dating', () => {
  const db = migratedDb();
  setRate(db, '2026-01-12', 0.86); setRate(db, '2026-01-13', 0.86); setRate(db, '2026-01-14', 0.863);
  const plan = planRates(ratesOf(db), ref([['2026-01-12', 0.86], ['2026-01-13', 0.861], ['2026-01-14', 0.862]]));
  assert.deepStrictEqual(plan.updates.map(u => [u.date, u.reason]), [
    ['2026-01-13', 'held the previous session\'s rate (a day late)'],
    ['2026-01-14', 'matches neither neighbouring session\'s end-of-day rate']
  ]);
});

test('planRates: rounding is not a difference; an FX session inside the range with no row is inserted', () => {
  const db = migratedDb();
  setRate(db, '2026-09-24', 0.87914); setRate(db, '2026-09-28', 0.8793);
  const plan = planRates(ratesOf(db), ref([['2026-09-24', 0.879142], ['2026-09-25', 0.87889], ['2026-09-28', 0.879302]]));
  assert.deepStrictEqual(plan.updates, []);
  assert.deepStrictEqual(plan.inserts.map(i => [i.date, i.rate]), [['2026-09-25', 0.87889]]);
});

test('planRates: rows after the last known rate are left at the open edge, a weekday gap is left unverified', () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.87); setRate(db, '2026-09-22', 0.99); setRate(db, '2026-09-23', 0.871); setRate(db, '2026-09-30', 0.88);
  const plan = planRates(ratesOf(db), ref([['2026-09-21', 0.87], ['2026-09-23', 0.871], ['2026-09-29', 0.88]], '2026-09-30'));
  assert.deepStrictEqual(plan.openEdge.map(o => o.date), ['2026-09-30']);
  assert.deepStrictEqual(plan.unverifiable.map(u => u.date), ['2026-09-22']);
  assert.deepStrictEqual(plan.deletes, []);
});

test('planRates: a correction above 5% is flagged implausible', () => {
  const db = migratedDb();
  setRate(db, '2026-09-21', 0.87); setRate(db, '2026-09-22', 0.95); setRate(db, '2026-09-23', 0.871);
  const plan = planRates(ratesOf(db), ref([['2026-09-21', 0.87], ['2026-09-22', 0.872], ['2026-09-23', 0.871]]));
  assert.deepStrictEqual(plan.implausible.map(x => x.date), ['2026-09-22']);
  assert.throws(() => applyPlan(db, { ...plan, prices: [] }), /exceed 5%/);
});

// ------------------------------------------------------------ redate-rates: prices

test('planPrices re-converts exactly the prices whose date\'s rate changes, at native × new rate', () => {
  const db = migratedDb();
  setRate(db, '2026-01-08', 0.86); setRate(db, '2026-01-09', 0.861); setRate(db, '2026-01-12', 0.863);
  addPrice(db, { ticker: 'AAA', date: '2026-01-08', eur: 86, native: 100 });      // rate unchanged
  addPrice(db, { ticker: 'AAA', date: '2026-01-09', eur: 86.1, native: 100 });    // 0.861 -> 0.862
  addPrice(db, { ticker: 'AAA', date: '2026-01-12', eur: 86.3, native: 100 });    // 0.863 -> 0.864
  addPrice(db, { ticker: 'EEE', date: '2026-01-09', eur: 50, native: 50, currency: 'EUR' }); // never converted
  addPrice(db, { ticker: 'BBB', date: '2026-01-09', eur: 99, native: 100 });      // was not at its rate before

  const rates = ratesOf(db);
  const plan = planRates(rates, ref([['2026-01-08', 0.86], ['2026-01-09', 0.862], ['2026-01-12', 0.864]]));
  const prices = planPrices(pricesOf(db), rates, plan);
  assert.deepStrictEqual(prices.map(p => [p.ticker, p.date, p.before.eur, p.after.eur, p.wasAtRate]), [
    ['AAA', '2026-01-09', 86.1, 86.2, true],
    ['AAA', '2026-01-12', 86.3, 86.4, true],
    ['BBB', '2026-01-09', 99, 86.2, false]
  ]);
});

test('planPrices follows the carry-forward: a Saturday price moves with Friday\'s re-dated rate', () => {
  const db = migratedDb();
  setRate(db, '2026-01-09', 0.861); setRate(db, '2026-01-11', 0.862);
  addPrice(db, { ticker: 'AAA', date: '2026-01-10', eur: 86.1, native: 100 });
  const rates = ratesOf(db);
  // Friday gets Monday's opening snapshot; the Sunday row goes. Saturday reads Friday's.
  const plan = planRates(rates, ref([['2026-01-08', 0.86], ['2026-01-09', 0.862], ['2026-01-12', 0.864]]));
  assert.deepStrictEqual(plan.deletes.map(d => d.date), ['2026-01-11']);
  const after = rateTables(rates, plan).USD;
  assert.strictEqual(lookupRate(after, '2026-01-10'), 0.862);
  assert.deepStrictEqual(planPrices(pricesOf(db), rates, plan).map(p => p.after.eur), [86.2]);
});

// ------------------------------------------------------- redate-rates: apply, rollback

function scenario() {
  const db = migratedDb();
  setRate(db, '2026-01-08', 0.86); setRate(db, '2026-01-09', 0.861); setRate(db, '2026-01-11', 0.862); setRate(db, '2026-01-12', 0.863);
  addPrice(db, { ticker: 'AAA', date: '2026-01-09', eur: 86.1, native: 100 });
  addPrice(db, { ticker: 'AAA', date: '2026-01-12', eur: 86.3, native: 100 });
  const yf = { chart: async () => fxChart([['2026-01-09', 1 / 0.86], ['2026-01-12', 1 / 0.862], ['2026-01-13', 1 / 0.864], ['2026-01-14', 1 / 0.865]]) };
  return { db, yf };
}

test('applyPlan and rollback: one transaction there, the exact rows back', () => {
  const { db } = scenario();
  const beforeRates = ratesOf(db), beforePrices = pricesOf(db);
  const plan = planAll(db, ref([['2026-01-08', 0.86], ['2026-01-09', 0.862], ['2026-01-12', 0.864]]));
  const log = applyPlan(db, plan);

  assert.deepStrictEqual(ratesOf(db).map(r => [r.date, r.rate]), [['2026-01-08', 0.86], ['2026-01-09', 0.862], ['2026-01-12', 0.864]]);
  assert.deepStrictEqual(pricesOf(db).map(p => p.price_eur), [86.2, 86.4]);
  assert.strictEqual(makeRateLookup(db)('USD', '2026-01-10'), 0.862);
  assert.strictEqual(changeLogMatchesDb(db, log), true);

  rollback(db, { ...log, status: 'applied' });
  assert.deepStrictEqual(ratesOf(db), beforeRates, 'ids, dates, rates and created_at all restored');
  assert.deepStrictEqual(pricesOf(db), beforePrices);
});

test('applyPlan: a row that changed since the plan was made aborts everything', () => {
  const { db } = scenario();
  const plan = planAll(db, ref([['2026-01-08', 0.86], ['2026-01-09', 0.862], ['2026-01-12', 0.864]]));
  db.prepare("UPDATE prices SET price_eur = 1 WHERE price_date = '2026-01-12'").run(); // the job ran in between
  const beforeRates = ratesOf(db);
  assert.throws(() => applyPlan(db, plan), /concurrent write/);
  assert.deepStrictEqual(ratesOf(db), beforeRates, 'nothing written');
});

test('rollback refuses an aborted log, and a pending one whose transaction never committed', () => {
  const { db } = scenario();
  const plan = planAll(db, ref([['2026-01-08', 0.86], ['2026-01-09', 0.862], ['2026-01-12', 0.864]]));
  const pending = { status: 'pending', updates: plan.updates, deletes: plan.deletes, inserts: plan.inserts, prices: plan.prices };
  assert.throws(() => rollback(db, { ...pending, status: 'aborted' }), /nothing to roll back/);
  assert.throws(() => rollback(db, pending), /never committed/);
  applyPlan(db, plan);
  assert.doesNotThrow(() => rollback(db, pending), 'a pending log whose commit did happen is reversed');
});

test('main: dry run by default, then --apply with a backup and a change log, then a clean re-run, then --rollback', async () => {
  const { db, yf } = scenario();
  const user = addUser(db);
  addTx(db, user, { ticker: 'AAA', quantity: 10, amount: 800, ts: day(2) });
  const beforeRates = ratesOf(db), beforePrices = pricesOf(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redate-rates-'));
  const opts = { db, yf, now: new Date('2026-01-14T12:00:00Z'), identityDb: null, delayMs: 0, backupDirDefault: dir, serviceActive: () => false };

  const lines = [];
  assert.strictEqual(await main({ ...opts, argv: [], log: s => lines.push(s) }), 0);
  assert.deepStrictEqual(ratesOf(db), beforeRates, 'a dry run writes nothing');
  assert.ok(lines.some(l => /Rates: 2 update\(s\), 1 delete\(s\), 0 insert\(s\)/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /Portfolio effect today, .*total \+1\.00, all of it the rate re-dating/.test(l)), lines.join('\n'));

  assert.strictEqual(await main({ ...opts, argv: ['--apply'], log: () => {} }), 0);
  const files = fs.readdirSync(dir);
  assert.ok(files.some(f => /^portfolio\.db\.pre-redate-rates-.*\.gz$/.test(f)), files.join(', '));
  const logFile = path.join(dir, files.find(f => /^redate-rates-.*\.json$/.test(f)));
  assert.strictEqual(JSON.parse(fs.readFileSync(logFile, 'utf-8')).status, 'applied');

  const again = [];
  await main({ ...opts, argv: [], log: s => again.push(s) });
  assert.ok(again.some(l => /Rates: 0 update\(s\), 0 delete\(s\), 0 insert\(s\)/.test(l)), again.join('\n'));
  assert.ok(again.some(l => /Prices: 0 price_eur/.test(l)), again.join('\n'));

  assert.strictEqual(await main({ ...opts, argv: ['--rollback', logFile], log: () => {} }), 0);
  assert.deepStrictEqual(ratesOf(db), beforeRates);
  assert.deepStrictEqual(pricesOf(db), beforePrices);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('main: refuses to write while the price job is running, and rejects unknown arguments', async () => {
  const { db, yf } = scenario();
  const lines = [];
  const base = { db, yf, identityDb: null, delayMs: 0, log: s => lines.push(s) };
  assert.strictEqual(await main({ ...base, argv: ['--apply'], serviceActive: () => true }), 1);
  assert.strictEqual(await main({ ...base, argv: ['--since', '2026-01-01'], serviceActive: () => false }), 1);
  assert.ok(lines.some(l => /unknown argument/.test(l)));
});

test('requiring redate-rates does not run it', () => {
  const m = require('../redate-rates.js');
  assert.strictEqual(typeof m.main, 'function');
});
