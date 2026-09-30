#!/usr/bin/env node
/**
 * Fill in daily price history for held tickers.
 *
 * price-fetch.js records one row per ticker per day from the day it first runs, so a
 * ticker added today has today's price and nothing before it. Two things break as a
 * result: /api/snapshots falls back to cost basis for any date with no price, so the
 * portfolio-over-time chart shows accumulated cost rather than market value; and
 * without a history there is no high to measure against, so "near the top" cannot be
 * expressed at all.
 *
 * Yahoo serves daily bars via chart(). Each day's close is stored in its own currency
 * and converted using the rate **for that date** — the same principle as
 * recompute-eur.js, and for the same reason: applying today's rate to old dates
 * quietly misprices history.
 *
 * Each row's `price_date` is the bar's own trading date **in the exchange's own
 * timezone** (`meta.exchangeTimezoneName`), not a UTC slice of the clock — see
 * `tradingDate` below. A bar dated today is only kept once it is final — see
 * `isBarFinal` — so a run part-way through a session never writes an intraday price
 * as if it were a close. This is also what `price-fetch.js` now uses for every write,
 * so the daily job and this script cannot disagree: they are the same code (issue #12).
 *
 *   node backfill-history.js                    every held ticker, default depth
 *   node backfill-history.js ORCL --years 5     one ticker, five years
 *   node backfill-history.js --years 2 --dry-run
 *
 * Safe to re-run: rows are upserted per (ticker, date), so it converges rather than
 * duplicating.
 */

const path = require('path');
const Database = require('better-sqlite3');
const YahooFinance = require('yahoo-finance2').default;
const { ensurePriceCurrencyColumns } = require('./db-migrations');

const DEFAULT_YEARS = 2;
const DEFAULT_GRACE_MIN = 30;

function parseArgs(argv) {
  const args = argv.slice(2);
  const yearsIdx = args.indexOf('--years');
  return {
    years: yearsIdx > -1 ? parseFloat(args[yearsIdx + 1]) : DEFAULT_YEARS,
    dryRun: args.includes('--dry-run'),
    tickers: args.filter(a => !a.startsWith('--') && !/^[\d.]+$/.test(a)).map(t => t.toUpperCase())
  };
}

/**
 * A bar's own trading date, in the exchange's own timezone — never computed from
 * the clock. `date` is anything `Date` accepts (a Yahoo bar timestamp, `now`).
 *
 * Today's code used to take a UTC slice of the timestamp. That happens to agree
 * with this for US and European exchanges, all of which open after 00:00 UTC, but
 * it would silently misdate a bar for an exchange that opens *before* midnight UTC
 * (Sydney, Tokyo). `Intl.DateTimeFormat` with the exchange's own zone is correct
 * everywhere, at the cost of nothing today's tickers would ever have noticed.
 */
function tradingDate(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(date));
}

/**
 * Is a bar dated `barDateStr` (exchange-local) the *final* close of its session?
 *
 * A bar dated before today (exchange tz) is always final — the session it belongs
 * to has closed, full stop. A bar dated **today** is final only once
 * `meta.currentTradingPeriod.regular` names today as the current regular session
 * and the clock has passed that session's end by `graceMin` minutes — the grace
 * covers closing auctions (XETRA/Euronext finish about 17:35 CET; Yahoo's own
 * `regular.end` says 17:30) and late US closing prints (ORCL's `regularMarketTime`
 * has been seen at 20:04Z against a 20:00Z close). Missing metadata means "not
 * final" rather than a guess — the bar is picked up on the next run instead.
 *
 * A bar dated *after* today should not occur; treated as not final rather than
 * asserted against, so a clock skew between here and Yahoo cannot crash the job.
 */
function isBarFinal(barDateStr, meta, now, graceMin = DEFAULT_GRACE_MIN) {
  const tz = (meta && meta.exchangeTimezoneName) || 'UTC';
  const todayStr = tradingDate(now, tz);
  if (barDateStr < todayStr) return true;
  if (barDateStr > todayStr) return false;

  const reg = meta && meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  if (!reg || !reg.end || !reg.start) return false;
  if (tradingDate(reg.start, tz) !== todayStr) return false; // metadata does not name today's session

  const graceEnd = new Date(reg.end).getTime() + graceMin * 60000;
  return now.getTime() >= graceEnd;
}

