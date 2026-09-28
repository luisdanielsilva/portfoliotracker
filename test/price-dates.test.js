/**
 * Issue #12: one meaning for `prices.price_date` — the bar's own trading date,
 * in the exchange's own timezone, never computed from the clock.
 *
 * Everything here uses a fake `yf` (`{ chart: async () => ({ meta, quotes }) }`)
 * with fictional tickers and prices — no network, no real holdings.
 */
const test = require('node:test');
const assert = require('node:assert');
const { tradingDate, isBarFinal, backfillTicker, finalBars } = require('../backfill-history.js');
const { migratedDb, addPrice } = require('./helpers.js');

// ---------------------------------------------------------------- tradingDate

test('tradingDate: a US bar in the afternoon UTC gives the same calendar date', () => {
  assert.strictEqual(tradingDate('2026-09-25T13:30:00.000Z', 'America/New_York'), '2026-09-25');
});

test('tradingDate: a bar at 23:00Z in Australia/Sydney gives the next date', () => {
  // Sydney is UTC+10/+11 — 23:00Z on the 25th is already the 26th there.
  assert.strictEqual(tradingDate('2026-09-25T23:00:00.000Z', 'Australia/Sydney'), '2026-09-26');
});

test('tradingDate defaults to UTC when no timezone is given', () => {
  assert.strictEqual(tradingDate('2026-09-25T23:00:00.000Z'), '2026-09-25');
});

test('tradingDate: a bar stamped exactly at midnight exchange-local stays on that calendar date', () => {
  // 2026-09-25T04:00:00Z is exactly 00:00:00 in America/New_York (EDT, UTC-4).
  assert.strictEqual(tradingDate('2026-09-25T04:00:00.000Z', 'America/New_York'), '2026-09-25');
});

test('tradingDate: the US market open (13:30Z) and the European open (07:00Z) both land on the date they are stamped', () => {
  assert.strictEqual(tradingDate('2026-09-25T13:30:00.000Z', 'America/New_York'), '2026-09-25');
  assert.strictEqual(tradingDate('2026-09-25T07:00:00.000Z', 'Europe/Paris'), '2026-09-25');
});

test('tradingDate: across a US DST change, a bar close to midnight UTC still resolves to the exchange-local date', () => {
  // By 2026-11-02 New York is back on EST (UTC-5) after the fall-back Sunday:
  // 2026-11-03T04:30:00Z is 2026-11-02T23:30 EST, still the 2nd in New York.
  assert.strictEqual(tradingDate('2026-11-03T04:30:00.000Z', 'America/New_York'), '2026-11-02');
  // And one day into spring-forward DST (2026-03-08), New York is UTC-4:
  // 2026-03-09T03:30:00Z is 2026-03-08T23:30 EDT.
  assert.strictEqual(tradingDate('2026-03-09T03:30:00.000Z', 'America/New_York'), '2026-03-08');
});

// ------------------------------------------------------------------ isBarFinal

const NY = 'America/New_York';
const usMeta = (regularEndISO, regularStartISO) => ({
  exchangeTimezoneName: NY,
  currentTradingPeriod: { regular: { start: regularStartISO, end: regularEndISO } }
});

test('isBarFinal: a past date is final regardless of metadata', () => {
  assert.strictEqual(isBarFinal('2026-09-24', null, new Date('2026-09-25T12:00:00Z')), true);
});

test('isBarFinal: today\'s US bar before end + 30 min is not final', () => {
  const meta = usMeta('2026-09-25T20:00:00.000Z', '2026-09-25T13:30:00.000Z');
  const now = new Date('2026-09-25T20:15:00.000Z'); // 15 min after close, inside the grace
  assert.strictEqual(isBarFinal('2026-09-25', meta, now), false);
});

test('isBarFinal: today\'s US bar after end + 30 min is final', () => {
  const meta = usMeta('2026-09-25T20:00:00.000Z', '2026-09-25T13:30:00.000Z');
  const now = new Date('2026-09-25T20:31:00.000Z');
  assert.strictEqual(isBarFinal('2026-09-25', meta, now), true);
});

test('isBarFinal: today\'s EU bar at the timer\'s own slot (Mon 08:00 UTC) is not final', () => {
  // Euronext/XETRA: 09:00 CEST open = 07:00 UTC, close 17:30 CEST = 15:30 UTC.
  const meta = {
    exchangeTimezoneName: 'Europe/Paris',
    currentTradingPeriod: { regular: { start: '2026-09-28T07:00:00.000Z', end: '2026-09-28T15:30:00.000Z' } }
  };
  const now = new Date('2026-09-28T08:00:00.000Z'); // the daily timer's slot
  assert.strictEqual(isBarFinal('2026-09-28', meta, now), false);
});

