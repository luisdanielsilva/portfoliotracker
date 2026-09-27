/**
 * Naming a stock split Yahoo knows about and this app's `stock_splits` table
 * does not — issue #9.
 *
 * `stock_splits` is global (see README): a row inserted by any account changes
 * quantities and average cost for every user holding that ticker. That is why
 * everything the server accepts here comes from Yahoo, never from the client —
 * a browser supplies only which ticker and which date, and this module decides
 * whether that is a real, clean split and what its ratio actually is.
 *
 * Pure functions (`isCleanSplit`, `diffAgainstRecorded`, `evidenceFor`) take no
 * database and no network, so they are unit-tested directly. `fetchSplits` and
 * `recordSplit` take an injectable `yf`, because the HTTP test suite spawns the
 * real server against a temporary database and nothing there may reach Yahoo.
 */

/**
 * How far a reduced split ratio may go and still be offered as a split.
 *
 * Yahoo's `chart(..., {events:'split'})` also reports corporate actions that
 * are not splits at all — AT&T's WarnerMedia spin-off shows up as a
 * "1324:1000 split" on 2022-04-11, and holders' share counts did not change
 * that day. A genuine split is a small, round number on both sides once
 * reduced (5:1, 3:2, 1:10); 1324:1000 reduces to 331:250, which is neither
 * small nor round. 20 is generous enough to admit a 20-for-1 split (Amazon
 * and Alphabet both did one in 2022) while still rejecting every spin-off
 * ratio observed so far.
 */
const CLEAN_MAX = 20;

/**
 * Cached Yahoo split lookups, keyed by ticker. Public market data, so the
 * cache is global rather than per-user.
 *
 * A successful response with no events gets a short TTL: an empty result is
 * often a ticker Yahoo hasn't backfilled yet rather than a durable fact, and
 * caching it for as long as a real split list would mean a preview retried
 * an hour later still saying "no splits" for no good reason. A response with
 * events is stable market history and can sit for longer.
 *
 * The cache is also size-bounded: entries are inserted in `Map` insertion
 * order, so the oldest can be evicted once the cache grows past `CACHE_MAX`
 * without tracking access times.
 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_EMPTY_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();

function cacheSet(ticker, value) {
  cache.delete(ticker);   // re-insert at the end so eviction below drops the oldest, not this one
  cache.set(ticker, { at: Date.now(), value, ttl: value.events.length ? CACHE_TTL_MS : CACHE_EMPTY_TTL_MS });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/** Test-only: forget every cached lookup, so one test's fake `yf` cannot serve another's assertions. */
function _clearCache() {
  cache.clear();
}

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

/**
 * Is (numerator, denominator) a "clean" split ratio.
 *
 * Reduces by the pair's gcd first, then requires both reduced terms to be
 * integers no larger than CLEAN_MAX, and the ratio to actually be a split
 * (not 1:1 or 0:1 — no-ops Yahoo has been seen to report).
 */
function isCleanSplit(numerator, denominator) {
  if (!numerator || !denominator) return false;
  const g = gcd(numerator, denominator);
  const n = numerator / g, d = denominator / g;
  if (!Number.isInteger(n) || !Number.isInteger(d)) return false;
  if (n === d) return false;
  return n <= CLEAN_MAX && d <= CLEAN_MAX;
}

