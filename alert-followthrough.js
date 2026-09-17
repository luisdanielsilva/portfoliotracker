#!/usr/bin/env node
/**
 * What happened after each alert — read-only, prints, changes nothing.
 *
 *   node alert-followthrough.js                 # 30-day window, delivered alerts
 *   node alert-followthrough.js --days 60
 *   node alert-followthrough.js --all           # include alerts that never left
 *   node alert-followthrough.js --list          # every event, one per line
 *
 * Read the rate with the caveats attached, not on its own: a purchase after a
 * buy alert is correlation, a transaction's date is the one the user typed, and
 * a 'watch' rule counts a trade in either direction because the app was never
 * told which way its threshold pointed. With a handful of events per type this
 * is a description of what happened, not a measurement of whether alerts work.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { followThrough, summariseFollowThrough } = require('./alert-log');
require('dotenv').config();

function main(argv) {
  const arg = name => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const windowDays = Number(arg('--days') || 30);
  const onlyDelivered = !argv.includes('--all');
  const dbFile = process.env.DB_PATH || path.join(__dirname, 'portfolio.db');

  const db = new Database(dbFile, { readonly: true });
  const rows = followThrough(db, { windowDays, onlyDelivered });

  console.log(`\n${rows.length} alert(s) ${onlyDelivered ? 'delivered' : 'logged'}, `
    + `follow-through measured over ${windowDays} day(s)\n`);
  if (!rows.length) {
    console.log('Nothing to score yet — the log starts the day this shipped.\n');
    return;
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('alert', 22) + pad('says', 7) + pad('given', 7) + pad('followed', 10) + 'mean days');
  for (const g of summariseFollowThrough(rows)) {
    console.log(pad(g.alertType, 22) + pad(g.direction, 7) + pad(g.given, 7)
      + pad(`${g.followed} (${g.followRatePct.toFixed(0)}%)`, 10)
      + (g.meanDaysToAction === null ? '—' : g.meanDaysToAction.toFixed(1)));
  }

  if (argv.includes('--list')) {
    console.log('');
    for (const r of rows) {
      console.log(`${String(r.fired_at).slice(0, 10)}  ${pad(r.ticker, 9)}${pad(r.alert_type, 22)}`
        + `${pad(r.delivery, 10)}${r.followed ? `→ ${r.action} after ${r.daysToAction.toFixed(1)}d` : '(no trade)'}`);
    }
  }
  console.log('');
}

// Guarded, because two scripts in this directory used to do their work on
// require and one of them was run by accident — see README, Traps.
if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
