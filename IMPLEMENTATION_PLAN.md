# Portfolio Tracker — Detailed Implementation Plan

**Date:** September 4, 2026  
**Duration:** ~4 weeks (6 phases)  
**Approach:** Evolve existing codebase; keep HTML/Node.js frontend; add SQLite backend; deploy directly to VPS  
**Database:** SQLite (file-based, no server needed)

---

## Overview & Architecture Decisions

### Current State
- Single HTML file (1396 lines) with embedded data and charting logic
- Express.js backend (65 lines) with 3 endpoints: GET/POST/DELETE `/api/transactions`
- File-based persistence (data.json) for transactions
- Browser localStorage for user-added snapshots
- Nginx reverse proxy forwarding `/portfoliotracker/api/` to Node.js on port 3000
- Deployed on Hetzner VPS with manual copy-to-docroot

### Target Architecture
- Keep HTML/CSS/JS frontend unchanged initially (it's complex; don't risk breaking it)
- Backend: swap file I/O for SQLite queries (file-based, no server installation needed)
- Add compute layer for snapshots (on-the-fly from transactions + prices)
- Price fetching: standalone Node.js script, scheduled via systemd timer or cron
- Alerts: stored in DB, evaluated during price fetch, email delivery
- Multi-user: add user table, auth context (start simple: JWT or API keys)
- Multi-currency: store transaction currency, convert to EUR at save time (or keep both)
- SQLite advantages: no DB server, lightweight, perfect for MVP, entire DB is one file (data.db)

### Key Architectural Decisions
1. **No snapshots table**: Snapshots are computed views (current state + transaction history)
2. **Prices cached daily**: separate table prevents repeated fetches; feeds into live calculations
3. **Email alerts async**: evaluated after price fetch, sent via SMTP (Sendgrid/AWS SES/local postfix)
4. **Multi-user scope**: all tables have `user_id` foreign key; auth via JWT tokens (simple, stateless)
5. **Backward compatibility**: data.json migration path; frontend works unchanged initially

---

## PHASE BREAKDOWN

### PHASE 1: Database Foundation & Migration (Days 1–4)

**Objectives:**
- Initialize SQLite database with schema
- Migrate transactions from data.json to SQLite
- Swap server.js file I/O for SQLite queries
- Validate data integrity

**Mini-tasks:**

1. **Install SQLite & initialize database** (0.5 day)
   - Install `better-sqlite3` npm package (synchronous SQLite driver)
   - Create `data.db` file in project root
   - Schema auto-initialized on first server start

2. **Design schema** (0.5 day)
   - `users` table (id, email, api_key, created_at)
   - `transactions` table (id, user_id, ticker, quantity, amount_eur, currency, rate_used, ts, tx_type, notes)
   - `prices` table (id, ticker, price_eur, date, source, updated_at)
   - `alerts` table (id, user_id, ticker, rule_type, threshold, enabled, last_triggered)
   - See schema spec below

3. **Update server.js** (1 day)
   - Add `mysql2/promise` package (async/await support)
   - Replace `loadData()` / `saveData()` with DB queries
   - Update endpoints: GET, POST, DELETE `/api/transactions`
   - Add simple auth middleware (API key header or no-auth for MVP)

4. **Migrate data** (0.5 day)
   - Export data.json to CSV
   - Write migration script: `migrate.js`
   - Populate users table with default user
   - Load transactions; validate row count + totals
   - Keep data.json as backup

5. **Test & validation** (1 day)
   - Verify all 3 endpoints work with DB
   - Test transaction add/delete/get
   - Compare output against original data.json
   - Check frontend still renders correctly

**Critical Files for Phase 1:**
- `/home/deploy/portfoliotracker/server.js` (rewrite DB layer)
- New: `/home/deploy/portfoliotracker/migrate.js` (one-time migration)
- New: `/home/deploy/portfoliotracker/.env` (DB credentials, git-ignored)
- Updated: `/home/deploy/portfoliotracker/package.json` (add mysql2)

**Checkpoint #1 (End of Phase 1):**
- [ ] MySQL running on VPS
- [ ] All 3 transaction endpoints return data from DB (not file)
- [ ] Data migrated; row counts match
- [ ] Frontend loads transactions and displays them (no visual change)
- [ ] Backup of data.json preserved; can rollback if needed

---

### PHASE 2: Price Fetching Job (Days 5–8)

**Objectives:**
- Fetch stock prices daily from Yahoo Finance
- Store in DB; make available to frontend
- Schedule job via systemd timer (more reliable than cron on systemd systems)
- No frontend changes yet (just feeds data layer)

**Mini-tasks:**