/** 'YYYY-MM-DD' from whatever chart() handed back — a Date, or already a string. */
function isoDate(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/**
 * Every split event Yahoo reports for `ticker`, plus the monthly bars needed
 * to weigh evidence about them, from a single monthly-bar request — see
 * evidenceFor(). Cached for CACHE_TTL_MS because a preview and the confirm
 * step that follows it both ask about the same ticker within seconds of each
 * other, and repeated previews while someone fiddles with column mapping
 * would otherwise hit Yahoo every time.
 */
async function fetchSplits(yf, ticker) {
  const cached = cache.get(ticker);
  if (cached) {
    if (Date.now() - cached.at < cached.ttl) return cached.value;
    cache.delete(ticker);   // expired; fall through and refetch, don't just let it sit
  }

  const chart = await yf.chart(ticker, {
    period1: '1990-01-01', interval: '1mo', events: 'split'
  });

  const rawEvents = (chart.events && chart.events.splits) || [];
  const events = rawEvents.map(e => {
    const numerator = e.numerator, denominator = e.denominator;
    return {
      date: isoDate(e.date),
      numerator, denominator,
      ratio: numerator / denominator,
      clean: isCleanSplit(numerator, denominator)
    };
  }).sort((a, b) => a.date.localeCompare(b.date));

  const months = (chart.quotes || [])
    .filter(q => q.low != null && q.high != null)
    .map(q => ({ month: isoDate(q.date).slice(0, 7), low: q.low, high: q.high }));

  const value = { events, months };
  cacheSet(ticker, value);
  return value;
}

const DAY_MS = 864e5;
function daysApart(a, b) {
  return Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;
}

/**
 * Mark each Yahoo event `recorded` if a `stock_splits` row for the same
 * ticker lies within +/-7 days of it.
 *
 * The tolerance is not cosmetic: the unique index on `stock_splits` is
 * (ticker, split_date), so a date one day off from an existing row would be
 * accepted as a *different* split and applied a second time, doubling every
 * holding's post-split quantity. `recordedRows` is already scoped to one
 * ticker — `[{date}]` — since the caller knows which ticker it is checking.
 */
function diffAgainstRecorded(events, recordedRows) {
  return events.map(e => ({
    ...e,
    recorded: recordedRows.some(r => daysApart(e.date, r.date) <= 7)
  }));
}

/**
 * Whether the rows in a file, priced before `split`, look as-traded (paid at
 * the real, pre-split price) or restated (the broker already rewrote history
 * to the split-adjusted price).
 *
 * `months` are Yahoo's monthly bars, which are always adjusted for *every*
 * split the ticker has ever had, past and future relative to any one row.
 * The midpoint of a month's low and high is one adjusted reference price;
 * un-adjusting it back to what would actually have changed hands on a given
 * date means multiplying by the ratio of every split that happened *after*
 * that date — that is the as-traded hypothesis. The restated hypothesis is
 * the same, except it leaves `split` itself out of that product, because a
 * broker who already applied this one split's adjustment would not have
 * applied any split that came later either... except this one, which the
 * file already accounts for.
 *
 * Rows in the split's own month are skipped — a trade at any point in that
 * month could have landed before or after the ex-date, so its price does not
 * cleanly belong to either hypothesis. Comparison is in log distance, so a
 * row twice too high and a row half as high count the same as evidence in
 * their own direction, which a raw difference would not.
 *
 * Returns 'as-traded', 'restated', or 'unknown' when no row qualifies or the
 * qualifying rows are evenly split between the two.
 */
function evidenceFor(rows, events, months, split) {
  const monthOf = d => d.slice(0, 7);
  const splitMonth = monthOf(split.date);
  const monthByKey = new Map(months.map(m => [m.month, m]));

  let asTraded = 0, restated = 0;
  for (const row of rows) {
    if (!row.date || !(row.date < split.date)) continue;
    if (monthOf(row.date) === splitMonth) continue;
    if (!row.price) continue;
    const m = monthByKey.get(monthOf(row.date));
    if (!m) continue;

    const adjMid = (m.low + m.high) / 2;
    const later = events.filter(e => e.date > row.date);
    const factorAll = later.reduce((a, e) => a * e.ratio, 1);
    const factorWithoutThis = later
      .filter(e => e.date !== split.date)
      .reduce((a, e) => a * e.ratio, 1);

    const expectedAsTraded = adjMid * factorAll;
    const expectedRestated = adjMid * factorWithoutThis;
    if (!expectedAsTraded || !expectedRestated) continue;

    const distAsTraded = Math.abs(Math.log(row.price / expectedAsTraded));
    const distRestated = Math.abs(Math.log(row.price / expectedRestated));
    if (distAsTraded < distRestated) asTraded++;
    else if (distRestated < distAsTraded) restated++;
  }

  if (asTraded === 0 && restated === 0) return 'unknown';
  if (asTraded > restated) return 'as-traded';
  if (restated > asTraded) return 'restated';
  return 'unknown';
}

const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;   // same shape server.js validates transactions against
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The full server-side rule for POST /api/stock-splits (acceptance criterion
 * 5 in the plan): validate, refuse a duplicate without calling Yahoo, require
 * a pre-split holding, require Yahoo to actually report a matching clean
 * split, and only then insert it — with Yahoo's own date and ratio, never
 * anything the client supplied.
 *
 * Returns a plain result object; the route maps it to an HTTP status.
 */
/**
 * True for a SQLite UNIQUE-index violation (better-sqlite3's synchronous
 * throw) — not for constraint failures in general. A bare `SQLITE_CONSTRAINT`
 * also covers a trigger `RAISE`, a CHECK, or a foreign-key failure, none of
 * which mean "already recorded".
 */
function isUniqueConstraintError(err) {
  return !!err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || /unique constraint/i.test(String(err.message || '')));
}

