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
- **Price Alerts:** Multiple rule types (price above/below, % change, dip from avg cost).
  Everything that fires for one person in a run arrives as a **single digest email**, split into
  "dips below your average cost" and "price levels you set". Each rule sends at most once per 24h.
- **Landing page:** Logged-out visitors get a public page explaining the tool (worked DCA example,
  six feature cards, a How-it-works time track, a preview of the alert email) rather than a bare
  login form. It lives inside `#auth-gate` in `index.html` and is replaced by the app on sign-in.
- **Portfolio Data:** 74 historical snapshots (Jun 2023 – Aug 2026) + user transactions
- **Database:** SQLite with proper schema, migrations, foreign keys. **Not tracked in git** — see
  Backups below.
- **Server:** Express.js on Node.js 22, rate-limited auth endpoints, CORS-aware
- **Email Delivery:** Resend SMTP — magic-link login, price alerts, and the contact form all send real email
- **Price-Fetch Scheduler:** systemd timer, runs daily at 09:00 UTC, market-aware (skips weekends,
  and skips US trading hours 13:00–20:00 UTC so it only ever records a settled close)
- **Backups:** `./backup-db.sh` nightly via cron — see Backups below

### ⏳ Open Items / Backlog

**Testing — on hold, and CI-only when resumed:**

There are no automated tests. A suite was planned (see below) and deliberately parked
(2026-09-09). **When it resumes it must run in GitHub Actions CI, not locally** — the user
wants tests that gate code quality in a pipeline, not pre-commit hooks or cron jobs. Do not
propose local-only test running again.

Note this does not prevent a bad edit reaching production: editing a file here *is* deploying,
since pm2 restarts on save and CI only runs after a push. CI is a quality gate on the
repository, not a deployment gate. A real deployment gate would need a staging copy.

The planned coverage, grounded in bugs actually found:
- `areMarketsClosedForFetch()` across all 24h × weekday/weekend — would have caught the bug
  where the scheduled job never ran once
- Currency conversion: native→EUR, a EUR-quoted stock not double-converted, a missing rate
  skipping rather than inventing a value
- Average cost across buys, sells, mixed currencies, and full exit
- Alert semantics: price rules against the native price, dips against the EUR cost basis,
  the 24h throttle
- Migrations on a temp database, run twice to prove idempotency, including that threshold
  restatement preserves meaning

**Blocker still to clear before writing tests:**
- `price-fetch.js` and `check-job-health.js` call their entry point at module scope, so
  `require()`-ing them runs the real job. They need `if (require.main === module)` guards and
  `module.exports`. (`portfolio.js` and `db-migrations.js` are already importable.)

*Cleared 2026-09-09:* `getAvgCostPerShare` was implemented twice with different signatures; it
now lives once in `portfolio.js` and both callers use it.


**The sell side is missing — the tool is currently only half its purpose:**

The stated purpose is twofold: average *in* below your cost, and sell *near the tops*. Everything
built so far serves the first. `dip_from_avg_cost`, the digest's "dips below your average cost"
section, the DCA tab and the landing page headline all point one way. There is no
take-profit rule, no notion of a peak, and no signal that a position is extended.

What it needs, roughly in order:
1. **A `gain_from_avg_cost` rule** — the exact mirror of the dip rule, firing when a holding is
   up X% on what you paid. `price_above` exists and is evaluated, but it takes an absolute price,
   so it does not follow your cost basis the way the dip rule does.
2. **A notion of the top.** "Near the top" needs a high to measure against — 52-week or
   all-time — which requires the price history below.
3. **A trailing signal** ("dropped X% from its recent high"), which is what the removed
   `change_pct` should have been. This is the one that actually protects a gain.
4. **Framing.** The digest has one section for dips; a sell-side section, and language that is
   not exclusively about buying, would follow.

**Price history only goes back to when each ticker was first fetched:**

`price-fetch.js` records one row per ticker per day from the day it starts running. Eight of the
ten current holdings therefore have days of history, not years. Two consequences, both live:

- **Historical snapshots value those holdings at cost.** `/api/snapshots` falls back to cost
  basis when no price exists for a date, so the portfolio-over-time chart is largely accumulated
  cost rather than market value, and per-holding gain and drawdown before September 2026 are not
  real. Only TSLA has genuine history.
- **Peaks are meaningless** for those tickers, which blocks the sell side above.

The fix is a backfill: Yahoo serves daily history via `chart()` — already used for FX in
`recompute-eur.js` — so each held ticker can be filled in from its first purchase date, converted
at the rate for each day (`exchange_rates` now holds those). It is the single change that would
most improve the accuracy of what the app already shows.

**Ops hygiene:**
- No load testing has been done — response times under real concurrent load are unverified

*(Historical euro values were recomputed from real per-date FX on 2026-09-09 — see
Exchange Rates below. No longer an open item.)*

**Open registration:**
- `noindex` keeps the site out of search results, but **signing in is registration** — anyone with
  the URL can create an account. Gate with an invite code or an email allow-list if that ever
  matters.

