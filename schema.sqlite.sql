-- The financial side. `user_id` here holds the opaque key from identity.db, as
-- TEXT — there is no users table in this file and no foreign key to one, which
-- is the point: delete the identity row and what remains here is anonymous.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  quantity REAL NOT NULL,
  amount_eur REAL NOT NULL,
  currency TEXT DEFAULT 'EUR',
  exchange_rate REAL DEFAULT 1,
  tx_type TEXT NOT NULL CHECK(tx_type IN ('buy','sell')),
  ts INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK(rule_type IN ('price_above','price_below','change_pct','dip_from_avg_cost','gain_from_avg_cost','drop_from_high')),
  threshold REAL NOT NULL,
  currency TEXT,
  enabled BOOLEAN DEFAULT 1,
  last_triggered_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_ticker_alert ON alerts(user_id, ticker);
CREATE INDEX IF NOT EXISTS idx_enabled ON alerts(enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_unique ON alerts(user_id, ticker, rule_type, threshold);

-- The algorithm's two timings used to be columns on users. They are preferences
-- about alerting, not identity, so they belong on this side of the line.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  algo_alerts_enabled INTEGER NOT NULL DEFAULT 1,
  algo_hold_days INTEGER NOT NULL DEFAULT 3,
  algo_cooldown_days INTEGER NOT NULL DEFAULT 60
);

CREATE TABLE IF NOT EXISTS algo_alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  fired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  signal_date DATE NOT NULL,
  tier TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_algo_log_user_ticker ON algo_alert_log(user_id, ticker, fired_at DESC);

CREATE TABLE IF NOT EXISTS algo_settings_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  field TEXT NOT NULL,
  old_value INTEGER,
  new_value INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_algo_settings_user ON algo_settings_log(user_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  price_eur REAL NOT NULL,
  price_usd REAL,
  price_native REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  price_date DATE NOT NULL,
  source TEXT DEFAULT 'yahoo_finance',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_ticker_date ON prices(ticker, price_date);
CREATE INDEX IF NOT EXISTS idx_ticker_date ON prices(ticker, price_date DESC);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  date DATE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_rate ON exchange_rates(from_currency, to_currency, date);

CREATE TABLE IF NOT EXISTS stock_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  split_date DATE NOT NULL,
  ratio REAL NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_split ON stock_splits(ticker, split_date);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS data_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