/**
 * The rate for `date` from `rows` (`{date, rate}`, sorted by date ascending): the most
 * recent on or before it, or the earliest one there is for a date before them all.
 * Pure, so redate-rates.js can ask the same question of a table that does not exist
 * yet (the one it is about to write) and get the answer `makeRateLookup` will give.
 */
function lookupRate(rows, date) {
  if (!rows.length) return null;
  let lo = 0, hi = rows.length - 1, best = null;
  while (lo <= hi) {                         // most recent rate on or before `date`
    const mid = (lo + hi) >> 1;
    if (rows[mid].date <= date) { best = rows[mid].rate; lo = mid + 1; } else { hi = mid - 1; }
  }
  // before the first recorded rate, fall back to the earliest one we have
  return best != null ? best : rows[0].rate;
}

/** USD→EUR (etc.) for a given day, carrying the most recent earlier rate forward. */
function makeRateLookup(db) {
  const cache = {};
  return function rateFor(currency, date) {
    if (currency === 'EUR') return 1;
    const key = currency;
    if (!cache[key]) {
      cache[key] = db.prepare(
        "SELECT date, rate FROM exchange_rates WHERE from_currency = ? AND to_currency = 'EUR' ORDER BY date ASC"
      ).all(currency);
    }
    return lookupRate(cache[key], date);
  };
}

/* ================= exchange rates: which date a rate belongs to (issue #33) =================
 * `exchange_rates` row D is the rate a close **on D** is converted at (see `backfillTicker`),
 * so it has to be the rate at the *end* of D — that is what "the rate for the close's own
 * date" means.
 *
 * Yahoo's daily FX bar is not that, and not what its label suggests either. `EURUSD=X` is
 * stamped at 00:00 in its own timezone (`meta.exchangeTimezoneName`, Europe/London), and
 * its "close" is a snapshot taken at that **start**: measured 2026-09-30 against Yahoo's
 * own hourly series over 505 days, a daily close sits 0.035% on average from the day's
 * first hourly open and 0.315% from its last hourly close, and is nearer the start on 464
 * of the 505 days. So the bar Yahoo labels D+1 is the rate at the turn of D into D+1 —
 * about three hours after the US close of D — and it is the right rate for D: against the
 * hourly rate at 16:00 New York on D it is off by 0.079% on average, where the bar Yahoo
 * labels D is off by 0.314%.
 *
 * Hence the rule, which every writer of `exchange_rates` now goes through: **each daily
 * snapshot is filed under the FX session it ends** — the bar labelled Tuesday under Monday,
 * the bar labelled Monday under Friday. FX sessions are weekdays other than 25 December and
 * 1 January, the two days the whole market shuts: the snapshot that opens 2 January is the
 * first price after 31 December's close, and is filed there. It is a calendar rule, not
 * "the bar before it", on purpose: Yahoo has the odd weekday with no bar at all
 * (2017-07-11, 2019-05-22, Easter Monday 2025) although FX traded, and the snapshot after
 * such a gap ends the day that is missing, not the one before it. The newest snapshot has
 * not been followed by another yet, so the latest date with a rate is always the session
 * before today's, and a close written before its snapshot exists carries the previous
 * rate forward until the job's next run rewrites it (the job re-converts its whole ~10-day
 * window every run).
 *
 * Only bars stamped exactly at the start of a day count. Around the current day Yahoo also
 * returns an extra bar stamped at the time of the request, holding the live price; that
 * is an intraday quote, the very thing this issue removes, and it is dropped.
 */
const FX_TZ = 'Europe/London';

/**
 * One rate per currency per day, rewritten if the day's rate is fetched again.
 *
 * Shared by every writer (the daily job, recompute-eur.js, redate-rates.js), because
 * there used to be two copies of this statement and they drifted: both set `updated_at`,
 * a column `exchange_rates` has never had — the pre-split database called it that,
 * `schema.sqlite.sql` calls it `created_at`, and the 2026-09-14 split rebuilt the table
 * from the schema. SQLite resolves column names at prepare() time, so the whole job died
 * on 2026-09-16 rather than degrading. The timestamp is simply gone: nothing reads it,
 * and `created_at` on a row that was just rewritten would be a lie.
 */
const RATE_UPSERT_SQL = `
  INSERT INTO exchange_rates (from_currency, to_currency, rate, date)
  VALUES (?, 'EUR', ?, ?)
  ON CONFLICT(from_currency, to_currency, date)
    DO UPDATE SET rate = excluded.rate
`;