**Not planned for now:**
- AI-powered transaction import from screenshots/PDFs — a placeholder UI/endpoint was built then
  removed. Explicitly parked (2026-09-09); do not pick it up without asking.

**Settled, recorded so it is not re-litigated:**
- The EUR/USD toggle on the portfolio chart **stays**. Portfolio value defaults to euros; the
  toggle is an explicit user action, not a default display.
- **The site stays out of search results while in development** (2026-09-09). All three public
  pages — `index.html`, `privacy.html`, `terms.html` — carry `noindex, nofollow`. A `robots.txt`
  would not help: it is only honoured at the domain root, which this app does not control, so the
  per-page meta tag is the mechanism. It does not block access, so Google's OAuth review still
  fetches the policy pages fine.
- **Not yet decided:** `noindex` hides the app from search, but anyone with the URL can still
  create an account, since signing in *is* registration. If unwanted visitors ever become a
  concern, gate it with an invite code or an allow-list of emails.


### ✅ After importing real data

The transactions currently in the database are test values. When real data is imported, run:

```bash
node verify-portfolio.js          # read-only cross-check of every derived figure
```

It checks what the app *computes* against what the raw transactions say: a missing price that
would silently drop a holding from the total, a euro value that does not match the recorded FX
rate, splits applied to shares bought after the split, and an average cost implausibly far from
the market price.

This exists because every bug found on 2026-09-09 was caught by noticing a number looked wrong
— a phantom holding worth 81% of the portfolio, splits tripling post-split purchases, average
cost ignoring splits. That is not a repeatable process. Run against a backup from before those
fixes, this tool reports all three unaided.

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

### 💾 Backups

`data.db` is **deliberately untracked**. It holds user emails and raw session cookies, and it
changes on every login and price fetch — a public repo would have leaked working logins, and even
a private one keeps that history forever. Git is therefore not a backup; this is:

```bash
./backup-db.sh              # snapshot, verify, compress, prune
./backup-db.sh --list       # what snapshots exist
./backup-db.sh --restore /home/deploy/backups/portfoliotracker/data.db.YYYYMMDD-HHMMSS.gz
```

- Uses SQLite's **online backup API**, not `cp` — the app writes continuously, and copying the
  file mid-transaction gives a torn snapshot.
- Every snapshot is integrity-checked and row-counted before it counts as a backup.
- Written to `~/backups/portfoliotracker/`, gzipped (~40K each), pruned after `KEEP_DAYS` (30),
  and never pruned down to zero.
- Runs nightly at 03:30 via the `deploy` user's crontab, logging to `logs/backup.log`.
- Restore keeps the database it replaces, at `data.db.replaced-<timestamp>`, and reminds you to
  `pm2 restart portfolio-api` so the app reopens the file.

Override with `DB_PATH`, `BACKUP_DIR` or `KEEP_DAYS` env vars.

**The repository is private.** It must stay that way while any user data is in its history.

### 🔧 Configuration

