#!/usr/bin/env node
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const app = express();

// SQLite database connection
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Initialize database schema
const schema = require('fs').readFileSync(path.join(__dirname, 'schema.sqlite.sql'), 'utf-8');
db.exec(schema);

// Migration: widen alerts.rule_type CHECK constraint to include 'dip_from_avg_cost'
// (SQLite can't ALTER a CHECK constraint in place, so rebuild the table if needed)
(function migrateAlertsRuleType() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='alerts'").get();
  if (row && !row.sql.includes('dip_from_avg_cost')) {
    db.exec(`
      CREATE TABLE alerts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ticker TEXT NOT NULL,
        rule_type TEXT NOT NULL CHECK(rule_type IN ('price_above', 'price_below', 'change_pct', 'dip_from_avg_cost')),
        threshold REAL NOT NULL,
        enabled BOOLEAN DEFAULT 1,
        last_triggered_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO alerts_new SELECT * FROM alerts;
      DROP TABLE alerts;
      ALTER TABLE alerts_new RENAME TO alerts;
      CREATE INDEX IF NOT EXISTS idx_user_ticker_alert ON alerts(user_id, ticker);
      CREATE INDEX IF NOT EXISTS idx_enabled ON alerts(enabled);
    `);
    console.log('Migrated alerts table to support dip_from_avg_cost rule_type');
  }
})();

// Compute average cost per share (in EUR) currently held for a ticker, from transactions
function getAvgCostPerShare(ticker, userId) {
  const txStmt = db.prepare(`
    SELECT tx_type, quantity, amount_eur FROM transactions
    WHERE user_id = ? AND ticker = ? ORDER BY ts ASC
  `);
  let qty = 0, totalAmount = 0;
  for (const tx of txStmt.all(userId, ticker)) {
    if (tx.tx_type === 'buy') { qty += tx.quantity; totalAmount += tx.amount_eur; }
    else if (tx.tx_type === 'sell') { qty -= tx.quantity; totalAmount -= tx.amount_eur; }
  }
  if (qty <= 0) return null;
  return { avgCostEUR: totalAmount / qty, quantity: qty };
}

app.use(express.json());
app.use(express.static(__dirname));

// Default user ID (Phase 1 MVP - single user)
const DEFAULT_USER_ID = 1;

// Ensure default user exists
const defaultUserStmt = db.prepare('SELECT id FROM users WHERE id = ?');
if (!defaultUserStmt.get(DEFAULT_USER_ID)) {
  const insertUser = db.prepare(
    'INSERT INTO users (id, email, api_key) VALUES (?, ?, ?)'
  );
  insertUser.run(DEFAULT_USER_ID, 'default@portfoliotracker.local', 'sk_default_phase1_test');
}

