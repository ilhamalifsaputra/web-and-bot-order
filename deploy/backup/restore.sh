#!/usr/bin/env bash
#
# Restore the shop database from a backup (execution/06, M-5). This is also
# the rollback path for a bad migration/deploy: restore the last good backup.
# Engine-aware: detected from the backup file's extension, so this ONE
# script/operator command keeps working across the SQLite -> Postgres
# cutover (docs/POSTGRES_MIGRATION.md) — no manual script swap needed.
#
# SQLite (.db / .db.gz) procedure (WAL-safe): stop every writer, pause the
# container's automatic schema update (otherwise it migrates the restored DB
# forward again and undoes the rollback), swap the file, DELETE the stale
# -wal/-shm (they belong to the OLD db — keeping them corrupts the restore),
# fix ownership, integrity-check, restart, smoke /healthz.
#
# Postgres (.dump) procedure: verify the dump, stop the app (`server`), take
# a pg_dump safety copy of the CURRENT live database (so a bad restore is
# itself reversible — postgres itself keeps running, only `server` is
# stopped), `pg_restore --clean --if-exists` into the target DB, restart
# `server`, smoke /healthz. No SKIP_AUTO_MIGRATE sentinel needed on this path
# — docker-entrypoint.sh's auto_migrate() already no-ops entirely for
# non-`file:` DATABASE_URL_PRISMA values (docker-entrypoint.sh:99-102).
#
# Run on the HOST. Requires docker compose; sqlite3 for the SQLite path;
# pg_restore (postgresql-client) on the host for the Postgres path. Stops ALL
# services that touch the DB (order-bot, notifier, web-admin, storefront —
# currently one combined `server` service).
#
# Usage:
#   deploy/backup/restore.sh ./data/backups/bot-2026-06-18-1200.db
#   deploy/backup/restore.sh ./data/backups/bot-2026-06-18-1200.db.gz   # gz ok
#   deploy/backup/restore.sh ./data/backups/pg-2026-06-18-1200.dump     # Postgres
set -euo pipefail

SRC="${1:-}"
DB="${DB:-./data/bot.db}"
WEB_PORT="${WEB_PORT:-8000}"
SERVICES="${SERVICES:-server}"
# Honoured by docker-entrypoint.sh, which otherwise brings the schema up to date
# on every start — that would migrate a restored SQLite DB straight back forward
# and undo the rollback. Lives beside the DB so it travels with the ./data mount.
# (Only ever written on the SQLite path — see restore_sqlite below.)
SENTINEL="$(dirname "$DB")/SKIP_AUTO_MIGRATE"

if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "Usage: $0 <backup.db|backup.db.gz|backup.dump>   (file must exist)" >&2
  exit 1
fi

# Which code path to run: inspect the backup file's extension.
detect_engine() {
  case "$SRC" in
    *.db | *.db.gz) echo "sqlite" ;;
    *.dump) echo "postgres" ;;
    *) echo "unknown" ;;
  esac
}

# ---------------------------------------------------------------------------
# SQLite path — logic unchanged from the pre-engine-aware script (only its
# surrounding structure, now a function, changed).
# ---------------------------------------------------------------------------
restore_sqlite() {
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
}

# ---------------------------------------------------------------------------
# Postgres path — mirrors the SQLite path's safety properties: verify the
# backup before touching anything live, a pre-restore safety copy of the
# current DB, restart, smoke /healthz. No sentinel: see header comment.
# ---------------------------------------------------------------------------
restore_postgres() {
  POSTGRES_USER="${POSTGRES_USER:-bot_order}"
  POSTGRES_DB="${POSTGRES_DB:-bot_order}"
  COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml)

  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found. This script must run on the host with docker compose available." >&2
    exit 1
  fi
  if ! command -v pg_restore >/dev/null 2>&1; then
    echo "ERROR: pg_restore not found. Install it: sudo apt-get install -y postgresql-client" >&2
    exit 1
  fi

  # Verify the BACKUP before we touch the live DB — never restore garbage.
  if ! pg_restore --list "$SRC" >/dev/null 2>&1; then
    echo "ERROR: pg_restore --list failed on $SRC — dump looks corrupt. Aborting." >&2
    exit 1
  fi

  echo "==> Stopping writers: $SERVICES"
  docker compose stop $SERVICES

  # Keep a safety copy of the CURRENT live DB so a wrong restore is itself
  # reversible — postgres itself keeps running (only $SERVICES is stopped
  # above), so it can still be dumped.
  PREV="$(dirname "$SRC")/pg-pre-restore-$(date +%F-%H%M%S).dump"
  echo "==> Saving current DB to $PREV"
  "${COMPOSE[@]}" exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$PREV"

  echo "==> Restoring $SRC into $POSTGRES_DB"
  "${COMPOSE[@]}" exec -T postgres pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$SRC"

  echo "==> Starting services"
  docker compose start $SERVICES
}

ENGINE="$(detect_engine)"
case "$ENGINE" in
  sqlite) restore_sqlite ;;
  postgres) restore_postgres ;;
  *)
    echo "ERROR: unrecognized backup file extension: $SRC (expected .db, .db.gz, or .dump)" >&2
    exit 1
    ;;
esac

# Reminder printed on both exit paths below — SQLite only: a forgotten
# sentinel means the next deploy quietly stops updating the schema, which is
# the failure this repo's automatic migration exists to prevent. The Postgres
# path never writes this sentinel (see header comment), so it's a no-op there.
remind_sentinel() {
  [ "$ENGINE" = "sqlite" ] || return 0
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
