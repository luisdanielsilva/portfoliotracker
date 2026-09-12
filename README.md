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
- **DCA tab:** analyses any holding against its own trailing average and Bollinger bands.
  The selector lists what you hold, taken from `/api/avg-cost`. It used to be driven by the
  chart's universe, whose keys are the short names this app started with (`asml`, `vw`, `spy`)
  rather than Yahoo symbols — so the two European listings, whose symbols carry an exchange
  suffix, asked for price history that does not exist under that name and were silently
  dropped. Use `tickerLabel()` for anything user-facing: it falls back through `BKEY` and
  `TICKER_NAMES` so `ASML.AS` reads as "ASML Holding".
- **Price Alerts:** Four rule types, covering both sides of the plan:
  - `dip_from_avg_cost` — down X% on **your** average cost (buy signal)
  - `gain_from_avg_cost` — up X% on your average cost (take-profit; follows your cost basis as
    you keep buying, which an absolute price level does not)
  - `drop_from_high` — down X% from the ticker's own **high of the past year** (trailing; the one
    rule that still says something once a holding has run well past what you paid)
  - `price_above` / `price_below` — an absolute level, in the currency that market quotes
  
  Everything that fires for one person in a run arrives as a **single digest email**, split into
  "dips below your average cost", "up on what you paid", "down from their recent high" and
  "price levels you set". Each rule sends at most once per 24h. The alert list shows, per rule,
  what it fires at, where the price is now, the remaining headroom, and a **sparkline** drawing
  six months of price against the trigger level and its reference (your average cost, or the
  52-week high) — so the gap the rule is watching is visible rather than arithmetic.
- **Alert map:** a full-size chart above the alert list, one holding at a time: its price
  history, your average cost, and every rule on it as its own line, coloured to match the tags
  in the list (dip green, target orange, trailing red, price level blue). Markers show the day
  each rule *crossed* into firing over the chosen period (3M / 6M / 1Y / 2Y / All), and hovering
  gives the price plus every rule's distance on that date. Two things it deliberately does not
  pretend: it applies today's levels to past prices (your average cost has moved, this does not
  model that), and a level too far from the current price is left off the chart rather than
  flattening it — the row below still gives the level and the distance. A trailing rule's line
  moves, because it recomputes its own 365-day high at each date; triggering is always tested in
  the rule's own currency even though the drawing is in the market's.
- **Contact / Feature Request:** one widget, `contact.js`, loaded by `index.html`,
  `privacy.html` and `terms.html`. It injects its own styles, markup and behaviour, styled
  from the CSS variables all three pages already define, and posts to `api/contact`
  (relative, so it resolves under `/portfoliotracker/` from any of them). Any element with
  `data-contact-open` becomes a trigger; a page with none gets a button before its footer.
  Fields match the form on dupsweep.com: Type (Support / Feature Request), Name, E-mail,
  Title, Description. The app page previously had its own copy of all of this, with a
  browser `alert()` for feedback, and the two policy pages had none.
- **Landing page:** Logged-out visitors get a public page explaining the tool (two worked examples
  — one buying the dip, one selling near the top — six feature cards, a How-it-works time track,
  and a preview of the alert email) rather than a bare login form. It lives inside `#auth-gate` in
  `index.html` and is replaced by the app on sign-in. **Its mock of the alert email is a hand-built
  copy of `renderAlertDigest()`** — change one and check the other, or the page starts advertising
  an email nobody receives.
- **Portfolio Data:** 74 historical snapshots (Jun 2023 – Aug 2026) + user transactions
- **Database:** SQLite with proper schema, migrations, foreign keys. **Not tracked in git** — see
  Backups below.
- **Server:** Express.js on Node.js 22, rate-limited auth endpoints, CORS-aware
- **Email Delivery:** Resend SMTP — magic-link login, price alerts, and the contact form all send real email
- **Price-Fetch Scheduler:** systemd timer, runs daily at 09:00 UTC, market-aware (skips weekends,
  and skips US trading hours 13:00–20:00 UTC so it only ever records a settled close)
- **Backups:** `./backup-db.sh` nightly via cron — see Backups below

### 🔎 Review findings — 2026-09-11

A full sweep of the app, the server, the infrastructure and the repository. Severity is
about what an outsider could do or what silently corrupts data, not about effort.

**Phases 1-3 were implemented on 2026-09-12** — items 1 to 10 below are done; what is
left is marked at the end of this section.

