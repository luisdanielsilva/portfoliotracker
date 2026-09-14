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
DB_PATH="${DB_PATH:-$APP_DIR/portfolio.db}"
IDENTITY_PATH="${IDENTITY_DB_PATH:-$(dirname "$DB_PATH")/identity.db}"

# Since the split there are two files and a backup of one is worth very little on
# its own: the financial data with no identities cannot be signed into, and the
# identities with no financial data are an address book. Both are snapshotted
# every run, under their own names, and a restore puts each back where it came
# from.
DB_FILES=("$DB_PATH" "$IDENTITY_PATH")
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/portfoliotracker}"
KEEP_DAYS="${KEEP_DAYS:-30}"

list_backups() {
  if compgen -G "$BACKUP_DIR/"*.db.*.gz > /dev/null; then
    ls -lh "$BACKUP_DIR"/*.db.*.gz | awk '{print "  "$9"  "$5"  "$6" "$7" "$8}'
    echo "  ($(find "$BACKUP_DIR" -name '*.db.*.gz' | wc -l) snapshots in $BACKUP_DIR)"
  else
    echo "  no snapshots yet in $BACKUP_DIR"
  fi
}

restore_backup() {
  local src="$1"
  [ -f "$src" ] || { echo "No such snapshot: $src" >&2; exit 1; }

  # A snapshot is named <basename>.<stamp>.gz, so it knows which file it is a
  # copy of. Restoring an identity snapshot over the portfolio database would be
  # a very bad afternoon, so the destination is derived rather than assumed.
  local base; base="$(basename "$src")"; base="${base%%.db.*}.db"
  local DB_PATH
  case "$base" in
    "$(basename "$IDENTITY_PATH")") DB_PATH="$IDENTITY_PATH" ;;
    *) DB_PATH="${DB_FILES[0]}" ;;
  esac
  echo "This will REPLACE $DB_PATH with $src"
  read -r -p "Type 'restore' to confirm: " reply
  [ "$reply" = "restore" ] || { echo "Aborted."; exit 1; }

  # Never discard the current database on the way in. In WAL mode the newest
  # committed rows may still be in data.db-wal, so a plain copy of data.db alone
  # can silently omit them — checkpoint first, and this "just in case" copy is
  # then actually the whole thing.
  local safety="$DB_PATH.replaced-$(date +%Y%m%d-%H%M%S)"
  node -e "
    const D=require('$APP_DIR/node_modules/better-sqlite3');
    const db=new D('$DB_PATH');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  " 2>/dev/null || true
  cp "$DB_PATH" "$safety"

  # Replacing the file while the old -wal and -shm are still beside it is the way
  # to corrupt a restore: SQLite finds a write-ahead log belonging to a different
  # database and replays it onto the new one. Remove them with the file they
  # describe.
  rm -f "$DB_PATH-wal" "$DB_PATH-shm"
  gunzip -c "$src" > "$DB_PATH"
  rm -f "$DB_PATH-wal" "$DB_PATH-shm"
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

for SOURCE in "${DB_FILES[@]}"; do
  [ -f "$SOURCE" ] || { echo "  ⚠ skipping $SOURCE — not found"; continue; }
  TARGET="$BACKUP_DIR/$(basename "$SOURCE").$STAMP"

  # SQLite's online backup API, not cp: the app writes to these files
  # continuously, and copying one mid-transaction yields a torn snapshot. This
  # also fails loudly rather than producing a corrupt file.
  node -e "
  const Database = require('$APP_DIR/node_modules/better-sqlite3');
  const db = new Database('$SOURCE', { readonly: true });
  db.backup('$TARGET')
    .then(() => { db.close(); })
    .catch(e => { console.error('backup failed: ' + e.message); process.exit(1); });
  "

  # Verify the snapshot is readable and sane before it counts as a backup. What
  # "sane" means differs per file, so count whatever that one is supposed to hold.
  node -e "
  const Database = require('$APP_DIR/node_modules/better-sqlite3');
  const db = new Database('$TARGET', { readonly: true });
  const ok = db.pragma('integrity_check')[0].integrity_check;
  if (ok !== 'ok') { console.error('integrity check failed: ' + ok); process.exit(1); }
  const has = t => !!db.prepare(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name=?\").get(t);
  const count = t => db.prepare('SELECT COUNT(*) c FROM ' + t).get().c;
  const parts = [];
  if (has('users')) parts.push(count('users') + ' users');
  if (has('transactions')) parts.push(count('transactions') + ' transactions');
  if (has('prices')) parts.push(count('prices') + ' prices');
  if (!parts.length) { console.error('snapshot holds none of the expected tables'); process.exit(1); }
  console.log('  verified: integrity ok, ' + parts.join(', '));
  db.close();
  "

  gzip -f "$TARGET"
  echo "  wrote $TARGET.gz ($(du -h "$TARGET.gz" | cut -f1))"
done

# Prune old snapshots, but never leave zero backups behind — and prune each file's
# snapshots against its own set. Pooling them would let a run of portfolio backups
# push every identity backup past the "keep at least one" guard.
PRUNED=0
for SOURCE in "${DB_FILES[@]}"; do
  PATTERN="$(basename "$SOURCE").*.gz"
  if [ "$(find "$BACKUP_DIR" -name "$PATTERN" | wc -l)" -gt 1 ]; then
    while IFS= read -r old; do
      rm -f "$old"; PRUNED=$((PRUNED + 1))
    done < <(find "$BACKUP_DIR" -name "$PATTERN" -mtime "+$KEEP_DAYS" | head -n -1)
  fi
done
[ "$PRUNED" -gt 0 ] && echo "  pruned $PRUNED snapshot(s) older than $KEEP_DAYS days"

for SOURCE in "${DB_FILES[@]}"; do
  echo "  $(find "$BACKUP_DIR" -name "$(basename "$SOURCE").*.gz" | wc -l) $(basename "$SOURCE") snapshot(s) retained"
done
echo "  in $BACKUP_DIR"
