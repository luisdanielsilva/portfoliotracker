#!/usr/bin/env node
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();

const app = express();

// Sits behind nginx: trust its X-Forwarded-* headers so req.protocol reflects
// HTTPS and rate limiting keys off the real client IP rather than the proxy's.
app.set('trust proxy', 1);

// SQLite database connection
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Initialize database schema
const schema = require('fs').readFileSync(path.join(__dirname, 'schema.sqlite.sql'), 'utf-8');
db.exec(schema);

// Migration: widen alerts.rule_type CHECK constraint to include 'dip_from_avg_cost'
// (SQLite can't ALTER a CHECK constraint in place, so rebuild the table if needed)
(function migrateAlertsRuleType() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='alerts'").get();
  if (row && !row.sql.includes('dip_from_avg_cost')) {
    db.exec(`
      CREATE TABLE alerts_new (
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
      INSERT INTO alerts_new SELECT * FROM alerts;
      DROP TABLE alerts;
      ALTER TABLE alerts_new RENAME TO alerts;
      CREATE INDEX IF NOT EXISTS idx_user_ticker_alert ON alerts(user_id, ticker);
      CREATE INDEX IF NOT EXISTS idx_enabled ON alerts(enabled);
    `);
    console.log('Migrated alerts table to support dip_from_avg_cost rule_type');
  }
})();

// Migration: stop the same rule being saved twice. Nothing prevented it, and one
// ticker ended up with three identical "dip 5%" rules — which would have meant the
// same row three times in a single alert digest. De-duplicate first (keeping the
// oldest of each group), because the index cannot be created while duplicates exist;
// doing it in this order also keeps a restored older backup bootable.
(function migrateAlertsUnique() {
  const removed = db.prepare(`
    DELETE FROM alerts WHERE id NOT IN (
      SELECT MIN(id) FROM alerts GROUP BY user_id, ticker, rule_type, threshold
    )
  `).run().changes;
  if (removed) console.log(`Removed ${removed} duplicate alert rule(s)`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_unique ON alerts(user_id, ticker, rule_type, threshold)');
})();

// Migration: drop password_hash / api_key from users (passwordless magic-link auth).
// transactions and alerts hold FKs to users(id) with ON DELETE CASCADE, so foreign
// keys MUST be off while the table is swapped out — otherwise DROP TABLE users
// cascade-deletes every transaction and alert in the database.
(function migrateUsersPasswordless() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!row || !(row.sql.includes('api_key') || row.sql.includes('password_hash'))) return;

  db.pragma('foreign_keys = OFF'); // no-op inside a transaction, so it must be set out here
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users_new (id, email, created_at) SELECT id, email, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE INDEX IF NOT EXISTS idx_email ON users(email);
      COMMIT;
    `);
    const problems = db.pragma('foreign_key_check');
    if (problems.length) {
      throw new Error('Foreign key check failed after users migration: ' + JSON.stringify(problems));
    }
    console.log('Migrated users table to passwordless shape (dropped password_hash, api_key)');
  } finally {
    db.pragma('foreign_keys = ON');
  }
})();

// Compute average cost per share (in EUR) currently held for a ticker, from transactions
function getAvgCostPerShare(ticker, userId) {
  const txStmt = db.prepare(`
    SELECT tx_type, quantity, amount_eur FROM transactions
    WHERE user_id = ? AND ticker = ? ORDER BY ts ASC
  `);
  let qty = 0, totalAmount = 0;
  for (const tx of txStmt.all(userId, ticker)) {
    if (tx.tx_type === 'buy') { qty += tx.quantity; totalAmount += tx.amount_eur; }
    else if (tx.tx_type === 'sell') { qty -= tx.quantity; totalAmount -= tx.amount_eur; }
  }
  if (qty <= 0) return null;
  return { avgCostEUR: totalAmount / qty, quantity: qty };
}

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // for the magic-link confirm form
app.use(cookieParser());
app.use(express.static(__dirname));

/* ================= passwordless magic-link auth ================= */

const SESSION_COOKIE = 'pt_session';
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;        // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
// Secure cookies require HTTPS. Production sits behind nginx TLS; allow plain
// HTTP for local testing against localhost:3000 directly.
const COOKIE_SECURE = process.env.COOKIE_INSECURE !== 'true';

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Where to send a freshly signed-in user.
function appUrl() {
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/` : '/';
}

