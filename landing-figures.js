#!/usr/bin/env node
/**
 * The landing page's charts, drawn from real price history.
 *
 *   node landing-figures.js [--check]
 *
 * Every figure a logged-out visitor sees used to be a hand-drawn polyline: twelve
 * points across four years, each landing on a tidy number. Nothing moves like
 * that, and the first thing this page does is ask a stranger to trust it with
 * numbers — so the prices here are real closes, fetched from the same source the
 * app itself uses, and only the buyer is invented. The captions say which is
 * which, because "example data" on a page about being honest with figures is the
 * weakest sentence on it.
 *
 * The script owns everything between the `figure:<id>:start` and `figure:<id>:end`
 * markers in index.html and rewrites it in place. `--check` regenerates without
 * writing and reports whether the file is up to date, which is what CI would run
 * if this ever needs pinning.
 *
 * Windows were not picked for looks. Each one is the shape its figure has to
 * teach, verified before it was chosen:
 *
 *   dip    SPY   2020-01-02 -> 2020-06-30   -31.4% to the trough, back to -5.1%
 *   rules  AMD   2023-07-13 -> 2024-09-18   +82% to the peak, then -30% off it
 *   folio  TSLA/MSFT/AMD  2022-01-03 -> now  a real drawdown and a real recovery
 *
 * If a window is changed, re-read the figure's annotations: they are computed,
 * but the prose around them is not.
 */

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, 'index.html');

/* ----------------------------------------------------------------- data */

function yahoo() {
  const YahooFinance = require('yahoo-finance2').default;
  return new YahooFinance({ suppressNotices: ['yahooSurvey'] });
}

/** Daily closes, oldest first. Historical closes do not change, so no cache. */
async function series(yf, symbol, from, to) {
  const res = await yf.chart(symbol, { period1: from, period2: to, interval: '1d' });
  const out = res.quotes
    .filter(q => q.close != null && q.date)
    .map(q => ({ d: q.date.toISOString().slice(0, 10), c: q.close }));
  if (out.length < 30) throw new Error(`${symbol}: only ${out.length} closes for ${from}..${to}`);
  return out;
}

/**
 * Euros per dollar, by date, with gaps filled backwards.
 *
 * The same rule the importer uses: a trade on a day the rate table skips takes
 * the last rate before it, never the next one, because that is the rate that
 * existed at the time.
 */
async function usdToEur(yf, from, to) {
  const raw = await series(yf, 'EURUSD=X', from, to);
  const byDate = new Map(raw.map(r => [r.d, 1 / r.c]));
  let last = 1 / raw[0].c;
  return date => {
    if (byDate.has(date)) { last = byDate.get(date); return last; }
    return last;                       // weekend, holiday, or a day the feed skipped
  };
}

/* -------------------------------------------------------------- drawing */

/** A 1/2/5 x 10^n ladder, the same shape the app's own axes use. */
function niceTicks(lo, hi, target) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= target) || 10 * mag;
  const first = Math.ceil(lo / step) * step;
  const ticks = [];
  for (let v = first; v <= hi + step * 1e-9; v += step) ticks.push(parseFloat(v.toFixed(10)));
  return ticks;
}

/** A plot box, and the two functions that put a value inside it. */
function box({ x0, x1, y0, y1, lo, hi, n }) {
  const pad = (hi - lo) * 0.08 || 1;
  const min = lo - pad, max = hi + pad;
  return {
    min, max, x0, x1, y0, y1,
    x: i => x0 + (x1 - x0) * (n === 1 ? 0 : i / (n - 1)),
    y: v => y1 - (y1 - y0) * ((v - min) / (max - min)),
    ticks: (count = 5) => niceTicks(min, max, count)
  };
}

const r1 = n => Math.round(n * 10) / 10;

/** A polyline through every point, rounded so the file does not carry noise it cannot draw. */
function line(values, b) {
  return values.map((v, i) => `${i ? 'L' : 'M'}${r1(b.x(i))},${r1(b.y(v))}`).join(' ');
}

/** A step function: holds its value until it changes, which is how invested capital moves. */
function steps(values, b) {
  let d = `M${r1(b.x(0))},${r1(b.y(values[0]))}`;
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[i - 1]) d += ` H${r1(b.x(i))} V${r1(b.y(values[i]))}`;
  }
  return d + ` H${r1(b.x(values.length - 1))}`;
}

/** The band between two series, as a closed path. */
function band(upper, lower, b) {
  const down = upper.map((v, i) => `${i ? 'L' : 'M'}${r1(b.x(i))},${r1(b.y(v))}`).join(' ');
  const back = [];
  for (let i = lower.length - 1; i >= 0; i--) back.push(`L${r1(b.x(i))},${r1(b.y(lower[i]))}`);
  return `${down} ${back.join(' ')} Z`;
}

const gridlines = (b, ticks) =>
  ticks.map(t => `<line class="gridline" x1="${b.x0}" y1="${r1(b.y(t))}" x2="${b.x1}" y2="${r1(b.y(t))}"></line>`).join('\n        ');