**Fixed during the review:**

- **CRITICAL — the whole application directory was public.** `express.static(__dirname)`
  served every file beside it over HTTPS: `data.db`, the `data.db.backup-*` files (one taken
  *before* session cookies were hashed and purged — enough to take over an account), all
  source, and `.git/` with the history that still carries the tracked database. Confirmed
  against production, then replaced with an allowlist of the four files meant to be public.
  The stale backups were moved to `~/backups/portfoliotracker/legacy` (chmod 600).

**Done (2026-09-12):**

| # | Was | Now |
|---|---|---|
| 1 | `POST /api/contact` public, unthrottled, uncapped | 5/hour per address, every field length-capped, type and address shape checked, 64kb JSON limit (a 200kb body gets 413) |
| 2 | Transactions stored as posted | Ticker shape, positive finite quantity and amount, buy/sell, 3-letter currency, positive rate, date between 1990 and tomorrow — each with its own message. Alerts check the rule type and reject a percentage below 0 or above 100 |
| 3 | No security headers | CSP, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy, `x-powered-by` off. The page is one inline script, so `script-src` needs `'unsafe-inline'` — the CSP is not an XSS defence and the comment says so |
| 4 | An unhandled rejection killed the process | `unhandledRejection` and `uncaughtException` log instead |
| 5 | Expired sessions and spent tokens accumulated forever | Purged at boot and daily; the first run removed 2 sessions and 3 tokens |
| 6 | 3 moderate advisories | `qs` pinned to 6.16.0 through an `overrides` entry — express 4 pulls a vulnerable one otherwise. `npm audit`: 0 |
| 7 | 14 form controls with no accessible name | All labelled: 11 by `for=`, 3 by `aria-label` where the visible label names a group rather than a field |
| 8 | `schema.sql` (a MySQL schema with `password_hash` and `api_key`), `migrate.js`, `migrate-snapshots.js` | Deleted |
| 9 | Logs never rotated | `logrotate.portfoliotracker` in the repo — **needs one root command to install, see DEPLOYMENT.md** |
| 10 | `emailAttempts` map unbounded | Pruned once it passes 500 entries |

**Still open:**

| # | Severity | Finding |
|---|---|---|
| 18 | Low | Signing in is registration: anyone with the URL can create an account. `noindex` keeps it out of search but is not a gate. Deliberate for now; an invite code or email allow-list is the fix if it ever matters. |

**Cleared 2026-09-12:** the row `verify-portfolio.js` had been flagging — 1,984 AAPL for
€0.13, dated 1994, entered by a test sign-in on 2026-09-10 — was deleted at the owner's
request after a backup. `verify-portfolio.js` now reports **no problems found**. The
validation added in Phase 1 rejects that shape of input at the API, so it cannot recur;
what it could not do was clean up a row already stored.

**On the record — how this one got in, and how a second nearly did:** the garbage row
arrived through the API from a browser, which is why client-side checks were never enough.
While *testing* the new server-side date rule, this session posted a 1994-dated transaction
straight at the live account and it was accepted, because 1990 is the floor and 1994 is
inside it. The row was removed immediately and the count returned to 16, but it should
never have been created: **write endpoints get tested against a scratch account, not
against real data.** Every other check in that phase was.

**Checked and sound:** ownership filters on every alert and transaction route (no IDOR);
session cookies `HttpOnly; Secure; SameSite=Lax`; magic-link tokens hashed, single-use and
consumed only on POST; `trust proxy` set so rate limits see the real client; Google OAuth
state cookie; no XSS in the server-rendered confirm page; no console errors or failed
requests across all five tabs; no duplicate element ids; every chart carries an aria-label.

### ⏳ Open Items / Backlog

**Testing — 34 tests, in CI since 2026-09-12.**

`npm test` runs them; `node:test` is built into Node 22, so there is no framework to
install and nothing was added to package.json. `.github/workflows/test.yml` runs the suite,
asserts no database was created, and fails on a high npm advisory. `package-lock.json` is
tracked now because `npm ci` needs it.

They are scoped to what has actually broken here, not to a coverage number:

- **Market hours**, every hour of a weekday and a weekend — the check that once read its own
  09:00 timer slot as "still trading" and skipped every scheduled run.
- **Average cost**: buying lower, selling, full exit, one user's holdings invisible to
  another, and a split that multiplies only the shares held when it happened.