test('isBarFinal: missing currentTradingPeriod means today\'s bar is not final', () => {
  const now = new Date('2026-09-25T23:00:00.000Z');
  assert.strictEqual(isBarFinal(tradingDate(now, NY), { exchangeTimezoneName: NY }, now), false);
});

test('isBarFinal: a bar dated after today is not final', () => {
  const meta = usMeta('2026-09-25T20:00:00.000Z', '2026-09-25T13:30:00.000Z');
  const now = new Date('2026-09-24T12:00:00Z');
  assert.strictEqual(isBarFinal('2026-09-25', meta, now), false);
});

test('isBarFinal: a half-day (early regular.end) is final once its own, earlier grace has passed', () => {
  // US Thanksgiving-eve-style half day: regular session ends 13:00 ET (17:00Z) instead of 16:00 ET.
  const meta = usMeta('2026-11-27T17:00:00.000Z', '2026-11-27T13:30:00.000Z');
  const stillOpen = new Date('2026-11-27T17:15:00.000Z');   // 15 min after the early close, inside the grace
  const afterGrace = new Date('2026-11-27T17:31:00.000Z');  // 31 min after the early close
  assert.strictEqual(isBarFinal('2026-11-27', meta, stillOpen), false);
  assert.strictEqual(isBarFinal('2026-11-27', meta, afterGrace), true);
});

test('isBarFinal: metadata naming a different day than the bar (stale currentTradingPeriod) is not final', () => {
  // The bar is dated today, but currentTradingPeriod.regular still names yesterday's
  // session (e.g. a chart response fetched right at the day boundary) — a real day, not
  // just "missing metadata" (already covered above).
  const meta = usMeta('2026-09-24T20:00:00.000Z', '2026-09-24T13:30:00.000Z'); // names the 24th
  const now = new Date('2026-09-25T21:00:00.000Z'); // today is the 25th
  assert.strictEqual(isBarFinal('2026-09-25', meta, now), false);
});

// ------------------------------------------------------------------ finalBars

/** A US-style meta: exchange tz America/New_York, session 13:30Z-20:00Z. */
function usDayMeta(dateStr) {
  return {
    currency: 'USD',
    exchangeTimezoneName: NY,
    currentTradingPeriod: { regular: { start: `${dateStr}T13:30:00.000Z`, end: `${dateStr}T20:00:00.000Z` } }
  };
}

test('finalBars drops a bar for today before it is final, keeps completed sessions', () => {
  // Monday 08:00 UTC (the timer's slot), bars for Thu, Fri, and a Monday partial.
  const now = new Date('2026-09-28T08:00:00.000Z'); // Monday
  const chart = {
    meta: usDayMeta('2026-09-28'),
    quotes: [
      { date: new Date('2026-09-24T20:00:00.000Z'), close: 100 },  // Thursday, closed
      { date: new Date('2026-09-25T20:00:00.000Z'), close: 101 },  // Friday, closed
      { date: new Date('2026-09-28T08:00:00.000Z'), close: 102 }   // Monday, mid-session
    ]
  };
  const { bars, droppedOpen } = finalBars(chart, now);
  assert.deepEqual(bars.map(b => b.date), ['2026-09-24', '2026-09-25']);
  assert.strictEqual(droppedOpen, 1);
});

test('finalBars keeps only the first bar for a repeated date', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');
  const chart = {
    meta: usDayMeta('2026-09-24'),
    quotes: [
      { date: new Date('2026-09-24T20:00:00.000Z'), close: 100 },
      { date: new Date('2026-09-24T20:00:00.000Z'), close: 999 }   // a repeat, must not win
    ]
  };
  const { bars } = finalBars(chart, now);
  assert.strictEqual(bars.length, 1);
  assert.strictEqual(bars[0].close, 100);
});

// --------------------------------------------------------------- backfillTicker

function fakeYf(chart) { return { chart: async () => chart }; }

