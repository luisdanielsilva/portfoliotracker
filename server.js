#!/usr/bin/env node
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const authMail = require('./auth-mail');
const escapeHtml = authMail.escapeHtml;
require('dotenv').config();

const app = express();

// Sits behind nginx: trust its X-Forwarded-* headers so req.protocol reflects
// HTTPS and rate limiting keys off the real client IP rather than the proxy's.
app.set('trust proxy', 1);

// SQLite database connection
/* ---- two databases, joined by an opaque key ----
 *
 * `db` is the financial side and keeps the name it always had, so every query
 * against transactions, alerts and prices is untouched by the split. `identityDb`
 * holds the email addresses and the credentials, and nothing else.
 *
 * What travels between them is `user_key`: a random UUID stored beside the email,
 * used as `user_id` everywhere on the financial side. Deliberately not a hash of
 * the address — addresses are guessable, so a hash of one is not pseudonymous.
 *
 * `req.userId` IS that key. That is what made the split a small change rather
 * than a rewrite: the value became a string, the queries did not move.
 */
const dbPath = process.env.DB_PATH || path.join(__dirname, 'portfolio.db');
const identityPath = process.env.IDENTITY_DB_PATH || path.join(path.dirname(dbPath), 'identity.db');
const db = new Database(dbPath);
const identityDb = new Database(identityPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

/* ---- concurrency ----
 * WAL: a write no longer locks out every reader. Measured on a copy of this
 * database, 2,500 single-row inserts — one backfill — took 6,895ms in the default
 * rollback-journal mode and 114ms in WAL, and in the former case every other
 * request waited behind it.
 *
 * busy_timeout matters the moment more than one process opens this file: without
 * it a writer that finds the database locked fails immediately with SQLITE_BUSY
 * instead of waiting its turn.
 *
 * The nightly backup already uses SQLite's online backup API, which is WAL-aware.
 * backup-db.sh's restore path was not, and was fixed alongside this.
 */
for (const handle of [db, identityDb]) {
  handle.pragma('journal_mode = WAL');
  handle.pragma('busy_timeout = 5000');
  handle.pragma('synchronous = NORMAL');   // safe with WAL; fsync per checkpoint, not per commit
}
identityDb.pragma('foreign_keys = ON');

// Initialize database schema
const schema = require('fs').readFileSync(path.join(__dirname, 'schema.sqlite.sql'), 'utf-8');
db.exec(schema);
identityDb.exec(require('fs').readFileSync(path.join(__dirname, 'schema.identity.sql'), 'utf-8'));

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

/**
 * Nothing ever deleted an expired session or a spent login token, so they accumulated
 * indefinitely. Old credential rows are exactly what had to be purged by hand once
 * already; the fix is for them not to pile up in the first place.
 *
 * Runs at boot and then daily. unref() so it never holds the process open.
 */
function purgeExpiredCredentials() {
  try {
    // Compare as timestamps, not as strings. expires_at is written as an ISO-8601 string
    // with a T and a Z, but SQLite's own datetime() produces "YYYY-MM-DD HH:MM:SS" — and a
    // space sorts before T, so a string comparison reads such a row as long expired and
    // deletes a session that is perfectly valid. julianday() parses both.
    const sessions = identityDb.prepare(
      "DELETE FROM sessions WHERE julianday(expires_at) < julianday('now')"
    ).run().changes;
    // A used token is spent; an expired one can never be used. Keep neither.
    const tokens = identityDb.prepare(
      "DELETE FROM login_tokens WHERE used_at IS NOT NULL OR julianday(expires_at) < julianday('now')"
    ).run().changes;
    if (sessions || tokens) {
      console.log(`Purged ${sessions} expired session(s) and ${tokens} spent login token(s)`);
    }
  } catch (err) {
    console.error('Credential purge failed:', err.message);
  }
}
purgeExpiredCredentials();
setInterval(purgeExpiredCredentials, 24 * 60 * 60 * 1000).unref();

// Prices carry the currency the market quotes them in; see db-migrations.js.
const { recentHigh } = require('./db-migrations');
require('./db-migrations').ensurePriceCurrencyColumns(db);
require('./db-migrations').ensureAlertCurrency(db);
require('./db-migrations').ensureGainRuleType(db);
require('./db-migrations').ensureDropFromHighRuleType(db);
require('./db-migrations').ensureAlgorithmAlertSettings(db);
require('./db-migrations').ensureAlertEventLog(db);
require('./db-migrations').ensureWatchlist(db);
require('./db-migrations').ensureDataVersion(db);

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

// Average cost per share (EUR) — shared with the price-fetch job so the figure the
// app shows and the figure dip alerts fire on cannot drift apart. See portfolio.js.
const { getAvgCostPerShare: avgCostFor } = require('./portfolio');
const algorithm = require('./algorithm');
function getAvgCostPerShare(ticker, userId) {
  return avgCostFor(db, userId, ticker);
}

// What a Dip or Target rule measures from — cost basis for a holding, recorded
// reference price for a watched stock. Holdings always win. See reference-price.js.
const { referenceFor, watchedTickers } = require('./reference-price');
const { lastHeldAvgCost } = require('./portfolio');

// A crash in one request must not take the process down with it. Under Node 22 an
// unhandled rejection is fatal by default; pm2 would restart, but that is a
// request-triggered restart and the reason never reached a log.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', (reason && reason.stack) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.stack || err);
});

app.disable('x-powered-by');

// script-src is 'self' with no 'unsafe-inline': the application moved out of index.html
// into app.js precisely so this could be true. With an inline script the browser cannot
// tell the one you wrote from one an attacker injected, so the policy had to permit both
// and bought nothing against XSS. Now an injected <script> or on* attribute does not run.
//
// style-src still allows inline styles — the pages carry 39 KB of them, and an injected
// stylesheet is a far smaller problem than injected code.
const CSP = [
  "default-src 'self'",
  // The donate widget is served from singleuseapps.com and mounts Stripe's
  // embedded checkout, which loads js.stripe.com and renders inside its own
  // iframe. Named hosts only — no wildcards, and 'unsafe-inline' stays out.
  "script-src 'self' https://www.singleuseapps.com https://singleuseapps.com https://js.stripe.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "frame-src https://js.stripe.com",
  "connect-src 'self' https://www.singleuseapps.com https://singleuseapps.com https://api.stripe.com",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  next();
});

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' })); // for the magic-link confirm form
app.use(cookieParser());
// SECURITY: only these four files are public.
//
// This was `express.static(__dirname)`, which served the entire application
// directory. data.db, every data.db.backup-* beside it, .git/ and all of the
// source were downloadable over HTTPS — including the backup taken *before*
// session cookies were hashed and purged, which was enough to take over an
// account. An allowlist, rather than a filter, so a new file dropped in this
// directory is private until someone deliberately publishes it.
const PUBLIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/privacy.html': 'privacy.html',
  '/terms.html': 'terms.html',
  '/contact.js': 'contact.js',
  '/app.js': 'app.js'
};
app.get(Object.keys(PUBLIC_FILES), (req, res) => {
  res.sendFile(path.join(__dirname, PUBLIC_FILES[req.path]));
});

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
  identityDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
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
  const existing = identityDb.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return existing.id;
  // The key is minted here and never derived from anything about the person.
  return identityDb.prepare('INSERT INTO users (user_key, email) VALUES (?, ?)')
    .run(crypto.randomUUID(), email).lastInsertRowid;
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

function mailFrom() {
  return process.env.AUTH_EMAIL_FROM || process.env.ALERT_EMAIL_FROM || 'login@portfoliotracker.local';
}

