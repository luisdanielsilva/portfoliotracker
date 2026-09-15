/**
 * The ceiling on outbound mail.
 *
 * On 2026-09-15 a crash met `Restart=on-failure` and the job emailed a failure
 * report 453 times in five hours, exhausting the account's daily quota — after
 * which the alert emails users depend on could not be sent either. Every throttle
 * in the app was individually reasonable; nothing was counting the total.
 *
 * These tests are about the total.
 */
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const g = require('../mailguard.js');

/** An identity database holding nothing but a count — which is all mailguard reads. */
function withUsers(n) {
  const id = new Database(':memory:');
  id.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  const ins = id.prepare('INSERT INTO users (id) VALUES (?)');
  for (let i = 1; i <= n; i++) ins.run(i);
  return id;
}

/* The ledger carries its identity database the way the app's does, so no test ever
   reaches for the real one — and so the global ceiling in these tests is a number
   the test itself chose. Twenty accounts is a 200-message ceiling: high enough that
   the per-recipient tests below are testing what they say they are. */
const freshLedger = (users = 20) => {
  const db = new Database(':memory:');
  g.ensureEmailLog(db);
  db.identity = withUsers(users);
  return db;
};

/** A mailer that records instead of sending. */
function fakeMailer() {
  const sent = [];
  return { sent, sendMail: async m => { sent.push(m); } };
}

test('a repeated failure report stops at its budget', async () => {
  const db = freshLedger();
  const mailer = fakeMailer();
  // The exact shape of the incident: the same report, over and over.
  for (let i = 0; i < 50; i++) {
    await g.sendGuarded(db, mailer, 'run-report', { to: 'ops@example.com', subject: 'FAILED' });
  }
  assert.strictEqual(mailer.sent.length, g.LIMITS['run-report'],
    `453 attempts must become ${g.LIMITS['run-report']} emails, not 453`);
});

test('each recipient has their own budget', async () => {
  const db = freshLedger();
  const mailer = fakeMailer();
  for (let i = 0; i < 20; i++) {
    await g.sendGuarded(db, mailer, 'alert', { to: 'a@example.com', subject: 'x' });
    await g.sendGuarded(db, mailer, 'alert', { to: 'b@example.com', subject: 'x' });
  }
  const toA = mailer.sent.filter(m => m.to === 'a@example.com').length;
  const toB = mailer.sent.filter(m => m.to === 'b@example.com').length;
  assert.strictEqual(toA, g.LIMITS.alert);
  assert.strictEqual(toB, g.LIMITS.alert, 'one noisy recipient must not consume another\'s budget');
});

test('kinds do not share a budget', async () => {
  const db = freshLedger();
  const mailer = fakeMailer();
  for (let i = 0; i < 20; i++) await g.sendGuarded(db, mailer, 'run-report', { to: 'ops@example.com', subject: 'x' });
  const afterReports = mailer.sent.length;
  // Support mail must still get through after the reports have used themselves up.
  const r = await g.sendGuarded(db, mailer, 'contact', { to: 'ops@example.com', subject: 'help' });
  assert.strictEqual(r.sent, true, 'a support message must not be blocked by noisy reports');
  assert.strictEqual(mailer.sent.length, afterReports + 1);
});

test('the address is never stored, only a hash of it', async () => {
  const db = freshLedger();
  await g.sendGuarded(db, fakeMailer(), 'alert', { to: 'someone@example.com', subject: 'x' });
  const rows = db.prepare('SELECT * FROM email_log').all();
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes('someone@example.com'), 'the financial database must not hold an address');
  assert.ok(dump.includes(g.hashRecipient('someone@example.com')), 'it holds the hash instead');
});

