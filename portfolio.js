/**
 * Portfolio arithmetic shared by the server and the price-fetch job.
 *
 * These numbers were previously computed by two separate copies of the same
 * function — one in server.js, one in price-fetch.js — with different signatures
 * and different return types. They happened to agree, and nothing enforced it.
 * That mattered because the same figure is both what the app displays as your
 * average cost and what a dip alert fires against: had they drifted, the app
 * would have shown one number while the alerts acted on another, silently.
 */

/**
 * Average cost per share currently held, in EUR, from the transaction history.
 *
 * Cost basis stays in euros deliberately: euros are what actually left the
 * account, and a position bought partly in dollars and partly in euros has no
 * single native cost to average. See the currency notes in README.
 *
 * Returns null when nothing is held — a fully exited position has no average
 * cost, and dividing by zero quantity would otherwise produce Infinity.
 */
/**
 * Walk one position's transactions once, in order.
 *
 * Extracted so that "what is it worth now" and "what was it worth while it was
 * still held" cannot disagree. This file exists because two copies of this
 * arithmetic already drifted apart once; a second reader of the same rows would
 * have been the same mistake in a new place.
 *
 * `lastHeld` is the answer as of the last transaction that left anything held —
 * which, for a position that has since been closed, is the average cost actually
 * paid over its whole life.
 */
function replayPosition(db, userId, ticker) {
  const rows = db.prepare(`
    SELECT tx_type, quantity, amount_eur, date(ts/1000,'unixepoch') AS tx_date
    FROM transactions
    WHERE user_id = ? AND ticker = ? ORDER BY ts ASC
  `).all(userId, ticker);

  // A split changes how many shares the same money bought. One share at €600 that
  // later splits 3-for-1 is three shares at €200 — the position is unchanged, but
  // per-share cost is not. Ignoring splits overstated the average cost by the split
  // ratio and reported a share count that disagreed with the portfolio chart, and
  // that figure is what dip alerts fire against.
  const splits = db.prepare(
    'SELECT split_date, ratio FROM stock_splits WHERE ticker = ? ORDER BY split_date ASC'
  ).all(ticker);

  let quantity = 0;
  let totalAmount = 0;
  let lastHeld = null;
  for (const tx of rows) {
    // express every transaction in today's share terms: multiply by each split
    // that happened after it was bought
    let qty = tx.quantity;
    for (const split of splits) {
      if (tx.tx_date < split.split_date) qty *= split.ratio;
    }

    if (tx.tx_type === 'buy') {
      quantity += qty;
      totalAmount += tx.amount_eur;
    } else if (tx.tx_type === 'sell') {
      quantity -= qty;
      totalAmount -= tx.amount_eur;
    }

    if (quantity > 0) lastHeld = { avgCostEUR: totalAmount / quantity, quantity };
  }

  return { quantity, totalAmount, lastHeld, transactionCount: rows.length };
}

function getAvgCostPerShare(db, userId, ticker) {
  const { quantity, totalAmount } = replayPosition(db, userId, ticker);
  if (quantity <= 0) return null;
  return { avgCostEUR: totalAmount / quantity, quantity };
}

/**
 * What a share of this cost, on average, while it was still held — for a
 * position that has since been closed.
 *
 * This is the reference a sold-out stock carries onto the watchlist. It has to
 * be recomputed from the history rather than remembered at the moment of sale,
 * because the offer to keep watching can be accepted long after the sale, and
 * because a number the browser sends back is a number the browser could have
 * changed.
 *
 * Returns null while anything is still held — ask getAvgCostPerShare then — and
 * null for a ticker that was never held at all.
 */
function lastHeldAvgCost(db, userId, ticker) {
  const { quantity, lastHeld } = replayPosition(db, userId, ticker);
  if (quantity > 0) return null;
  return lastHeld;
}

module.exports = { getAvgCostPerShare, lastHeldAvgCost, replayPosition };
