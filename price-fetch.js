#!/usr/bin/env node
/**
 * price-fetch.js — Daily price fetching from Yahoo Finance + alert evaluation
 * Fetches closing prices for all tracked tickers and stores in SQLite
 * Evaluates active alerts and sends email notifications
 * Market-aware: only fetches after all relevant markets close
 * Usage: node price-fetch.js
 * Scheduled via systemd timer (every 30 min during trading hours)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const YahooFinance = require('yahoo-finance2').default;
const nodemailer = require('nodemailer');
const { evaluateAlgorithmSignals, standingsFor, isStandingsDay } = require('./algo-alerts');
const { algoRecipients } = require('./algo-settings');
const mailguard = require('./mailguard');
const { identityFor } = require('./identity-db');
const { ensurePriceCurrencyColumns, ensureAlertCurrency, ensureGainRuleType,
        ensureDropFromHighRuleType, ensureAlgorithmAlertSettings, ensureAlertEventLog,
        ensureDataVersion, ensureWatchlist, recentHigh } = require('./db-migrations');
const { recordAlertEvent, markDelivery } = require('./alert-log');
require('dotenv').config();

// Hardcoded until the database split, which is exactly the kind of thing that
// keeps writing to a file nobody reads any more. It honours DB_PATH now, like
// every other entry point.
//
// The systemd unit that runs this job sets DB_PATH explicitly, and it is owned by
// root — so when the split happened it went on pointing at the pre-split file
// that nothing reads any more. This job would have carried on succeeding every
// morning, writing prices nobody would ever see, and the only symptom would have
// been a portfolio that quietly stopped moving.
//
// So: if the configured database still has a `users` table, it is the old one.
// Prefer the split file beside it and say so loudly enough to get the unit fixed.
function resolveDbPath() {
  const configured = process.env.DB_PATH || path.join(__dirname, 'portfolio.db');
  try {
    if (!require('fs').existsSync(configured)) return configured;
    const probe = new Database(configured, { readonly: true });
    const preSplit = probe.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'"
    ).get();
    probe.close();
    if (!preSplit) return configured;

    const beside = path.join(path.dirname(configured), 'portfolio.db');
    if (beside !== configured && require('fs').existsSync(beside)) {
      console.warn(`⚠ DB_PATH points at ${configured}, which is the pre-split database.`);
      console.warn(`  Using ${beside} instead. Fix the systemd unit: DB_PATH must name portfolio.db.`);
      return beside;
    }
    console.warn(`⚠ ${configured} looks like a pre-split database and no portfolio.db sits beside it.`);
  } catch {
    // Unreadable is somebody else's problem; let the normal open report it.
  }
  return configured;
}
const dbPath = resolveDbPath();
const logsDir = path.join(__dirname, 'logs');
const logFile = path.join(logsDir, 'price-fetch.log');

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  fs.appendFileSync(logFile, logMessage + '\n');
}

function initEmailTransporter() {
  if (!process.env.SMTP_HOST) {
    log('⚠ SMTP not configured, alerts will be logged only (not emailed)');
    return null;
  }

  const port = parseInt(process.env.SMTP_PORT || '25');
  // Port 465 = implicit TLS (secure: true)
  // Port 587 = STARTTLS after connect (secure: false)
  const secure = port === 465;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: port,
    secure: secure,
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD
    } : undefined
  });
}

/* ================= alert digest email =================
 * One email per user per run, listing every rule that fired — dips and price
 * levels together — rather than one email per alert. Table layout with inline
 * styles, because that is what mail clients reliably render.
 */

const MAIL = {
  ground: '#f6f5f1', surface: '#ffffff', ink: '#1b1d21', muted: '#6b6e76',
  faint: '#9a9ca2', hair: '#e3e0d7', accent: '#2a78d6', neg: '#c0473e', pos: '#3f8f5b',
  sans: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  mono: "SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace",
  serif: "Georgia,'Times New Roman',serif"
};

const eur = n => '€' + n.toFixed(2);

// Prices are shown in the currency the market quotes them in; only aggregated
// portfolio value is expressed in euros.
const CURRENCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', CHF: 'CHF ', JPY: '¥', CAD: 'CA$', AUD: 'A$' };
function fmtNative(amount, currency) {
  if (amount == null) return '—';
  const sym = CURRENCY_SYMBOL[currency];
  return sym ? `${sym}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency || ''}`.trim();
}

function appLink() {
  return (process.env.APP_BASE_URL || 'https://www.singleuseapps.com/portfoliotracker').replace(/\/$/, '') + '/';
}

// One row: ticker and headline figure on top, the context underneath.
/** 1st, 2nd, 3rd, 4th — including the 11th/12th/13th exceptions. */
function ordinal(n) {
  const v = Math.round(n);
  const rem100 = v % 100;
  if (rem100 >= 11 && rem100 <= 13) return v + 'th';
  return v + (['th', 'st', 'nd', 'rd'][v % 10] || 'th');
}

/*
 * The digest as data, before anything decides how it looks.
 *
 * There are two renderers of this content: the email below, and the mock of the
 * email on the landing page. They used to be two hand-maintained copies of one
 * design and they drifted twice — most recently the page advertised four kinds
 * of alert for a tool that sends five, and omitted the weekly standings table
 * entirely. So the wording, the grouping and the figures live here, and the two
 * renderers differ only in markup. Adding a kind means adding it once, and the
 * landing page picks it up when `landing-figures.js --mail` is run (a test fails
 * if it has not been).
 *
 * A row's `detail` is a list of lines, each a list of segments. A segment with
 * `mono` is the figure the line turns on: the email sets it in the mono face in
 * ink, the page gives it a <b>, which its stylesheet does the same way.
 */
