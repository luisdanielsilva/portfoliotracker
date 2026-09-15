/**
 * Where the identities live.
 *
 * Since the split the financial database holds an opaque key where a person used
 * to be, and the address sits in a different file. Two things have to cross that
 * line — price-fetch, to turn a key into an address it can write to, and
 * mailguard, to count how many people are registered — and they must agree on
 * where to look. So the resolution lives here rather than twice, in each of them.
 *
 * Read-only on purpose: nothing that crosses this line has any business writing.
 */
const path = require('path');
const Database = require('better-sqlite3');

function identityFor(db) {
  if (db && db.identity) return db.identity;          // tests hand theirs over directly
  const file = process.env.IDENTITY_DB_PATH
    || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, 'portfolio.db')), 'identity.db');
  try {
    const handle = new Database(file, { readonly: true });
    handle.pragma('busy_timeout = 5000');
    return handle;
  } catch {
    return null;   // no identities available: nothing can be emailed, and the caller says so
  }
}

module.exports = { identityFor };
