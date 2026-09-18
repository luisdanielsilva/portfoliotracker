/**
 * Every local module a file uses, that file requires.
 *
 * On 2026-09-15 `mailguard.sendGuarded(...)` was added to server.js in two places and
 * the `require` was not. It is a ReferenceError, thrown inside the request handler and
 * caught by the try/catch that exists so a broken mailer cannot swallow the only way
 * in — so magic-link login and the contact form silently sent nothing for a day, with
 * one line in the pm2 log to show for it. Nothing failed loudly, and no test noticed:
 * the suite runs with SMTP unconfigured, which takes the branch above the call.
 *
 * This is the cheap check that would have caught it — not a substitute for exercising
 * the send path, but it costs nothing and it is exactly the shape of the bug.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** The project's own modules, by the identifier each is conventionally bound to. */
const LOCAL = {
  mailguard: './mailguard',
  authMail: './auth-mail',
  algorithm: './algorithm',
};

const sources = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.js') && !f.startsWith('.') && f !== 'ecosystem.config.js')
  .map(f => ({ name: f, text: fs.readFileSync(path.join(ROOT, f), 'utf-8') }));

test('a file that uses a local module requires it', () => {
  const missing = [];
  for (const { name, text } of sources) {
    for (const [ident, spec] of Object.entries(LOCAL)) {
      if (name === path.basename(spec) + '.js') continue;          // the module itself
      const used = new RegExp(`(?<![\\w.'"\`])${ident}\\.[a-zA-Z_]`).test(text);
      const required = text.includes(`require('${spec}')`) || text.includes(`require("${spec}")`);
      if (used && !required) missing.push(`${name} uses ${ident}. but never requires ${spec}`);
    }
  }
  assert.deepStrictEqual(missing, [], missing.join('\n'));
});

test('the web app sends only through the guarded helpers', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8');
  assert.doesNotMatch(server, /\bauthMailer\.sendMail\(/, 'a direct send would bypass every budget');
  assert.match(server, /require\('\.\/auth-mail'\)/, 'the login link and the contact form go through it');

  const authMail = fs.readFileSync(path.join(ROOT, 'auth-mail.js'), 'utf-8');
  assert.match(authMail, /require\('\.\/mailguard'\)/, 'and that is where the ceiling is applied');
  assert.doesNotMatch(authMail, /mailer\.sendMail\(/, 'even here, sendGuarded does the sending');
});

/**
 * The operational scripts must not run on `require`.
 *
 * `recompute-eur.js` and `split-databases.js` were guarded on 2026-09-16, after one of
 * them was executed by accident. These two were left: loading `check-job-health.js`
 * opens the database, prints a verdict, can email an operator and then calls
 * process.exit() whichever way it goes, and loading `send-backup.js` either exits 1 for
 * want of a file argument or emails the database as an attachment. Either one takes its
 * caller down with it, which is why a missing guard here fails the whole run.
 */
const SCRIPTS = ['check-job-health', 'send-backup', 'recompute-eur', 'split-databases'];

test('requiring an operational script does not run it', () => {
  for (const name of SCRIPTS) {
    const text = fs.readFileSync(path.join(ROOT, `${name}.js`), 'utf-8');
    assert.match(text, /require\.main/, `${name}.js must not act merely because it was loaded`);
  }
  // And the guard has to hold in practice, not just appear in the source. An unguarded
  // script would exit the process here rather than reach the assertion below.
  for (const name of ['check-job-health', 'send-backup']) {
    const m = require(path.join(ROOT, `${name}.js`));
    assert.ok(m && typeof m === 'object', `${name} should export rather than execute`);
  }
});
