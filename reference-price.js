/**
 * Where a Dip or Target rule measures from.
 *
 * Both rules ask "how far is the price from what this stock is worth to me",
 * and until the watchlist existed that had exactly one answer: the average cost
 * of the position. A watched stock has no position and therefore no cost, so it
 * carries a reference price instead — see ensureWatchlist() in db-migrations.js
 * for what the three kinds mean.
 *
 * **Holdings always win.** A stock that is both held and watched resolves to its
 * cost basis and never looks at the watchlist. That ordering is the whole safety
 * property of this module: every alert that existed before the watchlist was
 * built keeps resolving to precisely the number it resolved to before, so
 * shipping this cannot quietly restate somebody's live alerts. Do not invert it,
 * and do not add a "prefer the watchlist" option — the reason there is one answer
 * is that two answers eventually disagree and the wrong one wins.
 *
 * `basis` travels with the number on purpose. A watch price and a cost basis are
 * both euros per share and are not the same fact, and alert_events has a single
 * `avg_cost_eur` column to put either in. Without the label, alert-followthrough
 * would read "you were 25% under your cost" off a stock that was never bought.
 */

const { getAvgCostPerShare } = require('./portfolio');

/** True when the database has been migrated far enough to have a watchlist. */
function hasWatchlist(db) {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'watchlist'"
  ).get();
}

/**
 * The reference for one user's view of one ticker.
 *
 * @returns {{eur: number, basis: string, quantity?: number}|null}
 *   `basis` is 'avg_cost' for a holding, or the watchlist's own
 *   'spotted' | 'typed' | 'carried'. Null when there is nothing to measure
 *   against — neither held nor watched, or watched with no reference recorded.
 */
function referenceFor(db, userId, ticker) {
  const cost = getAvgCostPerShare(db, userId, ticker);
  if (cost) return { eur: cost.avgCostEUR, basis: 'avg_cost', quantity: cost.quantity };

  // Guarded rather than assumed: this is read by the daily job, and a database
  // restored from a backup taken before the watchlist shipped still has to run.
  if (!hasWatchlist(db)) return null;

  const watched = db.prepare(
    'SELECT reference_price_eur, reference_source FROM watchlist WHERE user_id = ? AND ticker = ?'
  ).get(userId, ticker);

  // A row with no reference price is a stock somebody is following without
  // having said what they would pay. Price level and Trailing still work for it;
  // Dip and Target have nothing to measure from and must not invent one.
  if (!watched || watched.reference_price_eur == null) return null;

  return { eur: watched.reference_price_eur, basis: watched.reference_source };
}

/** Every ticker this user is watching. */
function watchedTickers(db, userId) {
  if (!hasWatchlist(db)) return [];
  return db.prepare(
    'SELECT ticker FROM watchlist WHERE user_id = ? ORDER BY ticker'
  ).all(userId).map(r => r.ticker);
}

/** Every watched ticker across all users — what the daily job needs to fetch. */
function allWatchedTickers(db) {
  if (!hasWatchlist(db)) return [];
  return db.prepare('SELECT DISTINCT ticker FROM watchlist ORDER BY ticker')
    .all().map(r => r.ticker);
}

module.exports = { referenceFor, watchedTickers, allWatchedTickers, hasWatchlist };
