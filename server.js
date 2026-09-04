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
