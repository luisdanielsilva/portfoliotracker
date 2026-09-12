/**
 * The scheduled price fetch never ran once. The market-hours check tested only
 * `hour < close`, so 09:00 UTC — the timer's own slot — read as "still trading" and every
 * run was skipped. Nobody noticed for days because a skip looks like a success in the logs.
 *
 * These assertions are the shape of that bug.
 */
const test = require('node:test');
const assert = require('node:assert');
const { areMarketsClosedForFetch } = require('../price-fetch.js');

const at = (day, hour, minute = 0) => new Date(Date.UTC(2026, 8, day, hour, minute));
// 2026-09-07 is a Monday; 2026-09-12 a Saturday, 2026-09-13 a Sunday.
const MONDAY = 7, SATURDAY = 12, SUNDAY = 13;

test('the 09:00 UTC timer slot is treated as closed — the bug that stopped every run', () => {
  const { isClosed } = areMarketsClosedForFetch(at(MONDAY, 9));
  assert.equal(isClosed, true, '09:00 UTC must be a usable slot: the last close is final');
});

test('every hour before the US open counts as closed', () => {
  for (let h = 0; h < 13; h++) {
    assert.equal(areMarketsClosedForFetch(at(MONDAY, h)).isClosed, true, `${h}:00 UTC`);
  }
});

test('trading hours are open', () => {
  for (let h = 13; h < 21; h++) {
    assert.equal(areMarketsClosedForFetch(at(MONDAY, h)).isClosed, false, `${h}:00 UTC`);
  }
});

test('after the close it is closed again, through to midnight', () => {
  for (let h = 21; h < 24; h++) {
    assert.equal(areMarketsClosedForFetch(at(MONDAY, h)).isClosed, true, `${h}:00 UTC`);
  }
});

test('weekends are closed at every hour', () => {
  for (const day of [SATURDAY, SUNDAY]) {
    for (let h = 0; h < 24; h += 3) {
      const r = areMarketsClosedForFetch(at(day, h));
      assert.equal(r.isClosed, true, `day ${day} ${h}:00`);
      assert.match(r.reason, /weekend/i);
    }
  }
});

test('the window is never empty — some hour of a weekday is always usable', () => {
  const usable = Array.from({ length: 24 }, (_, h) => areMarketsClosedForFetch(at(MONDAY, h)).isClosed);
  assert.ok(usable.some(Boolean), 'a day with no usable slot means the job can never run');
});
