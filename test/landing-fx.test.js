/**
 * The landing page's euro figures use the same rate for a date as `exchange_rates`
 * does (#36). It used to read EURUSD=X through the generic close-series helper,
 * which filed each start-of-day snapshot under its UTC date — a session late all
 * winter — and kept the live bar Yahoo adds for today.
 */
const test = require('node:test');
const assert = require('node:assert');
const { usdToEur } = require('../landing-figures.js');
const { isDayStart } = require('../backfill-history.js');

function londonMidnight(dateStr) {
  const gmt = new Date(`${dateStr}T00:00:00Z`);
  return isDayStart(gmt, 'Europe/London') ? gmt : new Date(gmt.getTime() - 3600e3);
}
const inv = x => parseFloat((1 / x).toFixed(6));

/** A stand-in for yahoo-finance2 that answers one EURUSD=X chart. */
function fakeYahoo(snaps, live) {
  const quotes = snaps.map(([d, close]) => ({ date: londonMidnight(d), close }));
  if (live) quotes.push({ date: new Date(live[0]), close: live[1] });
  return {
    chart: async symbol => {
      assert.strictEqual(symbol, 'EURUSD=X');
      return { meta: { exchangeTimezoneName: 'Europe/London' }, quotes };
    }
  };
}

/** Thirty-odd weekday snapshots, 1.10 + i/1000, from `start`. */
function weekdays(start, n) {
  const out = [];
  const d = new Date(`${start}T12:00:00Z`);
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push([d.toISOString().slice(0, 10), 1.1 + out.length / 1000]);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

test('a winter rate is the next morning\'s snapshot, and Friday\'s is Monday\'s', async () => {
  const snaps = weekdays('2026-01-05', 35);            // Monday 5 Jan onwards, 00:00Z in London winter
  const fx = await usdToEur(fakeYahoo(snaps), '2026-01-01', '2026-03-01');
  const close = d => snaps.find(s => s[0] === d)[1];
  assert.strictEqual(fx('2026-01-13'), inv(close('2026-01-14')), 'Tuesday closes at Wednesday\'s opening snapshot');
  assert.strictEqual(fx('2026-01-16'), inv(close('2026-01-19')), 'Friday closes at Monday\'s');
  assert.strictEqual(fx('2026-01-17'), inv(close('2026-01-19')), 'a Saturday carries Friday\'s rate forward');
});

test('the same rule in summer, when London midnight is 23:00Z the evening before', async () => {
  const snaps = weekdays('2026-06-01', 35);
  const fx = await usdToEur(fakeYahoo(snaps), '2026-05-28', '2026-08-01');
  const close = d => snaps.find(s => s[0] === d)[1];
  assert.strictEqual(fx('2026-06-09'), inv(close('2026-06-10')));
});

test('the live bar for today is not a rate', async () => {
  const snaps = weekdays('2026-08-17', 35);
  const last = snaps[snaps.length - 1][0];
  const fx = await usdToEur(fakeYahoo(snaps, [`${last}T14:21:56Z`, 9.99]), '2026-08-15', last);
  // The newest snapshot closes the session before it; its own day has no rate yet and
  // takes that one forward — never the intraday 9.99. The lookup carries the last rate
  // it returned, as the figures walk dates in order, so walk them in order here too.
  let rate;
  for (const [d] of snaps) rate = fx(d);
  assert.strictEqual(rate, inv(snaps[snaps.length - 1][1]));
});
