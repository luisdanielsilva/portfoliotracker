/**
 * The import endpoint, against a real server and a throwaway database.
 *
 * The parser is tested next door in csv-import.test.js; nothing here parses
 * anything. What is pinned here is the half that can corrupt a portfolio: the
 * euro amount a row is stored with, the rate it was converted at, whether a
 * second upload of the same file doubles the position, and whether undoing an
 * import can reach a transaction it did not create.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3198;
const base = `http://127.0.0.1:${PORT}`;
let server, dbFile, identityFile;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-import-'));
  dbFile = path.join(dir, 'test.db');
  identityFile = path.join(dir, 'identity.db');
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
  return { key, pdb, headers: { 'Content-Type': 'application/json', Cookie: `pt_session=${raw}` } };
}

/** A USD rate the fixtures can be converted at, on a date they can reach backwards to. */
function storeRate(pdb, date, rate) {
  pdb.prepare(`INSERT INTO exchange_rates (from_currency, to_currency, rate, date)
               VALUES ('USD','EUR',?,?)
               ON CONFLICT(from_currency,to_currency,date) DO UPDATE SET rate = excluded.rate`).run(rate, date);
}

const post = (session, rows) => fetch(base + '/api/transactions/import', {
  method: 'POST', headers: session.headers, body: JSON.stringify({ rows })
});

const row = (over = {}) => ({
  line: 2, date: '2025-01-30', type: 'buy', ticker: 'NVDA',
  quantity: 10, price: 127.11, currency: 'USD', ...over
});

test('a session is required', async () => {
  const res = await fetch(base + '/api/transactions/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [row()] })
  });
  assert.equal(res.status, 401);
});

test('a row is stored as price x quantity, converted at the trade date rate', async () => {
  const s = signIn('amount@example.com');
  storeRate(s.pdb, '2025-01-30', 0.9);

  const res = await post(s, [row()]);
  const body = await res.json();
  assert.equal(body.imported, 1);

  const tx = s.pdb.prepare('SELECT * FROM transactions WHERE user_id = ?').get(s.key);
  assert.equal(tx.ticker, 'NVDA');
  assert.equal(tx.quantity, 10);
  assert.equal(tx.currency, 'USD');
  assert.equal(tx.exchange_rate, 0.9);
  // 10 x 127.11 x 0.9 — fees are not in this number, by decision
  assert.ok(Math.abs(tx.amount_eur - 1143.99) < 0.005, `amount was ${tx.amount_eur}`);
  assert.equal(new Date(tx.ts).toISOString(), '2025-01-30T12:00:00.000Z');
  assert.equal(tx.import_batch_id, body.batchId);
});

test('a trade on a day with no rate uses the last rate before it, not the one after', async () => {
  const s = signIn('gap@example.com');
  storeRate(s.pdb, '2025-03-07', 0.92);          // Friday
  storeRate(s.pdb, '2025-03-10', 0.80);          // Monday, a rate that did not exist yet

  await post(s, [row({ date: '2025-03-08', quantity: 1, price: 100 })]);   // Saturday
  const tx = s.pdb.prepare('SELECT * FROM transactions WHERE user_id = ?').get(s.key);
  assert.equal(tx.exchange_rate, 0.92);
  assert.ok(Math.abs(tx.amount_eur - 92) < 0.005);
});

test('a trade older than every stored rate is refused, not converted at the oldest one', async () => {
  const s = signIn('old@example.com');
  storeRate(s.pdb, '2015-04-30', 0.9);

  const res = await post(s, [row({ date: '2014-01-02' })]);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.skipped[0].reason, /no USD rate/);
});

test('a EUR row needs no rate at all', async () => {
  const s = signIn('euro@example.com');
  const res = await post(s, [row({ ticker: 'VOW.DE', currency: 'EUR', quantity: 5, price: 100, date: '2021-10-12' })]);
  assert.equal((await res.json()).imported, 1);
  const tx = s.pdb.prepare('SELECT * FROM transactions WHERE user_id = ?').get(s.key);
  assert.equal(tx.exchange_rate, 1);
  assert.equal(tx.amount_eur, 500);
});

