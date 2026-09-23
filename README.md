# Portfolio Tracker

A personal tool for someone who buys a few companies, holds them for years, and keeps adding
to them. It records what you actually bought, values it over time in euros, and tells you when
a holding has moved far enough from its own normal to be worth a look.

**Live:** https://www.singleuseapps.com/portfoliotracker/

> ### This is not financial advice
>
> Nothing this tool produces is a recommendation to buy or sell anything. It does not know
> what a company is worth, whether its business is sound, or what is about to happen. Every
> signal in it is arithmetic on past closing prices, and past prices are not a forecast.
>
> **Use it at your own risk.** The numbers can be wrong: a price feed can be stale or
> mistaken, a stock split can be missed, and the code is written by one person for their own
> use. Check anything that matters against your broker before acting on it. If you need
> advice, ask a qualified financial adviser.

## What it does

- **Records transactions.** Buys and sells, with the amount you actually paid. Foreign
  purchases convert to euros at the rate **on the day of the trade**, not today's.
- **Values the portfolio over time.** A daily price fetch builds the history; the chart shows
  what the holdings were worth on any past date, adjusted for stock splits.
- **Follows your real cost basis.** Every alert that talks about being "up" or "down" measures
  against what you actually paid, recalculated as you keep buying.
- **Watches in both directions.** Most tools only ever suggest buying more. This one also
  tells you when a holding is unusually expensive by its own history.
- **Emails you, sparingly.** Alerts you write yourself, plus one fixed signal from the
  Algorithm tab that works out to a handful of emails a year.

## How to use it

1. **Sign in** with a login link sent to your email, or with Google. There is no password.
2. **Register your transactions** on the *Transactions* tab — date, ticker, quantity, and the
   amount that left your account. Each new ticker offers to load its price history. A CSV
   export from your broker can be imported instead: the file is read in your browser, you
   confirm what it found, and the import can be undone in one action.
3. **Wait a day.** Prices are fetched once every weekday morning. History appears immediately
   for a backfilled ticker; today's value updates each morning after that.
4. **Set the alerts you want** on the *Alerts* tab: pick a type — a dip below your average
   cost, a profit target, a fall from a 12-month high, or a plain price level — then a holding
   and a value. The panel beside the form shows what that rule would do, including a chart of
   where the level sits against the last six months.
5. **Read the *Algorithm* tab** when deciding where to add next. It ranks each holding's price
   against its own 6-month, 1-year and 2-year history, and explains every number it shows.

The other tabs — *Portfolio*, *DCA* — are ways of looking at the same data.

## What it is good at

- **It uses your numbers, not generic ones.** A dip alert fires against your average cost, so
  it stays meaningful as you keep buying. Most trackers can only compare against a fixed price.
- **Currency is handled honestly.** Euros for what you paid, the market's own currency for what
  a share costs, and real historical exchange rates for past dates.
- **It explains itself.** Every chart says what it measures and what it cannot tell you. The
  Algorithm tab shows the percentile behind each reading rather than a verdict.
- **It is quiet by design.** The one automatic alert is deliberately rare, and there is no
  sell alert at all, because the underlying reading is true too often to be worth an email.
- **Your data stays yours.** No ads, no analytics, no third-party trackers, nothing sold. The
  holdings are visible only to the account that entered them.

## What it is not good at

Worth reading before trusting it with anything:

- **Closing prices only.** No intraday, no volume, no order book. A signal is at best a
  statement about where today's close sits in a distribution of past closes.
- **It knows nothing about the companies.** No earnings, revenue, debt or news. A price that
  looks unusually cheap is equally consistent with a bargain and with something genuinely
  broken, and no arrangement of these numbers separates the two.
- **The signal has a known bias.** Ranking a *price level* means a stock in a long uptrend sits
  near its own top almost permanently, so the sell side reads "expensive" most of the time for
  a winner. This is measured and documented rather than hidden — see *Algorithm tab* below.
- **Transactions are typed in by hand.** There is no broker connection, so the records are only
  as good as what you enter. A reconciliation script exists because mistakes happen.
- **Prices come from an unofficial source.** Yahoo Finance via a community library. It is
  free and usually right, with no guarantee of either.
- **One machine, one person.** A single small server and a nightly backup. It is a personal
  tool that other people are welcome to use, not a service with an uptime promise.
- **Euro-centric.** Cost basis and portfolio value are in euros. It works with dollar and other
  foreign holdings, but a non-euro investor would find the framing odd.

## Running your own

Node 22, SQLite, and an SMTP account for the login links. `npm ci && npm start`, with `.env`
providing `SMTP_*`, `APP_BASE_URL` and optionally Google OAuth credentials. `npm test` runs the
suite. Everything below this line is the engineering record for the deployment above.

---

## Current Status (Sept 2026)

### ✅ Working Features
- **Frontend:** Single-page app with responsive design, charts (SVG line charts), snapshot timeline
- **Authentication:** Passwordless magic-link login + Google OAuth, session-based
  - Magic-link verify is a two-step GET (confirm page) → POST (consume) flow, so corporate mail
    gateways that auto-fetch links to scan them (e.g. Microsoft Safe Links) can't burn the
    one-time token before the user clicks it
- **Transactions tab:** buy/sell registration with automatic snapshot derivation, and the
  transaction list. Split out of the old combined "Add transactions and alerts" tab on
  2026-09-12 — registering a holding and deciding when to be told about it are different
  jobs, and one screen was doing both.
- **Transactions tab:** the register form, the transaction list, and **import from a broker
  CSV** — read in the browser, confirmed row by row, undoable. See *Import from a broker file*.
- **Alerts tab:** one form for all four rule types (dip, target, trailing, price level), the
  alert map and the alert list. The Algorithm tab has its own alert, which is deliberately *not* here — see
  *Algorithm alerts* below.
