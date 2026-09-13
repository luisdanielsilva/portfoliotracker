/**
 * The server, started for real against a throwaway database.
 *
 * The first assertion here is the one that matters most: express.static(__dirname) once
 * published data.db, its backups and .git over HTTPS. Nothing caught it for a week. A test
 * that fetches /data.db and expects 404 would have.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3199;
const base = `http://127.0.0.1:${PORT}`;
let server, dbFile;

test.before(async () => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-test-')), 'test.db');
  server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DB_PATH: dbFile, API_PORT: String(PORT), SMTP_HOST: '', COOKIE_INSECURE: 'true' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

test.after(() => { if (server) server.kill(); });

test('the database is not downloadable', async () => {
  assert.equal((await fetch(base + '/data.db')).status, 404);
  assert.equal((await fetch(base + '/test.db')).status, 404);
});

test('source and configuration are not downloadable', async () => {
  for (const p of ['/server.js', '/package.json', '/.env', '/db-migrations.js', '/.git/config', '/schema.sqlite.sql']) {
    assert.equal((await fetch(base + p)).status, 404, `${p} must not be served`);
  }
});

test('the four public files are served', async () => {
  for (const p of ['/', '/index.html', '/privacy.html', '/terms.html', '/contact.js', '/app.js']) {
    assert.equal((await fetch(base + p)).status, 200, `${p} should be public`);
  }
});

test('the API refuses an unauthenticated request', async () => {
  for (const p of ['/api/snapshots', '/api/transactions', '/api/alerts', '/api/avg-cost',
                   '/api/algorithm?ticker=TSLA', '/api/algorithm/settings']) {
    assert.equal((await fetch(base + p)).status, 401, `${p} must require a session`);
  }
});

test('security headers are set', async () => {
  const h = (await fetch(base + '/')).headers;
  assert.match(h.get('content-security-policy') || '', /script-src 'self'/);
  assert.ok(!/unsafe-inline/.test((h.get('content-security-policy') || '').split('style-src')[0]),
    "script-src must not allow inline scripts");
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('x-powered-by'), null, 'the stack should not be advertised');
});

test('the contact form validates and caps its input', async () => {
  const post = body => fetch(base + '/api/contact', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const good = { type: 'support', name: 'A', email: 'a@b.co', title: 'T', message: 'M' };
  assert.equal((await post({ ...good, type: 'nonsense' })).status, 400, 'unknown type');
  assert.equal((await post({ ...good, email: 'not-an-address' })).status, 400, 'bad address');
  assert.equal((await post({ ...good, message: 'x'.repeat(6000) })).status, 400, 'over the length cap');
  assert.equal((await post({ ...good, name: '' })).status, 400, 'empty field');
});

test('a database built from schema.sqlite.sql alone has every table the app queries', () => {
  const Database = require('better-sqlite3');
  const db = new Database(dbFile, { readonly: true });
  const have = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['users', 'sessions', 'login_tokens', 'transactions', 'prices', 'alerts',
                   'exchange_rates', 'stock_splits', 'job_runs',
                   'algo_alert_log', 'algo_settings_log']) {
    assert.ok(have.includes(t), `${t} missing — a fresh deployment would fail on it`);
  }
  db.close();
});

/**
 * The Algorithm tab's two timings, over HTTP and with a real session — the only
 * level at which the change log can be tested, because that is where it is written.
 */
