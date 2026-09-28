#!/usr/bin/env node
/**
 * Cross-check the figures the app derives from your transactions.
 *
 * Run this straight after importing real data. Every bug found on 2026-09-09 was
 * caught by noticing a number looked wrong; this does that check deliberately
 * instead of by luck. It reads only — it never writes.
 *
 *   node verify-portfolio.js               check every user
 *   node verify-portfolio.js --user <key>   check one (a user's identity key —
 *                                             a string, not a row number)
 *   node verify-portfolio.js --check-splits  also compare stock_splits against
 *                                             Yahoo (network; opt-in — see below)
 *
 * Each check states what it compares and why, so a failure tells you where to
 * look rather than only that something is off.
 *
 * `--check-splits` is the one path in this script that reaches the network:
 * for every traded ticker (or, with `--user`, that user's tickers) it asks
 * Yahoo for every split event it knows about and reports any that has no
 * `stock_splits` row within +/-7 days — see split-check.js's `auditSplits`.
 * The default run never does this and never even loads `yahoo-finance2`.
 *
 * Exit codes: 0 nothing wrong; 1 a real problem (a default check failed, an
 * unrecorded clean split affects someone's holding, or `--user` was given an
 * identity key that is missing, looks like another flag, or matches nobody —
 * see below); 2 nothing else was wrong, but Yahoo could not be reached for
 * one or more tickers, so `--check-splits` did not actually verify everything
 * it was asked to. 1 outranks 2 when both happen in the same run.
 *
 * `--user` is validated before anything else runs: a missing value, a value
 * starting with `--` (so `--user --check-splits` cannot silently take the
 * flag as the key), or a key that matches no user all exit 1 with an
 * explanatory `✗` line and check nobody — never "check everyone" (the old
 * `parseInt` behaviour) and never a false "no problems found". Yahoo is never
 * contacted in any of these cases. A crash (a locked database, an unexpected
 * exception) also exits 1 — the same code as "a real problem" — because that
 * was already this script's behaviour before this refactor (an uncaught
 * throw exits 1); a distinct code for "the script itself broke" is a
 * possible follow-up, not done here. A ticker Yahoo has permanently delisted
 * will 404 forever, so `--check-splits` will exit 2 on every run until that
 * ticker is removed from `transactions` or the check is otherwise skipped for
 * it — there is no ignore-list yet.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const Database = require('better-sqlite3');
const { getAvgCostPerShare } = require('./portfolio');

/** `user@example.com` -> `us***@example.com` — used both in the per-user header and the splits section. */
function mask(email) {
  return String(email || '').replace(/(.{2}).*(@.*)/, '$1***$2');
}

/**
 * Round to `digits` decimal places and trim trailing zeros, so a floating-
 * point replay (a 3:2 split followed by a 7:5, for instance) prints `1.2`
 * rather than `1.1999999999999997`. Plain numbers only — this is for display,
 * never for a comparison.
 */
function fmtNum(n, digits = 4) {
  return Number(n.toFixed(digits)).toString();
}

/** `+300` / `-90.5` — signed, formatted, for a share-count delta. */
function fmtDelta(n) {
  const s = fmtNum(Math.abs(n));
  return (n < 0 ? '-' : '+') + s;
}

