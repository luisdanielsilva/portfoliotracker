#!/usr/bin/env bash
#
# Ship an encrypted copy of the database off this machine.
#
# backup-db.sh already takes a nightly snapshot, but it writes to ~/backups on the same
# disk as data.db — so it survives a bad migration and not a dead disk. This puts the same
# snapshot in two places that have nothing to do with this VPS:
#
#   1. an email to CONTACT_EMAIL_TO (Gmail)
#   2. a commit in a private GitHub repository
#
# The file is gpg-symmetric (AES256) before it leaves, so neither destination holds
# anything readable without BACKUP_PASSPHRASE. That is what makes putting it in a git
# repository acceptable at all: a leak of the repo yields ciphertext.
#
#   ./backup-offsite.sh              take a fresh snapshot, encrypt, send and push
#   ./backup-offsite.sh --dry-run    do everything except send and push
#
# Restore:
#   gpg -d portfoliotracker.<stamp>.tar.gpg | tar -x
#   gunzip portfolio.db.<stamp>.gz identity.db.<stamp>.gz
# (older snapshots are a single data.db.<stamp>.gz.gpg, from before the split)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
set -a; [ -f .env ] && . ./.env; set +a

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/portfoliotracker}"
GIT_MIRROR="${GIT_MIRROR:-$HOME/backups/portfoliotracker-git}"
KEEP_OFFSITE="${KEEP_OFFSITE:-26}"      # ~6 months of weekly copies kept in the repo
DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { say "ERROR: $*" >&2; exit 1; }

[ -n "${BACKUP_PASSPHRASE:-}" ] || fail "BACKUP_PASSPHRASE is not set in .env — nothing would be readable on restore"

# 1. a fresh, integrity-checked snapshot from the existing script
say "taking a snapshot"
./backup-db.sh >/dev/null || fail "backup-db.sh failed — not shipping anything"
# Both files, newest of each. Shipping only the financial half off-site would
# make the off-site copy unusable on its own — no identities means nobody can
# sign in to it — and shipping only the identity half would be an address book.
SNAPSHOTS=()
for BASE in portfolio.db identity.db; do
  NEWEST="$(ls -1t "$BACKUP_DIR/$BASE".*.gz 2>/dev/null | head -1)"
  [ -n "$NEWEST" ] && SNAPSHOTS+=("$NEWEST")
done
[ "${#SNAPSHOTS[@]}" -eq 2 ] || fail "expected a snapshot of each database in $BACKUP_DIR, found ${#SNAPSHOTS[@]}"
STAMP="$(basename "${SNAPSHOTS[0]}" | sed 's/^[^.]*\.db\.//; s/\.gz$//')"
for f in "${SNAPSHOTS[@]}"; do say "snapshot: $(basename "$f") ($(du -h "$f" | cut -f1))"; done

# 2. bundle the pair, then encrypt
#
# One archive rather than two, because either half alone is useless: the
# financial file with no identities cannot be signed into, and the identity file
# alone is an address book. Keeping them in one object means a restore can never
# end up with a mismatched pair from different weeks.
BUNDLE="$BACKUP_DIR/portfoliotracker.$STAMP.tar"
tar -cf "$BUNDLE" -C "$BACKUP_DIR" $(printf '%s\n' "${SNAPSHOTS[@]}" | xargs -n1 basename)
ENC="$BACKUP_DIR/portfoliotracker.$STAMP.tar.gpg"
printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet \
  --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-count 65011712 \
  --passphrase-fd 0 --output "$ENC" "$BUNDLE"
rm -f "$BUNDLE"
[ -s "$ENC" ] || fail "encryption produced nothing"
chmod 600 "$ENC"

# prove it round-trips before trusting it anywhere — and that both files are in it
printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --quiet --decrypt --passphrase-fd 0 "$ENC" \
  | tar -t > /dev/null 2>&1 || fail "the encrypted copy does not decrypt back to a valid archive"
INSIDE="$(printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --quiet --decrypt --passphrase-fd 0 "$ENC" | tar -t | wc -l)"
[ "$INSIDE" -eq 2 ] || fail "the archive holds $INSIDE file(s), expected 2"
say "encrypted and verified: $(basename "$ENC") ($(du -h "$ENC" | cut -f1))"

if $DRY_RUN; then say "dry run — not sending, not pushing"; rm -f "$ENC"; exit 0; fi

# 3. email it
node "$APP_DIR/send-backup.js" "$ENC" || say "WARNING: email copy failed (the git copy may still have worked)"

# 4. commit it to the private mirror
if [ -d "$GIT_MIRROR/.git" ]; then
  cp "$ENC" "$GIT_MIRROR/"
  (
    cd "$GIT_MIRROR"
    # keep the repo from growing without bound; encrypted blobs do not delta-compress
    ls -1t portfoliotracker.*.tar.gpg data.db.*.gz.gpg 2>/dev/null | tail -n +$((KEEP_OFFSITE + 1)) | xargs -r git rm -q --ignore-unmatch
    git add -A
    if git diff --cached --quiet; then
      say "git mirror: nothing new to commit"
    else
      git commit -q -m "backup $STAMP"
      git push -q origin HEAD && say "git mirror: pushed $STAMP"
    fi
  ) || say "WARNING: git mirror failed (the email copy may still have worked)"
else
  say "WARNING: no git mirror at $GIT_MIRROR — skipping (see DEPLOYMENT.md)"
fi

rm -f "$ENC"
say "done"
