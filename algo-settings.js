/**
 * The Position Timing Signal's per-user settings, and who it speaks to.
 *
 * An account has a `user_settings` row only once its owner has saved a timing:
 * signing up creates the identity and nothing on the financial side. So "no row"
 * is the normal state of a new account, and it has to mean the defaults — on,
 * 3 days, 1 month — everywhere, or the alert the tab says is watching every
 * holding silently watches nobody's (issue #34). Every reader goes through here
 * rather than selecting from `user_settings` itself.
 *
 * The column defaults in schema.sqlite.sql and db-migrations.js are kept equal
 * to these, and a test holds them to it, but nothing relies on them: the only
 * writer (PUT /api/algorithm/settings) always writes every value.
 */

const ALGO_DEFAULTS = Object.freeze({ enabled: 1, holdDays: 3, cooldownDays: 30 });

const COLUMNS =
  'algo_alerts_enabled AS enabled, algo_hold_days AS holdDays, algo_cooldown_days AS cooldownDays';

/** One account's settings, the defaults standing in for a row that was never written. */
function readAlgoSettings(db, userKey) {
  const row = db.prepare(`SELECT ${COLUMNS} FROM user_settings WHERE user_id = ?`).get(userKey);
  return row ? { ...row } : { ...ALGO_DEFAULTS };
}

/**
 * Everyone the signal may email: every account that has an address, with its
 * settings (or the defaults), less those who switched it off.
 *
 * The list starts from the identities, not from `user_settings` — starting from
 * the settings table is exactly what left new accounts out. The two live in
 * different files, so this is two reads joined in memory by the opaque key.
 * Without a reachable identity database there is nobody to email, so the list
 * is empty rather than a guess.
 */
function algoRecipients(db, identityDb) {
  if (!identityDb) return [];
  let identities;
  try {
    identities = identityDb.prepare('SELECT user_key AS id, email FROM users').all();
  } catch {
    return [];
  }
  const saved = new Map();
  for (const r of db.prepare(`SELECT user_id AS id, ${COLUMNS} FROM user_settings`).all()) {
    saved.set(r.id, r);
  }
  const out = [];
  for (const { id, email } of identities) {
    if (!id || !email) continue;
    const s = saved.get(id) || ALGO_DEFAULTS;
    if (!s.enabled) continue;
    out.push({ id, email, holdDays: s.holdDays, cooldownDays: s.cooldownDays });
  }
  return out;
}

module.exports = { ALGO_DEFAULTS, readAlgoSettings, algoRecipients };
