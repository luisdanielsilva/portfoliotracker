/**
 * The decision journal (#28): every trade, what it did to the average cost, the
 * alert that came before it, and what the decision is worth — plus every alert
 * that was not acted on, and what the price did afterwards.
 *
 * Asked for in the user's words: "later in time, I want to look back and be
 * able to understand if my decisions to buy or sell were good and how much I
 * earned/not lost with those or not."
 *
 * ONE CALCULATION. The average before and after each trade comes from
 * replayPosition().steps — the same walk that produces the figure dip alerts
 * fire against — and alerts are grouped by alertEpisodes(), the same grouping
 * the follow-through report uses. Nothing here re-derives either.
 *
 * HOW A DECISION IS SCORED. Positive always means the decision was good:
 *   buy   what those shares are worth − what they cost
 *   sale  what they were sold for − what those shares would be worth
 * each at two horizons, as the user chose: *today*, and *one year after the
 * trade* (the last close on or before that day; null until a year has passed).
 * Quantities are in today's share units and `prices` is split-adjusted, so a
 * 2019 TSLA sale is priced in the same units as a 2026 close. Euros throughout,
 * at each day's own rate — a cost basis is euros (README, currency model).
 *
 * WHAT IT CANNOT SEE, and the page has to say so: a trade after an alert is
 * correlation, not cause; `ts` is the date the user typed; and a sale is scored
 * against the shares, not against whatever the money did next.
 */
const { replayPosition } = require('./portfolio');
const { alertEpisodes, matchTrade, withDetail } = require('./alert-log');

const YEAR_MS = 365 * 864e5;

function priceSeries(db, ticker) {
  const rows = db.prepare(
    'SELECT price_date, price_eur, price_native, currency FROM prices WHERE ticker = ? AND price_eur IS NOT NULL ORDER BY price_date ASC'
  ).all(ticker);
  return {
    last: rows.length ? rows[rows.length - 1] : null,
    /** the last close on or before `date` (YYYY-MM-DD), by binary search */
    onOrBefore(date) {
      let lo = 0, hi = rows.length - 1, hit = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].price_date <= date) { hit = rows[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      return hit;
    }
  };
}

/** A decision valued at one close. Null when there is no close to value it at. */
function score(step, close) {
  if (!close) return null;
  const value = step.quantity * close.price_eur;
  const result = step.type === 'buy' ? value - step.amountEUR : step.amountEUR - value;
  return {
    date: close.price_date,
    priceEur: close.price_eur,
    valueEur: value,
    resultEur: result,
    resultPct: step.amountEUR ? result / step.amountEUR : null
  };
}

function episodeSummary(e) {
  return {
    alertType: e.alert_type, source: e.source, direction: e.direction,
    firstAt: e.firstAt, lastAt: e.lastAt, reminders: e.reminders,
    threshold: e.threshold, currency: e.currency,
    priceEur: e.price_eur, priceNative: e.price_native,
    avgCostEur: e.avg_cost_eur, basis: e.detail && e.detail.basis || null
  };
}

function decisionJournal(db, userId, { ticker = null, windowDays = 30, now = Date.now() } = {}) {
  const tickers = ticker ? [ticker] : db.prepare(`
    SELECT ticker FROM transactions WHERE user_id = ?
    UNION SELECT ticker FROM alert_events WHERE user_id = ? AND delivery = 'sent'
    ORDER BY ticker`).all(userId, userId).map(r => r.ticker);

  const oneYearOn = step => new Date(step.ts + YEAR_MS).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  const windowMs = windowDays * 864e5;

  const holdings = tickers.map(t => {
    const pos = replayPosition(db, userId, t);
    const prices = priceSeries(db, t);
    // only what reached the reader: an email that never left is not one they ignored
    const rows = db.prepare(
      "SELECT * FROM alert_events WHERE user_id = ? AND ticker = ? AND delivery = 'sent' ORDER BY fired_at ASC, id ASC"
    ).all(userId, t).map(withDetail);
    const episodes = alertEpisodes(rows);

    const txs = pos.steps.map(s => ({ id: s.id, ts: s.ts, tx_type: s.type }));
    const answeredBy = new Map();   // transaction id -> episodes it answered
    const unanswered = [];
    for (const e of episodes) {
      const hit = matchTrade(txs, e, windowMs);
      if (hit) {
        if (!answeredBy.has(hit.id)) answeredBy.set(hit.id, []);
        answeredBy.get(hit.id).push({ ...episodeSummary(e), daysToTrade: (hit.ts - e.firstMs) / 864e5 });
      } else {
        unanswered.push(e);
      }
    }

    const trades = pos.steps.map(s => {
      const yearDate = oneYearOn(s);
      return {
        id: s.id, date: s.date, ts: s.ts, type: s.type,
        quantity: s.quantity, amountEUR: s.amountEUR,
        pricePerShareEUR: s.quantity ? s.amountEUR / s.quantity : null,
        avgBefore: s.avgBefore, avgAfter: s.avgAfter,
        avgChangeEUR: s.avgBefore != null && s.avgAfter != null ? s.avgAfter - s.avgBefore : null,
        quantityBefore: s.quantityBefore, quantityAfter: s.quantityAfter,
        realisedGain: s.realisedGain,
        alerts: answeredBy.get(s.id) || [],
        today: score(s, prices.last),
        oneYear: yearDate <= today ? score(s, prices.onOrBefore(yearDate)) : null,
        oneYearDate: yearDate
      };
    });

    const ignored = unanswered.map(e => {
      const nowClose = prices.last;
      const startNative = e.price_native;
      const nowNative = nowClose ? nowClose.price_native : null;
      return {
        ...episodeSummary(e),
        priceNowNative: nowNative,
        priceNowEur: nowClose ? nowClose.price_eur : null,
        changeSincePct: startNative && nowNative != null ? nowNative / startNative - 1 : null,
        // still being reminded: the window to act has not closed yet
        open: now - e.lastMs <= windowMs
      };
    });

    const sum = (list, pick) => list.reduce((acc, x) => {
      const v = pick(x); return v == null ? acc : acc + v;
    }, 0);
    const buys = trades.filter(x => x.type === 'buy');
    const sells = trades.filter(x => x.type === 'sell');
    return {
      ticker: t,
      currency: prices.last ? prices.last.currency : null,
      quantity: pos.quantity,
      avgCostEUR: pos.quantity > 0 ? pos.totalAmount / pos.quantity : null,
      realisedEUR: pos.realised,
      priceNowEur: prices.last ? prices.last.price_eur : null,
      priceNowNative: prices.last ? prices.last.price_native : null,
      priceDate: prices.last ? prices.last.price_date : null,
      trades,
      ignored,
      totals: {
        buys: buys.length, sells: sells.length,
        buysToday: sum(buys, x => x.today && x.today.resultEur),
        sellsToday: sum(sells, x => x.today && x.today.resultEur),
        buysOneYear: sum(buys, x => x.oneYear && x.oneYear.resultEur),
        sellsOneYear: sum(sells, x => x.oneYear && x.oneYear.resultEur),
        lowered: buys.filter(x => x.avgChangeEUR != null && x.avgChangeEUR < 0).length,
        afterAlert: trades.filter(x => x.alerts.length).length,
        ignored: ignored.length
      }
    };
  });

  return { windowDays, holdings };
}

module.exports = { decisionJournal, score };
