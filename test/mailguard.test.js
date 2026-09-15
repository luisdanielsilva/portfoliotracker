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

const freshLedger = () => { const db = new Database(':memory:'); g.ensureEmailLog(db); return db; };

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
  const db = freshLedger();
  const mailer = fakeMailer();
  // A loop that invents a new recipient every time defeats any per-recipient
  // limit. This is the backstop for the failure nobody has thought of yet.
  for (let i = 0; i < g.GLOBAL_DAILY_LIMIT + 60; i++) {
    await g.sendGuarded(db, mailer, 'login', { to: `user${i}@example.com`, subject: 'x' });
  }
  assert.strictEqual(mailer.sent.length, g.GLOBAL_DAILY_LIMIT);
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
