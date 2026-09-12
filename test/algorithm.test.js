/**
 * The position-timing signal. Every threshold here came from a written spec, which
 * means the tests are the only thing standing between a retune and a silent change
 * of meaning — the numbers look arbitrary precisely because they were chosen, so
 * each one is pinned deliberately.
 */
const test = require('node:test');
const assert = require('node:assert');
const A = require('../algorithm.js');

/* ---------- percentile rank ---------- */

test('percentile rank counts ties as half', () => {
  assert.strictEqual(A.percentileRank([1, 2, 3, 4], 3), 62.5);   // 2 below, 1 equal
  assert.strictEqual(A.percentileRank([10, 10, 10], 10), 50);    // all tied is the middle
  assert.strictEqual(A.percentileRank([5, 6, 7], 1), 0);
  assert.strictEqual(A.percentileRank([5, 6, 7], 9), 100);
  assert.strictEqual(A.percentileRank([], 1), null);
});

/* ---------- regimes ---------- */

test('regime cutoffs are inclusive on the strong side', () => {
  assert.strictEqual(A.classify(95), 'StrongHigh');
  assert.strictEqual(A.classify(94.9), 'High');
  assert.strictEqual(A.classify(80), 'High');
  assert.strictEqual(A.classify(79.9), 'Neutral');
  assert.strictEqual(A.classify(20.1), 'Neutral');
  assert.strictEqual(A.classify(20), 'Low');
  assert.strictEqual(A.classify(5.1), 'Low');
  assert.strictEqual(A.classify(5), 'StrongLow');
});

test('confidence tiers break where the spec says', () => {
  assert.strictEqual(A.tierFor(24.9), 'Watch');
  assert.strictEqual(A.tierFor(25), 'Signal');
  assert.strictEqual(A.tierFor(49.9), 'Signal');
  assert.strictEqual(A.tierFor(50), 'Strong');
  assert.strictEqual(A.tierFor(74.9), 'Strong');
  assert.strictEqual(A.tierFor(75), 'VeryStrong');
});

/* ---------- the two lanes ---------- */

const regimes = (a, b, c) => ({ '6M': a, '1Y': b, '2Y': c });

test('sell needs two windows in both lanes', () => {
  const one = regimes('High', 'Neutral', 'Neutral');
  assert.strictEqual(A.resolveLane(one, 2, 1).direction, 'None');
  assert.strictEqual(A.resolveLane(one, 2, 2).direction, 'None');

  const two = regimes('High', 'High', 'Neutral');
  assert.strictEqual(A.resolveLane(two, 2, 1).direction, 'Sell');
  assert.strictEqual(A.resolveLane(two, 2, 2).direction, 'Sell');
});

test('buy fires on one window in the early lane and needs two in the confirmed lane', () => {
  // The asymmetry the whole two-lane design exists for: a dip appears in the
  // short window first while the long ones are still anchored to a run-up.
  const dip = regimes('StrongLow', 'Neutral', 'Neutral');
  assert.strictEqual(A.resolveLane(dip, 2, 1).direction, 'Buy');
  assert.strictEqual(A.resolveLane(dip, 2, 2).direction, 'None');
});

test('confidence is the agreeing weight over the maximum possible', () => {
  // one plain Low of a possible 2 x 3 = 6
  assert.strictEqual(Math.round(A.resolveLane(regimes('Low', 'Neutral', 'Neutral'), 2, 1).confidencePct), 17);
  // two strong lows = 4/6
  assert.strictEqual(Math.round(A.resolveLane(regimes('StrongLow', 'StrongLow', 'Neutral'), 2, 2).confidencePct), 67);
  // everything strong high = 6/6
  const all = A.resolveLane(regimes('StrongHigh', 'StrongHigh', 'StrongHigh'), 2, 2);
  assert.strictEqual(all.confidencePct, 100);
  assert.strictEqual(all.tier, 'VeryStrong');
});

test('a side below its agreement bar is discarded, not scored weakly', () => {
  // One High and two Lows: the sell side has one window and needs two, so it is
  // dropped entirely rather than competing with the buy side.
  const mixed = regimes('High', 'Low', 'Low');
  const lane = A.resolveLane(mixed, 2, 2);
  assert.strictEqual(lane.sellScore, 0);
  assert.strictEqual(lane.direction, 'Buy');
});

test('both sides firing is reported as Mixed rather than silently resolved', () => {
  const lane = A.resolveLane(regimes('High', 'High', 'Low'), 2, 1);
  assert.strictEqual(lane.direction, 'Mixed');
  assert.strictEqual(lane.sellScore, 2);
  assert.strictEqual(lane.buyScore, 1);
});

test('agreement rules generalise to other window counts', () => {
  assert.deepStrictEqual(A.agreementRules(3), { sell: 2, buyEarly: 1, buyConfirmed: 2 });
  assert.deepStrictEqual(A.agreementRules(4), { sell: 3, buyEarly: 1, buyConfirmed: 3 });
});

/* ---------- scoring a series ---------- */

function series(n, fn, startDate = '2020-01-01') {
  const out = [];
  const t0 = Date.parse(startDate);
  for (let i = 0; i < n; i++) {
    out.push({ date: new Date(t0 + i * 864e5).toISOString().slice(0, 10), close: fn(i) });
  }
  return out;
}