const money = n => '&euro;' + Math.round(n).toLocaleString('en-US');
// Prices under 100 keep both decimals: "EUR 68.6" reads as a measurement, "EUR 68.60" as money.
const money1 = n => '&euro;' + (n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US'));

/**
 * Evenly spaced indices into a series of `len` points, always including the last.
 *
 * Even spacing is the point: x is derived from position in the sampled array, so
 * an uneven sample would stretch and squash time without saying so.
 */
function thinIndices(len, n) {
  if (len <= n) return Array.from({ length: len }, (_, i) => i);
  const step = (len - 1) / (n - 1);
  const idx = [];
  for (let i = 0; i < n - 1; i++) idx.push(Math.round(i * step));
  idx.push(len - 1);
  return idx;
}

/** Sample a series down to at most n points, always keeping the last one. */
function thin(arr, n) {
  return thinIndices(arr.length, n).map(i => arr[i]);
}

/** Where a full-series index lands once the series has been sampled. */
function nearestSampled(idx, sampled) {
  let best = 0, bestGap = Infinity;
  for (let i = 0; i < sampled.length; i++) {
    const gap = Math.abs(sampled[i] - idx);
    if (gap < bestGap) { bestGap = gap; best = i; }
  }
  return best;
}

/**
 * Where a label fits.
 *
 * A hand-drawn figure leaves room for its own annotations; a real price series
 * does not, and three labels here landed straight on the lines they describe.
 * So the gap is measured: over a range of candidate positions, take the one
 * where the two lines are furthest apart and put the text between them.
 */
function widestGap(above, below, from, to, halfSpan = 0) {
  // Scored across the label's own width, not at its midpoint: a centre with
  // daylight above it is no use when the end of the sentence runs into the line.
  let best = from, bestGap = -Infinity;
  for (let i = Math.max(0, from); i <= Math.min(above.length - 1, to); i++) {
    let worst = Infinity;
    for (let j = Math.max(0, i - halfSpan); j <= Math.min(above.length - 1, i + halfSpan); j++) {
      worst = Math.min(worst, above[j] - below[j]);
    }
    if (worst > bestGap) { bestGap = worst; best = i; }
  }
  return best;
}

/** Half a label's width, in series indices — 11.5px text is about 5.6 units a character. */
function halfLabel(text, b, n) {
  return Math.round((text.length * 5.6 / 2) / (b.x1 - b.x0) * (n - 1));
}

/**
 * The wrapper every figure wears.
 *
 * A casual scroller reads three things in this order: the headline, the source,
 * and one line under the chart. So the headline carries the payoff in numbers
 * rather than naming the mechanism, the source names the ticker and the dates
 * where they can be seen instead of in small print, and the takeaway is one
 * sentence. Everything else — provenance, caveats, the honest awkward detail —
 * goes behind a toggle, which is there for the reader who wants it and out of
 * the way of the one who does not.
 */
function figureHead(headline, source, dates) {
  return `<h3 class="lp-fig-h">${headline}</h3>
      <p class="lp-fig-src"><b>${source}</b> &middot; ${dates} <span class="real">real closes</span></p>`;
}

function figureFoot(takeaway, detail) {
  return `<figcaption>${takeaway}</figcaption>
      <details class="lp-fig-more"><summary>Where these numbers come from</summary><p>${detail}</p></details>`;
}

/* -------------------------------------------------------------- figures */

/**
 * What one buy on the dip does.
 *
 * SPY through the 2020 crash: a third off the top and most of the way back. The
 * second purchase is the invented part, placed at the trough — which is the
 * flattering assumption, and the figure says so rather than pretending the
 * reader would have timed it.
 */
function dipFigure(spy) {
  const base = spy[0].c;
  const px = spy.map(p => ({ d: p.d, v: 100 * p.c / base }));
  const values = px.map(p => p.v);
  const troughIdx = values.indexOf(Math.min(...values));
  const first = values[0], second = values[troughIdx], last = values[values.length - 1];
  const avg = (first + second) / 2;

  const b = box({ x0: 70, x1: 790, y0: 40, y1: 250, lo: Math.min(...values), hi: Math.max(...values, 100), n: values.length });
  const ticks = b.ticks(5);
  const avgLine = values.map((_, i) => (i < troughIdx ? first : avg));

  const svg = `<svg viewBox="0 0 900 300" role="img" aria-label="Real chart: SPY, the S&amp;P 500 tracker, from January to June 2020, rebased to 100 euros. The price falls ${Math.round(100 - second)} percent to ${Math.round(second)}, where a second purchase of the same size drops the average cost to ${Math.round(avg)} euros. It ends at ${Math.round(last)}, a profit against that average and still a loss against the original 100.">
      <g>
        ${gridlines(b, ticks)}
      </g>
      <!-- the price range made profitable by the second buy: bounded above by the
           old break-even at EUR 100, below by the new average cost -->
      <rect x="${r1(b.x(troughIdx))}" y="${r1(b.y(first))}" width="${r1(b.x1 - b.x(troughIdx))}" height="${r1(b.y(avg) - b.y(first))}" fill="var(--accent-soft)"></rect>
      <g class="axislbl" text-anchor="end" dominant-baseline="middle">
        ${ticks.map(t => `<text x="60" y="${r1(b.y(t))}">${money(t)}</text>`).join('\n        ')}
      </g>
      <g class="xlbl">
        <text x="${b.x0}" y="272">Jan 2020 &middot; first buy</text>
        <text x="${r1(b.x(troughIdx))}" y="272">23 Mar &middot; the dip</text>
        <text x="${b.x1}" y="272">30 Jun</text>
      </g>
      <path d="${steps(avgLine, b)}" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="4 3"></path>
      <path class="serieline" d="${line(values, b)}" stroke="var(--s-total)"></path>
      <g class="buyring" stroke="var(--s-total)">
        <circle cx="${b.x0}" cy="${r1(b.y(first))}" r="4.5"></circle>
        <circle cx="${r1(b.x(troughIdx))}" cy="${r1(b.y(second))}" r="4.5"></circle>
      </g>
      <g style="font-size:11.5px;font-family:'IBM Plex Sans',system-ui,sans-serif" fill="var(--muted)">
        <text x="84" y="${r1(b.y(first) - 14)}">Bought 10 @ ${money(first)}</text>
        <text x="${r1(b.x(troughIdx) + 10)}" y="${r1(b.y(second) + 20)}">Bought 10 more @ ${money1(second)}</text>
        <text x="${r1(b.x(troughIdx) + 15)}" y="${r1(b.y(first) + 19)}" fill="var(--accent)">Profit at ${money(avg)}. At ${money(first)} this was still a loss.</text>
      </g>
      <g class="endlbl">
        <text x="798" y="${r1(b.y(last))}" fill="var(--s-total)">${money1(last)}</text>
        <text x="798" y="${r1(b.y(avg))}" fill="var(--faint)">${money(avg)}</text>
      </g>
      <g style="font-size:10px;font-family:'IBM Plex Sans',system-ui,sans-serif">
        <text x="798" y="${r1(b.y(last) + 13)}" fill="var(--muted)">price at the end</text>
        <text x="798" y="${r1(b.y(avg) + 13)}" fill="var(--faint)">your average</text>
      </g>
    </svg>`;

  const head = figureHead(`Down ${Math.round(100 - second)}%, and still in profit`,
                          'SPY &mdash; the S&amp;P 500', 'Jan &ndash; Jun 2020');

  const key = `<p class="lp-fig-key">
      <span><i style="background:var(--s-total)"></i>Price</span>
      <span><i class="dash"></i>Average cost <b>${money(first)} &rarr; ${money(avg)}</b></span>
    </p>`;

  const foot = figureFoot(
    `Ten shares at ${money(first)}, ten more at the bottom. Break-even falls to <b>${money(avg)}</b> &mdash; so ${money1(last)} is a profit, where against ${money(first)} it is still a loss.`,
    `${spy.length} daily closes, rebased so the first is ${money(first)}. The two purchases are the illustration and the second sits at the very bottom, which nobody manages on purpose &mdash; a worse entry still works, it just moves the shaded band, which is the range where that second buy decides between a profit and a loss.`);

  return { head, key, svg, foot, facts: { first, second, avg, last, n: spy.length } };
}

/**
 * What a rule near the top does.
 *
 * AMD from July 2023: +82% into the March 2024 peak, then 30% off it. A target
 * tied to cost fires on the way up and is then overtaken; a trailing rule climbs
 * behind the price and fires when the run breaks. That is the honest version of
 * this picture — the target sells early, and the figure does not hide it.
 */
function rulesFigure(amd) {
  const base = amd[0].c;
  const values = amd.map(p => 100 * p.c / base);
  const avgCost = 88;                                   // averaged in before this window
  const target = avgCost * 1.75;                        // the app's +75% rule
  const TRAIL = 0.20;

  const runMax = [];
  values.reduce((m, v) => { const x = Math.max(m, v); runMax.push(x); return x; }, values[0]);
  const trail = runMax.map(m => m * (1 - TRAIL));

  const targetIdx = values.findIndex(v => v >= target);
  const peakIdx = values.indexOf(Math.max(...values));
  const breakIdx = values.findIndex((v, i) => i > peakIdx && v <= trail[i]);
  const last = values[values.length - 1];

  const b = box({ x0: 70, x1: 790, y0: 40, y1: 250,
                  lo: Math.min(...values, avgCost), hi: Math.max(...values), n: values.length });
  const ticks = b.ticks(5);

  // the widest daylight between the price and the trailing level, on the way up
  const breakText = 'the run breaks \u2014 emailed here';
  // and, after the break, where the price stays furthest below the band
  const bandMiddle = (values[peakIdx] + trail[peakIdx]) / 2;
  const breakLabelIdx = widestGap(values.map(() => bandMiddle), values, breakIdx + 5, values.length - 20,
                                  halfLabel(breakText, b, values.length));

  const svg = `<svg viewBox="0 0 900 300" role="img" aria-label="Real chart: AMD from July 2023 to September 2024, rebased to 100 euros. Averaged in at ${avgCost} euros, it runs ${Math.round(values[peakIdx] - 100)} percent above the starting point to a peak of ${Math.round(values[peakIdx])}. A take-profit rule 75 percent above cost fires at ${Math.round(target)} on the way up. A trailing rule 20 percent below the stock's own high climbs behind the price and fires at ${Math.round(trail[breakIdx])} when the run breaks.">
      <g>
        ${gridlines(b, ticks)}
      </g>
      <!-- what the stock is allowed to give back from its peak before the trailing
           rule says the run has broken -->
      <rect x="${r1(b.x(peakIdx))}" y="${r1(b.y(values[peakIdx]))}" width="${r1(b.x1 - b.x(peakIdx))}" height="${r1(b.y(trail[peakIdx]) - b.y(values[peakIdx]))}" fill="rgba(192,71,62,.10)"></rect>
      <g class="axislbl" text-anchor="end" dominant-baseline="middle">
        ${ticks.map(t => `<text x="60" y="${r1(b.y(t))}">${money(t)}</text>`).join('\n        ')}
      </g>
      <g class="xlbl">
        <text x="${b.x0}" y="272">Jul 2023</text>
        <text x="${r1(b.x(peakIdx))}" y="272">7 Mar 2024 &middot; the peak</text>
        <text x="${b.x1}" y="272">Sep 2024</text>
      </g>
      <!-- your average cost: flat, because it only moves when you trade -->
      <path d="M${b.x0},${r1(b.y(avgCost))} H${b.x1}" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="4 3"></path>
      <!-- take-profit level: +75% on that average -->
      <path d="M${b.x0},${r1(b.y(target))} H${b.x1}" fill="none" stroke="var(--s-tsla)" stroke-width="1.5" stroke-dasharray="7 4"></path>
      <!-- trailing level: 20% under the highest price so far, so it climbs in steps -->
      <path d="${steps(trail, b)}" fill="none" stroke="var(--neg)" stroke-width="1.5"></path>
      <path class="serieline" d="${line(values, b)}" stroke="var(--s-total)"></path>
      <g class="buyring" stroke="var(--s-tsla)">
        <circle cx="${r1(b.x(targetIdx))}" cy="${r1(b.y(values[targetIdx]))}" r="4.5"></circle>
      </g>
      <g class="buyring" stroke="var(--neg)">
        <circle cx="${r1(b.x(breakIdx))}" cy="${r1(b.y(values[breakIdx]))}" r="4.5"></circle>
      </g>
      <g style="font-size:11.5px;font-family:'IBM Plex Sans',system-ui,sans-serif" fill="var(--muted)">
        <text x="${r1(b.x(targetIdx) - 250)}" y="${r1(b.y(target) - 8)}" fill="var(--s-tsla)">+75% on your cost &mdash; emailed here</text>
        <text x="${r1(b.x(peakIdx) + 8)}" y="${r1(b.y(values[peakIdx]) - 9)}" fill="var(--muted)">peak ${money(values[peakIdx])}</text>
        <text x="${r1(b.x(breakLabelIdx))}" y="${r1(b.y(bandMiddle) + 4)}" text-anchor="middle" fill="var(--neg)">the run breaks &mdash; emailed here</text>
      </g>
      <g class="endlbl">
        <text x="798" y="${r1(b.y(target))}" fill="var(--s-tsla)">${money(target)}</text>
        <text x="798" y="${r1(b.y(last))}" fill="var(--s-total)">${money(last)}</text>
        <text x="798" y="${r1(b.y(avgCost))}" fill="var(--faint)">${money(avgCost)}</text>
      </g>
      <g style="font-size:10px;font-family:'IBM Plex Sans',system-ui,sans-serif">
        <text x="798" y="${r1(b.y(target) + 13)}" fill="var(--muted)">your target</text>
        <text x="798" y="${r1(b.y(last) + 13)}" fill="var(--muted)">price at the end</text>
        <text x="798" y="${r1(b.y(avgCost) + 13)}" fill="var(--faint)">your average</text>
      </g>
    </svg>`;

  const runPct = Math.round(values[peakIdx] - 100);
  const givePct = Math.round(100 - 100 * last / values[peakIdx]);

  const head = figureHead(`It ran ${runPct}%, then gave ${givePct}% back. You heard about both.`,
                          'AMD', 'Jul 2023 &ndash; Sep 2024');

  const key = `<p class="lp-fig-key">
      <span><i style="background:var(--s-total)"></i>Price</span>
      <span><i class="dash"></i>Your average cost <b>${money(avgCost)}</b></span>
      <span><i style="background:var(--s-tsla)"></i>Target <b>${money(target)}</b></span>
      <span><i style="background:var(--neg)"></i>Trailing &minus;20% <b>${money(trail[breakIdx])}</b></span>
    </p>`;

  const foot = figureFoot(
    `Your target emailed you at <b>${money(target)}</b> on the way up. When the run broke, the trailing rule emailed again at <b>${money(trail[breakIdx])}</b> &mdash; no dashboard, no watching.`,
    `${amd.length} daily closes, rebased so the first is ${money(100)}. Your average cost only moves when you trade, so a target tied to it keeps meaning something; the red line is 20% under the highest close so far, which is why it climbs in steps and then holds still while the price falls back through it. Note the unflattering part: the target fired at ${money(target)} and the stock carried on to ${money(values[peakIdx])} before turning. One rule fires on the way up and one on the way down; neither decides anything for you.`);

  return { head, key, svg, foot, facts: { target, peak: values[peakIdx], breakAt: trail[breakIdx], last, n: amd.length } };
}

/**
 * A portfolio, bought into on a schedule, priced in euros at each day's rate.
 *
 * Three S&P 500 holdings and a purchase every quarter — the plainest thing a
 * person actually does. Everything the remaining figures show (invested against
 * value, the weights, the drawdown) comes out of this one simulation, so they
 * agree with each other by construction.
 */
function simulate(prices, fx, { start, perBuy, everyDays }) {
  const dates = [...new Set(Object.values(prices).flat().map(p => p.d))].sort().filter(d => d >= start);
  const byTicker = {};
  for (const [t, rows] of Object.entries(prices)) byTicker[t] = new Map(rows.map(r => [r.d, r.c]));

  const tickers = Object.keys(prices);
  const held = Object.fromEntries(tickers.map(t => [t, 0]));
  const lastPrice = Object.fromEntries(tickers.map(t => [t, null]));
  const out = [];
  let invested = 0, sinceBuy = everyDays, buyIndex = 0;

  for (const d of dates) {
    for (const t of tickers) if (byTicker[t].has(d)) lastPrice[t] = byTicker[t].get(d);
    if (tickers.some(t => lastPrice[t] == null)) continue;

    const rate = fx(d);
    const buys = [];
    if (sinceBuy >= everyDays) {
      const t = tickers[buyIndex % tickers.length];
      const eurPrice = lastPrice[t] * rate;
      const qty = perBuy / eurPrice;
      held[t] += qty;
      invested += perBuy;
      buys.push(t);
      buyIndex++;
      sinceBuy = 0;
    }
    sinceBuy++;

    const value = tickers.reduce((sum, t) => sum + held[t] * lastPrice[t] * rate, 0);
    out.push({ d, value, invested, buys, holdings: { ...held }, rate, px: { ...lastPrice } });
  }
  return out;
}

function folioFigure(sim) {
  const sampled = thinIndices(sim.length, 240);
  const pts = sampled.map(i => sim[i]);
  const values = pts.map(p => p.value);
  const invested = pts.map(p => p.invested);
  const b = box({ x0: 56, x1: 620, y0: 20, y1: 210, lo: 0, hi: Math.max(...values), n: pts.length });
  const ticks = b.ticks(4).filter(t => t >= 0);
  const last = sim[sim.length - 1];
  /*
   * Rings are placed by date, not by whether the purchase survived sampling.
   * A buy happens on one day in sixty-odd, so sampling 240 points out of
   * twelve hundred quietly dropped three quarters of them — the figure claimed
   * four purchases where the simulation made nineteen.
   */
  const buyIdx = [...new Set(sim
    .map((p, i) => (p.buys.length ? nearestSampled(i, sampled) : -1))
    .filter(i => i >= 0))];
  const k = n => '&euro;' + (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';

  const svg = `<svg viewBox="0 0 720 250" role="img" aria-label="Real chart: a portfolio of TSLA, MSFT and AMD bought every quarter from January 2022, priced in euros. Market value ends at ${Math.round(last.value)} euros against ${Math.round(last.invested)} euros invested.">
      <g>
        ${gridlines(b, ticks)}
      </g>
      <g class="axislbl" text-anchor="end" dominant-baseline="middle">
        ${ticks.map(t => `<text x="48" y="${r1(b.y(t))}">${k(t)}</text>`).join('\n        ')}
      </g>
      <g class="xlbl">
        ${['2022', '2023', '2024', '2025', '2026'].map(y => {
          const i = pts.findIndex(p => p.d >= y + '-01-01');
          return i < 0 ? '' : `<text x="${r1(b.x(i))}" y="228">${y}</text>`;
        }).filter(Boolean).join('\n        ')}
      </g>
      <!-- gain band: market value above invested -->
      <path class="iv-band" d="${band(values, invested, b)}"></path>
      <path d="${steps(invested, b)}" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="4 3"></path>
      <path class="serieline" d="${line(values, b)}" stroke="var(--s-total)"></path>
      <g class="buyring" stroke="var(--s-total)">
        ${buyIdx.map(i => `<circle cx="${r1(b.x(i))}" cy="${r1(b.y(values[i]))}" r="3"></circle>`).join('\n        ')}
      </g>
      <g class="endlbl">
        <text x="630" y="${r1(b.y(last.value) - 3)}" fill="var(--s-total)">${money(last.value)}</text>
        <text x="630" y="${r1(b.y(last.invested) - 3)}" fill="var(--faint)">${money(last.invested)}</text>
      </g>
      <g style="font-size:10px;font-family:'IBM Plex Sans',system-ui,sans-serif">
        <text x="630" y="${r1(b.y(last.value) + 10)}" fill="var(--muted)">Market value</text>
        <text x="630" y="${r1(b.y(last.invested) + 10)}" fill="var(--faint)">Invested</text>
      </g>
    </svg>`;

  const under = sim.filter(p => p.value < p.invested);
  const lastUnder = new Date(under[under.length - 1].d).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const head = figureHead(`${money(last.invested)} in. ${money(last.value)} today.`,
                          'TSLA &middot; MSFT &middot; AMD', 'Jan 2022 &ndash; today');

  const key = `<p class="lp-fig-key">
      <span><i style="background:var(--s-total)"></i>Market value <b>${money(last.value)}</b></span>
      <span><i class="dash"></i>Invested <b>${money(last.invested)}</b></span>
    </p>`;

  const foot = figureFoot(
    `${money(sim[0].invested)} every quarter, whatever the price was that morning &mdash; and <b>${under.length} days</b> along the way when it was worth less than the money put in.`,
    `Prices are real and converted to euros at each day's own rate; the buyer is the illustration &mdash; ${money(sim[0].invested)} into one of the three holdings every quarter, in rotation. The shaded band is gain over what went in and the ${buyIdx.length} rings are the purchases. Those ${under.length} losing days out of ${sim.length} ran as late as ${lastUnder}, which is the part a chart of somebody else's good idea usually leaves out.`);

  return { head, key, svg, foot, facts: { value: last.value, invested: last.invested } };
}

/** The averaging-down window, as it actually happened to one holding. */
function miniAveraging(spy) {
  const base = spy[0].c;
  const values = spy.map(p => 100 * p.c / base);
  const troughIdx = values.indexOf(Math.min(...values));
  const buyAt = [0, Math.round(troughIdx * 0.55), troughIdx, Math.round(troughIdx + (values.length - troughIdx) * 0.22)];

  let qty = 0, cost = 0;
  const avg = values.map((v, i) => {
    if (buyAt.includes(i)) { qty += 1; cost += v; }
    return cost / qty;
  });

  const b = box({ x0: 8, x1: 250, y0: 10, y1: 90, lo: Math.min(...values), hi: Math.max(...values), n: values.length });
  const crossIdx = values.findIndex((v, i) => i > troughIdx && v > avg[i]);
  const endAvg = avg[avg.length - 1], endPx = values[values.length - 1];

  // Two end labels within a line-height of each other read as one smudge.
  let pxY = b.y(endPx), avgY = b.y(endAvg);
  if (Math.abs(pxY - avgY) < 11) { const mid = (pxY + avgY) / 2; pxY = mid - 6; avgY = mid + 6; }

  return {
    svg: `<svg viewBox="0 0 300 100" role="img" aria-label="Real chart: SPY through the 2020 crash, with four purchases made while the price sat under the average cost, pulling that average from 100 down to ${Math.round(endAvg)} euros.">
          <!-- the stretch where the price line sits under the average-cost line -->
          <rect x="${r1(b.x0)}" y="10" width="${r1(b.x(crossIdx < 0 ? values.length - 1 : crossIdx) - b.x0)}" height="80" fill="var(--accent-soft)"></rect>
          <path d="${steps(avg, b)}" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="4 3"></path>
          <path class="serieline" d="${line(values, b)}" stroke="var(--s-total)"></path>
          <g class="buyring" stroke="var(--s-total)">
            ${buyAt.map(i => `<circle cx="${r1(b.x(i))}" cy="${r1(b.y(values[i]))}" r="3.2"></circle>`).join('\n            ')}
          </g>
          <text class="endlbl" x="256" y="${r1(pxY)}" fill="var(--s-total)">${money1(endPx)}</text>
          <text class="endlbl" x="256" y="${r1(avgY)}" fill="var(--faint)">${money(endAvg)}</text>
        </svg>`,
    facts: { endAvg, endPx }
  };
}

/** Invested against value, the same simulation at card size. */
function miniFolio(sim) {
  const pts = thin(sim, 90);
  const values = pts.map(p => p.value), invested = pts.map(p => p.invested);
  const b = box({ x0: 8, x1: 250, y0: 12, y1: 88, lo: 0, hi: Math.max(...values), n: pts.length });
  const last = sim[sim.length - 1];
  const k = n => '&euro;' + (n / 1000).toFixed(1) + 'k';

  return {
    svg: `<svg viewBox="0 0 300 100" role="img" aria-label="Real chart: portfolio market value against the total invested, which steps up with each purchase.">
          <path class="iv-band" d="${band(values, invested, b)}"></path>
          <path d="${steps(invested, b)}" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="4 3"></path>
          <path class="serieline" d="${line(values, b)}" stroke="var(--s-total)"></path>
          <text class="endlbl" x="256" y="${r1(b.y(last.value))}" fill="var(--s-total)">${k(last.value)}</text>
          <text class="endlbl" x="256" y="${r1(b.y(last.invested))}" fill="var(--faint)">${k(last.invested)}</text>
        </svg>`
  };
}

/** Holdings by market value, taken from where that simulation ended. */
function miniHoldings(sim) {
  const last = sim[sim.length - 1];
  const rows = Object.entries(last.holdings)
    .map(([t, q]) => ({ t, v: q * last.px[t] * last.rate }))
    .sort((a, b) => b.v - a.v);
  const max = rows[0].v;
  const y = i => 10 + i * 30;

  return {
    svg: `<svg viewBox="0 0 300 100" role="img" aria-label="Real bar chart of holdings by market value: ${rows.map(r => `${r.t} ${Math.round(r.v)} euros`).join(', ')}.">
          <g class="axislbl" text-anchor="end" dominant-baseline="middle" style="fill:var(--ink)">
            ${rows.map((r, i) => `<text x="40" y="${y(i) + 9}">${r.t}</text>`).join('\n            ')}
          </g>
          <g fill="var(--accent)">
            ${rows.map((r, i) => {
              const w = 46 + (200 - 46) * (r.v / max);
              return `<path d="M46,${y(i)} H${r1(w - 4)} Q${r1(w)},${y(i)} ${r1(w)},${y(i) + 4} V${y(i) + 14} Q${r1(w)},${y(i) + 18} ${r1(w - 4)},${y(i) + 18} H46 Z"></path>`;
            }).join('\n            ')}
          </g>
          <g class="endlbl" text-anchor="end" dominant-baseline="middle" style="fill:var(--muted)">
            ${rows.map((r, i) => `<text x="292" y="${y(i) + 9}">${money(r.v)}</text>`).join('\n            ')}
          </g>
        </svg>`
  };
}

/** How far under its own high water mark that portfolio has been. */
function miniDrawdown(sim) {
  /*
   * The drawdown is computed on every day and only then sampled, because a peak
   * or a trough that falls between two sampled days is a peak that never
   * happened: sampling first reported -35% for a portfolio that was really
   * -39% down. The sampled point nearest the true low is moved onto it, so the
   * line reaches the number the label claims.
   */
  let peak = 0;
  const full = sim.map(p => { peak = Math.max(peak, p.value); return peak ? 100 * (p.value / peak - 1) : 0; });
  const worst = Math.min(...full), fullWorstIdx = full.indexOf(worst);
  const sampled = thinIndices(full.length, 110);
  sampled[nearestSampled(fullWorstIdx, sampled)] = fullWorstIdx;
  const dd = sampled.map(i => full[i]);
  const worstIdx = dd.indexOf(worst);
  const b = box({ x0: 8, x1: 250, y0: 14, y1: 88, lo: worst, hi: 0, n: dd.length });

  return {
    svg: `<svg viewBox="0 0 300 100" role="img" aria-label="Real chart: this portfolio's drawdown from its own peak, reaching ${Math.abs(Math.round(worst))} percent down before recovering.">
          <line class="gridline" x1="8" y1="${r1(b.y(0))}" x2="250" y2="${r1(b.y(0))}"></line>
          <path class="uw-area" d="${line(dd, b)} L${r1(b.x(dd.length - 1))},${r1(b.y(0))} L${r1(b.x0)},${r1(b.y(0))} Z"></path>
          <path class="uw-line" d="${line(dd, b)}"></path>
          <circle cx="${r1(b.x(worstIdx))}" cy="${r1(b.y(worst))}" r="3.2" fill="var(--neg)"></circle>
          <text class="endlbl" x="256" y="${r1(b.y(0))}" fill="var(--faint)">0%</text>
          <text class="endlbl" x="${r1(b.x(worstIdx) + 6)}" y="${r1(b.y(worst) + 11)}" fill="var(--neg)">&minus;${Math.abs(Math.round(worst))}%</text>
        </svg>`,
    facts: { worst }
  };
}

/**
 * The hero's worked example, and the panel beside it.
 *
 * These numbers sit directly above the first chart and used to be invented:
 * ten at EUR 100 and ten more at EUR 70 for an average of EUR 85, while the
 * figure underneath drew a real fall to EUR 68.60 and an average of EUR 84.
 * Close enough that nobody would notice, which is the problem — the page's
 * argument is that numbers should be kept honest and current, so the first
 * numbers on it cannot be approximations of the ones below.
 *
 * Every figure here is now computed from the same series the charts draw, and
 * each row of the panel carries what the rule actually did rather than only
 * what it is.
 */
function heroBlocks(dip, rules) {
  const d = dip.facts, r = rules.facts;

  const lede = `<p class="lp-lede">
          Ten shares at ${money(d.first)}, then ten more after it fell to ${money1(d.second)} &mdash; your
          average cost is ${money(d.avg)}, so the stock only has to climb back to ${money(d.avg)} to put you
          in profit, not ${money(d.first)}. That is the S&amp;P 500 through 2020, and every chart below it is
          real prices too. Portfolio Tracker keeps that number current for every holding and works from it
          in both directions: it emails you when a stock falls under your cost, when you are up 75% on what
          you actually paid, and when a holding is 20% off its own 12-month high &mdash; so you act on your
          own plan instead of noticing three weeks late.
        </p>`;

  const stats = `<div class="lp-stats">
          <div><b class="hi">${money(d.first)} &rarr; ${money(d.avg)}</b><span>One buy near the 2020 bottom cut this break-even by ${Math.round(100 - 100 * d.avg / d.first)}% &mdash; the price ended the window at ${money1(d.last)}, a profit against ${money(d.avg)} and a loss against ${money(d.first)}</span></div>
          <div><b>+75% on cost</b><span>A take-profit level that follows what you actually paid. On AMD it emailed at ${money(r.target)}; the stock ran on to ${money(r.peak)} before it turned</span></div>
          <div><b>&minus;20% off its high</b><span>The trailing level that says a run has broken, measured against the stock's own peak. It caught that break at ${money(r.breakAt)}, with the window ending at ${money(r.last)}</span></div>
          <div><b>Every close</b><span>Prices refreshed and every rule re-checked each weekday morning, before the US market opens</span></div>
        </div>
        <p class="lp-statnote">Real closes: SPY ${d.n} days, Jan&ndash;Jun 2020, and AMD ${r.n} days, Jul 2023&ndash;Sep 2024, each rebased to ${money(d.first)} at the left edge. The purchases are the illustration.</p>`;

  return { lede, stats };
}

/* ---------------------------------------------------------------- output */

function replaceBlock(html, id, content) {
  const start = `<!-- figure:${id}:start -->`;
  const end = `<!-- figure:${id}:end -->`;
  const a = html.indexOf(start), b = html.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`markers for "${id}" not found in index.html`);
  const indent = ' '.repeat(6);
  return html.slice(0, a + start.length) + '\n' + indent + content.trim() + '\n' + indent.slice(2) + html.slice(b);
}

async function main() {
  const check = process.argv.includes('--check');
  const yf = yahoo();
  const today = new Date().toISOString().slice(0, 10);

  const [spy, amd, fx] = await Promise.all([
    series(yf, 'SPY', '2020-01-02', '2020-07-01'),
    series(yf, 'AMD', '2023-07-13', '2024-09-19'),
    usdToEur(yf, '2021-12-01', today)
  ]);
  const folioPrices = {};
  for (const t of ['TSLA', 'MSFT', 'AMD']) folioPrices[t] = await series(yf, t, '2022-01-01', today);

  const sim = simulate(folioPrices, fx, { start: '2022-01-03', perBuy: 600, everyDays: 63 });

  const dip = dipFigure(spy);
  const rules = rulesFigure(amd);
  const folio = folioFigure(sim);

  let html = fs.readFileSync(INDEX, 'utf-8');
  const before = html;
  const assemble = f => `${f.head}\n      ${f.key}\n      ${f.svg}\n      ${f.foot}`;
  html = replaceBlock(html, 'dip', assemble(dip));
  html = replaceBlock(html, 'rules', assemble(rules));
  html = replaceBlock(html, 'folio', assemble(folio));

  // the hero's worked example comes from the same numbers as the figure below it
  const hero = heroBlocks(dip, rules);
  html = replaceBlock(html, 'hero-lede', hero.lede);
  html = replaceBlock(html, 'hero-stats', hero.stats);
  html = replaceBlock(html, 'mini-averaging', miniAveraging(spy).svg);
  html = replaceBlock(html, 'mini-folio', miniFolio(sim).svg);
  html = replaceBlock(html, 'mini-holdings', miniHoldings(sim).svg);
  html = replaceBlock(html, 'mini-drawdown', miniDrawdown(sim).svg);

  const last = sim[sim.length - 1];
  console.log(`dip    SPY ${spy.length} closes: ${dip.facts.first.toFixed(0)} -> ${dip.facts.second.toFixed(1)} -> ${dip.facts.last.toFixed(1)}, average ${dip.facts.avg.toFixed(1)}`);
  console.log(`rules  AMD ${amd.length} closes: target ${rules.facts.target.toFixed(0)} fired, peak ${rules.facts.peak.toFixed(0)}, trailing ${rules.facts.breakAt.toFixed(0)}, end ${rules.facts.last.toFixed(0)}`);
  console.log(`folio  ${sim.length} days: invested ${Math.round(last.invested)}, value ${Math.round(last.value)}`);

  if (check) {
    console.log(before === html ? 'index.html is up to date' : 'index.html is OUT OF DATE — run without --check');
    process.exit(before === html ? 0 : 1);
  }
  fs.writeFileSync(INDEX, html);
  console.log(`index.html updated (${(html.length / 1024).toFixed(0)} KB)`);
}

if (require.main === module) {
  main().catch(err => { console.error('landing-figures failed:', err.message); process.exit(1); });
}

module.exports = { niceTicks, box, line, steps, band, thin, thinIndices, nearestSampled, widestGap, halfLabel, simulate };
