# Deployment & Operations

Everything runs on one Hetzner VPS, in one directory, as the `deploy` user.
`README.md` describes *what* the app is; this describes *running* it.

| | |
|---|---|
| App directory | `/var/www/portfoliotracker` (git repo, pm2 app and web root are all this one path) |
| Process | pm2 app `portfolio-api` on port 3000 |
| Public URL | https://www.singleuseapps.com/portfoliotracker/ |
| Nginx vhost | `/etc/nginx/sites-available/singleuseapps-com` proxies `/portfoliotracker/` → `localhost:3000` |
| Database | `/var/www/portfoliotracker/data.db` — **untracked**, backed up nightly |
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
./backup-db.sh --restore ~/backups/portfoliotracker/data.db.YYYYMMDD-HHMMSS.gz
pm2 restart portfolio-api      # the app must reopen the file
```

Restore keeps the database it replaced as `data.db.replaced-<timestamp>`, so a wrong restore is
itself reversible. Snapshots are taken with SQLite's online backup API (not `cp`) and are
integrity-checked before they count.

---

## Things that have actually broken here

Each of these cost real time. They are listed because none is obvious from the code.

**1. systemd units are not in the repo.** `portfolio-price-fetch.{timer,service}` live in
`/etc/systemd/system/`. When the project moved directories, `WorkingDirectory`, `DB_PATH` and
`ExecStart` still pointed at the old path and the job died for ~14h without a sound. After any
move: `systemctl cat portfolio-price-fetch.service` and check all three.

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
| `ALERT_EMAIL_TO` | Where job reports and health alerts go |
| `PRICE_FETCH_REPORT` | `false` disables the per-run status email |

Changing `.env` restarts the app automatically.

---

## Scheduled work

| When | What | Where |
|---|---|---|
| 09:00 UTC daily | Price fetch + alert digests | systemd timer |
| 03:30 local daily | Database backup, 30-day retention | `crontab -l` |
| 13:00 local daily | Job health watchdog | `crontab -l` |

The fetch only runs when US markets are shut — after the 21:00 UTC close and again before the
13:00 UTC open. The window wraps midnight; testing only `hour < close` made the 09:00 slot skip
every single day, which is how it shipped originally.