/** The Yahoo symbol whose inverse is the multiplier this app wants: `EURUSD=X` is USD per EUR. */
const fxSymbol = currency => `EUR${currency}=X`;

/** Is `date` exactly 00:00:00 in `tz`? */
function isDayStart(date, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(new Date(date)) === '00:00:00';
}

/** Is `YYYY-MM-DD` a day the FX market trades: a weekday other than 25 Dec and 1 Jan? */
function isFxSession(dateStr) {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  const md = dateStr.slice(5);
  return day !== 0 && day !== 6 && md !== '12-25' && md !== '01-01';
}

/** The FX session before `YYYY-MM-DD`: Monday's is Friday, 2 January's is 31 December. */
function previousFxSession(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1); while (!isFxSession(d.toISOString().slice(0, 10)));
  return d.toISOString().slice(0, 10);
}

/**
 * A raw `chart()` response for `EUR<CUR>=X` in, the rows `exchange_rates` should hold out:
 * `rates` is `[{date, rate}]`, ascending, each rate the multiplier into euros (6 dp, as
 * it has always been stored) filed under the FX session its snapshot ends — see above.
 * `pending` is the newest snapshot's own date: the first day whose rate is not known yet.
 */
function fxRatesFromChart(chart) {
  const tz = (chart && chart.meta && chart.meta.exchangeTimezoneName) || FX_TZ;
  const seen = new Set();
  const snaps = [];
  let droppedLive = 0;
  for (const q of (chart && chart.quotes) || []) {
    if (!(q.close > 0)) continue;
    if (!isDayStart(q.date, tz)) { droppedLive++; continue; }
    const date = tradingDate(q.date, tz);
    if (seen.has(date)) continue;
    seen.add(date);
    snaps.push({ date, close: q.close });
  }
  snaps.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Ascending, first one wins: should Yahoo carry a bar for a day the market is shut
  // (a weekend, Christmas), its snapshot is the previous session's close exactly —
  // better than the one taken after the market reopens.
  const rates = [];
  const filed = new Set();
  for (const s of snaps) {
    const date = previousFxSession(s.date);
    if (filed.has(date)) continue;
    filed.add(date);
    rates.push({ date, rate: parseFloat((1 / s.close).toFixed(6)) });
  }
  return { rates, pending: snaps.length ? snaps[snaps.length - 1].date : null, droppedLive };
}

/**
 * Fetch and store the daily rates for one currency between `from` and `to`
 * (`YYYY-MM-DD`). The one writer of `exchange_rates`: the daily job calls it with a
 * short window, recompute-eur.js with the whole of history. Returns a summary; throws
 * if Yahoo does, so the caller decides what a failure means.
 */
async function backfillRates(db, yf, currency, { from, to, dryRun = false } = {}) {
  const chart = await yf.chart(fxSymbol(currency), { period1: from, period2: to, interval: '1d' });
  const { rates, pending, droppedLive } = fxRatesFromChart(chart);
  if (!rates.length) return { currency, written: 0, rates, last: null, pending, droppedLive };

  const upsert = db.prepare(RATE_UPSERT_SQL);
  if (!dryRun) db.transaction(() => { for (const r of rates) upsert.run(currency, r.rate, r.date); })();
  return { currency, written: rates.length, rates, last: rates[rates.length - 1], pending, droppedLive };
}

/**
 * Turn a raw `chart()` response into the bars this app will actually store:
 * dated by their own exchange-local trading date, non-final bars for today
 * dropped, and one bar per date (the first, if Yahoo ever repeats a date).
 *
 * Shared between `backfillTicker` (which writes) and `redate-prices.js` (which
 * only diffs) so the two can never disagree about what a "final bar" is.
 */
function finalBars(chart, now = new Date()) {
  const meta = chart.meta || {};
  const currency = meta.currency || 'USD';
  const tz = meta.exchangeTimezoneName || 'UTC';
  const raw = (chart.quotes || []).filter(q => q.close != null);

  let droppedOpen = 0;
  const seen = new Set();
  const bars = [];
  for (const q of raw) {
    const date = tradingDate(q.date, tz);
    if (!isBarFinal(date, meta, now)) { droppedOpen++; continue; }
    // Yahoo occasionally repeats a date across adjacent bars (a quirk around
    // partial/live bars getting mixed into a chart response); keep the first
    // one seen rather than the last, so a later, less-final print never wins.
    if (seen.has(date)) continue;
    seen.add(date);
    bars.push({ date, close: q.close });
  }
  return { currency, tz, bars, droppedOpen };
}

