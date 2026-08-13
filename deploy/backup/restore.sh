#!/usr/bin/env bash
#
# Restore the shared SQLite DB from a backup (execution/06, M-5). This is also
# the rollback path for a bad migration/deploy: restore the last good backup.
#
# Procedure (WAL-safe): stop every writer, pause the container's automatic schema
# update (otherwise it migrates the restored DB forward again and undoes the
# rollback), swap the file, DELETE the stale -wal/-shm (they belong to the OLD db
# — keeping them corrupts the restore), fix ownership, integrity-check, restart,
# smoke /healthz.
#
# Run on the HOST. Requires sqlite3 + docker compose. Stops ALL services that
# touch the DB (order-bot, notifier, web-admin, storefront).
#
# Usage:
#   deploy/backup/restore.sh ./data/backups/bot-2026-06-18-1200.db
#   deploy/backup/restore.sh ./data/backups/bot-2026-06-18-1200.db.gz   # gz ok
set -euo pipefail

SRC="${1:-}"
DB="${DB:-./data/bot.db}"
WEB_PORT="${WEB_PORT:-8000}"
SERVICES="${SERVICES:-server}"
# Honoured by docker-entrypoint.sh, which otherwise brings the schema up to date
# on every start — that would migrate this restored DB straight back forward and
# undo the rollback. Lives beside the DB so it travels with the ./data mount.
SENTINEL="$(dirname "$DB")/SKIP_AUTO_MIGRATE"

if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "Usage: $0 <backup.db|backup.db.gz>   (file must exist)" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 not found. Install it: sudo apt-get install -y sqlite3" >&2
  exit 1
fi

# If gzipped, decompress to a temp .db first.
TMP=""
if [[ "$SRC" == *.gz ]]; then
  TMP="$(mktemp --suffix=.db)"
  gunzip -c "$SRC" > "$TMP"
  SRC="$TMP"
fi
cleanup() { [ -n "$TMP" ] && rm -f "$TMP"; }
trap cleanup EXIT

# Verify the BACKUP before we destroy the live DB — never restore garbage.
CHECK="$(sqlite3 "$SRC" 'PRAGMA integrity_check;')"
if [ "$CHECK" != "ok" ]; then
  echo "ERROR: backup failed integrity_check: $CHECK — aborting." >&2
  exit 1
fi

echo "==> Stopping writers: $SERVICES"
docker compose stop $SERVICES

# Pause automatic schema updates BEFORE the swap: the backup we are about to
# restore may predate a schema change, and the container would otherwise apply
# that change again the moment it starts — silently undoing the rollback. Also
# guards any `docker compose run --rm server ...` issued while we work, since
# those go through the entrypoint too.
echo "==> Pausing automatic schema updates ($SENTINEL)"
cat > "$SENTINEL" <<EOF
Created by deploy/backup/restore.sh at $(date +%F' '%T) while restoring:
  $SRC

Automatic schema updates are paused so this restored database is not migrated
forward again, which would undo the rollback.

Delete this file once the running code matches this database's schema:
  rm $SENTINEL
Then: docker compose restart $SERVICES
EOF

# Keep a safety copy of the current DB so a wrong restore is itself reversible.
if [ -f "$DB" ]; then
  PREV="${DB}.pre-restore-$(date +%F-%H%M%S)"
  cp -p "$DB" "$PREV"
  echo "==> Saved current DB to $PREV"
fi

echo "==> Replacing $DB and clearing stale WAL/SHM"
cp -p "$SRC" "$DB"
rm -f "${DB}-wal" "${DB}-shm"      # stale sidecars of the OLD db — must go

# Match the container runtime user (Dockerfile: app:app, uid/gid from -r). The
# entrypoint also chowns ./data, but set it here so a host-side start is clean.
if id app >/dev/null 2>&1; then
  chown app:app "$DB" || true
fi

echo "==> Verifying restored DB"
CHECK2="$(sqlite3 "$DB" 'PRAGMA integrity_check;')"
[ "$CHECK2" = "ok" ] || { echo "ERROR: restored DB integrity_check: $CHECK2" >&2; exit 1; }

echo "==> Starting services"
docker compose start $SERVICES

# Reminder printed on both exit paths below — a forgotten sentinel means the next
# deploy quietly stops updating the schema, which is the failure this repo's
# automatic migration exists to prevent.
remind_sentinel() {
  echo
  echo "NOTE: automatic schema updates are PAUSED by $SENTINEL"
  echo "      Remove it once the deployed code matches this schema:"
  echo "        rm $SENTINEL && docker compose restart $SERVICES"
}

# Smoke: wait for web-admin /healthz to go green (DB ping inside).
echo -n "==> Smoke /healthz "
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/healthz" || true)"
  if [ "$code" = "200" ]; then echo "OK (200)"; remind_sentinel; exit 0; fi
  echo -n "."; sleep 2
done
echo "FAILED — /healthz never returned 200; check logs (docker compose logs server)." >&2
remind_sentinel
exit 1
