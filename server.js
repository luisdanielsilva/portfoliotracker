#!/usr/bin/env node
const express = require('express');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();

// MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'portfoliotracker',
  password: process.env.DB_PASSWORD || 'portfolio_secure_pwd_2026',
  database: process.env.DB_NAME || 'portfoliotracker_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

app.use(express.json());
app.use(express.static(__dirname));

// Default user ID (Phase 1 MVP - single user)
const DEFAULT_USER_ID = 1;

// GET /api/transactions - retrieve all transactions
app.get('/api/transactions', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [rows] = await conn.execute(
      'SELECT id, ticker, quantity, amount_eur as amount, currency, exchange_rate as exchangeRate, tx_type as type, ts FROM transactions WHERE user_id = ? ORDER BY ts DESC',
      [DEFAULT_USER_ID]
    );
    conn.release();
    res.json({ transactions: rows });
  } catch (err) {
    console.error('GET /api/transactions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/transactions - create new transaction
app.post('/api/transactions', async (req, res) => {
  try {
    const tx = req.body;

    // Validate required fields
    if (!tx.ts || !tx.ticker || !tx.quantity || !tx.amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const conn = await pool.getConnection();

    // Insert transaction
    const [result] = await conn.execute(
      `INSERT INTO transactions
       (user_id, ticker, quantity, amount_eur, currency, exchange_rate, tx_type, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        DEFAULT_USER_ID,
        tx.ticker,
        tx.quantity,
        tx.amountEUR || tx.amount,
        tx.currency || 'EUR',
        tx.exchangeRate || 1.0,
        tx.type || 'buy',
        tx.ts,
      ]
    );

    // Fetch the inserted transaction
    const [rows] = await conn.execute(
      'SELECT id, ticker, quantity, amount_eur as amount, currency, exchange_rate as exchangeRate, tx_type as type, ts FROM transactions WHERE id = ?',
      [result.insertId]
    );
    conn.release();

    const transaction = rows[0];
    res.json({ success: true, transaction });
  } catch (err) {
    console.error('POST /api/transactions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/transactions/:id - remove transaction
app.delete('/api/transactions/:id', async (req, res) => {
  try {
    const conn = await pool.getConnection();

    // Check if transaction exists
    const [rows] = await conn.execute(
      'SELECT id FROM transactions WHERE id = ? AND user_id = ?',
      [req.params.id, DEFAULT_USER_ID]
    );

    if (rows.length === 0) {
      conn.release();
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Delete transaction
    await conn.execute(
      'DELETE FROM transactions WHERE id = ? AND user_id = ?',
      [req.params.id, DEFAULT_USER_ID]
    );
    conn.release();

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/transactions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.API_PORT || 3000;
app.listen(PORT, () => {
  console.log(`Portfolio tracker server running on http://localhost:${PORT}`);
  console.log(`Database: ${process.env.DB_NAME || 'portfoliotracker_db'}`);
});
