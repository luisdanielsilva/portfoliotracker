/**
 * A throwaway database built from the real schema, so tests exercise the same tables the
 * app does without touching data.db. Nothing here reads or writes the live database.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sqlite.sql'), 'utf-8');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function addUser(db, email = 'someone@example.com') {
  return db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid;
}

function addTx(db, userId, { ticker, quantity, amount, type = 'buy', ts, currency = 'EUR', rate = 1 }) {
  return db.prepare(
    `INSERT INTO transactions (user_id, ticker, quantity, amount_eur, currency, exchange_rate, tx_type, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, ticker, quantity, amount, currency, rate, type, ts).lastInsertRowid;
}

function addPrice(db, { ticker, date, eur, native = null, currency = 'USD' }) {
  db.prepare(
    `INSERT INTO prices (ticker, price_eur, price_usd, price_native, currency, price_date, source)
     VALUES (?, ?, ?, ?, ?, ?, 'test')`
  ).run(ticker, eur, null, native === null ? eur : native, currency, date);
}

function addSplit(db, { ticker, date, ratio }) {
  db.prepare('INSERT INTO stock_splits (ticker, split_date, ratio, description) VALUES (?, ?, ?, ?)')
    .run(ticker, date, ratio, `${ratio}-for-1`);
}

const day = n => new Date(Date.UTC(2026, 0, n)).getTime();

module.exports = { freshDb, addUser, addTx, addPrice, addSplit, day };