// The body of this lives in auth-mail.js, where a test can call it with a mailer that
// records instead of sending. Never let a broken mailer swallow the only way in: the
// link goes to the log instead, which is where the account owner can still reach it.
async function sendMagicLink(email, link) {
  return authMail.sendMagicLink({
    db, mailer: authMailer, from: mailFrom(), email, link,
    onUnsent: reason => {
      console.error(`Magic-link email to ${email} not sent: ${reason}`);
      logMagicLink(email, link, reason);
    },
    log: msg => console.log(msg)
  });
}

// Rate limiters for the link-request endpoint (per the plan's security section)
const requestLinkIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "If that's a valid email, a login link is on its way." }
});


/* ---- computed-view cache ----
 *
 * /api/snapshots rebuilt a user's entire history on every request — 463KB and
 * ~48ms of blocking work, repeated for a page that had not changed. /api/algorithm
 * re-scored a full price series per request, and that scoring is *identical for
 * every user*: only the position gate at the end differs.
 *
 * Both are now keyed by a database-wide version counter, so a cached entry is
 * used only while nothing has been written. That also makes the cache correct
 * with more than one process: neither has to be told about the other's writes,
 * because the key itself changes underneath both of them.
 */
function dataVersion() {
  const row = db.prepare('SELECT version FROM data_version WHERE id = 1').get();
  return row ? row.version : 0;
}
function bumpDataVersion() {
  db.prepare('UPDATE data_version SET version = version + 1 WHERE id = 1').run();
}

/** A Map with a ceiling, evicting what was used longest ago. */
class BoundedCache {
  constructor(max) { this.max = max; this.map = new Map(); this.hits = 0; this.misses = 0; }
  get(key) {
    if (!this.map.has(key)) { this.misses++; return undefined; }
    const v = this.map.get(key);
    this.map.delete(key); this.map.set(key, v);   // move to newest
    this.hits++;
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}
const snapshotCache = new BoundedCache(40);   // one JSON string per user per version
const scoreCache = new BoundedCache(60);      // one scored series per ticker per version

/* ---- rate limits on the authenticated API ----
 *
 * Measured before writing these. better-sqlite3 is synchronous and Node is one
 * thread, so an expensive endpoint does not merely slow down its own caller — it
 * blocks every other request behind it. Twenty concurrent /api/snapshots took
 * 966ms and made an unrelated trivial request 19x slower, from 51ms to 950ms.
 * One account can make the site unresponsive for everyone, and signing in is
 * currently all it takes to get an account.
 *
 * The numbers are set well above anything the app itself does — loading every tab
 * and clicking through all ten holdings costs a small fraction of these — so a
 * real user will never meet them.
 */
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down and try again shortly.' }
});

/** The two that do real work per call: ~48ms and ~23ms of blocking CPU each. */
const heavyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests for this view. Try again in a few minutes.' }
});

/**
 * Backfill is the one endpoint that reaches outside and writes unbounded rows.
 * Each call fetches up to ten years from Yahoo for an arbitrary symbol and writes
 * every bar into the shared prices table. Abused, it does two kinds of damage
 * this app cannot absorb: it can get the server's IP throttled by Yahoo, which
 * breaks the daily fetch everything else depends on, and it lets one account
 * grow the database with tickers nobody holds.
 */
const backfillLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many backfill requests. Try again in an hour.' }
});

/* ---- request validation ----
   The client checks these too, but the client is not where validation happens: a
   transaction posted straight at the API used to be stored whatever it said. One
   already is — 1,984 shares at an amount that rounds to €0.00 — and verify-portfolio.js
   has been flagging it ever since. */
const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
const TX_TYPES = new Set(['buy', 'sell']);
const RULE_TYPES = new Set(['price_above', 'price_below', 'dip_from_avg_cost',
                            'gain_from_avg_cost', 'drop_from_high']);
const MIN_TX_TS = Date.UTC(1990, 0, 1);

/**
 * How many distinct tickers one account may track.
 *
 * Every ticker anybody holds costs a price fetch every weekday, for ever, from a
 * source that is free and unofficial. That cost is carried by the server, not by
 * the account that added it, so without a ceiling a single user can commit the
 * whole system to a few hundred daily requests. Fifty is far above any real
 * portfolio and far below anything that would hurt.
 *
 * It applies only to *new* tickers: selling out of something and buying back in
 * must always work, and so must correcting the history of a position already
 * held.
 */
const MAX_TICKERS_PER_USER = 50;

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function positive(v, max) {
  const n = num(v);
  return n !== null && n > 0 && n <= max ? n : null;
}
function str(v, max) {
  return typeof v === 'string' && v.trim().length && v.trim().length <= max ? v.trim() : null;
}

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages from this address. Try again in an hour.' }
});

const emailAttempts = new Map(); // email -> [timestamps]
// Bounded: without this, a bot posting random addresses grows the map until the
// process runs out of memory. Entries older than the window are dead weight anyway.
function pruneEmailAttempts(now) {
  const windowStart = now - 60 * 60 * 1000;
  for (const [email, hits] of emailAttempts) {
    const live = hits.filter(t => t > windowStart);
    if (live.length) emailAttempts.set(email, live); else emailAttempts.delete(email);
  }
}
function emailRateLimited(email) {
  const now = Date.now();
  if (emailAttempts.size > 500) pruneEmailAttempts(now);
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
    identityDb.prepare('INSERT INTO login_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
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

    const row = identityDb.prepare(`
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

    const row = identityDb.prepare(`
      SELECT id, user_id, expires_at, used_at FROM login_tokens WHERE token_hash = ?
    `).get(hashToken(rawToken));

    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).send('This login link is invalid or has expired. Please request a new one.');
    }

    identityDb.prepare('UPDATE login_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);

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
  const row = identityDb.prepare(`
    SELECT s.user_id, s.expires_at, u.email, u.last_seen_at, u.user_key
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sessionKey);

  if (!row) return res.status(401).json({ error: 'Not authenticated' });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    identityDb.prepare('DELETE FROM sessions WHERE id = ?').run(sessionKey);
    return res.status(401).json({ error: 'Session expired' });
  }

  // The opaque key, not the identity row id — everything downstream is financial
  // and must never be able to name anybody.
  req.userId = row.user_key;
  req.userEmail = row.email;

  // Stamp the day, not the moment: one write per account per day rather than one
  // per request. This is what will later answer "is anybody actually waiting for
  // this ticker's price?", and it deliberately does not touch the cache version —
  // being here changes nothing about what the computed views should say.
  const today = new Date().toISOString().slice(0, 10);
  if (!row.last_seen_at || String(row.last_seen_at).slice(0, 10) !== today) {
    try {
      identityDb.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), row.user_id);
    } catch (err) {
      console.error('last_seen_at update failed:', err.message);   // never block a request for this
    }
  }

  next();
}

app.use('/api', apiLimiter);
app.use('/api', authMiddleware);

// Any successful write can change a computed view. Bumping centrally means a new
// write endpoint cannot forget to do it — the failure mode of per-endpoint
// invalidation is silently serving stale data, which is worse than recomputing.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try { bumpDataVersion(); } catch (err) { console.error('Cache version bump failed:', err.message); }
    }
  });
  next();
});

// --- everything below requires authentication ---

// GET /api/auth/me - who am I (frontend boot gate)
app.get('/api/auth/me', (req, res) => {
  res.json({ id: req.userId, email: req.userEmail });
});