- **Alert semantics**: a dip against the euro cost basis, a target above it, a price level
  in the market's own currency and not in euros, a trailing rule against the 365-day high,
  a disabled rule, and the 24-hour throttle.
- **Migrations**: run twice and nothing changes; a table rebuild keeps existing rules; a
  euro threshold is *converted* into the market currency rather than relabelled.
- **HTTP**, against a real server on a throwaway database: `/data.db` and `/server.js` are
  404, the four public files are 200, the API is 401 unauthenticated, the security headers
  are present, and the contact form rejects a bad type, a bad address and an over-long
  message.

Two of them were checked by reintroducing the original bug: putting back `hour < close`
fails two tests, and putting back `express.static(__dirname)` fails the two that fetch
`/data.db` and `/server.js`. A test nobody has seen fail is a guess.

**What this does not do**, and it is worth being clear: editing a file on the server *is*
deploying it, and CI runs after a push. This is a gate on the repository, not on the
deployment. A real deployment gate needs a staging copy.

**`check-job-health.js`, `recompute-eur.js` and `verify-portfolio.js` were listed as
blockers and are not.** They are operational scripts, not libraries; the valuable tests do
not need to `require()` them, and refactoring three working scripts to satisfy a plan would
be work with no test behind it. `verify-portfolio.js` also needs the production database,
which CI will never have.

**The sell side — done (2026-09-10):**

The stated purpose is twofold: average *in* below your cost, and sell *near the tops*. Everything
built before 2026-09-10 served only the first. Now:

1. ✅ `gain_from_avg_cost` — the mirror of the dip rule, firing when a holding is up X% on what
   you paid.
2. ✅ **A notion of the top.** `backfill-history.js` fills in years of daily closes, and
   `recentHigh()` in `db-migrations.js` reads the high of the trailing 365 days.
3. ✅ `drop_from_high` — the trailing signal, which is what the removed `change_pct` should have
   been. Against the current holdings at a 20% threshold, five of ten would fire.
