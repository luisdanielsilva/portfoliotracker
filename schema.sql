-- Users table
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  api_key VARCHAR(64) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_api_key (api_key),
  INDEX idx_email (email)
);

-- Transactions table
CREATE TABLE transactions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  ticker VARCHAR(10) NOT NULL,
  quantity DECIMAL(20, 8) NOT NULL,
  amount_eur DECIMAL(15, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  exchange_rate DECIMAL(10, 6),
  tx_type ENUM('buy', 'sell') NOT NULL,
  ts BIGINT NOT NULL,
  notes VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_ticker (user_id, ticker),
  INDEX idx_user_ts (user_id, ts)
);

-- Prices table
CREATE TABLE prices (
  id INT PRIMARY KEY AUTO_INCREMENT,
  ticker VARCHAR(10) NOT NULL,
  price_eur DECIMAL(15, 4) NOT NULL,
  price_usd DECIMAL(15, 4),
  price_date DATE NOT NULL,
  source VARCHAR(50) DEFAULT 'yahoo_finance',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_ticker_date (ticker, price_date),
  INDEX idx_ticker_date (ticker, price_date DESC)
);

-- Alerts table
CREATE TABLE alerts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  ticker VARCHAR(10) NOT NULL,
  rule_type ENUM('price_above', 'price_below', 'change_pct') NOT NULL,
  threshold DECIMAL(15, 4) NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  last_triggered_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_ticker (user_id, ticker),
  INDEX idx_enabled (enabled)
);

-- Exchange rates table
CREATE TABLE exchange_rates (
  id INT PRIMARY KEY AUTO_INCREMENT,
  from_currency VARCHAR(3) NOT NULL,
  to_currency VARCHAR(3) NOT NULL,
  rate DECIMAL(10, 6) NOT NULL,
  date DATE NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_pair_date (from_currency, to_currency, date),
  INDEX idx_pair_date (from_currency, to_currency, date DESC)
);

SHOW TABLES;
