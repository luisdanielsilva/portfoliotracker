# portfolio tracker

Personal stock portfolio tracking app with 74+ historical snapshots, transaction registration, price alerts, and passwordless authentication.

**Live:** https://www.luisdanielsilva.com/portfoliotracker/

## Current Status (Sept 2026)

### ✅ Working Features
- **Frontend:** Single-page app with responsive design, charts (SVG line charts), snapshot timeline
- **Authentication:** Passwordless magic-link login + Google OAuth, session-based
- **Transactions:** Buy/sell registration with automatic snapshot derivation (Node.js backend)
- **Price Alerts:** Multiple rule types (price above/below, % change, dip from avg cost)
- **Portfolio Data:** 74 historical snapshots (Jun 2023 – Aug 2026) + user transactions
- **Database:** SQLite with proper schema, migrations, foreign keys
- **Server:** Express.js on Node.js, rate-limited auth endpoints, CORS-aware

### ⏳ In Progress / Pending
- **Email Delivery:** Not yet configured (blocks magic-link delivery and alert emails)
  - Decision made to use Resend; awaiting setup
- **Price-Fetch Scheduler:** Setup script created, systemd timer ready for deployment
  - Runs daily at 09:00 UTC to fetch prices and evaluate alerts

### 🎯 Architecture

**Single Source of Truth:** `/var/www/portfoliotracker/`
- All code, data, config in one location
- No more separate dev/prod directories
- PM2 manages the server process with auto-restart on code changes

**Tech Stack:**
- Frontend: Vanilla HTML/CSS/JS (no build process)
- Backend: Node.js + Express.js + SQLite
- Deployment: Nginx reverse proxy, systemd for scheduled tasks
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

### 🔧 Configuration

Environment variables in `.env`:
- `DB_PATH` — SQLite database location
- `API_PORT` — Server port (default 3000)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — OAuth config (already set)
- `SMTP_*` — Email config (not yet configured; points to Resend when ready)
- `COOKIE_INSECURE` — For local dev without HTTPS

### 📊 API Endpoints

**Auth (public):**
- `POST /api/auth/request-link` — Request magic login link
- `GET /api/auth/verify?token=...` — Verify and create session
- `GET /api/auth/google/start` — Google OAuth flow
- `GET /api/auth/google/callback` — OAuth callback

**Authenticated:**
- `GET /api/auth/me` — Current user info
- `POST /api/auth/logout` — Destroy session
- `GET /api/transactions` — List user's transactions
- `POST /api/transactions` — Add transaction
- `DELETE /api/transactions/:id` — Remove transaction
- `GET /api/alerts` — List user's price alerts with current prices
- `POST /api/alerts` — Create alert
- `PUT /api/alerts/:id` — Update alert
- `DELETE /api/alerts/:id` — Remove alert

**Public:**
- `POST /api/contact` — Contact form (TODO: email integration)

### 🗓️ Scheduled Tasks

**Price-Fetch (daily at 09:00 UTC):**
- Fetches closing prices from Yahoo Finance
- Stores in SQLite
- Evaluates price alerts
- Sends email alerts (when Resend configured)
- Setup: `sudo /home/deploy/setup-price-fetch.sh`

### 📝 Database Schema

- `users` — Email-based accounts (passwordless)
- `sessions` — Active login sessions with expiration
- `transactions` — Buy/sell events with timestamp and amounts
- `alerts` — Price alert rules per user
- `prices` — Historical daily closing prices (populated by price-fetch)

### 🔐 Security

- Secure HttpOnly cookies for sessions
- CSRF protection on Google OAuth flow
- Rate limiting on auth endpoints (15 requests/15 min per IP)
- Input validation on all endpoints
- Foreign key constraints with cascade deletes
- Session expiration (30 days)

### 📚 History

- **Jun 2023 – Aug 2026:** 74 iPhone screenshots tracking portfolio evolution
- **Sep 2026:** Transaction system + Node.js backend + SQLite migration
- **Sep 2026:** Passwordless auth (magic links + Google OAuth)
- **Sep 2026:** Price alerts system with DCA analysis
- **Sep 2026:** Directory consolidation (dev + prod → single location)
