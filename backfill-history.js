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

function parseArgs(argv) {
  const args = argv.slice(2);
  const yearsIdx = args.indexOf('--years');
  return {
    years: yearsIdx > -1 ? parseFloat(args[yearsIdx + 1]) : DEFAULT_YEARS,
    dryRun: args.includes('--dry-run'),
    tickers: args.filter(a => !a.startsWith('--') && !/^[\d.]+$/.test(a)).map(t => t.toUpperCase())
  };
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

/** Fetch and store daily history for one ticker. Returns a summary. */
async function backfillTicker(db, yf, ticker, years, { dryRun = false } = {}) {
  const from = new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 864e5).toISOString().slice(0, 10);

  const chart = await yf.chart(ticker, { period1: from, period2: to, interval: '1d' });
  const currency = (chart.meta && chart.meta.currency) || 'USD';
  const bars = (chart.quotes || []).filter(q => q.close != null);
  if (!bars.length) return { ticker, added: 0, currency, note: 'no data returned' };

  const rateFor = makeRateLookup(db);
  const upsert = db.prepare(`
    INSERT INTO prices (ticker, price_eur, price_usd, price_native, currency, price_date, source)
    VALUES (?, ?, ?, ?, ?, ?, 'yahoo_backfill')
    ON CONFLICT(ticker, price_date) DO UPDATE SET
      price_eur = excluded.price_eur, price_usd = excluded.price_usd,
      price_native = excluded.price_native, currency = excluded.currency,
      updated_at = CURRENT_TIMESTAMP
  `);

  let written = 0, skipped = 0;
  const apply = db.transaction(() => {
    for (const bar of bars) {
      const date = bar.date.toISOString().slice(0, 10);
      const rate = rateFor(currency, date);
      if (rate == null) { skipped++; continue; }   // no rate: better nothing than a guess
      const native = parseFloat(bar.close.toFixed(4));
      upsert.run(ticker, parseFloat((native * rate).toFixed(4)),
        currency === 'USD' ? native : null, native, currency, date);
      written++;
    }
  });
  if (!dryRun) apply(); else written = bars.length;

  const peak = Math.max(...bars.map(b => b.close));
  return { ticker, currency, added: written, skipped, from: bars[0].date.toISOString().slice(0, 10), peak };
}

async function main() {
  const { years, dryRun, tickers } = parseArgs(process.argv);
  const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));
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

module.exports = { backfillTicker, DEFAULT_YEARS };
