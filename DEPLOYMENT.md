# Deployment & Operations

Everything runs on one Hetzner VPS, in one directory, as the `deploy` user.
`README.md` describes *what* the app is; this describes *running* it.

| | |
|---|---|
| App directory | `/var/www/portfoliotracker` (git repo, pm2 app and web root are all this one path) |
| Process | pm2 app `portfolio-api` on port 3000 |
| Public URL | https://www.singleuseapps.com/portfoliotracker/ |
| Nginx vhost | `/etc/nginx/sites-available/singleuseapps-com` proxies `/portfoliotracker/` → `localhost:3000` |
| Database | `/var/www/portfoliotracker/portfolio.db` (+ `identity.db`) — **untracked**, backed up nightly |
| Repo | `luisdanielsilva/portfoliotracker` — **private, and must stay private** |

---

## Deploying a change

There is no build step and no separate staging copy. Editing a file here *is* deploying.

```bash
cd /var/www/portfoliotracker
# edit, then:
git add <files> && git commit && git push
```

**What restarts by itself:** pm2 watches `server.js`, `schema.sqlite.sql` and `.env`, so saving
any of those restarts the app within a second or two. Nothing to do.

**What does not:** `index.html`, `privacy.html` and `terms.html` are served statically, so a
browser refresh is enough — deliberately not watched, to avoid bouncing the process on every
frontend edit. `price-fetch.js` and `check-job-health.js` are run fresh by their schedules, so
they simply use the new code next run.