1. **Design price-fetch script** (0.5 day)
   - New file: `price-fetch.js`
   - Takes ticker list from transactions table (unique)
   - Fetches from Yahoo Finance API (via `yfinance` Node.js wrapper or HTTP calls)
   - Converts to EUR if needed (use ECB or Xe.com API for USD→EUR)
   - Upserts into `prices` table
   - Logs results to file

2. **Handle Yahoo Finance alternatives** (0.5 day)
   - Option A: `node-yahoo-finance2` npm package (recommended; pure JS)
   - Option B: Call Python script (if yfinance preferred) via child_process
   - Option C: Fallback to static rate (less ideal but handles API outages)
   - **Recommendation:** Use `node-yahoo-finance2` for simplicity; no external processes

3. **Currency conversion** (0.5 day)
   - Store exchange rates in separate table: `exchange_rates` (from_currency, to_currency, rate, date)
   - Update daily (or on-demand) via ECB API or similar
   - Use cached rates; fall back to last-known if API down

4. **Schedule via systemd** (0.5 day)
   - Create `portfoliotracker-price-fetch.service` (runs `node price-fetch.js`)
   - Create `portfoliotracker-price-fetch.timer` (daily at 09:00 UTC)
   - Enable and test: `systemctl start portfoliotracker-price-fetch.timer`
   - Alternative: cron `0 9 * * * cd /home/deploy/portfoliotracker && node price-fetch.js >> logs/price-fetch.log 2>&1`

5. **Logging & error handling** (0.5 day)
   - Create `logs/` directory
   - Write start/end timestamps, fetched tickers, any failures
   - Email admin if fetch fails (integrate with alert system later)

6. **Test manually** (1.5 days)
   - Run `node price-fetch.js` by hand
   - Verify prices in DB for a few tickers (TSLA, VW, etc.)
   - Check data quality (no NaN, reasonable ranges)
   - Test with a few currencies
   - Verify timer fires automatically

7. **Frontend integration (read-only)** (0.5 day)
   - Add new endpoint: `GET /api/prices?ticker=TSLA` or `GET /api/prices/latest`
   - Frontend can now display current prices (optional; show in UI if available)
   - No breaking changes

**Critical Files for Phase 2:**
- New: `/home/deploy/portfoliotracker/price-fetch.js` (main job)
- New: `/etc/systemd/system/portfoliotracker-price-fetch.service`
- New: `/etc/systemd/system/portfoliotracker-price-fetch.timer`
- Updated: `/home/deploy/portfoliotracker/server.js` (add /api/prices endpoint)
- Updated: `package.json` (add node-yahoo-finance2)
- New: `/home/deploy/portfoliotracker/logs/` directory

**Checkpoint #2 (End of Phase 2):**
- [ ] MySQL `prices` table populated with real data
- [ ] `price-fetch.js` runs successfully by hand
- [ ] Systemd timer fires daily at scheduled time
- [ ] `GET /api/prices` endpoint returns latest prices
- [ ] No frontend errors; transaction data still loads
- [ ] Logs created; can inspect fetch history

---

### PHASE 3: Alert System (Days 9–11)

**Objectives:**
- Users define alert rules (e.g., "notify if TSLA > 500 EUR")
- System evaluates after each price fetch
- Send email alerts
- Frontend UI to manage rules

**Mini-tasks:**

1. **Alert schema** (0.5 day)
   - `alerts` table: id, user_id, ticker, rule_type (price_above/below/change_pct), threshold, enabled, last_triggered_at, created_at
   - Example: (user=1, ticker=TSLA, rule=price_above, threshold=500.00, enabled=true)

2. **Email service setup** (0.5 day)
   - Integrate nodemailer or service like Sendgrid/AWS SES
   - Store credentials in .env
   - Test send to admin email
   - Create email template (simple HTML)

3. **Alert evaluation logic** (0.5 day)
   - Add to `price-fetch.js`:
     - After fetching prices, query active alerts
     - For each alert, check if rule triggered
     - Only send if last_triggered was >24h ago (avoid spam)
     - Update last_triggered_at; log result

4. **Backend endpoints** (0.5 day)
   - `POST /api/alerts` – create new alert rule
   - `GET /api/alerts` – list user's alerts
   - `PUT /api/alerts/:id` – update (enable/disable/threshold)
   - `DELETE /api/alerts/:id` – remove rule

5. **Frontend UI** (1 day)
   - Add tab or section: "Price Alerts"
   - Form to create alert: ticker, rule, threshold, email
   - List of active alerts with edit/delete
   - Show last triggered time
   - **Note:** Keep inline with existing UI style

