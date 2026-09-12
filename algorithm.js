/**
 * Position-timing signal.
 *
 * Ranks a stock's closing price against its own trailing 6-month, 1-year and
 * 2-year history and flags the days where enough of those windows agree the
 * price is unusually high or low. Two lanes run side by side: a looser "Early"
 * lane that reacts to a short-window dip on its own, and a stricter "Confirmed"
 * lane that wants broader agreement.
 *
 * Implemented from a written specification. Where this file departs from it, it
 * says so in a comment and the reason is in README under "Algorithm tab".
 *
 * Pure functions of a price array throughout — no database, no clock — because
 * the thresholds here are the kind of thing that gets retuned, and retuning
 * without tests is guessing.
 */

/**
 * The active windows, in calendar days back from the evaluation date.
 *
 * A 5-year window was specified as tested and deliberately rejected: anchored to
 * a multi-year-old crash low it reads "High" almost permanently and never reaches
 * "Low", which biases the whole tool toward Sell. Do not add one back without
 * re-running the backtest that rejected it.
 */
const WINDOWS = [
  { key: '6M', days: 182, label: '6-month' },
  { key: '1Y', days: 365, label: '1-year' },
  { key: '2Y', days: 730, label: '2-year' }
];

/* Percentile cutoffs for the five regimes. */
const STRONG_HIGH = 95, HIGH = 80, LOW = 20, STRONG_LOW = 5;

const REGIME_WEIGHT = { Neutral: 0, High: 1, Low: 1, StrongHigh: 2, StrongLow: 2 };
const SELL_REGIMES = ['High', 'StrongHigh'];
const BUY_REGIMES = ['Low', 'StrongLow'];

/**
 * How many windows must agree, as a function of how many are active.
 *
 * The spec hardcodes "2 of 3" and asks that it scale with the window count if the
 * set ever becomes configurable. Two of three is two-thirds agreement, so that is
 * what generalises: at three windows these return exactly the specified 2, 1, 2.
 */
const agreementRules = (activeCount) => ({
  sell: Math.ceil(activeCount * 2 / 3),
  buyEarly: 1,
  buyConfirmed: Math.ceil(activeCount * 2 / 3)
});

/**
 * Percentile rank of `value` within `values`, counting a tie as half.
 *
 * The evaluation day's own close is part of its window, so a lone value ranks 50
 * rather than 0 or 100 — which is the right answer for "where does this sit among
 * everything I know", and the reason the tie term is not optional.
 */
function percentileRank(values, value) {
  if (!values.length) return null;
  let below = 0, equal = 0;
  for (const v of values) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return ((below + 0.5 * equal) / values.length) * 100;
}

function classify(pr) {
  if (pr === null) return null;
  if (pr >= STRONG_HIGH) return 'StrongHigh';
  if (pr >= HIGH) return 'High';
  if (pr <= STRONG_LOW) return 'StrongLow';
  if (pr <= LOW) return 'Low';
  return 'Neutral';
}

function tierFor(confidencePct) {
  if (confidencePct < 25) return 'Watch';
  if (confidencePct < 50) return 'Signal';
  if (confidencePct < 75) return 'Strong';
  return 'VeryStrong';
}

/**
 * Resolve one lane from the day's regimes.
 *
 * `minSell` / `minBuy` are how many windows must be in a high (or low) regime
 * before any of them count at all — below the bar the whole side is discarded
 * rather than scored weakly, which is what makes the two lanes differ.
 */
function resolveLane(regimes, minSell, minBuy) {
  const sell = WINDOWS.filter(w => SELL_REGIMES.includes(regimes[w.key]));
  const buy = WINDOWS.filter(w => BUY_REGIMES.includes(regimes[w.key]));

  const sellScore = sell.length >= minSell
    ? sell.reduce((sum, w) => sum + REGIME_WEIGHT[regimes[w.key]], 0) : 0;
  const buyScore = buy.length >= minBuy
    ? buy.reduce((sum, w) => sum + REGIME_WEIGHT[regimes[w.key]], 0) : 0;

  const maxPossible = 2 * WINDOWS.length;
  let direction = 'None', score = 0;
  if (sellScore > 0 && buyScore === 0) { direction = 'Sell'; score = sellScore; }
  else if (buyScore > 0 && sellScore === 0) { direction = 'Buy'; score = buyScore; }
  else if (sellScore > 0 && buyScore > 0) {
    // Both sides firing needs three windows to disagree sharply. It is close to
    // impossible with this window set; the case is kept so it cannot go unnoticed.
    direction = 'Mixed';
    score = Math.max(sellScore, buyScore);
  }

  const confidencePct = (score / maxPossible) * 100;
  return {
    direction,
    confidencePct,
    tier: direction === 'None' ? null : tierFor(confidencePct),
    sellScore, buyScore,
    windows: direction === 'Sell' ? sell.map(w => w.key)
      : direction === 'Buy' ? buy.map(w => w.key) : []
  };
}

/**
 * Score a whole series.
 *
 * `series` is ascending by date: [{date, close}, ...]. Every day is scored, but
 * a day whose windows are not yet fully populated is marked `complete: false` —
 * a 2-year rank computed off eight months of history is not the same statistic,
 * and the caller should not display it as though it were.
 */