async function main({ db, identityDb, argv, yf, log, delayMs }) {
  const argUser = argv.indexOf('--user');
  // `user_key` (schema.identity.sql) is a UUID string, not a row number — see
  // test/helpers.js's addUser(). A numeric-looking key would still be a
  // string here. Below, a missing value, a value that looks like another
  // flag, or a key that matches nobody is rejected explicitly (exit 1) —
  // rather than silently meaning "all users" (the old parseInt behaviour) or
  // "checked nothing, clean bill of health" (what an unvalidated empty
  // `users` result used to produce).
  const onlyUser = argUser > -1 ? argv[argUser + 1] : null;
  const checkSplits = argv.includes('--check-splits');

  db.pragma('busy_timeout = 5000');
  let problems = 0;
  let unchecked = 0;
  const fail = m => { log(`   ✗ ${m}`); problems++; };
  const ok = m => log(`   ✓ ${m}`);
  const eur = n => '€' + n.toFixed(2);

  const users = identityDb.prepare(
    onlyUser ? 'SELECT user_key AS id, email FROM users WHERE user_key = ?' : 'SELECT user_key AS id, email FROM users'
  ).all(...(onlyUser ? [onlyUser] : []));

  // `--user` is validated here, before the per-user loop and before
  // `--check-splits` ever touches Yahoo: a bad key must never read as "there
  // was nothing to check, so nothing was wrong".
  if (argUser > -1 && (!onlyUser || onlyUser.startsWith('--'))) {
    log('✗ --user needs an identity key (a UUID string)');
    return 1;
  }
  if (onlyUser && users.length === 0) {
    log(`✗ no user with identity key "${onlyUser}", nothing was checked`);
    return 1;
  }

  // Lazy, and only reached once `--user` has already been validated: the
  // default run must load nothing network-capable at all, and a bad `--user`
  // must never reach Yahoo either. `yf` may already be injected by a test.
  if (checkSplits && !yf) {
    const YahooFinance = require('yahoo-finance2').default;
    yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }

  for (const user of users) {
    const txCount = db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ?').get(user.id).c;
    log(`\n── user ${user.id} (${mask(user.email)}) — ${txCount} transaction(s)`);
    if (!txCount) { log('   (nothing to check)'); continue; }

    const tickers = db.prepare(
      'SELECT DISTINCT ticker FROM transactions WHERE user_id = ? ORDER BY ticker'
    ).all(user.id).map(r => r.ticker);

    for (const ticker of tickers) {
      const cost = getAvgCostPerShare(db, user.id, ticker);
      const price = db.prepare(
        'SELECT price_native, price_eur, currency, price_date FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1'
      ).get(ticker);

      log(`\n  ${ticker}`);

      if (!cost) { ok('no longer held (sold out) — no average cost, as expected'); continue; }
      log(`   holding ${cost.quantity} @ avg ${eur(cost.avgCostEUR)}`);

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

  if (checkSplits) {
    const { auditSplits } = require('./split-check.js');
    const userIds = onlyUser ? [onlyUser] : undefined;
    // `delayMs` passes through so tests can skip the real 250ms-per-ticker
    // gap (auditSplits's own default) without changing production behaviour.
    const results = await auditSplits(db, yf, { userIds, ...(delayMs !== undefined ? { delayMs } : {}) });

    /** `user 3 (so***@example.com)`, or a plain, honest label when there is no identity row to mask. */
    const holderLabel = h => {
      const holder = users.find(u => u.id === h.userId);
      return `user ${h.userId} (${holder ? mask(holder.email) : 'no identity record'})`;
    };

    const uncheckedCount = results.filter(r => r.error).length;
    log(`\n── stock splits vs Yahoo (${results.length - uncheckedCount} checked, ${uncheckedCount} could not be checked)`);

    for (const r of results) {
      if (r.error) {
        // Not a `✗`: Yahoo being unreachable is not, itself, "a problem with
        // your data" — it is a check that didn't run. It still counts toward
        // `unchecked`, so the final line can never claim "no problems found"
        // without saying some tickers were never actually verified.
        log(`   ⚠ could not check ${r.ticker} — ${r.error}`);
        unchecked++;
        continue;
      }

      if (!r.unrecorded.length) {
        log(`   ✓ ${r.ticker}… all Yahoo splits recorded or none reported`);
        continue;
      }

      const affected = r.unrecorded.filter(e => e.clean && e.holders.length);
      const unaffectedClean = r.unrecorded.filter(e => e.clean && !e.holders.length);
      const nonClean = r.unrecorded.filter(e => !e.clean);

      for (const e of affected) {
        log(`   ✗ ${r.ticker}: unrecorded split ${e.date} ${e.numerator}:${e.denominator} affects a held position`);
        problems++;
        for (const h of e.holders) {
          // `heldBefore`/`delta` are real shares (the telescoped replay in
          // auditSplits folds in every earlier unrecorded split first), so
          // "held" here means the position that really existed, not the
          // stored, pre-split-correction quantity.
          log(`      ${holderLabel(h)} — held ${fmtNum(h.heldBefore)} before the split, ${fmtDelta(h.delta)} shares`);
        }
      }

      if (r.totals && r.totals.length) {
        for (const t of r.totals) {
          log(`      ${holderLabel({ userId: t.userId })}: stored holding ${fmtNum(t.stored)}, with Yahoo's splits ${fmtNum(t.real)} (off by ${fmtDelta(t.off)})`);
        }
      }

      if (unaffectedClean.length) {
        const list = unaffectedClean.map(e => `${e.date} ${e.numerator}:${e.denominator}`).join(', ');
        log(`   ⚠ ${r.ticker}: ${unaffectedClean.length} unrecorded split(s), no position held across: ${list}`);
      }

      for (const e of nonClean) {
        const heldBy = e.holders.length
          ? ` — held across by ${e.holders.map(holderLabel).join(', ')}`
          : ' — no position held across';
        const symbol = e.holders.length ? '⚠' : 'ℹ';
        log(`   ${symbol} ${r.ticker}: unrecorded non-clean event ${e.date} ${e.numerator}:${e.denominator} (probably not a split)${heldBy}`);
      }
    }
  }

  log(`\n${problems === 0 ? (unchecked === 0 ? '✓ no problems found' : `⚠ no problems found, but ${unchecked} ticker(s) could not be checked`) : `✗ ${problems} problem(s) found`}`);

  if (problems > 0) return 1;
  if (unchecked > 0) return 2;
  return 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'portfolio.db');
  const db = new Database(dbPath, { readonly: true });

  // Identities live in their own file since the split. This script names people in
  // its output, so it needs both — and it opens the identity side read-only, which
  // is all a reconciliation report should ever need.
  const identityPath = process.env.IDENTITY_DB_PATH || path.join(path.dirname(dbPath), 'identity.db');
  const identityDb = new Database(identityPath, { readonly: true });

  main({ db, identityDb, argv, log: console.log }).then(exitCode => {
    db.close();
    identityDb.close();
    process.exit(exitCode);
  }).catch(err => {
    console.error(err);
    db.close();
    identityDb.close();
    process.exit(1);
  });
}

module.exports = { main, mask, fmtNum, fmtDelta };
