#!/usr/bin/env bash
#
# Restore the shop database from a backup (execution/06, M-5). This is also
# the rollback path for a bad migration/deploy: restore the last good backup.
# The database is PostgreSQL; the backup is a `pg_dump -Fc` .dump file.
#
# Procedure: verify the dump, stop the app (`server`), take
# a pg_dump safety copy of the CURRENT live database (so a bad restore is
# itself reversible — postgres itself keeps running, only `server` is
# stopped), `pg_restore --clean --if-exists --single-transaction` into the
# target DB, pause automatic migrations with SKIP_AUTO_MIGRATE, restart
# `server`, smoke /healthz. The entrypoint honors this sentinel, preserving the restored schema until matching code is deployed.
#
# Run on the HOST. Requires docker compose. It needs NO host-side
# postgresql-client: both the dump
# verification and the restore itself run inside the `postgres` container, so
# the client always matches the server version. Stops ALL services that touch
# the DB (order-bot, notifier, web-admin, storefront — currently one combined
# `server` service). The script `cd`s to the repo root itself, so it can be
# invoked from any directory; a relative backup path argument is resolved
# against the directory you invoked it from, before that `cd`.
#
# POSTGRES_USER, POSTGRES_DB, WEB_PORT and DATA_DIR are taken from the
# environment when set there, otherwise from the repo's .env (parsed as
# KEY=VALUE text, never sourced — deploy/backup/lib-env.sh), otherwise the
# defaults below. Every docker compose call, and every command this script tells
# you to run, uses both compose files (docker-compose.yml +
# docker-compose.postgres.prod.yml).
#
# Usage:
#   deploy/backup/restore.sh ./data/backups/pg-2026-06-18-1200.dump
set -euo pipefail

SRC="${1:-}"

if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "Usage: $0 <backup.dump>   (file must exist)" >&2
  exit 1
fi

