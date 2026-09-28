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
    const rows = cache[key];
    if (!rows.length) return null;
    let lo = 0, hi = rows.length - 1, best = null;
    while (lo <= hi) {                       // most recent rate on or before `date`
      const mid = (lo + hi) >> 1;
      if (rows[mid].date <= date) { best = rows[mid].rate; lo = mid + 1; } else { hi = mid - 1; }
    }
    // before the first recorded rate, fall back to the earliest one we have
    return best != null ? best : rows[0].rate;
  };
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

module.exports = { backfillTicker, tradingDate, isBarFinal, finalBars, makeRateLookup, DEFAULT_YEARS, DEFAULT_GRACE_MIN };
