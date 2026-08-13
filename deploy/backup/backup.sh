#!/usr/bin/env bash
#
# WAL-safe online backup of the shared SQLite DB (execution/06, M-5).
#
# Uses the SQLite ".backup" command, which takes a CONSISTENT snapshot through
# the online-backup API even while the bot/web are writing — it folds in the
# -wal contents, so (unlike `cp bot.db`) you never lose the un-checkpointed
# transactions sitting in bot.db-wal. Zero downtime.
#
# Run on the HOST (the DB lives in the bind-mounted ./data). Requires sqlite3:
#   Debian/Ubuntu VPS:  sudo apt-get update && sudo apt-get install -y sqlite3
#
# Usage:
#   deploy/backup/backup.sh                 # uses defaults below
#   DB=/srv/app/data/bot.db DEST=/srv/backups RETENTION=28 deploy/backup/backup.sh
#
# Cron (every 6h, log to file) — `crontab -e`:
#   0 */6 * * * DB=/srv/app/data/bot.db DEST=/srv/backups /srv/app/deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1
set -euo pipefail

DB="${DB:-./data/bot.db}"
DEST="${DEST:-./data/backups}"
RETENTION="${RETENTION:-28}"          # how many timestamped backups to keep
STAMP="$(date +%F-%H%M%S)"
OUT="${DEST}/bot-${STAMP}.db"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 not found. Install it: sudo apt-get install -y sqlite3" >&2
  exit 1
fi
if [ ! -f "$DB" ]; then
  echo "ERROR: DB not found at: $DB" >&2
  exit 1
fi

mkdir -p "$DEST"

# Online, consistent snapshot (folds in -wal). NOT a raw file copy.
sqlite3 "$DB" ".backup '$OUT'"

# Verify the snapshot is structurally sound before we trust/rotate it.
CHECK="$(sqlite3 "$OUT" 'PRAGMA integrity_check;')"
if [ "$CHECK" != "ok" ]; then
  echo "ERROR: integrity_check failed on $OUT: $CHECK" >&2
  rm -f "$OUT"
  exit 1
fi

# Compress to save off-box transfer/storage (keep the .db too for fast restore).
gzip -kf "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "OK  backup=$OUT (${SIZE}, integrity=ok)  gz=$OUT.gz"

# Retention: keep the newest $RETENTION *.db (and their .gz); prune the rest.
mapfile -t OLD < <(ls -1t "${DEST}"/bot-*.db 2>/dev/null | tail -n +"$((RETENTION + 1))")
for f in "${OLD[@]:-}"; do
  [ -n "$f" ] || continue
  rm -f "$f" "$f.gz"
  echo "pruned $f"
done

# OPTIONAL off-box copy (uncomment & set a target — meets the 3-2-1 rule):
#   rsync -a "$OUT.gz" backups@offsite:/srv/bot-backups/   || echo "WARN: off-box rsync failed" >&2
#   aws s3 cp "$OUT.gz" "s3://my-bucket/bot-backups/"      || echo "WARN: s3 upload failed"   >&2