# Resolve a relative backup path against the CURRENT working directory before
# the `cd` below moves us to the repo root — `restore.sh ./data/backups/x.dump`
# must keep meaning the file the operator just listed with `ls`.
case "$SRC" in
  /*) ;;
  *) SRC="$PWD/$SRC" ;;
esac

# Make the script self-locating, for the same reason backup.sh is: the
# script runs `docker compose -f docker-compose.yml -f
# docker-compose.postgres.prod.yml ...` with RELATIVE compose-file paths,
# which only resolve from the repo root — so without this, invoking
# restore.sh from anywhere else fails with "no configuration file provided".
# deploy/backup/ -> ../.. is the repo root. NOTE: as a result, a relative
# DATA_DIR= override is interpreted relative to the repo root (the backup path
# argument is not — see above).
cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." || {
  echo "ERROR: could not cd to the repo root from $(dirname "${BASH_SOURCE[0]:-$0}")" >&2
  exit 1
}

# POSTGRES_USER/POSTGRES_DB must be the ones the postgres container was created
# with, and WEB_PORT the one the server publishes (a multi-shop host gives every
# shop its own), or this script restores over the wrong database / smokes the
# wrong shop. Taken from the environment when set there, otherwise read from the
# repo's .env as plain KEY=VALUE text (never sourced — deploy/backup/lib-env.sh).
# shellcheck source=deploy/backup/lib-env.sh
. deploy/backup/lib-env.sh
load_env_defaults POSTGRES_USER POSTGRES_DB WEB_PORT DATA_DIR

DATA_DIR="${DATA_DIR:-./data}"
WEB_PORT="${WEB_PORT:-8000}"
SERVICES="${SERVICES:-server}"
COMPOSE=("${BACKUP_COMPOSE[@]}")
# Honoured by docker-entrypoint.sh, which otherwise updates the schema on every
# start and could immediately undo a rollback. ./data is bind-mounted into the
# server container as /app/data, so DATA_DIR must stay that directory for the
# entrypoint to see the sentinel.
SENTINEL="$DATA_DIR/SKIP_AUTO_MIGRATE"

case "$SRC" in
  *.dump) ;;
  *)
    echo "ERROR: unrecognized backup file extension: $SRC (expected .dump)" >&2
    exit 1
    ;;
esac

pause_auto_migrate() {
  local restart_command="$1"
  echo "==> Pausing automatic schema updates ($SENTINEL)"
  cat > "$SENTINEL" <<EOF
Created by deploy/backup/restore.sh at $(date +%F' '%T) while restoring:
  $SRC

Automatic schema updates are paused so this restored database is not migrated
forward again, which would undo the rollback.

Delete this file once the running code matches this database's schema:
  rm $SENTINEL
Then: $restart_command
EOF
}

# ---------------------------------------------------------------------------
# Safety properties: verify the backup before touching anything live, a
# pre-restore safety copy of the current DB, pause migrations, restart, smoke
# /healthz.
# ---------------------------------------------------------------------------
restore_postgres() {
  POSTGRES_USER="${POSTGRES_USER:-bot_order}"
  POSTGRES_DB="${POSTGRES_DB:-bot_order}"

  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found. This script must run on the host with docker compose available." >&2
    exit 1
  fi

  # Verify the BACKUP before we touch the live DB — never restore garbage.
  # Run inside the postgres container (dump piped in over stdin) rather than
  # with a host `pg_restore`: the server is postgres:16-alpine, and an older
  # host client would reject a perfectly good PG16 -Fc dump with "unsupported
  # version ... in file header" — refusing to restore a backup that is
  # actually fine, at the exact moment the operator needs it. The container's
  # own client always matches its server. stderr is captured and printed, not
  # discarded, so a real failure shows the actual diagnostic.
  if ! VERIFY_ERR="$("${COMPOSE[@]}" exec -T postgres pg_restore --list < "$SRC" 2>&1 >/dev/null)"; then
    echo "ERROR: pg_restore --list failed on $SRC — dump looks corrupt. Aborting:" >&2
    echo "$VERIFY_ERR" >&2
    exit 1
  fi

  echo "==> Stopping writers: $SERVICES"
  # shellcheck disable=SC2086 # SERVICES is an intentional word-split list
  "${COMPOSE[@]}" stop $SERVICES

  # Keep a safety copy of the CURRENT live DB so a wrong restore is itself
  # reversible — postgres itself keeps running (only $SERVICES is stopped
  # above), so it can still be dumped. The redirection truncates $PREV before
  # `docker` runs, so on failure remove the useless zero-byte stub rather than
  # leaving something that looks like a rollback point but is not — and abort
  # before touching the live database, since a restore with no safety copy is
  # not a reversible operation.
  PREV="$(dirname "$SRC")/pg-pre-restore-$(date +%F-%H%M%S).dump"
  echo "==> Saving current DB to $PREV"
  if ! "${COMPOSE[@]}" exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$PREV"; then
    rm -f "$PREV"
    echo "ERROR: the pre-restore safety dump failed (see the error above); removed the partial file $PREV." >&2
    echo "       Aborting BEFORE the restore — the live database is untouched. Services are stopped; restart them with: $BACKUP_COMPOSE_TEXT start $SERVICES" >&2
    exit 1
  fi

  # --single-transaction: without it pg_restore exits 0 even when individual
  # statements inside the dump fail, so a half-restored database would sail
  # past this line, pass the /healthz smoke test, and be reported to the
  # operator as a successful rollback. It wraps the whole restore in one
  # BEGIN/COMMIT (a failure leaves the database in its PRE-restore state
  # instead of a partial mess) and implies --exit-on-error, so a real failure
  # actually exits non-zero and `set -e` aborts here. --if-exists is what
  # makes it safe to combine with --clean: the DROPs then no-op instead of
  # erroring out and rolling the whole transaction back.
  echo "==> Restoring $SRC into $POSTGRES_DB"
  if ! "${COMPOSE[@]}" exec -T postgres pg_restore --clean --if-exists --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$SRC"; then
    echo "ERROR: pg_restore failed (see the error above). Because of --single-transaction the whole restore was rolled back, so the database is exactly as it was BEFORE this run — nothing is half-applied." >&2
    echo "       Services are still stopped. Investigate, then either retry with a different backup, or bring the stack back up unchanged: $BACKUP_COMPOSE_TEXT start $SERVICES" >&2
    echo "       The pre-restore safety copy taken above is at: $PREV" >&2
    exit 1
  fi

  # Prevent the entrypoint's schema push, ledger seed, and data-only migrations
  # from immediately advancing the just-restored database on server start.
  pause_auto_migrate "$BACKUP_COMPOSE_TEXT restart $SERVICES"

  echo "==> Starting services"
  # shellcheck disable=SC2086 # SERVICES is an intentional word-split list
  "${COMPOSE[@]}" start $SERVICES
}

restore_postgres

# A forgotten sentinel keeps future schema updates paused.
remind_sentinel() {
  local restart_command="$BACKUP_COMPOSE_TEXT restart $SERVICES"
  echo
  echo "NOTE: automatic schema updates are PAUSED by $SENTINEL"
  echo "      Remove it once the deployed code matches this schema:"
  echo "        rm $SENTINEL && $restart_command"
}

# Smoke: wait for web-admin /healthz to go green (DB ping inside).
echo -n "==> Smoke /healthz "
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/healthz" || true)"
  if [ "$code" = "200" ]; then echo "OK (200)"; remind_sentinel; exit 0; fi
  echo -n "."; sleep 2
done
echo "FAILED — /healthz never returned 200; check logs ($BACKUP_COMPOSE_TEXT logs $SERVICES)." >&2
remind_sentinel
exit 1