- **Algorithm tab:** the position-timing signal — every holding's close ranked against its own
  trailing 6M/1Y/2Y history, with two signal lanes (Early / Confirmed), notable runs, a full data
  table and a position-gated recommendation. Rules in `algorithm.js`, details under *Algorithm tab*.
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
- **Price-Fetch Scheduler:** systemd timer, runs daily at 09:00 local time, market-aware (skips weekends,
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
requests across all seven tabs; no duplicate element ids; every chart carries an aria-label.

### 🔎 Security review — 2026-09-13

A full pass over auth, authorisation, injection, data exposure and host risk. Where possible
the conclusion was **tested against the running app**, not read off the source.

**Fixed in this pass:**

1. **`data.db` was world-readable (0644), and so were the backups** in a world-traversable
   directory. Any local account on the box — including a compromised process belonging to
   another site — could read every user's holdings and email address. Now `600`, with the
   backup directory `700`. This was the most serious finding, and it had nothing to do with
   the application code.
2. **Sixteen endpoints returned raw `err.message` to the client** — SQLite text, library
   internals, file paths. Every one already logged the real error server-side, so the detail
   bought the caller nothing and an attacker a look inside. They now return a generic message;
   `/api/backfill` returns a useful-but-neutral 502 because its failures are usually "that
   symbol does not exist".
3. **Contact-form subject now strips CR/LF.** Header injection was tested and is *not*
   exploitable — nodemailer folds a newline into a continuation line rather than starting a
   header — but that is the library's promise rather than this app's.

**Tested and sound — no change needed:**

- **Cross-account isolation.** A scratch account was given a session and pointed at the real
  account's rows: delete and edit of another user's transaction and alert both `404`, every
  read came back empty, `/api/algorithm` refuses a ticker the caller does not own, and the
  victim's 16 transactions were untouched afterwards. Every mutation checks `id AND user_id`
  and returns 404 rather than 403, so it does not even confirm the row exists.
- **Input validation.** Twelve hostile payloads — negative and zero quantities, a €1e15 amount,
  `NaN`, an invented `tx_type`, dates in 1850 and 2200, `<script>` and `'; DROP TABLE users;--`
  as tickers, unknown rule types, absurd thresholds — all refused with 400.
- **No SQL injection.** Every query is a prepared statement; the single template in
  `db-migrations.js` interpolates an internal constant, never input.
- **No `eval`, no `child_process`, no path traversal** in application code.
- **Google OAuth**: state CSRF cookie compared and cleared, id_token signature/issuer/audience
  verified, and `email_verified !== true` rejected — without that last check someone could
  claim an account belonging to another person's address.
- **Magic link**: token stored only as a hash, single-use, expiring; the confirm page echoes
  the token only when it is *already valid* and escapes it, so there is no reflected XSS.
- **Sessions**: 32 random bytes, stored hashed, `HttpOnly; Secure; SameSite=Lax`. Lax is also
  what stops cross-site POSTs from carrying the cookie, which is the CSRF defence for every
  state-changing endpoint.
- **Credential hygiene**: spent and expired tokens and sessions purged on boot and daily.
- `npm audit` clean, `.env` is `600`, `.env.example` holds no real values, `.gitignore` covers
  the database, backups and logs, and nothing sensitive is tracked.

**Left open, with reasons:**

1. **Ticker enumeration.** `/api/price-history/:ticker` and `/api/prices` serve the shared price
   tables, so any signed-in user can fetch history for a symbol only someone else holds. It
   reveals *what* is tracked, never *who* holds it or how much. Low severity; fixing it means
   scoping shared price data per user, which costs more than it returns.
2. ~~**The client's `esc()` does not escape `>` or `'`.**~~ **Aligned in `5c06643`
   (2026-09-14).** `esc()` in `app.js:110` now covers the same five characters as
   `escapeHtml()`, which lives in `auth-mail.js` and is re-exported to `server.js` — one
   definition, two callers.
3. **Open registration** remains the multiplier under every authenticated limit.

### ⚡ Capacity work — 2026-09-13

Done because the app is meant to be open to anyone signing in, which makes a registration
gate the wrong answer: the fix is to survive the load, not to ration the door.

**Measured before and after, same test — 20 concurrent `/api/snapshots` plus one unrelated
trivial request fired during the burst:**

| | Before | After |
|---|---|---|
| The burst | 966 ms | **169 ms** |
| A bystander's trivial request | 950 ms (19x slower than idle) | **84 ms** (2x) |

Three changes, in this order, because each depends on the one before it.

**1. WAL, with a busy timeout.** The database ran in the default rollback-journal mode, where
a write locks out every reader. On a copy of this database, 2,500 single-row inserts — one
backfill — took **6,895 ms in the old mode and 114 ms in WAL**, and in the old mode every
other request queued behind it. `busy_timeout = 5000` is set on *every* process that opens
the file (it is a connection setting, not a database one), so a writer that finds the file
locked waits rather than failing with SQLITE_BUSY.

*The restore path had to be fixed first.* The nightly backup was already WAL-safe — it uses
SQLite's online backup API and verifies integrity afterwards. `backup-db.sh restore` was not:
it took its "just in case" copy with a plain `cp` of `data.db` alone, which in WAL mode can
omit the newest committed rows, and it then overwrote the database while the **old `-wal` file
was still beside it** — which SQLite would replay onto the restored file. It now checkpoints
before copying and removes the stale `-wal`/`-shm` with the file they describe.

**2. Caching the computed views.** `/api/snapshots` rebuilt a user's whole history on every
request (463KB, ~48ms of blocking work) for a page that had not changed; `/api/algorithm`
re-scored a full price series per request, and that scoring is *identical for every user* —
only the position gate differs. Both are now keyed by a database-wide `data_version` counter,
bumped by a single middleware after any successful write and by the price-fetch job after it
writes. Keying on the data rather than on a clock is what makes it correct across processes:
neither worker has to hear about the other's writes, because the key changes underneath both.
Result: **71ms → 2.9ms** for snapshots, 25ms → 7ms for the algorithm.

**3. Two workers.** pm2 moved from one forked process to two clustered ones on a two-core box —
half the machine had been idle. This is only safe *because* of (1). Two consequences worth
remembering: rate-limit counters live in each process's memory, so the effective limit is
roughly doubled, and the caches are per-process, so each warms separately.

Pinned by tests: a write must retire the cached portfolio (verified by removing the version
bump and watching the test fail), and the database must be in WAL mode.

### 🚨 The 453-email morning — 2026-09-15

Worth keeping because the bug was trivial and the consequences were not.

**What happened.** The database split left `const identityDb` declared *after* the code that
reads it, inside the same function. `const` is hoisted into a temporal dead zone, so this is not
a load-time error that any check would catch — it is a throw on the line that uses it. The daily
job died on its first piece of real work.

**Why it became five hours long.** The systemd unit carries `Restart=on-failure` with
`RestartSec=30` and no start limit. A job that cannot start is restarted for ever: **453 failed
runs between 08:00 and 13:00**, each one emailing a failure report, until the account hit its
daily sending quota. At that point the alert emails users actually rely on could not be sent
either — the monitoring had taken out the thing it was monitoring.

**Three lessons, two of them now enforced in code:**

1. **`node --check` does not catch this.** It is valid syntax. Only running the function does.
   82 tests passed while the job was broken, because none of them entered `fetchPrices`.
2. **A failure report is now throttled to one an hour** (`failureRecentlyReported`). Order
   matters and both obvious orderings are wrong: ask the throttle *before* recording the
   failure, or it finds the row it just wrote and suppresses the first report; close the
   database *after* asking, or it cannot read its own history and every crash mails.
3. **The unit should give up.** `Restart=on-failure` with no `StartLimitBurst` on a
   timer-driven oneshot means infinite retries between scheduled runs. Needs root:

```
sudo systemctl edit --full portfolio-price-fetch.service
# under [Unit] add:   StartLimitIntervalSec=1h
#                     StartLimitBurst=3
sudo systemctl daemon-reload
```

**No prices were lost.** The ranged catch-up added on 2026-09-14 fills gaps: a held ticker more
than a day behind gets one request covering the missing days rather than a quote for today, so
the next successful run restores the whole gap.


### ✉️ A ceiling on outbound mail — 2026-09-15

After the 453-email morning, every send goes through `mailguard.js`. Nothing calls `sendMail`
directly any more, and a send that would exceed its budget does not happen — whichever process
asks, however often.

**Per recipient, per rolling 24 hours:**

| Kind | Limit | What it is |
|---|---|---|
| `login` | 10 | magic links — someone mistypes, loses the mail, tries again |
| `alert` | 5 | the daily digest: dip/target/trailing/price rules, the algorithm's buy alert and Monday's standings all ride in **one** message |
| `contact` | 30 | support mail — silently dropping one of these is far worse than dropping a duplicate report |
| `run-report` | 6 | one scheduled run a day; six means something is retrying |
| `health` | 3 | the staleness check, once a day |
| `backup` | 3 | weekly |
| anything new | 5 | a kind nobody listed gets a budget rather than a free pass |

Plus a **global ceiling of ten messages a day per registered user**, across all recipients and
kinds — 60 a day at the six accounts registered on 2026-09-15, and it moves with the user base.
The per-recipient budgets would have stopped the incident at six; the global one is for the
failure nobody has thought of yet — a loop that invents new recipients, which no per-recipient
budget can see.

It is expressed per user rather than as a flat number (it was a flat 200 until 2026-09-15) so
that it stays tight as the app grows: 200 is very loose for six accounts and very tight for two
hundred. Two consequences to know about:

- **The ceiling can be lower than one person's own budgets allow** — `contact` alone is 30. That
  is deliberate, but it does mean an unusually chatty account can crowd out another account's
  alerts. Raise `GLOBAL_PER_USER` before loosening any per-recipient budget.
- **A floor of one user's worth** (`GLOBAL_FLOOR`, ten) keeps a fresh install with an empty
  `users` table from computing a ceiling of zero and silencing the backup and health mail that
  says the install is working.

The count comes from the identity database, which mailguard reads for exactly one number and
never an address; resolving *where* that database is now lives in `identity-db.js`, shared with
`price-fetch.js` so the two cannot disagree. If the count cannot be read the global check is
skipped rather than guessed at — the per-recipient budgets still apply, on the same principle
as the broken-ledger rule below.

**A normal user receives one email a day**: the digest. Everything the app knows how to tell
them arrives inside it.

**Three decisions worth keeping:**

- **The ledger stores a hash, not the address.** It lives in the financial database, which since
  the split must never hold an email address. Counting does not need to know who anybody is.
  Matching is case- and whitespace-insensitive, so capitalisation cannot buy a second budget.
- **The send is recorded before it goes out**, not after it succeeds. A provider error that left
  the count unchanged would let a retry loop send for ever — the exact shape of what happened.
- **A broken ledger lets mail through.** Backwards, that would mean a bookkeeping bug silences
  the alerts, which is worse than the problem the bookkeeping prevents.

Twelve tests, verified by removing the cap and watching four of them fail, and by moving the
per-user number from ten to eleven and watching the ceiling test catch it.

### 🧹 Two things taken out — 2026-09-15

**"All stocks at a glance" is gone.** The tab drew one small chart per holding — a grid of
sparklines with a shared scrubber, absolute or indexed to 100, sorted by size or by % change.
Removed at the user's request. What went with it: `buildGrid()` and the whole small-multiples
block in `app.js` (~100 lines), the `view-stocks` section, and the CSS only it used
(`.grid-sm`, `.cell`, `.sm-*`, `.scrubline`). Two helpers had to survive it — `firstIdx()` moved
next to the detail view, which also uses it; `idx1()` went, having only ever formatted an
indexed-to-100 label. Nothing else read any of it, and no data was touched: every number that
tab showed is derived from `/api/snapshots` and still on the *Portfolio in detail* tab.

**All four alert forms are one form.** They were four `addcard`s, three of them identical in
shape — pick a holding, pick a percentage, read back the price it would fire at — differing only
in which presets they offered, what the percentage was measured against, and what the preview
said. Now one card with a **Type** segmented control, and those differences live in a
`RULE_TYPES` table the form reads from. Another rule is an entry in that table, not another card.

**The layout answers the other half of the complaint.** Every control used to stack down the
left edge, leaving the right half of a wide panel empty. Type spans the top because it governs
both columns; below it the controls sit left and *what the rule will actually do* sits right —
the type's explanation, the numbers it would fire at, and the same six-month sparkline the alert
list draws, so the panel carries something real rather than padding the card out. Single column
under 720px.

**Price level joined the merge, and lost its free-text ticker box.** It keeps its own shape
inside the form — an above/below direction and a price rather than percentage presets — and the
`ruleType` (`price_above` / `price_below`) is decided from the direction at submit. The ticker is
now the same holdings list as the other three, which is a fix rather than a restriction: the
daily job fetches **only tickers you currently hold** (`price-fetch.js` filters `everSeen` by
`stillHeld`), so a price alert typed against anything else had no prices to evaluate and could
never fire. The currency label follows the holding — it can say `Price (USD)` now, where the old
free-text form could only say `Threshold` and hope.

Four details worth keeping:

- **Each type remembers its own preset and its own custom box.** Flipping between them to
  compare does not rewrite the one you had set up.
- **The trailing preview stays in the market's own currency** while the two cost-based ones
  convert — the reason is unchanged: comparing a euro trigger against a dollar high is a trap.
- **The dip preview used to render its threshold as `-5,0%`** while the other two said `+25%`
  and `−20%`. Invisible while they were separate cards, obvious one button apart; it now
  matches. The dip form's success message was also `frm-note success`, a class that does not
  exist, so "Dip alert created!" came out in the error colour. Both fixed in passing.
- **The sparkline is asked for once per ticker.** A holding with no stored history would
  otherwise send a request on every keystroke in the custom box and never get an answer.

`LATEST_PRICE_CURRENCY` went with the old price form: it existed only to label that free-text
box, and `LATEST_PRICES` already carries each ticker's currency.

### 💱 "no such column: updated_at" — 2026-09-16

The daily job died at 09:00 before storing a single price. `exchange_rates` has a
`created_at` column and has never had `updated_at` — but the **pre-split `data.db` did**,
and both copies of the rate upsert were written against that. The 2026-09-14 split rebuilt
the table from `schema.sqlite.sql`, which says `created_at`, and the mismatch sat there until
the first run that reached the statement.

Three things made it worse than a typo deserves:

- **SQLite resolves column names at `prepare()`, not at `run()`**, so this threw before any
  rate was fetched. `fetchExchangeRates` has a per-currency `catch` that falls back to the
  last known rate — designed exactly for "the rate is unavailable this morning" — but the
  prepare is outside the loop, so a wrong column name is fatal where a network failure is not.
- **The statement existed twice**, in `price-fetch.js` and `recompute-eur.js`, and both copies
  carried the same wrong column. It is now `RATE_UPSERT_SQL`, exported from `price-fetch.js`
  and required by the other; a test asserts `recompute-eur.js` contains no second copy.
- **No test had ever prepared it against the shipped schema.** `test/exchange-rates.test.js`
  now does, plus the conflict path (a second write on the same day updates rather than
  duplicating). Verified by restoring the wrong column and watching three tests fail.

The timestamp is gone rather than renamed: nothing reads it, and `created_at` on a row that
was just rewritten would be a lie. The live database needed no migration — its schema already
matched `schema.sqlite.sql` exactly, table for table and column for column; only the SQL was
speaking the old database's language.

**Maintenance scripts now refuse to run on `require`.** `recompute-eur.js` executed a
top-level IIFE, so `require('./recompute-eur')` — checking the module still loads, say —
restated every euro price in whatever `DB_PATH` pointed at. It and `split-databases.js` are
both behind `require.main === module` now, and **`check-job-health.js` and `send-backup.js`
joined them on 2026-09-18** — they had the same shape and the same reach: loading the first
opens the database, prints a verdict, can email an operator and calls `process.exit()` whichever
way it goes; loading the second either exits 1 for want of a file argument or emails the
database as an attachment. Either one takes its caller down with it, so the damage was never
limited to the script that was loaded.

`test/module-wiring.test.js` pins all four — the source must mention `require.main`, and the two
mail-sending ones are actually required in the test, where an unguarded script would end the run
rather than reach the assertion. Verified by deleting the guard and watching it fail.

### 📭 The login email that never sent — 2026-09-16

`mailguard.sendGuarded(...)` was added to `server.js` in two places when the ceiling landed on
2026-09-15 — and the `require` was not. That is a `ReferenceError`, thrown inside the request
handler and caught by the `try/catch` that exists so a broken mailer cannot swallow the only
way in. So **magic-link login and the contact form sent nothing for a day**, with one line in
the pm2 log — `Magic-link email to … failed: mailguard is not defined` — to show for it. The
caller got the usual "a login link is on its way".

Why nothing caught it:

- **The failure is deliberately quiet.** Both call sites treat a mail failure as something to
  log and continue from, which is right — a mailer that throws must not take out the login
  endpoint — but it means the difference between "sent" and "not sent" is invisible from
  outside.
- **The test suite runs with SMTP unconfigured**, which takes the `if (!authMailer)` branch
  above the call. No test has ever reached the line.
- **`node --check` passes.** An undefined identifier is only an error when the line runs.

`test/module-wiring.test.js` is the cheap check that would have caught it: for the project's
own modules, a file that writes `mailguard.` must require `./mailguard`. It also asserts
`server.js` never calls `authMailer.sendMail` directly, which would bypass every budget.
Verified by removing the require and watching two tests fail. It is not a substitute for
exercising the send path — `sendMagicLink` is not reachable from a test because `server.js`
starts listening on require — but it costs nothing and it is exactly the shape of this bug.

### ✉️ The mail path is testable now — 2026-09-16

Twice in two days a mail failure was invisible, and both times the reason was the same:
nothing could call the send path. `server.js` starts listening the moment it is required, so
the magic-link and contact-form senders inside it were unreachable from a test — and both are
wrapped in a `catch` that deliberately swallows, because a broken mailer must not take out the
login endpoint. Green suite, quiet log, no email.

`auth-mail.js` now holds both. Everything they need is passed in — the database, the mailer,
the addresses — so a test hands them a mailer that records instead of sending and asks the
question nobody was asking: **did a message with the link in it actually reach the mailer?**
`test/auth-mail.test.js` covers that, plus the login budget (the eleventh link in a day is
refused), a mailer that throws (reported, never propagated — signing in must not break), no
mailer at all, HTML escaping of what a stranger typed into the contact form, and header
injection through the subject line.

Reintroducing the exact 2026-09-15 bug — the missing `require` — now fails **nine** tests
instead of none.

Two behaviour changes came with it, both small:

- **A contact message stopped by the daily budget now throws**, like a failed send, so the
  endpoint answers "could not be delivered" instead of thanking the sender for a message that
  did not go. The budget refusing is not different from the provider refusing, from the only
  perspective that matters.
- **The magic link is HTML-escaped** in the email body. Today's link has a single query
  parameter so nothing changes; if a second is ever added, `&amp;` is the correct encoding
  inside an `href` and the raw `&` was not.

`escapeHtml` moved with them and is re-exported to `server.js`, which still needs it for the
confirm form. `server.js` no longer requires `mailguard` at all — it does not send anything
itself any more.

### 🧭 Website simplification — 2026-09-16

The suggestions paused for on 2026-09-12 arrived, and this is them.

**Portfolio over time and Portfolio in detail are one tab.** They were one subject behind two
clicks: the chart answers *what is it worth*, everything in the second tab answers *why*, and
none of the "why" means much before you have seen the line. One view now, chart first, detail
under it behind an *In detail* heading. `view-detail` is gone; nothing else changed, because
both halves were already rendered by the same `rebuild()`.

**Transactions moved to the rightmost tab** — the one you visit least sits furthest from where
the eye starts. Tab order is now Portfolio · DCA · Algorithm · Alerts · Transactions.

**The Transactions page is two columns:** the register form on the left, at a fixed 380px
because a form does not benefit from being wider, and the list of what you have registered
taking the rest. Stacked, the list began below the fold on the tab whose whole job is showing
it. One column under 860px.

**The Alerts page reads map → form → list.** The map is the picture the other two sections are
about; creating a rule adds a line to it, and the list is what is already on it.

**Two bugs in the alert list, both from the same cause.** The last column was `auto`, so it was
0 wide in the header row and ~100px in a data row — and since every row is its own grid, that
leftover went to the `fr` columns and the headings sat right of the numbers they labelled
("Fires at" and "Now" most visibly, measured 41px out). The same `auto` pushed the row's minimum
past the card: every column was already at its `minmax` floor, the total overflowed by 34px, and
the Delete button landed on the card's own border. Fixed by a fixed-width last column, floors
low enough to fit, and `min-width:0` on the cells. Measured after: header and row column edges
identical to the pixel, and the buttons 31px inside the card.

**The AI upload was part of these suggestions and is not built** — see *Not planned for now*.
The shape is agreed; it needs an API key the server does not have.

### 📒 A log of every alert given — 2026-09-17

Until today an alert left almost no trace. A hand-built rule updated one column,
`alerts.last_triggered_at`, which the next firing overwrote — so the third dip erased the first
two. The algorithm wrote a row in `algo_alert_log` with a tier and a confidence but no price.
Neither could answer the question the log now exists for: **was this alert actually given to
somebody, and did they then act on it?**

**One table for both kinds — `alert_events`.** The hand-built rules and the algorithm are
deliberately different features, but from the reader's side they are the same event: something
arrived in the inbox about a holding on a day. Two logs would have meant every evaluation query
is a UNION of two shapes, one of which lacks the price the evaluation needs. `source` says
which produced the row (`rule` / `algo`), `alert_type` carries the rule type or `algo`, and
`alert_id` points back at the rule for the ones that have one.

**A row is an email item, never a day the condition held.** A dip rule whose condition is true
for nine days running is throttled to one email and is therefore *one* event; a very strong buy
inside its 60-day cooldown is not an event at all. This is the distinction that decides whether
the eventual follow-through rate means anything — counting nine throttled days as nine alerts
would divide by the wrong number and flatter the result.

**Delivery is recorded, never assumed.** The row is written *before* the digest goes out, for
the same reason the throttle is stamped early: a mail failure that left the log empty would
re-fire the same alert every morning until it succeeded. What became of the email is then
written back onto the same row — `sent`, `not_sent` (no SMTP configured, or mailguard's daily
ceiling refused it), `failed` (the mailer threw), or `pending`, which means the process died
in between and should be read as *unknown*. An alert that never left is not one the reader
ignored, and `followThrough()` scores only delivered ones unless told otherwise.

**The price is copied onto the row** rather than looked up from `prices` later, because a
backfill, a split adjustment or a restated FX rate can all change what that day's price row says
afterwards — and the question is what the reader was told at the time.

**Direction is recorded where the app knows it, and not invented where it does not.**
`dip_from_avg_cost` and the algorithm's alert argue for buying; `gain_from_avg_cost` and
`drop_from_high` argue for selling. The three level rules are `watch`: "TSLA above 350" is a buy
signal for one person and a sell target for the next, the app was never told which, and a log
whose whole value is that it does not invent anything should not start there. A `watch` event
counts a trade in either direction as having acted.

**`algo_alert_log` is superseded and carried forward, not abandoned.** The migration copies any
rows it holds into `alert_events` on every boot, matched on (user, ticker, fired_at) so it is
safe to repeat. Without that carry-forward the algorithm's cooldown would have read an empty
table on the first boot after this change and could have emailed a holding meant to stay quiet
for another two months. Carried rows arrive as `pending`: the old table recorded that an alert
was raised and never what became of the email. The table itself is kept, unwritten, so a
database restored from an older backup still opens.

**Reading it back.** `alert-log.js` has `followThrough()` — did a trade in the same holding, in
the direction the alert argued for, land inside the window — and `summariseFollowThrough()` for
the rate by alert type. The matching is done in JavaScript rather than SQL on purpose: the rule
is a judgment and it should be readable by whoever wants to argue with it.
`node alert-followthrough.js [--days 60] [--all] [--list]` prints it; the script is read-only
and guarded with `require.main === module`.

**Three caveats that belong wherever a number from this is quoted.** A purchase after a buy
alert is correlation, never cause — the reader may have been buying that week regardless. A
transaction's `ts` is the trade date the user typed, so it can predate the alert it appears to
answer. And `watch` rules count a trade in either direction, so their rate is not comparable
with a dip's. With a handful of events per type this is a description of what happened, not a
measurement of whether alerts work. The log starts empty on 2026-09-17; there is no history to
backfill, because none was ever kept.

Covered by `test/alert-log.test.js` (13 tests), and the Algorithm tab's timeline now reads
`alert_events` — an alert the mailer refused shows there as *Alert raised, email not sent*
rather than silently looking like an email that arrived.

### 👁 A watchlist — following what you do not own — 2026-09-18

Stocks can now be followed without being bought: candidates to buy, or positions that have been
sold and are still worth hearing about. They get prices daily and **the same four alert rules a
holding gets**, on a sixth tab.

**The feature was already half-present, and the missing half failed silently.** `POST /api/alerts`
never checked that the ticker meant anything to the person asking — only the UI's dropdown did, by
being filled from holdings. Anything else was accepted, stored, and listed as enabled, while the
daily job fetched prices only for tickers somebody held. An alert on an unowned stock could never
fire and nothing said so. No such alert existed when this was found; the endpoint now refuses one.

**A dip needs something to measure from.** Dip and Target are defined against average cost, and a
stock you never bought has none. Rather than deny those two rules to a watched stock, the watchlist
records a **reference price** and `reference-price.js` resolves which number applies:

| Watched how | `reference_source` | The number |
|---|---|---|
| Added from the form | `spotted` | its price that day |
| Typed by hand | `typed` | whatever you said |
| Carried from a closed position | `carried` | the average cost you actually paid |

**Holdings always win.** A stock both held and watched resolves to its cost basis and never looks
at the watchlist. That ordering is the safety property of the whole change — it is why shipping it
could not restate anybody's live alerts, and it was checked against the real database before
release: all twelve existing cost-based alerts resolved to exactly the same number. Do not invert
it, and do not add a "prefer the watchlist" option: two answers to one question is how the average
cost calculation went wrong before.

`basis` travels with the number into `alert_events.detail`, because `avg_cost_eur` now holds a cost
basis for some rows and a watch price for others, and `alert-followthrough.js` would otherwise
report "25% under what you paid" for a stock that was never bought.

**Selling the last share offers to keep watching it.** That was where a ticker used to quietly
leave the app. The offer is made by the server on the transaction that empties the position; the
figure is recomputed from the history by `lastHeldAvgCost()` rather than taken from the browser,
because the offer can be accepted later and a number the client sends is a number the client could
have changed.

**Adding a ticker validates it by backfilling it.** Every ticker until now arrived on a transaction
somebody really made, so a typo corrected itself; `TICKER_RE` only says "1–12 characters", and
`GOOG` for `GOOGL` passes it happily. Asking Yahoo for two years of history proves the symbol is
real *and* stops the Trailing rule being silently dead for its first year — it needs 365 days.
History already deep enough is left alone rather than re-fetched, which is the normal case for a
stock arriving from a closed position.

One trap found by testing rather than reasoning: `backfillTicker` reports `added: 0` both when Yahoo
has no such symbol **and** when every bar was skipped for want of an exchange rate to convert it to
euros. Conflating them told a tester that AMD was not a ticker. They are now separate answers, and
`test/http.test.js` pins that a valid ticker is never reported as non-existent.

Covered by `test/watchlist.test.js` (17) and thirteen HTTP tests against a real server; 161 tests in
all. Checked in light, dark and at 390px.

### 📉 The watchlist chart — 2026-09-18

The Watchlist tab draws the stock it is showing: price history, the reference a dip is measured
from as a dashed line, and every alert on it as its own line, with markers on the days each rule
**crossed** into firing.

It is not a second chart. The Alerts tab's map already drew exactly this for a holding, so the
renderer was parameterised over an element-id prefix and its own selection, and mounted twice —
`MAPS.am` and `MAPS.wm`. Writing a second one would have been a second copy of two hundred lines
that answer the same question, and this codebase already has a file (`portfolio.js`) that exists
because two copies of one calculation drifted apart.

The dashed line is the reference, resolved with the same precedence as everywhere else: a
holding's average cost if there is one, otherwise the watch price, labelled *Avg cost*, *What you
paid*, *Your reference* or *Price when added* so it never claims you bought something you did not.

**A stock that listed recently does not have a 52-week high, and nothing used to say so.**
`recentHigh()` takes the highest close inside its 365-day window and reports it whatever the
window actually contains. Every ticker used to arrive on a transaction, so there were always years
behind it; a watchlist can hold something that listed last quarter, and a Trailing rule on it
measures off a three-month high while calling itself *off 52w high*. `GET /api/watchlist` now
returns `historyDays` and `historyShort`, and the row says "3m history" when it is short. Found by
reading a real watchlist entry, not by reasoning about the code.

**How much history is enough is the chart's question, not a rule's.** The period buttons go
3M / 6M / 1Y / 2Y, so two years is the longest fixed span the chart can be asked to draw, and that
is what `WATCH_HISTORY_DAYS` is. It was briefly `HIGH_WINDOW_DAYS` — the trailing rule's 365 — and
the two answer different questions: a stock with 400 days looked deep enough to skip the backfill,
after which pressing **2Y** drew a 400-day line and said nothing about the other 330. The backfill
depth, the skip test and the short flag all read the one constant now, and the chart says
*"2Y is more history than there is"* with the date the prices start when a button reaches past
them. **All** is exempt — it means "everything there is", so it is honest at any depth.

### ⏱️ Two timers, one job — 2026-09-18

Two systemd timers were running `price-fetch.js` every day: `price-fetch.timer` at 09:00 local and
`portfolio-price-fetch.timer` at 09:00 UTC, which is 10:00 WEST in summer. Both ran the whole job —
fetch, store, evaluate, mail — so every day's prices were fetched twice, the second run restating
the first with a later quote, and the run report was mailed twice. The alert digest escaped going
out twice only because of the 24h per-alert throttle. That is a safety net catching a mistake, not
a design.

`price-fetch.timer` was the stray. It was created during the Sept 7 consolidation and never cleaned
up, and it never received either fix the other unit was deliberately given: `DB_PATH` was left
implicit, and its `StartLimitInterval` / `StartLimitBurst` sat in `[Service]` under the pre-229
names, where systemd ignores them — so the retry cap described above was never actually in force on
that unit. Every mention in this README, in `DEPLOYMENT.md`, and in `check-job-health.js`'s own
diagnostics already names `portfolio-price-fetch`.

So `portfolio-price-fetch` survives, and it took the two things the stray had that were better:

| | was | now |
|---|---|---|
| `OnCalendar` | `09:00:00 UTC` | `09:00:00` (local) |
| `OnBootSec` | — | `5min` |

Local time holds the same wall-clock slot across DST instead of sliding an hour every summer, and
it is the slot the alert digest already arrived in — so nothing changes for a reader except the
duplicate run report stopping. It stays inside the safe market-hours window at either offset (see
*Scheduled Tasks*). `OnBootSec=5min` catches up a run missed to a reboot. `price-fetch.timer` and
`price-fetch.service` were disabled and deleted.

### 🧮 A stock split is not a purchase — 2026-09-18

An eleven-year transaction history was imported into an account that had held eighteen months of
it, and the figures under the chart came back **upside down**: invested capital **€103,956**
against a market value of **€103,140**, a **149% gain rendered as a 0.8% loss**.

Two defects, and the same shape twice: a cost that was already known and not used.

**1. The browser estimated a number the API sends it.** `app.js` mapped every holding to
`[idx, quantity, marketValue, null]`, discarding the `amount` beside it — the euros that actually
went in. With the return % null, the invested-capital estimator falls back to *"a quantity increase
means a purchase at today's price"*. **A stock split is a quantity increase:**

| snapshot | position | booked as invested |
|---|---|--:|
| 2020-08-31 | 8 → 40 shares (5-for-1) | €13,356 |
| 2022-08-25 | 68 → 204 shares (3-for-1) | €40,381 |

**€53,738 of capital that was never invested.** The same fallback never subtracts on a sale, so
**€14,251** of proceeds stayed in the cost as well. One holding read €85,265 invested against a
true €22,513.

The fix is not a better estimate — it is to stop estimating. The transform derives the return from
`amount`, which takes the exact path (`cb = v / (1 + rt/100)`) that already existed for hand-entered
snapshots. A holding whose sales exceed its purchases has no positive cost to measure against and
stays null rather than inventing one. **Both fallbacks remain for snapshots typed in by hand, and
both are commented with what they cannot see** — neither knows a split from a purchase.

**2. `/api/snapshots` counted closed positions in `costBasis`.** For a position long since sold,
`totalAmount` is proceeds minus purchases — a realised gain arriving as *negative cost*. Two closed
holdings were moving the figure beside the market value by **€175.87**. The holdings array
immediately above it already filtered on `qty > 0`; the cost basis now does too.

**Why it took eleven years of history to show up.** The account had no pre-split transactions and
no closed positions until the import. Neither bug was dormant by luck — both needed data the app
had never been given. *A feature that has only ever seen one shape of data has not been tested.*

**How it was verified with no browser available.** Minting a session cookie to screenshot a
logged-in page is refused by this sandbox, so: all **4,105 daily snapshots** were rebuilt offline
exactly as `server.js` builds them, the replication was checked against figures computed
independently from the transactions (market value and cost basis both matching to the cent), and
the client's own estimator was then run over the result. Every holding's invested capital now
agrees with its transactions. `test/http.test.js` pins the server half and **was seen to fail
without it**. The remaining step — reading the page — was done by the user, which is also how the
wrong figures were noticed in the first place.

### 📥 Import from a broker file — 2026-09-23

Until today there was one way to get a transaction into this app: type it. That is why eleven
years of history went in by hand, and why it went in without anything reusable to show for it.
There is now a **CSV import** in the *Register transaction* card on the Transactions tab, under
the form and beside the transaction list — the two ways of registering a trade in one place:
choose a file, confirm what the app read, import. `csv-import.js` (the reader), `POST /api/transactions/import`, `POST
/api/import/check`, `GET /api/securities/lookup`, and 34 tests across `test/csv-import.test.js`
and `test/import-api.test.js`.

**The file is read in the browser and never uploaded.** `csv-import.js` is loaded by the page
and by node — the same code the tests exercise is the code that reads your statement — and the
only thing that reaches the server is the list of rows confirmed on the preview. This is not a
privacy gesture bolted on afterwards: it removes the upload endpoint, the multipart dependency,
the 64kb body limit and the promise to delete a file afterwards, because there is no file here
to delete.

**Four decisions were taken before anything was written**, and each one is visible in the code:

| Decision | What it means |
|---|---|
| Cost basis is **price × quantity** | Fees and commission are not in `amount_eur`. Where a file has no price column the price is derived from the total, and the preview says so on that row, because the fee is still inside it |
| A security is resolved by **ISIN, confirmed once** | Yahoo answers, a person confirms, and the answer is remembered per user in `security_map`. The second import from the same broker asks nothing |
| Re-imports are caught by **`import_key`** | And an import is undoable in one action through `import_batch_id` |
| **EUR and USD only** | They are the only currencies with stored rates. A GBP row is listed as skipped with that as the reason, rather than converted at a guess |

**Why the ticker is confirmed and not accepted.** Yahoo's first answer for "Volkswagen AG" is
`VOW3.DE`. The position actually held in this database is `VOW.DE` — a different share class,
a different price, and a silent corruption of the portfolio if a machine picks it. ISIN lookups
are exact (`NL0010273215` → `ASML.AS`, `US88160R1014` → `TSLA`) and still go past a person once.

**What the preview refuses to do quietly.** Every row that will not be imported is listed with
the line number and the reason — dividends, deposits, fees, transfers, splits, a currency with
no rate, an unreadable date. The app stores buys and sells and has nowhere to put a dividend;
importing one as a purchase is the same shape as the split-as-purchase bug above, which took a
day to find. Refusing and saying so is the safe failure.

**The price check, and why its threshold is loose.** `POST /api/import/check` compares each
row's price against the stored close for that ticker on that date, and flags anything more than
**20%** away. Two things make this less obvious than it sounds. `prices` holds Yahoo's
split-adjusted history while a transaction holds what was actually paid — TSLA's 2015 close
reads 17.68 in one and 265.92 in the other, both correct — so the close is scaled back up by
every split since the trade date before the comparison. And the threshold has to be generous:
measured against this account's own 49 hand-typed rows, the honest spread against the close runs
from −38% to +27%, because trades fill intraday and because rights issues and unrecorded splits
move it further. A tight bound would cry wolf on ordinary rows and teach the reader to click
past the warning that matters. What it does catch is the failure modes that are quiet: a decimal
comma read as a thousands separator, a total mapped into the price column, a pre-split quantity
against a post-split price.

**Rates are read backwards, never forwards.** The euro amount uses the last rate on or before
the trade date. Trades land on days the rate table skips — weekends, holidays, and 363 weekdays
in this database that simply have no row — so an exact-date lookup would reject ordinary trades.
A date earlier than the table itself (it starts 2015-04-30) is refused rather than converted at
the oldest rate we happen to hold.

**Two columns, one table, one partial index.** `transactions` gained `import_batch_id` and
`import_key`; `security_map` holds the confirmed ISIN → ticker choices. The uniqueness on
`import_key` is partial — `WHERE import_key IS NOT NULL` — because every hand-typed transaction
has a NULL key, and a plain UNIQUE index would allow exactly one of them per user.

**Limits.** 500 rows per import, refused rather than truncated. One JSON body limit of 1MB for
this endpoint alone, chosen per path so raising it does not widen every other endpoint. The whole
batch is one SQLite transaction: a half-applied import is the worst outcome available, because
the obvious response to it — upload the file again — doubles everything that did land. Price
history for a new ticker is backfilled one ticker at a time, as far back as that holding's own
oldest imported trade, because firing six ten-year requests at Yahoo at once is how an IP gets
throttled and the daily job everything depends on breaks.

**Not covered, deliberately:** `.xlsx` (save as CSV — a parser dependency for a format every
broker also exports as CSV), currencies beyond EUR and USD, fees, and corporate actions. A split
row in a file is flagged and skipped, not applied; `stock_splits` is still maintained by hand.

### ⏳ Open Items / Backlog

**Two writers disagree about what a price's date means — measured 2026-09-18, not fixed.**

`price-fetch.js` runs at 09:00 local, before the US session it is reporting on has opened, so the
close it fetches belongs to the *previous* session — and it stores it under **the date the job
ran**. `backfill-history.js` stores each bar under **its own trading date**. Both are reasonable in
isolation; together they put the same close on two different dates.

Checked against Yahoo the same afternoon:

| ticker | row | holds | |
|---|---|---|---|
| ORCL | 2026-09-16 | the 09-15 close | a day late |
| ORCL | 2026-09-17 | the 09-16 close | a day late |
| ORCL | 2026-09-18 | the 09-17 close | a day late |
| TSLA | 2026-09-17 | the 09-17 close | on its own date |

TSLA reads correctly only because a backfill that morning rewrote its recent rows; ORCL was left
alone and still carries the job's dating. **So the two conventions now coexist inside one
portfolio, and two holdings on the same chart can be a session apart.**

**What it does and does not break.** Every total, average cost, gain and alert is computed from the
*latest* price, so none of them is wrong — the newest row is the newest close whatever it is called.
What is wrong is anything read *by date*: comparing a point on the chart against an external chart,
or reading two holdings against each other across a day the job ran.

**A second, smaller thing the same morning:** a backfill run while a market is open writes that
day's *intraday* price as though it were a close. TSLA's 09-18 row holds 363.525 against a 363.60
close. Harmless once the next day's row lands, but it is not a close and is labelled as one.

**The fix is a decision plus a migration**, which is why it is here and not done: settle on the
bar's own trading date, have `price-fetch.js` date each close by the session it belongs to rather
than by the clock, re-date the rows the job has already written, and refuse to write a bar for a
market that is still open. Doing that carelessly would restate history, so it wants its own change
with its own before-and-after — not a line slipped into an import.

**Support address is a gmail one — change it when the new domain is in place.** The app already
*sends* from `singleuseapps.com` (`ALERT_EMAIL_FROM`, `AUTH_EMAIL_FROM` in `.env`); what is still
a personal gmail is the address a reader is *given* to write to, and the inbox that receives.
Six places publish it and two `.env` keys point at it:

| Where | What |
|---|---|
| `index.html:1584` | the app footer |
| `index.html:1129` | the landing-page footer |
| `privacy.html:93`, `privacy.html:108` | the deletion request and the contact block |
| `terms.html:83` | the contact block |
| `contact.js:177` | the fallback shown when the contact form fails to send |
| `.env` → `CONTACT_EMAIL_TO` | where the contact form delivers |
| `.env` → `OPS_EMAIL_TO` | where job-health and backup mail go — worth keeping separate from the above, so machine noise and people asking for help do not share an inbox |

Blocked on the domain, not on the work: it is one `grep -rn singleuseapp@gmail.com` and two `.env`
edits, plus a `pm2 restart portfolio-api` for the `.env` change to be read. Privacy Policy and
Terms both name the address as the contact of record, so changing it is a change to a published
document — worth a line in each saying when it changed.

**~~The systemd unit still names the pre-split database~~ — fixed 2026-09-15.**

`/etc/systemd/system/portfolio-price-fetch.service` sets
`Environment="DB_PATH=/var/www/portfoliotracker/data.db"`. After the split that is the dead
file, and the job would have gone on succeeding every morning while writing prices nothing
reads — no error, no alert, just a portfolio that quietly stopped moving.

`price-fetch.js` now guards against it: if the configured database still has a `users` table it
is pre-split, so the job uses `portfolio.db` beside it and says so loudly. Tested, and pinned by
`test/fetch-cadence.test.js`.

The unit now names `portfolio.db`, and `StartLimitIntervalSec=1h` / `StartLimitBurst=3` were
added at the same time so a failing job gives up after three attempts instead of retrying every
thirty seconds for ever. The guard below stays as a safety net. For reference, the fix was:

```
sudo sed -i 's|DB_PATH=/var/www/portfoliotracker/data.db|DB_PATH=/var/www/portfoliotracker/portfolio.db|' \
  /etc/systemd/system/portfolio-price-fetch.service
sudo systemctl daemon-reload
```

Until then, watch the first run after the split — the warning appears in the job log and in the
daily run report.


**Detrending the algorithm — proposed, tested, and rejected (2026-09-14).**

The recommendation on 2026-09-13 was to rank the *deviation from a moving average* rather than
the price level, to cure the sell side reading high for any stock in a long climb (44% of days
across these holdings, 76% for NVDA). **Measured, it is the wrong change.** Balance improves
exactly as predicted; the discriminating power collapses with it:

| Variant | %Sell | %Buy | mean top-vs-bottom-fifth spread | positive in |
|---|---|---|---|---|
| price level (shipping) | 44% | 27% | **+9.9%** | 8/10 |
| deviation, 50-day | 21% | 31% | −0.1% | 5/10 |
| deviation, 100-day | 22% | 38% | +0.1% | 8/10 |
| deviation, 200-day | 23% | 44% | +2.2% | 7/10 |
| deviation, 300-day | 24% | 44% | +2.7% | 6/10 |

Monotonic: the more trend you remove, the more balanced *and* the more useless. **The bias is
where the signal was coming from.** What the score detects is closer to trend than to mean
reversion, however much its construction suggests otherwise.

So the tab now says this in its own methodology rather than the code pretending otherwise. Do
not re-propose detrending without beating +9.9% here first. Re-run with
`node backtest.js`-style within-stock quintile spreads; the throwaway harness used for this is
not kept, deliberately — it should be rebuilt against whatever the data looks like then.


**pm2 stays in fork mode — cluster was tried and reverted (2026-09-14).**

Two workers were added on 2026-09-13 and taken out again a day later, because **pm2's file
watcher does not fire in cluster mode**. Measured: after switching, editing `server.js`
changed nothing until `pm2 reload` was run by hand — and "editing a file on the server *is*
deploying it" is how this project is operated everywhere else. A silent no-op deploy is a
worse failure than a slow one.

It was also worth much less than expected once the caching landed: the same 20-request burst
took **160ms on two workers and 182ms on one**. The cache had already done the work; the
second process was buying 12%. Revisit if real concurrent load ever appears, and if so change
the deployment model deliberately rather than inheriting a broken watcher.


**Fetch cadence by demand — built 2026-09-14.**

Every held ticker used to be fetched every weekday whether or not anybody was in a position to
read the answer. Now each one is classified per run:

| Tier | Test | What happens |
|---|---|---|
| Hot | a holder seen within `HOT_SEEN_DAYS` (7), **or** any enabled alert on it | quote today, or one ranged request if days are missing |
| Cold | anything else | one ranged request if `COLD_INTERVAL_DAYS` (7) have passed, otherwise nothing |

**No history is lost by waiting.** Yahoo's chart endpoint is range-based — one request covering
a week returns every trading day in it — so a cold ticker costs a fifth of the requests and
still ends up with a complete daily series. The only thing traded away is how quickly a signal
is noticed, and a ticker with an alert on it is never cold, so nothing that emails anybody is
delayed.

**Two traps, both now pinned by tests.** An alert exists for somebody who is *not* logging in,
so dormancy must never be allowed to silence it — that is why an enabled alert forces daily. And
the Algorithm tab's alert is on by default for every account, so counting it would make every
ticker hot and the rule a no-op; it deliberately does not count. `test/fetch-cadence.test.js`
fails if either is broken, verified by breaking them.

A hot ticker that is more than a day behind also gets the ranged treatment rather than a quote,
because a quote only ever writes *today* — it would leave a hole in the history for ever.

**Ticker cap — 50 per account (2026-09-14).** Every ticker anybody holds costs a fetch every
weekday for ever, paid by the server rather than by the account that added it. Fifty is far
above any real portfolio and far below anything that hurts. It applies only to *new* tickers, so
selling out and buying back always works, and the refusal points at the Support link — it is a
limit on cost, not a rule about how anyone should invest.

**Escaping aligned (2026-09-14).** The browser's `esc()` covered three characters where the
server's `escapeHtml()` covers five. Safe as used, but two escapers with two definitions is the
actual defect; there is now one definition in two places.

**~~Edge rate limiting — written, not applied~~ — applied, verified 2026-09-18.**
`/etc/nginx/conf.d/portfoliotracker-limits.conf` declares `pt_req` (10r/s) and `pt_conn`, and
both `location /portfoliotracker/` and `location /portfoliotracker/api/` in
`sites-enabled/singleuseapps-com` use them (`limit_req … burst=40 nodelay`, `limit_conn pt_conn
20`, both answering 429). `nginx-rate-limit.conf.example` stays as the reasoning and the copy
this repository can see — **the live files are not in git**, so `diff` them the way
`deploy/systemd/README.md` says to diff the units. This is what the app's own limiters cannot
reach: the ~280KB of static files served to anyone with no account at all.

**Personal and financial data are now separate files (done 2026-09-14).**

`identity.db` holds the email addresses, the sessions and the login tokens. `portfolio.db`
holds everything anybody owns. They are joined by an **opaque random key**, never by an
address — `split-databases.js` did the migration and explains why a hash of the email would
have been the wrong answer: addresses are guessable, so a hash of one can be tested against
every row until it matches.

**What made this a small change rather than a rewrite:** `req.userId` *is* the key. Every
`WHERE user_id = ?` on the financial side kept working; the value simply became a string.
Only the fifteen places that genuinely touch identity had to move.

**Where the line runs.**

| identity.db | portfolio.db |
|---|---|
| users (email, `user_key`, `last_seen_at`) | transactions, alerts, `user_settings` |
| sessions, login_tokens | algo_alert_log, algo_settings_log |
| | prices, exchange_rates, stock_splits, job_runs, data_version |

The algorithm's two timings moved from columns on `users` into `user_settings` on the
financial side: they are preferences about alerting, not identity.

**Four joins had to become two lookups.** The alert digest, the weekly standings, the
algorithm's alert and the fetch-cadence tier all needed "who is this and what is their
address". They now read the rows on one side and resolve `key → email` on the other, in
memory, one direction only. `emailsByKey()` in `price-fetch.js` is the only crossing point.

**What it buys, and what it does not.** A leak of one file is no longer a leak of both — the
accident of 2026-09-11, when the whole directory was briefly served over HTTPS, would have
exposed holdings with nobody's name on them. Deleting a person is one row, and what remains is
already anonymous. It is **no defence against losing the server**: both files sit on the same
disk, in the same backup, under the same passphrase.

**Everything downstream had to follow, and three things nearly did not:**

- **`price-fetch.js` hardcoded `data.db`** and ignored `DB_PATH` entirely. The daily job would
  have cheerfully written tomorrow's prices into the dead file.
- **`verify-portfolio.js`, `recompute-eur.js` and `backfill-history.js`** defaulted to `data.db`
  and never loaded `.env`, so they were reading the pre-split database and reporting on it.
- **`.env` still said `DB_PATH=./data.db`**, so for a few minutes the new code ran against the
  old data and showed an empty portfolio.

**Backups cover both, as one object.** `backup-db.sh` snapshots each file and verifies each
against what it is supposed to contain; pruning is per-file, because pooling them would let a
run of portfolio snapshots push every identity snapshot past the "keep at least one" guard.
`backup-offsite.sh` tars the pair *before* encrypting, so a restore can never end up with a
mismatched pair from different weeks, and it refuses to ship an archive that does not hold
exactly two files.

**Rollback:** `data.db` is untouched and still holds everything as it was. Point `DB_PATH` back
at it, restart, and the app is exactly where it was before the split.

**Load and denial of service — audited 2026-09-13, partly fixed.**

*What was measured, not assumed:* `better-sqlite3` is synchronous and Node is one thread, so an
expensive endpoint blocks **every** other request, not just its own caller. Twenty concurrent
`/api/snapshots` took 966ms and made an unrelated trivial request **19x slower — 51ms to
950ms**. At roughly 48ms of blocking CPU per call, about 20 requests a second makes the site
unresponsive for everyone, and one account is enough to do it.

*Fixed now:* a blanket limit on `/api` (600 per 5 min per IP), a tighter one on the two
expensive views (`/api/snapshots`, `/api/algorithm` — 120 per 5 min), and a strict one on
`/api/backfill` (20/hour), which reaches out to Yahoo and writes unbounded rows into the shared
price table on every call. `/api/backfill` also accepted **any string as a ticker** and passed
it to Yahoo; it now validates like every other endpoint. `trust proxy` is set, so limits key on
the real client rather than on nginx.

*Where this stands, re-checked 2026-09-18:*
1. ~~**No limit in nginx.**~~ **Done.** `limit_req`/`limit_conn` are live on both
   `/portfoliotracker/` locations — see *Edge rate limiting* under Open Items.
2. ~~**`/app.js` and `/` are public and unlimited.**~~ **Covered by the same limits**, which sit
   on the static location and not only on `/api`. The bytes are unchanged; what is capped now is
   how fast one address can ask for them.
3. ~~**`/api/snapshots` recomputes the whole series per request.**~~ **Cached since `e6c6dbc`
   (2026-09-13)** — `BoundedCache(40)` in `server.js`, keyed by `userId` + the database-wide
   version counter, so an entry is served only while nothing has been written. `/api/algorithm`
   has the same treatment per ticker.
4. **Open registration** remains open, and remains the multiplier: every authenticated limit
   above assumes getting an account is meaningful, and right now signing in *is* registering.


**Donations — widget built 2026-09-14, NOT yet able to take money.**

A *Support this tool* section above the footer: three fixed amounts (2€ / 5€ / 10€), a
**Donate** button, no email asked for. Modelled on the DupSweep buy widget, but deliberately
not that widget with the price changed — buying a licence needs a name and an email because
something must be delivered; a donation delivers nothing, so collecting either would be
holding personal data for no reason. Stripe still takes an email on its own form for the
receipt; that is Stripe's record and none of it comes back here.

**Three files, only one of them in this repository:**

| File | Where | What |
|---|---|---|
| `index.html`, `server.js` | this repo | the section, and the CSP hosts it needs |
| `donate-widget.js` | `/var/www/singleuseapps-com/` | the shared widget (**new**) |
| `src/routes/donation.js`, `src/routes/webhook.js`, `src/server.js` | `/var/www/license-service/` | the checkout endpoint and a webhook guard |

**~~Neither of those two directories is a git repository~~ — both are, since 2026-09-17**
(`singleuseapps-com` at `713348a`, `license-service` at `c8066ae`; both private on GitHub, both
clean and in sync, checked 2026-09-18). Only `.env.example` is tracked in either — no `.env`, no
keys. What is still outside git is nginx (see *Edge rate limiting*) and the cron entries.

**It cannot take money yet, for reasons that have nothing to do with this app:**

1. ~~**The licence service is stopped and nginx has no `/api` route.**~~ **Fixed — checked
   2026-09-18:** `license-service` is online in pm2 and `POST /api/checkout/donation` answers
   **400** to an empty body, which is the route replying rather than nginx 404ing. DupSweep's
   buy widget can reach its endpoint again too.
2. **Stripe is in test mode** — the only blocker left. No `sk_live` key is present in the
   service's `.env`. Real cards will not work until live keys are set there and in the
   publishable key inside both widgets.

Until then the section fails *visibly* rather than silently — clicking Donate shows "Could not
start checkout" and re-enables the button. A donation that fails quietly is worse than one
refused: the giver believes they have helped and has no idea they have not.

**Two things guarded on the way in.** The amounts are enforced **server-side** — a price the
page can choose is a price anyone can choose — and the webhook now **skips donation sessions**.
Without that it would have called `issueKey` with no `appId`, thrown, returned 500, and Stripe
would have retried the same donation for days.

**CSP had to widen**, exactly as predicted when this was only a backlog note: embedded checkout
needs `script-src` for `singleuseapps.com` and `js.stripe.com`, `connect-src` for the API and
`api.stripe.com`, and a new `frame-src` for Stripe's iframe. Named hosts only, no wildcards,
and `'unsafe-inline'` stays out. A plain link to a hosted payment page would have needed none
of it — that trade is now made rather than theoretical.

**Algorithm alerts — built 2026-09-13.** `algo-alerts.js`, tests in `test/algo-alerts.test.js`.

They are deliberately *not* rows in `alerts`. That table is the one the user builds by hand
and may empty at will; the algorithm's alert is fixed behaviour covering every holding at
once. Mixing them would invite editing the thing that is meant not to be edited, and would
let "delete all my alerts" silently switch the algorithm off.

**It emails about exactly one thing: a holding reading very strong buy.** Not configurable —
that is a claim about the signal, not a preference. The user owns two timings, both about
volume rather than meaning, and both live on the Algorithm tab beside the explanation:
`algo_hold_days` (consecutive readings before it counts, default 3) and `algo_cooldown_days`
(how long that holding then stays quiet, default 60). `PUT /api/algorithm/settings`.

**There is no sell alert, and that is a decision rather than an omission.** Measured over the
current holdings: the sell side is on **39% of all days**, and **76%** for NVDA — whose sell
days were followed by **+13.8% over the next 60**. An alert that is usually true and loudest
where it is most wrong trains its reader to ignore the inbox, and would take the hand-built
alerts' credibility with it. Selling is the target rule's job: it fires off the user's own
cost basis, so it genuinely happens once.

*Two measurements shaped the design and are worth not rediscovering:*

1. **A stricter tier does not mean fewer emails — it means more.** Inside one long sell
   stretch a higher bar keeps lapsing and re-arming, so the stretch fragments. NVDA: 572 sell
   days → 29 entries at Signal+, but **41** at Strong+. Frequency is controlled by the
   cooldown, not the threshold.
2. **The position gate filters nothing on the sell side.** A portfolio this far ahead (AMD
   +156%, ASML +110%) clears a 20–30% profit bar automatically; all three live sell signals
   passed it.

**Everything is on a timeline.** Two logs feed a third lane under the main chart:
`algo_alert_log` (every email this algorithm sent about that holding) and
`algo_settings_log` (every change to the two timings, with the value it had before).
`GET /api/algorithm` returns them merged as `events`, and the chart draws a green pin per
email and a grey tick per settings change, with the detail in the hover.

The settings log matters more than it looks. Without it, a chart showing "it emailed here,
and not there" is unreadable, because the usual reason for the gap is that the rules changed
in between and nothing recorded it. Only real changes are written — re-selecting what is
already selected is not an event, and a timeline full of those is one nobody reads. A
settings change is account-wide rather than per holding, so it appears on every stock's
timeline; the label says so, because the difference would otherwise have to be guessed.

**The weekly standings** ride in the same digest every Monday — one line per holding that is
not silent, both directions, sent whether or not anything fired. It is the only place the
sell side appears, and a summary cannot spam because nothing triggers it. Subject and heading
change to "Where things stand" when nothing else is in the email.

Implementation notes worth keeping: `fired_at` is stamped from the **injected clock**, not
`CURRENT_TIMESTAMP`, so the function is deterministic under test — the same principle as
`areMarketsClosedForFetch(when)`. A price file older than `MAX_PRICE_AGE_DAYS` (5) is not
scored at all, which also means a cooldown shorter than that cannot be observed without the
prices moving too. `test/helpers.js` gained `migratedDb()` because `schema.sqlite.sql` alone
lacks anything added by an ALTER, `prices.price_native` included.

**Testing — 200 tests, in CI since 2026-09-12.**

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
  removed. Parked again on 2026-09-16, this time with the shape agreed: an upload box under the
  register form, the file read by a model, the extracted rows shown for confirmation, registered
  on approval and **the file deleted from the server**, editable afterwards like any other
  transaction. It needs `ANTHROPIC_API_KEY` in `.env` (there is none) and the SDK (not
  installed), and each upload costs real money. Do not build it without asking.

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

### 🧮 Algorithm tab — the position-timing signal

Built from a written specification (2026-09-12). `algorithm.js` holds the rules, all pure
functions of a price array; `/api/algorithm` serves them; the Algorithm tab draws them.
`test/algorithm.test.js` pins every threshold — they look arbitrary because they were
*chosen*, so a retune must break a test rather than change meaning silently.

**The rules.** Each day's close is given a percentile rank inside three trailing windows —
6 months, 1 year, 2 years (calendar days: 182 / 365 / 730, the window open at the far end
and closed at the near one). A rank of ≥95 is StrongHigh, ≥80 High, ≤20 Low, ≤5 StrongLow,
anything else Neutral; Strong counts 2, plain 1. Two lanes then read the same regimes with
different bars: **Sell needs two of three windows in both lanes; Buy needs two in the
Confirmed lane but only one in the Early lane.** Confidence is the agreeing weight over the
maximum possible (2 × 3 = 6) → Watch / Signal / Strong / Very Strong at 25 / 50 / 75%.

The Buy asymmetry is the point of running two lanes. A sentiment-driven dip shows up in the
6-month window while the 1- and 2-year windows are still anchored to the prior run-up and
read Neutral the whole way down — the spec cites a ~14% drawdown missed entirely by a
2-of-3 Buy rule. The Early lane catches those; the Confirmed lane says whether anything
broader agrees.

**A 5-year window was specified as tried and rejected** — it sat High 88% of the time and
never reached Low, biasing everything toward Sell. Do not add one back without redoing that
test.

**Where this deviates from the spec, and why:**

| Spec says | Here | Why |
|---|---|---|
| Use Adjusted Close | `prices.price_native` | Yahoo's `chart()` close is already **split**-adjusted (verified across TSLA's 2022 3:1 — no discontinuity). It is not dividend-adjusted. Storing a dividend-adjusted price would misstate portfolio value, which is the same column's day job, so the small ranking effect is accepted and recorded here rather than fixed. |
| Pick a market-data API | The existing `prices` table | The data layer was already solved; `backfill-history.js --years 5` filled the depth. No new provider, no new key. |
| Step 6 gate "not yet wired in" | **Wired in** | The spec defers it only because the reference build had no `shares_held` / `avg_cost_basis`. This app has both, from `portfolio.js`. It is applied as a *visual distinction* — the spec's own permitted option — so a flag still shows but reads "position agrees" or "position says wait". The lanes stay purely technical. |
| Prices in `$` | Native currency for ranking, **EUR** for the gate | A stock's stretch must be measured in its own currency or FX moves invent signals; a gain must be measured in euros because euros are what left the account. Same split as everywhere else in this app. |
| Agreement counts hardcoded 2-of-3 | `agreementRules(n)` | The spec asks for this if the window set becomes configurable. Two of three is two-thirds, so that ratio is what generalises; at three windows it returns exactly 2 / 1 / 2. |

**Not implemented, deliberately:** Step 8 position sizing (how many shares to trade) and the
z-score alternative to percentile rank. Both are specified as optional; percentile rank is
what the reference build used and what is here.

**History requirement.** The longest window looks back two years, so a *displayed* day needs
two full years behind it. `backfill-history.js --years 5` was run for all ten holdings on
2026-09-12, taking `prices` from 6,144 to 13,123 rows and giving ~500 displayable days per
ticker. A ticker without that depth returns 409 and the tab says so rather than ranking
against a window it does not have. FX rates only reach back to 2022-04-17, so `price_eur`
for older rows uses the earliest known rate — irrelevant here (ranking uses native, and no
transaction predates 2025-01-30) but worth knowing before trusting old EUR prices.

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

**Series colours belong to the series — 2026-09-15.** The chart used to colour a line by its
position in the selection array: `palette()[selected.indexOf(key)]`. Removing one line then
shifted every line after it up a slot, so a stock changed colour because a *different* stock
was removed, and a colour read off the chart a moment earlier no longer meant the same
holding. Each shown series now holds a slot of its own until it is itself removed. A series
prefers the slot it held last time, falling back to one derived from its fixed position in
`ALL`, so a holding keeps its colour across a remove-and-re-add and across reloads; the
preference is given up only when another shown series already holds that slot, which with
fewer than 17 series never happens.

**Sixteen lines at once, not eight.** The old cap was the palette length, and the palette is
eight because that is how many categorical hues stay tellable apart — both palettes here pass
a lightness/chroma/contrast check and a colour-blindness separation check (protanopia and
deuteranopia, Machado-Oliveira-Fernandes at full severity) that a ninth hue would not. So the
ninth line does not invent a colour: it reuses the first hue and adds a second channel, a
dashed stroke. Eight hues × two dash styles = sixteen unique pairs, which covers ten holdings
plus the three aggregates with room to spare. A third dash style in `DASH` raises it again.

Two details make the dash actually visible, and both are load-bearing:

- **A dashed series thins its point markers** to roughly one every 9px. At a couple of hundred
  closes the 2.4px dots sit closer together than the dash and merge into a solid ribbon,
  hiding the one channel that separates slot 9 from slot 1. The first eight series are
  untouched and still mark every point.
- **The legend, picker and tooltip show a sample of the line**, not a square of colour, so a
  dashed series is identifiable there too. Only `#tip` gets this; the drawdown, alert-map and
  transaction tooltips keep their square keys.

The end-value labels also needed a fix: each one is nudged down to clear the label above it,
and with sixteen of them the tail ran off the bottom of the plot. The lowest is now pinned to
the axis and the stack walks back up from there, which moves only the labels that are in each
other's way.

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

**Note on systemd units:** systemd reads the price-fetch timer/service from
`/etc/systemd/system/`, which is outside this repo. Since 2026-09-18 **copies are tracked in
`deploy/systemd/`**, with install and drift-check commands in `deploy/systemd/README.md`. They are
copies, so they can go stale — the `diff` is the point, not the copy. If the project directory ever
moves again, remember to update `WorkingDirectory`, `DB_PATH`, and `ExecStart` in
`portfolio-price-fetch.service` too — this was missed during the Sept 7 consolidation and caused
a silent ~14h outage of price fetching until caught on Sept 9. The backup and health-check jobs
are cron, not systemd, and `crontab -l` is still their only copy.

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
- `GET /api/algorithm?ticker=X&period=2y` — Position-timing signal: both lanes for every day, notable runs, tile counts, and today's position-gated call
- `GET /api/alerts` — List user's price alerts with current prices
- `POST /api/alerts` — Create alert
- `PUT /api/alerts/:id` — Update alert
- `DELETE /api/alerts/:id` — Remove alert

**Public:**
- `POST /api/contact` — Contact form; emails `CONTACT_EMAIL_TO` with the submitter as reply-to

### 🗓️ Scheduled Tasks

**Price-Fetch (daily at 09:00 local):**
- Fetches closing prices from Yahoo Finance
- Stores in SQLite
- Evaluates price alerts and sends one digest email per user via Resend
- Managed by `portfolio-price-fetch.timer` / `.service` under `/etc/systemd/system/` — the only
  timer for this job since 2026-09-18, when a duplicate was removed
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
- `alert_events` — Every alert actually given, hand-built rule and algorithm alike: who, which
  ticker, which type, what it argued for (`buy`/`sell`/`watch`), the price and threshold at the
  time, and what became of the email (`delivery`). One row per email item, never per day the
  condition held. This is what makes "was it given, and did they follow it" answerable — see
  *A log of every alert given*
- `algo_alert_log` — **superseded by `alert_events`**, kept unwritten so an older backup still
  opens; its rows are carried forward on boot
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
