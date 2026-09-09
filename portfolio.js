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
    SELECT tx_type, quantity, amount_eur FROM transactions
    WHERE user_id = ? AND ticker = ? ORDER BY ts ASC
  `).all(userId, ticker);

  let quantity = 0;
  let totalAmount = 0;
  for (const tx of rows) {
    if (tx.tx_type === 'buy') {
      quantity += tx.quantity;
      totalAmount += tx.amount_eur;
    } else if (tx.tx_type === 'sell') {
      quantity -= tx.quantity;
      totalAmount -= tx.amount_eur;
    }
  }

  if (quantity <= 0) return null;
  return { avgCostEUR: totalAmount / quantity, quantity };
}

module.exports = { getAvgCostPerShare };