**Before pushing, always confirm the repo is still private:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.github.com/repos/luisdanielsilva/portfoliotracker
# 404 = private (correct).  200 = PUBLIC — stop and fix before pushing.
```

The database is untracked now, but git history still contains earlier user data.

---

## Checking it is healthy

```bash
pm2 list                                   # portfolio-api should be "online"
pm2 logs portfolio-api --lines 50          # app errors
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/auth/config   # expect 200
systemctl list-timers portfolio-price-fetch.timer   # EMPTY output = the fetch is not armed
node check-job-health.js --status           # did the daily job actually succeed recently
crontab -l                                  # backup 03:30, health check 13:00
diff -u /etc/systemd/system/portfolio-price-fetch.timer deploy/systemd/portfolio-price-fetch.timer
```

`systemctl list-timers` printing nothing has happened twice and is silent — the app looks
perfectly healthy while prices quietly stop updating.

---

## Rolling back

**Code** — the working tree is the deployment, so:

```bash
git log --oneline -10
git revert <sha>          # preferred: keeps history honest
# or, to inspect an old version without moving the branch:
git stash && git checkout <sha> -- server.js
```

pm2 restarts on `server.js` changing either way. If the app fails to boot, `pm2 logs
portfolio-api` shows the throw; a migration in `server.js` that throws will stop it starting at
all.

**Database** — restore the most recent good snapshot:

```bash
./backup-db.sh --list
./backup-db.sh --restore ~/backups/portfoliotracker/portfolio.db.YYYYMMDD-HHMMSS.gz
pm2 restart portfolio-api      # the app must reopen the file
```

(Identity data restores the same way, from an `identity.db.YYYYMMDD-HHMMSS.gz` snapshot — `restore_backup`
derives the destination from the snapshot's own name, so passing an `identity.db.*` file there is safe and
never touches `portfolio.db`.)

Restore keeps the database it replaced as `portfolio.db.replaced-<timestamp>`, so a wrong restore is
itself reversible. Snapshots are taken with SQLite's online backup API (not `cp`) and are
integrity-checked before they count.

---

## Re-dating price history (`redate-prices.js`, issue #12)

A one-off, not part of a normal deploy — run only when a human has decided to. See *One meaning
for a price's date* in `README.md` for what it fixes.

Every command below pins `--since 2026-08-28` explicitly (S3): `redate-prices.js`'s own default for
`--since` is `MIN(price_date) WHERE source='yahoo_finance'` minus 7 days, and this deploy's job is what
relabels every row it rewrites as `yahoo_finance`. Deploying the new code (step 1) *before* migrating
means that label starts moving the moment the job next runs — a range-path ticker can have a gap of up
to a year, which would pull that `MIN` back and silently widen the window, weakening the OUT-OF-WINDOW
guard against a Yahoo restatement. `2026-08-28` is the value measured when this was written; if a lot of
time has passed, ask whoever last ran this rather than trusting the tool's own default.

1. **Deploy the code first**, and before the next scheduled price-fetch run. The old job re-creates
   a job-dated row the very next morning if it is still the one running — `server.js` also caches
   `backfill-history.js` lazily, so `/api/backfill` and watchlist backfills keep the old code until
   `pm2 restart portfolio-api`. Restart after deploying.
2. **Pick the window: 22:30–07:30 Lisbon, on a Monday–Friday night** (so the US session that just
   closed has one to judge against), and never while the 09:00 timer might be running —
   `systemctl list-timers portfolio-price-fetch.timer` should show nothing due before you finish.
   It must be a weeknight, not a Friday/Saturday or Saturday/Sunday night: over a weekend the
   trailing Friday/weekend rows cannot be bracketed until Monday's close, so the dry run's
   `⚠ ... left untouched because the latest session is not final yet` (the "open edge") fires and
   those rows are simply skipped rather than corrected. In the stated window on a weeknight, expect
   **no** open-edge warning at all; if one appears anyway, re-run once every relevant session has
   actually closed.

   Also run, right before `--apply` (step 4), a direct look at the unit itself — the best-effort
   check inside `redate-prices.js` is not a substitute for looking:
   ```bash
   systemctl status portfolio-price-fetch.service
   ```
3. **Dry run, and read it**:
   ```bash
   cd /var/www/portfoliotracker
   DB_PATH=/var/www/portfoliotracker/portfolio.db node redate-prices.js --since 2026-08-28
   ```
   Review the counts and every changed row with a human before going further. `OUT OF WINDOW`
   entries (if any) mean Yahoo has restated history — stop and decide by hand, do not `--apply`.
   A `DELETE (weekday gap — Yahoo has no bar)` line is not a weekend or a known holiday — it means
   Yahoo has no session at all for a real trading weekday, which is a data gap, not the pattern this
   migration exists to clean up. Review those by hand before applying; do not assume they are safe
   just because they are outnumbered by ordinary weekend/holiday deletes.
   A `⚠ N row(s) on or after <date> left untouched because the latest session is not final yet`
   line means step 2's window was missed — a session this run needed to judge is still open. It is
   safe to `--apply` anyway (those rows are simply left alone, not misapplied), but re-run once
   every relevant session has actually closed so nothing is left dangling.

   The dry run also prints one `Portfolio effect` line per user — the change to *that user's actual
   holdings*, quantity-weighted, not one share of every ticker touched (see *"Portfolio effect" and
   the open edge* in `README.md`). A fictional example:
   ```
   Portfolio effect, user ab***@x.com (7 held tickers): total -18.42 = rate-date -21.90 + close-changed +3.48 (residual +0.00)
   ```
   `IDENTITY_DB_PATH` (default `identity.db` next to the price database) is what lets it show a
   masked email instead of a raw user key.
4. **Apply**:
   ```bash
   DB_PATH=/var/www/portfoliotracker/portfolio.db node redate-prices.js --apply --since 2026-08-28
   ```
   Takes a `.backup()` of the database, gzips it under `backup-db.sh`'s own naming
   (`portfolio.db.pre-redate-<stamp>.gz`) and writes a change log to `~/backups/portfoliotracker/`
   *before* the transaction runs (as `"status": "pending"`, rewritten `"applied"` once the commit is
   durable — so a crash can never leave the database migrated with nothing recorded). Applies in one
   transaction and bumps `data_version` (no restart needed — the app reads prices per request). If it
   ever prints a line starting `✗✗✗ THE DATABASE WAS MIGRATED`, the transaction **did** commit even
   though the last step failed — do not re-run; go straight to *Verify*, and fix whatever the message
   says before touching the log file.
5. **Verify**:
   ```bash
   node verify-portfolio.js                # expect exit 0
   DB_PATH=/var/www/portfoliotracker/portfolio.db node redate-prices.js --since 2026-08-28   # dry run again — expect 0 changes
   ```
   Then eyeball the Portfolio chart for one US and one EU holding against Yahoo's own chart for a
   mid-history date.
6. **Rollback**, if needed:
   ```bash
   DB_PATH=/var/www/portfoliotracker/portfolio.db node redate-prices.js --rollback <backup-dir>/redate-prices-<stamp>.json
   ```
   Refuses if any row no longer matches what the migration itself last wrote there — it accepts both a
   `"pending"` log left by a crash right after the commit (it checks the database itself before
   trusting it) and a normal `"applied"` one, and refuses outright on an `"aborted"` log ("nothing to
   roll back"), since there is nothing in the database to undo. It also takes its own backup first.

   **Last resort — only if the change log is gone or `--rollback` itself refuses:** since the backup
   `--apply` wrote is gzipped under `backup-db.sh`'s own naming, its `--restore` now works directly and
   is the preferred path:
   ```bash
   ./backup-db.sh --restore ~/backups/portfoliotracker/portfolio.db.pre-redate-<stamp>.gz
   pm2 restart portfolio-api
   ```
   with the timer not running and pm2 stopped first (see *Rolling back → Database* above). Do **not**
   hand `--restore` a `.pre-redate-<stamp>` file with no `.gz` — a version of this script from before
   the issue #12 review wrote its backup uncompressed, and `--restore`'s `gunzip` truncates the target
   file before failing on anything that is not actually gzip. If, for any reason, an old uncompressed
   backup is all that exists, restore it manually instead: stop the timer
   (`sudo systemctl disable --now portfolio-price-fetch.timer`), `pm2 stop portfolio-api`, remove
   `portfolio.db-wal`/`portfolio.db-shm`, `cp <backup> portfolio.db`, then `pm2 start portfolio-api` and
   re-enable the timer.

## Re-dating exchange rates (`redate-rates.js`, issue #33)

A one-off, not part of a normal deploy — run only when a human has decided to. See *A rate's date*
in `README.md` for what it fixes. It restates `price_eur` on most dates in history by a fraction of a
percent (0.35% on average in the 2026-09-30 dry run; +€106.62 on today's portfolio value), so it
gets the same care as #12's migration.

1. **#12 first.** Run this after `redate-prices.js` has been applied, not before or alongside it:
   that migration rewrites `price_eur` from the rates as they stand, and this one then re-converts
   exactly the dates whose rate it moves. The other order works too, but its dry run would be
   reviewing numbers #12 is about to replace.
2. **Deploy the code first**, before the next scheduled price-fetch run, and
   `pm2 restart portfolio-api` — the old job files a clock-dated intraday quote every morning, which
   the migration would then have to correct again the next day (a second dry run would show it as
   one update). The new job writes nothing under today's date at all.
3. **Pick the window: 22:30–07:30 Lisbon**, never while the 09:00 timer might be running
   (`systemctl list-timers portfolio-price-fetch.timer`), and look at the unit yourself right before
   `--apply` — the script's own check is best effort:
   ```bash
   systemctl status portfolio-price-fetch.service
   ```
   Any night works: the rate for a date is only judged once Yahoo's next start-of-day snapshot
   exists, and a row newer than that is reported as left for the job, never changed.
4. **Dry run, and read it**:
   ```bash
   cd /var/www/portfoliotracker
   DB_PATH=/var/www/portfoliotracker/portfolio.db node redate-rates.js             # summary
   DB_PATH=/var/www/portfoliotracker/portfolio.db node redate-rates.js --verbose   # every row
   ```
   Expect, against the 2026-09-30 copy: about 1,179 rate updates (almost all "a day late", winter
   weekdays), 373 deletes (Sundays, a few Saturdays, 25 Dec / 1 Jan), 356 inserts (summer Fridays),
   about 9,800 `price_eur` values re-converted, one unverifiable weekday (2017-11-15) and one row
   left for the job. Stop and ask if:
   - any line says `IMPLAUSIBLE` (`--apply` refuses anyway — a rate moving more than 5% is a broken
     reference, not a date);
   - `Prices:` reports rows that "did not equal price_native × their old rate", on dates other than
     2026-09-11 — something other than rates has been writing `price_eur`;
   - the counts are far from the ones above for no reason you can name.
5. **Apply**:
   ```bash
   DB_PATH=/var/www/portfoliotracker/portfolio.db node redate-rates.js --apply
   ```
   Backup (`portfolio.db.pre-redate-rates-<stamp>.gz`) and change log
   (`redate-rates-<stamp>.json`, `"pending"` then `"applied"`) go to `~/backups/portfoliotracker/`;
   one transaction; bumps `data_version`, so no restart is needed. A `✗✗✗ THE DATABASE WAS MIGRATED`
   line means the commit happened — do not re-run; go to *Verify*.
6. **Verify**:
   ```bash
   node verify-portfolio.js                                                        # expect exit 0
   DB_PATH=/var/www/portfoliotracker/portfolio.db node redate-rates.js             # expect 0 / 0 / 0 and 0 prices
   ```
   and spot-check one date: `SELECT rate FROM exchange_rates WHERE date = '<a recent Monday>'` should
   be `1 / close` of Yahoo's `EURUSD=X` bar labelled the Tuesday after.
7. **Rollback**, if needed:
   ```bash
   DB_PATH=/var/www/portfoliotracker/portfolio.db node redate-rates.js --rollback ~/backups/portfoliotracker/redate-rates-<stamp>.json
   ```
   Restores both tables row for row (deleted rates come back with their ids and `created_at`), after
   taking its own backup; refuses if any row no longer holds what the migration wrote. Note that the
   *code* keeps writing the new dating either way — rolling the data back without the code leaves
   the last ~10 days re-dated again by the next morning's run. Last resort, as for #12:
   `./backup-db.sh --restore ~/backups/portfoliotracker/portfolio.db.pre-redate-rates-<stamp>.gz`
   with the timer stopped and pm2 stopped first.

---

## Things that have actually broken here

Each of these cost real time. They are listed because none is obvious from the code.

**1. systemd units live outside the repo.** `portfolio-price-fetch.{timer,service}` are read by
systemd from `/etc/systemd/system/`. When the project moved directories, `WorkingDirectory`,
`DB_PATH` and `ExecStart` still pointed at the old path and the job died for ~14h without a sound.
Since 2026-09-18 **copies are tracked in `deploy/systemd/`** — copies, not the live files, so they
can drift. After any move, or any change to the Node version or the schedule, check both:
`systemctl cat portfolio-price-fetch.service`, then the drift `diff` in `deploy/systemd/README.md`.

**2. Stopping the service leaves the timer disarmed.** `systemctl stop` on the service does not
re-arm the timer afterwards. Re-enable explicitly:
`sudo systemctl enable --now portfolio-price-fetch.timer`

**3. `better-sqlite3` is a native module.** After any Node version change it throws
`ERR_DLOPEN_FAILED` / `libnode.so.NNN`. Fix: `npm rebuild better-sqlite3`, then
`pm2 kill && pm2 resurrect` — pm2's own daemon also runs on the old Node until restarted.

**4. A skipped job looks exactly like a successful one.** Hence `job_runs`, the per-run email and
the separate watchdog. If you add another early `return`/`exit` to the fetch job, record a run
row on that path too or you reintroduce the blind spot.

**5. sudo needs a password here.** Anything touching systemd, nginx or apt has to be run by a
human. Everything else — pm2, cron, npm, the app, backups — runs unprivileged as `deploy`.

---

## Credentials and where they live

`.env` (gitignored, never committed — verified across the whole history):

| Variable | Notes |
|---|---|
| `SMTP_*` | Resend. `secure` is derived from the port; `SMTP_USE_TLS` is legacy and unread |
| `GOOGLE_CLIENT_ID` / `_SECRET` | OAuth client. Changing `APP_BASE_URL` **requires** updating the redirect URI in Google Cloud Console, or sign-in breaks |
| `APP_BASE_URL` | Builds magic-link URLs and the OAuth redirect URI |
| `CONTACT_EMAIL_TO` | Where contact-form messages go — the address the website publishes |
| `OPS_EMAIL_TO` | Where the price-fetch run report and the job watchdog go |
| `ALERT_EMAIL_TO` | Legacy. Both of the above fall back to it, so an older `.env` keeps working |
| `PRICE_FETCH_REPORT` | `false` disables the per-run status email |

Changing `.env` restarts the app automatically.

---

## Scheduled work

| When | What | Where |
|---|---|---|
| 09:00 local daily | Price fetch + alert digests | systemd timer |
| 03:30 local daily | Database backup, 30-day retention | `crontab -l` |
| 13:00 local daily | Job health watchdog | `crontab -l` |

The fetch only runs when US markets are shut — after the 21:00 UTC close and again before the
13:00 UTC open. The window wraps midnight; testing only `hour < close` made the 09:00 slot skip
every single day, which is how it shipped originally.

## Off-site backups

`backup-db.sh` writes nightly to `~/backups/portfoliotracker` — the same disk as the
database, so it survives a bad migration and not a dead disk. `backup-offsite.sh` puts the
same snapshot in two places that have nothing to do with this VPS.

```bash
./backup-offsite.sh --dry-run    # snapshot, encrypt, verify the round-trip, send nothing
./backup-offsite.sh              # and email it and push it
```

Weekly by cron, Sunday 04:00, after the nightly local backup:

```
0 4 * * 0 cd /var/www/portfoliotracker && ./backup-offsite.sh >> logs/backup-offsite.log 2>&1
```

**What goes where**

| Copy | Where | Kept |
|---|---|---|
| Nightly, plain | `~/backups/portfoliotracker` on this box | 30 days |
| Weekly, encrypted | emailed to `CONTACT_EMAIL_TO` | as long as the inbox keeps it |
| Weekly, encrypted | `luisdanielsilva/portfoliotracker-backups` (private) | ~26 weeks, pruned by the script |

Both off-site copies are gpg symmetric (AES256) before they leave, so neither Gmail nor
GitHub holds anything readable. That is what makes a git repository an acceptable
destination at all: a leak of it yields ciphertext.

**The passphrase** is `BACKUP_PASSPHRASE` in `.env` (chmod 600, gitignored) and in the
owner's password manager. It is deliberately not in the repository, not in the email, and
not in this file. **Without it every off-site copy is a brick** — if it is ever rotated,
the old copies stay readable only with the old one.

**Restore**

```bash
gpg -d portfolio.db.<stamp>.gz.gpg > portfolio.db.gz
gunzip portfolio.db.gz
sqlite3 portfolio.db "PRAGMA integrity_check;"    # expect: ok
# and the same for identity.db.<stamp>.gz.gpg -> identity.db, if that side is what needs restoring
```

(Snapshots from before the 2026-09-14 split are a single `data.db.<stamp>.gz.gpg` — that legacy name is
still handled by the pruning logic, but nothing this old should still be the most recent copy.)

Then put `portfolio.db` (and/or `identity.db`) in the application directory and `pm2 restart portfolio-api`.
The script refuses to ship anything it cannot decrypt back to a valid gzip, so a copy that reaches
either destination has already been proven to round-trip once.
