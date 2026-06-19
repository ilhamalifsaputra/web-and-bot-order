#!/usr/bin/env bash
#
# Restore the shared SQLite DB from a backup (execution/06, M-5). This is also
# the rollback path for a bad migration/deploy: restore the last good backup.
#
# Procedure (WAL-safe): stop every writer, swap the file, DELETE the stale
# -wal/-shm (they belong to the OLD db — keeping them corrupts the restore),
# fix ownership, integrity-check, restart, smoke /healthz.
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
SERVICES="${SERVICES:-order-bot notifier web-admin storefront}"

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

# Smoke: wait for web-admin /healthz to go green (DB ping inside).
echo -n "==> Smoke /healthz "
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/healthz" || true)"
  if [ "$code" = "200" ]; then echo "OK (200)"; exit 0; fi
  echo -n "."; sleep 2
done
echo "FAILED — /healthz never returned 200; check logs (docker compose logs web-admin)." >&2
exit 1