test('backfillTicker writes Thu and Fri under their own dates, not Monday, and uses the rate for each bar\'s own date', () => {
  const db = migratedDb();
  // Different rates on different days, so a wrong date would show up as a wrong euro figure.
  const rate = (date, r) => db.prepare(
    `INSERT INTO exchange_rates (from_currency, to_currency, rate, date) VALUES ('USD','EUR',?,?)`
  ).run(r, date);
  rate('2026-09-24', 0.90);
  rate('2026-09-25', 0.95);

  const now = new Date('2026-09-28T08:00:00.000Z'); // Monday, the timer's slot
  const yf = fakeYf({
    meta: usDayMeta('2026-09-28'),
    quotes: [
      { date: new Date('2026-09-24T20:00:00.000Z'), close: 100 },
      { date: new Date('2026-09-25T20:00:00.000Z'), close: 101 },
      { date: new Date('2026-09-28T08:00:00.000Z'), close: 999 } // must not be written
    ]
  });

  const r = backfillTicker(db, yf, 'AAA', 1, { now });
  return r.then(res => {
    const rows = db.prepare('SELECT price_date, price_native, price_eur FROM prices WHERE ticker = ? ORDER BY price_date').all('AAA');
    assert.deepEqual(rows.map(x => x.price_date), ['2026-09-24', '2026-09-25']);
    assert.ok(Math.abs(rows[0].price_eur - 90) < 0.001, `Thursday should use the 0.90 rate, got ${rows[0].price_eur}`);
    assert.ok(Math.abs(rows[1].price_eur - 95.95) < 0.001, `Friday should use the 0.95 rate, got ${rows[1].price_eur}`);
    assert.strictEqual(res.droppedOpen, 1);
    assert.strictEqual(res.last.date, '2026-09-25');
  });
});

test('backfillTicker updates source on conflict, so it names the last writer', async () => {
  const db = migratedDb();
  db.prepare(`INSERT INTO exchange_rates (from_currency, to_currency, rate, date) VALUES ('USD','EUR',0.9,'2026-09-24')`).run();
  addPrice(db, { ticker: 'AAA', date: '2026-09-24', eur: 1, native: 1, currency: 'USD' }); // source 'test'

  const now = new Date('2026-09-25T12:00:00.000Z');
  const yf = fakeYf({ meta: usDayMeta('2026-09-24'), quotes: [{ date: new Date('2026-09-24T20:00:00.000Z'), close: 100 }] });
  await backfillTicker(db, yf, 'AAA', 1, { now, source: 'yahoo_finance' });

  const row = db.prepare('SELECT source, price_native FROM prices WHERE ticker=? AND price_date=?').get('AAA', '2026-09-24');
  assert.strictEqual(row.source, 'yahoo_finance');
  assert.strictEqual(row.price_native, 100);
});

test('two writers agree: a job-style call and a backfill call produce identical rows for identical bars', async () => {
  const dbA = migratedDb(), dbB = migratedDb();
  for (const db of [dbA, dbB]) {
    db.prepare(`INSERT INTO exchange_rates (from_currency, to_currency, rate, date) VALUES ('USD','EUR',0.91,'2026-09-24')`).run();
  }
  const now = new Date('2026-09-25T12:00:00.000Z');
  const chart = { meta: usDayMeta('2026-09-24'), quotes: [{ date: new Date('2026-09-24T20:00:00.000Z'), close: 123.45 }] };

  await backfillTicker(dbA, fakeYf(chart), 'AAA', 1, { now, source: 'yahoo_finance' });
  await backfillTicker(dbB, fakeYf(chart), 'AAA', 1, { now, source: 'yahoo_backfill' });

  const rowA = dbA.prepare('SELECT price_date, price_native, price_eur FROM prices WHERE ticker=?').get('AAA');
  const rowB = dbB.prepare('SELECT price_date, price_native, price_eur FROM prices WHERE ticker=?').get('AAA');
  assert.deepEqual({ date: rowA.price_date, native: rowA.price_native, eur: rowA.price_eur },
                    { date: rowB.price_date, native: rowB.price_native, eur: rowB.price_eur });
});

test('a Saturday run over a table whose Friday row exists writes no new date', async () => {
  const db = migratedDb();
  db.prepare(`INSERT INTO exchange_rates (from_currency, to_currency, rate, date) VALUES ('USD','EUR',0.9,'2026-09-25')`).run();
  addPrice(db, { ticker: 'AAA', date: '2026-09-25', eur: 90, native: 100, currency: 'USD' });

  const now = new Date('2026-09-26T12:00:00.000Z'); // Saturday
  const yf = fakeYf({ meta: usDayMeta('2026-09-25'), quotes: [{ date: new Date('2026-09-25T20:00:00.000Z'), close: 100 }] });
  await backfillTicker(db, yf, 'AAA', 1, { now, source: 'yahoo_finance' });

  const dates = db.prepare('SELECT price_date FROM prices WHERE ticker=? ORDER BY price_date').all('AAA').map(r => r.price_date);
  assert.deepEqual(dates, ['2026-09-25']);
});
