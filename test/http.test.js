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

/* ---- the watchlist gate ----
 *
 * POST /api/alerts never checked that the ticker meant anything to the person
 * asking. Only the UI's dropdown did, by being filled from holdings. So an alert
 * on anything else was accepted, stored, listed as enabled — and could never
 * fire, because the daily job only fetches prices for tickers somebody holds or
 * watches. Nothing anywhere said so. These pin the refusal.
 *
 * No network here on purpose: POST /api/watchlist asks Yahoo to prove the symbol
 * is real, so these write the watchlist row directly and test the gate alone.
 */
function watch(pdb, userKey, ticker, referenceEur) {
  pdb.prepare(
    `INSERT INTO watchlist (user_id, ticker, reference_price_eur, reference_price_native,
                            currency, reference_source)
     VALUES (?, ?, ?, ?, 'USD', 'spotted')`
  ).run(userKey, ticker, referenceEur, referenceEur);
}

test('an alert on a stock that is neither held nor watched is refused', async () => {
  const s = signIn('gate@example.com');
  const r = await fetch(base + '/api/alerts', {
    method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'NFLX', ruleType: 'price_below', threshold: 100 })
  });
  assert.strictEqual(r.status, 400, 'an alert that could never fire must not be accepted');
  assert.match((await r.json()).error, /watchlist/i, 'and it should say what to do about it');
  s.idb.close(); s.pdb.close();
});

test('a watched stock can carry a price level alert', async () => {
  const s = signIn('watchprice@example.com');
  watch(s.pdb, s.key, 'GOOGL', 142);
  const r = await fetch(base + '/api/alerts', {
    method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'GOOGL', ruleType: 'price_below', threshold: 120 })
  });
  assert.strictEqual(r.status, 200);
  s.idb.close(); s.pdb.close();
});

test('a watched stock with a reference price can carry a dip alert', async () => {
  const s = signIn('watchdip@example.com');
  watch(s.pdb, s.key, 'GOOGL', 142);
  const r = await fetch(base + '/api/alerts', {
    method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'GOOGL', ruleType: 'dip_from_avg_cost', threshold: 20 })
  });
  assert.strictEqual(r.status, 200, 'the reference price is what it measures from');
  s.idb.close(); s.pdb.close();
});

test('a watched stock with no reference price is refused a dip alert', async () => {
  const s = signIn('noref@example.com');
  watch(s.pdb, s.key, 'NFLX', null);
  const r = await fetch(base + '/api/alerts', {
    method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'NFLX', ruleType: 'dip_from_avg_cost', threshold: 20 })
  });
  assert.strictEqual(r.status, 400, 'a dip with nothing to measure from must not be stored');
  assert.match((await r.json()).error, /reference price/i);

  // ...but the rules that need no reference still work for it.
  const ok = await fetch(base + '/api/alerts', {
    method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'NFLX', ruleType: 'drop_from_high', threshold: 20 })
  });
  assert.strictEqual(ok.status, 200, 'trailing needs no reference and must still be allowed');
  s.idb.close(); s.pdb.close();
});

test('the watchlist is per person', async () => {
  const a = signIn('wa@example.com');
  const b = signIn('wb@example.com');
  watch(a.pdb, a.key, 'GOOGL', 142);

  const list = await (await fetch(base + '/api/watchlist', { headers: b.headers })).json();
  assert.deepStrictEqual(list.watchlist, [], 'one person must not see another\'s watchlist');

  const r = await fetch(base + '/api/alerts', {
    method: 'POST', headers: b.headers,
    body: JSON.stringify({ ticker: 'GOOGL', ruleType: 'price_below', threshold: 120 })
  });
  assert.strictEqual(r.status, 400, 'nor borrow their watchlist to arm an alert');
  a.idb.close(); a.pdb.close(); b.idb.close(); b.pdb.close();
});

