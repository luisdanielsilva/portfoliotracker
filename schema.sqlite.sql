-- SQLite Schema for Portfolio Tracker

-- Users table (passwordless: identity is the verified email address)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- Algorithm-tab alerts: fixed behaviour, but the user owns the two timings.
  algo_alerts_enabled INTEGER NOT NULL DEFAULT 1,
  algo_hold_days INTEGER NOT NULL DEFAULT 3,
  algo_cooldown_days INTEGER NOT NULL DEFAULT 60
);

CREATE INDEX IF NOT EXISTS idx_email ON users(email);

-- Magic-link login tokens: single-use, short-lived. Only the hash is stored.
CREATE TABLE IF NOT EXISTS login_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_token_hash ON login_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_token_user ON login_tokens(user_id);

-- Sessions: the opaque value stored in the session cookie
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_user ON sessions(user_id);

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

-- Known stock splits, applied when computing historical snapshots and average cost.
--
-- This table and job_runs below existed only in the live database: created by hand,
-- in no schema file and no migration. Everything kept working because the file they
-- were missing from is only read to create what is absent — so a restored backup had
-- them and a fresh deployment would not, and /api/snapshots would have failed on the
-- first request. Found by writing tests against a database built from this file.
CREATE TABLE IF NOT EXISTS stock_splits (
  id INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  split_date TEXT NOT NULL,
  ratio REAL NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- One row per price-fetch run: success / skipped / failed, plus a summary. This is what
-- makes "ran and skipped" distinguishable from "never ran"; before it existed, both
-- outages looked identical in the logs.
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','skipped','failed')),
  summary TEXT,
  ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_job_runs_job_time ON job_runs(job, ran_at DESC);

-- When the Algorithm tab last spoke about a holding, so a long signal is not
-- re-sent every day. Deliberately separate from `alerts`, which is the list the
-- user builds by hand.
CREATE TABLE IF NOT EXISTS algo_alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  fired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  signal_date DATE NOT NULL,
  tier TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence REAL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_algo_log_user_ticker ON algo_alert_log(user_id, ticker, fired_at DESC);

-- Every change to the Algorithm tab's two timings. The signal history is only
-- readable against the settings that were in force at the time.
CREATE TABLE IF NOT EXISTS algo_settings_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  field TEXT NOT NULL,
  old_value INTEGER,
  new_value INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_algo_settings_user ON algo_settings_log(user_id, changed_at DESC);

-- Bumped on every write that could change a computed view. Cache entries are
-- keyed by it, so one process's write retires another process's cached copy.
CREATE TABLE IF NOT EXISTS data_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
INSERT OR IGNORE INTO data_version (id, version) VALUES (1, 1);
