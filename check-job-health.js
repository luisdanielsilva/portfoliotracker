#!/usr/bin/env node
/**
 * Independent watchdog for the daily price-fetch job.
 *
 * The per-run status email only arrives when the job runs. The failures that
 * actually happened here were the opposite: a stale systemd path meant it never
 * started, and a market-hours bug meant it skipped every single time. Neither
 * produced any email at all, and both hid for hours.
 *
 * So this runs separately and complains about *absence*: no successful run
 * recently enough. Run it from cron a few hours after the job's own slot.
 *
 *   node check-job-health.js          check, email if stale, exit 1 if unhealthy
 *   node check-job-health.js --status just print, never email
 *
 * Env: MAX_RUN_AGE_HOURS (default 26), OPS_EMAIL_TO, SMTP_*
 */

const path = require('path');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db');
const MAX_AGE_HOURS = parseFloat(process.env.MAX_RUN_AGE_HOURS || '26');
const statusOnly = process.argv.includes('--status');

function mailer() {
  if (!process.env.SMTP_HOST) return null;
  const port = parseInt(process.env.SMTP_PORT || '25');
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
  });
}

// Requiring this file must not run it. Loading it opens the database, prints a
// verdict, can email an operator, and ends in process.exit() whatever it finds — so
// a stray require() takes its caller down with it. Same guard as recompute-eur.js.
if (require.main !== module) {
  module.exports = { dbPath, MAX_AGE_HOURS };
  return;
}

// Writable, not because this script changes anything it reports on, but because
// the mail ledger has to record what it sends — a cap that cannot write is not a
// cap, it is a suggestion.
const db = new Database(dbPath);


db.pragma('busy_timeout = 5000');
// No table at all means the job has not completed once since this was added.
const hasTable = db.prepare(
  "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='job_runs'"
).get().c > 0;

const lastSuccess = hasTable ? db.prepare(
  "SELECT ran_at, summary FROM job_runs WHERE job='price-fetch' AND status='success' ORDER BY ran_at DESC LIMIT 1"
).get() : null;

const lastAny = hasTable ? db.prepare(
  "SELECT ran_at, status FROM job_runs WHERE job='price-fetch' ORDER BY ran_at DESC LIMIT 1"
).get() : null;

const ageHours = lastSuccess
  ? (Date.now() - new Date(lastSuccess.ran_at + 'Z').getTime()) / 36e5
  : Infinity;

const healthy = ageHours <= MAX_AGE_HOURS;

// A run that keeps skipping is the signature of the market-hours bug returning:
// it looks busy in the logs while never actually fetching anything.
const skipping = !healthy && lastAny && lastAny.status === 'skipped';

console.log(`last successful run : ${lastSuccess ? lastSuccess.ran_at + ' UTC' : 'never'}`);
console.log(`age                 : ${ageHours === Infinity ? 'n/a' : ageHours.toFixed(1) + 'h'} (limit ${MAX_AGE_HOURS}h)`);
console.log(`most recent run     : ${lastAny ? lastAny.ran_at + ' UTC (' + lastAny.status + ')' : 'none recorded'}`);
console.log(`status              : ${healthy ? 'HEALTHY' : 'UNHEALTHY'}`);

if (healthy || statusOnly) {
  db.close();
  process.exit(healthy ? 0 : 1);
}

const detail = lastSuccess
  ? `The last successful price fetch was ${ageHours.toFixed(1)} hours ago (${lastSuccess.ran_at} UTC).`
  : 'There is no record of the price fetch job ever completing successfully.';
const suspicion = skipping
  ? `The most recent run at ${lastAny.ran_at} UTC reported "skipped" rather than failing, which is what a broken market-hours check looks like.`
  : lastAny
    ? `The most recent run at ${lastAny.ran_at} UTC ended as "${lastAny.status}".`
    : 'No run has been recorded at all — the timer may be inactive. Check: systemctl list-timers portfolio-price-fetch.timer';

const body = [
  'Portfolio Tracker — price fetch looks stale',
  '',
  detail,
  suspicion,
  '',
  'Prices and alerts are not updating. Worth checking:',
  '  systemctl list-timers portfolio-price-fetch.timer   (empty listing = not armed)',
  '  journalctl -u portfolio-price-fetch.service -n 50',
  '  cd /var/www/portfoliotracker && node price-fetch.js  (run it by hand)',
].join('\n');

console.log('\n--- sending staleness alert ---\n' + body);

const to = process.env.OPS_EMAIL_TO || process.env.ALERT_EMAIL_TO;
const m = mailer();
if (!m || !to) {
  console.error('No mailer or OPS_EMAIL_TO configured; could not send.');
  db.close();
  process.exit(1);
}

require('./mailguard').sendGuarded(db, m, 'health', {
  from: process.env.ALERT_EMAIL_FROM || 'alerts@portfoliotracker.local',
  to,
  subject: `Portfolio Tracker: price fetch has not succeeded in ${ageHours === Infinity ? 'any recorded run' : ageHours.toFixed(0) + 'h'}`,
  text: body
}, msg => console.log(msg)).then(() => {
  console.log('staleness alert sent to ' + to);
  db.close();
  process.exit(1);
}).catch(e => {
  console.error('could not send staleness alert: ' + e.message);
  db.close();
  process.exit(1);
});