test('the address is matched case- and whitespace-insensitively', async () => {
  const db = freshLedger();
  const mailer = fakeMailer();
  for (const to of ['Person@Example.com ', 'person@example.com', ' PERSON@EXAMPLE.COM']) {
    for (let i = 0; i < 3; i++) await g.sendGuarded(db, mailer, 'alert', { to, subject: 'x' });
  }
  assert.strictEqual(mailer.sent.length, g.LIMITS.alert,
    'capitalisation must not buy anybody a second budget');
});

test('a global ceiling catches what per-recipient budgets cannot', async () => {
  const db = freshLedger(4);
  const mailer = fakeMailer();
  // A loop that invents a new recipient every time defeats any per-recipient
  // limit. This is the backstop for the failure nobody has thought of yet.
  for (let i = 0; i < 200; i++) {
    await g.sendGuarded(db, mailer, 'login', { to: `user${i}@example.com`, subject: 'x' });
  }
  assert.strictEqual(mailer.sent.length, 4 * g.GLOBAL_PER_USER,
    'four registered accounts buy forty messages a day, however many recipients the loop invents');
});

test('the ceiling is ten per registered user, and moves with the user base', () => {
  assert.strictEqual(g.globalCeiling(null, withUsers(1)).limit, 10);
  assert.strictEqual(g.globalCeiling(null, withUsers(6)).limit, 60);
  assert.strictEqual(g.globalCeiling(null, withUsers(200)).limit, 2000);
  // and it reports the count it used, so the refusal can say why
  assert.strictEqual(g.globalCeiling(null, withUsers(6)).users, 6);
});

test('an install with no accounts yet still gets one user\'s worth', async () => {
  // Zero registered users would otherwise compute a ceiling of zero and silence the
  // backup and health mail that says a fresh install is working.
  const db = freshLedger(0);
  const mailer = fakeMailer();
  for (let i = 0; i < 40; i++) await g.sendGuarded(db, mailer, 'login', { to: `u${i}@example.com`, subject: 'x' });
  assert.strictEqual(mailer.sent.length, g.GLOBAL_FLOOR);
});

test('an identity database that cannot be read does not silence the mail', async () => {
  // Same principle as the broken ledger below: if the count is unavailable the global
  // check is skipped, not guessed at. The per-recipient budgets are still in force.
  const db = freshLedger();
  db.identity = new Database(':memory:');        // no users table at all
  const mailer = fakeMailer();
  for (let i = 0; i < 100; i++) await g.sendGuarded(db, mailer, 'login', { to: `u${i}@example.com`, subject: 'x' });
  assert.strictEqual(mailer.sent.length, 100, 'an unreadable count must not become a ceiling of zero');
});

test('yesterday does not count against today', async () => {
  const db = freshLedger();
  const mailer = fakeMailer();
  const h = g.hashRecipient('ops@example.com');
  for (let i = 0; i < 10; i++) {
    db.prepare("INSERT INTO email_log (recipient_hash, kind, sent_at) VALUES (?, 'run-report', datetime('now','-30 hours'))").run(h);
  }
  const r = await g.sendGuarded(db, mailer, 'run-report', { to: 'ops@example.com', subject: 'x' });
  assert.strictEqual(r.sent, true, 'the window rolls — it is 24 hours, not a counter that never resets');
});

test('a broken ledger lets mail through rather than silencing it', async () => {
  // Getting this backwards would mean a bookkeeping bug stops the alerts, which
  // is worse than the problem the bookkeeping exists to prevent.
  const mailer = fakeMailer();
  const r = await g.sendGuarded(null, mailer, 'alert', { to: 'a@example.com', subject: 'x' });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(mailer.sent.length, 1);
});

test('an unknown kind still gets a budget', async () => {
  const db = freshLedger();
  const mailer = fakeMailer();
  for (let i = 0; i < 20; i++) await g.sendGuarded(db, mailer, 'something-new', { to: 'a@example.com', subject: 'x' });
  assert.strictEqual(mailer.sent.length, g.DEFAULT_LIMIT, 'a new feature must not get an unlimited allowance');
});
