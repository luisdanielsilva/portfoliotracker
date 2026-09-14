#!/usr/bin/env node
/**
 * Cross-check the figures the app derives from your transactions.
 *
 * Run this straight after importing real data. Every bug found on 2026-09-09 was
 * caught by noticing a number looked wrong; this does that check deliberately
 * instead of by luck. It reads only — it never writes.
 *
 *   node verify-portfolio.js            check every user
 *   node verify-portfolio.js --user 1   check one
 *
 * Each check states what it compares and why, so a failure tells you where to
 * look rather than only that something is off.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const Database = require('better-sqlite3');
const { getAvgCostPerShare } = require('./portfolio');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'portfolio.db');
const argUser = process.argv.indexOf('--user');
const onlyUser = argUser > -1 ? parseInt(process.argv[argUser + 1], 10) : null;

const db = new Database(dbPath, { readonly: true });

// Identities live in their own file since the split. This script names people in
// its output, so it needs both — and it opens the identity side read-only, which
// is all a reconciliation report should ever need.
const identityPath = process.env.IDENTITY_DB_PATH || path.join(path.dirname(dbPath), 'identity.db');
const identityDb = new Database(identityPath, { readonly: true });

db.pragma('busy_timeout = 5000');
let problems = 0;
const fail = m => { console.log(`   ✗ ${m}`); problems++; };
const ok = m => console.log(`   ✓ ${m}`);
const eur = n => '€' + n.toFixed(2);

const users = identityDb.prepare(
  onlyUser ? 'SELECT user_key AS id, email FROM users WHERE user_key = ?' : 'SELECT user_key AS id, email FROM users'
).all(...(onlyUser ? [onlyUser] : []));

for (const user of users) {
  const txCount = db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ?').get(user.id).c;
  console.log(`\n── user ${user.id} (${user.email.replace(/(.{2}).*(@.*)/, '$1***$2')}) — ${txCount} transaction(s)`);
  if (!txCount) { console.log('   (nothing to check)'); continue; }

  const tickers = db.prepare(
    'SELECT DISTINCT ticker FROM transactions WHERE user_id = ? ORDER BY ticker'
  ).all(user.id).map(r => r.ticker);

  for (const ticker of tickers) {
    const cost = getAvgCostPerShare(db, user.id, ticker);
    const price = db.prepare(
      'SELECT price_native, price_eur, currency, price_date FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1'
    ).get(ticker);

    console.log(`\n  ${ticker}`);

    if (!cost) { ok('no longer held (sold out) — no average cost, as expected'); continue; }
    console.log(`   holding ${cost.quantity} @ avg ${eur(cost.avgCostEUR)}`);

    // 1. A price the fetch job never obtained: usually a bad symbol, and it silently
    //    excludes the holding from the portfolio total.
    if (!price) { fail(`no price on record — the ticker may be wrong, and it is missing from the total`); continue; }

    // 2. The euro price must be the native price times a real rate. A large gap means
    //    a stale or fabricated conversion — this is how the 0.92 constant was caught.
    const impliedRate = price.price_eur / price.price_native;
    const storedRate = db.prepare(
      "SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = 'EUR' AND date <= ? ORDER BY date DESC LIMIT 1"
    ).get(price.currency || 'USD', price.price_date);
    if (price.currency === 'EUR') {
      Math.abs(impliedRate - 1) < 0.001
        ? ok('quoted in EUR and not converted again')
        : fail(`quoted in EUR but price_eur differs from price_native (ratio ${impliedRate.toFixed(4)}) — double conversion`);
    } else if (storedRate) {
      const drift = Math.abs(impliedRate - storedRate.rate) / storedRate.rate * 100;
      drift < 1
        ? ok(`euro price matches the recorded ${price.currency} rate (${impliedRate.toFixed(4)})`)
        : fail(`euro price implies ${impliedRate.toFixed(4)} but the recorded rate is ${storedRate.rate.toFixed(4)} (${drift.toFixed(1)}% off) — run recompute-eur.js`);
    } else {
      fail(`no ${price.currency}→EUR rate recorded for ${price.price_date} — the euro value cannot be justified`);
    }

    // 3. Splits multiply only shares held when they happened. Recomputing here
    //    independently of the API is the check that catches the class of bug where
    //    post-split purchases get multiplied again.
    const splits = db.prepare(
      'SELECT split_date, ratio FROM stock_splits WHERE ticker = ? ORDER BY split_date'
    ).all(ticker);
    if (splits.length) {
      const txs = db.prepare(
        "SELECT tx_type, quantity, date(ts/1000,'unixepoch') d FROM transactions WHERE user_id = ? AND ticker = ?"
      ).all(user.id, ticker);
      let expected = 0;
      for (const t of txs) {
        let q = t.quantity;
        for (const s of splits) if (t.d < s.split_date) q *= s.ratio;
        expected += t.tx_type === 'buy' ? q : -q;
      }
      Math.abs(expected - cost.quantity) < 1e-6
        ? ok(`${splits.length} split(s) applied only to shares held at the time (${expected} shares)`)
        : fail(`split-adjusted quantity should be ${expected} but holding shows ${cost.quantity}`);
    }

    // 4. A sanity band, not a correctness proof: an average cost wildly away from the
    //    market usually means a typo in an amount — like 100 shares entered for €114.
    const ratio = price.price_eur / cost.avgCostEUR;
    if (ratio > 20 || ratio < 0.05) {
      fail(`average cost ${eur(cost.avgCostEUR)} is implausible against a market price of ${eur(price.price_eur)} — check the amount entered`);
    } else {
      ok(`average cost is a plausible distance from the market price`);
    }
  }
}

console.log(`\n${problems === 0 ? '✓ no problems found' : `✗ ${problems} problem(s) found`}`);
db.close();
process.exit(problems === 0 ? 0 : 1);
