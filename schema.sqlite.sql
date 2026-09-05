-- SQLite Schema for Portfolio Tracker

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  api_key TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create index on api_key for faster lookups
CREATE INDEX IF NOT EXISTS idx_api_key ON users(api_key);
CREATE INDEX IF NOT EXISTS idx_email ON users(email);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  quantity REAL NOT NULL,
  amount_eur REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  exchange_rate REAL,
  tx_type TEXT NOT NULL CHECK(tx_type IN ('buy', 'sell')),
  ts INTEGER NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for transaction queries
CREATE INDEX IF NOT EXISTS idx_user_ticker ON transactions(user_id, ticker);
CREATE INDEX IF NOT EXISTS idx_user_ts ON transactions(user_id, ts);

-- Prices table (global, shared across users)
CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  price_eur REAL NOT NULL,
  price_usd REAL,
  price_date DATE NOT NULL,
  source TEXT DEFAULT 'yahoo_finance',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Unique constraint to prevent duplicate prices for same ticker/date
CREATE UNIQUE INDEX IF NOT EXISTS unique_ticker_date ON prices(ticker, price_date);
CREATE INDEX IF NOT EXISTS idx_ticker_date ON prices(ticker, price_date DESC);

-- Alerts table
CREATE TABLE IF NOT EXISTS alerts (
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

-- Indexes for alert queries
CREATE INDEX IF NOT EXISTS idx_user_ticker_alert ON alerts(user_id, ticker);
CREATE INDEX IF NOT EXISTS idx_enabled ON alerts(enabled);

-- Exchange rates table (for multi-currency support)
CREATE TABLE IF NOT EXISTS exchange_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  date DATE NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Unique constraint for exchange rate pairs
CREATE UNIQUE INDEX IF NOT EXISTS unique_pair_date ON exchange_rates(from_currency, to_currency, date);
CREATE INDEX IF NOT EXISTS idx_pair_date ON exchange_rates(from_currency, to_currency, date DESC);