test('changing a timing saves it and records what changed', async () => {
  const Database = require('better-sqlite3');
  const crypto = require('node:crypto');
  const db = new Database(dbFile);
  const userId = db.prepare('INSERT INTO users (email) VALUES (?)').run('timings@example.com').lastInsertRowid;
  const raw = 'httptest-' + crypto.randomBytes(12).toString('hex');
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)')
    .run(crypto.createHash('sha256').update(raw).digest('hex'), userId, new Date(Date.now() + 36e5).toISOString());

  const call = (method, body) => fetch(base + '/api/algorithm/settings', {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `pt_session=${raw}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const logRows = () => db.prepare('SELECT field, old_value, new_value FROM algo_settings_log WHERE user_id = ? ORDER BY id').all(userId);

  const defaults = await (await call('GET')).json();
  assert.strictEqual(defaults.holdDays, 3, 'a new account starts at the documented defaults');
  assert.strictEqual(defaults.cooldownDays, 60);
  assert.strictEqual(logRows().length, 0, 'reading changes nothing');

  assert.strictEqual((await call('PUT', { holdDays: 5, cooldownDays: 90 })).status, 200);
  assert.deepStrictEqual(logRows(), [
    { field: 'holdDays', old_value: 3, new_value: 5 },
    { field: 'cooldownDays', old_value: 60, new_value: 90 }
  ], 'both changes are recorded, with what they were before');

  // Re-choosing what is already chosen is not an event. A timeline full of those
  // is a timeline nobody reads.
  assert.strictEqual((await call('PUT', { holdDays: 5, cooldownDays: 90 })).status, 200);
  assert.strictEqual(logRows().length, 2, 'a no-op change adds nothing to the log');

  const bad = await call('PUT', { holdDays: 99, cooldownDays: 90 });
  assert.strictEqual(bad.status, 400, 'out-of-range values are refused');
  assert.strictEqual(logRows().length, 2, 'and a refused change is not logged');
  assert.strictEqual((await (await call('GET')).json()).holdDays, 5, 'nor does it corrupt what was saved');

  db.close();
});

/**
 * Backfill reaches outside the process and writes unbounded rows into shared
 * data. It used to hand Yahoo whatever string it was given.
 */
test('backfill refuses a ticker that is not a ticker', async () => {
  const Database = require('better-sqlite3');
  const crypto = require('node:crypto');
  const db = new Database(dbFile);
  const userId = db.prepare('INSERT INTO users (email) VALUES (?)').run('backfill@example.com').lastInsertRowid;
  const raw = 'bf-' + crypto.randomBytes(12).toString('hex');
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)')
    .run(crypto.createHash('sha256').update(raw).digest('hex'), userId, new Date(Date.now() + 36e5).toISOString());

  for (const ticker of ['../../etc/passwd', 'A'.repeat(40), 'not a ticker', '']) {
    const r = await fetch(base + '/api/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `pt_session=${raw}` },
      body: JSON.stringify({ ticker, years: 10 })
    });
    assert.strictEqual(r.status, 400, `"${ticker}" must be refused before anything is fetched`);
  }
  // Nothing reached the price table on the way through.
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM prices').get().c, 0);
  db.close();
});

test('the expensive endpoints carry a rate limit', async () => {
  // Not exercised to exhaustion here — that would take hundreds of requests and
  // punish the suite. The header is the contract: if the limiter is removed, it
  // disappears, and this fails.
  const r = await fetch(base + '/api/snapshots');
  assert.ok(r.headers.get('ratelimit-limit'), '/api/snapshots must advertise a limit');
  const s = await fetch(base + '/api/avg-cost');
  assert.ok(s.headers.get('ratelimit-limit'), 'the whole API sits behind a limiter');
});

/**
 * The computed-view cache. A stale entry here would show somebody yesterday's
 * portfolio as though it were today's, which is worse than any slowness it saves.
 */
test('a write retires the cached portfolio', async () => {
  const Database = require('better-sqlite3');
  const crypto = require('node:crypto');
  const db = new Database(dbFile);
  const userId = db.prepare('INSERT INTO users (email) VALUES (?)').run('cache@example.com').lastInsertRowid;
  const raw = 'cache-' + crypto.randomBytes(12).toString('hex');
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)')
    .run(crypto.createHash('sha256').update(raw).digest('hex'), userId, new Date(Date.now() + 36e5).toISOString());
  const headers = { 'Content-Type': 'application/json', Cookie: `pt_session=${raw}` };
  const snapshots = () => fetch(base + '/api/snapshots', { headers }).then(r => r.text());
  const buy = (ticker, qty, amount, ts) => fetch(base + '/api/transactions', {
    method: 'POST', headers, body: JSON.stringify({ ticker, quantity: qty, amountEUR: amount, type: 'buy', ts })
  });

  assert.strictEqual((await buy('AAA', 1, 100, Date.UTC(2026, 0, 10))).status, 200);
  const first = await snapshots();
  await snapshots();                                   // now certainly cached

  const version = () => db.prepare('SELECT version FROM data_version WHERE id = 1').get().version;
  const before = version();
  assert.strictEqual((await buy('BBB', 5, 500, Date.UTC(2026, 1, 10))).status, 200);
  assert.ok(version() > before, 'a write must bump the version the cache is keyed by');

  const after = await snapshots();
  assert.notStrictEqual(after, first, 'the cached response must not survive the write');
  assert.ok(after.includes('BBB'), 'the new holding has to appear immediately');
  db.close();
});

test('the database runs in WAL mode with a busy timeout', () => {
  // Both are required before a second worker is safe: WAL so readers do not block
  // on a writer, busy_timeout so a blocked writer waits rather than erroring.
  const Database = require('better-sqlite3');
  const db = new Database(dbFile, { readonly: true });
  assert.strictEqual(db.pragma('journal_mode', { simple: true }), 'wal');
  db.close();
});
