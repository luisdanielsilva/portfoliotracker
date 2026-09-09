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
const { ensurePriceCurrencyColumns } = require('./db-migrations');
require('dotenv').config();

const dbPath = path.join(__dirname, 'data.db');
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
function digestRow(item, isLast) {
  const border = isLast ? '' : `border-bottom:1px solid ${MAIL.hair};`;
  let headline, detail;

  if (item.kind === 'dip') {
    headline = `<span style="color:${MAIL.neg}">−${item.dropPct.toFixed(1)}%</span>`;
    detail = `${eur(item.price)} now · your average cost ${eur(item.avgCost)}<br>`
      + `Back to break-even at <span style="color:${MAIL.ink};font-family:${MAIL.mono}">${eur(item.avgCost)}</span>`;
  } else {
    const above = item.kind === 'price_above';
    const away = Math.abs((item.price - item.threshold) / item.threshold) * 100;
    headline = `<span style="color:${above ? MAIL.pos : MAIL.accent}">${above ? 'above' : 'below'} ${eur(item.threshold)}</span>`;
    detail = `${eur(item.price)} now · ${away.toFixed(1)}% ${above ? 'over' : 'under'} the level you set`;
  }

  return `<tr><td style="padding:14px 0;${border}">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font:600 15px/1.3 ${MAIL.sans};color:${MAIL.ink}">${item.ticker}</td>
      <td align="right" style="font:600 14px/1.3 ${MAIL.mono}">${headline}</td>
    </tr><tr>
      <td colspan="2" style="padding-top:5px;font:400 13px/1.6 ${MAIL.sans};color:${MAIL.muted}">${detail}</td>
    </tr></table>
  </td></tr>`;
}

function digestSection(title, items) {
  if (!items.length) return '';
  return `<tr><td style="padding:24px 0 0;font:600 11px/1 ${MAIL.sans};letter-spacing:.09em;text-transform:uppercase;color:${MAIL.faint}">${title}</td></tr>`
    + `<tr><td><table width="100%" cellpadding="0" cellspacing="0" border="0">`
    + items.map((it, i) => digestRow(it, i === items.length - 1)).join('')
    + `</table></td></tr>`;
}

