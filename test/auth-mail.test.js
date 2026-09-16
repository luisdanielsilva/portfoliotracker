/**
 * The mail the web app sends — exercised, not inspected.
 *
 * These are the tests that did not exist on 2026-09-15, when `mailguard` was referenced
 * in server.js without its require and magic-link login silently sent nothing for a day.
 * The endpoint kept answering "a login link is on its way", the suite stayed green
 * (it runs with SMTP unconfigured, which takes the branch above the send), and the only
 * evidence was one line in the pm2 log.
 *
 * So the question every test here asks is the one nobody was asking: did a message with
 * the link in it actually reach the mailer?
 */
const test = require('node:test');
const assert = require('node:assert');
const authMail = require('../auth-mail.js');
const g = require('../mailguard.js');
const Database = require('better-sqlite3');

/** A mailer that records instead of sending, and one that fails the way a provider does. */
const recorder = () => { const sent = []; return { sent, sendMail: async m => { sent.push(m); } }; };
const broken = msg => ({ sendMail: async () => { throw new Error(msg); } });

function ledger(users = 20) {
  const db = new Database(':memory:');
  g.ensureEmailLog(db);
  const identity = new Database(':memory:');
  identity.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  for (let i = 1; i <= users; i++) identity.prepare('INSERT INTO users (id) VALUES (?)').run(i);
  db.identity = identity;
  return db;
}

const LINK = 'https://www.singleuseapps.com/portfoliotracker/api/auth/verify?token=abc123';

test('the login link reaches the mailer', async () => {
  const db = ledger(), mailer = recorder();
  const verdict = await authMail.sendMagicLink({ db, mailer, from: 'login@x.test', email: 'a@example.com', link: LINK });

  assert.strictEqual(verdict.sent, true);
  assert.strictEqual(mailer.sent.length, 1, 'this is the assertion that was false all of 2026-09-15');
  assert.strictEqual(mailer.sent[0].to, 'a@example.com');
  assert.match(mailer.sent[0].html, /abc123/, 'a login email without the link in it is not a login email');
  assert.match(mailer.sent[0].subject, /login link/i);
});

test('a login email is recorded against the budget', async () => {
  const db = ledger(), mailer = recorder();
  await authMail.sendMagicLink({ db, mailer, from: 'login@x.test', email: 'a@example.com', link: LINK });
  const kinds = g.recentSummary(db);
  assert.deepStrictEqual(kinds, [{ kind: 'login', n: 1 }]);
});

test('the eleventh link in a day is refused, and the caller is told why', async () => {
  const db = ledger(), mailer = recorder();
  const unsent = [];
  for (let i = 0; i < g.LIMITS.login + 3; i++) {
    await authMail.sendMagicLink({ db, mailer, from: 'login@x.test', email: 'a@example.com', link: LINK,
      onUnsent: r => unsent.push(r) });
  }
  assert.strictEqual(mailer.sent.length, g.LIMITS.login, 'the ceiling applies to login mail like everything else');
  assert.strictEqual(unsent.length, 3);
  assert.match(unsent[0], /login: 10 already sent/);
});

test('a mailer that throws does not break signing in', async () => {
  const db = ledger();
  const unsent = [];
  const verdict = await authMail.sendMagicLink({ db, mailer: broken('554 rejected'), from: 'login@x.test',
    email: 'a@example.com', link: LINK, onUnsent: r => unsent.push(r) });

  assert.strictEqual(verdict.sent, false, 'it reports the failure');
  assert.match(unsent[0], /554 rejected/, 'and hands the caller the link to log instead');
});

test('no mailer configured is reported, not thrown', async () => {
  const unsent = [];
  const verdict = await authMail.sendMagicLink({ db: ledger(), mailer: null, from: 'login@x.test',
    email: 'a@example.com', link: LINK, onUnsent: r => unsent.push(r) });
  assert.strictEqual(verdict.sent, false);
  assert.deepStrictEqual(unsent, ['SMTP not configured']);
});

test('the contact form escapes what a stranger typed', async () => {
  const db = ledger(), mailer = recorder();
  await authMail.sendContact({
    db, mailer, from: 'contact@x.test', to: 'ops@x.test', replyTo: 'them@example.com',
    type: 'Bug', title: 'Broken', name: '<script>alert(1)</script>', email: 'them@example.com',
    message: 'first line\n<img src=x onerror=alert(1)>'
  });
  const html = mailer.sent[0].html;
  assert.doesNotMatch(html, /<script>/, 'the message body is untrusted input arriving in my inbox');
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /first line<br>/, 'newlines still become line breaks');
});

test('a contact message that fails to send throws, so the sender is not thanked for nothing', async () => {
  const db = ledger();
  await assert.rejects(
    authMail.sendContact({ db, mailer: broken('mailbox unavailable'), from: 'c@x.test', to: 'ops@x.test',
      type: 'Bug', title: 't', name: 'n', email: 'e@example.com', message: 'm' }),
    /mailbox unavailable/,
    'this used to be swallowed and answered with success'
  );
});

test('the subject line cannot be used to inject headers', () => {
  const m = authMail.contactMessage({ from: 'c@x.test', to: 'ops@x.test', type: 'Bug',
    title: 'hello\r\nBcc: someone@evil.test', name: 'n', email: 'e@example.com', message: 'm' });
  assert.doesNotMatch(m.subject, /[\r\n]/);
});

test('a contact message stopped by the budget throws too — it did not arrive either', async () => {
  const db = ledger(), mailer = recorder();
  const send = () => authMail.sendContact({ db, mailer, from: 'c@x.test', to: 'ops@x.test',
    type: 'Bug', title: 't', name: 'n', email: 'e@example.com', message: 'm' });
  for (let i = 0; i < g.LIMITS.contact; i++) await send();
  assert.strictEqual(mailer.sent.length, g.LIMITS.contact);
  await assert.rejects(send(), /contact: 30 already sent/);
});