// POST /api/auth/logout - drop the session server-side and clear the cookie
app.post('/api/auth/logout', (req, res) => {
  const rawSessionId = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  if (rawSessionId) identityDb.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(rawSessionId));
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
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/transactions - create new transaction
app.post('/api/transactions', (req, res) => {
  try {
    const tx = req.body || {};

    const ticker = String(tx.ticker || '').toUpperCase().trim();
    const quantity = positive(tx.quantity, 1e9);
    const amountEUR = positive(tx.amountEUR != null ? tx.amountEUR : tx.amount, 1e12);
    const txType = String(tx.type || 'buy');
    const currency = String(tx.currency || 'EUR').toUpperCase();
    const rate = positive(tx.exchangeRate != null ? tx.exchangeRate : 1, 1e6);
    const ts = num(tx.ts);

    if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: 'Ticker must be 1-12 characters: letters, digits, dot or dash.' });
    if (quantity === null) return res.status(400).json({ error: 'Quantity must be a positive number.' });
    if (amountEUR === null) return res.status(400).json({ error: 'Amount must be a positive number.' });
    if (!TX_TYPES.has(txType)) return res.status(400).json({ error: "Type must be 'buy' or 'sell'." });
    if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'Currency must be a three-letter code.' });
    if (rate === null) return res.status(400).json({ error: 'Exchange rate must be a positive number.' });
    // A date far in the past or the future is a typo, not a trade — and it stretches
    // every chart to fit it. Two days of slack covers time zones and the form's 12:00.
    if (ts === null || ts < MIN_TX_TS || ts > Date.now() + 2 * 864e5) {
      return res.status(400).json({ error: 'Date must be between 1990 and tomorrow.' });
    }

    const known = db.prepare(
      'SELECT COUNT(*) AS n FROM (SELECT DISTINCT ticker FROM transactions WHERE user_id = ?)'
    ).get(req.userId).n;
    const isNewTicker = !db.prepare(
      'SELECT 1 FROM transactions WHERE user_id = ? AND ticker = ? LIMIT 1'
    ).get(req.userId, ticker);
    if (isNewTicker && known >= MAX_TICKERS_PER_USER) {
      return res.status(409).json({
        error: `You are tracking ${MAX_TICKERS_PER_USER} tickers, which is the limit. `
          + 'Get in touch through the Support link if you need more — it is a limit on server cost, not a rule.'
      });
    }

    const insertStmt = db.prepare(
      `INSERT INTO transactions
       (user_id, ticker, quantity, amount_eur, currency, exchange_rate, tx_type, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // Asked either side of the insert, because "did this close the position" is
    // a question about the change, not about the state. A sell that takes a
    // holding to zero is the only transaction that can make it true.
    const heldBefore = getAvgCostPerShare(ticker, req.userId);
    const result = insertStmt.run(req.userId, ticker, quantity, amountEUR, currency, rate, txType, ts);
    const heldAfter = getAvgCostPerShare(ticker, req.userId);

    // Fetch the inserted transaction
    const selectStmt = db.prepare(
      'SELECT id, ticker, quantity, amount_eur as amount, currency, exchange_rate as exchangeRate, tx_type as type, ts FROM transactions WHERE id = ?'
    );
    const transaction = selectStmt.get(result.lastInsertRowid);

    /* A position that has just been closed can keep being followed.
     *
     * Until now this was where a ticker quietly left the app: the daily job
     * stops fetching it the next morning and its alerts, if any, become
     * unfirable without saying so. Offering the watchlist here is what closes
     * that — but it is only ever an offer, so this reports the opportunity and
     * writes nothing. The client accepts by calling POST /api/watchlist with
     * `carry: true`, which recomputes the figure rather than trusting this one.
     */
    let closedPosition = null;
    if (heldBefore && !heldAfter) {
      const carried = lastHeldAvgCost(db, req.userId, ticker);
      const alreadyWatching = db.prepare(
        'SELECT 1 FROM watchlist WHERE user_id = ? AND ticker = ?'
      ).get(req.userId, ticker);
      if (carried && !alreadyWatching) {
        closedPosition = { ticker, avgCostEur: parseFloat(carried.avgCostEUR.toFixed(4)) };
      }
    }

    res.json({ success: true, transaction, closedPosition });
  } catch (err) {
    console.error('POST /api/transactions error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});


// GET /api/prices - retrieve latest prices for all tickers
app.get('/api/prices', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT ticker, price_eur as priceEUR, price_usd as priceUSD,
             price_native as priceNative, currency, price_date as date, source, updated_at as updatedAt
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
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/price-history/:ticker - retrieve full daily price history for a ticker
// POST /api/backfill { ticker, years } — pull daily history for a ticker.
//
// A ticker only starts accumulating prices the day it is first fetched, so a newly
// added holding has no past. Without one, snapshots before today fall back to cost
// basis and there is no high to measure "near the top" against. This lets the app
// fill that in at the moment a ticker is added, with the depth the user chooses.
app.post('/api/backfill', backfillLimiter, async (req, res) => {
  try {
    const ticker = String(req.body.ticker || '').toUpperCase().trim();
    const years = Math.min(Math.max(parseFloat(req.body.years) || 2, 0.25), 10);
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });
    // This one asked Yahoo about whatever string it was handed. Every other
    // endpoint that takes a ticker checks it; this one did not.
    if (!TICKER_RE.test(ticker)) {
      return res.status(400).json({ error: 'Ticker must be 1-12 characters: letters, digits, dot or dash.' });
    }

    const YahooFinance = require('yahoo-finance2').default;
    const { backfillTicker } = require('./backfill-history');
    const result = await backfillTicker(db, new YahooFinance(), ticker, years);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('POST /api/backfill error:', err.message);
    res.status(502).json({ error: 'Could not load price history for that ticker. It may not exist, or the price source may be unavailable.' });
  }
});

// GET /api/price-history?tickers=A,B,C&days=180 — compact series for several tickers
// at once. The alert list draws a sparkline per rule; fetching each ticker separately
// would mean a round trip per row for data that is a few hundred numbers in total.
app.get('/api/price-history', (req, res) => {
  try {
    const tickers = String(req.query.tickers || '')
      .split(',').map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 40);
    if (!tickers.length) return res.json({ series: {} });

    const days = Math.min(parseInt(req.query.days, 10) || 180, 3650);
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

    const stmt = db.prepare(`
      SELECT price_date AS d, price_eur AS eur, price_native AS native, currency
      FROM prices WHERE ticker = ? AND price_date >= ? ORDER BY price_date ASC
    `);
    const series = {};
    for (const ticker of tickers) series[ticker] = stmt.all(ticker, from);
    res.json({ series, from, days });
  } catch (err) {
    console.error('GET /api/price-history error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/price-history/:ticker', (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const stmt = db.prepare(`
      SELECT ticker, price_eur as priceEUR, price_usd as priceUSD,
             price_native as priceNative, currency, price_date as date
      FROM prices
      WHERE ticker = ?
      ORDER BY price_date ASC
    `);
    const history = stmt.all(ticker);
    res.json({ ticker, history });
  } catch (err) {
    console.error('GET /api/price-history error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Generate daily snapshot dates from first transaction to today
function generateDailySnapshots(userId) {
  const txStmt = db.prepare(`
    SELECT MIN(ts) as firstTx, MAX(ts) as lastTx FROM transactions WHERE user_id = ?
  `);
  const result = txStmt.get(userId);

  if (!result.firstTx) return []; // No transactions

  // Each point is anchored at local midnight, and the last one is *now*.
  //
  // The walk used to start at the first transaction's own clock time, so every point
  // carried that hour and the series ended there: a transaction registered at noon
  // today fell past the end of a series whose last point was stamped 00:15, and did
  // not appear on the chart until the following day. Anchoring at midnight and
  // finishing at the current moment means anything registered a minute ago is on it.
  //
  // The end is the later of now and the newest transaction: the registration form
  // defaults to 12:00, so a purchase entered at nine in the morning is stamped hours
  // ahead of the clock and would otherwise sit past the end of its own series.
  const stamp = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date(Math.max(Date.now(), result.lastTx || 0));
  const d = new Date(result.firstTx);
  d.setHours(0, 0, 0, 0);

  const dates = [];
  while (d <= now) {
    dates.push(`${stamp(d)}T00:00`);
    d.setDate(d.getDate() + 1);
  }
  if (dates.length) {
    dates[dates.length - 1] =
      `${stamp(now)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  return dates;
}

// GET /api/snapshots - compute snapshots from transactions with market value
app.get('/api/snapshots', heavyLimiter, (req, res) => {
  try {
    // Nothing below this line changes until something is written, so the finished
    // JSON is reusable as-is — which skips the rebuild *and* the serialisation.
    const cacheKey = `${req.userId}:${dataVersion()}`;
    const cached = snapshotCache.get(cacheKey);
    if (cached) return res.type('application/json').send(cached);
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

    // A split multiplies only the shares held when it happened. Shares bought
    // afterwards are already quoted in post-split terms. So each transaction is
    // converted here into "current share units" — its quantity times every split
    // that came after it — and the running total is then expressed in whatever
    // date's terms a snapshot needs. Multiplying the accumulated total instead
    // tripled purchases made years after the split.
    function toCurrentUnits(ticker, quantity, txDate) {
      let qty = quantity;
      for (const split of (splitsByTicker[ticker] || [])) {
        if (split.date > txDate) qty *= split.ratio;
      }
      return qty;
    }

    transactions.forEach(tx => {
      const {ticker, tx_type, quantity, amount_eur, ts} = tx;

      if (!holdings[ticker]) {
        holdings[ticker] = {qty: 0, totalAmount: 0};
      }

      const txDate = new Date(ts).toISOString().slice(0, 10);
      const qtyInCurrentUnits = toCurrentUnits(ticker, quantity, txDate);

      if (tx_type === 'buy') {
        holdings[ticker].qty += qtyInCurrentUnits;
        holdings[ticker].totalAmount += amount_eur;
      } else if (tx_type === 'sell') {
        holdings[ticker].qty -= qtyInCurrentUnits;
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

    // Holdings are accumulated in current share units (see toCurrentUnits). A
    // snapshot dated before a split has to be shown in the share terms of its own
    // day, so undo any split that had not happened yet by then — otherwise a 2022
    // snapshot would be drawn using 2026 share counts.
    function applySplits(ticker, qtyInCurrentUnits, asOfDate) {
      let qty = qtyInCurrentUnits;
      for (const split of (splitsByTicker[ticker] || [])) {
        if (split.date > asOfDate) qty /= split.ratio;
      }
      return qty;
    }

    /* Every price, once.
     *
     * This used to call db.prepare() inside two nested loops — once per snapshot date per
     * ticker — which on this database was 8,274 statement compilations for a single
     * request, and one more every day as the series grew. The whole prices table is a few
     * thousand rows; reading it once and walking it costs less than preparing one
     * statement. Same answer, and the endpoint stops getting slower with age.
     */
    const seriesByTicker = {};
    for (const row of db.prepare(
      'SELECT ticker, price_date, price_eur FROM prices ORDER BY ticker ASC, price_date ASC'
    ).all()) {
      (seriesByTicker[row.ticker] || (seriesByTicker[row.ticker] = [])).push(row);
    }
    // Snapshot dates ascend, so each ticker's cursor only ever moves forward.
    const cursor = {};
    function priceAsOf(ticker, date) {
      const series = seriesByTicker[ticker];
      if (!series) return null;
      let i = cursor[ticker] || 0;
      while (i + 1 < series.length && series[i + 1].price_date <= date) i++;
      cursor[ticker] = i;
      // the cursor may still sit before the first row that exists on or after `date`
      return series[i].price_date <= date ? series[i].price_eur : null;
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
        let price = priceAsOf(ticker, snapshotDate);

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

    const body = JSON.stringify({ snapshots });
    snapshotCache.set(cacheKey, body);
    res.type('application/json').send(body);
  } catch (err) {
    console.error('GET /api/snapshots error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/avg-cost - average cost per share for each ticker currently held, with current price & dip vs. that cost
app.get('/api/avg-cost', (req, res) => {
  try {
    const tickerStmt = db.prepare('SELECT DISTINCT ticker FROM transactions WHERE user_id = ? ORDER BY ticker');
    const priceStmt = db.prepare('SELECT price_eur, price_usd, price_native, currency FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1');
    const result = tickerStmt.all(req.userId).map(row => {
      const cost = getAvgCostPerShare(row.ticker, req.userId);
      if (!cost) return null;
      const price = priceStmt.get(row.ticker);
      const currentPriceEUR = price ? price.price_eur : null;
      const dipPct = currentPriceEUR !== null ? (currentPriceEUR / cost.avgCostEUR - 1) : null;
      // the trailing form needs a peak to measure against, and an empty one is the
      // signal to tell the user to backfill rather than to show a broken preview
      const high = recentHigh(db, row.ticker);
      return {
        ticker: row.ticker,
        recentHigh: high ? high.peak : null,
        recentHighEUR: high ? high.peakEur : null,
        recentHighDate: high ? high.peakDate : null,
        quantity: cost.quantity,
        avgCostEUR: cost.avgCostEUR,
        currentPriceEUR,
        currentPriceUSD: price ? price.price_usd : null,
        currentPriceNative: price ? price.price_native : null,
        currency: price ? price.currency : null,
        dipPct
      };
    }).filter(Boolean);
    res.json({ tickers: result });
  } catch (err) {
    console.error('GET /api/avg-cost error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Attach the context an alert needs to be understood without doing arithmetic:
// where the price is now, and for a dip rule what it is measured against.
//
// The current price used to be attached only to dip rules, so a price-level alert
// arrived with nothing to compare its threshold to — the list could show what it
// fires at but not how far away that was, which is the one thing worth knowing.
function enrichAlert(a, userId) {
  const priceRow = db.prepare(
    'SELECT price_eur, price_usd, price_native, currency FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1'
  ).get(a.ticker);
  if (priceRow) {
    a.currentPriceEUR = priceRow.price_eur;
    a.currentPriceUSD = priceRow.price_usd;
    a.currentPriceNative = priceRow.price_native;
    a.marketCurrency = priceRow.currency;
  }

  // A trailing rule measures against the recent high, not the cost basis.
  if (a.ruleType === 'drop_from_high') {
    const high = recentHigh(db, a.ticker);
    if (high) {
      a.recentHigh = high.peak;
      a.recentHighEUR = high.peakEur;
      a.triggerPriceEUR = high.peakEur * (1 - a.threshold / 100);
      a.triggerPriceNative = high.peak * (1 - a.threshold / 100);
      if (priceRow) a.offHighPct = (priceRow.price_native / high.peak - 1) * 100;
    }
    return a;
  }

  const costBased = a.ruleType === 'dip_from_avg_cost' || a.ruleType === 'gain_from_avg_cost';
  if (!costBased) return a;

  /* Both cost-based rules measure against a reference — a dip fires below it, a
   * gain above it. It must be resolved the same way the daily job resolves it,
   * through referenceFor(), or the list and the job disagree about the same
   * alert. They did: this read the cost basis directly, so a Dip on a watched
   * stock showed "fires at —" in the list while price-fetch.js was perfectly
   * capable of firing it. Two readers of one number is how this codebase has
   * gone wrong before; see the note at the top of portfolio.js.
   */
  const ref = referenceFor(db, userId, a.ticker);
  if (!ref) return a;
  a.avgCostEUR = ref.eur;
  a.referenceBasis = ref.basis;   // 'avg_cost' | 'spotted' | 'typed' | 'carried'
  a.triggerPriceEUR = a.ruleType === 'gain_from_avg_cost'
    ? ref.eur * (1 + a.threshold / 100)
    : ref.eur * (1 - a.threshold / 100);
  if (priceRow) a.currentDipPct = (priceRow.price_eur / ref.eur - 1) * 100;
  return a;
}

/**
 * GET /api/algorithm?ticker=XYZ&period=2y — the position-timing signal.
 *
 * Ranks each day's close against the stock's own trailing 6M/1Y/2Y history and
 * returns both signal lanes for every displayable day, plus the runs, the tile
 * counts and today's position-gated recommendation. See algorithm.js for the
 * rules and README for where the implementation departs from the spec.
 */
app.get('/api/algorithm', heavyLimiter, (req, res) => {
  try {
    const ticker = String(req.query.ticker || '').toUpperCase();
    if (!TICKER_RE.test(ticker)) return res.status(400).json({ error: 'Invalid ticker' });

    // Only what the user actually holds: this tool is about timing a position,
    // and without one there is nothing to gate the signal against.
    const owns = db.prepare('SELECT 1 FROM transactions WHERE user_id = ? AND ticker = ? LIMIT 1').get(req.userId, ticker);
    if (!owns) return res.status(404).json({ error: 'No transactions for that ticker' });

    const rows = db.prepare(
      'SELECT price_date AS date, price_native AS close, price_eur AS closeEur, currency FROM prices WHERE ticker = ? AND price_native IS NOT NULL ORDER BY price_date ASC'
    ).all(ticker);
    if (rows.length < 30) return res.status(409).json({ error: 'Not enough price history', days: rows.length });

    // The scoring depends only on the price series, so it is the same answer for
    // every user who asks about this ticker. Only the position gate below is
    // personal, and that is arithmetic on two numbers.
    const scoreKey = `${ticker}:${dataVersion()}`;
    let scored = scoreCache.get(scoreKey);
    if (!scored) {
      scored = algorithm.scoreSeries(rows);
      scoreCache.set(scoreKey, scored);
    }

    // A day is displayable only once every window behind it is fully populated —
    // a 2-year rank off eight months of data is a different statistic wearing the
    // same name. The spec's answer is to pull more history, which backfill-history.js
    // did; this is the guard that proves it worked.
    const usable = scored.filter(d => d.complete);
    if (!usable.length) {
      return res.status(409).json({
        error: 'Not enough history for a full 2-year window',
        have: rows.length, firstDate: rows[0].date
      });
    }

    const PERIODS = { '1y': 365, '2y': 730, '3y': 1095, 'max': null };
    const periodKey = Object.prototype.hasOwnProperty.call(PERIODS, req.query.period) ? req.query.period : '2y';
    const windowDays = PERIODS[periodKey];
    const lastTime = Date.parse(usable[usable.length - 1].date);
    const days = windowDays === null ? usable
      : usable.filter(d => Date.parse(d.date) > lastTime - windowDays * 864e5);

    const cost = getAvgCostPerShare(ticker, req.userId);
    const latest = rows[rows.length - 1];
    const position = cost ? {
      shares: cost.quantity,
      avgCost: cost.avgCostEUR,
      // The gate compares like with like: cost basis is in euros because euros
      // are what left the account, so the price it is measured against is too.
      price: latest.closeEur,
      currency: 'EUR'
    } : null;

    const today = scored[scored.length - 1];
    const gate = algorithm.applyPositionGate(today, position);

    // Two kinds of event, drawn on one timeline under the chart.
    //
    // An email is about this holding. A settings change is not — the two timings
    // are per account and apply to everything at once — but it belongs on every
    // stock's timeline precisely because it changed the rules this stock was being
    // judged by. The label says which is which so the distinction is never guessed.
    const from = days.length ? days[0].date : '1970-01-01';
    const events = [];

    for (const row of db.prepare(
      `SELECT fired_at, signal_date, delivery,
              json_extract(detail, '$.tier') AS tier,
              json_extract(detail, '$.confidence') AS confidence,
              direction
       FROM alert_events
       WHERE user_id = ? AND ticker = ? AND source = 'algo' AND date(fired_at) >= ?
       ORDER BY fired_at ASC`
    ).all(req.userId, ticker, from)) {
      // The timeline says what the reader was actually told. An alert the mailer
      // refused is still worth a mark — it explains a gap in the emails without
      // claiming one arrived.
      const arrived = row.delivery !== 'not_sent' && row.delivery !== 'failed';
      events.push({
        date: String(row.fired_at).slice(0, 10),
        type: 'email',
        scope: 'ticker',
        sent: arrived,
        label: arrived ? 'Email sent' : 'Alert raised, email not sent',
        detail: `${ticker} read ${row.tier === 'VeryStrong' ? 'very strong' : String(row.tier || '').toLowerCase()} `
          + `${String(row.direction).toLowerCase()} at ${Math.round(row.confidence)}% — signal dated ${row.signal_date}`
      });
    }

    const FIELD_WORDS = {
      holdDays: 'days it must hold',
      cooldownDays: 'quiet period (days)',
      enabled: 'algorithm alerts'
    };
    for (const row of db.prepare(
      `SELECT changed_at, field, old_value, new_value FROM algo_settings_log
       WHERE user_id = ? AND date(changed_at) >= ? ORDER BY changed_at ASC`
    ).all(req.userId, from)) {
      const asWords = v => (row.field === 'enabled' ? (v ? 'on' : 'off') : String(v));
      events.push({
        date: String(row.changed_at).slice(0, 10),
        type: 'setting',
        scope: 'account',
        label: 'Setting changed',
        detail: `${FIELD_WORDS[row.field] || row.field}: `
          + `${row.old_value === null ? 'unset' : asWords(row.old_value)} → ${asWords(row.new_value)}`
      });
    }
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const count = (lane, dir) => days.filter(d => d[lane].direction === dir).length;
    const buyEarlyDays = days.filter(d => d.early.direction === 'Buy');

    res.json({
      ticker,
      currency: latest.currency || 'USD',
      asOf: latest.date,
      currentPrice: latest.close,
      currentPriceEur: latest.closeEur,
      period: periodKey,
      position,
      gate,
      today: {
        date: today.date,
        regimes: today.regimes,
        percentiles: today.percentiles,
        early: today.early,
        confirmed: today.confirmed
      },
      stats: {
        sellDays: count('early', 'Sell'),
        buyDaysEarly: buyEarlyDays.length,
        buyDaysAlsoConfirmed: buyEarlyDays.filter(d => d.confirmed.direction === 'Buy').length,
        noSignalDays: days.filter(d => d.early.direction === 'None' && d.confirmed.direction === 'None').length,
        mixedDays: count('early', 'Mixed'),
        totalDays: days.length
      },
      events,
      runs: {
        sell: algorithm.findRuns(days, 'confirmed', 'Sell'),
        buyEarly: algorithm.findRuns(days, 'early', 'Buy'),
        buyConfirmed: algorithm.findRuns(days, 'confirmed', 'Buy')
      },
      meta: {
        windows: algorithm.WINDOWS,
        cutoffs: { strongHigh: algorithm.STRONG_HIGH, high: algorithm.HIGH, low: algorithm.LOW, strongLow: algorithm.STRONG_LOW },
        gates: algorithm.DEFAULT_GATES,
        agreement: algorithm.agreementRules(algorithm.WINDOWS.length),
        historyFrom: rows[0].date,
        displayableFrom: usable[0].date
      },
      days: days.map(d => ({
        date: d.date,
        close: Math.round(d.close * 100) / 100,
        pr: { '6M': Math.round(d.percentiles['6M'] * 10) / 10, '1Y': Math.round(d.percentiles['1Y'] * 10) / 10, '2Y': Math.round(d.percentiles['2Y'] * 10) / 10 },
        rg: d.regimes,
        e: { d: d.early.direction, t: d.early.tier, c: Math.round(d.early.confidencePct) },
        f: { d: d.confirmed.direction, t: d.confirmed.tier, c: Math.round(d.confirmed.confidencePct) }
      }))
    });
  } catch (error) {
    console.error('Error computing algorithm signal:', error);
    res.status(500).json({ error: 'Failed to compute signal' });
  }
});

/**
 * The Algorithm tab's two timings.
 *
 * Only these two are the user's. What fires the alert — a very strong buy, and
 * nothing else — is fixed, because it is a claim about the signal rather than a
 * preference. These are about how often they want to hear from it.
 */
const ALGO_HOLD_MIN = 1, ALGO_HOLD_MAX = 15;
const ALGO_COOLDOWN_MIN = 7, ALGO_COOLDOWN_MAX = 365;

app.get('/api/algorithm/settings', (req, res) => {
  try {
    const row = db.prepare(
      'SELECT algo_alerts_enabled AS enabled, algo_hold_days AS holdDays, algo_cooldown_days AS cooldownDays FROM user_settings WHERE user_id = ?'
    ).get(req.userId) || { enabled: 1, holdDays: 3, cooldownDays: 60 };
    res.json({
      enabled: !!row.enabled,
      holdDays: row.holdDays,
      cooldownDays: row.cooldownDays,
      limits: { holdMin: ALGO_HOLD_MIN, holdMax: ALGO_HOLD_MAX, cooldownMin: ALGO_COOLDOWN_MIN, cooldownMax: ALGO_COOLDOWN_MAX }
    });
  } catch (error) {
    console.error('Error reading algorithm settings:', error);
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

app.put('/api/algorithm/settings', (req, res) => {
  try {
    const { holdDays, cooldownDays, enabled } = req.body || {};
    const hold = Number(holdDays), cool = Number(cooldownDays);
    if (!Number.isInteger(hold) || hold < ALGO_HOLD_MIN || hold > ALGO_HOLD_MAX) {
      return res.status(400).json({ error: `holdDays must be a whole number between ${ALGO_HOLD_MIN} and ${ALGO_HOLD_MAX}` });
    }
    if (!Number.isInteger(cool) || cool < ALGO_COOLDOWN_MIN || cool > ALGO_COOLDOWN_MAX) {
      return res.status(400).json({ error: `cooldownDays must be a whole number between ${ALGO_COOLDOWN_MIN} and ${ALGO_COOLDOWN_MAX}` });
    }
    const before = db.prepare(
      'SELECT algo_hold_days AS holdDays, algo_cooldown_days AS cooldownDays, algo_alerts_enabled AS enabled FROM user_settings WHERE user_id = ?'
    ).get(req.userId) || {};
    const wantEnabled = enabled === false ? 0 : 1;

    // Only real changes are logged. A click that re-selects what was already
    // chosen is not an event, and a timeline full of those is a timeline nobody
    // reads.
    const logChange = db.prepare(
      'INSERT INTO algo_settings_log (user_id, field, old_value, new_value) VALUES (?,?,?,?)'
    );
    const apply = db.transaction(() => {
      db.prepare(`INSERT INTO user_settings (user_id, algo_hold_days, algo_cooldown_days, algo_alerts_enabled)
                  VALUES (?,?,?,?)
                  ON CONFLICT(user_id) DO UPDATE SET
                    algo_hold_days = excluded.algo_hold_days,
                    algo_cooldown_days = excluded.algo_cooldown_days,
                    algo_alerts_enabled = excluded.algo_alerts_enabled`)
        .run(req.userId, hold, cool, wantEnabled);
      if (before.holdDays !== hold) logChange.run(req.userId, 'holdDays', before.holdDays ?? null, hold);
      if (before.cooldownDays !== cool) logChange.run(req.userId, 'cooldownDays', before.cooldownDays ?? null, cool);
      if (before.enabled !== wantEnabled) logChange.run(req.userId, 'enabled', before.enabled ?? null, wantEnabled);
    });
    apply();

    res.json({ success: true, holdDays: hold, cooldownDays: cool, enabled: enabled !== false });
  } catch (error) {
    console.error('Error saving algorithm settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// GET /api/alerts - retrieve user's alerts
app.get('/api/alerts', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT id, ticker, rule_type as ruleType, threshold, currency, enabled,
             last_triggered_at as lastTriggeredAt, created_at as createdAt
      FROM alerts
      WHERE user_id = ?
      ORDER BY created_at DESC
    `);
    const alerts = stmt.all(req.userId).map(a => enrichAlert(a, req.userId));
    res.json({ alerts });
  } catch (err) {
    console.error('GET /api/alerts error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/alerts - create new alert
app.post('/api/alerts', (req, res) => {
  try {
    const alert = req.body || {};

    if (!alert.ticker || !alert.ruleType || alert.threshold === undefined) {
      return res.status(400).json({ error: 'Missing required fields: ticker, ruleType, threshold' });
    }
    // Without this the CHECK constraint rejects a bad rule type as a 500, and a
    // percentage rule would happily accept 5000% or a negative.
    if (!RULE_TYPES.has(alert.ruleType)) {
      return res.status(400).json({ error: 'Unknown rule type.' });
    }
    if (!TICKER_RE.test(String(alert.ticker).toUpperCase().trim())) {
      return res.status(400).json({ error: 'Ticker must be 1-12 characters: letters, digits, dot or dash.' });
    }
    const pct = alert.ruleType !== 'price_above' && alert.ruleType !== 'price_below';
    const threshold = positive(alert.threshold, pct ? 1000 : 1e9);
    if (threshold === null || (pct && alert.ruleType !== 'gain_from_avg_cost' && threshold >= 100)) {
      return res.status(400).json({
        error: pct ? 'Percentage must be above 0 (and below 100 for a dip or trailing rule).'
                   : 'Price must be a positive number.'
      });
    }

    /* The rule has to have something to fire on.
     *
     * This endpoint never checked that the ticker meant anything to this user —
     * only the UI's dropdown did, by being filled from holdings. An alert on
     * anything else was accepted, stored, listed as enabled, and could never
     * fire, because the daily job only fetches prices for tickers somebody holds
     * or watches. Nothing said so. Refusing here is what closes that.
     */
    const upper = String(alert.ticker).toUpperCase().trim();
    const isHeld = !!getAvgCostPerShare(upper, req.userId);
    const isWatched = watchedTickers(db, req.userId).includes(upper);
    if (!isHeld && !isWatched) {
      return res.status(400).json({
        error: `You do not hold ${upper} and are not watching it. Add it to your watchlist first, and the alert will have a price to work from.`
      });
    }

    // Dip and Target measure against a number. A watched stock with no reference
    // price recorded has none, and a rule that can never evaluate is the same
    // silent failure in a smaller box.
    const costBased = alert.ruleType === 'dip_from_avg_cost' || alert.ruleType === 'gain_from_avg_cost';
    if (costBased && !referenceFor(db, req.userId, upper)) {
      return res.status(400).json({
        error: `${upper} has no reference price to measure from. Set one on your watchlist, or use a price level or trailing rule instead.`
      });
    }

    const insertStmt = db.prepare(`
      INSERT INTO alerts (user_id, ticker, rule_type, threshold, currency, enabled)
      VALUES (?, ?, ?, ?, ?, 1)
    `);

    // A price threshold is in the currency its market quotes, so it reads the same
    // way as the price on screen. Percentage rules carry no currency — a dip is
    // measured against the euro cost basis.
    const ticker = alert.ticker.toUpperCase();
    const isPriceRule = alert.ruleType === 'price_above' || alert.ruleType === 'price_below';
    let currency = null;
    if (isPriceRule) {
      const p = db.prepare('SELECT currency FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1').get(ticker);
      currency = (p && p.currency) || 'USD';
    }

    let result;
    try {
      result = insertStmt.run(
        req.userId,
        ticker,
        alert.ruleType,
        threshold,
        currency
      );
    } catch (e) {
      // Blocked by idx_alert_unique: the identical rule already exists.
      if (String(e.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'You already have that exact alert for this ticker.' });
      }
      throw e;
    }

    const selectStmt = db.prepare(`
      SELECT id, ticker, rule_type as ruleType, threshold, currency, enabled,
             last_triggered_at as lastTriggeredAt, created_at as createdAt
      FROM alerts WHERE id = ?
    `);
    const newAlert = enrichAlert(selectStmt.get(result.lastInsertRowid), req.userId);

    res.json({ success: true, alert: newAlert });
  } catch (err) {
    console.error('POST /api/alerts error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
      SELECT id, ticker, rule_type as ruleType, threshold, currency, enabled,
             last_triggered_at as lastTriggeredAt, created_at as createdAt
      FROM alerts WHERE id = ?
    `);
    const alert = enrichAlert(selectStmt.get(id), req.userId);

    res.json({ success: true, alert });
  } catch (err) {
    console.error('PUT /api/alerts error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* ---- watchlist: stocks followed without being owned ----
 *
 * A watched stock is a candidate to buy, or a position somebody has left and
 * still wants to hear about. It gets the same four alert rules a holding gets;
 * the only thing it lacks is a cost basis, so it carries a reference price for
 * Dip and Target to measure from. See reference-price.js.
 */

// GET /api/watchlist — the list, with the latest price and where it sits
// relative to the reference. `dropPct` is positive when the price is below the
// reference, which is the direction the Dip rule cares about.
app.get('/api/watchlist', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT w.ticker, w.reference_price_eur AS referenceEur,
             w.reference_price_native AS referenceNative, w.currency,
             w.reference_source AS referenceSource, w.note, w.added_at AS addedAt,
             (SELECT COUNT(*) FROM alerts a
               WHERE a.user_id = w.user_id AND a.ticker = w.ticker AND a.enabled = 1) AS alertCount
      FROM watchlist w WHERE w.user_id = ? ORDER BY w.ticker
    `).all(req.userId);

    const latest = db.prepare(
      'SELECT price_eur AS eur, price_native AS native, currency, price_date AS date '
      + 'FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1'
    );
    /* How much history each one actually has.
     *
     * A watchlist can hold a stock that listed last quarter, which holdings
     * never could — every ticker used to arrive on a transaction for something
     * the user had owned for a while. recentHigh() takes the maximum over
     * whatever rows fall inside its 365-day window and says nothing when that is
     * only sixty of them, so a Trailing rule on a young listing measures off a
     * three-month high while calling itself "off 52w high". Reporting the depth
     * is what lets the list say so instead.
     */
    const span = db.prepare(
      'SELECT MIN(price_date) AS first, MAX(price_date) AS last FROM prices WHERE ticker = ?'
    );
    const { WATCH_HISTORY_DAYS } = require('./db-migrations');
    for (const r of rows) {
      const p = latest.get(r.ticker);
      r.price = p || null;
      r.dropPct = (p && r.referenceEur)
        ? ((r.referenceEur - p.eur) / r.referenceEur) * 100
        : null;

      const s = span.get(r.ticker);
      r.historyFrom = s && s.first ? s.first : null;
      r.historyDays = (s && s.first && s.last)
        ? Math.round((Date.parse(s.last) - Date.parse(s.first)) / 864e5)
        : 0;
      r.historyShort = r.historyDays < WATCH_HISTORY_DAYS;
    }
    res.json({ watchlist: rows });
  } catch (err) {
    console.error('GET /api/watchlist error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/watchlist { ticker, referencePrice?, note? }
//
// The backfill is not an optimisation here, it is the validation. Every ticker
// this app has ever seen arrived on a transaction somebody actually made, so a
// typo corrected itself. A watchlist accepts whatever is typed, and TICKER_RE
// only says "1-12 characters" — 'GOOG' for 'GOOGL' passes it happily. Asking
// Yahoo for the history is what proves the symbol is real, and it is the same
// call that stops the Trailing rule being silently dead for its first year.
app.post('/api/watchlist', backfillLimiter, async (req, res) => {
  try {
    const ticker = String((req.body || {}).ticker || '').toUpperCase().trim();
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });
    if (!TICKER_RE.test(ticker)) {
      return res.status(400).json({ error: 'Ticker must be 1-12 characters: letters, digits, dot or dash.' });
    }

    const existing = db.prepare('SELECT ticker FROM watchlist WHERE user_id = ? AND ticker = ?')
      .get(req.userId, ticker);
    if (existing) return res.status(409).json({ error: 'You are already watching that stock.' });

    /* Backfill only when the history is actually short of what the rules need.
     *
     * The span that matters is the chart's: WATCH_HISTORY_DAYS, two years,
     * because that is the longest period its buttons offer. Measuring against
     * the trailing rule's 365 instead left a stock with 400 days looking deep
     * enough to skip, after which the 2Y button drew a short line in silence.
     * If prices already reach back that far — which they do for anything held
     * for a while — asking Yahoo again buys nothing and costs a request.
     */
    const { WATCH_HISTORY_DAYS } = require('./db-migrations');
    const oldest = db.prepare('SELECT MIN(price_date) AS d FROM prices WHERE ticker = ?').get(ticker);
    const needBy = new Date(Date.now() - WATCH_HISTORY_DAYS * 864e5).toISOString().slice(0, 10);
    const historyIsDeepEnough = !!(oldest && oldest.d && oldest.d <= needBy);

    let filled = { added: 0, from: oldest && oldest.d };
    if (!historyIsDeepEnough) {
      const YahooFinance = require('yahoo-finance2').default;
      const { backfillTicker } = require('./backfill-history');
      filled = await backfillTicker(db, new YahooFinance(), ticker, WATCH_HISTORY_DAYS / 365);

      /* Two different failures both arrive as `added: 0`, and telling somebody
       * their ticker does not exist when it does is worse than either.
       *
       * `note: 'no data returned'` is the real "no such symbol" — Yahoo sent no
       * bars at all. But backfillTicker also skips every bar it cannot convert
       * to euros, so a currency with no exchange_rates rows yet writes nothing
       * for a stock that exists perfectly well. That case is about this app's
       * own data, not about what was typed, and it must say so.
       */
      if (filled.note === 'no data returned') {
        return res.status(404).json({
          error: `No price history found for ${ticker}. Check the symbol — Yahoo uses suffixes like .AS or .DE for non-US listings.`
        });
      }
      if (!filled.added && filled.skipped) {
        return res.status(503).json({
          error: `${ticker} quotes in ${filled.currency}, and there is no exchange rate on file to convert that to euros yet. `
            + 'It should work after the next daily price run.'
        });
      }
      if (!filled.added) {
        return res.status(404).json({
          error: `No usable price history found for ${ticker}.`
        });
      }
    }

    const latest = db.prepare(
      'SELECT price_eur AS eur, price_native AS native, currency FROM prices '
      + 'WHERE ticker = ? ORDER BY price_date DESC LIMIT 1'
    ).get(ticker);

    // A typed price is in the market's own currency, the same as a Price level
    // rule, so it reads like the number on screen rather than a converted one.
    const typed = req.body.referencePrice !== undefined && req.body.referencePrice !== null
      && req.body.referencePrice !== ''
      ? positive(req.body.referencePrice, 1e9)
      : null;
    if (req.body.referencePrice !== undefined && req.body.referencePrice !== null
        && req.body.referencePrice !== '' && typed === null) {
      return res.status(400).json({ error: 'Reference price must be a positive number.' });
    }

    const rate = (latest && latest.eur && latest.native) ? latest.eur / latest.native : 1;

    /* `carry: true` — a position that has just been closed keeps following the
     * stock, and what it cost while it was held becomes the reference. Computed
     * here from the transaction history rather than taken from the request: the
     * browser knowing the number is not the same as the browser being allowed to
     * choose it, and this is the figure a dip alert will fire on.
     */
    let source = typed !== null ? 'typed' : 'spotted';
    let referenceEur = typed !== null ? parseFloat((typed * rate).toFixed(4))
                                      : (latest ? latest.eur : null);
    let referenceNative = typed !== null ? typed : (latest ? latest.native : null);

    if (req.body.carry === true && typed === null) {
      const carried = lastHeldAvgCost(db, req.userId, ticker);
      if (!carried) {
        return res.status(400).json({
          error: `${ticker} has no closed position to carry a cost from.`
        });
      }
      source = 'carried';
      referenceEur = parseFloat(carried.avgCostEUR.toFixed(4));
      // Cost basis is euros by definition — euros are what left the account —
      // so there is no native figure to record alongside it. See portfolio.js.
      referenceNative = null;
    }

    db.prepare(`
      INSERT INTO watchlist
        (user_id, ticker, reference_price_eur, reference_price_native, currency, reference_source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.userId, ticker, referenceEur, referenceNative,
           (latest && latest.currency) || filled.currency || 'USD',
           source, str(req.body.note, 200) || null);

    bumpDataVersion();
    res.json({ success: true, ticker, referenceEur, referenceNative, referenceSource: source,
               history: { added: filled.added, from: filled.from,
                          alreadyDeepEnough: historyIsDeepEnough } });
  } catch (err) {
    console.error('POST /api/watchlist error:', err.message);
    res.status(502).json({ error: 'Could not load price history for that ticker. It may not exist, or the price source may be unavailable.' });
  }
});

// PATCH /api/watchlist/:ticker { referencePrice?, note? }
app.patch('/api/watchlist/:ticker', (req, res) => {
  try {
    const ticker = String(req.params.ticker || '').toUpperCase().trim();
    const row = db.prepare('SELECT * FROM watchlist WHERE user_id = ? AND ticker = ?')
      .get(req.userId, ticker);
    if (!row) return res.status(404).json({ error: 'Not on your watchlist.' });

    let referenceEur = row.reference_price_eur;
    let referenceNative = row.reference_price_native;
    let source = row.reference_source;
    if (req.body.referencePrice !== undefined) {
      const typed = positive(req.body.referencePrice, 1e9);
      if (typed === null) return res.status(400).json({ error: 'Reference price must be a positive number.' });
      const latest = db.prepare(
        'SELECT price_eur AS eur, price_native AS native FROM prices WHERE ticker = ? ORDER BY price_date DESC LIMIT 1'
      ).get(ticker);
      const rate = (latest && latest.eur && latest.native) ? latest.eur / latest.native : 1;
      referenceNative = typed;
      referenceEur = parseFloat((typed * rate).toFixed(4));
      source = 'typed';
    }

    db.prepare(`
      UPDATE watchlist SET reference_price_eur = ?, reference_price_native = ?,
                           reference_source = ?, note = COALESCE(?, note)
      WHERE user_id = ? AND ticker = ?
    `).run(referenceEur, referenceNative, source,
           req.body.note !== undefined ? str(req.body.note, 200) : null,
           req.userId, ticker);

    bumpDataVersion();
    res.json({ success: true, ticker, referenceEur, referenceNative, referenceSource: source });
  } catch (err) {
    console.error('PATCH /api/watchlist error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/watchlist/:ticker
//
// Alerts on the stock are deleted with it. Leaving them would recreate exactly
// the silent failure this feature was built to close: a rule with nothing left
// to measure against and no price arriving, sitting in the list looking armed.
// The count goes back in the response so the UI can say what it took with it.
app.delete('/api/watchlist/:ticker', (req, res) => {
  try {
    const ticker = String(req.params.ticker || '').toUpperCase().trim();
    const row = db.prepare('SELECT ticker FROM watchlist WHERE user_id = ? AND ticker = ?')
      .get(req.userId, ticker);
    if (!row) return res.status(404).json({ error: 'Not on your watchlist.' });

    const held = getAvgCostPerShare(ticker, req.userId);
    let removedAlerts = 0;
    if (!held) {
      removedAlerts = db.prepare('DELETE FROM alerts WHERE user_id = ? AND ticker = ?')
        .run(req.userId, ticker).changes;
    }
    db.prepare('DELETE FROM watchlist WHERE user_id = ? AND ticker = ?').run(req.userId, ticker);

    bumpDataVersion();
    res.json({ success: true, ticker, removedAlerts });
  } catch (err) {
    console.error('DELETE /api/watchlist error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/contact - handle contact form submissions
// Public and unauthenticated, so it is the one endpoint a stranger can use to make the
// server send mail. Five an hour per address, and every field capped — an uncapped
// message field is an open relay for a multi-megabyte email.
app.post('/api/contact', contactLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const type = ['support', 'feature'].includes(body.type) ? body.type : null;
    const name = str(body.name, 120);
    const email = str(body.email, 200);
    const title = str(body.title, 200);
    const message = str(body.message, 5000);

    if (!type || !name || !email || !title || !message) {
      return res.status(400).json({ error: 'Every field is needed, and each has a length limit.' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'That does not look like an email address.' });
    }

    console.log(`Contact form submission: Type=${type}, Name=${name}, Email=${email}, Title=${title}`);

    // Someone writing in from the website. Goes to the address the site publishes,
    // which is deliberately not the inbox the job reports land in.
    const recipient = process.env.CONTACT_EMAIL_TO || process.env.ALERT_EMAIL_TO;
    if (!authMailer || !recipient) {
      console.error('Contact form: no mailer or CONTACT_EMAIL_TO configured — message not delivered');
      console.log(`Undelivered message: ${message}`);
      return res.status(503).json({ error: 'Messages are not being delivered right now.' });
    }

    try {
      await authMail.sendContact({
        db, mailer: authMailer, log: msg => console.log(msg),
        from: process.env.AUTH_EMAIL_FROM || process.env.ALERT_EMAIL_FROM || 'contact@portfoliotracker.local',
        to: recipient, replyTo: email, type, title, name, email, message
      });
    } catch (err) {
      // This used to be swallowed and answered with success, on the reasoning that the
      // submission was "still logged". A line in a log nobody reads is not delivery: the
      // sender was thanked for a message that never arrived. It has already happened —
      // an address our own validation accepts can still be refused by the mail provider,
      // and then the only person who knows is the one who cannot see the log.
      console.error(`Contact form email failed (${email}): ${err.message}`);
      console.log(`Undelivered message: ${message}`);
      return res.status(502).json({ error: 'That message could not be delivered. Please email us directly.' });
    }

    res.json({ success: true, message: "Thanks for reaching out - we'll get back to you soon." });
  } catch (err) {
    console.error('POST /api/contact error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

const PORT = process.env.API_PORT || 3000;
app.listen(PORT, () => {
  console.log(`Portfolio tracker server running on http://localhost:${PORT}`);
  console.log(`Portfolio database: ${dbPath}`);
  console.log(`Identity database:  ${identityPath}`);
});
