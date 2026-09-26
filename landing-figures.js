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
 *   dip      SPY   2020-01-02 -> 2020-06-30   -31.4% to the trough, back to -5.1%
 *   rules    AMD   2023-07-13 -> 2024-09-18   +82% to the peak, then -30% off it
 *   compare  six   2019-01-02 -> now          paid in, held, and traded on the rule
 *
 * The TSLA/MSFT/AMD simulation from 2022 is still run, but only for the four
 * drawings in the feature cards: as a full figure it repeated the one below it.
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

/**
 * Buy and hold against the rule this site is about.
 *
 * Both strategies receive the same money on the same days. Buy and hold puts it
 * straight into the six names, split evenly, and never sells. The rule holds it
 * as cash until a holding sits in the bottom fifth of its own trailing
 * twelve-month range, then buys; when one sits in the top fifth it sells a tenth
 * of that position and the proceeds wait for the next low.
 *
 * Three decisions here were made to keep the comparison honest rather than
 * flattering, and every one of them costs the rule:
 *
 *   - The window is 252 sessions because that is the twelve-month high this site
 *     already advertises, not because it is the window that wins. At 126 sessions
 *     the same rule finishes well behind buy and hold.
 *   - A signal seen at one close is filled at the next one, never at the close
 *     that produced it.
 *   - Cash sitting between signals is counted at face value and earns nothing.
 *
 * The parameter the result is genuinely sensitive to is how much gets sold at a
 * high: a tenth wins, a quarter loses. That is in the figure's own disclosure,
 * because a reader who cannot see it cannot judge the chart.
 */
function backtest(prices, fx, { start, perBuy, everyDays, win = 252, low = 0.2, high = 0.8, trim = 0.1, cool = 21, sell = true }) {
  const tickers = Object.keys(prices);
  const dates = [...new Set(Object.values(prices).flat().map(p => p.d))].sort().filter(d => d >= start);
  const byTicker = {};
  for (const [t, rows] of Object.entries(prices)) byTicker[t] = new Map(rows.map(r => [r.d, r.c]));

  const hist = Object.fromEntries(tickers.map(t => [t, []]));
  const last = Object.fromEntries(tickers.map(t => [t, null]));
  const hold = Object.fromEntries(tickers.map(t => [t, 0]));   // buy and hold
  const rule = Object.fromEntries(tickers.map(t => [t, 0]));   // on the rule
  const basis = Object.fromEntries(tickers.map(t => [t, 0]));  // average cost, as the app tracks it
  const acted = Object.fromEntries(tickers.map(t => [t, -1e9]));

  let cash = 0, invested = 0, since = everyDays, i = 0, realised = 0, buys = 0, sells = 0, peakCash = 0;
  let pending = [];
  const out = [];

  for (const d of dates) {
    for (const t of tickers) if (byTicker[t].has(d)) { last[t] = byTicker[t].get(d); hist[t].push(last[t]); }
    if (tickers.some(t => last[t] == null)) continue;
    const rate = fx(d);

    if (since >= everyDays) {
      invested += perBuy;
      for (const t of tickers) hold[t] += (perBuy / tickers.length) / (last[t] * rate);
      cash += perBuy;
      since = 0;
    }
    since++;

    // yesterday's signals, filled at today's close
    for (const o of pending) {
      if (o.side === 'buy') {
        const spend = Math.min(o.cash, cash);
        if (spend > 0) { rule[o.t] += spend / (last[o.t] * rate); basis[o.t] += spend; cash -= spend; buys++; }
      } else if (rule[o.t] > 0) {
        const qty = rule[o.t] * trim, proceeds = qty * last[o.t] * rate, cost = basis[o.t] * trim;
        rule[o.t] -= qty; basis[o.t] -= cost; cash += proceeds; realised += proceeds - cost; sells++;
      }
    }
    pending = [];

    for (const t of tickers) {
      const h = hist[t].slice(-win);
      if (h.length < win / 2 || i - acted[t] < cool) continue;
      const lo = Math.min(...h), hi = Math.max(...h);
      if (hi <= lo) continue;
      const pos = (last[t] - lo) / (hi - lo);
      if (pos <= low && cash > 0) { pending.push({ side: 'buy', t, cash }); acted[t] = i; }
      else if (sell && pos >= high && rule[t] > 0) { pending.push({ side: 'sell', t }); acted[t] = i; }
    }

    peakCash = Math.max(peakCash, cash);
    out.push({
      d, invested,
      hold: tickers.reduce((s, t) => s + hold[t] * last[t] * rate, 0),
      rule: tickers.reduce((s, t) => s + rule[t] * last[t] * rate, 0) + cash,
      cash
    });
    i++;
  }

  const l = out[out.length - 1];
  const neverBought = tickers.filter(t => rule[t] * last[t] * fx(l.d) < perBuy);
  return {
    rows: out,
    facts: { invested: l.invested, hold: l.hold, rule: l.rule, cash: l.cash, peakCash,
             realised, buys, sells, neverBought,
             // days the rule is *ahead* of buy and hold; the caption quotes the other 60%
             ahead: out.filter(r => r.rule > r.hold).length, n: out.length }
  };
}

