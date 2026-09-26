/**
 * The landing page's mock of the alert email is generated from the renderer that
 * sends the real one, and this is what stops it drifting back apart.
 *
 * It had drifted twice before the two were joined: once the digest had grown to
 * four sections while the page showed two and quoted euros where the email
 * quotes dollars, and once the page advertised four kinds of alert for a tool
 * that sends five, leaving out both the algorithm's own section and the weekly
 * standings table. Both times the page was wrong for weeks, because nothing
 * connected the copies.
 *
 * So: add a section to `DIGEST_SECTIONS`, or change a heading, or reword a row,
 * and this fails until `node landing-figures.js --mail` has been run. That
 * command needs no network, which is what makes this cheap enough for CI.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { digestModel, DIGEST_SECTIONS } = require('../price-fetch.js');
const { mailFigure, MAIL_ITEMS, MAIL_STANDINGS, MAIL_DATE } = require('../landing-figures.js');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const between = (a, b) => INDEX.slice(INDEX.indexOf(a) + a.length, INDEX.indexOf(b));
const mock = between('<!-- figure:mail:start -->', '<!-- figure:mail:end -->');

test('the mock on the landing page is what the generator produces', () => {
  assert.ok(mock.includes('lp-mail-body'), 'the figure:mail block is missing from index.html');
  assert.strictEqual(mock.trim(), mailFigure().trim(),
    'index.html is out of date — run: node landing-figures.js --mail');
});

test('every section the digest can send appears on the page', () => {
  // the illustration has to exercise each kind, or the page cannot show them all
  const model = digestModel(MAIL_ITEMS, MAIL_STANDINGS, MAIL_DATE);
  assert.strictEqual(model.sections.length, DIGEST_SECTIONS.length,
    'the landing page\'s example alerts no longer cover every section the digest renders');
  for (const section of DIGEST_SECTIONS) {
    assert.ok(mock.includes(section.title), `the page does not show the "${section.title}" section`);
  }
  assert.ok(model.standings && mock.includes(model.standings.title), 'the page does not show the standings table');
});

test('the currencies on the page are the ones the email quotes', () => {
  const model = digestModel(MAIL_ITEMS, MAIL_STANDINGS, MAIL_DATE);
  for (const row of model.sections.flatMap(s => s.rows)) {
    for (const seg of row.detail.flat()) {
      const money = seg.t.match(/[$€]\s?[\d,.]+/g) || [];
      for (const m of money) {
        assert.ok(mock.includes(m.replace('€', '&euro;')),
          `${row.ticker}: the email quotes ${m} and the page does not`);
      }
    }
  }
});
