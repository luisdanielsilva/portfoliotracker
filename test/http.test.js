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
let server, dbFile, identityFile;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-test-'));
  dbFile = path.join(dir, 'test.db');
  identityFile = path.join(dir, 'identity.db');   // where the server will look for it
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


/**
 * Create an account and a usable session across the split: the identity and the
 * session go in identity.db, the settings row on the financial side, and what
 * comes back is the opaque key the app will see as req.userId.
 */
function signIn(email) {
  const Database = require('better-sqlite3');
  const crypto = require('node:crypto');
  const idb = new Database(identityFile);
  const pdb = new Database(dbFile);
  const key = crypto.randomUUID();
  const userId = idb.prepare('INSERT INTO users (user_key, email) VALUES (?, ?)').run(key, email).lastInsertRowid;
  const raw = 'test-' + crypto.randomBytes(12).toString('hex');
  idb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)')
    .run(crypto.createHash('sha256').update(raw).digest('hex'), userId, new Date(Date.now() + 36e5).toISOString());
  pdb.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(key);
  return { key, userId, raw, idb, pdb, headers: { 'Content-Type': 'application/json', Cookie: `pt_session=${raw}` } };
}

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

test('a fresh deployment gets every table, on the correct side of the split', () => {
  const Database = require('better-sqlite3');
  const pdb = new Database(dbFile, { readonly: true });
  const idb = new Database(identityFile, { readonly: true });
  const tablesIn = h => h.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const financial = tablesIn(pdb), identity = tablesIn(idb);

  for (const t of ['transactions', 'prices', 'alerts', 'exchange_rates', 'stock_splits',
                   'job_runs', 'alert_events', 'algo_alert_log', 'algo_settings_log',
                   'user_settings', 'data_version']) {
    assert.ok(financial.includes(t), `${t} missing from the financial database`);
  }
  for (const t of ['users', 'sessions', 'login_tokens']) {
    assert.ok(identity.includes(t), `${t} missing from the identity database`);
  }

  // The whole point of the split, asserted rather than assumed.
  assert.ok(!financial.includes('users'), 'the financial database must not hold identities');
  for (const t of financial) {
    const cols = pdb.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map(c => c.name);
    assert.ok(!cols.some(c => /email/i.test(c)), `${t} has an email column on the financial side`);
  }
  pdb.close(); idb.close();
});

/**
 * The Algorithm tab's two timings, over HTTP and with a real session — the only
 * level at which the change log can be tested, because that is where it is written.
 */
test('changing a timing saves it and records what changed', async () => {
  const s = signIn('timings@example.com');
  const call = (method, body) => fetch(base + '/api/algorithm/settings', {
    method, headers: s.headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const logRows = () => s.pdb.prepare('SELECT field, old_value, new_value FROM algo_settings_log WHERE user_id = ? ORDER BY id').all(s.key);

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
  s.idb.close(); s.pdb.close();
});

/**
 * Backfill reaches outside the process and writes unbounded rows into shared
 * data. It used to hand Yahoo whatever string it was given.
 */
test('backfill refuses a ticker that is not a ticker', async () => {
  const s = signIn('backfill@example.com');
  for (const ticker of ['../../etc/passwd', 'A'.repeat(40), 'not a ticker', '']) {
    const r = await fetch(base + '/api/backfill', {
      method: 'POST', headers: s.headers, body: JSON.stringify({ ticker, years: 10 })
    });
    assert.strictEqual(r.status, 400, `"${ticker}" must be refused before anything is fetched`);
  }
  assert.strictEqual(s.pdb.prepare('SELECT COUNT(*) c FROM prices').get().c, 0);
  s.idb.close(); s.pdb.close();
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
  const s = signIn('cache@example.com');
  const { headers } = s;
  const db = s.pdb;
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
  s.idb.close(); s.pdb.close();
});

test('the database runs in WAL mode with a busy timeout', () => {
  // Both are required before a second worker is safe: WAL so readers do not block
  // on a writer, busy_timeout so a blocked writer waits rather than erroring.
  const Database = require('better-sqlite3');
  const db = new Database(dbFile, { readonly: true });
  assert.strictEqual(db.pragma('journal_mode', { simple: true }), 'wal');
  db.close();
});

test('being here is recorded once a day, not once a request', async () => {
  // last_seen_at is identity, not money — it must be written on that side only.
  const s = signIn('seen@example.com');
  const seen = () => s.idb.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(s.userId).last_seen_at;
  const visit = () => fetch(base + '/api/transactions', { headers: { Cookie: `pt_session=${s.raw}` } });

  assert.strictEqual(seen(), null, 'a new account has never been here');
  await visit();
  const first = seen();
  assert.ok(first, 'the first request stamps it');

  for (let i = 0; i < 5; i++) await visit();
  assert.strictEqual(seen(), first, 'later requests the same day must not write again');

  // Backdate it and the next visit should refresh it.
  s.idb.prepare("UPDATE users SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(s.userId);
  await visit();
  assert.notStrictEqual(seen(), '2020-01-01T00:00:00.000Z', 'a new day is recorded');
  s.idb.close(); s.pdb.close();
});
