#!/usr/bin/env node
/**
 * Recompute stored euro prices from the real exchange rate on each price's own date.
 *
 * Why this exists: euro values in `prices` were produced two different ways, neither
 * of them real FX.
 *
 *   - The bulk-imported history used a rate drifting smoothly from 0.95 to 0.82 across
 *     four years — a linear interpolation, not market data. Close to reality at the
 *     ends, materially wrong in the middle (2025-01-02 used 0.8718 against a real
 *     0.9660, understating that day by ~10%).
 *   - Rows written by price-fetch before 2026-09-09 used a hard-coded 0.92.
 *
 * `price_native` is stored for every row, so the original quoted price was never lost
 * and the conversion can simply be redone. Rates come from Yahoo's daily FX series and
 * are applied **per date**, not as one rate across all history — using today's rate on
 * old rows would remove the visible discontinuity while quietly mispricing years.
 *
 *   node recompute-eur.js --dry-run    show what would change, write nothing
 *   node recompute-eur.js              apply (take a backup first)
 *
 * Fetched rates are also written to `exchange_rates`, so the numbers can be audited
 * later rather than being an unexplainable one-off adjustment.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const Database = require('better-sqlite3');
const YahooFinance = require('yahoo-finance2').default;
const { ensurePriceCurrencyColumns } = require('./db-migrations');

const dryRun = process.argv.includes('--dry-run');
const dbPath = process.env.DB_PATH || path.join(__dirname, 'portfolio.db');

// Requiring this file must not run it. Without this guard a `require('./recompute-eur')`
// — a check that the module still loads, say — restates every euro price in whatever
// database DB_PATH points at, which is exactly what happened on 2026-09-16.
if (require.main !== module) {
  module.exports = { dbPath };
  return;
}

(async () => {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  ensurePriceCurrencyColumns(db);

  const span = db.prepare(
    'SELECT MIN(price_date) lo, MAX(price_date) hi FROM prices WHERE price_native > 0'
  ).get();
  if (!span.lo) { console.log('No priced rows to recompute.'); return; }

  const currencies = db.prepare(
    "SELECT DISTINCT currency FROM prices WHERE price_native > 0 AND currency IS NOT NULL AND currency <> 'EUR'"
  ).all().map(r => r.currency);

  console.log(`Range ${span.lo} → ${span.hi}; currencies to convert: ${currencies.join(', ') || '(none)'}`);
  if (dryRun) console.log('DRY RUN — nothing will be written\n');

  const yf = new YahooFinance();
  const series = {}; // currency -> { 'YYYY-MM-DD': rateToEur }

  for (const currency of currencies) {
    const chart = await yf.chart(`EUR${currency}=X`, {
      // a month of lead-in so the earliest price dates have a rate to carry forward
      period1: new Date(new Date(span.lo).getTime() - 40 * 864e5).toISOString().slice(0, 10),
      period2: new Date(new Date(span.hi).getTime() + 864e5).toISOString().slice(0, 10),
      interval: '1d'
    });
    const byDate = {};
    for (const q of chart.quotes) {
      if (q.close) byDate[q.date.toISOString().slice(0, 10)] = 1 / q.close;
    }
    series[currency] = { byDate, days: Object.keys(byDate).sort() };
    console.log(`  ${currency}: ${series[currency].days.length} daily rates`);
  }

  // FX does not trade at weekends or on holidays, while a price row can carry any
  // date. Carry the most recent earlier rate forward — the same convention a broker
  // uses — rather than interpolating or skipping the row.
  function rateFor(currency, date) {
    const s = series[currency];
    if (!s) return null;
    if (s.byDate[date]) return s.byDate[date];
    let i = s.days.length - 1;
    while (i >= 0 && s.days[i] > date) i--;
    return i >= 0 ? s.byDate[s.days[i]] : null;
  }

  const rows = db.prepare(
    'SELECT id, ticker, price_date, price_native, price_eur, currency FROM prices WHERE price_native > 0'
  ).all();

  const updatePrice = db.prepare('UPDATE prices SET price_eur = ? WHERE id = ?');
  // the daily job's statement, not a second copy of it — see RATE_UPSERT_SQL
  const upsertRate = db.prepare(require('./price-fetch').RATE_UPSERT_SQL);

  let changed = 0, unchanged = 0, skipped = 0, biggest = null;

  const apply = db.transaction(() => {
    for (const row of rows) {
      const currency = row.currency || 'USD';
      const rate = currency === 'EUR' ? 1 : rateFor(currency, row.price_date);
      if (rate == null) { skipped++; continue; }

      const next = parseFloat((row.price_native * rate).toFixed(4));
      const delta = Math.abs(next - row.price_eur);
      if (delta > 0.005) {
        changed++;
        const pct = Math.abs(delta / row.price_eur) * 100;
        if (!biggest || pct > biggest.pct) {
          biggest = { pct, ticker: row.ticker, date: row.price_date, from: row.price_eur, to: next };
        }
        if (!dryRun) updatePrice.run(next, row.id);
      } else {
        unchanged++;
      }
    }

    if (!dryRun) {
      for (const currency of currencies) {
        for (const day of series[currency].days) {
          upsertRate.run(currency, parseFloat(series[currency].byDate[day].toFixed(6)), day);
        }
      }
    }
  });

  apply();

  console.log(`\nrows: ${rows.length}  changed: ${changed}  already correct: ${unchanged}  skipped (no rate): ${skipped}`);
  if (biggest) {
    console.log(`largest single correction: ${biggest.ticker} on ${biggest.date} `
      + `€${biggest.from.toFixed(2)} → €${biggest.to.toFixed(2)} (${biggest.pct.toFixed(1)}%)`);
  }
  console.log(dryRun ? '\nDry run complete — nothing written.' : '\nApplied. Restart is not required; the app reads prices per request.');
  db.close();
})().catch(err => {
  console.error('recompute failed:', err.message);
  process.exit(1);
});