test('the same file imported twice does not double the position', async () => {
  const s = signIn('twice@example.com');
  storeRate(s.pdb, '2025-01-30', 0.9);
  const file = [row(), row({ line: 3, ticker: 'AMD', quantity: 5, price: 200 })];

  const first = await (await post(s, file)).json();
  assert.equal(first.imported, 2);

  const second = await (await post(s, file)).json();
  assert.equal(second.imported, 0, 'nothing new should be written');
  assert.equal(second.duplicates.length, 2);
  assert.match(second.duplicates[0].reason, /already imported/);

  const n = s.pdb.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ?').get(s.key).c;
  assert.equal(n, 2);
});

test('two genuine fills of the same size on the same day are both kept', async () => {
  // Identical rows are not necessarily a duplicate — a broker splits one order
  // into fills. Both must land, and a re-upload of that same file must still
  // recognise both rather than adding a third.
  const s = signIn('fills@example.com');
  storeRate(s.pdb, '2025-01-30', 0.9);
  const file = [row(), row({ line: 3 })];

  assert.equal((await (await post(s, file)).json()).imported, 2);
  assert.equal((await (await post(s, file)).json()).imported, 0);
  assert.equal(s.pdb.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ?').get(s.key).c, 2);
});

test('a broker order reference identifies the trade when the file has one', async () => {
  const s = signIn('ref@example.com');
  storeRate(s.pdb, '2025-01-30', 0.9);

  await post(s, [row({ orderRef: 'ORD-991' })]);
  // The same trade, restated by the broker at a slightly different price.
  // The reference says it is the same trade, so it is not imported again.
  const again = await (await post(s, [row({ orderRef: 'ORD-991', price: 127.15 })])).json();
  assert.equal(again.imported, 0);
  assert.equal(s.pdb.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ?').get(s.key).c, 1);
});

test('one unusable row does not stop the file, and comes back named', async () => {
  const s = signIn('partial@example.com');
  storeRate(s.pdb, '2025-01-30', 0.9);

  const body = await (await post(s, [
    row(),
    row({ line: 3, ticker: '', name: 'Some Unlisted Thing' }),
    row({ line: 4, quantity: -5 }),
    row({ line: 5, ticker: 'AMD', date: 'not-a-date' })
  ])).json();

  assert.equal(body.imported, 1);
  assert.deepEqual(body.skipped.map(s => s.line), [3, 4, 5]);
  assert.match(body.skipped[0].reason, /ticker/);
  assert.match(body.skipped[1].reason, /quantity/);
  assert.match(body.skipped[2].reason, /date/);
});

test('an import can be undone in one action', async () => {
  const s = signIn('undo@example.com');
  storeRate(s.pdb, '2025-01-30', 0.9);
  const { batchId } = await (await post(s, [row(), row({ line: 3, ticker: 'AMD' })])).json();

  const res = await fetch(`${base}/api/transactions/import/${batchId}`, { method: 'DELETE', headers: s.headers });
  assert.equal((await res.json()).removed, 2);
  assert.equal(s.pdb.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ?').get(s.key).c, 0);

  // and undoing it twice is a 404, not a second deletion of something else
  assert.equal((await fetch(`${base}/api/transactions/import/${batchId}`, { method: 'DELETE', headers: s.headers })).status, 404);
});

test('undo cannot reach a hand-typed transaction, or another account import', async () => {
  const mine = signIn('mine@example.com');
  const theirs = signIn('theirs@example.com');
  storeRate(mine.pdb, '2025-01-30', 0.9);

  mine.pdb.prepare(`INSERT INTO transactions (user_id, ticker, quantity, amount_eur, currency, exchange_rate, tx_type, ts)
                    VALUES (?, 'TSLA', 3, 900, 'EUR', 1, 'buy', ?)`).run(mine.key, Date.UTC(2024, 0, 2, 12));
  const { batchId } = await (await post(theirs, [row()])).json();

  // their batch id, my session: it must not delete anything of mine and must not find theirs
  assert.equal((await fetch(`${base}/api/transactions/import/${batchId}`, { method: 'DELETE', headers: mine.headers })).status, 404);
  assert.equal(mine.pdb.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ?').get(mine.key).c, 1);
  assert.equal(theirs.pdb.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ?').get(theirs.key).c, 1);
});

test('an oversized import is refused rather than truncated', async () => {
  const s = signIn('big@example.com');
  storeRate(s.pdb, '2025-01-30', 0.9);
  const many = Array.from({ length: 501 }, (_, i) => row({ line: i + 2, quantity: i + 1 }));

  const res = await post(s, many);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /500 rows/);
  assert.equal(s.pdb.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ?').get(s.key).c, 0);
});

test('a body too large for a hand-typed transaction is still accepted here', async () => {
  // The global limit is 64kb; 400 rows of JSON is comfortably past it.
  const s = signIn('body@example.com');
  storeRate(s.pdb, '2025-01-30', 0.9);
  const many = Array.from({ length: 400 }, (_, i) =>
    row({ line: i + 2, quantity: i + 1, orderRef: 'ORD-' + i, name: 'NVIDIA CORPORATION COMMON STOCK' }));

  const res = await post(s, many);
  assert.equal(res.status, 200, 'the import route takes a larger body');
  assert.equal((await res.json()).imported, 400);
});

test('an unsupported currency never reaches the database', async () => {
  const s = signIn('gbp@example.com');
  const res = await post(s, [row({ currency: 'GBP', ticker: 'BP.L' })]);
  assert.equal(res.status, 400);
  assert.match((await res.json()).skipped[0].reason, /GBP/);
});

test('the security lookup remembers a confirmed answer instead of asking again', async () => {
  const s = signIn('lookup@example.com');
  storeRate(s.pdb, '2025-01-30', 0.9);
  // importing with an ISIN records the choice the person confirmed
  await post(s, [row({ isin: 'US67066G1040', ticker: 'NVDA', name: 'NVIDIA Corp' })]);

  const res = await fetch(base + '/api/securities/lookup?isin=US67066G1040', { headers: s.headers });
  const body = await res.json();
  assert.equal(body.remembered, 'NVDA');
  assert.deepEqual(body.candidates, []);
});

test('a file that only names its securities is remembered too', () => {
  // Not a nicety. The dedupe key includes the ticker, so a security confirmed
  // as VOW.DE once and suggested as VOW3.DE the next time is two different
  // trades to this endpoint — and the same file imported twice doubles the
  // position. Remembering the name is what closes that.
  return (async () => {
    const s = signIn('named@example.com');
    const row = { line: 2, date: '2021-10-12', type: 'buy', quantity: 20, price: 158.20,
                  currency: 'EUR', ticker: 'VOW.DE', name: 'Volkswagen AG' };

    assert.equal((await (await post(s, [row])).json()).imported, 1);

    const res = await fetch(base + '/api/securities/lookup?name=' + encodeURIComponent('VOLKSWAGEN AG '),
      { headers: s.headers });
    const body = await res.json();
    assert.equal(body.remembered, 'VOW.DE', 'the confirmed ticker comes back, normalised name and all');

    // and the same file again adds nothing
    assert.equal((await (await post(s, [row])).json()).imported, 0);
    assert.equal(s.pdb.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id = ?').get(s.key).c, 1);
  })();
});

test('a remembered name never collides with a real ISIN', async () => {
  const s = signIn('collide@example.com');
  storeRate(s.pdb, '2025-01-30', 0.9);
  await post(s, [row({ isin: 'US67066G1040', name: 'NVIDIA Corp' })]);
  await post(s, [row({ line: 3, ticker: 'AMD', name: 'NVIDIA Corp', date: '2025-01-30', quantity: 1, price: 1 })]);

  const byIsin = await (await fetch(base + '/api/securities/lookup?isin=US67066G1040', { headers: s.headers })).json();
  const byName = await (await fetch(base + '/api/securities/lookup?name=NVIDIA%20Corp', { headers: s.headers })).json();
  assert.equal(byIsin.remembered, 'NVDA');
  assert.equal(byName.remembered, 'AMD', 'the name key is a separate row, not an overwrite of the ISIN one');
});