function scoreSeries(series) {
  const rules = agreementRules(WINDOWS.length);
  const closes = series.map(p => p.close);
  const times = series.map(p => Date.parse(p.date));
  const firstTime = times[0];

  // One moving left edge per window: the series is sorted, so each edge only
  // ever advances. Recomputing the bound per day would make this quadratic.
  const edges = WINDOWS.map(() => 0);

  return series.map((point, i) => {
    const regimes = {}, percentiles = {}, complete = {};
    let allComplete = true;

    WINDOWS.forEach((w, wi) => {
      const cutoff = times[i] - w.days * 864e5;
      while (times[edges[wi]] <= cutoff) edges[wi]++;   // window is (d - days, d]
      const values = closes.slice(edges[wi], i + 1);
      const pr = percentileRank(values, closes[i]);
      percentiles[w.key] = pr;
      regimes[w.key] = classify(pr);
      complete[w.key] = firstTime <= cutoff;
      if (!complete[w.key]) allComplete = false;
    });

    return {
      date: point.date,
      close: point.close,
      percentiles,
      regimes,
      complete: allComplete,
      early: resolveLane(regimes, rules.sell, rules.buyEarly),
      confirmed: resolveLane(regimes, rules.sell, rules.buyConfirmed)
    };
  });
}

/**
 * Contiguous stretches where one lane held a direction at Signal tier or better.
 *
 * "Contiguous" means consecutive scored trading days: a weekend does not break a
 * run, a day that drops below the tier does.
 */
function findRuns(scored, laneKey, direction, minConfidence = 25) {
  const runs = [];
  let current = null;
  for (const day of scored) {
    const lane = day[laneKey];
    const inRun = lane.direction === direction && lane.confidencePct >= minConfidence;
    if (inRun) {
      if (!current) current = { start: day.date, startClose: day.close, days: 0, peakConfidence: 0 };
      current.end = day.date;
      current.endClose = day.close;
      current.days++;
      current.peakConfidence = Math.max(current.peakConfidence, lane.confidencePct);
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }
  if (current) runs.push(current);
  return runs.reverse();     // most recent first
}

/* ------------------------------------------------------------------ *
 * Step 6 — the position gate                                          *
 * ------------------------------------------------------------------ */

/**
 * Default gain/loss gates. Exposed rather than inlined because the spec is
 * explicit that these express the user's own risk tolerance, not a fact about
 * markets.
 */
const DEFAULT_GATES = {
  strongHighGainPct: 20,    // trim only once this far ahead
  highGainPct: 30,          // a weaker high reading asks for more profit first
  lowLossPct: -10,          // add only once this far underwater
  strongLowLossPct: -20
};

/**
 * Turn a day's signal plus the actual position into a suggested action.
 *
 * The specification's matrix is per-window; a lane aggregates several windows, so
 * the row is chosen by the strongest regime among the windows that actually
 * fired. A Strong reading anywhere in the agreeing set is what makes it a strong
 * signal, and it is the row with the lower profit requirement.
 *
 * Returns `gateMet: false` with the reason when the price agrees but the position
 * does not — which is information, not silence: it is the difference between "not
 * a good moment" and "a good moment you are not positioned for".
 */
function applyPositionGate(day, position, gates = DEFAULT_GATES) {
  const lane = day.early;
  if (!position || !(position.avgCost > 0) || !(position.shares > 0)) {
    return { applicable: false, reason: 'no position on record' };
  }

  const gainPct = ((position.price - position.avgCost) / position.avgCost) * 100;
  const gainAbs = (position.price - position.avgCost) * position.shares;
  const base = { applicable: true, gainPct, gainAbs };

  if (lane.direction !== 'Buy' && lane.direction !== 'Sell') {
    return { ...base, gateMet: false, action: 'Hold', reason: 'no signal today' };
  }

  const firing = lane.windows.map(k => day.regimes[k]);
  const strong = firing.includes('StrongHigh') || firing.includes('StrongLow');

  if (lane.direction === 'Sell') {
    const need = strong ? gates.strongHighGainPct : gates.highGainPct;
    return {
      ...base, need,
      gateMet: gainPct >= need,
      action: strong ? 'Sell / trim' : 'Consider partial trim',
      reason: gainPct >= need
        ? `up ${gainPct.toFixed(1)}%, past the ${need}% you asked for`
        : `only up ${gainPct.toFixed(1)}% — you set ${need}% before trimming`
    };
  }

  const need = strong ? gates.strongLowLossPct : gates.lowLossPct;
  return {
    ...base, need,
    gateMet: gainPct <= need,
    action: strong ? 'Buy / accumulate' : 'Consider adding (small)',
    reason: gainPct <= need
      ? `down ${Math.abs(gainPct).toFixed(1)}%, past the ${Math.abs(need)}% you asked for`
      : `${gainPct >= 0 ? 'up' : 'down'} ${Math.abs(gainPct).toFixed(1)}% — you set ${need}% before adding`
  };
}

module.exports = {
  WINDOWS, REGIME_WEIGHT, DEFAULT_GATES,
  STRONG_HIGH, HIGH, LOW, STRONG_LOW,
  percentileRank, classify, tierFor, resolveLane, scoreSeries, findRuns,
  applyPositionGate, agreementRules
};
