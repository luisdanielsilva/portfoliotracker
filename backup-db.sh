#!/usr/bin/env bash
#
# Rotated snapshots of the portfolio tracker's SQLite database.
#
# Backups live OUTSIDE the repo: the database is untracked on purpose (it holds
# user emails and raw session cookies), so git is not a backup and this is.
#
#   ./backup-db.sh              take a snapshot, prune old ones
#   ./backup-db.sh --list       show what snapshots exist
#   ./backup-db.sh --restore F  restore from snapshot F (asks first)
#
# Override with env vars: DB_PATH, BACKUP_DIR, KEEP_DAYS.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PATH="${DB_PATH:-$APP_DIR/data.db}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/portfoliotracker}"
KEEP_DAYS="${KEEP_DAYS:-30}"

list_backups() {
  if compgen -G "$BACKUP_DIR/data.db.*.gz" > /dev/null; then
    ls -lh "$BACKUP_DIR"/data.db.*.gz | awk '{print "  "$9"  "$5"  "$6" "$7" "$8}'
    echo "  ($(find "$BACKUP_DIR" -name 'data.db.*.gz' | wc -l) snapshots in $BACKUP_DIR)"
  else
    echo "  no snapshots yet in $BACKUP_DIR"
  fi
}

restore_backup() {
  local src="$1"
  [ -f "$src" ] || { echo "No such snapshot: $src" >&2; exit 1; }
  echo "This will REPLACE $DB_PATH with $src"
  read -r -p "Type 'restore' to confirm: " reply
  [ "$reply" = "restore" ] || { echo "Aborted."; exit 1; }

  # Never discard the current database on the way in.
  local safety="$DB_PATH.replaced-$(date +%Y%m%d-%H%M%S)"
  cp "$DB_PATH" "$safety"
  gunzip -c "$src" > "$DB_PATH"
  echo "Restored. Previous database kept at $safety"
  echo "Restart the app so it reopens the file:  pm2 restart portfolio-api"
}

case "${1:-}" in
  --list) list_backups; exit 0 ;;
  --restore) restore_backup "${2:-}"; exit 0 ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 1 ;;
esac

[ -f "$DB_PATH" ] || { echo "Database not found at $DB_PATH" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/data.db.$STAMP"

# SQLite's online backup API, not cp: the app writes to this file continuously,
# and copying it mid-transaction yields a torn snapshot. This also fails loudly
# rather than producing a corrupt file.
node -e "
const Database = require('$APP_DIR/node_modules/better-sqlite3');
const db = new Database('$DB_PATH', { readonly: true });
db.backup('$TARGET')
  .then(() => { db.close(); })
  .catch(e => { console.error('backup failed: ' + e.message); process.exit(1); });
"

# Verify the snapshot is readable and sane before it counts as a backup.
node -e "
const Database = require('$APP_DIR/node_modules/better-sqlite3');
const db = new Database('$TARGET', { readonly: true });
const ok = db.pragma('integrity_check')[0].integrity_check;
if (ok !== 'ok') { console.error('integrity check failed: ' + ok); process.exit(1); }
const n = db.prepare('SELECT COUNT(*) c FROM transactions').get().c;
const u = db.prepare('SELECT COUNT(*) c FROM users').get().c;
console.log('  verified: integrity ok, ' + u + ' users, ' + n + ' transactions');
db.close();
"

gzip -f "$TARGET"
echo "  wrote $TARGET.gz ($(du -h "$TARGET.gz" | cut -f1))"

# Prune old snapshots, but never leave zero backups behind.
PRUNED=0
if [ "$(find "$BACKUP_DIR" -name 'data.db.*.gz' | wc -l)" -gt 1 ]; then
  while IFS= read -r old; do
    rm -f "$old"; PRUNED=$((PRUNED + 1))
  done < <(find "$BACKUP_DIR" -name 'data.db.*.gz' -mtime "+$KEEP_DAYS" | head -n -1)
fi
[ "$PRUNED" -gt 0 ] && echo "  pruned $PRUNED snapshot(s) older than $KEEP_DAYS days"

echo "  $(find "$BACKUP_DIR" -name 'data.db.*.gz' | wc -l) snapshot(s) retained in $BACKUP_DIR"
