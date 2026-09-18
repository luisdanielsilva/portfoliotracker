/**
 * A throwaway database built from the real schema, so tests exercise the same tables the
 * app does without touching data.db. Nothing here reads or writes the live database.
 */
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sqlite.sql'), 'utf-8');
const IDENTITY_SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.identity.sql'), 'utf-8');

/**
 * The financial database, with its identity counterpart hanging off it as
 * `db.identity`. Two files in production, two connections here, joined by the
 * same opaque key — so a test exercises the split rather than pretending it away.
 */
function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const identity = new Database(':memory:');
  identity.pragma('foreign_keys = ON');
  identity.exec(IDENTITY_SCHEMA);
  db.identity = identity;
  return db;
}

/**
 * Creates an identity and returns its **key**, not its row id — because the key
 * is what every financial table stores. Tests written before the split keep
 * working unchanged: the value they pass around simply became a string.
 */
function addUser(db, email = 'someone@example.com') {
  const key = crypto.randomUUID();
  db.identity.prepare('INSERT INTO users (user_key, email) VALUES (?, ?)').run(key, email);
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(key);
  return key;
}

/** The identity row id, for the few tests that need to write a session. */
function identityIdFor(db, key) {
  return db.identity.prepare('SELECT id FROM users WHERE user_key = ?').get(key).id;
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


/**
 * The same throwaway database with every migration applied — which is what the
 * running app actually has. schema.sqlite.sql alone is missing anything added by
 * an ALTER, `prices.price_native` among them, so a test that inserts a price
 * needs this rather than freshDb().
 */
function migratedDb() {
  const db = freshDb();
  const m = require('../db-migrations.js');
  m.ensurePriceCurrencyColumns(db);
  m.ensureAlertCurrency(db);
  m.ensureGainRuleType(db);
  m.ensureDropFromHighRuleType(db);
  m.ensureAlgorithmAlertSettings(db);
  m.ensureAlertEventLog(db);
  m.ensureWatchlist(db);
  return db;
}

/** Put a ticker on somebody's watchlist, with or without a reference price. */
function addWatch(db, userId, { ticker, referenceEur = null, referenceNative = null,
                                currency = 'USD', source = 'spotted', note = null }) {
  db.prepare(
    `INSERT INTO watchlist (user_id, ticker, reference_price_eur, reference_price_native,
                            currency, reference_source, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, ticker, referenceEur,
        referenceNative === null ? referenceEur : referenceNative, currency, source, note);
}

module.exports = { freshDb, migratedDb, addUser, identityIdFor, addTx, addPrice, addSplit, addWatch, day };