6. **Test & validation** (0.5 day)
   - Manually trigger price fetch
   - Verify alerts evaluated
   - Check email received
   - Test enable/disable
   - Test threshold updates

**Critical Files for Phase 3:**
- Updated: `/home/deploy/portfoliotracker/price-fetch.js` (add alert evaluation)
- Updated: `/home/deploy/portfoliotracker/server.js` (add alert endpoints)
- Updated: `/home/deploy/portfoliotracker/index.html` (add alerts UI tab)
- New: `/home/deploy/portfoliotracker/email-template.html`
- Updated: `.env` (SMTP credentials)
- Updated: `package.json` (add nodemailer)

**Checkpoint #3 (End of Phase 3):**
- [ ] Alert rules stored in DB; CRUD endpoints work
- [ ] Price fetch triggers alert evaluation
- [ ] Test email received at specified address
- [ ] Frontend can create/edit/delete alerts
- [ ] No spam (throttle to once per 24h per rule)
- [ ] Logging shows which alerts triggered

---

### PHASE 4: Multi-User Support (Days 12–14)

**Objectives:**
- Each user has isolated data (transactions, alerts, snapshots)
- Simple auth: API key or JWT token
- Frontend stores and sends auth token
- No complex OAuth yet (keep it simple)

**Mini-tasks:**