// Issue a session for a user id and set the cookie. Shared by every sign-in path.
//
// The cookie carries the raw secret; the database stores only its SHA-256, the
// same way login_tokens are handled. The rows are therefore useless to anyone who
// reads the database — a backup, a snapshot, a stray copy — because the value a
// browser must present cannot be derived from what is stored.
function startSession(res, userId) {
  const rawSessionId = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(rawSessionId), userId, new Date(Date.now() + SESSION_TTL_MS).toISOString());
  res.cookie(SESSION_COOKIE, rawSessionId, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
  return rawSessionId;
}

// One account per email address, regardless of which sign-in path created it.
// A Google login for an email that already exists attaches to that account.
function findOrCreateUserByEmail(email) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid;
}

// Mirrors the SMTP-optional pattern in price-fetch.js: if SMTP isn't configured,
// callers fall back to logging the magic link instead of emailing it.
function initMailer() {
  if (!process.env.SMTP_HOST) return null;
  const port = parseInt(process.env.SMTP_PORT || '25');
  // Port 465 = implicit TLS (secure: true)
  // Port 587 = STARTTLS after connect (secure: false)
  const secure = port === 465;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: port,
    secure: secure,
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD
    } : undefined
  });
}
const authMailer = initMailer();

function logMagicLink(email, link, reason) {
  console.log(`\n=== MAGIC LINK for ${email} (${reason}) ===\n${link}\n=== expires in 15 min ===\n`);
}

async function sendMagicLink(email, link) {
  if (!authMailer) {
    logMagicLink(email, link, 'SMTP not configured');
    return;
  }
  try {
    await authMailer.sendMail({
      from: process.env.AUTH_EMAIL_FROM || process.env.ALERT_EMAIL_FROM || 'login@portfoliotracker.local',
      to: email,
      subject: 'Your Portfolio Tracker login link',
      html: `<p>Click below to sign in. This link works once and expires in 15 minutes.</p>
             <p><a href="${link}">Sign in to Portfolio Tracker</a></p>
             <p style="color:#666;font-size:12px">If you didn't request this, you can ignore this email.</p>`
    });
  } catch (err) {
    // Never let a broken mailer swallow the only way in — log it instead.
    console.error(`Magic-link email to ${email} failed: ${err.message}`);
    logMagicLink(email, link, 'email send failed');
  }
}

// Rate limiters for the link-request endpoint (per the plan's security section)
const requestLinkIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "If that's a valid email, a login link is on its way." }
});
const emailAttempts = new Map(); // email -> [timestamps]
function emailRateLimited(email) {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const hits = (emailAttempts.get(email) || []).filter(t => t > windowStart);
  hits.push(now);
  emailAttempts.set(email, hits);
  return hits.length > 5;
}

// POST /api/auth/request-link - send a magic link (public)
// Always returns the same response whether the email is new, known, or rate limited.
app.post('/api/auth/request-link', requestLinkIpLimiter, async (req, res) => {
  const generic = { message: "If that's a valid email, a login link is on its way." };
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json(generic);
    if (emailRateLimited(email)) return res.json(generic);

    const userId = findOrCreateUserByEmail(email);

    const rawToken = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO login_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .run(userId, hashToken(rawToken), new Date(Date.now() + LOGIN_TOKEN_TTL_MS).toISOString());

    const base = (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    await sendMagicLink(email, `${base}/api/auth/verify?token=${rawToken}`);

    res.json(generic);
  } catch (err) {
    console.error('POST /api/auth/request-link error:', err.message);
    res.json(generic); // never leak failure detail on this endpoint
  }
});

// GET /api/auth/verify?token=... - shows a confirm page, does NOT consume the token (public)
// Corporate mail gateways (e.g. Microsoft Safe Links) auto-fetch every link in an
// incoming email to scan it, which would burn a one-time token before the user ever
// clicks it. Splitting into GET (render) + POST (consume) means only a real click on
// the button below - not an automated scanner - completes sign-in.
app.get('/api/auth/verify', (req, res) => {
  try {
    const rawToken = String(req.query.token || '');
    if (!rawToken) return res.status(400).send('Missing token');

    const row = db.prepare(`
      SELECT id, used_at, expires_at FROM login_tokens WHERE token_hash = ?
    `).get(hashToken(rawToken));

    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).send('This login link is invalid or has expired. Please request a new one.');
    }

    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sign in to Portfolio Tracker</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto;text-align:center;padding:0 20px}