test('removing a watched stock takes its now-meaningless alerts with it', async () => {
  const s = signIn('wdel@example.com');
  watch(s.pdb, s.key, 'GOOGL', 142);
  await fetch(base + '/api/alerts', {
    method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'GOOGL', ruleType: 'price_below', threshold: 120 })
  });

  const r = await fetch(base + '/api/watchlist/GOOGL', { method: 'DELETE', headers: s.headers });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).removedAlerts, 1, 'and it should say how many it took');

  const left = await (await fetch(base + '/api/alerts', { headers: s.headers })).json();
  assert.ok(!(left.alerts || []).some(a => a.ticker === 'GOOGL'),
    'an alert with nothing left to measure must not survive the stock it watched');
  s.idb.close(); s.pdb.close();
});

/* ---- selling out, and keeping the stock in view ----
 *
 * A closed position used to be where a ticker quietly left the app: the daily
 * job stops fetching it the next morning, and any alert on it becomes unfirable
 * without saying so. The offer is made here; nothing is written until it is
 * taken.
 */
test('selling the last share offers to keep watching, and carries what it cost', async () => {
  const s = signIn('soldout@example.com');
  const buy = { ticker: 'ORCL', quantity: 10, amountEUR: 1000, type: 'buy', ts: Date.UTC(2026, 0, 2) };
  const sell = { ticker: 'ORCL', quantity: 10, amountEUR: 1400, type: 'sell', ts: Date.UTC(2026, 0, 9) };

  const bought = await (await fetch(base + '/api/transactions',
    { method: 'POST', headers: s.headers, body: JSON.stringify(buy) })).json();
  assert.strictEqual(bought.closedPosition, null, 'buying closes nothing');

  const sold = await (await fetch(base + '/api/transactions',
    { method: 'POST', headers: s.headers, body: JSON.stringify(sell) })).json();
  assert.ok(sold.closedPosition, 'the sale that empties the position makes the offer');
  assert.strictEqual(sold.closedPosition.ticker, 'ORCL');
  assert.strictEqual(sold.closedPosition.avgCostEur, 100, '€1000 over 10 shares');

  // The offer alone must not have written anything.
  const before = await (await fetch(base + '/api/watchlist', { headers: s.headers })).json();
  assert.deepStrictEqual(before.watchlist, [], 'an offer is not an action');
  s.idb.close(); s.pdb.close();
});

test('a partial sale makes no offer', async () => {
  const s = signIn('partial@example.com');
  await fetch(base + '/api/transactions', { method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'MSFT', quantity: 10, amountEUR: 1000, type: 'buy', ts: Date.UTC(2026, 0, 2) }) });
  const sold = await (await fetch(base + '/api/transactions', { method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'MSFT', quantity: 4, amountEUR: 560, type: 'sell', ts: Date.UTC(2026, 0, 9) }) })).json();

  assert.strictEqual(sold.closedPosition, null, 'still held, so nothing to offer');
  s.idb.close(); s.pdb.close();
});

test('accepting the offer carries the real cost, not a number the client chose', async () => {
  const s = signIn('carry@example.com');
  await fetch(base + '/api/transactions', { method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'ORCL', quantity: 10, amountEUR: 1000, type: 'buy', ts: Date.UTC(2026, 0, 2) }) });
  await fetch(base + '/api/transactions', { method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'ORCL', quantity: 10, amountEUR: 1400, type: 'sell', ts: Date.UTC(2026, 0, 9) }) });

  // A ticker with transactions already has price history in the real app; here
  // there is none, so this also proves `carry` does not depend on the backfill
  // having found anything. The row is dated beyond WATCH_HISTORY_DAYS (730) so
  // the add sees history deep enough to skip Yahoo — 400 days used to be enough
  // and is not any more, which is the point of that constant.
  s.pdb.prepare(`INSERT INTO prices (ticker, price_eur, price_native, currency, price_date, source)
                 VALUES ('ORCL', 90, 90, 'EUR', date('now','-800 day'), 'test')`).run();

  const r = await fetch(base + '/api/watchlist', {
    method: 'POST', headers: s.headers,
    // The client tries to dictate a reference; `carry` must win on the server's
    // own figure rather than this one being taken on trust.
    body: JSON.stringify({ ticker: 'ORCL', carry: true })
  });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.referenceSource, 'carried');
  assert.strictEqual(body.referenceEur, 100, 'what it actually cost, recomputed server-side');

  const list = await (await fetch(base + '/api/watchlist', { headers: s.headers })).json();
  assert.strictEqual(list.watchlist.length, 1);
  assert.strictEqual(list.watchlist[0].referenceSource, 'carried');
  s.idb.close(); s.pdb.close();
});

