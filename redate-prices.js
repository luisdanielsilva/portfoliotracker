#!/usr/bin/env node
/**
 * Issue #12: the one-off reconciliation that brings existing `prices` rows into
 * line with the "one meaning for price_date" convention (see backfill-history.js).
 *
 * `prices.source` is not a reliable record of who last wrote a row — an
 * `ON CONFLICT` used to update the values but not the label — so this does not
 * try to guess who wrote what. It re-derives every row from Yahoo instead: for
 * each ticker it asks for the same bars `backfillTicker` would, keeps only the
 * final ones (see `finalBars`), and diffs them against what is actually stored.
 *
 *   DB_PATH=<path> node redate-prices.js                 dry run (DEFAULT): report only
 *   DB_PATH=<path> node redate-prices.js --apply         backup, then apply in one transaction
 *   DB_PATH=<path> node redate-prices.js --rollback <changes.json>
 *   options: --since YYYY-MM-DD   --backup-dir <dir> (default ~/backups/portfoliotracker)
 *
 * DB_PATH is required and opened with `fileMustExist: true` — there is no default,
 * so this can never create or silently hit a database nobody meant it to touch.
 *
 * A difference dated before `--since` is reported as OUT OF WINDOW and makes
 * `--apply` refuse: it usually means Yahoo has restated history (a new split, a
 * revision) that needs a human decision, not an automatic rewrite.
 *
 * Backups and change logs hold real prices and go **outside the repo**, next to
 * backup-db.sh's own backups by default, and are written gzipped under
 * backup-db.sh's own naming convention (`portfolio.db.<stamp>.gz`) so its
 * `--restore` can be the last-resort recovery path without needing special
 * handling for this script's backups (issue #12 review, B2).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const { finalBars, makeRateLookup } = require('./backfill-history');
const { replayPosition } = require('./portfolio');
const { identityFor } = require('./identity-db');

const round4 = n => parseFloat(n.toFixed(4));
const UPDATE_TOLERANCE = 0.00005;

/**
 * For each ticker already in `prices`, ask Yahoo for its final bars over the
 * ticker's full stored range (with a little lead-in so the earliest row still
 * has something to compare against). Returns `{ barsByTicker, failed }` —
 * `failed` lists any ticker Yahoo could not answer for, which is the CLI's
 * signal to abort the whole run rather than apply a partial reconciliation.
 */