4. ✅ **Framing.** The headline is "Buy the dips. Sell near the tops. On a rule, not a feeling.";
   the hero states all three rule types with figures; a second worked example ("What a rule near
   the top does") shows a target firing on the way up and a trailing level firing when the run
   breaks; the feature card is "Four rules, both directions"; the how-it-works steps and the
   landing page's mock of the alert email match what the digest actually sends. The DCA tab reads
   in both directions and gained a "Highest premium" figure to mirror "Deepest discount". Its
   "Notable dips" table stays one-sided on purpose — it is the buying-opportunity log, and it says
   so, pointing at the alert map for the other direction.

**Price history — backfilled 2026-09-10 (was an open item):**

`price-fetch.js` records one row per ticker per day from the day it starts running, so most
holdings had days of history rather than years. Two consequences were live: `/api/snapshots` fell
back to cost basis for any date with no price, so the portfolio-over-time chart was largely
accumulated cost rather than market value; and without a high, "near the top" could not be
expressed at all.

`backfill-history.js` fixes both — Yahoo's `chart()` daily bars, stored in the market's own
currency and converted at the rate **for that date** (same principle as `recompute-eur.js`),
upserted per (ticker, date) so it is safe to re-run:

```bash
node backfill-history.js                    # every held ticker, 2 years
node backfill-history.js ORCL --years 5     # one ticker, deeper
node backfill-history.js --years 2 --dry-run
```

The first run added 6,123 rows across 11 tickers. It changed what the chart says: March 2025
showed €6,197 of market value against €6,837 of cost — under water, and previously invisible —
and max drawdown corrected from −13.5% to −21.9%. Registering a transaction for a ticker with no
history now asks how far back to fetch (6mo / 1y / 2y / 5y) and calls the same code.

**Ops hygiene:**
- No load testing has been done — response times under real concurrent load are unverified

*(Alerts have been emailed to each rule's own owner since the multi-user work — `evaluateAlerts`
joins `users` and sends to `owner_email`, and since 2026-09-12 to nothing else — the old
fallback would have posted one person's holdings to the operator's inbox. The alerts
card claimed a placeholder address until 2026-09-11; the copy was simply stale.)*

*(Historical euro values were recomputed from real per-date FX on 2026-09-09 — see
Exchange Rates below. No longer an open item.)*

**Open registration:**
- `noindex` keeps the site out of search results, but **signing in is registration** — anyone with
  the URL can create an account. Gate with an invite code or an email allow-list if that ever
  matters.

**Not planned for now:**
- AI-powered transaction import from screenshots/PDFs — a placeholder UI/endpoint was built then
  removed. Explicitly parked (2026-09-09); do not pick it up without asking.

**`data.db` removed from the git history — 2026-09-12.** `git filter-repo --invert-paths
--path data.db` stripped it from all 14 commits that carried it, and the result was
force-pushed. 110 commits became 106: four had only ever touched the database and were left
empty. The current code is byte-identical — the tree hash at HEAD is the same before and
after (`5b5c4866868a`) — and a fresh clone now holds 106 commits, zero `data.db` blobs, and
792 KB instead of 7.1 MB.

What was actually in there, having checked rather than assumed: sessions were stored
unhashed until `5151e45`, so those blobs did hold live-shaped cookies — but they were inert,
because the lookup hashes what you present and the rows they matched were deleted long ago.
The real portfolio was never committed: tracking stopped at 16:40 on 9 September and the
sixteen real transactions were entered at 22:52 the same day. What genuinely remained was
**five email addresses**, three of them other people's, which is what made the rewrite worth
doing.

**One loose end, and it needs you.** GitHub keeps unreachable objects until it
garbage-collects, so an old blob is *still* fetchable by exact SHA through the API — but
only with a token that already has access to this private repository. Unauthenticated
requests get 404, and a fresh clone does not contain it. To have them provably gone, open a
support request at https://support.github.com asking GitHub to run `gc` on
`luisdanielsilva/portfoliotracker` after a history rewrite. Until then the exposure is
limited to people who can already read the whole repository.

**CSP tightened and the XSS shape removed — 2026-09-12.** The application moved out of
`index.html` into `app.js` (142 KB, 2,643 lines) so `script-src` could drop
`'unsafe-inline'` and become `'self'`. With an inline script the browser cannot tell the one
you wrote from one an attacker injected, so the old policy had to permit both and bought
nothing against XSS; an injected `<script>` and an injected `on*` handler are both refused
now, verified in the browser. `style-src` still allows inline styles — 39 KB of them, and an
injected stylesheet is a far smaller problem than injected code.

Separately and more importantly, six places interpolated a ticker-derived string into
`innerHTML` without escaping, including the transaction list. Not exploitable — the API
rejects a ticker containing markup and no stored ticker is dangerous — but plugged at one
end only, and the CSP as it then stood would not have caught it. All six now use `esc()`.
Fix the injection, then keep the backstop: in that order.

**Off-site backups — done 2026-09-12.** `backup-offsite.sh` encrypts the nightly snapshot
with gpg (AES256) and puts it in two independent places weekly: an email to
`CONTACT_EMAIL_TO`, and a commit in the private `portfoliotracker-backups` repository.
Encryption is what makes the git destination acceptable — a leak of that repo yields
ciphertext. The script refuses to ship anything that does not decrypt back to a valid gzip,
and a restore drill was run end to end: the copy in GitHub decrypts to a database with
`integrity_check` ok and 5 users, 16 transactions, 16 alerts, 6,144 prices. Details and the
restore procedure are in DEPLOYMENT.md.

**Settled, recorded so it is not re-litigated:**
- **No log rotation. Decided 2026-09-12 after measuring — do not raise it again without new
  numbers.** `price-fetch.log` grew 52 KB in eight days: ~6.5 KB a day, ~2.4 MB a year,
  against 28 GB free. It was proposed as generic hygiene, and the measurement did not
  support it. The config that existed for it has been deleted. The residual risk is a crash
  loop turning 6 KB a day into megabytes an hour — if that ever happens, the file to watch
  is `~/.pm2/logs/portfolio-api-error*.log` rather than `logs/`, because that is where a
  failing server writes and nothing prunes it.
- **Alerts go to the address you authenticated with. Decided 2026-09-12 — do not propose a
  `notify_email` column, a profile page or a per-alert recipient again.** The address *is*
  the identity: `findOrCreateUserByEmail` keys the account on it, so a magic link and a
  Google sign-in for the same address reach the same account, and `evaluateAlerts` sends to
  `users.email` with no environment variable involved. A Google sign-in therefore delivers
  to whatever address that Google account carries, which is often not a gmail.com one —
  three of the five accounts here are corporate. The simplicity is the point: one address
  per account, nothing to configure, nothing to verify a second time, no way for alerts
  about someone's holdings to be pointed at an address they have not proved they own.
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

### 🆕 What a new account sees

A brand-new account has no transactions, and everything in the app is derived from
transactions — so every chart, the KPI strip and the picker have nothing to draw.

**The blank page was one uncaught exception, not an absent feature.** `renderHeadline()`
called `fmtDayY.format(new Date(T[n-1]))` with an empty series, `new Date(undefined)` made
Intl throw `RangeError: Invalid time value`, and that aborted `rebuild()` before the picker,
the charts, the KPI strip or the tables had drawn anything. `startApp()`'s `.catch` swallowed
it, so the console was clean and the page merely looked empty. That catch now logs.

With the throw fixed, the empty state is deliberate:
- Every chart falls back to `drawEmptyChart()` — its own axes drawn at zero, a caption, and a
  button that focuses the transaction form. No invented data inside the signed-in app; the
  example curves belong on the landing page, where they are labelled as examples.
- The KPI strip renders five cards at `€ 0,00` / `—` so the band holds its place instead of
  appearing from nowhere with the first transaction.
- A three-step first-run card sits above the chart and hides itself once `n > 0`.
- The stock-splits events line is hidden when you hold nothing — a split in a stock you do
  not own is not an event in your portfolio.

Also fixed here: `CURRENT_MARKET_VALUE` and `CURRENT_COST_BASIS` were only ever assigned from
`/api/prices`, which has never returned snapshots, so the gain line beside the headline was
dead for every account since it was written. They now come from the last snapshot, where the
numbers actually are.

### 📈 How the portfolio chart is built

There is **no snapshots table**. `/api/snapshots` recomputes the entire series on every
request from `transactions` (split-adjusted into current share units) valued at the newest
stored price on or before each date, so the chart cannot drift from the transactions behind
it. Three things about it are worth knowing, all of them mistakes that were live:

- **The series ends at the later of now and the newest transaction.** It used to walk from the
  first transaction's own clock time, so every point carried that hour and the series stopped
  there. The registration form defaults to 12:00, so a purchase entered in the morning was
  stamped hours ahead of the last point and did not reach the chart until the next day.
- **Dates are sent as UTC instants and must be parsed as such.** The client stripped the `Z`
  and re-parsed, which moved every point back by the viewer's offset — an hour, except that
  local midnight minus an hour lands on the previous day, so the last point read a day early.
- **Nothing about the chart is stored in the browser.** Registering a transaction used to push
  a snapshot built client-side into `localStorage` (`pf.snapshots.v1`). It valued the new
  position at what was paid rather than at market, survived deleting the transaction, and
  outlived the page — one stale copy went on overriding the tail of the chart forever. The key
  is now cleared on load. Do not reintroduce a client-side copy of derived state.

`refreshPortfolio()` re-fetches and redraws after any transaction is added or deleted, and
after a backfill lands new history.

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
- `AUTH_EMAIL_FROM` / `ALERT_EMAIL_FROM` — the two sender addresses
- `CONTACT_EMAIL_TO` — where contact-form messages land: the address the website publishes
- `OPS_EMAIL_TO` — where the machine writes: the per-run price-fetch report and the watchdog
- `ALERT_EMAIL_TO` — legacy single address; both of the above fall back to it

  **No environment variable decides who gets an alert.** A digest goes to the account that
  created the rule, read from `users.email` — `ALERT_EMAIL_TO` never named the recipient of
  an alert despite what it sounds like, which is why the two were split on 2026-09-12.
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
- `POST /api/contact` — Contact form; emails `CONTACT_EMAIL_TO` with the submitter as reply-to

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
triggered, duration — sent to `OPS_EMAIL_TO`. A crash reports before exiting. Turn it off with
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
- **Sep 2026:** Two years of daily price history backfilled; the portfolio chart became market
  value rather than accumulated cost
- **Sep 2026:** Sell side built — `gain_from_avg_cost` and `drop_from_high` rules, digest sections
  for both, and a per-alert sparkline showing the gap each rule is watching
- **Sep 2026:** Alert map — a full chart of one holding with every rule drawn on it, and markers
  where each would have fired
- **Sep 2026:** Public copy reframed for both directions; the tool had been described as a
  dip-buying tool for a week after it stopped being one