/** Fetch and store daily history for one ticker. Returns a summary. */
async function backfillTicker(db, yf, ticker, years, { dryRun = false, now = new Date(), source = 'yahoo_backfill' } = {}) {
  const from = new Date(now.getTime() - years * 365.25 * 864e5).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 864e5).toISOString().slice(0, 10);

  const chart = await yf.chart(ticker, { period1: from, period2: to, interval: '1d' });
  const { currency, bars, droppedOpen } = finalBars(chart, now);
  if (!bars.length) return { ticker, added: 0, currency, note: 'no data returned', droppedOpen, last: null };

  const rateFor = makeRateLookup(db);
  const upsert = db.prepare(`
    INSERT INTO prices (ticker, price_eur, price_usd, price_native, currency, price_date, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, price_date) DO UPDATE SET
      price_eur = excluded.price_eur, price_usd = excluded.price_usd,
      price_native = excluded.price_native, currency = excluded.currency,
      source = excluded.source, updated_at = CURRENT_TIMESTAMP
  `);

  // Computed either way — dry-run still reports the "as of" figure a caller
  // (price-fetch.js) needs to build its run report from, without writing anything.
  let written = 0, skipped = 0, last = null, skippedDate = null;
  const writeAll = db.transaction(() => {
    for (const bar of bars) {
      const rate = rateFor(currency, bar.date);
      if (rate == null) { skipped++; if (skippedDate == null) skippedDate = bar.date; continue; }   // no rate: better nothing than a guess
      const native = parseFloat(bar.close.toFixed(4));
      const eur = parseFloat((native * rate).toFixed(4));
      const usd = currency === 'USD' ? native : null;
      if (!dryRun) upsert.run(ticker, eur, usd, native, currency, bar.date, source);
      written++;
      last = { date: bar.date, native, eur, currency };
    }
  });
  writeAll();

  const peak = Math.max(...bars.map(b => b.close));
  return {
    ticker, currency, added: written, skipped, skippedDate, droppedOpen,
    from: bars[0].date, peak, last
  };
}

async function main() {
  const { years, dryRun, tickers } = parseArgs(process.argv);
  const db = new Database(process.env.DB_PATH || path.join(__dirname, 'portfolio.db'));
  db.pragma('busy_timeout = 5000');
  ensurePriceCurrencyColumns(db);

  const list = tickers.length
    ? tickers
    : db.prepare('SELECT DISTINCT ticker FROM transactions ORDER BY ticker').all().map(r => r.ticker);

  console.log(`Backfilling ${years} year(s) for ${list.length} ticker(s)${dryRun ? ' (dry run)' : ''}\n`);
  const yf = new YahooFinance();

  for (const ticker of list) {
    try {
      const r = await backfillTicker(db, yf, ticker, years, { dryRun });
      console.log(`  ${ticker.padEnd(9)} ${String(r.added).padStart(5)} days from ${r.from || '—'}`
        + `  peak ${r.peak ? r.peak.toFixed(2) : '—'} ${r.currency}`
        + (r.skipped ? `  (${r.skipped} skipped, no FX rate)` : '')
        + (r.droppedOpen ? `  (${r.droppedOpen} open bar(s) not final, skipped)` : '')
        + (r.note ? `  ${r.note}` : ''));
    } catch (err) {
      console.log(`  ${ticker.padEnd(9)} failed: ${err.message.slice(0, 60)}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }

  const total = db.prepare('SELECT COUNT(*) c FROM prices').get().c;
  console.log(`\n${dryRun ? 'Would leave' : 'prices table now holds'} ${total} rows`);
  db.close();
}

if (require.main === module) {
  main().catch(err => { console.error('backfill failed:', err.message); process.exit(1); });
}

module.exports = { backfillTicker, tradingDate, isBarFinal, finalBars, makeRateLookup, lookupRate, DEFAULT_YEARS, DEFAULT_GRACE_MIN,
  RATE_UPSERT_SQL, FX_TZ, fxSymbol, isDayStart, isFxSession, previousFxSession, fxRatesFromChart, backfillRates };
