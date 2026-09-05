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

// 74 original snapshot dates (for interpolation)
const ORIGINAL_SNAPSHOT_DATES = [
  "2023-06-10T16:36", "2023-06-19T18:54", "2023-06-30T16:39", "2023-07-03T13:12",
  "2023-07-03T23:13", "2023-07-11T22:51", "2023-07-17T18:58", "2023-07-19T17:23",
  "2023-07-21T15:13", "2023-08-18T00:02", "2023-08-28T00:16", "2024-03-07T22:07",
  "2024-03-12T20:25", "2024-03-18T11:03", "2024-03-22T17:11", "2024-03-27T16:58",
  "2024-04-05T21:09", "2024-04-09T11:24", "2024-04-09T21:52", "2024-04-11T14:21",
  "2024-04-14T13:29", "2024-04-16T10:08", "2024-04-17T17:38", "2024-04-22T12:23",
  "2024-05-31T15:14", "2024-06-11T23:38", "2024-07-03T19:57", "2024-10-07T16:26",
  "2024-10-25T16:59", "2024-11-13T19:49", "2024-11-18T18:44", "2024-12-05T15:46",
  "2024-12-05T21:04", "2024-12-07T13:59", "2024-12-12T10:18", "2024-12-17T16:39",
  "2024-12-18T23:22", "2025-01-05T18:20", "2025-01-17T19:54", "2025-01-22T21:38",
  "2025-01-30T20:45", "2025-02-03T17:23", "2025-02-06T09:00", "2025-02-11T15:47",
  "2025-02-21T15:53", "2025-02-26T16:28", "2025-03-03T16:27", "2025-03-12T15:07",
  "2025-06-06T21:32", "2025-07-05T16:18", "2025-09-15T15:06", "2025-11-01T13:37",
  "2025-11-07T10:43", "2025-12-10T13:59", "2025-12-26T11:39", "2026-01-03T11:00",
  "2026-02-09T14:55", "2026-03-30T15:41", "2026-05-07T12:27", "2026-05-08T20:58",
  "2026-05-10T18:50", "2026-05-11T15:07", "2026-05-13T08:44", "2026-05-14T13:44",
  "2026-05-19T17:41", "2026-05-29T19:20", "2026-05-29T19:27", "2026-06-12T15:15",
  "2026-06-27T17:40", "2026-07-08T18:27", "2026-07-14T09:47", "2026-08-10T10:18",
  "2026-08-22T10:00", "2026-08-31T19:01"
];

// GET /api/snapshots - compute snapshots from transactions with interpolation
app.get('/api/snapshots', (req, res) => {
  try {
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

    // Generate snapshots for all 74 original dates by interpolating
    const snapshots = ORIGINAL_SNAPSHOT_DATES.map(dateStr => {
      const ts = new Date(dateStr).getTime();

      // Find the most recent transaction at or before this date
      let stateAtDate = {}; // empty if no transactions yet
      for (const snap of transactionSnapshots) {
        if (snap.ts <= ts) {
          stateAtDate = JSON.parse(JSON.stringify(snap.holdings));
        } else {
          break;
        }
      }

      // Build holdings array
      const holdingsArray = Object.entries(stateAtDate)
        .filter(([_, h]) => h.qty > 0) // Only include positive positions
        .map(([ticker, h]) => ({
          ticker,
          quantity: h.qty,
          amount: h.totalAmount,
          costPerShare: h.qty > 0 ? h.totalAmount / h.qty : 0
        }));

      const portfolioTotal = Object.values(stateAtDate).reduce((sum, h) => sum + h.totalAmount, 0);

      return {
        date: new Date(dateStr).toISOString(),
        ts,
        holdings: holdingsArray,
        portfolioTotal
      };
    });

    res.json({ snapshots });
  } catch (err) {
    console.error('GET /api/snapshots error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alerts - retrieve user's alerts
app.get('/api/alerts', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT id, ticker, rule_type as ruleType, threshold, enabled, last_triggered_at as lastTriggeredAt, created_at as createdAt
      FROM alerts
      WHERE user_id = ?
      ORDER BY created_at DESC
    `);
    const alerts = stmt.all(DEFAULT_USER_ID);
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
    const newAlert = selectStmt.get(result.lastInsertRowid);

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
    const alert = selectStmt.get(id);

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

const PORT = process.env.API_PORT || 3000;
app.listen(PORT, () => {
  console.log(`Portfolio tracker server running on http://localhost:${PORT}`);
  console.log(`Database: ${dbPath}`);
});
