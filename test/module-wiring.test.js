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
