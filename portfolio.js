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
function getAvgCostPerShare(db, userId, ticker) {
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
  }

  if (quantity <= 0) return null;
  return { avgCostEUR: totalAmount / quantity, quantity };
}

module.exports = { getAvgCostPerShare };
