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

test('server.js in particular reaches mail through mailguard, and has it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8');
  assert.match(src, /require\('\.\/mailguard'\)/, 'the ceiling is not optional for the server');
  assert.match(src, /mailguard\.sendGuarded/, 'and nothing calls sendMail directly');
  assert.doesNotMatch(src, /\bauthMailer\.sendMail\(/, 'a direct send would bypass every budget');
});