/**
 * The money in, what holding it became, and what the rule made of it — one figure.
 *
 * This used to be two. The one above it drew a quarterly buyer's invested line
 * against market value from 2022, and this one drew paid-in against two strategy
 * curves from 2019: the same shape, the same dashed step, the same claim, twice
 * in a row. The band and the underwater count came down from that figure, so the
 * "money in vs what it is worth" question is still answered here — it is just
 * answered on the chart that also has something further to say.
 */
function compareFigure(bt, noSell) {
  const f = bt.facts;
  const sampled = thinIndices(bt.rows.length, 240);
  const pts = sampled.map(i => bt.rows[i]);
  const ruleV = pts.map(p => p.rule), holdV = pts.map(p => p.hold), inv = pts.map(p => p.invested);
  const b = box({ x0: 56, x1: 620, y0: 20, y1: 210, lo: 0, hi: Math.max(...ruleV, ...holdV), n: pts.length });
  const ticks = b.ticks(4).filter(t => t >= 0);
  const k = n => '&euro;' + (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  const gap = f.rule - f.hold;

  /*
   * The honest half of the caption, measured on every day rather than on the 240
   * sampled ones — the same mistake the rings in the old portfolio figure made.
   *
   * The figure this one absorbed counted days worth less than the money put in,
   * which was the right number for a buyer who started in 2022 and the wrong one
   * here: three good years first mean it happens on 7 days out of 1,944, which
   * reads as a boast. The drawdown is what this window actually has to admit, so
   * that is what the visible line carries and the underwater count moved into the
   * detail, where it is true rather than flattering.
   */
  const under = bt.rows.filter(r => r.hold < r.invested).length;
  let peak = null, dd = { depth: 0 };
  for (const r of bt.rows) {
    if (!peak || r.hold > peak.hold) peak = r;
    const depth = peak.hold > 0 ? 1 - r.hold / peak.hold : 0;
    if (depth > dd.depth) dd = { depth, d: r.d, peak };
  }
  /*
   * How long it took to be worth that much again — with the money that went in
   * meanwhile named, because this portfolio is still being paid into while it
   * falls. Reaching the old euro value in June 2023 sounds like a recovery and is
   * partly just ten thousand euros of fresh buys; a figure that says "back to
   * where it started" and leaves that out is doing the thing this page is against.
   */
  const backAt = bt.rows.find(r => r.d > dd.d && r.hold >= dd.peak.hold);
  const month = d => new Date(d).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const recovery = backAt
    ? `it was not worth that much again until ${month(backAt.d)}, and only with `
      + `${money(backAt.invested - dd.peak.invested)} of fresh monthly buys added in between`
    : `it has not been worth that much since`;

  // the two end labels are far enough apart to sit on their own lines; invested is far below both
  const svg = `<svg viewBox="0 0 720 250" role="img" aria-label="Real chart: the same ${Math.round(f.invested)} euros paid in monthly across six technology shares since 2019. Held and never sold it ends at ${Math.round(f.hold)} euros; traded on the rule it ends at ${Math.round(f.rule)} euros.">
      <g>
        ${gridlines(b, ticks)}
      </g>
      <g class="axislbl" text-anchor="end" dominant-baseline="middle">
        ${ticks.map(t => `<text x="48" y="${r1(b.y(t))}">${k(t)}</text>`).join('\n        ')}
      </g>
      <g class="xlbl">
        ${['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'].map(y => {
          const i = pts.findIndex(p => p.d >= y + '-01-01');
          return i < 0 ? '' : `<text x="${r1(b.x(i))}" y="228">${y}</text>`;
        }).filter(Boolean).join('\n        ')}
      </g>
      <!-- gain band: what holding turned the paid-in money into -->
      <path class="iv-band" d="${band(holdV, inv, b)}"></path>
      <path d="${steps(inv, b)}" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="4 3"></path>
      <path class="serieline" d="${line(holdV, b)}" stroke="var(--muted)" stroke-width="1.6"></path>
      <path class="serieline" d="${line(ruleV, b)}" stroke="var(--s-total)"></path>
      <g class="endlbl">
        <text x="630" y="${r1(b.y(f.rule) - 3)}" fill="var(--s-total)">${k(f.rule)}</text>
        <text x="630" y="${r1(b.y(f.hold) - 3)}" fill="var(--muted)">${k(f.hold)}</text>
        <text x="630" y="${r1(b.y(f.invested) - 3)}" fill="var(--faint)">${k(f.invested)}</text>
      </g>
      <g style="font-size:10px;font-family:'IBM Plex Sans',system-ui,sans-serif">
        <text x="630" y="${r1(b.y(f.rule) + 10)}" fill="var(--muted)">On the rule</text>
        <text x="630" y="${r1(b.y(f.hold) + 10)}" fill="var(--muted)">Held</text>
        <text x="630" y="${r1(b.y(f.invested) + 10)}" fill="var(--faint)">Paid in</text>
      </g>
    </svg>`;

  const head = figureHead(`${k(f.invested)} in. ${k(f.hold)} held. ${k(f.rule)} on the rule.`,
                          'TSLA &middot; NVDA &middot; AMD &middot; MSFT &middot; GOOGL &middot; META',
                          'Jan 2019 &ndash; today');

  const key = `<p class="lp-fig-key">
      <span><i class="dash"></i>Paid in <b>${money(f.invested)}</b></span>
      <span><i style="background:var(--muted)"></i>Bought and held <b>${k(f.hold)}</b></span>
      <span><i style="background:var(--s-total)"></i>On the rule <b>${k(f.rule)}</b></span>
    </p>`;

  const foot = figureFoot(
    `${money(600)} a month into six shares, whatever the price was that morning &mdash; and a fall into ${month(dd.d)} that left them <b>${Math.round(100 * dd.depth)}% below</b> their peak. Selling is what turned ${k(f.hold)} into ${k(f.rule)}: a tenth of a holding at each twelve-month high, put back at the next low; buying the dips <b>without</b> ever selling finishes behind at ${k(noSell.facts.rule)}.`,
    `Real closes for the six, in euros at each day's rate; the buyer is the illustration &mdash; ${money(600)} a month, ${money(f.invested)} in total. The shaded band is what simply holding it turned that money into: it was worth less than the money paid in on ${under} of ${f.n} days, all of them in the first months, and its worst fall was ${Math.round(100 * dd.depth)}% off its peak to ${month(dd.d)} &mdash; ${recovery}. Buy and hold splits every monthly ${money(600)} evenly and never sells. The rule holds the money as cash until a share sits in the bottom fifth of its own trailing twelve-month range, then buys; at the top fifth it sells a tenth of that holding, at most once a month per share, and every signal is filled at the <i>next</i> close. Three things a reader should weigh: it is behind buy and hold on ${100 - Math.round(100 * f.ahead / f.n)}% of days and only wins late; it realises ${money(f.realised)} of gains along the way where buy and hold realises none, and no tax is charged here &mdash; at 28% that is about ${money(f.realised * 0.28)}, two thirds of the ${money(gap)} difference; and it never once bought NVDA, the best of the six, because a share that keeps making new highs never enters the bottom fifth of its own range. It is also sensitive to how much is sold at each high: a tenth wins, a quarter finishes behind. One basket, one seven-year window, no costs.`);

  return { head, key, svg, foot, facts: { ...f, under, drawdown: dd.depth } };
}

/*
 * The card drawings are 300 units wide and as tall as the space their card
 * actually leaves them at the three-column width, measured in the browser
 * rather than guessed: 270 x 181 for the averaging card, 270 x 212 for the two
 * that sit under one line of text, 270 x 192 for the drawdown. Drawing to that
 * shape is what lets them fill the card without `preserveAspectRatio` having to
 * stretch anything, which would take the labels with it.
 */
const MINI_W = 300;
const MINI = { averaging: 200, folio: 235, holdings: 235, drawdown: 210 };

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

  const H = MINI.averaging;
  const b = box({ x0: 8, x1: 250, y0: 10, y1: H - 10, lo: Math.min(...values), hi: Math.max(...values), n: values.length });
  const crossIdx = values.findIndex((v, i) => i > troughIdx && v > avg[i]);
  const endAvg = avg[avg.length - 1], endPx = values[values.length - 1];

  // Two end labels within a line-height of each other read as one smudge.
  let pxY = b.y(endPx), avgY = b.y(endAvg);
  if (Math.abs(pxY - avgY) < 11) { const mid = (pxY + avgY) / 2; pxY = mid - 6; avgY = mid + 6; }

  return {
    svg: `<svg viewBox="0 0 ${MINI_W} ${H}" preserveAspectRatio="none" role="img" aria-label="Real chart: SPY through the 2020 crash, with four purchases made while the price sat under the average cost, pulling that average from 100 down to ${Math.round(endAvg)} euros.">
          <!-- the stretch where the price line sits under the average-cost line -->
          <rect x="${r1(b.x0)}" y="10" width="${r1(b.x(crossIdx < 0 ? values.length - 1 : crossIdx) - b.x0)}" height="${H - 20}" fill="var(--accent-soft)"></rect>
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
  const H = MINI.folio;
  const b = box({ x0: 8, x1: 250, y0: 12, y1: H - 12, lo: 0, hi: Math.max(...values), n: pts.length });
  const last = sim[sim.length - 1];
  const k = n => '&euro;' + (n / 1000).toFixed(1) + 'k';

  return {
    svg: `<svg viewBox="0 0 ${MINI_W} ${H}" preserveAspectRatio="none" role="img" aria-label="Real chart: portfolio market value against the total invested, which steps up with each purchase.">
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
  const H = MINI.holdings;
  // one slot per holding across the full height, with the bar centred in its slot
  const pad = 12, slot = (H - pad * 2) / rows.length, barH = Math.min(52, slot - 14), rad = 7;
  const y = i => pad + i * slot + (slot - barH) / 2;

  return {
    svg: `<svg viewBox="0 0 ${MINI_W} ${H}" preserveAspectRatio="none" role="img" aria-label="Real bar chart of holdings by market value: ${rows.map(r => `${r.t} ${Math.round(r.v)} euros`).join(', ')}.">
          <g class="axislbl" text-anchor="end" dominant-baseline="middle" style="fill:var(--ink)">
            ${rows.map((r, i) => `<text x="40" y="${r1(y(i) + barH / 2)}">${r.t}</text>`).join('\n            ')}
          </g>
          <g fill="var(--accent)">
            ${rows.map((r, i) => {
              const w = 46 + (200 - 46) * (r.v / max);
              const t = r1(y(i)), bm = r1(y(i) + barH);
              return `<path d="M46,${t} H${r1(w - rad)} Q${r1(w)},${t} ${r1(w)},${r1(y(i) + rad)} V${r1(y(i) + barH - rad)} Q${r1(w)},${bm} ${r1(w - rad)},${bm} H46 Z"></path>`;
            }).join('\n            ')}
          </g>
          <g class="endlbl" text-anchor="end" dominant-baseline="middle" style="fill:var(--muted)">
            ${rows.map((r, i) => `<text x="292" y="${r1(y(i) + barH / 2)}">${money(r.v)}</text>`).join('\n            ')}
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
  const H = MINI.drawdown;
  const b = box({ x0: 8, x1: 250, y0: 14, y1: H - 12, lo: worst, hi: 0, n: dd.length });

  return {
    svg: `<svg viewBox="0 0 ${MINI_W} ${H}" preserveAspectRatio="none" role="img" aria-label="Real chart: this portfolio's drawdown from its own peak, reaching ${Math.abs(Math.round(worst))} percent down before recovering.">
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
          Ten shares at ${money(d.first)}. Ten more when it fell to ${money1(d.second)}. Your break-even
          is ${money(d.avg)} now &mdash; not ${money(d.first)}. Portfolio Tracker keeps that number current for
          every holding and emails you the moment one drops under your cost, is up 75% on what you
          paid, or falls 20% off its own high.
        </p>`;

  const stats = `<div class="lp-stats">
          <div class="r1"><b>${money(d.first)} &rarr; ${money(d.avg)}</b><strong>Every dip lowers the bar</strong><span>One buy near the 2020 bottom cut break-even by ${Math.round(100 - 100 * d.avg / d.first)}%. It ended at ${money1(d.last)} &mdash; profit against ${money(d.avg)}, loss against ${money(d.first)}.</span></div>
          <div class="r2"><b>+75% on cost</b><strong>Take the win on purpose</strong><span>Take profit measured on what you actually paid. On AMD it emailed at ${money(r.target)}; the stock ran to ${money(r.peak)}.</span></div>
          <div class="r3"><b>&minus;20% off its high</b><strong>Keep the gain you made</strong><span>Measured against the stock's own peak. It caught the break at ${money(r.breakAt)}; the window ended at ${money(r.last)}.</span></div>
          <div class="r4"><b>Every close</b><strong>It watches so you don't</strong><span>Prices and rules re-checked every weekday morning, before the US market opens.</span></div>
        </div>
        <p class="lp-statnote">Real closes: SPY, Jan&ndash;Jun 2020 (${d.n} days) and AMD, Jul 2023&ndash;Sep 2024 (${r.n} days), rebased to ${money(d.first)}. The purchases are the illustration.</p>`;

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

  // no longer a figure of its own: this one drives the four feature-card drawings
  const sim = simulate(folioPrices, fx, { start: '2022-01-03', perBuy: 600, everyDays: 63 });

  /*
   * The comparison runs on its own price set and its own rate lookup: it starts
   * three years earlier than the portfolio above, and usdToEur returns a stateful
   * closure that carries the last rate it saw forward, so sharing one between two
   * walks over different date ranges would let one walk seed the other's gaps.
   */
  const cmpPrices = {};
  for (const t of ['TSLA', 'NVDA', 'AMD', 'MSFT', 'GOOGL', 'META']) {
    cmpPrices[t] = await series(yf, t, '2019-01-02', today);
  }
  const cmpFx = await usdToEur(yf, '2018-12-01', today);
  const btOpts = { start: '2019-01-02', perBuy: 600, everyDays: 21 };
  const bt = backtest(cmpPrices, cmpFx, btOpts);
  // the same rule with the selling switched off, which is the caption's control
  const btNoSell = backtest(cmpPrices, await usdToEur(yf, '2018-12-01', today), { ...btOpts, sell: false });

  const dip = dipFigure(spy);
  const rules = rulesFigure(amd);
  const compare = compareFigure(bt, btNoSell);

  let html = fs.readFileSync(INDEX, 'utf-8');
  const before = html;
  const assemble = f => `${f.head}\n      ${f.key}\n      ${f.svg}\n      ${f.foot}`;
  html = replaceBlock(html, 'dip', assemble(dip));
  html = replaceBlock(html, 'rules', assemble(rules));
  html = replaceBlock(html, 'compare', assemble(compare));

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
  console.log(`minis  ${sim.length} days: invested ${Math.round(last.invested)}, value ${Math.round(last.value)}`);
  console.log(`cmp    ${bt.facts.n} days: paid in ${Math.round(bt.facts.invested)}, held ${Math.round(bt.facts.hold)}, rule ${Math.round(bt.facts.rule)} `
    + `(${(bt.facts.rule / bt.facts.hold).toFixed(3)}x, ${bt.facts.buys} buys / ${bt.facts.sells} sells, `
    + `realised ${Math.round(bt.facts.realised)}, ahead ${Math.round(100 * bt.facts.ahead / bt.facts.n)}% of days)`);
  console.log(`cmp    buys only, no selling: ${Math.round(btNoSell.facts.rule)}; `
    + `${compare.facts.under} days under water, worst drawdown ${Math.round(100 * compare.facts.drawdown)}%`);

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