test('carry is refused when there is no closed position to carry from', async () => {
  const s = signIn('nocarry@example.com');
  s.pdb.prepare(`INSERT INTO prices (ticker, price_eur, price_native, currency, price_date, source)
                 VALUES ('GOOGL', 140, 140, 'EUR', date('now','-800 day'), 'test')`).run();
  const r = await fetch(base + '/api/watchlist', {
    method: 'POST', headers: s.headers, body: JSON.stringify({ ticker: 'GOOGL', carry: true })
  });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /no closed position/i);
  s.idb.close(); s.pdb.close();
});

test('a stock already on the watchlist is not offered again', async () => {
  const s = signIn('already@example.com');
  watch(s.pdb, s.key, 'ORCL', 120);
  await fetch(base + '/api/transactions', { method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'ORCL', quantity: 10, amountEUR: 1000, type: 'buy', ts: Date.UTC(2026, 0, 2) }) });
  const sold = await (await fetch(base + '/api/transactions', { method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'ORCL', quantity: 10, amountEUR: 1400, type: 'sell', ts: Date.UTC(2026, 0, 9) }) })).json();

  assert.strictEqual(sold.closedPosition, null, 'it is already being watched');
  s.idb.close(); s.pdb.close();
});

test('the alert list shows where a dip on a watched stock fires', async () => {
  // The list used to read the cost basis directly, so a Dip on a watched stock
  // came back with no trigger price and rendered as "fires at —" while the
  // daily job was perfectly able to fire it. The list and the job have to
  // resolve the reference the same way.
  const s = signIn('enrich@example.com');
  watch(s.pdb, s.key, 'GOOGL', 200);
  s.pdb.prepare(`INSERT INTO prices (ticker, price_eur, price_native, currency, price_date, source)
                 VALUES ('GOOGL', 180, 180, 'EUR', date('now'), 'test')`).run();
  await fetch(base + '/api/alerts', {
    method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'GOOGL', ruleType: 'dip_from_avg_cost', threshold: 25 })
  });

  const { alerts } = await (await fetch(base + '/api/alerts', { headers: s.headers })).json();
  const dip = alerts.find(a => a.ticker === 'GOOGL' && a.ruleType === 'dip_from_avg_cost');
  assert.ok(dip, 'the alert exists');
  assert.strictEqual(dip.triggerPriceEUR, 150, '25% below the €200 reference');
  assert.strictEqual(dip.referenceBasis, 'spotted',
    'and it says what it measured from, so the UI does not call it an average cost');
  s.idb.close(); s.pdb.close();
});

test('a dip on a holding still reports its basis as the cost basis', async () => {
  const s = signIn('enrichheld@example.com');
  await fetch(base + '/api/transactions', { method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'ORCL', quantity: 10, amountEUR: 1000, type: 'buy', ts: Date.UTC(2026, 0, 2) }) });
  await fetch(base + '/api/alerts', { method: 'POST', headers: s.headers,
    body: JSON.stringify({ ticker: 'ORCL', ruleType: 'dip_from_avg_cost', threshold: 20 }) });

  const { alerts } = await (await fetch(base + '/api/alerts', { headers: s.headers })).json();
  const dip = alerts.find(a => a.ticker === 'ORCL');
  assert.strictEqual(dip.referenceBasis, 'avg_cost');
  assert.strictEqual(dip.triggerPriceEUR, 80, '20% below the €100 paid');
  s.idb.close(); s.pdb.close();
});

/* A valid ticker must not be told it does not exist.
 *
 * backfillTicker reports `added: 0` for two unrelated reasons: Yahoo returned no
 * bars (the symbol is wrong), or every bar was skipped because there is no
 * exchange rate on file to convert that currency to euros (the symbol is fine,
 * this app's data is not). Conflating them told somebody AMD was not a ticker.
 */