1. **Auth scheme design** (0.5 day)
   - **Option A (simpler):** API key header `X-API-Key: <key>`
     - Users table has generated api_key column
     - POST /auth/register → returns api_key
     - POST /auth/login → returns api_key
   - **Option B (more typical):** JWT tokens (sub claim = user_id)
     - POST /auth/register → returns token
     - Token stored in localStorage (frontend)
     - Middleware validates on each request
   - **Recommendation:** Start with Option A (simpler, doesn't require token refresh logic); migrate to JWT later if needed

2. **Users table & registration** (0.5 day)
   - Migrate existing data: create default user (id=1)
   - Add registration endpoint: `POST /auth/register` (email + password)
   - Hash password (use bcrypt)
   - Return api_key to client
   - Store in .env for local testing

3. **Auth middleware** (0.5 day)
   - Add to server.js: middleware that extracts/validates api_key
   - Reject if no key or invalid
   - Set `req.user_id` for downstream use

4. **Scope all queries to user** (1.5 days)
   - Update all transaction queries: add `WHERE user_id = ?`
   - Update all alert queries: add `WHERE user_id = ?`
   - Update all price queries (no user scoping; prices are global)
   - Verify no data leakage between users

5. **Frontend auth** (1 day)
   - Add login/register form (modal or page)
   - Store api_key in localStorage
   - Include `X-API-Key` header on all API calls
   - Handle 401 responses → redirect to login
   - **Note:** Keep HTML structure; add UI via CSS + JS only

6. **Test multi-user** (0.5 day)
   - Register 2 test users
   - Add transactions as user 1, verify user 2 can't see them
   - Add alerts as user 2, verify user 1 doesn't receive them
   - Verify price data shared across users

**Critical Files for Phase 4:**
- Updated: `/home/deploy/portfoliotracker/server.js` (auth middleware, user scoping)
- Updated: `/home/deploy/portfoliotracker/index.html` (login UI, api_key storage, headers)
- Updated: `package.json` (add bcrypt)
- Updated: Database schema (add password field, hashed)

**Checkpoint #4 (End of Phase 4):**
- [ ] Users can register and receive api_key
- [ ] Each user's transactions isolated
- [ ] Each user's alerts isolated
- [ ] Frontend sends api_key on all requests
- [ ] Data leakage tests pass
- [ ] Login/logout UI works

---

### PHASE 5: Snapshot Computation & Portfolio View (Days 15–16)

**Objectives:**
- Compute live portfolio snapshot from transactions + current prices
- Expose via new endpoint: `GET /api/portfolio` (user's current holdings)
- Frontend can optionally display live portfolio value (optional enhancement)

**Mini-tasks:**

1. **Snapshot computation logic** (0.5 day)
   - New function in server.js: `computePortfolioSnapshot(userId, asOfDate?)`
   - Group transactions by ticker
   - Sum quantities (buy = +, sell = -)
   - Get latest price for each ticker (from prices table)
   - Calculate value in EUR
   - Return array: [{ticker, qty, price, value_eur}, ...]

2. **Portfolio endpoint** (0.5 day)
   - `GET /api/portfolio` → returns today's snapshot
   - `GET /api/portfolio?asOf=2026-08-31` → returns historical snapshot (reconstructed from prices + transactions up to that date)
   - Include totals (total_eur, by_holding breakdown)

3. **Frontend integration** (0.5 day)
   - Optional: display live portfolio value in header (if API available)
   - Or: just compute via existing JS logic (no change needed)
   - Verify no visual regression

4. **Test** (0.5 day)
   - Verify portfolio value = sum(qty × price) for each ticker
   - Compare against manual calculation
   - Test with historical dates

**Critical Files for Phase 5:**
- Updated: `/home/deploy/portfoliotracker/server.js` (computePortfolioSnapshot function, /api/portfolio endpoint)
- Updated: `/home/deploy/portfoliotracker/index.html` (optional: display live value)

**Checkpoint #5 (End of Phase 5):**
- [ ] `GET /api/portfolio` returns current holdings
- [ ] Portfolio value = sum(qty × price)
- [ ] Historical snapshots work (as-of dates)
- [ ] Frontend renders without errors
- [ ] Data matches manual spot-checks

---

### PHASE 6: Testing, Performance & Go-Live (Days 17–18)

**Objectives:**
- Validate data integrity
- Performance test under load
- Deploy to production
- Rollback plan if needed

**Mini-tasks:**

1. **Data migration validation** (0.5 day)
   - Run `migrate.js` on prod DB (from backup data.json)
   - Verify row counts, checksums, totals
   - Compare frontend render: old vs. new backend (should be identical)

2. **Load test** (0.5 day)
   - Simulate 100 requests/sec to transaction endpoints
   - Monitor MySQL performance
   - Identify bottlenecks (add indexes if needed)

3. **Backup & rollback plan** (0.5 day)
   - Backup prod DB before cutover
   - Have data.json ready as fallback
   - Document rollback steps

4. **Deploy to production** (0.5 day)
   - Deploy new server.js (with MySQL queries)
   - Start MySQL (if not already running)
   - Run migration to prod DB
   - Enable price-fetch timer
   - Monitor logs for errors

5. **Smoke tests** (0.5 day)
   - Add a transaction via frontend; verify it appears
   - Delete a transaction; verify removal
   - Check alert email (trigger manually)
   - Verify prices update daily

6. **Documentation** (0.5 day)
   - Update README with DB setup steps
   - Document env var requirements
   - Explain price-fetch job, alert system
   - Provide troubleshooting guide

**Critical Files for Phase 6:**
- Updated: `/home/deploy/portfoliotracker/README.md`
- New: `/home/deploy/portfoliotracker/DEPLOYMENT.md` (runbook)
- New: `/home/deploy/portfoliotracker/backup-db.sh`

**Checkpoint #6 (End of Phase 6):**
- [ ] Prod DB migrated; no data loss
- [ ] All endpoints work in production
- [ ] Price fetch runs daily
- [ ] Alerts send emails
- [ ] Frontend unchanged (visual parity with old version)
- [ ] Documentation complete

---

## DATABASE SCHEMA

```sql
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

-- Prices table (global, not per-user)
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

-- Exchange rates table (for multi-currency support)
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
```

---

## CODE CHANGES SUMMARY

### server.js – Key Transformations

**Before (file I/O):**
```javascript
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }
  return { transactions: [], snapshots: [] };
}

app.get('/api/transactions', (req, res) => {
  const data = loadData();
  res.json({ transactions: data.transactions });
});
```

**After (MySQL):**
```javascript
const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Auth middleware
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing API key' });
  // Validate key against DB (cache results)
  req.userId = 1; // Simplified; real impl queries users table
  next();
});

app.get('/api/transactions', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [rows] = await conn.execute(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY ts DESC',
      [req.userId]
    );
    conn.release();
    res.json({ transactions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

---

## TESTING & VERIFICATION CHECKPOINTS

| Phase | Checkpoint | How to Verify |
|-------|-----------|---------------|
| 1 | DB schema created | `mysql> SHOW TABLES;` returns 5 tables |
| 1 | Transactions migrated | `SELECT COUNT(*) FROM transactions;` matches data.json |
| 1 | Endpoints work | `curl /api/transactions` returns JSON from DB |
| 2 | Price fetch runs | `SELECT * FROM prices;` has data for all tickers |
| 2 | Timer scheduled | `systemctl status portfoliotracker-price-fetch.timer` → active |
| 3 | Alerts table populated | `SELECT * FROM alerts;` shows test alerts |
| 3 | Email sent | Check inbox for test alert email |
| 4 | Auth working | `curl /api/transactions` without API key → 401 |
| 4 | Data isolated | User 1 can't see User 2's transactions |
| 5 | Portfolio endpoint | `curl /api/portfolio` returns current holdings |
| 6 | No data loss | Manual spot-check: old frontend + new backend = same values |
| 6 | Performance OK | Load test: 100 req/s → <200ms response time |

---

## DEPLOYMENT STEPS (Per Phase)

### Phase 1:
```bash
# SQLite setup is automatic — no server installation needed!

# Install dependencies:
npm install better-sqlite3

# Create .env with SQLite path:
echo "DB_PATH=./data.db" >> .env

# The schema is auto-initialized on first server start

# Commit code changes:
git add server.js package.json migrate.js schema.sqlite.sql .env.example
git commit -m "Add SQLite backend"

# Deploy:
./deploy.sh

# Optional: run migration to populate from data.json:
node migrate.js
```

### Phase 2:
```bash
npm install node-yahoo-finance2

# On VPS, create systemd files:
sudo cp portfoliotracker-price-fetch.service /etc/systemd/system/
sudo cp portfoliotracker-price-fetch.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable portfoliotracker-price-fetch.timer
sudo systemctl start portfoliotracker-price-fetch.timer

# Test:
node price-fetch.js

# Check status:
sudo systemctl status portfoliotracker-price-fetch.timer
sudo journalctl -u portfoliotracker-price-fetch -n 50
```

### Phase 3:
```bash
npm install nodemailer

# Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD to .env
npm test -- alerts
./deploy.sh
```

### Phase 4:
```bash
npm install bcrypt

git add . && git commit -m "Add multi-user auth"
./deploy.sh

# Test:
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "pass"}'
```

### Phase 5 & 6:
```bash
# Final smoke tests
curl http://localhost:3000/api/transactions \
  -H "X-API-Key: <key>" | jq .

# Verify prices updated
mysql -u portfoliotracker -p portfoliotracker_db \
  -e "SELECT * FROM prices ORDER BY updated_at DESC LIMIT 5;"

# Check alert emails received
./deploy.sh
```

---

## POTENTIAL PITFALLS & MITIGATIONS

| Risk | Mitigation |
|------|------------|
| MySQL not installed | Document install steps; pre-test on staging |
| Yahoo Finance API rate limits | Cache prices; respect rate limit headers |
| Email SMTP unreliable | Use service like Sendgrid; add retry logic |
| Data loss in migration | Backup data.json first; dry-run on staging |
| Frontend breaks with DB | Ensure response format identical to file-based version |
| Timezone issues (prices vs. transactions) | Store all timestamps as UTC; convert on display |
| Multi-user auth complexity | Start with simple API key; add JWT later if needed |
| Performance regression | Monitor query times; add indexes on user_id, ticker |

---

## RECOMMENDED SEQUENCE (Realistic Timeline)

1. **Weeks 1–2: Phase 1 + Phase 2** (overlap is OK)
   - Days 1–4: DB setup + migration
   - Days 5–8: Price fetching job (runs in parallel)
   - Checkpoint: Prod DB working, prices updating daily

2. **Week 3: Phase 3 + Phase 4** (overlap)
   - Days 9–11: Alert system
   - Days 12–14: Multi-user auth
   - Checkpoint: Users isolated, alerts emailing

3. **Week 4: Phase 5 + Phase 6**
   - Days 15–16: Snapshot API
   - Days 17–18: Testing, docs, go-live
   - Checkpoint: All features working, no data loss

**Total: ~4 weeks**

---

## CRITICAL FILES SUMMARY

Files to create/modify in Phase 1:
- `/home/deploy/portfoliotracker/server.js` (swap file I/O for MySQL queries; add auth middleware)
- `/home/deploy/portfoliotracker/price-fetch.js` (new: scheduled price fetching job)
- `/home/deploy/portfoliotracker/migrate.js` (new: one-time data.json → MySQL migration)
- `/home/deploy/portfoliotracker/index.html` (minimal updates: add API key storage, auth headers)
- `/home/deploy/portfoliotracker/package.json` (add mysql2, node-yahoo-finance2, bcrypt, nodemailer)
- `/home/deploy/portfoliotracker/.env` (new: DB credentials, SMTP config, git-ignored)
- `/home/deploy/portfoliotracker/.env.example` (template for .env)
- `/etc/systemd/system/portfoliotracker-price-fetch.service` (new: systemd service file)
- `/etc/systemd/system/portfoliotracker-price-fetch.timer` (new: systemd timer file)
- `/home/deploy/portfoliotracker/.gitignore` (ensure .env, logs/, node_modules/ ignored)

---

## Next Steps

1. Review this plan
2. Start Phase 1: Install MySQL, design schema, rewrite server.js
3. After each phase checkpoint, commit to git with clear messages
4. Once prototype complete (Phase 1–2), set up GitHub repo

Good luck! 🚀