button{font-size:16px;padding:12px 28px;border-radius:8px;border:none;background:#111;color:#fff;cursor:pointer}
button:hover{background:#333}</style></head>
<body>
  <p>Click below to finish signing in to Portfolio Tracker.</p>
  <form method="POST" action="./verify">
    <input type="hidden" name="token" value="${escapeHtml(rawToken)}">
    <button type="submit">Sign in</button>
  </form>
</body></html>`);
  } catch (err) {
    console.error('GET /api/auth/verify error:', err.message);
    res.status(500).send('Could not complete sign-in.');
  }
});

// POST /api/auth/verify - actually consumes the token and starts a session (public)
app.post('/api/auth/verify', (req, res) => {
  try {
    const rawToken = String(req.body.token || '');
    if (!rawToken) return res.status(400).send('Missing token');

    const row = db.prepare(`
      SELECT id, user_id, expires_at, used_at FROM login_tokens WHERE token_hash = ?
    `).get(hashToken(rawToken));

    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).send('This login link is invalid or has expired. Please request a new one.');
    }

    db.prepare('UPDATE login_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);

    startSession(res, row.user_id);
    res.redirect(appUrl());
  } catch (err) {
    console.error('POST /api/auth/verify error:', err.message);
    res.status(500).send('Could not complete sign-in.');
  }
});

/* --- Google OAuth (authorization code flow) --- */

const GOOGLE_STATE_COOKIE = 'pt_oauth_state';
const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;
const googleRedirectUri = `${(process.env.APP_BASE_URL || '').replace(/\/$/, '')}/api/auth/google/callback`;
const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.APP_BASE_URL);
const googleClient = googleEnabled
  ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, googleRedirectUri)
  : null;
if (!googleEnabled) {
  console.log('Google sign-in disabled (needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and APP_BASE_URL)');
}

// GET /api/auth/config - lets the sign-in screen know which methods are available (public)
app.get('/api/auth/config', (req, res) => {
  res.json({ google: googleEnabled });
});

// GET /api/auth/google - kick off the OAuth redirect (public)
app.get('/api/auth/google', (req, res) => {
  if (!googleClient) return res.status(503).send('Google sign-in is not configured.');

  // CSRF protection: the state we send to Google must come back unchanged, and we
  // hold our copy in a short-lived HttpOnly cookie rather than server memory.
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: GOOGLE_STATE_TTL_MS,
    path: '/'
  });

  res.redirect(googleClient.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email'],
    state,
    prompt: 'select_account'
  }));
});

// GET /api/auth/google/callback - exchange the code, verify the identity, start a session (public)
app.get('/api/auth/google/callback', async (req, res) => {
  if (!googleClient) return res.status(503).send('Google sign-in is not configured.');
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send('Google sign-in was cancelled.');
    if (!code) return res.status(400).send('Missing authorization code.');

    const expectedState = req.cookies ? req.cookies[GOOGLE_STATE_COOKIE] : null;
    res.clearCookie(GOOGLE_STATE_COOKIE, { path: '/' });
    if (!expectedState || !state || String(state) !== expectedState) {
      return res.status(400).send('Sign-in request expired or could not be verified. Please try again.');
    }

    const { tokens } = await googleClient.getToken(String(code));
    if (!tokens.id_token) return res.status(400).send('Google did not return an identity token.');

    // Verifies signature, issuer and that the token was minted for this client.
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();

    // Only trust an address Google itself has verified, otherwise someone could
    // claim an account belonging to a different person's email.
    if (!payload || !payload.email || payload.email_verified !== true) {
      return res.status(400).send('Your Google account does not have a verified email address.');
    }

    const userId = findOrCreateUserByEmail(String(payload.email).trim().toLowerCase());
    startSession(res, userId);
    res.redirect(appUrl());
  } catch (err) {
    console.error('GET /api/auth/google/callback error:', err.message);
    res.status(500).send('Could not complete Google sign-in.');
  }
});

// Routes under /api that stay reachable without a session. Paths are relative to
// the /api mount point. Contact stays public so someone who can't sign in can
// still reach support.
const PUBLIC_API_PATHS = new Set(['/contact']);

// Session cookie -> req.userId. Everything below this point requires a session.
function authMiddleware(req, res, next) {
  if (PUBLIC_API_PATHS.has(req.path)) return next();

  const rawSessionId = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  if (!rawSessionId) return res.status(401).json({ error: 'Not authenticated' });

  // Look the session up by the hash of the cookie, never the cookie itself.
  const sessionKey = hashToken(rawSessionId);
  const row = db.prepare(`
    SELECT s.user_id, s.expires_at, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sessionKey);

  if (!row) return res.status(401).json({ error: 'Not authenticated' });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionKey);
    return res.status(401).json({ error: 'Session expired' });
  }

  req.userId = row.user_id;
  req.userEmail = row.email;
  next();
}