function digestRowModel(item) {
  if (item.kind === 'dip') {
    // Measured against what you paid, which is tracked in euros.
    return {
      ticker: item.ticker,
      figure: { text: `\u2212${item.dropPct.toFixed(1)}%`, tone: 'neg' },
      detail: [
        [{ t: `${eur(item.price)} now \u00b7 your average cost ${eur(item.avgCost)}` }],
        [{ t: 'Back to break-even at ' }, { t: eur(item.avgCost), mono: true }]
      ]
    };
  }
  if (item.kind === 'high') {
    return {
      ticker: item.ticker,
      figure: { text: `\u2212${item.dropPct.toFixed(1)}%`, tone: 'neg' },
      detail: [
        [{ t: `${fmtNative(item.price, item.currency)} now \u00b7 52-week high ${fmtNative(item.peak, item.currency)}` }],
        [{ t: 'Past your ' }, { t: `\u2212${item.threshold}%`, mono: true }, { t: ' trailing level' }]
      ]
    };
  }
  if (item.kind === 'algo') {
    // The one thing the algorithm emails about. No threshold to quote, because
    // the user did not set one — so the detail line says what the windows saw.
    const pr = item.percentiles || {};
    const at = k => (pr[k] === undefined ? '\u2014' : ordinal(pr[k]));
    const detail = [
      [{ t: `${fmtNative(item.price, item.currency)} now \u00b7 held ${item.holdDays} day${item.holdDays === 1 ? '' : 's'} running` }],
      [{ t: `Ranks ${at('6M')} / ${at('1Y')} / ${at('2Y')} percentile against its own 6-month, 1-year and 2-year history` }]
    ];
    if (item.gainPct !== null && item.gainPct !== undefined) {
      detail.push([{ t: `You are ${item.gainPct >= 0 ? 'up' : 'down'} ${Math.abs(item.gainPct).toFixed(1)}% on this holding` }]);
    }
    return { ticker: item.ticker, figure: { text: 'very strong buy', tone: 'pos' }, detail };
  }
  if (item.kind === 'gain') {
    return {
      ticker: item.ticker,
      figure: { text: `+${item.gainPct.toFixed(1)}%`, tone: 'pos' },
      detail: [
        [{ t: `${eur(item.price)} now \u00b7 your average cost ${eur(item.avgCost)}` }],
        [{ t: 'Past your ' }, { t: `+${item.threshold}%`, mono: true }, { t: ' target' }]
      ]
    };
  }
  // A price level, shown in the currency its market quotes.
  const above = item.kind === 'price_above';
  const away = Math.abs((item.price - item.threshold) / item.threshold) * 100;
  const cur = item.currency || 'USD';
  return {
    ticker: item.ticker,
    figure: { text: `${above ? 'above' : 'below'} ${fmtNative(item.threshold, cur)}`, tone: above ? 'pos' : 'accent' },
    detail: [[{ t: `${fmtNative(item.price, cur)} now \u00b7 ${away.toFixed(1)}% ${above ? 'over' : 'under'} the level you set` }]]
  };
}

/** Section order and headings — the one place either renderer learns them. */
const DIGEST_SECTIONS = [
  { key: 'algo',   title: 'The algorithm sees an unusually cheap moment', match: i => i.kind === 'algo' },
  { key: 'dip',    title: 'Dips below your average cost',                 match: i => i.kind === 'dip' },
  { key: 'gain',   title: 'Up on what you paid',                          match: i => i.kind === 'gain' },
  { key: 'high',   title: 'Down from their recent high',                  match: i => i.kind === 'high' },
  { key: 'level',  title: 'Price levels you set',                         match: i => !['dip','gain','high','algo'].includes(i.kind) }
];

/**
 * @param {Date} now  the clock, so a generated page can pin a date and not
 *                    rewrite itself every morning.
 */
function digestModel(items, standings = [], now = new Date()) {
  return {
    heading: items.length === 0 ? 'Where things stand'
      : items.length === 1 ? 'One alert triggered' : `${items.length} alerts triggered`,
    when: now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
    sections: DIGEST_SECTIONS
      .map(sec => ({ key: sec.key, title: sec.title, rows: items.filter(sec.match).map(digestRowModel) }))
      .filter(sec => sec.rows.length),
    standings: standings.length ? {
      title: 'Where things stand this week',
      note: 'Everything the algorithm is not silent about. Nothing here needs doing.',
      rows: standings.map(s => ({
        ticker: s.ticker,
        verdict: `${s.direction.toLowerCase()} \u00b7 ${s.tier === 'VeryStrong' ? 'very strong' : s.tier.toLowerCase()}`,
        tone: s.direction === 'Buy' ? 'pos' : 'neg',
        confidence: `${Math.round(s.confidence)}%`
      }))
    } : null
  };
}

// One row: ticker and headline figure on top, the context underneath.
function digestRow(row, isLast) {
  const border = isLast ? '' : `border-bottom:1px solid ${MAIL.hair};`;
  const tone = { neg: MAIL.neg, pos: MAIL.pos, accent: MAIL.accent };
  const headline = `<span style="color:${tone[row.figure.tone]}">${row.figure.text}</span>`;
  const detail = row.detail
    .map(line => line.map(seg => (seg.mono
      ? `<span style="color:${MAIL.ink};font-family:${MAIL.mono}">${seg.t}</span>`
      : seg.t)).join(''))
    .join('<br>');

  return `<tr><td style="padding:14px 0;${border}">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font:600 15px/1.3 ${MAIL.sans};color:${MAIL.ink}">${row.ticker}</td>
      <td align="right" style="font:600 14px/1.3 ${MAIL.mono}">${headline}</td>
    </tr><tr>
      <td colspan="2" style="padding-top:5px;font:400 13px/1.6 ${MAIL.sans};color:${MAIL.muted}">${detail}</td>
    </tr></table>
  </td></tr>`;
}

function digestSection(section) {
  return `<tr><td style="padding:24px 0 0;font:600 11px/1 ${MAIL.sans};letter-spacing:.09em;text-transform:uppercase;color:${MAIL.faint}">${section.title}</td></tr>`
    + `<tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0">`
    + section.rows.map((r, i) => digestRow(r, i === section.rows.length - 1)).join('')
    + `</table></td></tr>`;
}


/**
 * The weekly standings: where every holding sits, both directions.
 *
 * This is the only place the sell side appears, and it appears as a table. A
 * summary cannot train you to ignore it, because it never asks for anything.
 */
function renderStandings(model) {
  if (!model) return '';
  const tone = { pos: MAIL.pos, neg: MAIL.neg };
  const rows = model.rows.map(r => `<tr>
      <td style="padding:7px 0;font:600 13px/1.3 ${MAIL.sans};color:${MAIL.ink}">${r.ticker}</td>
      <td align="right" style="padding:7px 0;font:400 13px/1.3 ${MAIL.sans};color:${tone[r.tone]}">${r.verdict}</td>
      <td align="right" style="padding:7px 0 7px 14px;font:400 13px/1.3 ${MAIL.mono};color:${MAIL.faint}">${r.confidence}</td>
    </tr>`).join('');
  return `<tr><td style="padding:24px 0 0;font:600 11px/1 ${MAIL.sans};letter-spacing:.09em;text-transform:uppercase;color:${MAIL.faint}">${model.title}</td></tr>`
    + `<tr><td style="padding-top:4px;font:400 12px/1.6 ${MAIL.sans};color:${MAIL.faint}">${model.note}</td></tr>`
    + `<tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>`;
}

