/**
 * Who the Position Timing Signal speaks to (issue #34).
 *
 * Sign-up writes no `user_settings` row, so an account that never saved a timing
 * has none. For weeks that meant the signal the tab says is "watching every
 * holding" was watching only accounts old enough to have been copied across by
 * the 2026-09-14 split, or whose owner had clicked a preset. These pin down that
 * a missing row means the defaults, and that switching it off still means off.
 */
const test = require('node:test');
const assert = require('node:assert');
const { ALGO_DEFAULTS, readAlgoSettings, algoRecipients } = require('../algo-settings.js');
const { migratedDb, addUser, setAlgoSettings } = require('./helpers.js');

test('an account with no settings row reads as the defaults', () => {
  const db = migratedDb();
  const u = addUser(db, 'fresh@example.com');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM user_settings').get().c, 0, 'precondition: no row, as after a real sign-up');
  assert.deepStrictEqual(readAlgoSettings(db, u), { enabled: 1, holdDays: 3, cooldownDays: 30 });
});

test('a saved row wins over the defaults', () => {
  const db = migratedDb();
  const u = addUser(db);
  setAlgoSettings(db, u, { holdDays: 5, cooldownDays: 90 });
  assert.deepStrictEqual(readAlgoSettings(db, u), { enabled: 1, holdDays: 5, cooldownDays: 90 });
});

test('the recipients are every account with an address, less those who switched it off', () => {
  const db = migratedDb();
  const fresh = addUser(db, 'fresh@example.com');
  const tuned = addUser(db, 'tuned@example.com');
  const off = addUser(db, 'off@example.com');
  setAlgoSettings(db, tuned, { holdDays: 1, cooldownDays: 14 });
  setAlgoSettings(db, off, { enabled: 0 });

  const byId = new Map(algoRecipients(db, db.identity).map(r => [r.id, r]));
  assert.deepStrictEqual(byId.get(fresh), { id: fresh, email: 'fresh@example.com', holdDays: 3, cooldownDays: 30 },
    'an account that never saved a timing is included, on the defaults');
  assert.deepStrictEqual(byId.get(tuned), { id: tuned, email: 'tuned@example.com', holdDays: 1, cooldownDays: 14 });
  assert.ok(!byId.has(off), 'switched off stays off');
  assert.strictEqual(byId.size, 2);
});

test('a settings row with no identity behind it is nobody to email', () => {
  const db = migratedDb();
  setAlgoSettings(db, 'orphan-key');
  assert.deepStrictEqual(algoRecipients(db, db.identity), []);
});

test('with no identity database there is nobody to email, rather than a guess', () => {
  const db = migratedDb();
  addUser(db);
  assert.deepStrictEqual(algoRecipients(db, null), []);
});

test("the schema's column defaults match the ones the code applies", () => {
  // Nothing relies on them, since the only writer always writes every value. But
  // three places stating the same default, disagreeing, is how this got started.
  const cols = Object.fromEntries(migratedDb().prepare('PRAGMA table_info(user_settings)').all()
    .map(c => [c.name, Number(c.dflt_value)]));
  assert.deepStrictEqual(
    { enabled: cols.algo_alerts_enabled, holdDays: cols.algo_hold_days, cooldownDays: cols.algo_cooldown_days },
    { ...ALGO_DEFAULTS });
});