app.use('/api', authMiddleware);

// --- everything below requires authentication ---

// GET /api/auth/me - who am I (frontend boot gate)
app.get('/api/auth/me', (req, res) => {
  res.json({ id: req.userId, email: req.userEmail });
});

// POST /api/auth/logout - drop the session server-side and clear the cookie
app.post('/api/auth/logout', (req, res) => {
  const rawSessionId = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  if (rawSessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(rawSessionId));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ success: true });
});

// GET /api/transactions - retrieve all transactions
app.get('/api/transactions', (req, res) => {
  try {
    const stmt = db.prepare(
      'SELECT id, ticker, quantity, amount_eur as amount, currency, exchange_rate as exchangeRate, tx_type as type, ts FROM transactions WHERE user_id = ? ORDER BY ts DESC'
    );
    const transactions = stmt.all(req.userId);
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
      req.userId,
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
    if (!checkStmt.get(req.params.id, req.userId)) {
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
      req.userId
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
    const exists = checkStmt.get(req.params.id, req.userId);

    if (!exists) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Delete transaction
    const deleteStmt = db.prepare(
      'DELETE FROM transactions WHERE id = ? AND user_id = ?'
    );
    deleteStmt.run(req.params.id, req.userId);

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

// GET /api/price-history/:ticker - retrieve full daily price history for a ticker
app.get('/api/price-history/:ticker', (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const stmt = db.prepare(`
      SELECT ticker, price_eur as priceEUR, price_usd as priceUSD, price_date as date
      FROM prices
      WHERE ticker = ?
      ORDER BY price_date ASC
    `);
    const history = stmt.all(ticker);
    res.json({ ticker, history });
  } catch (err) {
    console.error('GET /api/price-history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock-splits - retrieve all stock splits
app.get('/api/stock-splits', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT ticker, split_date as date, ratio, description
      FROM stock_splits
      ORDER BY split_date ASC
    `);
    const splits = stmt.all();
    res.json({ splits });
  } catch (err) {
    console.error('GET /api/stock-splits error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate daily snapshot dates from first transaction to today
function generateDailySnapshots(userId) {
  const txStmt = db.prepare(`
    SELECT MIN(ts) as firstTx FROM transactions WHERE user_id = ?
  `);
  const result = txStmt.get(userId);

  if (!result.firstTx) return []; // No transactions

  const startDate = new Date(result.firstTx);
  const endDate = new Date();

  const dates = [];
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}T00:00`);
  }

  return dates;
}

// GET /api/snapshots - compute snapshots from transactions with market value
app.get('/api/snapshots', (req, res) => {
  try {
    // Get all stock splits
    const splitsStmt = db.prepare('SELECT ticker, split_date, ratio FROM stock_splits ORDER BY split_date ASC');
    const splits = splitsStmt.all();
    const splitsByTicker = {};
    splits.forEach(s => {
      if (!splitsByTicker[s.ticker]) splitsByTicker[s.ticker] = [];
      splitsByTicker[s.ticker].push({date: s.split_date, ratio: s.ratio});
    });

    // Get all transactions ordered by date
    const txStmt = db.prepare(`
      SELECT ticker, tx_type, quantity, amount_eur, ts
      FROM transactions
      WHERE user_id = ?
      ORDER BY ts ASC
    `);
    const transactions = txStmt.all(req.userId);

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

    // Get latest prices for market value calculation
    const pricesStmt = db.prepare(`
      SELECT ticker, price_eur, price_date
      FROM prices
      WHERE (ticker, price_date) IN (
        SELECT ticker, MAX(price_date) FROM prices GROUP BY ticker
      )
    `);
    const latestPrices = {};
    pricesStmt.all().forEach(p => {
      latestPrices[p.ticker] = p.price_eur;
    });

    // Helper: apply splits to quantity as of a given date
    function applySplits(ticker, quantity, asOfDate) {
      let qty = quantity;
      const tickerSplits = splitsByTicker[ticker] || [];
      for (const split of tickerSplits) {
        if (asOfDate >= split.date) {
          qty *= split.ratio;
        }
      }
      return qty;
    }

    // Generate daily snapshots from first transaction to today
    const snapshotDates = generateDailySnapshots(req.userId);

    const snapshots = snapshotDates.map(dateStr => {
      const ts = new Date(dateStr).getTime();
      const snapshotDate = dateStr.split('T')[0]; // YYYY-MM-DD

      // Find the most recent transaction at or before this date
      let stateAtDate = {}; // empty if no transactions yet
      for (const snap of transactionSnapshots) {
        if (snap.ts <= ts) {
          stateAtDate = JSON.parse(JSON.stringify(snap.holdings));
        } else {
          break;
        }
      }

      // Get prices as of this snapshot date (or latest available before it)
      // Adjust prices for stock splits: pre-split prices need to be adjusted up
      const pricesOnDate = {};
      Object.keys(latestPrices).forEach(ticker => {
        const priceStmt = db.prepare(`
          SELECT price_eur FROM prices
          WHERE ticker = ? AND price_date <= ?
          ORDER BY price_date DESC
          LIMIT 1
        `);
        const priceRow = priceStmt.get(ticker, snapshotDate);
        let price = priceRow ? priceRow.price_eur : null;

        // Apply split adjustment to prices (multiply pre-split prices by ratio)
        if (price !== null) {
          const tickerSplits = splitsByTicker[ticker] || [];
          for (const split of tickerSplits) {
            if (snapshotDate < split.date) {
              // Price is before this split, multiply by split ratio
              price *= split.ratio;
            }
          }
        }
        pricesOnDate[ticker] = price;
      });

      // Build holdings array with market value, applying stock splits
      let marketValue = 0;
      const holdingsArray = Object.entries(stateAtDate)
        .filter(([_, h]) => h.qty > 0) // Only include positive positions
        .map(([ticker, h]) => {
          const adjustedQty = applySplits(ticker, h.qty, snapshotDate);
          const price = pricesOnDate[ticker];
          const currentValue = price ? adjustedQty * price : adjustedQty * (h.totalAmount / h.qty); // Fallback to cost if no price
          marketValue += currentValue;


          return {
            ticker,
            quantity: adjustedQty,
            amount: h.totalAmount,
            costPerShare: h.qty > 0 ? h.totalAmount / h.qty : 0,
            price: price || (h.totalAmount / h.qty),
            marketValue: currentValue
          };
        });

      return {
        date: new Date(dateStr).toISOString(),
        ts,
        holdings: holdingsArray,
        portfolioTotal: marketValue,
        costBasis: Object.values(stateAtDate).reduce((sum, h) => sum + h.totalAmount, 0)
      };
    });

    res.json({ snapshots });
  } catch (err) {
    console.error('GET /api/snapshots error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/avg-cost - average cost per share for each ticker currently held, with current price & dip vs. that cost
app.get('/api/avg-cost', (req, res) => {
  try {
    const tickerStmt = db.prepare('SELECT DISTINCT ticker FROM transactions WHERE user_id = ? ORDER BY ticker');
    const priceStmt = db.prepare('SELECT price_eur, price_usd FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1');
    const result = tickerStmt.all(req.userId).map(row => {
      const cost = getAvgCostPerShare(row.ticker, req.userId);
      if (!cost) return null;
      const price = priceStmt.get(row.ticker);
      const currentPriceEUR = price ? price.price_eur : null;
      const dipPct = currentPriceEUR !== null ? (currentPriceEUR / cost.avgCostEUR - 1) : null;
      return {
        ticker: row.ticker,
        quantity: cost.quantity,
        avgCostEUR: cost.avgCostEUR,
        currentPriceEUR,
        currentPriceUSD: price ? price.price_usd : null,
        dipPct
      };
    }).filter(Boolean);
    res.json({ tickers: result });
  } catch (err) {
    console.error('GET /api/avg-cost error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Add avg-cost / current-price / dip context to a dip_from_avg_cost alert (mutates and returns it)
function enrichDipAlert(a, userId) {
  if (a.ruleType !== 'dip_from_avg_cost') return a;
  const cost = getAvgCostPerShare(a.ticker, userId);
  if (!cost) return a;
  a.avgCostEUR = cost.avgCostEUR;
  a.triggerPriceEUR = cost.avgCostEUR * (1 - a.threshold / 100);
  const priceRow = db.prepare('SELECT price_eur, price_usd FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1').get(a.ticker);
  if (priceRow) {
    a.currentPriceEUR = priceRow.price_eur;
    a.currentPriceUSD = priceRow.price_usd;
    a.currentDipPct = (priceRow.price_eur / cost.avgCostEUR - 1) * 100;
  }
  return a;
}

// GET /api/alerts - retrieve user's alerts
app.get('/api/alerts', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT id, ticker, rule_type as ruleType, threshold, enabled, last_triggered_at as lastTriggeredAt, created_at as createdAt
      FROM alerts
      WHERE user_id = ?
      ORDER BY created_at DESC
    `);
    const alerts = stmt.all(req.userId).map(a => enrichDipAlert(a, req.userId));
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

    let result;
    try {
      result = insertStmt.run(
        req.userId,
        alert.ticker.toUpperCase(),
        alert.ruleType,
        parseFloat(alert.threshold)
      );
    } catch (e) {
      // Blocked by idx_alert_unique: the identical rule already exists.
      if (String(e.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'You already have that exact alert for this ticker.' });
      }
      throw e;
    }

    const selectStmt = db.prepare(`
      SELECT id, ticker, rule_type as ruleType, threshold, enabled, last_triggered_at as lastTriggeredAt, created_at as createdAt
      FROM alerts WHERE id = ?
    `);
    const newAlert = enrichDipAlert(selectStmt.get(result.lastInsertRowid), req.userId);

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
    if (!checkStmt.get(id, req.userId)) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const updateStmt = db.prepare(`
      UPDATE alerts
      SET enabled = COALESCE(?, enabled),
          threshold = COALESCE(?, threshold)
      WHERE id = ? AND user_id = ?
    `);

    updateStmt.run(enabled !== undefined ? (enabled ? 1 : 0) : null, threshold || null, id, req.userId);

    const selectStmt = db.prepare(`
      SELECT id, ticker, rule_type as ruleType, threshold, enabled, last_triggered_at as lastTriggeredAt, created_at as createdAt
      FROM alerts WHERE id = ?
    `);
    const alert = enrichDipAlert(selectStmt.get(id), req.userId);

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
    if (!checkStmt.get(req.params.id, req.userId)) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const deleteStmt = db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?');
    deleteStmt.run(req.params.id, req.userId);

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/alerts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// POST /api/contact - handle contact form submissions
app.post('/api/contact', async (req, res) => {
  try {
    const { type, name, email, title, message } = req.body;

    // Validate required fields
    if (!type || !name || !email || !title || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`Contact form submission: Type=${type}, Name=${name}, Email=${email}, Title=${title}`);

    const recipient = process.env.ALERT_EMAIL_TO;
    if (authMailer && recipient) {
      try {
        await authMailer.sendMail({
          from: process.env.AUTH_EMAIL_FROM || process.env.ALERT_EMAIL_FROM || 'contact@portfoliotracker.local',
          to: recipient,
          replyTo: email,
          subject: `[Portfolio Tracker] ${type}: ${title}`,
          html: `<p><strong>From:</strong> ${escapeHtml(name)} (${escapeHtml(email)})</p>
                 <p><strong>Type:</strong> ${escapeHtml(type)}</p>
                 <p><strong>Message:</strong></p>
                 <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`
        });
      } catch (err) {
        // Never fail the request just because the email didn't send - the submission is still logged above.
        console.error(`Contact form email failed: ${err.message}`);
      }
    } else {
      console.log(`Message: ${message}`);
    }

    res.json({ success: true, message: "Thanks for reaching out - we'll get back to you soon." });
  } catch (err) {
    console.error('POST /api/contact error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.API_PORT || 3000;
app.listen(PORT, () => {
  console.log(`Portfolio tracker server running on http://localhost:${PORT}`);
  console.log(`Database: ${dbPath}`);
});