/**
 * The HTTP status and message safe to hand back to the client for a failed
 * Yahoo fetch.
 *
 * yahoo-finance2's own error text (rate-limit bodies, stack-shaped messages)
 * is not meant for an end user and is logged instead. Where the shape of the
 * error lets us tell the two cases apart, "no data for this ticker" (404 —
 * the ticker itself is the problem, not the service) and "the service is
 * unavailable" (502) get different statuses and plain-English messages; when
 * it doesn't, the safe default is "unavailable" rather than "no splits".
 */
function yahooErrorInfo(err) {
  const msg = String((err && err.message) || '');
  if (/not found|no data|no fundamentals|unknown symbol|delisted/i.test(msg)) {
    return { status: 404, error: 'Yahoo has no data for this ticker.' };
  }
  return { status: 502, error: 'Yahoo is unavailable right now. Try again shortly.' };
}

async function recordSplit(db, yf, userId, ticker, date) {
  const t = String(ticker || '').toUpperCase().trim();
  const d = String(date || '');
  if (!TICKER_RE.test(t) || !DATE_RE.test(d)) {
    return { ok: false, status: 400, error: 'Ticker or date is not valid.' };
  }

  const recordedStmt = db.prepare('SELECT split_date AS date FROM stock_splits WHERE ticker = ?');
  const recorded = recordedStmt.all(t);
  if (recorded.some(r => daysApart(r.date, d) <= 7)) {
    return { ok: true, alreadyRecorded: true, status: 200 };
  }

  let events;
  try {
    ({ events } = await fetchSplits(yf, t));
  } catch (err) {
    console.error(`stock_splits: fetchSplits(${t}) failed:`, err.message);
    return { ok: false, ...yahooErrorInfo(err) };
  }

  const match = events.find(e => daysApart(e.date, d) <= 3);
  if (!match) {
    return { ok: false, status: 404, error: `Yahoo does not report a split for ${t} near ${d}.` };
  }
  if (!match.clean) {
    return {
      ok: false, status: 422,
      error: `${t}'s ${match.numerator}:${match.denominator} event on ${match.date} is not a clean split ratio and is not recorded.`
    };
  }

  // Re-run both checks against Yahoo's own date, not the client's `d`: the
  // insert below uses `match.date`, which can be up to 3 days from `d`, and
  // it — not `d` — is what the unique index and the "held before" rule
  // actually have to agree with.
  if (recorded.some(r => daysApart(r.date, match.date) <= 7)) {
    return { ok: true, alreadyRecorded: true, status: 200 };
  }

  const held = db.prepare(`
    SELECT 1 FROM transactions
    WHERE user_id = ? AND ticker = ? AND date(ts/1000,'unixepoch') < ? LIMIT 1
  `).get(userId, t, match.date);
  if (!held) {
    return { ok: false, status: 409, error: `No transaction in ${t} dated before ${match.date} was found on this account.` };
  }

  const description = `${match.numerator}-for-${match.denominator} split (from Yahoo, confirmed during an import)`;
  try {
    db.prepare(`
      INSERT INTO stock_splits (ticker, split_date, ratio, description, source, added_by, added_at)
      VALUES (?, ?, ?, ?, 'yahoo', ?, CURRENT_TIMESTAMP)
    `).run(t, match.date, match.ratio, description, userId);
  } catch (err) {
    // A concurrent request, or a `d` on the other side of the event from this
    // one, can both reach here for the same (ticker, split_date). The row is
    // recorded either way, so this is success, not a 500.
    if (isUniqueConstraintError(err)) {
      return { ok: true, alreadyRecorded: true, status: 200 };
    }
    throw err;
  }

  console.log(`stock_splits: recorded ${t} ${match.numerator}:${match.denominator} on ${match.date} (user ${userId})`);

  return {
    ok: true, status: 201, ticker: t, date: match.date,
    numerator: match.numerator, denominator: match.denominator, ratio: match.ratio
  };
}

module.exports = {
  CLEAN_MAX, isCleanSplit, fetchSplits, diffAgainstRecorded, evidenceFor, recordSplit, _clearCache
};
