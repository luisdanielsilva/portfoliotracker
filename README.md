# portfolio tracker

Personal stock portfolio tracking app with 74+ historical snapshots, transaction registration, price alerts, and passwordless authentication.

**Live:** https://www.singleuseapps.com/portfoliotracker/

## Current Status (Sept 2026)

### ✅ Working Features
- **Frontend:** Single-page app with responsive design, charts (SVG line charts), snapshot timeline
- **Authentication:** Passwordless magic-link login + Google OAuth, session-based
  - Magic-link verify is a two-step GET (confirm page) → POST (consume) flow, so corporate mail
    gateways that auto-fetch links to scan them (e.g. Microsoft Safe Links) can't burn the
    one-time token before the user clicks it
- **Transactions:** Buy/sell registration with automatic snapshot derivation (Node.js backend)
- **Price Alerts:** Multiple rule types (price above/below, % change, dip from avg cost)
- **Portfolio Data:** 74 historical snapshots (Jun 2023 – Aug 2026) + user transactions
- **Database:** SQLite with proper schema, migrations, foreign keys
- **Server:** Express.js on Node.js 22, rate-limited auth endpoints, CORS-aware
- **Email Delivery:** Resend SMTP — magic-link login, price alerts, and the contact form all send real email
- **Price-Fetch Scheduler:** systemd timer, runs daily at 09:00 UTC, market-aware (skips weekends,
  waits for US market close before fetching)

### ⏳ In Progress / Pending
- **Ops hygiene:** no load testing, no `DEPLOYMENT.md` runbook, no automated `backup-db.sh`
  (DB backups before risky changes are still manual — copy `data.db` by hand first)
- **Backlog (deferred, not started):** AI-powered transaction import from screenshots/PDFs;
  switching git remote auth from an embedded token to `gh` CLI auth

### 🎯 Architecture

**Single Source of Truth:** `/var/www/portfoliotracker/`
- All code, data, config in one location
- No more separate dev/prod directories
- PM2 manages the server process with auto-restart on code changes

**Tech Stack:**
- Frontend: Vanilla HTML/CSS/JS (no build process)
- Backend: Node.js 22 + Express.js + SQLite (`better-sqlite3` — a native module; rebuild it with
  `npm rebuild better-sqlite3` after any Node version change)
- Deployment: Nginx reverse proxy on `singleuseapps.com`, systemd for scheduled tasks
- Process Management: PM2 with watch mode

### 👨‍💻 Development

**Edit directly in production directory:**
```bash
# Connect to dev session (runs on Hetzner, accessed via Tailscale)
dev              # attach tmux session "dev"
dev bash         # shell access to same session
dev status       # check if running
dev stop         # kill it
```

Server auto-restarts when you edit `server.js`, `schema.sqlite.sql`, or `.env` (hot-reload).

**Manual server start:**
```bash
cd /var/www/portfoliotracker
npm install      # if needed
node server.js   # port 3000
```

### 📦 Deployment

No `deploy.sh` needed — development happens directly in the live directory.

**To deploy to production:**
```bash
# From within /var/www/portfoliotracker
git push         # pushes to remote
pm2 restart portfolio-api   # if needed
```

**Note on systemd units:** the price-fetch timer/service files live under
`/etc/systemd/system/` and are *not* part of this git repo. If the project directory ever moves
again, remember to update `WorkingDirectory`, `DB_PATH`, and `ExecStart` in
`portfolio-price-fetch.service` too — this was missed during the Sept 7 consolidation and caused
a silent ~14h outage of price fetching until caught on Sept 9.

### 🔧 Configuration

Environment variables in `.env`:
- `DB_PATH` — SQLite database location
- `API_PORT` — Server port (default 3000)
- `APP_BASE_URL` — canonical public URL (`https://www.singleuseapps.com/portfoliotracker`),
  used to build magic-link URLs and the Google OAuth redirect URI
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — OAuth config (already set)
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` — Resend SMTP config (already set).
  `secure` is derived from the port (`465` → true, else false) — the legacy `SMTP_USE_TLS` var is
  no longer read by the code.
- `AUTH_EMAIL_FROM` / `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` — sender/recipient addresses for
  magic links, alerts, and the contact form
- `COOKIE_INSECURE` — For local dev without HTTPS

### 📊 API Endpoints

**Auth (public):**
- `POST /api/auth/request-link` — Request magic login link
- `GET /api/auth/verify?token=...` — Renders a confirm page (does not consume the token)
- `POST /api/auth/verify` — Consumes the token and starts a session
- `GET /api/auth/google/start` — Google OAuth flow
- `GET /api/auth/google/callback` — OAuth callback

**Authenticated:**
- `GET /api/auth/me` — Current user info
- `POST /api/auth/logout` — Destroy session
- `GET /api/transactions` — List user's transactions
- `POST /api/transactions` — Add transaction
- `PUT /api/transactions/:id` — Update transaction
- `DELETE /api/transactions/:id` — Remove transaction
- `GET /api/snapshots` — Computed portfolio value over time (transactions + splits + latest prices)
- `GET /api/prices` — Latest known price per ticker
- `GET /api/price-history/:ticker` — Historical prices for one ticker
- `GET /api/stock-splits` — Known stock splits
- `GET /api/avg-cost` — Average cost basis per ticker
- `GET /api/alerts` — List user's price alerts with current prices
- `POST /api/alerts` — Create alert
- `PUT /api/alerts/:id` — Update alert
- `DELETE /api/alerts/:id` — Remove alert

**Public:**
- `POST /api/contact` — Contact form; emails `ALERT_EMAIL_TO` with the submitter set as reply-to

### 🗓️ Scheduled Tasks

**Price-Fetch (daily at 09:00 UTC):**
- Fetches closing prices from Yahoo Finance
- Stores in SQLite
- Evaluates price alerts
- Sends email alerts via Resend
- Managed by `portfolio-price-fetch.timer` / `.service` under `/etc/systemd/system/`
  (check status: `systemctl status portfolio-price-fetch.timer`)

### 📝 Database Schema

- `users` — Email-based accounts (passwordless)
- `sessions` — Active login sessions with expiration
- `login_tokens` — One-time magic-link tokens (hashed, expire after 15 min)
- `transactions` — Buy/sell events with timestamp and amounts
- `alerts` — Price alert rules per user
- `prices` — Historical daily closing prices (populated by price-fetch)
- `stock_splits` — Known stock splits, applied when computing historical snapshots

### 🔐 Security

- Secure HttpOnly cookies for sessions
- CSRF protection on Google OAuth flow
- Rate limiting on auth endpoints (15 requests/15 min per IP)
- Magic-link tokens are single-use and only consumed on an explicit POST (not a passive GET),
  so mail security scanners can't burn them before the user clicks
- Input validation on all endpoints
- Foreign key constraints with cascade deletes
- Session expiration (30 days)

### 📚 History

- **Jun 2023 – Aug 2026:** 74 iPhone screenshots tracking portfolio evolution
- **Sep 2026:** Transaction system + Node.js backend + SQLite migration
- **Sep 2026:** Passwordless auth (magic links + Google OAuth)
- **Sep 2026:** Price alerts system with DCA analysis
- **Sep 2026:** Directory consolidation (dev + prod → single location: `/var/www/portfoliotracker`)
- **Sep 2026:** Resend SMTP email delivery (magic links, alerts, contact form) fully working
- **Sep 2026:** Node.js upgraded 18 → 22; price-fetch systemd path outage fixed
- **Sep 2026:** Magic-link verify split into GET (confirm) + POST (consume) to survive
  corporate mail link-scanning