test('a day is incomplete until every window has the history it claims', () => {
  const scored = A.scoreSeries(series(900, i => 100 + i));
  assert.strictEqual(scored[0].complete, false);
  assert.strictEqual(scored[400].complete, false, '400 days is not yet two years');
  assert.strictEqual(scored[899].complete, true);
});

test('a price at a new high ranks at the top of every window', () => {
  const scored = A.scoreSeries(series(900, i => 100 + i));   // strictly rising
  const last = scored[scored.length - 1];
  assert.strictEqual(last.regimes['6M'], 'StrongHigh');
  assert.strictEqual(last.regimes['1Y'], 'StrongHigh');
  assert.strictEqual(last.regimes['2Y'], 'StrongHigh');
  assert.strictEqual(last.early.direction, 'Sell');
  assert.strictEqual(last.early.confidencePct, 100);
});

test('a price at a new low ranks at the bottom of every window', () => {
  const scored = A.scoreSeries(series(900, i => 1000 - i));
  const last = scored[scored.length - 1];
  assert.strictEqual(last.regimes['2Y'], 'StrongLow');
  assert.strictEqual(last.early.direction, 'Buy');
  assert.strictEqual(last.confirmed.direction, 'Buy');
});

test('the window is open at the far end and closed at the near one', () => {
  // Flat except for the evaluation day, so the rank depends only on how many
  // days are inside the window — which is what the boundary decides.
  const s = A.scoreSeries(series(400, i => (i === 399 ? 200 : 100)));
  const last = s[399];
  // 182 calendar days back, exclusive: the day exactly 182 days earlier is out.
  assert.strictEqual(last.percentiles['6M'], (181 + 0.5) / 182 * 100);
});

/* ---------- runs ---------- */

test('runs are contiguous, tier-gated and most recent first', () => {
  const scored = [
    { date: '2026-01-01', close: 1, early: { direction: 'Buy', confidencePct: 50 } },
    { date: '2026-01-02', close: 2, early: { direction: 'Buy', confidencePct: 50 } },
    { date: '2026-01-03', close: 3, early: { direction: 'None', confidencePct: 0 } },
    { date: '2026-01-04', close: 4, early: { direction: 'Buy', confidencePct: 17 } },  // Watch: below the bar
    { date: '2026-01-05', close: 5, early: { direction: 'Buy', confidencePct: 33 } }
  ];
  const runs = A.findRuns(scored, 'early', 'Buy');
  assert.strictEqual(runs.length, 2);
  assert.strictEqual(runs[0].start, '2026-01-05', 'most recent first');
  assert.strictEqual(runs[1].days, 2);
  assert.strictEqual(runs[1].startClose, 1);
  assert.strictEqual(runs[1].endClose, 2);
  assert.strictEqual(runs[1].peakConfidence, 50);
});

/* ---------- the position gate ---------- */

const dayWith = (dir, windows, regimeMap) => ({
  regimes: regimeMap,
  early: { direction: dir, windows, confidencePct: 50 }
});

test('a sell is gated on profit, and a strong reading asks for less of it', () => {
  const strong = dayWith('Sell', ['6M', '1Y'], { '6M': 'StrongHigh', '1Y': 'High' });
  const plain = dayWith('Sell', ['6M', '1Y'], { '6M': 'High', '1Y': 'High' });

  // +25%: past the 20% a strong high wants, short of the 30% a plain one wants
  const pos = { shares: 10, avgCost: 100, price: 125 };
  assert.strictEqual(A.applyPositionGate(strong, pos).gateMet, true);
  assert.strictEqual(A.applyPositionGate(strong, pos).action, 'Sell / trim');
  assert.strictEqual(A.applyPositionGate(plain, pos).gateMet, false);
  assert.strictEqual(A.applyPositionGate(plain, pos).need, 30);
});

test('a buy is gated on being underwater', () => {
  const strong = dayWith('Buy', ['6M', '1Y'], { '6M': 'StrongLow', '1Y': 'Low' });
  const plain = dayWith('Buy', ['6M', '1Y'], { '6M': 'Low', '1Y': 'Low' });

  const down15 = { shares: 10, avgCost: 100, price: 85 };
  assert.strictEqual(A.applyPositionGate(plain, down15).gateMet, true, '-15% clears the -10% bar');
  assert.strictEqual(A.applyPositionGate(strong, down15).gateMet, false, 'a strong low wants -20%');

  const up = { shares: 10, avgCost: 100, price: 120 };
  assert.strictEqual(A.applyPositionGate(plain, up).gateMet, false, 'never "add" while in profit');
});

test('the gates are parameters, not facts about markets', () => {
  const day = dayWith('Sell', ['6M', '1Y'], { '6M': 'High', '1Y': 'High' });
  const pos = { shares: 10, avgCost: 100, price: 110 };
  assert.strictEqual(A.applyPositionGate(day, pos).gateMet, false);
  assert.strictEqual(A.applyPositionGate(day, pos, { ...A.DEFAULT_GATES, highGainPct: 5 }).gateMet, true);
});

test('no position means the gate reports itself inapplicable rather than guessing', () => {
  const day = dayWith('Sell', ['6M'], { '6M': 'High' });
  assert.strictEqual(A.applyPositionGate(day, null).applicable, false);
  assert.strictEqual(A.applyPositionGate(day, { shares: 0, avgCost: 0, price: 10 }).applicable, false);
});
