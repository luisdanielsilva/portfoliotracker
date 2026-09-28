/**
 * verify-portfolio.js, offline. `main()` is exercised in-process with a fake
 * `yf`, and one spawn test proves the default CLI path never touches the
 * network — see test/fixtures/no-network.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { main, fmtNum, fmtDelta } = require('../verify-portfolio.js');
const { _clearCache } = require('../split-check.js');
const { migratedDb, addUser, addTx, addPrice, addSplit } = require('./helpers.js');

function fakeYf(table, { onCall } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    chart: async (ticker) => {
      calls++;
      if (onCall) onCall(ticker);
      const events = table[ticker] || [];
      return { events: { splits: events.map(e => ({ date: e.date, numerator: e.n, denominator: e.d })) }, quotes: [] };
    }
  };
}

function priced(db, ticker) {
  addPrice(db, { ticker, date: '2026-01-01', eur: 100, native: 100, currency: 'EUR' });
}

test('main(): --check-splits reports ✗ affected (exit 1), ⚠ unaffected on one line, ℹ non-clean, and a masked email', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db, 'realname@example.com');
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });   // held across the 4:1
  addTx(db, u, { ticker: 'NOW', quantity: 5, amount: 500, ts: Date.UTC(2026, 0, 1) });      // bought after its split
  addTx(db, u, { ticker: 'T', quantity: 3, amount: 300, ts: Date.UTC(2015, 0, 1) });        // spin-off, held across
  priced(db, 'NVDA'); priced(db, 'NOW'); priced(db, 'T');

  const yf = fakeYf({
    NVDA: [{ date: '2021-07-20', n: 4, d: 1 }],
    NOW: [{ date: '2025-12-18', n: 5, d: 1 }],
    T: [{ date: '2022-04-11', n: 1324, d: 1000 }]
  });

  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });
  const out = logs.join('\n');

  assert.match(out, /✗ NVDA: unrecorded split 2021-07-20 4:1 affects a held position/);
  assert.match(out, /user .* \(re\*\*\*@example\.com\)/);
  assert.doesNotMatch(out, /realname@example\.com/, 'the full email must never appear');

  // The holder sub-line is real shares, not stored ones, and the delta is signed.
  assert.match(out, /held 10 before the split, \+30 shares/);
  // The per-ticker total: stored vs. what Yahoo's split implies, and the size of the gap.
  assert.match(out, /stored holding 10, with Yahoo's splits 40 \(off by \+30\)/);

  assert.match(out, /⚠ NOW: 1 unrecorded split\(s\), no position held across: 2025-12-18 5:1/);

  assert.match(out, /⚠ T: unrecorded non-clean event 2022-04-11 1324:1000 \(probably not a split\) — held across by/);

  assert.equal(exitCode, 1, 'an affected clean split is a real problem');
});

test('main(): a non-clean event nobody held across stays ℹ and does not affect the exit code', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db, 'other@example.com');
  addTx(db, u, { ticker: 'T', quantity: 3, amount: 300, ts: Date.UTC(2023, 0, 1) });   // bought after the spin-off
  priced(db, 'T');
  const yf = fakeYf({ T: [{ date: '2022-04-11', n: 1324, d: 1000 }] });

  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });
  const out = logs.join('\n');

  assert.match(out, /ℹ T: unrecorded non-clean event 2022-04-11 1324:1000 \(probably not a split\) — no position held across/);
  assert.equal(exitCode, 0);
});

test('main(): an unrecorded clean split nobody held across is ⚠ and does not affect the exit code', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2025, 0, 1) });   // bought after the split
  priced(db, 'NVDA');
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });

  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });
  const out = logs.join('\n');

  assert.match(out, /⚠ NVDA: 1 unrecorded split\(s\), no position held across: 2021-07-20 4:1/);
  assert.equal(exitCode, 0);
});

test('main(): stacked unrecorded splits telescope — the reported deltas add up to the true total, not to double-counted stored-unit deltas', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db, 'stacked@example.com');
  addTx(db, u, { ticker: 'NVDA', quantity: 100, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'NVDA');
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }, { date: '2024-06-10', n: 10, d: 1 }] });

  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });
  const out = logs.join('\n');

  assert.match(out, /held 100 before the split, \+300 shares/, 'the first, 4:1 event: real shares before it are the original 100');
  assert.match(out, /held 400 before the split, \+3600 shares/, 'the second, 10:1 event: real shares by then include the first split');
  assert.match(out, /stored holding 100, with Yahoo's splits 4000 \(off by \+3900\)/, 'the two deltas must sum to the true total, 300 \\+ 3600 = 3900');
  assert.equal(exitCode, 1);
});

test('main(): a sale between two unrecorded splits is still caught by the second — no false negative', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db, 'sold@example.com');
  addTx(db, u, { ticker: 'NVDA', quantity: 100, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  // 200 real, post-4:1-split shares sold in 2022, between the two unrecorded splits.
  addTx(db, u, { ticker: 'NVDA', type: 'sell', quantity: 200, amount: 2000, ts: Date.UTC(2022, 0, 1) });
  priced(db, 'NVDA');
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }, { date: '2024-06-10', n: 10, d: 1 }] });

  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });
  const out = logs.join('\n');

  // Naively replaying only stored units would show 100 - 200 = -100 before the
  // 10:1 and wrongly report "no position held across" it.
  assert.match(out, /held 100 before the split, \+300 shares/);
  assert.match(out, /held 200 before the split, \+1800 shares/, 'real shares before the 10:1: 400 held minus 200 real shares sold');
  assert.doesNotMatch(out, /NVDA: unrecorded split 2024-06-10 10:1.*no position held/s);
  assert.equal(exitCode, 1);
});

test('main(): an unrecorded 4:1 with a later *recorded* 10:1 multiplies the delta by the recorded split — kept from before this fix', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 100, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  addSplit(db, { ticker: 'NVDA', date: '2024-06-10', ratio: 10 });
  priced(db, 'NVDA');
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });

  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });
  const out = logs.join('\n');

  assert.match(out, /held 100 before the split, \+3000 shares/);
  assert.equal(exitCode, 1);
});

test('main(): a reverse split (1:10) prints a negative held/delta and a negative off-by', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 1000, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'NVDA');
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 1, d: 10 }] });

  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });
  const out = logs.join('\n');

  assert.match(out, /held 1000 before the split, -900 shares/);
  assert.match(out, /stored holding 1000, with Yahoo's splits 100 \(off by -900\)/);
  assert.equal(exitCode, 1);
});

test('main(): the holder line rounds and trims — 3:2 then 7:5 must not print a long float', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 2, amount: 200, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'NVDA');
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 3, d: 2 }, { date: '2024-06-10', n: 7, d: 5 }] });

  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });
  const out = logs.join('\n');

  assert.doesNotMatch(out, /1\.1999999999999997/);
  assert.equal(exitCode, 1);
});

test('main(): a ticker Yahoo could not check is reported with ⚠, not ✗ — it is a check that did not run, not a data problem — and 1 outranks 2', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'BAD', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  addTx(db, u, { ticker: 'GOOD', quantity: 5, amount: 500, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'BAD'); priced(db, 'GOOD');

  const yfFailOnly = fakeYf({}, { onCall: t => { if (t === 'BAD') throw new Error('boom'); } });
  const logsA = [];
  const exitA = await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf: yfFailOnly, log: m => logsA.push(m), delayMs: 0 });
  assert.match(logsA.join('\n'), /⚠ could not check BAD — /);
  assert.doesNotMatch(logsA.join('\n'), /✗ could not check/);
  assert.equal(exitA, 2, 'nothing else was wrong, so a Yahoo outage alone is exit 2, not 1');

  _clearCache();
  const yfFailAndAffected = fakeYf(
    { GOOD: [{ date: '2021-07-20', n: 4, d: 1 }] },
    { onCall: t => { if (t === 'BAD') throw new Error('boom'); } }
  );
  const logsB = [];
  const exitB = await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf: yfFailAndAffected, log: m => logsB.push(m), delayMs: 0 });
  assert.equal(exitB, 1, 'a real problem outranks "could not check"');
});

test('main(): the header counts checked vs. could-not-check tickers, not failures as "checked"', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'BAD', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  addTx(db, u, { ticker: 'GOOD', quantity: 5, amount: 500, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'BAD'); priced(db, 'GOOD');

  const yf = fakeYf({}, { onCall: t => { if (t === 'BAD') throw new Error('boom'); } });
  const logs = [];
  await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });
  assert.match(logs.join('\n'), /stock splits vs Yahoo \(1 checked, 1 could not be checked\)/);
});

test('main(): a user with no identity row is labelled honestly, not as "user X (X)"', async () => {
  _clearCache();
  const db = migratedDb();
  const orphanId = 'not-a-real-user-key';
  addTx(db, orphanId, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'NVDA');
  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });

  const logs = [];
  await main({ db, identityDb: db.identity, argv: ['--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });
  const out = logs.join('\n');

  assert.match(out, new RegExp(`user ${orphanId} \\(no identity record\\)`));
  assert.doesNotMatch(out, new RegExp(`\\(${orphanId}\\)`));
});

test('main(): --user takes a string identity key, not an integer row id', async () => {
  _clearCache();
  const db = migratedDb();
  const u1 = addUser(db, 'first@example.com');
  const u2 = addUser(db, 'second@example.com');
  addTx(db, u1, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  addTx(db, u2, { ticker: 'AMD', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'NVDA'); priced(db, 'AMD');

  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--user', u1], yf: undefined, log: m => logs.push(m) });
  const out = logs.join('\n');

  assert.match(out, new RegExp(`user ${u1}`));
  assert.doesNotMatch(out, new RegExp(`user ${u2}`));
  assert.equal(exitCode, 0);
});

test('main(): --user with a key that matches nobody exits 1, never touches Yahoo, and never claims "no problems found"', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'NVDA');

  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });
  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--user', 'typo', '--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });
  const out = logs.join('\n');

  assert.equal(exitCode, 1);
  assert.equal(yf.calls, 0);
  assert.doesNotMatch(out, /no problems found/);
  assert.match(out, /✗ no user with identity key "typo", nothing was checked/);
});

test('main(): --user given as the last argument (no value) exits 1 rather than silently checking everyone', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'NVDA');

  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--user'], yf: undefined, log: m => logs.push(m) });

  assert.equal(exitCode, 1);
  assert.match(logs.join('\n'), /✗ --user needs an identity key/);
});

test('main(): --user --check-splits takes the flag as the key and must still exit 1, no Yahoo call', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'NVDA');

  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });
  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--user', '--check-splits'], yf, log: m => logs.push(m), delayMs: 0 });

  assert.equal(exitCode, 1);
  assert.equal(yf.calls, 0);
  assert.match(logs.join('\n'), /✗ --user needs an identity key/);
});

test('main(): an unknown argument is rejected before any DB query or Yahoo call, exit 1', async () => {
  const cases = [
    { argv: ['--check-split'], desc: 'typo, single flag' },
    { argv: ['--user=abc'], desc: '--user=KEY with no space' },
    { argv: ['--user', 'a', '--user', 'b'], desc: '--user given twice' },
    { argv: ['--check-splits', '--check-splits'], desc: '--check-splits given twice' },
    { argv: ['foo'], desc: 'a stray positional' }
  ];

  for (const { argv, desc } of cases) {
    _clearCache();
    const db = migratedDb();
    const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });
    const logs = [];
    const exitCode = await main({ db, identityDb: db.identity, argv, yf, log: m => logs.push(m), delayMs: 0 });
    const out = logs.join('\n');

    assert.equal(exitCode, 1, `${desc}: expected exit 1`);
    assert.equal(yf.calls, 0, `${desc}: expected no Yahoo call`);
    assert.match(out, /✗ (unknown argument|--user given more than once|--check-splits given more than once)/, `${desc}: expected a rejection line`);
  }
});

test('main(): --user=KEY (no space) gets a hint to use --user <key> with a space', async () => {
  _clearCache();
  const db = migratedDb();
  const yf = fakeYf({});
  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: ['--user=abc'], yf, log: m => logs.push(m), delayMs: 0 });

  assert.equal(exitCode, 1);
  assert.equal(yf.calls, 0);
  assert.match(logs.join('\n'), /✗ unknown argument "--user=abc" — use --user <key> \(with a space\)/);
});

test('main(): valid argument forms still work — no args, --check-splits, --user <key>, and --user <key> --check-splits in either order', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'NVDA');

  const forms = [
    [],
    ['--check-splits'],
    ['--user', u],
    ['--user', u, '--check-splits'],
    ['--check-splits', '--user', u]
  ];

  for (const argv of forms) {
    _clearCache();
    const yf = fakeYf({}); // no Yahoo splits at all, so --check-splits finds nothing to flag
    const logs = [];
    const exitCode = await main({ db, identityDb: db.identity, argv, yf, log: m => logs.push(m), delayMs: 0 });

    assert.equal(exitCode, 0, `argv ${JSON.stringify(argv)}: expected exit 0`);
    assert.doesNotMatch(logs.join('\n'), /unknown argument|given more than once/, `argv ${JSON.stringify(argv)}: unexpected rejection`);
  }
});

test('main(): without --check-splits, yf is never called and the splits section is absent', async () => {
  _clearCache();
  const db = migratedDb();
  const u = addUser(db);
  addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });
  priced(db, 'NVDA');

  const yf = fakeYf({ NVDA: [{ date: '2021-07-20', n: 4, d: 1 }] });
  const logs = [];
  const exitCode = await main({ db, identityDb: db.identity, argv: [], yf, log: m => logs.push(m) });

  assert.equal(yf.calls, 0);
  assert.doesNotMatch(logs.join('\n'), /stock splits vs Yahoo/);
  assert.equal(exitCode, 0);
});

test('fmtNum/fmtDelta: round and trim, and sign the delta', () => {
  assert.equal(fmtNum(1.1999999999999997), '1.2');
  assert.equal(fmtNum(3900), '3900');
  assert.equal(fmtDelta(300), '+300');
  assert.equal(fmtDelta(-90.5), '-90.5');
});

/**
 * Proof that the default run makes no network call, using the real CLI: a
 * `--require` preload (test/fixtures/no-network.js) throws if anything tries
 * to load `yahoo-finance2` or reach out over http(s)/fetch/net/tls/dns. The
 * default run must survive it; `--check-splits` must fail loudly, showing the
 * guard really is active rather than silently absent.
 */