function renderAlertDigest(items) {
  const dips = items.filter(i => i.kind === 'dip');
  const levels = items.filter(i => i.kind !== 'dip');
  const when = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const heading = items.length === 1 ? 'One alert triggered' : `${items.length} alerts triggered`;

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
        ${digestSection('Dips below your average cost', dips)}
        ${digestSection('Price levels you set', levels)}
      </table>
    </td></tr>
    <tr><td style="padding:24px 26px 26px">
      <a href="${appLink()}" style="display:inline-block;background:${MAIL.accent};color:#ffffff;text-decoration:none;font:500 14px/1 ${MAIL.sans};padding:12px 22px;border-radius:8px">Open Portfolio Tracker</a>
      <div style="margin-top:18px;padding-top:16px;border-top:1px solid ${MAIL.hair};font:400 12px/1.6 ${MAIL.sans};color:${MAIL.faint}">
        Each rule emails you at most once in 24 hours. Prices are the latest close, converted to euros.
        Change or switch off any rule in the app.
      </div>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

function renderAlertDigestText(items) {
  const lines = [`${items.length === 1 ? 'One alert' : items.length + ' alerts'} triggered\n`];
  for (const i of items) {
    if (i.kind === 'dip') {
      lines.push(`${i.ticker}  -${i.dropPct.toFixed(1)}% below your average`);
      lines.push(`  ${eur(i.price)} now, average cost ${eur(i.avgCost)}. Break-even at ${eur(i.avgCost)}.`);
    } else {
      const above = i.kind === 'price_above';
      lines.push(`${i.ticker}  ${above ? 'above' : 'below'} ${eur(i.threshold)}`);
      lines.push(`  ${eur(i.price)} now.`);
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

async function sendRunReport(mailer, status, d) {
  if (!RUN_REPORT_ENABLED) return;
  const to = process.env.ALERT_EMAIL_TO;
  if (!mailer || !to) { log('  📌 run report not sent (no mailer or ALERT_EMAIL_TO)'); return; }
  const subject = status === 'success'
    ? `Prices updated — ${d.successCount}/${d.tickerCount} tickers, ${d.alertsTriggered ?? 0} alert(s)`
    : status === 'skipped' ? `Price fetch skipped — ${d.reason}`
    : `Price fetch FAILED — ${d.error}`;
  try {
    await mailer.sendMail({ from: process.env.ALERT_EMAIL_FROM || 'alerts@portfoliotracker.local',
      to, subject, html: renderRunReport(status, d) });
    log(`  ✉ run report sent to ${to}`);
  } catch (e) {
    log(`  ❌ run report failed: ${e.message}`);
  }
}

function alertSubject(items) {
  if (items.length === 1) {
    const i = items[0];
    if (i.kind === 'dip') return `${i.ticker} is ${i.dropPct.toFixed(1)}% below your average cost`;
    return `${i.ticker} ${i.kind === 'price_above' ? 'rose above' : 'fell below'} ${eur(i.threshold)}`;
  }
  return `${items.length} alerts: ${[...new Set(items.map(i => i.ticker))].join(', ')}`;
}

// Average cost per share (EUR) currently held for a ticker, from transactions
function getAvgCostPerShare(db, ticker, userId) {
  const txStmt = db.prepare(`
    SELECT tx_type, quantity, amount_eur FROM transactions
    WHERE ticker = ? AND user_id = ? ORDER BY ts ASC
  `);
  let qty = 0, totalAmount = 0;
  for (const tx of txStmt.all(ticker, userId)) {
    if (tx.tx_type === 'buy') { qty += tx.quantity; totalAmount += tx.amount_eur; }
    else if (tx.tx_type === 'sell') { qty -= tx.quantity; totalAmount -= tx.amount_eur; }
  }
  if (qty <= 0) return null;
  return totalAmount / qty;
}

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
function areMarketsClosedForFetch() {
  const now = new Date();
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

async function evaluateAlerts(db, mailer) {
  log('\n📢 Evaluating active alerts...');

  // Join to users so each alert is emailed to the person who created it.
  const getAlertsStmt = db.prepare(`
    SELECT a.id, a.user_id, a.ticker, a.rule_type, a.threshold, a.last_triggered_at,
           u.email AS owner_email
    FROM alerts a
    JOIN users u ON u.id = a.user_id
    WHERE a.enabled = 1
  `);

  const getPriceStmt = db.prepare(`
    SELECT price_eur FROM prices
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

  for (const alert of alerts) {
    try {
      const price = getPriceStmt.get(alert.ticker);

      if (!price) {
        log(`  ⚠ No price data for ${alert.ticker}, skipping alert ${alert.id}`);
        continue;
      }

      const currentPrice = price.price_eur;
      const threshold = alert.threshold;
      const rule = alert.rule_type;
      let triggered = false;
      let avgCostEUR = null;

      // Check if alert should trigger
      if (rule === 'price_above' && currentPrice > threshold) {
        triggered = true;
      } else if (rule === 'price_below' && currentPrice < threshold) {
        triggered = true;
      } else if (rule === 'dip_from_avg_cost') {
        avgCostEUR = getAvgCostPerShare(db, alert.ticker, alert.user_id);
        if (avgCostEUR !== null && currentPrice <= avgCostEUR * (1 - threshold / 100)) {
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
      const recipient = alert.owner_email || process.env.ALERT_EMAIL_TO;
      const item = rule === 'dip_from_avg_cost'
        ? { kind: 'dip', ticker: alert.ticker, price: currentPrice, avgCost: avgCostEUR,
            dropPct: ((avgCostEUR - currentPrice) / avgCostEUR) * 100 }
        : { kind: rule, ticker: alert.ticker, price: currentPrice, threshold };

      if (!byRecipient.has(recipient)) byRecipient.set(recipient, []);
      byRecipient.get(recipient).push(item);

      updateAlertStmt.run(alert.id);
      triggeredCount++;

    } catch (err) {
      log(`  ❌ Error evaluating alert ${alert.id}: ${err.message}`);
    }
  }

  for (const [recipient, items] of byRecipient) {
    const subject = alertSubject(items);
    if (!mailer || !recipient) {
      log(`  📌 Would email ${recipient || 'unknown recipient'}: ${subject}`);
      continue;
    }
    try {
      await mailer.sendMail({
        from: process.env.ALERT_EMAIL_FROM || 'alerts@portfoliotracker.local',
        to: recipient,
        subject,
        text: renderAlertDigestText(items),
        html: renderAlertDigest(items)
      });
      log(`  ✉ Digest sent to ${recipient} (${items.length} alert${items.length > 1 ? 's' : ''})`);
    } catch (emailErr) {
      log(`  ❌ Failed to send digest to ${recipient}: ${emailErr.message}`);
    }
  }

  log(`✅ Alert evaluation complete: ${triggeredCount} triggered`);
  return { checked: alerts.length, triggered: triggeredCount, digests: byRecipient.size };
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

    // Get unique tickers from transactions
    const tickerStmt = db.prepare('SELECT DISTINCT ticker FROM transactions ORDER BY ticker');
    const tickers = tickerStmt.all().map(row => row.ticker);

    if (tickers.length === 0) {
      log('ℹ No tickers found in transactions table, skipping fetch');
      recordRun(db, 'skipped', { reason: 'no tickers held' });
      await sendRunReport(initEmailTransporter(), 'skipped',
        { reason: 'no tickers held', durationMs: Date.now() - startedAt });
      db.close();
      process.exit(0);
    }

    log(`Found ${tickers.length} unique tickers: ${tickers.join(', ')}`);

    // Fetch prices for each ticker
    let successCount = 0;
    let failureCount = 0;

    ensurePriceCurrencyColumns(db);

    const upsertStmt = db.prepare(`
      INSERT INTO prices (ticker, price_eur, price_usd, price_native, currency, price_date, source)
      VALUES (?, ?, ?, ?, ?, DATE('now'), 'yahoo_finance')
      ON CONFLICT(ticker, price_date) DO UPDATE SET
        price_eur = excluded.price_eur,
        price_usd = excluded.price_usd,
        price_native = excluded.price_native,
        currency = excluded.currency,
        updated_at = CURRENT_TIMESTAMP
    `);

    for (const ticker of tickers) {
      try {
        log(`  Fetching ${ticker}...`);

        // Fetch quote from Yahoo Finance
        const quoteData = await yahooFinance.quote(ticker);

        if (!quoteData || quoteData.regularMarketPrice === undefined) {
          log(`    ⚠ No price data for ${ticker}`);
          failureCount++;
          results.push({ ticker, ok: false, error: 'no price data (check the symbol)' });
          continue;
        }

        // Take the currency Yahoo reports rather than assuming USD. A European
        // listing is quoted in EUR already, and converting it would scale a
        // correct figure by the USD rate.
        const priceNative = quoteData.regularMarketPrice;
        const currency = quoteData.currency || 'USD';

        // TODO: still a fixed rate — see the accuracy note in the README.
        const usdToEur = 0.92;
        const priceEur = currency === 'EUR'
          ? priceNative
          : parseFloat((priceNative * usdToEur).toFixed(4));
        const priceUsd = currency === 'USD' ? priceNative : null;

        log(`    ✓ ${ticker}: ${fmtNative(priceNative, currency)}`
          + (currency === 'EUR' ? '' : ` → €${priceEur.toFixed(2)} EUR`));

        // Upsert into database
        upsertStmt.run(ticker, priceEur, priceUsd, priceNative, currency);
        successCount++;
        results.push({ ticker, ok: true, priceNative, currency, priceEur });
      } catch (err) {
        log(`    ❌ Error fetching ${ticker}: ${err.message}`);
        failureCount++;
        results.push({ ticker, ok: false, error: err.message });
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Log summary
    log(`\n✅ Price fetch complete: ${successCount} succeeded, ${failureCount} failed`);

    // Show sample of prices stored
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
    if (db) { recordRun(db, 'failed', { error: err.message, results }); try { db.close(); } catch (_) {} }
    try {
      await sendRunReport(initEmailTransporter(), 'failed', { error: err.message, results, durationMs: Date.now() - startedAt });
    } catch (_) {}
    process.exit(1);
  }
}

// Run the fetch job
fetchPrices().catch(err => {
  log(`❌ Uncaught error: ${err.message}`);
  process.exit(1);
});
