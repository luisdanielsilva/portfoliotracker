#!/usr/bin/env node
/**
 * Issue #33: the one-off reconciliation that brings existing `exchange_rates` rows
 * into line with "a rate is filed under the session it is the closing rate for"
 * (see backfill-history.js), then re-converts `price_eur` for exactly the price
 * rows whose rate that changes — and no others.
 *
 * The sibling of redate-prices.js (issue #12), and deliberately the same shape: it
 * does not guess who wrote a row (two writers used two different rules, and the
 * old job's rows are intraday quotes that match no bar at all), it re-derives what
 * every date *should* hold from Yahoo through `fxRatesFromChart` — the code every
 * writer now uses — and diffs that against what is stored.
 *
 *   DB_PATH=<path> node redate-rates.js                  dry run (DEFAULT): report only
 *   DB_PATH=<path> node redate-rates.js --verbose        dry run, every changed row listed
 *   DB_PATH=<path> node redate-rates.js --apply          backup, then apply in one transaction
 *   DB_PATH=<path> node redate-rates.js --rollback <changes.json>
 *   options: --backup-dir <dir> (default ~/backups/portfoliotracker)
 *
 * DB_PATH is required and opened with `fileMustExist: true` — there is no default.
 * Backups and change logs hold real prices and go outside the repo, gzipped under
 * backup-db.sh's naming (`portfolio.db.pre-redate-rates-<stamp>.gz`) so its
 * `--restore` works on them unchanged — the same helpers redate-prices.js uses.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { fxRatesFromChart, fxSymbol, lookupRate, isFxSession } = require('./backfill-history');
const {
  portfolioEffectsByUser, writeChangeLogAtomic, gzipBackup, serviceIsActive, round4
} = require('./redate-prices');
const { identityFor } = require('./identity-db');

/**
 * Stored rates have been written at 4, 5 and 6 decimal places over the years; a row
 * within this of its reference is the same rate, rounded. One day's move in EUR/USD
 * is typically 0.002–0.003, two orders of magnitude above it.
 */
const RATE_TOLERANCE = 0.00001;
/**
 * A correction larger than this is not a re-dating — EUR/USD has not moved 5% in a
 * day in the whole history this app holds. It means the reference is broken (a wrong
 * symbol, a unit change) and `--apply` refuses rather than writing it.
 */
const IMPLAUSIBLE_MOVE = 0.05;
const PRICE_TOLERANCE = 0.00005;

/**
 * For each currency in `exchange_rates`, the reference rates over the stored range.
 * Returns `{ refByCurrency, failed }`; any failure aborts the CLI rather than
 * reconciling some currencies and not others.
 */
