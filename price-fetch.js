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

function renderEmailTemplate(ticker, rule, threshold, currentPrice, extra) {
  let templatePath = path.join(__dirname, 'email-template.html');
  let html = fs.readFileSync(templatePath, 'utf-8');

  const ruleText = rule === 'price_above' ? 'above'
    : rule === 'price_below' ? 'below'
    : rule === 'dip_from_avg_cost' ? `down ${threshold}% from your average cost (€${extra.avgCostEUR.toFixed(2)})`
    : 'changed';

  html = html
    .replace(/{{ticker}}/g, ticker)
    .replace(/{{rule}}/g, ruleText)
    .replace(/{{threshold}}/g, threshold.toFixed(2))
    .replace(/{{currentPrice}}/g, currentPrice.toFixed(2))
    .replace(/{{timestamp}}/g, new Date().toISOString());

  return html;
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

      const subject = rule === 'dip_from_avg_cost'
        ? `📉 Dip Alert: ${alert.ticker} is down ${threshold}%+ from your avg cost (€${avgCostEUR.toFixed(2)} → €${currentPrice.toFixed(2)})`
        : `🚨 Price Alert: ${alert.ticker} ${rule === 'price_above' ? '>' : '<'} €${threshold.toFixed(2)}`;

      // Each alert is emailed to the user who created it. ALERT_EMAIL_TO is only a
      // fallback for rows with no usable owner email.
      const recipient = alert.owner_email || process.env.ALERT_EMAIL_TO;

      if (mailer && recipient) {
        try {
          const html = renderEmailTemplate(alert.ticker, rule, threshold, currentPrice, {avgCostEUR});
          await mailer.sendMail({
            from: process.env.ALERT_EMAIL_FROM || 'alerts@portfoliotracker.local',
            to: recipient,
            subject,
            html
          });
          log(`  ✉ Email sent to ${recipient} for alert ${alert.id} (${alert.ticker})`);
        } catch (emailErr) {
          log(`  ❌ Failed to send email for alert ${alert.id}: ${emailErr.message}`);
        }
      } else {
        log(`  📌 Alert triggered for ${recipient || 'unknown recipient'}: ${subject}`);
      }

      // Update last triggered time
      updateAlertStmt.run(alert.id);
      triggeredCount++;

    } catch (err) {
      log(`  ❌ Error evaluating alert ${alert.id}: ${err.message}`);
    }
  }

  log(`✅ Alert evaluation complete: ${triggeredCount} triggered`);
}

async function fetchPrices() {
  log('🚀 Starting price fetch job...');

  try {
    // Check if markets are closed before proceeding
    const { isClosed, reason } = areMarketsClosedForFetch();
    if (!isClosed) {
      log(`⏳ Skipping fetch: ${reason}`);
      log('   Will retry when markets close');
      process.exit(0);
    }
    log(`✓ Markets check passed: ${reason}`);

    // Initialize Yahoo Finance (v3 API requires instantiation)
    const yahooFinance = new YahooFinance();

    // Connect to database
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');

    // Get unique tickers from transactions
    const tickerStmt = db.prepare('SELECT DISTINCT ticker FROM transactions ORDER BY ticker');
    const tickers = tickerStmt.all().map(row => row.ticker);

    if (tickers.length === 0) {
      log('ℹ No tickers found in transactions table, skipping fetch');
      db.close();
      process.exit(0);
    }

    log(`Found ${tickers.length} unique tickers: ${tickers.join(', ')}`);

    // Fetch prices for each ticker
    let successCount = 0;
    let failureCount = 0;

    const upsertStmt = db.prepare(`
      INSERT INTO prices (ticker, price_eur, price_usd, price_date, source)
      VALUES (?, ?, ?, DATE('now'), 'yahoo_finance')
      ON CONFLICT(ticker, price_date) DO UPDATE SET
        price_eur = excluded.price_eur,
        price_usd = excluded.price_usd,
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
          continue;
        }

        const priceUsd = quoteData.regularMarketPrice;
        // Default EUR conversion rate (0.92 USD → EUR)
        // TODO: Phase 3 will fetch actual exchange rates
        const exchangeRate = 0.92;
        const priceEur = parseFloat((priceUsd * exchangeRate).toFixed(4));

        log(`    ✓ ${ticker}: $${priceUsd.toFixed(2)} USD → €${priceEur.toFixed(2)} EUR`);

        // Upsert into database
        upsertStmt.run(ticker, priceEur, priceUsd);
        successCount++;
      } catch (err) {
        log(`    ❌ Error fetching ${ticker}: ${err.message}`);
        failureCount++;
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
    await evaluateAlerts(db, mailer);

    db.close();
    process.exit(0);
  } catch (err) {
    log(`❌ Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

// Run the fetch job
fetchPrices().catch(err => {
  log(`❌ Uncaught error: ${err.message}`);
  process.exit(1);
});
