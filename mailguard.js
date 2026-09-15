/**
 * A hard ceiling on how much mail this app can send.
 *
 * WHY. On 2026-09-15 a crash met `Restart=on-failure`, the job failed 453 times
 * in five hours, and every failure emailed a report until the account's daily
 * sending quota was gone. The alert emails users actually depend on then could
 * not be sent either. Every individual piece of that was reasonable; the total
 * was not, and nothing in the system was counting the total.
 *
 * So this counts. Every send goes through here, every send is recorded, and a
 * send that would exceed its budget does not happen — no matter which process
 * asks, how often, or why. The throttles elsewhere (a rule fires at most once a
 * day, a failure is reported at most once an hour) are still the first line;
 * this is the one that does not depend on any of them being right.
 *
 * ADDRESSES ARE NOT STORED. The log lives in the financial database, which since
 * the split must never hold an email address — so the recipient is kept as a hash.
 * Counting does not need to know who anybody is.
 */

const crypto = require('crypto');
const { identityFor } = require('./identity-db');

/**
 * Budgets per recipient per rolling 24 hours, by kind.
 *
 * Each is set well above what the feature can legitimately produce and well below
 * anything that hurts. The numbers are deliberately not uniform: dropping a
 * support message silently is far worse than dropping the sixth copy of the same
 * failure report, so `contact` is generous and `run-report` is tight.
 */
const LIMITS = {
  login: 10,        // magic links: a person mistypes, loses the mail, tries again
  alert: 5,         // the daily digest — realistically one, five is room to breathe
  'run-report': 6,  // one scheduled run a day; six means something is retrying
  health: 3,        // the staleness check runs once a day
  backup: 3,        // weekly
  contact: 30       // support must not be silently dropped
};

/** Anything not listed above still gets a budget rather than a free pass. */
const DEFAULT_LIMIT = 5;

/**
 * A ceiling across everything, per day, whatever the kind or recipient:
 * **ten messages per registered user**.
 *
 * The per-recipient budgets would have stopped 2026-09-15 at six emails. This
 * exists for the failure nobody has thought of yet — a loop that invents new
 * recipients, say, which no per-recipient budget can see.
 *
 * It is expressed per user rather than as a flat number so that it stays tight as
 * the app grows: a fixed 200 is a very loose ceiling for six accounts and a very
 * tight one for two hundred. A normal user gets one email a day, so ten apiece is
 * an order of magnitude of headroom and still an order of magnitude below the
 * incident.
 *
 * Note what this means: the ceiling can now be *lower* than what one person's own
 * budgets allow (contact alone is 30). That is deliberate — a single address
 * burning the shared budget is exactly the kind of runaway worth stopping — but it
 * does mean one unusually chatty account can crowd out another account's alerts.
 * Raise GLOBAL_PER_USER before loosening any per-recipient budget.
 */
const GLOBAL_PER_USER = 10;

/**
 * ...but never less than one user's worth. A fresh install with an empty `users`
 * table would otherwise compute a ceiling of zero and silence the backup and
 * health mail that says the install is working.
 */
const GLOBAL_FLOOR = GLOBAL_PER_USER;

const hashRecipient = to => crypto.createHash('sha256').update(String(to).trim().toLowerCase()).digest('hex');

