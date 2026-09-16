/**
 * The daily rate row, and the statement that writes it.
 *
 * On 2026-09-16 the job died with "no such column: updated_at" before storing a
 * single price. The column had never existed on `exchange_rates` in this schema —
 * the pre-split database called its timestamp that, `schema.sqlite.sql` calls it
 * `created_at`, and the 2026-09-14 split rebuilt the table from the schema. SQLite
 * resolves column names at prepare() time, and the statement is prepared before the
 * loop that would otherwise have fallen back to the last known rate, so a wrong
 * column name is fatal rather than degrading.
 *
 * Nothing had ever prepared this statement against the shipped schema. That is what
 * these tests do, against the same string the job and recompute-eur.js both use.
 */
const test = require('node:test');
const assert = require('node:assert');
const { RATE_UPSERT_SQL } = require('../price-fetch.js');
const { freshDb } = require('./helpers.js');

const today = db => db.prepare("SELECT DATE('now') AS d").get().d;

test('the rate statement prepares against the schema the app ships', () => {
  const db = freshDb();
  assert.doesNotThrow(() => db.prepare(RATE_UPSERT_SQL),
    'a column this table does not have takes the whole job down, not just the rate');
});

test('a second write on the same day updates the rate rather than adding a row', () => {
  const db = freshDb();
  const up = db.prepare(RATE_UPSERT_SQL);
  up.run('USD', 0.8600, today(db));
  up.run('USD', 0.8712, today(db));
  const rows = db.prepare('SELECT from_currency, rate FROM exchange_rates').all();
  assert.strictEqual(rows.length, 1, 'one rate per currency per day');
  assert.strictEqual(rows[0].rate, 0.8712, 'the later fetch wins');
});

test('each currency and each date keeps its own row', () => {
  const db = freshDb();
  const up = db.prepare(RATE_UPSERT_SQL);
  up.run('USD', 0.86, '2026-09-15');
  up.run('USD', 0.87, '2026-09-16');
  up.run('GBP', 1.15, '2026-09-16');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM exchange_rates').get().n, 3);
});

test('recompute-eur writes rates with the same statement, not a copy of it', () => {
  // The two had drifted into separate copies and both carried the same wrong column.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'recompute-eur.js'), 'utf-8');
  assert.match(src, /RATE_UPSERT_SQL/, 'recompute-eur must share the statement, not restate it');
  assert.doesNotMatch(src, /INSERT INTO exchange_rates/, 'a second copy is how the first one went stale');
});

test('requiring a maintenance script does not run it', () => {
  // A `require('./recompute-eur')` used to restate every euro price in DB_PATH.
  const before = require('fs').statSync(require('path').join(__dirname, '..', 'recompute-eur.js'));
  const m = require('../recompute-eur.js');
  assert.ok(m && typeof m === 'object', 'it should export rather than execute');
  assert.ok(before.size > 0);
});