// GET /api/transactions - retrieve all transactions
app.get('/api/transactions', (req, res) => {
  try {
    const stmt = db.prepare(
      'SELECT id, ticker, quantity, amount_eur as amount, currency, exchange_rate as exchangeRate, tx_type as type, ts FROM transactions WHERE user_id = ? ORDER BY ts DESC'
    );
    const transactions = stmt.all(DEFAULT_USER_ID);
    res.json({ transactions });
  } catch (err) {
    console.error('GET /api/transactions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/transactions - create new transaction
app.post('/api/transactions', (req, res) => {
  try {
    const tx = req.body;

    // Validate required fields
    if (!tx.ts || !tx.ticker || !tx.quantity || !tx.amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const insertStmt = db.prepare(
      `INSERT INTO transactions
       (user_id, ticker, quantity, amount_eur, currency, exchange_rate, tx_type, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const result = insertStmt.run(
      DEFAULT_USER_ID,
      tx.ticker,
      tx.quantity,
      tx.amountEUR || tx.amount,
      tx.currency || 'EUR',
      tx.exchangeRate || 1.0,
      tx.type || 'buy',
      tx.ts
    );

    // Fetch the inserted transaction
    const selectStmt = db.prepare(
      'SELECT id, ticker, quantity, amount_eur as amount, currency, exchange_rate as exchangeRate, tx_type as type, ts FROM transactions WHERE id = ?'
    );
    const transaction = selectStmt.get(result.lastInsertRowid);

    res.json({ success: true, transaction });
  } catch (err) {
    console.error('POST /api/transactions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/transactions/:id - update transaction
app.put('/api/transactions/:id', (req, res) => {
  try {
    const tx = req.body;
    const checkStmt = db.prepare('SELECT id FROM transactions WHERE id = ? AND user_id = ?');
    if (!checkStmt.get(req.params.id, DEFAULT_USER_ID)) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const updateStmt = db.prepare(`
      UPDATE transactions
      SET ticker = ?, quantity = ?, amount_eur = ?, currency = ?, exchange_rate = ?, tx_type = ?, ts = ?
      WHERE id = ? AND user_id = ?
    `);

    updateStmt.run(
      tx.ticker,
      tx.quantity,
      tx.amountEUR || tx.amount,
      tx.currency || 'EUR',
      tx.exchangeRate || 1.0,
      tx.type || 'buy',
      tx.ts,
      req.params.id,
      DEFAULT_USER_ID
    );

    const selectStmt = db.prepare(
      'SELECT id, ticker, quantity, amount_eur as amount, currency, exchange_rate as exchangeRate, tx_type as type, ts FROM transactions WHERE id = ?'
    );
    const transaction = selectStmt.get(req.params.id);

    res.json({ success: true, transaction });
  } catch (err) {
    console.error('PUT /api/transactions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/transactions/:id - remove transaction
app.delete('/api/transactions/:id', (req, res) => {
  try {
    // Check if transaction exists
    const checkStmt = db.prepare(
      'SELECT id FROM transactions WHERE id = ? AND user_id = ?'
    );
    const exists = checkStmt.get(req.params.id, DEFAULT_USER_ID);

    if (!exists) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Delete transaction
    const deleteStmt = db.prepare(
      'DELETE FROM transactions WHERE id = ? AND user_id = ?'
    );
    deleteStmt.run(req.params.id, DEFAULT_USER_ID);

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/transactions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// GET /api/prices - retrieve latest prices for all tickers
app.get('/api/prices', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT ticker, price_eur as priceEUR, price_usd as priceUSD, price_date as date, source, updated_at as updatedAt
      FROM prices
      WHERE (ticker, price_date) IN (
        SELECT ticker, MAX(price_date) FROM prices GROUP BY ticker
      )
      ORDER BY ticker
    `);
    const prices = stmt.all();
    res.json({ prices });
  } catch (err) {
    console.error('GET /api/prices error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/price-history/:ticker - retrieve full daily price history for a ticker
app.get('/api/price-history/:ticker', (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const stmt = db.prepare(`
      SELECT ticker, price_eur as priceEUR, price_usd as priceUSD, price_date as date
      FROM prices
      WHERE ticker = ?
      ORDER BY price_date ASC
    `);
    const history = stmt.all(ticker);
    res.json({ ticker, history });
  } catch (err) {
    console.error('GET /api/price-history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock-splits - retrieve all stock splits
app.get('/api/stock-splits', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT ticker, split_date as date, ratio, description
      FROM stock_splits
      ORDER BY split_date ASC
    `);
    const splits = stmt.all();
    res.json({ splits });
  } catch (err) {
    console.error('GET /api/stock-splits error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate daily snapshot dates from first transaction to today
function generateDailySnapshots() {
  const txStmt = db.prepare(`
    SELECT MIN(ts) as firstTx FROM transactions WHERE user_id = ?
  `);
  const result = txStmt.get(DEFAULT_USER_ID);

  if (!result.firstTx) return []; // No transactions

  const startDate = new Date(result.firstTx);
  const endDate = new Date();

  const dates = [];
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}T00:00`);
  }

  return dates;
}

// GET /api/snapshots - compute snapshots from transactions with market value
app.get('/api/snapshots', (req, res) => {
  try {
    // Get all stock splits
    const splitsStmt = db.prepare('SELECT ticker, split_date, ratio FROM stock_splits ORDER BY split_date ASC');
    const splits = splitsStmt.all();
    const splitsByTicker = {};
    splits.forEach(s => {
      if (!splitsByTicker[s.ticker]) splitsByTicker[s.ticker] = [];
      splitsByTicker[s.ticker].push({date: s.split_date, ratio: s.ratio});
    });

    // Get all transactions ordered by date
    const txStmt = db.prepare(`
      SELECT ticker, tx_type, quantity, amount_eur, ts
      FROM transactions
      WHERE user_id = ?
      ORDER BY ts ASC
    `);
    const transactions = txStmt.all(DEFAULT_USER_ID);

    if (transactions.length === 0) {
      res.json({ snapshots: [] });
      return;
    }

    // Build cumulative holdings at each transaction
    const holdings = {}; // ticker -> {qty, totalAmount}
    const transactionSnapshots = [];

    transactions.forEach(tx => {
      const {ticker, tx_type, quantity, amount_eur, ts} = tx;

      if (!holdings[ticker]) {
        holdings[ticker] = {qty: 0, totalAmount: 0};
      }

      if (tx_type === 'buy') {
        holdings[ticker].qty += quantity;
        holdings[ticker].totalAmount += amount_eur;
      } else if (tx_type === 'sell') {
        holdings[ticker].qty -= quantity;
        holdings[ticker].totalAmount -= amount_eur;
      }

      // Store snapshot state at this transaction
      transactionSnapshots.push({
        ts,
        holdings: JSON.parse(JSON.stringify(holdings))
      });
    });

    // Get latest prices for market value calculation
    const pricesStmt = db.prepare(`
      SELECT ticker, price_eur, price_date
      FROM prices
      WHERE (ticker, price_date) IN (
        SELECT ticker, MAX(price_date) FROM prices GROUP BY ticker
      )
    `);
    const latestPrices = {};
    pricesStmt.all().forEach(p => {
      latestPrices[p.ticker] = p.price_eur;
    });

    // Helper: apply splits to quantity as of a given date
    function applySplits(ticker, quantity, asOfDate) {
      let qty = quantity;
      const tickerSplits = splitsByTicker[ticker] || [];
      for (const split of tickerSplits) {
        if (asOfDate >= split.date) {
          qty *= split.ratio;
        }
      }
      return qty;
    }

    // Generate daily snapshots from first transaction to today
    const snapshotDates = generateDailySnapshots();

    const snapshots = snapshotDates.map(dateStr => {
      const ts = new Date(dateStr).getTime();
      const snapshotDate = dateStr.split('T')[0]; // YYYY-MM-DD

      // Find the most recent transaction at or before this date
      let stateAtDate = {}; // empty if no transactions yet
      for (const snap of transactionSnapshots) {
        if (snap.ts <= ts) {
          stateAtDate = JSON.parse(JSON.stringify(snap.holdings));
        } else {
          break;
        }
      }

      // Get prices as of this snapshot date (or latest available before it)
      // Adjust prices for stock splits: pre-split prices need to be adjusted up
      const pricesOnDate = {};
      Object.keys(latestPrices).forEach(ticker => {
        const priceStmt = db.prepare(`
          SELECT price_eur FROM prices
          WHERE ticker = ? AND price_date <= ?
          ORDER BY price_date DESC
          LIMIT 1
        `);
        const priceRow = priceStmt.get(ticker, snapshotDate);
        let price = priceRow ? priceRow.price_eur : null;

        // Apply split adjustment to prices (multiply pre-split prices by ratio)
        if (price !== null) {
          const tickerSplits = splitsByTicker[ticker] || [];
          for (const split of tickerSplits) {
            if (snapshotDate < split.date) {
              // Price is before this split, multiply by split ratio
              price *= split.ratio;
            }
          }
        }
        pricesOnDate[ticker] = price;
      });

      // Build holdings array with market value, applying stock splits
      let marketValue = 0;
      const holdingsArray = Object.entries(stateAtDate)
        .filter(([_, h]) => h.qty > 0) // Only include positive positions
        .map(([ticker, h]) => {
          const adjustedQty = applySplits(ticker, h.qty, snapshotDate);
          const price = pricesOnDate[ticker];
          const currentValue = price ? adjustedQty * price : adjustedQty * (h.totalAmount / h.qty); // Fallback to cost if no price
          marketValue += currentValue;


          return {
            ticker,
            quantity: adjustedQty,
            amount: h.totalAmount,
            costPerShare: h.qty > 0 ? h.totalAmount / h.qty : 0,
            price: price || (h.totalAmount / h.qty),
            marketValue: currentValue
          };
        });

      return {
        date: new Date(dateStr).toISOString(),
        ts,
        holdings: holdingsArray,
        portfolioTotal: marketValue,
        costBasis: Object.values(stateAtDate).reduce((sum, h) => sum + h.totalAmount, 0)
      };
    });

    res.json({ snapshots });
  } catch (err) {
    console.error('GET /api/snapshots error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/avg-cost - average cost per share for each ticker currently held, with current price & dip vs. that cost
app.get('/api/avg-cost', (req, res) => {
  try {
    const tickerStmt = db.prepare('SELECT DISTINCT ticker FROM transactions WHERE user_id = ? ORDER BY ticker');
    const priceStmt = db.prepare('SELECT price_eur, price_usd FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1');
    const result = tickerStmt.all(DEFAULT_USER_ID).map(row => {
      const cost = getAvgCostPerShare(row.ticker, DEFAULT_USER_ID);
      if (!cost) return null;
      const price = priceStmt.get(row.ticker);
      const currentPriceEUR = price ? price.price_eur : null;
      const dipPct = currentPriceEUR !== null ? (currentPriceEUR / cost.avgCostEUR - 1) : null;
      return {
        ticker: row.ticker,
        quantity: cost.quantity,
        avgCostEUR: cost.avgCostEUR,
        currentPriceEUR,
        currentPriceUSD: price ? price.price_usd : null,
        dipPct
      };
    }).filter(Boolean);
    res.json({ tickers: result });
  } catch (err) {
    console.error('GET /api/avg-cost error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Add avg-cost / current-price / dip context to a dip_from_avg_cost alert (mutates and returns it)
function enrichDipAlert(a) {
  if (a.ruleType !== 'dip_from_avg_cost') return a;
  const cost = getAvgCostPerShare(a.ticker, DEFAULT_USER_ID);
  if (!cost) return a;
  a.avgCostEUR = cost.avgCostEUR;
  a.triggerPriceEUR = cost.avgCostEUR * (1 - a.threshold / 100);
  const priceRow = db.prepare('SELECT price_eur, price_usd FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1').get(a.ticker);
  if (priceRow) {
    a.currentPriceEUR = priceRow.price_eur;
    a.currentPriceUSD = priceRow.price_usd;
    a.currentDipPct = (priceRow.price_eur / cost.avgCostEUR - 1) * 100;
  }
  return a;
}

// GET /api/alerts - retrieve user's alerts
app.get('/api/alerts', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT id, ticker, rule_type as ruleType, threshold, enabled, last_triggered_at as lastTriggeredAt, created_at as createdAt
      FROM alerts
      WHERE user_id = ?
      ORDER BY created_at DESC
    `);
    const alerts = stmt.all(DEFAULT_USER_ID).map(enrichDipAlert);
    res.json({ alerts });
  } catch (err) {
    console.error('GET /api/alerts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/alerts - create new alert
app.post('/api/alerts', (req, res) => {
  try {
    const alert = req.body;

    if (!alert.ticker || !alert.ruleType || alert.threshold === undefined) {
      return res.status(400).json({ error: 'Missing required fields: ticker, ruleType, threshold' });
    }

    const insertStmt = db.prepare(`
      INSERT INTO alerts (user_id, ticker, rule_type, threshold, enabled)
      VALUES (?, ?, ?, ?, 1)
    `);

    const result = insertStmt.run(
      DEFAULT_USER_ID,
      alert.ticker.toUpperCase(),
      alert.ruleType,
      parseFloat(alert.threshold)
    );

    const selectStmt = db.prepare(`
      SELECT id, ticker, rule_type as ruleType, threshold, enabled, last_triggered_at as lastTriggeredAt, created_at as createdAt
      FROM alerts WHERE id = ?
    `);
    const newAlert = enrichDipAlert(selectStmt.get(result.lastInsertRowid));

    res.json({ success: true, alert: newAlert });
  } catch (err) {
    console.error('POST /api/alerts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/alerts/:id - update alert
app.put('/api/alerts/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { enabled, threshold } = req.body;

    const checkStmt = db.prepare('SELECT id FROM alerts WHERE id = ? AND user_id = ?');
    if (!checkStmt.get(id, DEFAULT_USER_ID)) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const updateStmt = db.prepare(`
      UPDATE alerts
      SET enabled = COALESCE(?, enabled),
          threshold = COALESCE(?, threshold)
      WHERE id = ? AND user_id = ?
    `);

    updateStmt.run(enabled !== undefined ? (enabled ? 1 : 0) : null, threshold || null, id, DEFAULT_USER_ID);

    const selectStmt = db.prepare(`
      SELECT id, ticker, rule_type as ruleType, threshold, enabled, last_triggered_at as lastTriggeredAt, created_at as createdAt
      FROM alerts WHERE id = ?
    `);
    const alert = enrichDipAlert(selectStmt.get(id));

    res.json({ success: true, alert });
  } catch (err) {
    console.error('PUT /api/alerts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/alerts/:id - remove alert
app.delete('/api/alerts/:id', (req, res) => {
  try {
    const checkStmt = db.prepare('SELECT id FROM alerts WHERE id = ? AND user_id = ?');
    if (!checkStmt.get(req.params.id, DEFAULT_USER_ID)) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const deleteStmt = db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?');
    deleteStmt.run(req.params.id, DEFAULT_USER_ID);

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/alerts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contact - handle contact form submissions
app.post('/api/contact', (req, res) => {
  try {
    const { type, name, email, title, message } = req.body;

    // Validate required fields
    if (!type || !name || !email || !title || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // TODO: Send email using a service like SendGrid, Nodemailer, or AWS SES
    // For now, just log the message
    console.log(`Contact form submission: Type=${type}, Name=${name}, Email=${email}, Title=${title}`);
    console.log(`Message: ${message}`);

    res.json({ success: true, message: 'Contact form received. Email functionality will be configured soon.' });
  } catch (err) {
    console.error('POST /api/contact error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.API_PORT || 3000;
app.listen(PORT, () => {
  console.log(`Portfolio tracker server running on http://localhost:${PORT}`);
  console.log(`Database: ${dbPath}`);
});