test('spawned CLI: the default run makes no network call; --check-splits is blocked by the fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-vp-test-'));
  try {
    const dbFile = path.join(dir, 'portfolio.db');
    const identityFile = path.join(dir, 'identity.db');

    const db = migratedDb();
    const u = addUser(db, 'someone@example.com');
    addTx(db, u, { ticker: 'NVDA', quantity: 10, amount: 1000, ts: Date.UTC(2020, 0, 1) });
    priced(db, 'NVDA');
    fs.writeFileSync(dbFile, db.serialize());
    fs.writeFileSync(identityFile, db.identity.serialize());

    const preload = path.join(__dirname, 'fixtures', 'no-network.js');
    const existingNodeOptions = process.env.NODE_OPTIONS || '';
    const env = {
      ...process.env,
      DB_PATH: dbFile,
      IDENTITY_DB_PATH: identityFile,
      NODE_OPTIONS: `${existingNodeOptions} --require "${preload}"`.trim()
    };

    const defaultRun = spawnSync(process.execPath, [path.join(__dirname, '..', 'verify-portfolio.js')], { env, encoding: 'utf-8' });
    assert.equal(defaultRun.status, 0, defaultRun.stdout + defaultRun.stderr);
    assert.match(defaultRun.stdout, /✓ no problems found/);

    const withFlag = spawnSync(process.execPath, [path.join(__dirname, '..', 'verify-portfolio.js'), '--check-splits'], { env, encoding: 'utf-8' });
    assert.notEqual(withFlag.status, 0, 'the fixture must block the load, not silently allow it');
    assert.match(withFlag.stderr, /no-network fixture: yahoo-finance2 must not be loaded/);

    // A bad --user must be rejected before --check-splits ever gets a chance
    // to load yahoo-finance2 — these three must exit 1 with the ✗ message and
    // must NOT trip the no-network fixture (no stderr from it, no crash).
    const badUserBin = path.join(__dirname, '..', 'verify-portfolio.js');
    const typoCase = spawnSync(process.execPath, [badUserBin, '--user', 'typo', '--check-splits'], { env, encoding: 'utf-8' });
    assert.equal(typoCase.status, 1, typoCase.stdout + typoCase.stderr);
    assert.match(typoCase.stdout, /✗ no user with identity key "typo", nothing was checked/);
    assert.doesNotMatch(typoCase.stderr, /no-network fixture/);

    const flagAsKeyCase = spawnSync(process.execPath, [badUserBin, '--user', '--check-splits'], { env, encoding: 'utf-8' });
    assert.equal(flagAsKeyCase.status, 1, flagAsKeyCase.stdout + flagAsKeyCase.stderr);
    assert.match(flagAsKeyCase.stdout, /✗ --user needs an identity key \(a UUID string\)/);
    assert.doesNotMatch(flagAsKeyCase.stderr, /no-network fixture/);

    const reorderedCase = spawnSync(process.execPath, [badUserBin, '--check-splits', '--user'], { env, encoding: 'utf-8' });
    assert.equal(reorderedCase.status, 1, reorderedCase.stdout + reorderedCase.stderr);
    assert.match(reorderedCase.stdout, /✗ --user needs an identity key \(a UUID string\)/);
    assert.doesNotMatch(reorderedCase.stderr, /no-network fixture/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
