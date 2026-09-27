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
 * One transaction applied to a running position — the average-cost method.
 *
 * A buy adds its shares and what they cost. A sale removes shares *at the
 * current average*, so it never moves the average of what is left; the gap
 * between the proceeds and the cost removed is realised gain, kept separately.
 * A position that reaches zero starts again from nothing.
 *
 * This replaced subtracting a sale's proceeds from the cost (#26). That made
 * every profitable sale lower the average, and let a closed position's profit
 * ride on as negative cost into the next one: TSLA, sold out in 2019 and bought
 * back in April 2020 at €44.86, read €10.65 a share, and still read €95.80
 * against a true €108.90 six years later. The same subtraction had already been
 * caught once at the portfolio total (README, closed positions in costBasis);
 * inside one ticker's history it survived until this.
 *
 * `pos` is {quantity, cost, realised}, mutated in place. `quantity` must already
 * be in current share units (every split after the trade applied).
 */
const EPSILON = 1e-9;   // what is left of 1/3 × 3 after floating point

function applyTransaction(pos, type, quantity, amountEUR) {
  if (type === 'buy') {
    pos.quantity += quantity;
    pos.cost += amountEUR;
  } else if (type === 'sell') {
    const held = Math.max(pos.quantity, 0);
    const avg = held > EPSILON ? pos.cost / held : 0;
    // shares sold beyond what was held have no recorded cost to take out
    const removed = avg * Math.min(quantity, held);
    pos.realised += amountEUR - removed;
    pos.quantity -= quantity;
    pos.cost -= removed;
  }
  if (pos.quantity <= EPSILON) { pos.quantity = 0; pos.cost = 0; }
  return pos;
}

function newPosition() {
  return { quantity: 0, cost: 0, realised: 0 };
}

/**
 * Walk one position's transactions once, in order.
 *
 * Extracted so that "what is it worth now" and "what was it worth while it was
 * still held" cannot disagree. This file exists because two copies of this
 * arithmetic already drifted apart once; a second reader of the same rows would
 * have been the same mistake in a new place.
 *
 * `lastHeld` is the answer as of the last transaction that left anything held —
 * which, for a position that has since been closed, is the average cost of the
 * shares it held last.
 *
 * `steps` is the same walk, one entry per transaction, with the average before
 * and after it — what the decision journal reads, so that the journal and the
 * figure alerts fire against are one calculation.
 */
function replayPosition(db, userId, ticker) {
  const rows = db.prepare(`
    SELECT id, tx_type, quantity, amount_eur, ts, date(ts/1000,'unixepoch') AS tx_date
    FROM transactions
    WHERE user_id = ? AND ticker = ? ORDER BY ts ASC, id ASC
  `).all(userId, ticker);

  // A split changes how many shares the same money bought. One share at €600 that
  // later splits 3-for-1 is three shares at €200 — the position is unchanged, but
  // per-share cost is not. Ignoring splits overstated the average cost by the split
  // ratio and reported a share count that disagreed with the portfolio chart, and
  // that figure is what dip alerts fire against.
  const splits = db.prepare(
    'SELECT split_date, ratio FROM stock_splits WHERE ticker = ? ORDER BY split_date ASC'
  ).all(ticker);

  const pos = newPosition();
  const avgOf = () => (pos.quantity > 0 ? pos.cost / pos.quantity : null);
  let lastHeld = null;
  const steps = [];
  for (const tx of rows) {
    // express every transaction in today's share terms: multiply by each split
    // that happened after it was bought
    let qty = tx.quantity;
    for (const split of splits) {
      if (tx.tx_date < split.split_date) qty *= split.ratio;
    }

    const avgBefore = avgOf();
    const quantityBefore = pos.quantity;
    const realisedBefore = pos.realised;
    applyTransaction(pos, tx.tx_type, qty, tx.amount_eur);
    if (pos.quantity > 0) lastHeld = { avgCostEUR: pos.cost / pos.quantity, quantity: pos.quantity };

    steps.push({
      id: tx.id, type: tx.tx_type, ts: tx.ts, date: tx.tx_date,
      quantity: qty, amountEUR: tx.amount_eur,
      avgBefore, avgAfter: avgOf(),
      quantityBefore, quantityAfter: pos.quantity,
      realisedGain: tx.tx_type === 'sell' ? pos.realised - realisedBefore : null
    });
  }

  return {
    quantity: pos.quantity, totalAmount: pos.cost, realised: pos.realised,
    lastHeld, steps, transactionCount: rows.length
  };
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

module.exports = { getAvgCostPerShare, lastHeldAvgCost, replayPosition, applyTransaction, newPosition };