Environment variables in `.env`:
- `DB_PATH` — SQLite database location
- `API_PORT` — Server port (default 3000)
- `APP_BASE_URL` — canonical public URL (`https://www.singleuseapps.com/portfoliotracker`),
  used to build magic-link URLs and the Google OAuth redirect URI
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — OAuth config (already set). The client lives in a
  Google Cloud project owned by the main account; the consent screen is **published** with only
  the non-sensitive `openid` and `email` scopes, so it needed no Google verification review.
  `singleuseapps.com` must stay in the client's **Authorized domains**, and
  `<APP_BASE_URL>/api/auth/google/callback` in its **Authorized redirect URIs** — an exact string
  match. Changing `APP_BASE_URL` therefore means updating the redirect URI in the console too, or
  sign-in breaks with `redirect_uri_mismatch`.
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` — Resend SMTP config (already set).
  `secure` is derived from the port (`465` → true, else false) — the legacy `SMTP_USE_TLS` var is
  no longer read by the code.
- `AUTH_EMAIL_FROM` / `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` — sender/recipient addresses for
  magic links, alerts, and the contact form
- `COOKIE_INSECURE` — For local dev without HTTPS
- `PRICE_FETCH_REPORT` — set to `false` to stop the per-run status email (default: on)
- `MAX_RUN_AGE_HOURS` — how stale a successful run may get before the watchdog complains
  (default 26)
- `DB_PATH` / `BACKUP_DIR` / `KEEP_DAYS` — also read by `backup-db.sh`

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
- Evaluates price alerts and sends one digest email per user via Resend
- Managed by `portfolio-price-fetch.timer` / `.service` under `/etc/systemd/system/`
- Check it is actually armed: `systemctl list-timers portfolio-price-fetch.timer` — an empty
  listing means no automated fetch at all, which has happened twice
- The market-hours window wraps midnight: safe after the 21:00 UTC close **and** again before the
  13:00 UTC open, when the previous close is final. Testing only `hour < close` made the 09:00 run
  skip every single day, silently.

**Database backup (daily at 03:30 local):** `./backup-db.sh` via the `deploy` user's crontab.

**Job health check (daily at 13:00 local):** `check-job-health.js`, also via crontab — three hours
after the fetch's own slot. See Monitoring below. `crontab -l` shows both.

### 💱 Exchange Rates

The portfolio total is in euros, so every non-euro price must be converted. The daily job fetches
the live rate for each currency actually held — Yahoo quotes FX as tickers, so `EUR<CUR>=X` gives
euros-per-unit and the stored multiplier is its inverse — and writes it to `exchange_rates`
(`from_currency` → `EUR`, one row per day).

- Rates are fetched **after** the quotes, because the set of currencies is only known once the
  quotes are in; a price is never stored using a rate fetched for a different currency.
- If a rate cannot be fetched, the **most recent stored rate** is used rather than a constant from
  months ago. If there is no stored rate and no fallback, the price is skipped rather than
  recording a euro figure that cannot be justified.
- Only USD had a hard-coded fallback (0.92); any other currency with no rate is simply not
  converted.

**History was recomputed on 2026-09-09** (`recompute-eur.js`). Euro values had been produced two
different ways, neither of them real FX:

- the bulk-imported rows used a rate drifting smoothly 0.95 → 0.82 across four years — a linear
  interpolation, close to reality at the ends and materially wrong in the middle (2025-02-03 used
  a rate that understated TSLA by 12.3%);
- rows written by price-fetch before that day used a flat 0.92.

Because `price_native` is stored for every row, the original quoted price was never lost and the
conversion could simply be redone. All 1,208 rows were recomputed at the **rate for their own
date**, and the 1,144 daily rates fetched were written to `exchange_rates` so the numbers can be
audited rather than being an unexplainable one-off adjustment.

Effect: the headline value moved €55,898.98 → €52,234.98 (−6.6%), and derived analytics shifted
with it — max drawdown went −65.5% → −67.3% and its start date moved by a month. Those are
corrections, not market moves.

```bash
node recompute-eur.js --dry-run   # preview, writes nothing
node recompute-eur.js             # apply (take a backup first)
```

Re-running it is safe and idempotent: it recomputes from `price_native` every time, so it does
not compound. It would be the tool to use if a rate source were ever found to be wrong.

### 🔭 Monitoring

Two outages this week were invisible for hours because a job that never ran and a job that ran
and skipped look the same in a log. Both halves below exist because of that, and they are
deliberately independent:

**1. Every run leaves a row.** `job_runs` records `success`, `skipped` or `failed` with a summary.
A run that skips daily is now distinguishable from one that never fires.

**2. Every run emails what it did.** Market check, per-ticker results, alerts evaluated and
triggered, duration — sent to `ALERT_EMAIL_TO`. A crash reports before exiting. Turn it off with
`PRICE_FETCH_REPORT=false` in `.env`; no code change, and the watchdog keeps working regardless.

**3. A watchdog notices silence.** The run email only arrives *when the job runs*, so it cannot
report the failure that matters most. `check-job-health.js` runs separately and looks for the
**absence** of a recent success (`MAX_RUN_AGE_HOURS`, default 26), emailing if stale. It calls out
a run stuck on `skipped` specifically, since that is what the market-hours bug looked like.

```bash
node check-job-health.js --status   # check without emailing
node check-job-health.js            # check, email if stale, exit 1 if unhealthy
```

### 📝 Database Schema

- `users` — Email-based accounts (passwordless)
- `sessions` — Active login sessions with expiration
- `login_tokens` — One-time magic-link tokens (hashed, expire after 15 min)
- `transactions` — Buy/sell events with timestamp and amounts
- `alerts` — Price alert rules per user. A unique index on
  `(user_id, ticker, rule_type, threshold)` stops the same rule being saved twice — it used to be
  possible, and one ticker ended up with three identical rules
- `prices` — Historical daily closing prices (populated by price-fetch)
- `stock_splits` — Known stock splits, applied when computing historical snapshots
- `job_runs` — One row per price-fetch run: `success` / `skipped` / `failed` plus a summary. This
  is what makes "ran and skipped" distinguishable from "never ran"; before it existed, both
  outages looked identical in the logs

### 🔐 Security

- Secure HttpOnly cookies for sessions
- **Session cookies are stored hashed.** `sessions.id` holds the SHA-256 of the cookie, never the
  cookie itself, so reading the database (a backup, a snapshot, a stray copy) yields nothing that
  can be presented to log in
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
- **Sep 2026:** Public landing page replaced the login wall; alert emails became a single digest
- **Sep 2026:** Discovered the scheduled price fetch had never once run — the market-hours check
  rejected its own timer slot. Fixed.
- **Sep 2026:** Repository made **private**, session/login tokens purged from the tracked database,
  and `data.db` untracked in favour of `backup-db.sh`
