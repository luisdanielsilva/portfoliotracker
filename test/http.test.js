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
  for (const p of ['/api/snapshots', '/api/transactions', '/api/alerts', '/api/avg-cost']) {
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
                   'exchange_rates', 'stock_splits', 'job_runs']) {
    assert.ok(have.includes(t), `${t} missing — a fresh deployment would fail on it`);
  }
  db.close();
});