async function gatherReference(db, yf, currencies, now = new Date(), { delayMs = 250 } = {}) {
  const refByCurrency = {};
  const failed = [];
  const spanStmt = db.prepare(
    "SELECT MIN(date) lo, MAX(date) hi FROM exchange_rates WHERE from_currency = ? AND to_currency = 'EUR'"
  );
  for (const currency of currencies) {
    const span = spanStmt.get(currency);
    if (!span || !span.lo) continue;
    const from = new Date(Date.parse(span.lo) - 10 * 864e5).toISOString().slice(0, 10);
    const to = new Date(Math.max(Date.parse(span.hi), now.getTime()) + 2 * 864e5).toISOString().slice(0, 10);
    try {
      const chart = await yf.chart(fxSymbol(currency), { period1: from, period2: to, interval: '1d' });
      if (!chart || !chart.quotes) throw new Error('no data returned');
      refByCurrency[currency] = fxRatesFromChart(chart);
    } catch (err) {
      failed.push({ currency, error: err.message });
    }
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
  return { refByCurrency, failed };
}

/**
 * The pure diff for `exchange_rates`: every stored `{id, from_currency, date, rate}`
 * row and the reference rates in, the plan out. Nothing here touches a database or
 * the network.
 *
 * - **update**: the date has a reference rate and the row holds something else.
 *   `reason` says what it held instead, which is the evidence for the re-dating:
 *   the previous session's rate (a day late), the next one's (a day early), or
 *   neither (an intraday quote).
 * - **delete**: a day the FX market is shut (weekend, 25 Dec, 1 Jan), with sessions on
 *   both sides. Readers carry the previous session's rate forward, the right one now.
 * - **unverifiable**: a weekday with no reference (a gap in Yahoo's bars) — left alone.
 * - **insert**: a session inside the stored range with no row.
 * - **openEdge**: rows on or after the first date whose rate is not known yet — left
 *   alone; the job rewrites them the morning after.
 */
function planRates(rateRows, refByCurrency) {
  const updates = [], deletes = [], inserts = [], openEdge = [], implausible = [], unverifiable = [];

  const byCurrency = new Map();
  for (const row of rateRows) {
    if (!byCurrency.has(row.from_currency)) byCurrency.set(row.from_currency, []);
    byCurrency.get(row.from_currency).push(row);
  }

  for (const [currency, rows] of byCurrency) {
    const ref = refByCurrency[currency];
    if (!ref || !ref.rates.length) continue; // no answer for this currency: leave it untouched

    const refDates = ref.rates.map(r => r.date);
    const refByDate = new Map(ref.rates.map(r => [r.date, r.rate]));
    const indexOf = new Map(refDates.map((d, i) => [d, i]));
    const firstRef = refDates[0], lastRef = refDates[refDates.length - 1];
    const stored = new Set(rows.map(r => r.date));
    const dates = rows.map(r => r.date).sort();
    const minDate = dates[0], maxDate = dates[dates.length - 1];
    const near = (a, b) => b !== undefined && Math.abs(a - b) <= RATE_TOLERANCE;

    for (const row of rows) {
      const before = { rate: row.rate, created_at: row.created_at };
      const want = refByDate.get(row.date);
      if (want !== undefined) {
        if (near(row.rate, want)) continue;
        const i = indexOf.get(row.date);
        const reason = near(row.rate, refByDate.get(refDates[i - 1])) ? 'held the previous session\'s rate (a day late)'
          : near(row.rate, refByDate.get(refDates[i + 1])) ? 'held the next session\'s rate (a day early)'
          : 'matches neither neighbouring session\'s end-of-day rate';
        const entry = { action: 'update', id: row.id, currency, date: row.date, before, after: { rate: want }, reason };
        updates.push(entry);
        if (Math.abs(want / row.rate - 1) > IMPLAUSIBLE_MOVE) implausible.push(entry);
      } else if (row.date > firstRef && row.date < lastRef) {
        if (!isFxSession(row.date)) {
          deletes.push({ action: 'delete', id: row.id, currency, date: row.date, before, reason: 'the FX market is shut (weekend, 25 Dec, 1 Jan)' });
        } else {
          // A weekday Yahoo has no snapshot at the end of (a gap in its bars, not a day
          // FX did not trade): there is nothing to check the row against, so keep it.
          unverifiable.push({ id: row.id, currency, date: row.date, rate: row.rate });
        }
      } else if (row.date > lastRef) {
        openEdge.push({ id: row.id, currency, date: row.date, rate: row.rate });
      }
      // else: before the reference begins — left alone
    }

    for (const r of ref.rates) {
      if (r.date < minDate || r.date > maxDate || stored.has(r.date)) continue; // never extend coverage
      inserts.push({ action: 'insert', currency, date: r.date, rate: r.rate, reason: 'an FX session with no stored rate' });
    }
  }

  return { updates, deletes, inserts, openEdge, implausible, unverifiable };
}

/** `{currency: [{date, rate}] ascending}` from rate rows, optionally with a plan applied. */
function rateTables(rateRows, plan = null) {
  const byKey = new Map(rateRows.map(r => [`${r.from_currency}|${r.date}`, { currency: r.from_currency, date: r.date, rate: r.rate }]));
  if (plan) {
    for (const d of plan.deletes) byKey.delete(`${d.currency}|${d.date}`);
    for (const u of plan.updates) byKey.get(`${u.currency}|${u.date}`).rate = u.after.rate;
    for (const i of plan.inserts) byKey.set(`${i.currency}|${i.date}`, { currency: i.currency, date: i.date, rate: i.rate });
  }
  const tables = {};
  for (const r of byKey.values()) (tables[r.currency] = tables[r.currency] || []).push(r);
  for (const t of Object.values(tables)) t.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return tables;
}

/**
 * The `price_eur` half of the plan: for every non-euro price row, the rate a reader
 * finds for its date today (`lookupRate`, the same carry-forward `makeRateLookup`
 * uses) and after the rate plan. Only a row whose rate actually changes is touched,
 * and it becomes exactly `price_native × new rate` — so every change here is the
 * rate re-dating and nothing else. `wasAtRate: false` marks a row that did not equal
 * `price_native × old rate` to begin with; it is corrected too, but counted apart so
 * the reviewer can see how much of a change was not the re-dating.
 */
function planPrices(priceRows, rateRows, ratePlan) {
  const before = rateTables(rateRows);
  const after = rateTables(rateRows, ratePlan);
  const updates = [];
  for (const p of priceRows) {
    const currency = p.currency || 'USD';
    if (currency === 'EUR' || p.price_native == null) continue;
    const rb = lookupRate(before[currency] || [], p.price_date);
    const ra = lookupRate(after[currency] || [], p.price_date);
    if (rb == null || ra == null || Math.abs(ra - rb) < 1e-12) continue; // this date's rate is unchanged
    const eur = round4(p.price_native * ra);
    if (Math.abs(eur - p.price_eur) <= PRICE_TOLERANCE) continue;
    updates.push({
      id: p.id, ticker: p.ticker, date: p.price_date, currency, native: p.price_native,
      rateBefore: rb, rateAfter: ra, before: { eur: p.price_eur }, after: { eur },
      wasAtRate: Math.abs(round4(p.price_native * rb) - p.price_eur) <= 3 * PRICE_TOLERANCE
    });
  }
  return updates;
}

/** The whole plan: rates, then the prices they move. */
function planAll(db, refByCurrency) {
  const rateRows = db.prepare(
    "SELECT id, from_currency, date, rate, created_at FROM exchange_rates WHERE to_currency = 'EUR' ORDER BY from_currency, date"
  ).all();
  const plan = planRates(rateRows, refByCurrency);
  const priceRows = db.prepare('SELECT id, ticker, price_date, price_native, price_eur, currency FROM prices').all();
  plan.prices = planPrices(priceRows, rateRows, plan);
  return plan;
}

/**
 * Apply a plan in one transaction. Every row is re-read first and must still equal
 * what the plan was built from — the job may have run since the dry run — and any
 * mismatch throws, rolling back everything. Refuses a plan with an implausible move.
 * Returns the change log, with the ids of inserted rows so a rollback can find them.
 */
function applyPlan(db, plan) {
  if (plan.implausible && plan.implausible.length) {
    throw new Error(`${plan.implausible.length} rate correction(s) exceed ${IMPLAUSIBLE_MOVE * 100}% — refusing to apply`);
  }
  const getRate = db.prepare('SELECT from_currency, date, rate FROM exchange_rates WHERE id = ?');
  const getRateAt = db.prepare("SELECT id FROM exchange_rates WHERE from_currency = ? AND to_currency = 'EUR' AND date = ?");
  const setRate = db.prepare('UPDATE exchange_rates SET rate = ? WHERE id = ?');
  const delRate = db.prepare('DELETE FROM exchange_rates WHERE id = ?');
  const insRate = db.prepare("INSERT INTO exchange_rates (from_currency, to_currency, rate, date) VALUES (?, 'EUR', ?, ?)");
  const getPrice = db.prepare('SELECT price_native, price_eur FROM prices WHERE id = ?');
  const setPrice = db.prepare('UPDATE prices SET price_eur = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const bumpVersion = db.prepare('UPDATE data_version SET version = version + 1 WHERE id = 1');

  const changeLog = { appliedAt: new Date().toISOString(), updates: [], deletes: [], inserts: [], prices: [] };
  const sameRate = (cur, e) => cur && cur.from_currency === e.currency && cur.date === e.date && Math.abs(cur.rate - e.before.rate) < 1e-12;

  db.transaction(() => {
    for (const u of plan.updates) {
      if (!sameRate(getRate.get(u.id), u)) throw new Error(`concurrent write detected on ${u.currency} ${u.date} — aborting, nothing written`);
      setRate.run(u.after.rate, u.id);
      changeLog.updates.push(u);
    }
    for (const d of plan.deletes) {
      if (!sameRate(getRate.get(d.id), d)) throw new Error(`concurrent write detected on ${d.currency} ${d.date} — aborting, nothing written`);
      delRate.run(d.id);
      changeLog.deletes.push(d);
    }
    for (const i of plan.inserts) {
      if (getRateAt.get(i.currency, i.date)) throw new Error(`concurrent write detected on ${i.currency} ${i.date} — aborting, nothing written`);
      const id = Number(insRate.run(i.currency, i.rate, i.date).lastInsertRowid);
      changeLog.inserts.push({ ...i, id });
    }
    for (const p of plan.prices) {
      const cur = getPrice.get(p.id);
      if (!cur || Math.abs(cur.price_native - p.native) > 1e-9 || Math.abs(cur.price_eur - p.before.eur) > 1e-9) {
        throw new Error(`concurrent write detected on ${p.ticker} ${p.date} — aborting, nothing written`);
      }
      setPrice.run(p.after.eur, p.id);
      changeLog.prices.push(p);
    }
    if (changeLog.updates.length || changeLog.deletes.length || changeLog.inserts.length || changeLog.prices.length) bumpVersion.run();
  })();
  return changeLog;
}

/** Does the database hold every "after" a change log describes? Read-only; see redate-prices.js. */
function changeLogMatchesDb(db, changeLog) {
  const getRate = db.prepare('SELECT rate FROM exchange_rates WHERE id = ?');
  const getPrice = db.prepare('SELECT price_eur FROM prices WHERE id = ?');
  for (const u of changeLog.updates || []) {
    const cur = getRate.get(u.id);
    if (!cur || Math.abs(cur.rate - u.after.rate) > 1e-12) return false;
  }
  for (const d of changeLog.deletes || []) if (getRate.get(d.id)) return false;
  for (const i of changeLog.inserts || []) {
    // a pending log was written before the inserts had ids; look them up by date instead
    const cur = i.id != null ? getRate.get(i.id)
      : db.prepare("SELECT rate FROM exchange_rates WHERE from_currency = ? AND to_currency = 'EUR' AND date = ?").get(i.currency, i.date);
    if (!cur || Math.abs(cur.rate - i.rate) > 1e-12) return false;
  }
  for (const p of changeLog.prices || []) {
    const cur = getPrice.get(p.id);
    if (!cur || Math.abs(cur.price_eur - p.after.eur) > 1e-9) return false;
  }
  return true;
}

/**
 * Reverse a change log in one transaction, refusing if any row no longer holds what
 * the migration wrote there. Same three log states as redate-prices.js: "applied"
 * is reversed, "aborted" refused, "pending" reversed only if the database shows the
 * commit happened.
 */
function rollback(db, changeLog) {
  const status = changeLog.status || 'applied';
  if (status === 'aborted') {
    throw new Error('nothing to roll back — this change log was aborted before its transaction committed');
  }
  if (status === 'pending' && !changeLogMatchesDb(db, changeLog)) {
    throw new Error('nothing to roll back — the migration never committed (log is still "pending", and the database does not hold its "after" values)');
  }

  const getRate = db.prepare('SELECT rate FROM exchange_rates WHERE id = ?');
  const getRateAt = db.prepare("SELECT id, rate FROM exchange_rates WHERE from_currency = ? AND to_currency = 'EUR' AND date = ?");
  const setRate = db.prepare('UPDATE exchange_rates SET rate = ? WHERE id = ?');
  const reinsert = db.prepare("INSERT INTO exchange_rates (id, from_currency, to_currency, rate, date, created_at) VALUES (?, ?, 'EUR', ?, ?, ?)");
  const delRate = db.prepare('DELETE FROM exchange_rates WHERE id = ?');
  const getPrice = db.prepare('SELECT price_eur FROM prices WHERE id = ?');
  const setPrice = db.prepare('UPDATE prices SET price_eur = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  const bumpVersion = db.prepare('UPDATE data_version SET version = version + 1 WHERE id = 1');

  db.transaction(() => {
    for (const p of changeLog.prices || []) {
      const cur = getPrice.get(p.id);
      if (!cur || Math.abs(cur.price_eur - p.after.eur) > 1e-9) throw new Error(`rollback refused: ${p.ticker} ${p.date} no longer matches the logged "after"`);
      setPrice.run(p.before.eur, p.id);
    }
    for (const i of changeLog.inserts || []) {
      const cur = getRateAt.get(i.currency, i.date);
      if (!cur || Math.abs(cur.rate - i.rate) > 1e-12) throw new Error(`rollback refused: ${i.currency} ${i.date} no longer matches the logged insert`);
      delRate.run(cur.id);
    }
    for (const d of changeLog.deletes || []) {
      if (getRateAt.get(d.currency, d.date)) throw new Error(`rollback refused: ${d.currency} ${d.date} already has a rate`);
      reinsert.run(d.id, d.currency, d.before.rate, d.date, d.before.created_at);
    }
    for (const u of changeLog.updates || []) {
      const cur = getRate.get(u.id);
      if (!cur || Math.abs(cur.rate - u.after.rate) > 1e-12) throw new Error(`rollback refused: ${u.currency} ${u.date} no longer matches the logged "after"`);
      setRate.run(u.before.rate, u.id);
    }
    bumpVersion.run();
  })();
}

/**
 * Per ticker, the change to the row a reader sees today (its newest price), in the
 * shape `portfolioEffectsByUser` weights by each user's holdings. The whole delta is
 * a rate-date effect: this migration never changes a close.
 */
function latestPriceDeltas(db, plan) {
  const byId = new Map(plan.prices.map(p => [p.id, p]));
  const latest = db.prepare(`
    SELECT p.id, p.ticker FROM prices p
    JOIN (SELECT ticker, MAX(price_date) d FROM prices GROUP BY ticker) m ON m.ticker = p.ticker AND m.d = p.price_date
  `).all();
  const byTicker = new Map();
  for (const row of latest) {
    const p = byId.get(row.id);
    if (!p) continue;
    const delta = p.after.eur - p.before.eur;
    byTicker.set(row.ticker, { ticker: row.ticker, date: p.date, delta, rateDateEffect: delta, closeChangedEffect: 0, residual: 0 });
  }
  return byTicker;
}

function printPlan(log, plan, db, { identityDb, verbose = false } = {}) {
  log(`Rates: ${plan.updates.length} update(s), ${plan.deletes.length} delete(s), ${plan.inserts.length} insert(s)`
    + (plan.implausible.length ? `, ${plan.implausible.length} IMPLAUSIBLE` : ''));

  const tally = (list, key) => list.reduce((m, e) => m.set(key(e), (m.get(key(e)) || 0) + 1), new Map());
  for (const [reason, n] of tally(plan.updates, u => u.reason)) log(`  ${String(n).padStart(5)} updated: ${reason}`);
  if (plan.deletes.length) log(`  ${String(plan.deletes.length).padStart(5)} deleted: the FX market is shut (weekend, 25 Dec, 1 Jan)`);
  if (plan.inserts.length) log(`  ${String(plan.inserts.length).padStart(5)} inserted: an FX session with no stored rate`);

  const years = [...tally([...plan.updates, ...plan.deletes, ...plan.inserts], e => e.date.slice(0, 4))].sort();
  if (years.length) log(`  by year: ${years.map(([y, n]) => `${y} ${n}`).join(', ')}`);

  const sample = verbose ? plan.updates : plan.updates.slice(-8);
  if (sample.length) log(verbose ? '  every update:' : '  the most recent updates (--verbose lists every row):');
  for (const u of sample) log(`    UPDATE ${u.currency} ${u.date}: ${u.before.rate} -> ${u.after.rate} (${u.reason})`);
  for (const d of verbose ? plan.deletes : plan.deletes.slice(-4)) log(`    DELETE ${d.currency} ${d.date}: was ${d.before.rate} (${d.reason})`);
  for (const i of verbose ? plan.inserts : plan.inserts.slice(-4)) log(`    INSERT ${i.currency} ${i.date}: ${i.rate} (${i.reason})`);
  for (const x of plan.implausible) log(`  ✗ IMPLAUSIBLE ${x.currency} ${x.date}: ${x.before.rate} -> ${x.after.rate} — a broken reference, not a re-dating`);

  const prices = plan.prices;
  const notAtRate = prices.filter(p => !p.wasAtRate);
  log(`\nPrices: ${prices.length} price_eur value(s) re-converted, on `
    + `${new Set(prices.map(p => p.date)).size} date(s) whose rate changed; `
    + `${new Set(prices.map(p => p.ticker)).size} ticker(s)`);
  if (prices.length) {
    const pct = p => (p.after.eur / p.before.eur - 1) * 100;
    const big = prices.reduce((a, p) => (Math.abs(pct(p)) > Math.abs(pct(a)) ? p : a));
    const meanAbs = prices.reduce((s, p) => s + Math.abs(pct(p)), 0) / prices.length;
    log(`  mean |change| ${meanAbs.toFixed(3)}%; largest ${big.ticker} ${big.date} €${big.before.eur} -> €${big.after.eur} (${pct(big) >= 0 ? '+' : ''}${pct(big).toFixed(2)}%)`);
    log(notAtRate.length
      ? `  ⚠ ${notAtRate.length} of them did not equal price_native × their old rate to begin with `
        + `(${[...new Set(notAtRate.map(p => p.date))].sort().join(', ')}) — corrected too, but not by the re-dating alone`
      : '  every one of them equalled price_native × its old rate before, so each change is the re-dating alone');
    for (const p of verbose ? prices : []) {
      log(`    PRICE ${p.ticker} ${p.date}: €${p.before.eur} -> €${p.after.eur} (${p.native} × ${p.rateBefore} -> × ${p.rateAfter})`);
    }
  }

  const { lines } = portfolioEffectsByUser(db, latestPriceDeltas(db, plan), identityDb);
  log('');
  for (const u of lines) {
    log(`Portfolio effect today, user ${u.label} (${u.heldCount} held ticker${u.heldCount === 1 ? '' : 's'}): `
      + (u.hasEffect ? `total ${u.total >= 0 ? '+' : ''}${u.total.toFixed(2)}, all of it the rate re-dating` : 'no effect'));
  }
  if (!lines.length) log('No user holds anything.');

  if (plan.unverifiable.length) {
    log(`ℹ ${plan.unverifiable.length} weekday rate(s) left untouched because Yahoo has no snapshot at the end of that day `
      + `to check them against: ${plan.unverifiable.map(u => `${u.currency} ${u.date}`).join(', ')}`);
  }
  if (plan.openEdge.length) {
    log(`ℹ ${plan.openEdge.length} rate row(s) on or after ${plan.openEdge[0].date} left untouched: the rate for that day `
      + 'is not known until the next London day starts. The daily job rewrites it the morning after.');
  }
  return { counts: { update: plan.updates.length, delete: plan.deletes.length, insert: plan.inserts.length, price: prices.length } };
}

const USAGE = 'usage: DB_PATH=<path> node redate-rates.js [--apply] [--verbose] [--backup-dir <dir>] [--rollback <changes.json>]';

async function main({
  db, yf, argv, now = new Date(), log = console.log, backupDirDefault, identityDb = identityFor(db),
  delayMs = 250, writeChangeLog = writeChangeLogAtomic, gzip = gzipBackup, serviceActive = serviceIsActive
}) {
  let apply = false, verbose = false, rollbackFile = null, backupDir = backupDirDefault;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--verbose') verbose = true;
    else if (a === '--backup-dir') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { log('✗ --backup-dir needs a value'); log(USAGE); return 1; }
      backupDir = v;
    } else if (a === '--rollback') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { log('✗ --rollback needs a value (a change-log path)'); log(USAGE); return 1; }
      rollbackFile = v;
    } else { log(`✗ unknown argument "${a}"`); log(USAGE); return 1; }
  }
  const dir = backupDir || path.join(os.homedir(), 'backups', 'portfoliotracker');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if ((apply || rollbackFile) && serviceActive('portfolio-price-fetch.service')) {
    log('✗ portfolio-price-fetch.service looks active — refusing to write while the job might be writing.');
    return 1;
  }

  if (rollbackFile) {
    let changeLog;
    try {
      changeLog = JSON.parse(fs.readFileSync(rollbackFile, 'utf-8'));
    } catch (err) {
      log(`✗ could not read ${rollbackFile}: ${err.message}`);
      return 1;
    }
    try { // cheap insurance, best effort: rollback() re-checks every row itself
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const raw = path.join(dir, `portfolio.db.pre-rollback-rates-${stamp}`);
      await db.backup(raw);
      await gzip(raw, `${raw}.gz`);
      log(`Backup written: ${raw}.gz`);
    } catch (err) {
      log(`⚠ could not take a pre-rollback backup (${err.message}); continuing anyway`);
    }
    try {
      rollback(db, changeLog);
    } catch (err) {
      log(`✗ ${err.message}`);
      return 1;
    }
    log(`Rolled back ${changeLog.updates.length} rate update(s), ${changeLog.deletes.length} delete(s), `
      + `${changeLog.inserts.length} insert(s) and ${(changeLog.prices || []).length} price_eur value(s).`);
    return 0;
  }

  const currencies = db.prepare("SELECT DISTINCT from_currency c FROM exchange_rates WHERE to_currency = 'EUR' ORDER BY c").all().map(r => r.c);
  const { refByCurrency, failed } = await gatherReference(db, yf, currencies, now, { delayMs });
  if (failed.length) {
    log(`✗ Yahoo could not be reached for ${failed.map(f => `${f.currency} (${f.error})`).join(', ')}`);
    log('  Aborting — nothing written.');
    return 1;
  }
  for (const [c, ref] of Object.entries(refByCurrency)) {
    log(`Reference ${fxSymbol(c)}: ${ref.rates.length} daily rate(s) ${ref.rates.length ? `${ref.rates[0].date} → ${ref.rates[ref.rates.length - 1].date}` : ''}`
      + ` (${ref.pending}'s not known yet${ref.droppedLive ? `; ${ref.droppedLive} live bar(s) ignored` : ''})`);
  }

  const plan = planAll(db, refByCurrency);
  printPlan(log, plan, db, { identityDb, verbose });

  if (!apply) { log('\nDry run — nothing written.'); return 0; }

  if (plan.implausible.length) {
    log(`\n✗ ${plan.implausible.length} IMPLAUSIBLE correction(s) — refusing to apply. The reference is wrong, not the dates.`);
    return 1;
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* dir pre-existed with looser perms: best effort */ }
  const rawBackupPath = path.join(dir, `portfolio.db.pre-redate-rates-${stamp}`);
  const logPath = path.join(dir, `redate-rates-${stamp}.json`);
  await db.backup(rawBackupPath);
  await gzip(rawBackupPath, `${rawBackupPath}.gz`);
  log(`Backup written: ${rawBackupPath}.gz`);

  // Written before the transaction as "pending" — see redate-prices.js (B1).
  const pendingLog = {
    status: 'pending', createdAt: new Date().toISOString(),
    updates: plan.updates, deletes: plan.deletes, inserts: plan.inserts, prices: plan.prices
  };
  try {
    writeChangeLog(logPath, pendingLog);
  } catch (err) {
    log(`✗ could not write the change log before applying — refusing to apply: ${err.message}`);
    log('  Nothing written.');
    return 1;
  }
  log(`Change log written (pending): ${logPath}`);

  let changeLog;
  try {
    changeLog = applyPlan(db, plan);
  } catch (err) {
    try {
      writeChangeLog(logPath, { ...pendingLog, status: 'aborted', abortedAt: new Date().toISOString(), error: err.message });
    } catch { /* best effort: rollback() refuses a stale "pending" log too, once it checks the DB */ }
    log(`✗ ${err.message}`);
    log('  Nothing written.');
    return 1;
  }

  try {
    writeChangeLog(logPath, { ...pendingLog, ...changeLog, status: 'applied' });
  } catch (err) {
    console.error('✗✗✗ THE DATABASE WAS MIGRATED (the transaction committed) but the change log');
    console.error(`✗✗✗ could not be marked "applied": ${err.message}`);
    console.error(`✗✗✗ The log at ${logPath} is still marked "pending" and describes exactly what`);
    console.error('✗✗✗ was written — it is safe to use with --rollback as-is.');
    return 1;
  }
  log(`Change log written: ${logPath}`);
  log(`Applied: ${changeLog.updates.length} rate update(s), ${changeLog.deletes.length} delete(s), `
    + `${changeLog.inserts.length} insert(s), ${changeLog.prices.length} price_eur value(s).`);
  return 0;
}

if (require.main === module) {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    console.error('✗ DB_PATH is required — this script never guesses or creates a database.');
    process.exit(1);
  }
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  const YahooFinance = require('yahoo-finance2').default;
  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  main({ db, yf, argv: process.argv.slice(2) }).then(code => {
    db.close();
    process.exit(code);
  }).catch(err => {
    console.error(err);
    db.close();
    process.exit(1);
  });
}

module.exports = {
  gatherReference, planRates, planPrices, planAll, rateTables, applyPlan, rollback, changeLogMatchesDb,
  latestPriceDeltas, printPlan, main, RATE_TOLERANCE, IMPLAUSIBLE_MOVE
};
