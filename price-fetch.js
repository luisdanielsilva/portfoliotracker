#!/usr/bin/env node
/**
 * price-fetch.js — Daily price fetching from Yahoo Finance
 * Fetches closing prices for all tracked tickers and stores in SQLite
 * Usage: node price-fetch.js
 * Scheduled via systemd timer (daily at 09:00 UTC)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const YahooFinance = require('yahoo-finance2').default;

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

async function fetchPrices() {
  log('🚀 Starting price fetch job...');

  try {
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