test('a real ticker with no exchange rate on file says so, and does not blame the ticker', async () => {
  const s = signIn('fxgap@example.com');
  const before = s.pdb.prepare("SELECT COUNT(*) c FROM exchange_rates WHERE from_currency='USD'").get().c;
  assert.strictEqual(before, 0, 'precondition: this throwaway db has no USD rate');

  const r = await fetch(base + '/api/watchlist', {
    method: 'POST', headers: s.headers, body: JSON.stringify({ ticker: 'AMD' })
  });
  const body = await r.json();
  // Either the network is unavailable in CI (502) or Yahoo answered and the FX
  // gap was reported (503). What must never happen is 404 "no such symbol".
  assert.notStrictEqual(r.status, 404,
    'a valid ticker must never be reported as not existing: ' + JSON.stringify(body));
  if (r.status === 503) assert.match(body.error, /exchange rate/i);
  s.idb.close(); s.pdb.close();
});

/* A stock that listed recently does not have a 52-week high, and nothing said so.
 *
 * recentHigh() takes the maximum over whatever rows fall inside its 365-day
 * window. Holdings always had years behind them; a watchlist can hold something
 * that listed last quarter, so a Trailing rule there measures off a three-month
 * high while calling itself "off 52w high". The list reports the depth so it can
 * be said out loud.
 */
test('the watchlist reports how much history each stock actually has', async () => {
  const s = signIn('depth@example.com');
  watch(s.pdb, s.key, 'NEWCO', 100);
  watch(s.pdb, s.key, 'OLDCO', 100);
  const px = s.pdb.prepare(`INSERT INTO prices (ticker, price_eur, price_native, currency, price_date, source)
                            VALUES (?, 100, 100, 'EUR', date('now', ?), 'test')`);
  px.run('NEWCO', '-60 day'); px.run('NEWCO', '-1 day');
  px.run('OLDCO', '-800 day'); px.run('OLDCO', '-1 day');

  const { watchlist } = await (await fetch(base + '/api/watchlist', { headers: s.headers })).json();
  const nw = watchlist.find(w => w.ticker === 'NEWCO');
  const od = watchlist.find(w => w.ticker === 'OLDCO');

  assert.strictEqual(nw.historyShort, true, 'sixty days is not a year');
  assert.strictEqual(nw.historyDays, 59);
  assert.strictEqual(od.historyShort, false, 'eight hundred days is');
  s.idb.close(); s.pdb.close();
});

/* The backfill depth is the chart's, not a rule's.
 *
 * The chart's period buttons reach 2Y, so two years is what a watched stock is
 * expected to carry. Testing that against the trailing rule's 365 instead left a
 * stock with 400 days looking deep enough to skip the backfill, after which
 * pressing 2Y drew a short line and said nothing about why.
 */
test('a stock with more than a year but less than two is still short', async () => {
  const s = signIn('twoyear@example.com');
  watch(s.pdb, s.key, 'MIDCO', 100);
  const px = s.pdb.prepare(`INSERT INTO prices (ticker, price_eur, price_native, currency, price_date, source)
                            VALUES ('MIDCO', 100, 100, 'EUR', date('now', ?), 'test')`);
  px.run('-400 day'); px.run('-1 day');

  const { watchlist } = await (await fetch(base + '/api/watchlist', { headers: s.headers })).json();
  const w = watchlist.find(x => x.ticker === 'MIDCO');
  assert.strictEqual(w.historyDays, 399);
  assert.strictEqual(w.historyShort, true,
    '400 days fills 1Y but not the 2Y the chart offers, so it must still be flagged');
  s.idb.close(); s.pdb.close();
});

test('two full years is not short', async () => {
  const s = signIn('deep@example.com');
  watch(s.pdb, s.key, 'DEEPCO', 100);
  const px = s.pdb.prepare(`INSERT INTO prices (ticker, price_eur, price_native, currency, price_date, source)
                            VALUES ('DEEPCO', 100, 100, 'EUR', date('now', ?), 'test')`);
  px.run('-800 day'); px.run('-1 day');

  const { watchlist } = await (await fetch(base + '/api/watchlist', { headers: s.headers })).json();
  assert.strictEqual(watchlist.find(x => x.ticker === 'DEEPCO').historyShort, false);
  s.idb.close(); s.pdb.close();
});