function ensureEmailLog(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_email_log_recipient ON email_log(recipient_hash, kind, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_log_sent ON email_log(sent_at DESC);
  `);
}

function limitFor(kind) {
  return Object.prototype.hasOwnProperty.call(LIMITS, kind) ? LIMITS[kind] : DEFAULT_LIMIT;
}

/* ---- how many people are registered ----
 *
 * The count lives in the identity database, which this module otherwise has no
 * business in: it reads one number and never an address. The handle is resolved
 * once per process — opening a database on every send would be absurd when the
 * shape of the problem is a loop sending hundreds of them.
 */
let identityHandle;
function identityDbFor(db) {
  if (db && db.identity) return db.identity;          // tests hand theirs over directly
  if (identityHandle === undefined) identityHandle = identityFor(db);
  return identityHandle;
}

function registeredUsers(identityDb) {
  if (!identityDb) return null;
  try {
    return identityDb.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  } catch {
    return null;   // unreadable: say so rather than guessing a number
  }
}

/**
 * The global ceiling as it stands right now, and the count behind it.
 *
 * `limit` is null when the registered users cannot be counted. The global check is
 * then skipped rather than guessed at, on the same principle as the rest of this
 * module: the per-recipient budgets still apply, and a bookkeeping failure must
 * not be what stops the alerts.
 */
function globalCeiling(db, identityDb) {
  const users = registeredUsers(identityDb === undefined ? identityDbFor(db) : identityDb);
  if (users == null) return { users: null, limit: null };
  return { users, limit: Math.max(GLOBAL_FLOOR, users * GLOBAL_PER_USER) };
}

/**
 * May this message be sent? Returns a reason when not, so the caller can log
 * something more useful than silence.
 */
function checkQuota(db, to, kind, identityDb) {
  if (!db || !to) return { allowed: true };     // nothing to count against
  try {
    ensureEmailLog(db);
    const sent = db.prepare(
      "SELECT COUNT(*) AS n FROM email_log WHERE recipient_hash = ? AND kind = ? AND julianday('now') - julianday(sent_at) < 1"
    ).get(hashRecipient(to), kind).n;
    const limit = limitFor(kind);
    if (sent >= limit) {
      return { allowed: false, reason: `${kind}: ${sent} already sent to this address in 24h (limit ${limit})`, sent, limit };
    }
    const { users, limit: globalLimit } = globalCeiling(db, identityDb);
    if (globalLimit != null) {
      const total = db.prepare(
        "SELECT COUNT(*) AS n FROM email_log WHERE julianday('now') - julianday(sent_at) < 1"
      ).get().n;
      if (total >= globalLimit) {
        return {
          allowed: false,
          reason: `global: ${total} messages sent in 24h (limit ${globalLimit} = ${GLOBAL_PER_USER} per registered user × ${users})`,
          sent: total, limit: globalLimit
        };
      }
    }
    return { allowed: true, sent, limit };
  } catch (err) {
    // A broken ledger must not become a reason to stop sending: the alerts matter
    // more than the counting does.
    return { allowed: true, error: err.message };
  }
}

function recordSend(db, to, kind) {
  if (!db || !to) return;
  try {
    ensureEmailLog(db);
    db.prepare('INSERT INTO email_log (recipient_hash, kind) VALUES (?, ?)').run(hashRecipient(to), kind);
  } catch { /* see above — never block a send on bookkeeping */ }
}

/**
 * Send, unless that would exceed the budget. Recording happens on the way out
 * rather than after a successful delivery, for the same reason a cooldown is
 * written before the mail goes: a provider error that left the count unchanged
 * would let a retry loop send for ever.
 */
async function sendGuarded(db, mailer, kind, message, log = () => {}, identityDb) {
  const to = message && message.to;
  const verdict = checkQuota(db, to, kind, identityDb);
  if (!verdict.allowed) {
    log(`  🚫 not sending — ${verdict.reason}`);
    return { sent: false, reason: verdict.reason };
  }
  if (!mailer) {
    log(`  📌 would send (${kind}) to ${to}`);
    return { sent: false, reason: 'no mailer' };
  }
  recordSend(db, to, kind);
  await mailer.sendMail(message);
  return { sent: true };
}

/** What has gone out in the last day, for the ops report and for tests. */
function recentSummary(db) {
  if (!db) return [];
  try {
    ensureEmailLog(db);
    return db.prepare(
      "SELECT kind, COUNT(*) AS n FROM email_log WHERE julianday('now') - julianday(sent_at) < 1 GROUP BY kind ORDER BY n DESC"
    ).all();
  } catch { return []; }
}

module.exports = {
  sendGuarded, checkQuota, recordSend, recentSummary, ensureEmailLog,
  LIMITS, DEFAULT_LIMIT, GLOBAL_PER_USER, GLOBAL_FLOOR, globalCeiling, registeredUsers,
  limitFor, hashRecipient
};