function renderAlertDigest(items, standings = []) {
  const { heading, when, sections, standings: standingsModel } = digestModel(items, standings);

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${MAIL.ground}">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${MAIL.ground};padding:28px 12px">
<tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${MAIL.surface};border:1px solid ${MAIL.hair};border-radius:12px">
    <tr><td style="padding:26px 26px 0">
      <div style="font:600 10.5px/1 ${MAIL.sans};letter-spacing:.14em;text-transform:uppercase;color:${MAIL.faint}">Portfolio Tracker</div>
      <div style="margin:12px 0 3px;font:400 25px/1.2 ${MAIL.serif};color:${MAIL.ink}">${heading}</div>
      <div style="font:400 13px/1.5 ${MAIL.sans};color:${MAIL.muted}">${when}, after the close</div>
    </td></tr>
    <tr><td style="padding:0 26px">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        ${sections.map(digestSection).join('\n        ')}
        ${renderStandings(standingsModel)}
      </table>
    </td></tr>
    <tr><td style="padding:24px 26px 26px">
      <a href="${appLink()}" style="display:inline-block;background:${MAIL.accent};color:#ffffff;text-decoration:none;font:500 14px/1 ${MAIL.sans};padding:12px 22px;border-radius:8px">Open Portfolio Tracker</a>
      <div style="margin-top:18px;padding-top:16px;border-top:1px solid ${MAIL.hair};font:400 12px/1.6 ${MAIL.sans};color:${MAIL.faint}">
        Each rule emails you at most once in 24 hours. Prices are the latest close, shown in the
        currency their market quotes; dips are measured against your average cost in euros.
        Change or switch off any rule in the app.
      </div>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

function renderAlertDigestText(items, standings = []) {
  const lines = [items.length === 0 ? 'Where things stand\n'
    : `${items.length === 1 ? 'One alert' : items.length + ' alerts'} triggered\n`];
  for (const i of items) {
    if (i.kind === 'algo') {
      const pr = i.percentiles || {};
      const at = k => (pr[k] === undefined ? '-' : ordinal(pr[k]));
      lines.push(`${i.ticker}  very strong buy, held ${i.holdDays} day${i.holdDays === 1 ? '' : 's'} running`);
      lines.push(`  ${fmtNative(i.price, i.currency)} now. Ranks ${at('6M')} / ${at('1Y')} / ${at('2Y')} percentile`
        + ` against its own 6-month, 1-year and 2-year history.`);
      if (i.gainPct !== null && i.gainPct !== undefined) {
        lines.push(`  You are ${i.gainPct >= 0 ? 'up' : 'down'} ${Math.abs(i.gainPct).toFixed(1)}% on this holding.`);
      }
    } else if (i.kind === 'dip') {
      lines.push(`${i.ticker}  -${i.dropPct.toFixed(1)}% below your average`);
      lines.push(`  ${eur(i.price)} now, average cost ${eur(i.avgCost)}. Break-even at ${eur(i.avgCost)}.`);
    } else if (i.kind === 'high') {
      lines.push(`${i.ticker}  -${i.dropPct.toFixed(1)}% from its 52-week high`);
      lines.push(`  ${fmtNative(i.price,i.currency)} now, high ${fmtNative(i.peak,i.currency)}.`);
    } else if (i.kind === 'gain') {
      lines.push(`${i.ticker}  +${i.gainPct.toFixed(1)}% on what you paid (target +${i.threshold}%)`);
      lines.push(`  ${eur(i.price)} now, average cost ${eur(i.avgCost)}.`);
    } else {
      const above = i.kind === 'price_above';
      const cur = i.currency || 'USD';
      lines.push(`${i.ticker}  ${above ? 'above' : 'below'} ${fmtNative(i.threshold, cur)}`);
      lines.push(`  ${fmtNative(i.price, cur)} now.`);
    }
  }
  if (standings.length) {
    lines.push('\nWhere things stand this week (nothing here needs doing):');
    for (const s of standings) {
      const word = s.tier === 'VeryStrong' ? 'very strong' : s.tier.toLowerCase();
      lines.push(`  ${s.ticker.padEnd(9)} ${s.direction.toLowerCase()} · ${word}  ${Math.round(s.confidence)}%`);
    }
  }
  lines.push(`\nOpen Portfolio Tracker: ${appLink()}`);
  lines.push('Each rule emails you at most once in 24 hours.');
  return lines.join('\n');
}

/* ================= job run log + daily status report =================
 * Two separate faults (a stale systemd path, then a market-hours bug) each hid
 * for hours because a job that never ran looks exactly like a quiet one. Every
 * run now leaves a row behind, and — while enabled — emails what it did.
 */

/* ================= exchange rates =================
 * The portfolio total is expressed in euros, so every non-euro price has to be
 * converted. That used to be a hard-coded 0.92, which was ~7% off the real rate
 * and simply wrong for any currency that is not USD.
 *
 * Yahoo quotes FX as tickers: EURUSD=X is euros-per-... no — it is how many USD
 * one EUR buys (1.1641). The multiplier this code wants is the inverse.
 */

/**
 * One rate per currency per day, rewritten if the day's rate is fetched again.
 *
 * Exported and shared with recompute-eur.js because there used to be two copies of
 * this statement and they drifted: both set `updated_at`, a column `exchange_rates`
 * has never had — the pre-split database called it that, `schema.sqlite.sql` calls
 * it `created_at`, and the 2026-09-14 split rebuilt the table from the schema.
 * SQLite resolves column names at prepare() time, and this is prepared before the
 * loop that would have fallen back to the last known rate, so the whole job died on
 * 2026-09-16 rather than degrading. The timestamp is simply gone: nothing reads it,
 * and `created_at` on a row that was just rewritten would be a lie.
 */
const RATE_UPSERT_SQL = `
  INSERT INTO exchange_rates (from_currency, to_currency, rate, date)
  VALUES (?, 'EUR', ?, ?)
  ON CONFLICT(from_currency, to_currency, date)
    DO UPDATE SET rate = excluded.rate
`;

/**
 * Fetches today's rate for each currency and stores it. The returned `rates`
 * map is no longer consulted to price anything written: since issue #12 every
 * price row goes through `backfillTicker`, which converts each bar with
 * `makeRateLookup` reading straight from `exchange_rates` for the bar's own
 * date (carrying the most recent earlier rate forward, or writing nothing if
 * there is truly no rate at all — "better nothing than a guess"). There used
 * to be a fallback constant here (`FALLBACK_USD_TO_EUR`) for when Yahoo's FX
 * quote failed. It never reached `exchange_rates`, but the old quote path
 * priced rows with `rates[currency]`, so on a day with no rate it did decide
 * `price_eur`. That path is gone and nothing reads `rates` any more, so the
 * constant was removed: a missing rate now means no row rather than a row
 * priced at a guess. The log lines below are the only thing this loop is
 * now for.
 */
async function fetchExchangeRates(yahooFinance, db, currencies) {
  const rates = { EUR: 1 };
  const upsert = db.prepare(RATE_UPSERT_SQL);
  // the same day SQLite itself would have stamped, asked for once rather than per row
  const today = db.prepare("SELECT DATE('now') AS d").get().d;
  // Falling back to the most recent stored rate beats a constant from months ago.
  const lastKnown = db.prepare(`
    SELECT rate FROM exchange_rates
    WHERE from_currency = ? AND to_currency = 'EUR'
    ORDER BY date DESC LIMIT 1
  `);

  for (const currency of currencies) {
    if (currency === 'EUR') continue;
    try {
      const quote = await yahooFinance.quote(`EUR${currency}=X`);
      const eurPerUnit = quote && quote.regularMarketPrice;
      if (!eurPerUnit) throw new Error('no rate returned');

      const toEur = parseFloat((1 / eurPerUnit).toFixed(6));
      rates[currency] = toEur;
      upsert.run(currency, toEur, today);
      log(`  💱 1 ${currency} = €${toEur.toFixed(4)}`);
    } catch (err) {
      const prev = lastKnown.get(currency);
      rates[currency] = prev ? prev.rate : null;
      log(`  ⚠ ${currency} rate unavailable (${err.message}); `
        + (prev ? `last known rate is €${prev.rate.toFixed(4)} (unchanged, not rewritten today)` : 'no rate stored for this currency yet'));
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return rates;
}

function ensureJobRunsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('success','skipped','failed')),
    summary TEXT,
    ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_job_runs_job_time ON job_runs(job, ran_at DESC)');
}

function recordRun(db, status, summary) {
  try {
    ensureJobRunsTable(db);
    db.prepare('INSERT INTO job_runs (job, status, summary) VALUES (?, ?, ?)')
      .run('price-fetch', status, JSON.stringify(summary || {}));
  } catch (e) {
    log(`  ⚠ could not record job run: ${e.message}`);
  }
}

// Set PRICE_FETCH_REPORT=false in .env to stop the per-run status email without
// touching code. The job-health watcher keeps working either way.
const RUN_REPORT_ENABLED = process.env.PRICE_FETCH_REPORT !== 'false';

function renderRunReport(status, d) {
  const tone = status === 'success' ? MAIL.pos : status === 'skipped' ? MAIL.muted : MAIL.neg;
  const heading = status === 'success' ? 'Prices updated'
    : status === 'skipped' ? 'Run skipped'
    : 'Run failed';

  const row = (label, value) => `<tr>
    <td style="padding:7px 0;font:400 13px/1.5 ${MAIL.sans};color:${MAIL.muted};width:42%">${label}</td>
    <td style="padding:7px 0;font:500 13px/1.5 ${MAIL.mono};color:${MAIL.ink}">${value}</td></tr>`;

  const tickerLines = (d.results || []).map(r => `<tr><td colspan="2" style="padding:3px 0;font:400 12.5px/1.5 ${MAIL.mono};color:${r.ok ? MAIL.muted : MAIL.neg}">
    ${r.ok ? '✓' : '⚠'} ${r.ticker}${r.ok ? ' — ' + fmtNative(r.priceNative, r.currency) : ' — ' + (r.error || 'no price data')}</td></tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${MAIL.ground}">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${MAIL.ground};padding:28px 12px"><tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:${MAIL.surface};border:1px solid ${MAIL.hair};border-radius:12px">
    <tr><td style="padding:24px 24px 0">
      <div style="font:600 10.5px/1 ${MAIL.sans};letter-spacing:.14em;text-transform:uppercase;color:${MAIL.faint}">Portfolio Tracker · daily job</div>
      <div style="margin:10px 0 3px;font:400 22px/1.2 ${MAIL.serif};color:${tone}">${heading}</div>
      <div style="font:400 12.5px/1.5 ${MAIL.sans};color:${MAIL.muted}">${new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}</div>
    </td></tr>
    <tr><td style="padding:14px 24px 0">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        ${row('Market check', d.reason || '—')}
        ${status === 'success' ? row('Prices fetched', `${d.successCount} of ${d.tickerCount}`) : ''}
        ${status === 'success' ? row('Alerts evaluated', String(d.alertsChecked ?? 0)) : ''}
        ${status === 'success' ? row('Alerts triggered', String(d.alertsTriggered ?? 0)) : ''}
        ${d.error ? row('Error', d.error) : ''}
        ${row('Duration', d.durationMs != null ? (d.durationMs / 1000).toFixed(1) + 's' : '—')}
      </table>
    </td></tr>
    ${tickerLines ? `<tr><td style="padding:12px 24px 0"><div style="padding-top:12px;border-top:1px solid ${MAIL.hair}">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">${tickerLines}</table></div></td></tr>` : ''}
    <tr><td style="padding:18px 24px 24px">
      <div style="padding-top:14px;border-top:1px solid ${MAIL.hair};font:400 11.5px/1.6 ${MAIL.sans};color:${MAIL.faint}">
        Sent after every run so a silent failure is visible. Turn it off with
        <span style="font-family:${MAIL.mono}">PRICE_FETCH_REPORT=false</span> in .env.
      </div>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

/**
 * How long a repeated failure stays quiet after its first report.
 *
 * On 2026-09-15 a crash on the first line of work met `Restart=on-failure` with
 * `RestartSec=30` and no start limit: the job failed **453 times between 08:00 and
 * 13:00**, emailed a report each time, and exhausted the account's daily sending
 * quota. The alert emails that users actually depend on then could not be sent
 * either — a monitoring feature had taken out the thing it was monitoring.
 *
 * One report per hour is enough to notice a broken job. It is also the difference
 * between being told and being drowned.
 */
const FAILURE_REPORT_QUIET_HOURS = 1;

/** Has a failure already been reported recently enough that another adds nothing? */
function failureRecentlyReported(db, withinHours = FAILURE_REPORT_QUIET_HOURS) {
  if (!db) return false;
  try {
    const row = db.prepare(`
      SELECT 1 FROM job_runs
      WHERE status = 'failed'
        AND julianday('now') - julianday(ran_at) < ?
      LIMIT 1
    `).get(withinHours / 24);
    return !!row;
  } catch {
    return false;   // never let the throttle itself be the reason nothing is sent
  }
}

async function sendRunReport(mailer, status, d, db = null) {
  if (!RUN_REPORT_ENABLED) return;

  // A job that cannot start will be restarted for as long as systemd feels like
  // it. Reporting every attempt turns one bug into an outage of the mail channel.
  if (status === 'failed' && failureRecentlyReported(db)) {
    log('  🔇 failure already reported within the hour — not sending another');
    return;
  }
  // Operational mail: how the job went. Goes to whoever runs the server, never to a user.
  const to = process.env.OPS_EMAIL_TO || process.env.ALERT_EMAIL_TO;
  if (!mailer || !to) { log('  📌 run report not sent (no mailer or OPS_EMAIL_TO)'); return; }
  const subject = status === 'success'
    ? `Prices updated — ${d.successCount}/${d.tickerCount} tickers, ${d.alertsTriggered ?? 0} alert(s)`
    : status === 'skipped' ? `Price fetch skipped — ${d.reason}`
    : `Price fetch FAILED — ${d.error}`;
  try {
    const r = await mailguard.sendGuarded(db, mailer, 'run-report',
      { from: process.env.ALERT_EMAIL_FROM || 'alerts@portfoliotracker.local',
        to, subject, html: renderRunReport(status, d) }, log);
    if (r.sent) log(`  ✉ run report sent to ${to}`);
  } catch (e) {
    log(`  ❌ run report failed: ${e.message}`);
  }
}

function alertSubject(items) {
  if (items.length === 0) return 'Where your holdings stand this week';
  if (items.length === 1) {
    const i = items[0];
    if (i.kind === 'algo') return `${i.ticker} looks unusually cheap by its own history`;
    if (i.kind === 'dip') return `${i.ticker} is ${i.dropPct.toFixed(1)}% below your average cost`;
    if (i.kind === 'gain') return `${i.ticker} is up ${i.gainPct.toFixed(1)}% on what you paid`;
    if (i.kind === 'high') return `${i.ticker} is ${i.dropPct.toFixed(1)}% off its 52-week high`;
    return `${i.ticker} ${i.kind === 'price_above' ? 'rose above' : 'fell below'} ${fmtNative(i.threshold, i.currency || 'USD')}`;
  }
  return `${items.length} alerts: ${[...new Set(items.map(i => i.ticker))].join(', ')}`;
}

// Average cost per share (EUR) — shared with the server so the figure a dip alert
// fires on and the figure the app displays cannot drift apart. See portfolio.js.
const { getAvgCostPerShare: avgCostFor } = require('./portfolio');

// What a Dip or Target rule measures from: the cost basis for a holding, or the
// recorded reference price for a stock that is only watched. Holdings always
// win, so this returns exactly what the old cost-basis lookup returned for every
// alert that existed before the watchlist — see reference-price.js.
const { referenceFor, allWatchedTickers } = require('./reference-price');

// Map ticker to exchange (common US tech stocks)
// Extend as needed for other exchanges
function getTickerExchange(ticker) {
  const exchanges = {
    // US markets (NYSE/NASDAQ)
    'TSLA': 'us',
    'AMD': 'us',
    'MSFT': 'us',
    'MICROSOFT': 'us',
    'AAPL': 'us',
    'GOOGL': 'us',
    'META': 'us',
    'NVDA': 'us',
    // Expand as needed for other exchanges
    // 'ASML': 'euronext', // Amsterdam
    // 'LLOY': 'lse',      // London
  };
  return exchanges[ticker] || 'us'; // Default to US if unknown
}

// Check if all relevant markets are closed
// Returns { isClosed: boolean, reason: string }
function areMarketsClosedForFetch(when) {
  // Takes the moment as an argument so it can be asked about all 24 hours of a weekday
  // and a weekend without waiting a week. Defaults to now, which is every caller in the app.
  const now = when || new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const dayOfWeek = now.getUTCDay(); // 0=Sunday, 6=Saturday

  // Skip weekends
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return { isClosed: true, reason: 'Weekend' };
  }

  // US Markets: 9:30 AM - 4:00 PM ET
  // ET in UTC: EST = UTC-5, EDT = UTC-4
  // 4:00 PM EDT = 20:00 UTC, 4:00 PM EST = 21:00 UTC
  // We'll use 21:00 UTC to safely cover both (and give data time to propagate)
  // 9:30 AM EDT = 13:30 UTC, 9:30 AM EST = 14:30 UTC

  const usMarketCloseUTC = 21; // 9:00 PM UTC (after 4:00 PM ET close)
  const usMarketOpenUTC = 13;  // opens 13:30 UTC at the earliest; stop short of the half hour

  // The safe window wraps around midnight: from the close at 21:00 UTC through to the
  // next open. The pre-open hours count as closed because the previous session's close
  // is already final — which is what the daily 09:00 UTC timer depends on. Testing only
  // `utcHour < close` treated 09:00 as "still trading" and skipped every scheduled run.
  if (utcHour >= usMarketCloseUTC) {
    return { isClosed: true, reason: 'US markets closed for the day' };
  }
  if (utcHour < usMarketOpenUTC) {
    return { isClosed: true, reason: 'Before US open — the last close is final' };
  }

  const hoursUntilClose = usMarketCloseUTC - utcHour;
  const minutesUntilClose = Math.round(hoursUntilClose * 60 - utcMinute);
  return {
    isClosed: false,
    reason: `US markets still trading (closes in ~${minutesUntilClose} min at 21:00 UTC / 4:00 PM ET)`
  };
}


/* ---- reaching across the split ----
 *
 * The financial database holds an opaque key where a person used to be. Anything
 * that has to *tell* somebody something — an alert email, a digest — needs the
 * address, and the address is deliberately somewhere else. This is the only place
 * that crosses, and it crosses in one direction: key to email, never the reverse.
 *
 * Finding the identity database is no longer done here — `identity-db.js` does it,
 * because mailguard needs the same file to count how many people are registered.
 */

/** key -> email, as a plain lookup. Returns a function so callers cannot hold the table. */
function emailsByKey(identityDb) {
  const map = new Map();
  if (identityDb) {
    try {
      for (const r of identityDb.prepare('SELECT user_key, email FROM users').all()) map.set(r.user_key, r.email);
    } catch (err) {
      log(`  ⚠ could not read identities: ${err.message}`);
    }
  }
  return key => map.get(key) || null;
}

async function evaluateAlerts(db, mailer, identityDb = identityFor(db)) {
  log('\n📢 Evaluating active alerts...');

  // Join to users so each alert is emailed to the person who created it.
  // This used to be one JOIN. It cannot be any more: the addresses live in a
  // different file on purpose, and the whole point is that the financial database
  // cannot name anybody. So the rows come from here and the addresses from there,
  // joined in memory by the opaque key.
  const getAlertsStmt = db.prepare(`
    SELECT a.id, a.user_id, a.ticker, a.rule_type, a.threshold, a.currency, a.last_triggered_at
    FROM alerts a WHERE a.enabled = 1
  `);
  const emailOf = emailsByKey(identityDb);

  const getPriceStmt = db.prepare(`
    SELECT price_eur, price_native, currency FROM prices
    WHERE ticker = ?
    ORDER BY price_date DESC
    LIMIT 1
  `);

  const updateAlertStmt = db.prepare(`
    UPDATE alerts
    SET last_triggered_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const alerts = getAlertsStmt.all();
  let triggeredCount = 0;
  const byRecipient = new Map(); // email -> triggered items, sent as one digest each

  // The Algorithm tab's own alert rides in the same digest rather than sending a
  // second email. It is not a row in `alerts` — see algo-alerts.js for why — so
  // it is evaluated separately and merged here.
  const algoItems = evaluateAlgorithmSignals(db, new Date(), log, identityDb);
  for (const [recipient, items] of algoItems) {
    if (!byRecipient.has(recipient)) byRecipient.set(recipient, []);
    byRecipient.get(recipient).push(...items);
    triggeredCount += items.length;
  }

  // Once a week the standings go out whether or not anything fired, so the sell
  // side stays visible without ever demanding attention.
  const standingsByRecipient = new Map();
  if (isStandingsDay()) {
    // Everyone the signal speaks to, including accounts with no settings row
    // (issue #34) — the same list the very-strong-buy alert uses.
    for (const u of algoRecipients(db, identityDb)) {
      const email = u.email;
      const rows = standingsFor(db, u.id);
      if (!rows.length) continue;
      standingsByRecipient.set(email, rows);
      if (!byRecipient.has(email)) byRecipient.set(email, []);
    }
  }

  for (const alert of alerts) {
    try {
      const price = getPriceStmt.get(alert.ticker);

      if (!price) {
        log(`  ⚠ No price data for ${alert.ticker}, skipping alert ${alert.id}`);
        continue;
      }

      const threshold = alert.threshold;
      const rule = alert.rule_type;
      let triggered = false;
      let reference = null;      // { eur, basis } — cost basis, or a watch price
      let highPeak = null;

      // A price threshold is compared in the market's own currency, which is what
      // the user set it in. A dip is measured against the euro cost basis, because
      // that is the currency the money actually went out in.
      const marketCurrency = price.currency || 'USD';
      const nativePrice = price.price_native != null ? price.price_native : price.price_eur;
      const currentPrice = price.price_eur;

      if (rule === 'price_above' && nativePrice > threshold) {
        triggered = true;
      } else if (rule === 'price_below' && nativePrice < threshold) {
        triggered = true;
      } else if (rule === 'dip_from_avg_cost') {
        reference = referenceFor(db, alert.user_id, alert.ticker);
        if (reference && currentPrice <= reference.eur * (1 - threshold / 100)) {
          triggered = true;
        }
      } else if (rule === 'drop_from_high') {
        // Trailing: how far below its own 52-week high the price has fallen. The one
        // rule that protects a gain — cost basis says nothing once a holding has run.
        const high = recentHigh(db, alert.ticker);
        if (high && nativePrice <= high.peak * (1 - threshold / 100)) {
          triggered = true;
          highPeak = high.peak;
        }
      } else if (rule === 'gain_from_avg_cost') {
        // The sell-side mirror: fires when the holding is up `threshold`% on what
        // was actually paid. Measured in euros for the same reason a dip is — that
        // is the currency the money left in. On a watched stock there is nothing
        // to sell, and the same rule reads as "it ran up this far from where I
        // first looked at it" — the one that got away.
        reference = referenceFor(db, alert.user_id, alert.ticker);
        if (reference && currentPrice >= reference.eur * (1 + threshold / 100)) {
          triggered = true;
        }
      }

      if (!triggered) continue;

      // Check 24h throttle
      if (alert.last_triggered_at) {
        const lastTriggered = new Date(alert.last_triggered_at);
        const now = new Date();
        const hoursSince = (now - lastTriggered) / (1000 * 60 * 60);

        if (hoursSince < 24) {
          log(`  ⏳ Alert ${alert.id} (${alert.ticker}) throttled (triggered ${hoursSince.toFixed(1)}h ago)`);
          continue;
        }
      }

      // Collect rather than send: everything that fired for one person goes out
      // as a single digest below, so three rules never mean three emails.
      // A digest is somebody's portfolio. It goes to the account that created the rule
      // and nowhere else — the old fallback would have posted one person's holdings to
      // the operator's inbox if their user row ever lost its address.
      const recipient = emailOf(alert.user_id);
      if (!recipient) {
        log(`  ⚠ Alert ${alert.id} (${alert.ticker}) has no owner address, skipping`);
        continue;
      }
      let item;
      if (rule === 'dip_from_avg_cost') {
        item = { kind: 'dip', ticker: alert.ticker, price: currentPrice, avgCost: reference.eur,
                 basis: reference.basis,
                 dropPct: ((reference.eur - currentPrice) / reference.eur) * 100 };
      } else if (rule === 'drop_from_high') {
        item = { kind: 'high', ticker: alert.ticker, price: nativePrice, peak: highPeak,
                 dropPct: ((highPeak - nativePrice) / highPeak) * 100, threshold,
                 currency: alert.currency || marketCurrency };
      } else if (rule === 'gain_from_avg_cost') {
        item = { kind: 'gain', ticker: alert.ticker, price: currentPrice, avgCost: reference.eur,
                 basis: reference.basis,
                 gainPct: ((currentPrice - reference.eur) / reference.eur) * 100, threshold };
      } else {
        item = { kind: rule, ticker: alert.ticker, price: nativePrice, threshold,
                 currency: alert.currency || marketCurrency };
      }

      // Written before the digest is built, and before the throttle is stamped,
      // so the log holds an alert even if this process dies mid-run. The detail
      // is whatever the reader is about to be shown that the columns do not
      // already hold — a row should be readable years later without re-deriving
      // it from prices that may since have been restated.
      item.eventId = recordAlertEvent(db, {
        userId: alert.user_id, ticker: alert.ticker, source: 'rule',
        alertType: rule, alertId: alert.id,
        priceNative: nativePrice, priceEur: currentPrice,
        currency: alert.currency || marketCurrency,
        threshold, avgCostEur: reference ? reference.eur : null,
        // `basis` says what avg_cost_eur actually is. The column holds a cost
        // basis for a holding and a watch price for a watched stock, and those
        // are not the same fact — without the label, alert-followthrough would
        // report "25% under what you paid" for a stock that was never bought.
        detail: rule === 'dip_from_avg_cost' ? { dropPct: item.dropPct, basis: reference.basis }
          : rule === 'gain_from_avg_cost' ? { gainPct: item.gainPct, basis: reference.basis }
          : rule === 'drop_from_high' ? { peak: highPeak, dropPct: item.dropPct }
          : null
      });

      if (!byRecipient.has(recipient)) byRecipient.set(recipient, []);
      byRecipient.get(recipient).push(item);

      updateAlertStmt.run(alert.id);
      triggeredCount++;

    } catch (err) {
      log(`  ❌ Error evaluating alert ${alert.id}: ${err.message}`);
    }
  }

  for (const [recipient, items] of byRecipient) {
    const standings = standingsByRecipient.get(recipient) || [];
    if (!items.length && !standings.length) continue;
    const subject = alertSubject(items);
    // Every alert in this digest, so the log can record what became of the email
    // rather than assuming a row that was written means a reader who was told.
    const eventIds = items.map(i => i.eventId).filter(id => id != null);
    if (!mailer || !recipient) {
      log(`  📌 Would email ${recipient || 'unknown recipient'}: ${subject}`);
      markDelivery(db, eventIds, 'not_sent');
      continue;
    }
    try {
      const verdict = await mailguard.sendGuarded(db, mailer, 'alert', {
        from: process.env.ALERT_EMAIL_FROM || 'alerts@portfoliotracker.local',
        to: recipient,
        subject,
        text: renderAlertDigestText(items, standings),
        html: renderAlertDigest(items, standings)
      }, log);
      // A refusal from the guard — the daily ceiling, or no mailer — is not a
      // failure and is not the reader ignoring anything. It is simply an alert
      // they were never shown, and the evaluation has to be able to tell.
      markDelivery(db, eventIds, verdict && verdict.sent ? 'sent' : 'not_sent');
      if (verdict && verdict.sent) {
        log(`  ✉ Digest sent to ${recipient} (${items.length} alert${items.length > 1 ? 's' : ''})`);
      }
    } catch (emailErr) {
      markDelivery(db, eventIds, 'failed');
      log(`  ❌ Failed to send digest to ${recipient}: ${emailErr.message}`);
    }
  }

  log(`✅ Alert evaluation complete: ${triggeredCount} triggered`);
  return { checked: alerts.length, triggered: triggeredCount, digests: byRecipient.size };
}


/* ---- how often a ticker actually needs asking about ----
 *
 * Every held ticker used to be fetched every weekday regardless of whether
 * anybody was in a position to look at the answer. The saving is not in skipping
 * data — Yahoo's chart endpoint is range-based, so one request covering a week
 * returns every trading day inside it — it is in making one request instead of
 * five for a holding nobody is watching.
 *
 * Two things keep a ticker on the daily schedule, and the second one matters
 * more than it looks: **an alert is for somebody who is not logging in.**
 * Deferring fetches for a dormant holder would silence exactly the feature they
 * are relying on, so any enabled alert pins its ticker to daily whatever their
 * habits. The Algorithm tab's own alert deliberately does not count — it is on by
 * default for every account, so treating it as an alert would make every ticker
 * hot and the whole rule a no-op.
 */
const HOT_SEEN_DAYS = 7;        // a holder here this recently keeps it daily
const COLD_INTERVAL_DAYS = 7;   // otherwise, at most one catch-up a week

function tickerTier(db, ticker, now, identityDb = identityFor(db)) {
  // "Who holds this" is a financial question; "were they here lately" is an
  // identity one. Since the split they are two files, so this is two queries and
  // a loop rather than a join — the cost of not being able to name anybody from
  // the financial side alone.
  const holders = db.prepare('SELECT DISTINCT user_id FROM transactions WHERE ticker = ?').all(ticker);
  if (identityDb && holders.length) {
    const seenStmt = identityDb.prepare(`
      SELECT 1 FROM users WHERE user_key = ? AND last_seen_at IS NOT NULL
        AND julianday(?) - julianday(last_seen_at) <= ?
    `);
    const stamp = now.toISOString();
    for (const h of holders) {
      if (seenStmt.get(h.user_id, stamp, HOT_SEEN_DAYS)) return 'hot';
    }
  }

  const watched = db.prepare(
    'SELECT 1 FROM alerts WHERE ticker = ? AND enabled = 1 LIMIT 1'
  ).get(ticker);
  return watched ? 'hot' : 'cold';
}

/* ---- which tickers the job asks about at all ----
 *
 * Two sources, and they have nothing in common. A **held** ticker is one
 * somebody still owns: it used to be every ticker that had ever appeared in a
 * transaction, so a position sold to nothing kept costing a request a day for
 * ever. The test is split-adjusted rather than buys-minus-sells, because those
 * disagree — one share bought before a 3-for-1 and one sold after it nets to
 * zero on the raw numbers while two shares are still held. getAvgCostPerShare
 * does that correctly and returns null on a closed position, so it is the
 * authority.
 *
 * A **watched** ticker has no transaction row at all. Before the watchlist, the
 * universe was simply "what somebody bought", which is why an alert on anything
 * else could never fire: no price ever arrived for it, and nothing said so.
 *
 * Split out of fetchPrices() to be testable. It is the highest-risk line in the
 * watchlist change — get the union wrong and watched stocks silently never get
 * a price, which is precisely the failure the feature exists to end.
 */
function fetchUniverse(db) {
  const heldPairs = db.prepare('SELECT DISTINCT user_id, ticker FROM transactions').all();
  const everSeen = db.prepare('SELECT DISTINCT ticker FROM transactions ORDER BY ticker')
    .all().map(r => r.ticker);
  const stillHeld = new Set();
  for (const { user_id, ticker } of heldPairs) {
    if (avgCostFor(db, user_id, ticker)) stillHeld.add(ticker);
  }

  const watched = new Set(allWatchedTickers(db));
  const held = everSeen.filter(t => stillHeld.has(t));
  const watchOnly = [...watched].filter(t => !stillHeld.has(t)).sort();

  return {
    tickers: [...new Set([...held, ...watched])].sort(),
    held,
    watchOnly,
    // A fully-sold position somebody still watches is not dropped — that is the
    // case the watchlist was built for.
    dropped: everSeen.filter(t => !stillHeld.has(t) && !watched.has(t)),
    everSeen
  };
}

/**
 * Whole days between the newest stored price and now; Infinity if there is none.
 *
 * Since issue #12 the newest row is the previous *completed* session, not
 * today's — so this is naturally about a day bigger than it used to be, and a
 * Monday run reads roughly "3 days behind" (Friday's close, seen on Monday)
 * for every ticker, which used to be within the same-day cadence and is now
 * routed through `plan.range`'s "filled N day(s)" log line. That is noisier
 * than before, but it is accurate — those tickers really are catching up a
 * completed session they did not have — and both the job and backfill write
 * through the same `backfillTicker` path either way, so it has no effect on
 * what gets stored. Left as-is deliberately: this function's job is an
 * accurate gap, not a quiet Monday; the tier thresholds it feeds
 * (`tickerTier`, `HOT_SEEN_DAYS`, `COLD_INTERVAL_DAYS`) are unchanged.
 */
function priceGapDays(db, ticker, now) {
  const row = db.prepare(
    'SELECT MAX(price_date) AS d FROM prices WHERE ticker = ? AND price_native IS NOT NULL'
  ).get(ticker);
  if (!row || !row.d) return Infinity;
  return (now.getTime() - Date.parse(row.d)) / 864e5;
}

async function fetchPrices() {
  const startedAt = Date.now();
  log('🚀 Starting price fetch job...');

  // Opened before the market check so a skipped run is recorded too — a run that
  // skips every day is the exact failure this log exists to make visible.
  let db = null;
  const results = [];
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');   // shares the file with the web process
    db.pragma('foreign_keys = ON');

    const { isClosed, reason } = areMarketsClosedForFetch();
    if (!isClosed) {
      log(`⏳ Skipping fetch: ${reason}`);
      log('   Will retry when markets close');
      recordRun(db, 'skipped', { reason });
      await sendRunReport(initEmailTransporter(), 'skipped', { reason, durationMs: Date.now() - startedAt });
      db.close();
      process.exit(0);
    }
    log(`✓ Markets check passed: ${reason}`);

    // Initialize Yahoo Finance (v3 API requires instantiation)
    const yahooFinance = new YahooFinance();

    const { tickers, held, watchOnly, dropped, everSeen } = fetchUniverse(db);
    if (dropped.length) {
      log(`ℹ Not fetching ${dropped.length} fully-sold position(s): ${dropped.join(', ')}`);
    }
    if (watchOnly.length) {
      log(`👁 Also fetching ${watchOnly.length} watched, not held: ${watchOnly.join(', ')}`);
    }

    if (tickers.length === 0) {
      // Worth distinguishing: an empty database is normal, but transactions that
      // all net to zero is a state somebody should be able to recognise in a log.
      const why = everSeen.length ? 'every position has been sold' : 'no transactions yet';
      log(`ℹ Nothing to fetch — ${why}`);
      recordRun(db, 'skipped', { reason: why });
      await sendRunReport(initEmailTransporter(), 'skipped',
        { reason: why, durationMs: Date.now() - startedAt });
      db.close();
      process.exit(0);
    }

    /*
     * Decide, per ticker, between three outcomes:
     *   a quote  — the cheap daily path, for a hot ticker already up to date
     *   a range  — one request that fills whatever days are missing, for a hot
     *              ticker with a hole in it or a cold one that is due
     *   nothing  — a cold ticker asked about recently enough
     */
    // Opened here rather than further down, where it used to be: the tier
    // planning below reads it, and a `const` declared after its first use sits in
    // the temporal dead zone — which is not a warning at load time, it is a
    // throw at run time. The daily job failed exactly once that way.
    const identityDb = identityFor(db);

    const now = new Date();
    const plan = { quote: [], range: [], skip: [] };
    for (const ticker of tickers) {
      const tier = tickerTier(db, ticker, now, identityDb);
      const gap = priceGapDays(db, ticker, now);
      if (tier === 'hot') {
        // More than a day behind means days are actually missing, and a quote
        // only ever writes today — it would leave the hole in place for ever.
        (gap > 1.5 ? plan.range : plan.quote).push({ ticker, gap });
      } else if (gap >= COLD_INTERVAL_DAYS) {
        plan.range.push({ ticker, gap });
      } else {
        plan.skip.push({ ticker, gap });
      }
    }

    log(`Found ${tickers.length} ticker(s) (${held.length} held, ${watchOnly.length} watched): `
      + `${plan.quote.length} quoted, `
      + `${plan.range.length} caught up by range, ${plan.skip.length} left alone`);
    if (plan.skip.length) {
      log(`  ⏭  nobody is watching, asked recently enough: ${plan.skip.map(p => p.ticker).join(', ')}`);
    }

    // Fetch prices for each ticker
    let successCount = 0;
    let failureCount = 0;

    ensurePriceCurrencyColumns(db);
    ensureAlertCurrency(db);
    ensureGainRuleType(db);
    ensureDropFromHighRuleType(db);
    ensureAlgorithmAlertSettings(db);
    ensureAlertEventLog(db);
    ensureWatchlist(db);
    ensureDataVersion(db);

    // Rates before bars, not after: `backfillTicker` converts each bar at the
    // rate recorded *for that bar's own date* (see backfill-history.js), so a
    // same-day completed session (an evening manual run) needs today's rate
    // already sitting in `exchange_rates` before a single price is written.
    // The set of currencies to fetch a rate for comes from what these tickers
    // are already stored in — new tickers default to USD, same as before.
    const { backfillTicker } = require('./backfill-history');
    const currencyOfStmt = db.prepare(
      'SELECT currency FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1'
    );
    const neededCurrencies = [...new Set(tickers.map(t => (currencyOfStmt.get(t) || {}).currency || 'USD'))];
    await fetchExchangeRates(yahooFinance, db, neededCurrencies);

    // One writer for every ticker: the job and backfill-history.js both go
    // through backfillTicker, so they can never disagree about a price or its
    // date — see issue #12. A "quote" ticker (hot, already up to date) asks for
    // a short ~10-day window rather than one day, so a bar dropped for not
    // being final yet is still picked up without a hole opening in the table.
    const QUOTE_WINDOW_YEARS = 10 / 365.25;
    const requests = [
      ...plan.quote.map(p => ({ ticker: p.ticker, years: QUOTE_WINDOW_YEARS })),
      ...plan.range.map(p => ({ ticker: p.ticker, years: Math.min(Math.max((p.gap + 3) / 365.25, 0.02), 1), gap: p.gap }))
    ];

    for (const { ticker, years, gap } of requests) {
      try {
        const r = await backfillTicker(db, yahooFinance, ticker, years, { source: 'yahoo_finance', now });
        if (r.last) {
          log(`    ✓ ${ticker}: ${fmtNative(r.last.native, r.last.currency)} (${r.last.date})`
            + (gap !== undefined ? ` — filled ${r.added} day(s), ${gap === Infinity ? 'no history' : Math.round(gap) + ' behind'}` : '')
            + (r.droppedOpen ? `, ${r.droppedOpen} open bar not final yet` : ''));
          successCount++;
          results.push({ ticker, ok: true, priceNative: r.last.native, currency: r.last.currency, priceEur: r.last.eur, date: r.last.date });
        } else {
          // `r.note` is only set when Yahoo returned nothing at all. A ticker
          // with real bars that were all skipped for want of an FX rate has no
          // note, and reporting "no final bar" / "no price data" there points
          // an operator at the wrong system — say what actually happened.
          const reason = r.note
            || (r.skipped > 0 ? `missing FX rate for ${r.skippedDate || 'this ticker'} (${r.currency})` : 'no final bar to store');
          log(`    ⚠ ${ticker}: ${reason}`);
          failureCount++;
          results.push({ ticker, ok: false, error: reason });
        }
      } catch (err) {
        log(`    ❌ Error fetching ${ticker}: ${err.message}`);
        failureCount++;
        results.push({ ticker, ok: false, error: err.message });
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // New prices change every computed view. The web process caches those by a
    // version counter rather than by time, so this is what tells it to let go of
    // yesterday's answers — without the two processes needing to talk.
    if (successCount > 0) {
      db.prepare('UPDATE data_version SET version = version + 1 WHERE id = 1').run();
    }

    // Log summary
    log(`\n✅ Price fetch complete: ${successCount} succeeded, ${failureCount} failed`);

    // Show sample of prices stored. Since issue #12 a "quote" ticker's window is
    // ~10 days (not 1), so `updated_at DESC` now tends to surface whichever
    // tickers' 10-day rewrite happened to run last, rather than only the
    // tickers that actually moved — cosmetic only, this is a log line, not
    // something anything reads back.
    const sampleStmt = db.prepare(
      'SELECT ticker, price_eur, price_date FROM prices ORDER BY updated_at DESC LIMIT 5'
    );
    const samples = sampleStmt.all();
    if (samples.length > 0) {
      log('Recent prices:');
      samples.forEach(p => {
        log(`  ${p.ticker}: €${p.price_eur} (${p.price_date})`);
      });
    }

    // Evaluate alerts
    const mailer = initEmailTransporter();
    const alertStats = await evaluateAlerts(db, mailer);

    const summary = {
      reason, tickerCount: tickers.length, successCount, failureCount,
      alertsChecked: alertStats.checked, alertsTriggered: alertStats.triggered,
      results, durationMs: Date.now() - startedAt
    };
    recordRun(db, 'success', summary);
    await sendRunReport(mailer, 'success', summary);

    db.close();
    process.exit(0);
  } catch (err) {
    log(`❌ Fatal error: ${err.message}`);
    console.error(err);
    // Record and report the failure before exiting — a crash is precisely what
    // needs to reach someone, and the logs alone were not enough last time.
    // Order matters here, and both orderings are wrong in different ways.
    // Ask the throttle BEFORE recording this failure, or it finds the row it just
    // wrote and suppresses the very first report. And close the database AFTER
    // asking, or the throttle cannot read its own history and every crash mails.
    const quiet = db ? failureRecentlyReported(db) : false;
    if (db) recordRun(db, 'failed', { error: err.message, results });
    try {
      if (quiet) {
        log('  🔇 failure already reported within the hour — not sending another');
      } else {
        await sendRunReport(initEmailTransporter(), 'failed',
          { error: err.message, results, durationMs: Date.now() - startedAt });
      }
    } catch (_) {}
    if (db) { try { db.close(); } catch (_) {} }
    process.exit(1);
  }
}

// Run the fetch job — only when invoked directly. Requiring this file used to run
// the whole job as a side effect, which made the render helpers impossible to
// exercise on their own (and is what blocks a test suite).
if (require.main === module) {
  fetchPrices().catch(err => {
    log(`❌ Uncaught error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { renderAlertDigest, renderAlertDigestText, alertSubject, evaluateAlerts, ordinal,
  digestModel, DIGEST_SECTIONS,
  RATE_UPSERT_SQL, fetchExchangeRates,
  identityFor, emailsByKey, resolveDbPath, failureRecentlyReported,
  tickerTier, priceGapDays, fetchUniverse, HOT_SEEN_DAYS, COLD_INTERVAL_DAYS,
                   areMarketsClosedForFetch };