async function gatherBars(db, yf, tickers, now = new Date(), { delayMs = 250 } = {}) {
  const barsByTicker = {};
  const failed = [];
  const spanStmt = db.prepare('SELECT MIN(price_date) lo, MAX(price_date) hi FROM prices WHERE ticker = ?');

  for (const ticker of tickers) {
    const span = spanStmt.get(ticker);
    if (!span || !span.lo) continue;
    const from = new Date(Date.parse(span.lo) - 10 * 864e5).toISOString().slice(0, 10);
    const to = new Date(Math.max(Date.parse(span.hi), now.getTime()) + 864e5).toISOString().slice(0, 10);
    try {
      const chart = await yf.chart(ticker, { period1: from, period2: to, interval: '1d' });
      if (!chart || !chart.meta) throw new Error('no data returned');
      barsByTicker[ticker] = finalBars(chart, now);
    } catch (err) {
      failed.push({ ticker, error: err.message });
    }
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
  return { barsByTicker, failed };
}

/* ================= known non-session dates (S6) =================
 * The bracket rule deletes a DB date Yahoo has no session for, so long as
 * Yahoo has sessions either side of it. That is correct for a weekend or a
 * market holiday, but it would just as happily delete a real weekday session
 * Yahoo happens to return no bar for (a data gap). The dry run is the human's
 * only review surface for that distinction, so weekday deletes are labelled
 * differently — see `isKnownNonSession` and its use in `planReconcile` below.
 * This is intentionally a conservative, hand-maintained list of the major
 * closures across the exchanges this app fetches from (US, Euronext, XETRA):
 * missing a smaller regional holiday only means that delete gets the more
 * cautious "weekday gap" label, never the other way around.
 */

/** The date (UTC, `YYYY-MM-DD`) of the Nth (1-based) weekday-of-month. `weekday`: 0=Sun..6=Sat. */
function nthWeekdayOfMonth(year, month, weekday, n) {
  const d = new Date(Date.UTC(year, month, 1));
  let count = 0;
  while (true) {
    if (d.getUTCDay() === weekday) {
      count++;
      if (count === n) return d.toISOString().slice(0, 10);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

/** The date of the last weekday-of-month, e.g. the last Monday of May (US Memorial Day). */
function lastWeekdayOfMonth(year, month, weekday) {
  const d = new Date(Date.UTC(year, month + 1, 0)); // last calendar day of the month
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Easter Sunday (Gregorian, Anonymous/Gauss algorithm), as `YYYY-MM-DD` (UTC). */
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  return new Date(Date.parse(dateStr) + n * 864e5).toISOString().slice(0, 10);
}

function isWeekend(dateStr) {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** A hand-maintained set of major US/Euronext/XETRA closures for one calendar year. */
function knownHolidaysForYear(year) {
  const easter = easterSunday(year);
  return new Set([
    `${year}-01-01`,                     // New Year's Day
    nthWeekdayOfMonth(year, 0, 1, 3),    // MLK Day (US) — 3rd Monday of January
    nthWeekdayOfMonth(year, 1, 1, 3),    // Presidents' Day (US) — 3rd Monday of February
    addDays(easter, -2),                 // Good Friday (US, Euronext, XETRA)
    addDays(easter, 1),                  // Easter Monday (Euronext, XETRA)
    `${year}-05-01`,                     // Labour Day (Euronext, XETRA)
    lastWeekdayOfMonth(year, 4, 1),      // Memorial Day (US) — last Monday of May
    `${year}-06-19`,                     // Juneteenth (US, since 2022)
    `${year}-07-04`,                     // Independence Day (US)
    nthWeekdayOfMonth(year, 8, 1, 1),    // Labor Day (US) — 1st Monday of September
    nthWeekdayOfMonth(year, 10, 4, 4),   // Thanksgiving (US) — 4th Thursday of November
    `${year}-12-25`,                     // Christmas Day
    `${year}-12-26`                      // Boxing Day (Euronext, XETRA) / a common US half-day partner
  ]);
}

const holidayCache = new Map();
function isKnownNonSession(dateStr) {
  if (isWeekend(dateStr)) return true;
  const year = parseInt(dateStr.slice(0, 4), 10);
  if (!holidayCache.has(year)) holidayCache.set(year, knownHolidaysForYear(year));
  return holidayCache.get(year).has(dateStr);
}

/**
 * The pure diff: every row currently in `prices`, and the final Yahoo bars for
 * each ticker, in — the reconciliation plan out. Nothing here touches a
 * database or the network; `rateFor` and `since` are passed in so this can be
 * tested without either.
 *
 * `dbRows` must include every row for every ticker in `barsByTicker` — a
 * partial view of a ticker's history would make the "session on both sides"
 * guard and the `[min,max]` insert boundary wrong.
 */
function planReconcile(dbRows, barsByTicker, { rateFor, since }) {
  const byTicker = new Map();
  for (const row of dbRows) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
    byTicker.get(row.ticker).push(row);
  }

  const updates = [], deletes = [], inserts = [], outOfWindow = [], currencyMismatches = [];

  for (const [ticker, rows] of byTicker) {
    const info = barsByTicker[ticker];
    if (!info) continue; // no Yahoo answer for this ticker: leave every row untouched

    const { currency, bars } = info;
    const yahooByDate = new Map(bars.map(b => [b.date, b.close]));
    const yahooDates = [...yahooByDate.keys()].sort();
    const dbDates = rows.map(r => r.price_date).sort();
    if (!dbDates.length) continue;
    const minDate = dbDates[0], maxDate = dbDates[dbDates.length - 1];
    const isBracketed = date => yahooDates.some(d => d < date) && yahooDates.some(d => d > date);

    for (const row of rows) {
      // Never guess across a currency mismatch (e.g. a DB row in GBp against
      // Yahoo now reporting GBP for the same ticker) — flag it and move on,
      // rather than converting a native price with the wrong rate.
      if (row.currency && row.currency !== currency) {
        currencyMismatches.push({ ticker, date: row.price_date, dbCurrency: row.currency, yahooCurrency: currency });
        continue;
      }
      const rowCurrency = row.currency || currency;
      const yClose = yahooByDate.get(row.price_date);

      if (yClose !== undefined) {
        const newNative = round4(yClose);
        // A NULL price_native (`null - x` coerces to `x` in JS, not the 0 it
        // looks like) is a stored data problem in its own right — always
        // correct it from Yahoo rather than letting the tolerance check run
        // against a value that isn't really there.
        if (row.price_native != null && Math.abs(newNative - row.price_native) <= UPDATE_TOLERANCE) continue; // already correct
        const rate = rateFor(rowCurrency, row.price_date);
        if (rate == null) continue; // no rate: better untouched than a guess
        const entry = {
          action: 'update', id: row.id, ticker, date: row.price_date,
          before: { native: row.price_native, usd: row.price_usd, eur: row.price_eur, currency: row.currency, source: row.source },
          after: {
            native: newNative, usd: rowCurrency === 'USD' ? newNative : null,
            eur: round4(newNative * rate), currency: row.currency, source: row.source
          },
          reason: 'holds the wrong close for its own date'
        };
        (row.price_date < since ? outOfWindow : updates).push(entry);
      } else if (isBracketed(row.price_date)) {
        // A date Yahoo has no session for, with sessions either side of it: a
        // weekend or holiday carrying a stale close forward. Readers already
        // carry forward the newest row on or before a date, so deleting this
        // changes nothing any reader shows. But a real weekday session with no
        // Yahoo bar (a data gap, not a non-trading day) would land here too —
        // flag those distinctly (S6) so the dry run's human reviewer notices.
        const knownNonSession = isKnownNonSession(row.price_date);
        const entry = {
          action: 'delete', id: row.id, ticker, date: row.price_date,
          before: { native: row.price_native, usd: row.price_usd, eur: row.price_eur, currency: row.currency, source: row.source },
          reason: knownNonSession
            ? 'not a trading session (weekend/holiday)'
            : 'weekday with no Yahoo session — check',
          weekdayGap: !knownNonSession
        };
        (row.price_date < since ? outOfWindow : deletes).push(entry);
      }
      // else: outside Yahoo's coverage on this side (e.g. before its first bar) — left alone
    }

    for (const date of yahooDates) {
      if (date < minDate || date > maxDate) continue; // never extend coverage — that is the job's work
      if (rows.some(r => r.price_date === date)) continue;
      const native = round4(yahooByDate.get(date));
      const rate = rateFor(currency, date);
      if (rate == null) continue;
      const entry = {
        action: 'insert', ticker, date, native,
        usd: currency === 'USD' ? native : null,
        eur: round4(native * rate), currency,
        reason: 'a session inside the range with no stored row'
      };
      (date < since ? outOfWindow : inserts).push(entry);
    }
  }

  return { updates, deletes, inserts, outOfWindow, currencyMismatches };
}

/**
 * Apply a plan in one transaction. Each changed row is re-read first and must
 * still equal the "before" the plan was built from — the job, or a manual
 * backfill, may have written to the same row since the dry run ran — and any
 * mismatch throws, which rolls back everything rather than applying half a
 * reconciliation. Refuses outright if the plan has anything OUT OF WINDOW.
 *
 * Returns the change log: exactly what was written, with every row's full
 * before-and-after, for the change-log file and for `rollback()`.
 */
function applyPlan(db, plan) {
  if (plan.outOfWindow && plan.outOfWindow.length) {
    throw new Error(`${plan.outOfWindow.length} change(s) fall before --since — refusing to apply`);
  }

  const getById = db.prepare('SELECT price_native, price_eur FROM prices WHERE id = ?');
  const updateStmt = db.prepare(`
    UPDATE prices SET price_native = ?, price_usd = ?, price_eur = ?, source = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const deleteStmt = db.prepare('DELETE FROM prices WHERE id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO prices (ticker, price_eur, price_usd, price_native, currency, price_date, source)
    VALUES (?, ?, ?, ?, ?, ?, 'yahoo_backfill')
  `);
  const bumpVersion = db.prepare('UPDATE data_version SET version = version + 1 WHERE id = 1');

  const changeLog = {
    appliedAt: new Date().toISOString(),
    updates: [], deletes: [], inserts: []
  };

  const tx = db.transaction(() => {
    for (const u of plan.updates) {
      const cur = getById.get(u.id);
      if (!cur || Math.abs(cur.price_native - u.before.native) > 1e-9 || Math.abs(cur.price_eur - u.before.eur) > 1e-9) {
        throw new Error(`concurrent write detected on ${u.ticker} ${u.date} — aborting, nothing written`);
      }
      updateStmt.run(u.after.native, u.after.usd, u.after.eur, u.after.source, u.id);
      changeLog.updates.push(u);
    }
    for (const d of plan.deletes) {
      const cur = getById.get(d.id);
      if (!cur || Math.abs(cur.price_native - d.before.native) > 1e-9 || Math.abs(cur.price_eur - d.before.eur) > 1e-9) {
        throw new Error(`concurrent write detected on ${d.ticker} ${d.date} — aborting, nothing written`);
      }
      deleteStmt.run(d.id);
      changeLog.deletes.push(d);
    }
    for (const ins of plan.inserts) {
      insertStmt.run(ins.ticker, ins.eur, ins.usd, ins.native, ins.currency, ins.date);
      changeLog.inserts.push(ins);
    }
    if (changeLog.updates.length || changeLog.deletes.length || changeLog.inserts.length) bumpVersion.run();
  });
  tx();
  return changeLog;
}

/**
 * Does the database currently hold the "after" values a change log describes?
 * Read-only — used by `rollback()` to tell a log that was written *before* the
 * transaction (status "pending", see B1 in the issue #12 review) apart from
 * one describing a transaction that never actually committed. An update row
 * must equal its logged "after"; a deleted row must be absent; an inserted
 * row must be present with the logged values. An empty change log trivially
 * "matches".
 */
function changeLogMatchesDb(db, changeLog) {
  const getById = db.prepare('SELECT price_native, price_eur FROM prices WHERE id = ?');
  const getByTickerDate = db.prepare('SELECT id, price_native, price_eur FROM prices WHERE ticker = ? AND price_date = ?');

  for (const u of changeLog.updates || []) {
    const cur = getById.get(u.id);
    if (!cur || Math.abs(cur.price_native - u.after.native) > 1e-9 || Math.abs(cur.price_eur - u.after.eur) > 1e-9) return false;
  }
  for (const d of changeLog.deletes || []) {
    if (getByTickerDate.get(d.ticker, d.date)) return false; // still there: the delete never committed
  }
  for (const ins of changeLog.inserts || []) {
    const cur = getByTickerDate.get(ins.ticker, ins.date);
    if (!cur || Math.abs(cur.price_native - ins.native) > 1e-9 || Math.abs(cur.price_eur - ins.eur) > 1e-9) return false;
  }
  return true;
}

/**
 * Reverse a change log in one transaction. Refuses (and writes nothing) if any
 * row no longer equals its logged "after" — the same optimistic check as
 * `applyPlan`, run backwards.
 *
 * Accepts a log in any of the three states `--apply` can leave one in (B1):
 *   - "applied" (or no `status` at all, for logs written by a version of this
 *     script from before that field existed): reversed unconditionally, as before.
 *   - "aborted": the transaction never committed — refuses with "nothing to
 *     roll back", since there is nothing in the database to undo.
 *   - "pending": written before the transaction ran, so on its own it does not
 *     say whether the commit happened. `changeLogMatchesDb` checks the database
 *     itself first: if it holds the "after" values, the commit did happen (a
 *     crash landed between the commit and the log being marked "applied") and
 *     the log is reversed exactly as if it said "applied"; otherwise nothing
 *     was written and this refuses with "nothing to roll back".
 *
 * Note: this restores every logged column except `updated_at` (the restored
 * row gets a fresh `CURRENT_TIMESTAMP`, not its original one) — "byte-exact"
 * holds for `price_native`/`price_usd`/`price_eur`/`currency`/`source`/id, not
 * for that column.
 */
function rollback(db, changeLog) {
  const status = changeLog.status || 'applied'; // legacy logs (pre-B1) had no status field: they are always post-commit
  if (status === 'aborted') {
    throw new Error('nothing to roll back — this change log was aborted before its transaction committed');
  }
  if (status === 'pending' && !changeLogMatchesDb(db, changeLog)) {
    throw new Error('nothing to roll back — the migration never committed (log is still "pending", and the database does not hold its "after" values)');
  }

  const getById = db.prepare('SELECT price_native, price_eur FROM prices WHERE id = ?');
  const getByTickerDate = db.prepare('SELECT id, price_native, price_eur FROM prices WHERE ticker = ? AND price_date = ?');
  const restoreUpdate = db.prepare(`
    UPDATE prices SET price_native = ?, price_usd = ?, price_eur = ?, currency = ?, source = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const reinsertDeleted = db.prepare(`
    INSERT INTO prices (id, ticker, price_eur, price_usd, price_native, currency, price_date, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const removeInserted = db.prepare('DELETE FROM prices WHERE id = ?');
  const bumpVersion = db.prepare('UPDATE data_version SET version = version + 1 WHERE id = 1');

  const tx = db.transaction(() => {
    for (const u of changeLog.updates) {
      const cur = getById.get(u.id);
      if (!cur || Math.abs(cur.price_native - u.after.native) > 1e-9 || Math.abs(cur.price_eur - u.after.eur) > 1e-9) {
        throw new Error(`rollback refused: ${u.ticker} ${u.date} no longer matches the logged "after"`);
      }
      restoreUpdate.run(u.before.native, u.before.usd, u.before.eur, u.before.currency, u.before.source, u.id);
    }
    for (const d of changeLog.deletes) {
      const existing = getByTickerDate.get(d.ticker, d.date);
      if (existing) throw new Error(`rollback refused: ${d.ticker} ${d.date} already has a row`);
      reinsertDeleted.run(d.id, d.ticker, d.before.eur, d.before.usd, d.before.native, d.before.currency, d.date, d.before.source);
    }
    for (const ins of changeLog.inserts) {
      const cur = getByTickerDate.get(ins.ticker, ins.date);
      if (!cur || Math.abs(cur.price_native - ins.native) > 1e-9 || Math.abs(cur.price_eur - ins.eur) > 1e-9) {
        throw new Error(`rollback refused: ${ins.ticker} ${ins.date} no longer matches the logged insert`);
      }
      removeInserted.run(cur.id);
    }
    bumpVersion.run();
  });
  tx();
}

/** `MIN(price_date) WHERE source='yahoo_finance' − 7 days` — see the file header. */
function defaultSince(db) {
  const row = db.prepare("SELECT MIN(price_date) lo FROM prices WHERE source = 'yahoo_finance'").get();
  if (!row || !row.lo) return '1970-01-01'; // no job rows recorded yet: nothing is out of window
  return new Date(Date.parse(row.lo) - 7 * 864e5).toISOString().slice(0, 10);
}

/**
 * The rows a bracketed re-date pass necessarily leaves alone: a ticker's DB
 * rows dated *after* the last session Yahoo has confirmed final for that
 * ticker. While today's session (or a trailing weekend row that has not yet
 * been bracketed by tomorrow's close) is still open, these are not a bug —
 * they simply cannot be judged yet — but a caller must be able to tell "ran
 * clean" apart from "ran while the market was still open".
 */
function findOpenEdgeRows(dbRows, barsByTicker) {
  const latestFinalByTicker = new Map();
  for (const [ticker, info] of Object.entries(barsByTicker)) {
    if (!info || !info.bars.length) continue;
    latestFinalByTicker.set(ticker, info.bars.reduce((a, b) => (b.date > a ? b.date : a), info.bars[0].date));
  }

  const rows = dbRows.filter(row => {
    const latestFinal = latestFinalByTicker.get(row.ticker);
    return latestFinal !== undefined && row.price_date > latestFinal;
  });
  const date = rows.length ? rows.map(r => r.price_date).sort()[0] : null;
  return { rows, date, latestFinalByTicker };
}

/**
 * Per-ticker "latest value" deltas — see Q1/Q8 of the plan. For every ticker,
 * this compares the row a reader sees *today* (the current DB row with the
 * highest `price_date`, before any migration) against the corrected row for
 * that ticker's latest Yahoo-confirmed FINAL session — the row the reconciled
 * table will actually serve once healed. That is deliberately not "the
 * ticker's latest row that happens to be in `plan.updates`": while today's
 * session is still open, the DB's newest row is one of the trailing
 * open-edge rows the bracket guard correctly leaves untouched, and comparing
 * against it instead of the last final session used to make every ticker
 * read as "+0.00 / +0.00" — a false "nothing to see here" rather than a
 * report that the run happened too early.
 *
 * This is deliberately per-ticker and per-share, not summed across tickers:
 * summing one share of *every* ticker in `prices` would count tickers nobody
 * holds and give a number that is not any user's actual portfolio effect.
 * Turning this into a real total is `portfolioEffectsByUser`'s job — it
 * weights each entry here by how many shares a given user actually holds.
 *
 * The EUR delta is split with no residual left unexplained:
 *   rateDateEffect     = nativeBefore * (rateAfter - impliedRateBefore)   (native held fixed)
 *   closeChangedEffect = rateAfter    * (nativeAfter - nativeBefore)      (rate held fixed, at rateAfter)
 * which sum to exactly `eurAfter - eurBefore` algebraically; `residual` is
 * only the rounding already baked into the stored 4dp values, so it should
 * be a cent or less **per share**.
 */
function tickerLatestValueDeltas(dbRows, barsByTicker, plan, rateFor) {
  const beforeByTicker = new Map();
  for (const row of dbRows) {
    const cur = beforeByTicker.get(row.ticker);
    if (!cur || row.price_date > cur.price_date) beforeByTicker.set(row.ticker, row);
  }

  const dbRowByTickerDate = new Map(dbRows.map(r => [`${r.ticker}|${r.price_date}`, r]));
  const updateById = new Map(plan.updates.map(u => [u.id, u]));
  const insertByTickerDate = new Map(plan.inserts.map(i => [`${i.ticker}|${i.date}`, i]));

  const { latestFinalByTicker, rows: openEdgeRows, date: openEdgeDate } = findOpenEdgeRows(dbRows, barsByTicker);

  const byTicker = new Map();

  for (const [ticker, latestFinalDate] of latestFinalByTicker) {
    const before = beforeByTicker.get(ticker);
    if (!before) continue;

    let after = null;
    const dbRowAtDate = dbRowByTickerDate.get(`${ticker}|${latestFinalDate}`);
    if (dbRowAtDate) {
      const upd = updateById.get(dbRowAtDate.id);
      after = upd
        ? upd.after
        : { native: dbRowAtDate.price_native, eur: dbRowAtDate.price_eur, currency: dbRowAtDate.currency };
    } else {
      const ins = insertByTickerDate.get(`${ticker}|${latestFinalDate}`);
      if (ins) after = { native: ins.native, eur: ins.eur, currency: ins.currency };
    }
    if (!after) continue; // no correct value available for the final session (outside stored coverage)

    const sameRow = before.price_date === latestFinalDate;
    const delta = after.eur - before.price_eur;
    if (sameRow && Math.abs(delta) <= UPDATE_TOLERANCE) continue; // already correct, no effect

    // rateAfter: the FX rate actually used (or implied) for the corrected row.
    const rateAfter = after.native !== 0
      ? after.eur / after.native
      : rateFor(after.currency || before.currency, latestFinalDate);
    const impliedRateBefore = before.price_native !== 0 ? before.price_eur / before.price_native : rateAfter;

    const rateDateEffect = before.price_native * (rateAfter - impliedRateBefore);
    const closeChangedEffect = rateAfter * (after.native - before.price_native);
    const residual = round4(delta - (rateDateEffect + closeChangedEffect));

    byTicker.set(ticker, {
      ticker,
      before: { date: before.price_date, native: before.price_native, eur: before.price_eur },
      after: { date: latestFinalDate, native: after.native, eur: after.eur },
      delta, rateDateEffect, closeChangedEffect, residual
    });
  }

  return { byTicker, openEdge: { rows: openEdgeRows, date: openEdgeDate } };
}

/** `user@example.com` -> `us***@example.com`, the same masking verify-portfolio.js uses. */
function maskEmail(email) {
  return String(email || '').replace(/(.{2}).*(@.*)/, '$1***$2');
}

/**
 * The acceptance criterion (plan Q1) is measured in a real portfolio, not one
 * share of every changed ticker — see `tickerLatestValueDeltas`. For every
 * user with at least one held ticker (quantity > 0, via `replayPosition`,
 * which applies every split after the trade the same way the app does), this
 * weights each held ticker's per-share rate-date and close-changed effects by
 * that user's actual quantity, and sums the result into one portfolio line.
 * Tickers nobody holds, and tickers a user has fully sold out of, contribute
 * nothing — a changed ticker only enters a user's total if `quantity > 0`
 * today for that user.
 *
 * A user who holds nothing at all is skipped entirely (no line). A user who
 * holds something, but none of it is a ticker this run touched, gets an
 * explicit "no effect" line rather than silence, so a reviewer can tell
 * "checked, nothing changed" apart from "not checked at all".
 *
 * `identityDb` is optional (the `IDENTITY_DB_PATH` a caller may have wired
 * up via `identity-db.js`'s `identityFor`); without it, or without a stored
 * email, the line is labelled by the first 8 characters of the user's key.
 */
function portfolioEffectsByUser(db, byTicker, identityDb) {
  const changedTickers = [...byTicker.keys()];
  const users = db.prepare('SELECT DISTINCT user_id FROM transactions').all().map(r => r.user_id);
  const lines = [];

  for (const userId of users) {
    const tickers = db.prepare('SELECT DISTINCT ticker FROM transactions WHERE user_id = ?').all(userId).map(r => r.ticker);
    const held = [];
    for (const ticker of tickers) {
      const { quantity } = replayPosition(db, userId, ticker);
      if (quantity > 0) held.push({ ticker, quantity });
    }
    if (!held.length) continue; // nothing held at all: no line

    let total = 0, rateDateEffect = 0, closeChangedEffect = 0, affected = 0;
    for (const { ticker, quantity } of held) {
      const e = byTicker.get(ticker);
      if (!e) continue;
      affected++;
      total += quantity * e.delta;
      rateDateEffect += quantity * e.rateDateEffect;
      closeChangedEffect += quantity * e.closeChangedEffect;
    }

    let label = String(userId).slice(0, 8);
    if (identityDb) {
      try {
        const row = identityDb.prepare('SELECT email FROM users WHERE user_key = ?').get(userId);
        if (row && row.email) label = maskEmail(row.email);
      } catch { /* identity db unavailable or shaped differently: fall back to the key prefix */ }
    }

    lines.push({
      userId, label, heldCount: held.length, affectedCount: affected,
      hasEffect: affected > 0,
      total: round4(total), rateDateEffect: round4(rateDateEffect), closeChangedEffect: round4(closeChangedEffect),
      residual: round4(total - (rateDateEffect + closeChangedEffect))
    });
  }

  return { lines, changedTickers };
}

function printPlan(log, plan, dbRows, barsByTicker, rateFor, db, { identityDb } = {}) {
  const counts = { update: plan.updates.length, delete: plan.deletes.length, insert: plan.inserts.length };
  const weekdayGapCount = plan.deletes.filter(d => d.weekdayGap).length;
  log(`Plan: ${counts.update} update(s), ${counts.delete} delete(s)`
    + (weekdayGapCount ? ` (${weekdayGapCount} weekday gap — check)` : '')
    + `, ${counts.insert} insert(s)`
    + (plan.outOfWindow.length ? `, ${plan.outOfWindow.length} OUT OF WINDOW` : ''));

  const changedTickerSet = new Set([...plan.updates, ...plan.deletes, ...plan.inserts].map(e => e.ticker));
  log(`Tickers affected: ${changedTickerSet.size ? [...changedTickerSet].sort().join(', ') : '(none)'}`);

  for (const u of plan.updates) {
    log(`  UPDATE ${u.ticker} ${u.date}: ${u.before.native}/${u.before.eur} -> ${u.after.native}/${u.after.eur} (${u.reason})`);
  }
  for (const d of plan.deletes) {
    const label = d.weekdayGap ? 'DELETE (weekday gap — Yahoo has no bar)' : 'DELETE';
    log(`  ${label} ${d.ticker} ${d.date}: was ${d.before.native}/${d.before.eur} (${d.reason})`);
  }
  for (const i of plan.inserts) {
    log(`  INSERT ${i.ticker} ${i.date}: ${i.native}/${i.eur} (${i.reason})`);
  }
  for (const o of plan.outOfWindow) {
    log(`  OUT OF WINDOW ${o.action.toUpperCase()} ${o.ticker} ${o.date} — before --since, needs a human decision`);
  }
  if (plan.currencyMismatches && plan.currencyMismatches.length) {
    log(`⚠ ${plan.currencyMismatches.length} row(s) left untouched because their stored currency does not match Yahoo's:`);
    for (const m of plan.currencyMismatches) {
      log(`  ${m.ticker} ${m.date}: DB says ${m.dbCurrency}, Yahoo says ${m.yahooCurrency} — check by hand`);
    }
  }

  const { byTicker, openEdge } = tickerLatestValueDeltas(dbRows, barsByTicker, plan, rateFor);
  const { lines } = portfolioEffectsByUser(db, byTicker, identityDb);

  log(''); // blank line ahead of the per-user portfolio effects
  for (const u of lines) {
    if (!u.hasEffect) {
      log(`Portfolio effect, user ${u.label} (${u.heldCount} held ticker${u.heldCount === 1 ? '' : 's'}): no effect`);
      continue;
    }
    log(`Portfolio effect, user ${u.label} (${u.heldCount} held ticker${u.heldCount === 1 ? '' : 's'}): `
      + `total ${u.total >= 0 ? '+' : ''}${u.total.toFixed(2)}`
      + ` = rate-date ${u.rateDateEffect >= 0 ? '+' : ''}${u.rateDateEffect.toFixed(2)}`
      + ` + close-changed ${u.closeChangedEffect >= 0 ? '+' : ''}${u.closeChangedEffect.toFixed(2)}`
      + ` (residual ${u.residual >= 0 ? '+' : ''}${u.residual.toFixed(2)})`);
  }
  if (!lines.length) log('No user holds any ticker this run touched.');

  if (openEdge.rows.length) {
    log(`⚠ ${openEdge.rows.length} row(s) on or after ${openEdge.date} left untouched because the latest session `
      + `is not final yet; re-run after all sessions have closed (the runbook's 22:30–07:30 Lisbon window)`);
  }
  return { counts, lines, openEdgeCount: openEdge.rows.length, weekdayGapCount };
}

const USAGE = 'usage: DB_PATH=<path> node redate-prices.js [--apply] [--since YYYY-MM-DD] [--backup-dir <dir>] [--rollback <changes.json>]';

/**
 * Writes a change-log file so a crash can never leave a half-written one
 * behind to be mistaken for a good log (B1): write to a temp file in the same
 * directory, `fsync` it, then `rename` over the real path (an atomic
 * replace on the same filesystem), then best-effort `fsync` the directory so
 * the rename itself is durable, not just queued. Exported so tests can pass a
 * wrapper that fails on a chosen call, to exercise "crash right after the
 * commit" without needing to kill and resume a real process.
 */
function writeChangeLogAtomic(logPath, data) {
  const tmp = `${logPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, logPath);
  try {
    const dirFd = fs.openSync(path.dirname(logPath), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* directory fsync unsupported on this platform: best effort only */ }
  try { fs.chmodSync(logPath, 0o600); } catch { /* best effort */ }
}

/**
 * Gzip a raw backup file into `backup-db.sh`'s own naming convention (B2):
 * `<name>.db.pre-redate-<stamp>.gz`. `backup-db.sh --restore` derives its
 * destination with `${base%%.db.*}.db`, so a name of the shape
 * `portfolio.db.pre-redate-<stamp>.gz` resolves back to `portfolio.db` there
 * too — the same last-resort restore path works for this script's backups
 * without a special case, and an uncompressed backup can never again be handed
 * to `gunzip`, which used to truncate the live database before failing.
 */
async function gzipBackup(rawPath, gzPath) {
  await pipeline(fs.createReadStream(rawPath), zlib.createGzip(), fs.createWriteStream(gzPath));
  fs.unlinkSync(rawPath);
  try { fs.chmodSync(gzPath, 0o600); } catch { /* best effort */ }
}

async function main({
  db, yf, argv, now = new Date(), log = console.log, backupDirDefault, identityDb = identityFor(db),
  delayMs = 250, writeChangeLog = writeChangeLogAtomic, gzip = gzipBackup
}) {
  let apply = false, rollbackFile = null, since = null, backupDir = backupDirDefault;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--since') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { log('✗ --since needs a value (YYYY-MM-DD)'); log(USAGE); return 1; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { log(`✗ --since "${v}" is not YYYY-MM-DD`); log(USAGE); return 1; }
      since = v;
    }
    else if (a === '--backup-dir') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { log('✗ --backup-dir needs a value'); log(USAGE); return 1; }
      backupDir = v;
    }
    else if (a === '--rollback') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { log('✗ --rollback needs a value (a change-log path)'); log(USAGE); return 1; }
      rollbackFile = v;
    }
    else { log(`✗ unknown argument "${a}"`); log(USAGE); return 1; }
  }

  if (rollbackFile) {
    let changeLog;
    try {
      changeLog = JSON.parse(fs.readFileSync(rollbackFile, 'utf-8'));
    } catch (err) {
      log(`✗ could not read ${rollbackFile}: ${err.message}`);
      return 1;
    }

    try {
      if (serviceIsActive('portfolio-price-fetch.service')) {
        log('✗ portfolio-price-fetch.service looks active — refusing to roll back while the job might be writing.');
        return 1;
      }
    } catch { /* systemctl not present: best effort only */ }

    // Cheap insurance: a bad rollback should also be recoverable. Best-effort —
    // rollback() re-checks every row itself, so a failed backup here does not
    // by itself make the rollback unsafe, only harder to undo if it goes wrong.
    const dir = backupDir || path.join(os.homedir(), 'backups', 'portfoliotracker');
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rawBackupPath = path.join(dir, `portfolio.db.pre-rollback-${stamp}`);
      const backupPath = `${rawBackupPath}.gz`;
      await db.backup(rawBackupPath);
      await gzip(rawBackupPath, backupPath);
      log(`Backup written: ${backupPath}`);
    } catch (err) {
      log(`⚠ could not take a pre-rollback backup (${err.message}); continuing anyway`);
    }

    try {
      rollback(db, changeLog);
    } catch (err) {
      log(`✗ ${err.message}`);
      return 1;
    }
    log(`Rolled back ${changeLog.updates.length} update(s), ${changeLog.deletes.length} delete(s), ${changeLog.inserts.length} insert(s).`);
    return 0;
  }

  if (!since) since = defaultSince(db);
  log(`--since ${since}`);

  const tickers = db.prepare('SELECT DISTINCT ticker FROM prices ORDER BY ticker').all().map(r => r.ticker);
  const { barsByTicker, failed } = await gatherBars(db, yf, tickers, now, { delayMs });
  if (failed.length) {
    log(`✗ Yahoo could not be reached for ${failed.length} ticker(s): ${failed.map(f => `${f.ticker} (${f.error})`).join(', ')}`);
    log('  Aborting — nothing written.');
    return 1;
  }

  const dbRows = db.prepare('SELECT id, ticker, price_date, price_native, price_usd, price_eur, currency, source FROM prices ORDER BY ticker, price_date').all();
  const rateFor = makeRateLookup(db);
  const plan = planReconcile(dbRows, barsByTicker, { rateFor, since });
  const { openEdgeCount } = printPlan(log, plan, dbRows, barsByTicker, rateFor, db, { identityDb });

  if (!apply) {
    log(`\nDry run — nothing written.${openEdgeCount ? ` (${openEdgeCount} row(s) left at the open edge — see warning above.)` : ''}`);
    return 0;
  }

  if (plan.outOfWindow.length) {
    log(`\n✗ ${plan.outOfWindow.length} change(s) are OUT OF WINDOW — refusing to apply. Review with a human and re-run with --since.`);
    return 1;
  }

  try {
    if (serviceIsActive('portfolio-price-fetch.service')) {
      log('✗ portfolio-price-fetch.service looks active — refusing to apply while the job might be writing.');
      return 1;
    }
  } catch { /* systemctl not present: best effort only */ }

  const dir = backupDir || path.join(os.homedir(), 'backups', 'portfoliotracker');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* dir pre-existed with looser perms: best effort */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawBackupPath = path.join(dir, `portfolio.db.pre-redate-${stamp}`);
  const backupPath = `${rawBackupPath}.gz`; // gzipped, backup-db.sh's own naming — see B2
  const logPath = path.join(dir, `redate-prices-${stamp}.json`);

  await db.backup(rawBackupPath);
  await gzip(rawBackupPath, backupPath);
  log(`Backup written: ${backupPath}`);

  // B1: the change log is written BEFORE the transaction, as "pending". The
  // transaction is all-or-nothing, so the planned rows are exactly what will
  // be applied if it commits — a pending log for a transaction that never
  // commits is harmless (rollback() refuses it, because the DB still holds
  // the "before" values, not the "after" the log describes).
  const pendingLog = {
    status: 'pending', createdAt: new Date().toISOString(), since,
    updates: plan.updates, deletes: plan.deletes, inserts: plan.inserts
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
    // The transaction rolled back: nothing was written to the database. Mark
    // the log so nobody mistakes a pending log for a completed migration.
    try {
      writeChangeLog(logPath, { ...pendingLog, status: 'aborted', abortedAt: new Date().toISOString(), error: err.message });
    } catch { /* best effort: rollback() would refuse a stale "pending" log too, once it checks the DB */ }
    log(`✗ ${err.message}`);
    log('  Nothing written.');
    return 1;
  }

  try {
    writeChangeLog(logPath, {
      ...pendingLog, status: 'applied', appliedAt: changeLog.appliedAt,
      updates: changeLog.updates, deletes: changeLog.deletes, inserts: changeLog.inserts
    });
  } catch (err) {
    // The transaction DID commit — the database has already changed. Losing
    // the "applied" rewrite here must never read as "nothing written": that
    // was true before the pending log, never after.
    console.error('✗✗✗ THE DATABASE WAS MIGRATED (the transaction committed) but the change log');
    console.error(`✗✗✗ could not be marked "applied": ${err.message}`);
    console.error(`✗✗✗ The log at ${logPath} is still marked "pending" and describes exactly what`);
    console.error('✗✗✗ was written — it is safe to use with --rollback as-is. Fix the write failure');
    console.error('✗✗✗ (disk space, permissions) before running this script again.');
    return 1;
  }

  log(`Change log written: ${logPath}`);
  log(`Applied: ${changeLog.updates.length} update(s), ${changeLog.deletes.length} delete(s), ${changeLog.inserts.length} insert(s).`);
  return 0;
}

/**
 * Best effort: `false` (never blocks) if systemctl is not present or the unit
 * is unknown. `portfolio-price-fetch.service` is `Type=oneshot`, so while it
 * is running its `ActiveState` is `activating`, not `active` — `systemctl
 * is-active` exits non-zero for that and would make this check a no-op for
 * the one unit it exists for (S1). `systemctl show -p ActiveState --value`
 * always exits 0 and prints the state as plain text instead, so `activating`
 * (and `reloading`, for a unit type that has one) can be read directly.
 */
function serviceIsActive(unit) {
  try {
    const out = execSync(`systemctl show -p ActiveState --value ${unit}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out === 'active' || out === 'activating' || out === 'reloading';
  } catch {
    return false;
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    console.error('✗ DB_PATH is required — this script never guesses or creates a database.');
    process.exit(1);
  }
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  const YahooFinance = require('yahoo-finance2').default;
  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

  main({ db, yf, argv, log: console.log }).then(code => {
    db.close();
    process.exit(code);
  }).catch(err => {
    console.error(err);
    db.close();
    process.exit(1);
  });
}

module.exports = {
  planReconcile, applyPlan, rollback, gatherBars, defaultSince,
  tickerLatestValueDeltas, portfolioEffectsByUser, findOpenEdgeRows, printPlan, main, round4, UPDATE_TOLERANCE,
  writeChangeLogAtomic, gzipBackup, changeLogMatchesDb, serviceIsActive, isKnownNonSession
};
