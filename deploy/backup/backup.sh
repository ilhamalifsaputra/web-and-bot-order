#!/usr/bin/env bash
#
# Online backup of the shop database (execution/06, M-5). Engine-aware: picks
# the SQLite or Postgres code path below by inspecting DATABASE_URL_PRISMA —
# the same variable the app itself reads — so this ONE script/cron entry
# keeps working unchanged across the SQLite -> Postgres cutover
# (docs/POSTGRES_MIGRATION.md). No manual script swap needed at cutover time.
#
# SQLite path (DATABASE_URL_PRISMA unset, or file:... — today's default):
#   Uses the SQLite ".backup" command, which takes a CONSISTENT snapshot
#   through the online-backup API even while the bot/web are writing — it
#   folds in the -wal contents, so (unlike `cp bot.db`) you never lose the
#   un-checkpointed transactions sitting in bot.db-wal. Zero downtime.
#   Requires sqlite3:
#     Debian/Ubuntu VPS:  sudo apt-get update && sudo apt-get install -y sqlite3
#
# Postgres path (postgres:// or postgresql://): `pg_dump -Fc` (custom format —
# already compressed and restorable with `pg_restore`) run *inside* the
# `postgres` container via `docker compose exec`, since the prod compose
# overlay deliberately does not publish Postgres's port to the host
# (docker-compose.postgres.prod.yml). The dump is also VERIFIED inside that
# same container, so the only host requirement on this path is `docker` — no
# host-side postgresql-client/pg_restore is needed (and a host client older
# than the server would in fact reject a perfectly good PG16 dump).
#
# Run on the HOST (the SQLite DB lives in the bind-mounted ./data; the
# `postgres` container's data lives in its own named volume). The script
# `cd`s to the repo root itself (see below), so it can be invoked from any
# directory — including cron, whose working directory is $HOME.
#
# Usage:
#   deploy/backup/backup.sh                 # uses defaults below
#   DB=/srv/app/data/bot.db DEST=/srv/backups RETENTION=28 deploy/backup/backup.sh
#   # Postgres path: POSTGRES_USER/POSTGRES_DB come from .env (docker compose
#   # reads it automatically for variable interpolation); DEST/RETENTION work
#   # exactly the same as above.
#
# Cron (every 6h, log to file) — `crontab -e`:
#   0 */6 * * * DB=/srv/app/data/bot.db DEST=/srv/backups /srv/app/deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1
set -euo pipefail

# Make the script self-locating: the Postgres path runs `docker compose -f
# docker-compose.yml -f docker-compose.postgres.prod.yml ...` with RELATIVE
# compose-file paths, which only resolve from the repo root. Cron runs jobs
# with the working directory set to $HOME, so without this the Postgres path
# would fail on every scheduled run with "no configuration file provided".
# deploy/backup/ -> ../.. is the repo root. Harmless for the SQLite path: its
# documented production invocation passes absolute DB=/DEST=, and its relative
# defaults (./data/bot.db, ./data/backups) are *meant* to be repo-root
# relative anyway — which is exactly what they now always are. NOTE: as a
# result, relative DB=/DEST= values are interpreted relative to the repo root,
# not to the directory you invoked the script from.
cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." || {
  echo "ERROR: could not cd to the repo root from $(dirname "${BASH_SOURCE[0]:-$0}")" >&2
  exit 1
}

DEST="${DEST:-./data/backups}"
RETENTION="${RETENTION:-28}"          # how many timestamped backups to keep
STAMP="$(date +%F-%H%M%S)"

# Which code path to run: inspect DATABASE_URL_PRISMA, the same variable the
# app itself reads (packages/db). Unset -> today's SQLite default, so cron
# jobs that don't export it (the common case pre-cutover) keep working
# exactly as before.
detect_engine() {
  case "${DATABASE_URL_PRISMA:-}" in
    "" | file:*) echo "sqlite" ;;
    postgres://* | postgresql://*) echo "postgres" ;;
    *) echo "unknown" ;;
  esac
}

# ---------------------------------------------------------------------------
# SQLite path — logic unchanged from the pre-engine-aware script (only its
# surrounding structure, now a function, changed).
# ---------------------------------------------------------------------------
backup_sqlite() {
  DB="${DB:-./data/bot.db}"
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

  OFFBOX_FILE="$OUT.gz"
}

# ---------------------------------------------------------------------------
# Postgres path — mirrors the SQLite path's safety properties: verify before
# trusting the backup, retention pruning, never touching credentials.
# ---------------------------------------------------------------------------
backup_postgres() {
  # Read directly from env — never parsed out of DATABASE_URL_PRISMA, and
  # POSTGRES_PASSWORD is never read/echoed here at all. Defaults match
  # docker-compose.postgres.prod.yml's own fallback (${POSTGRES_USER:-bot_order}
  # etc.), so a .env that only sets DATABASE_URL_PRISMA still works.
  POSTGRES_USER="${POSTGRES_USER:-bot_order}"
  POSTGRES_DB="${POSTGRES_DB:-bot_order}"
  OUT="${DEST}/pg-${STAMP}.dump"
  COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml)

  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not found. This script must run on the host with docker compose available." >&2
    exit 1
  fi

  mkdir -p "$DEST"

  # `-Fc` (custom format): already compressed, restorable with pg_restore, and
  # works whether or not Postgres's port is published to the host — the prod
  # overlay deliberately doesn't publish it, so this runs *inside* the
  # postgres container via `exec`, not against a host-side pg_dump.
  #
  # The redirection creates/truncates $OUT before `docker` even starts, so a
  # failing dump would otherwise leave a zero-byte file behind — and `set -e`
  # would abort before the verify-and-delete step below could clean it up.
  # Those stubs are worse than nothing: retention pruning is purely
  # timestamp-ordered, so on a later run the newest (zero-byte) files are the
  # ones it keeps, and it prunes real backups instead. Delete it explicitly.
  if ! "${COMPOSE[@]}" exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$OUT"; then
    rm -f "$OUT"
    echo "ERROR: pg_dump failed (see the error above); removed the partial file $OUT." >&2
    exit 1
  fi

  # Verify the dump's table of contents parses before we trust/rotate it — the
  # closest analogue to PRAGMA integrity_check that doesn't require restoring
  # into a scratch database.
  #
  # Run INSIDE the postgres container (dump piped back in over stdin) rather
  # than with a host `pg_restore`: the server is postgres:16-alpine, and a
  # host client older than the server (what plain `apt-get install
  # postgresql-client` gives on several distros) rejects a PG16 -Fc dump with
  # "unsupported version ... in file header". With a host binary that
  # false negative would delete a perfectly good backup on EVERY run. The
  # container's own client always matches its server.
  #
  # stderr is captured, not discarded, so a real failure prints the actual
  # diagnostic — the same way the SQLite path surfaces integrity_check output.
  if ! VERIFY_ERR="$("${COMPOSE[@]}" exec -T postgres pg_restore --list < "$OUT" 2>&1 >/dev/null)"; then
    echo "ERROR: pg_restore --list failed on $OUT — dump looks corrupt:" >&2
    echo "$VERIFY_ERR" >&2
    rm -f "$OUT"
    exit 1
  fi

  SIZE="$(du -h "$OUT" | cut -f1)"
  echo "OK  backup=$OUT (${SIZE}, pg_restore --list=ok)"

  # Retention: keep the newest $RETENTION *.dump; prune the rest. Glob is
  # anchored to pg-<digits>... (real backup filenames start with the year,
  # e.g. pg-2026-08-28-153000.dump) so it can never match restore.sh's
  # pg-pre-restore-<stamp>.dump safety copy, which would otherwise compete
  # for this same retention budget/namespace when it lands in $DEST.
  mapfile -t OLD < <(ls -1t "${DEST}"/pg-[0-9]*.dump 2>/dev/null | tail -n +"$((RETENTION + 1))")
  for f in "${OLD[@]:-}"; do
    [ -n "$f" ] || continue
    rm -f "$f"
    echo "pruned $f"
  done

  OFFBOX_FILE="$OUT"
}

case "$(detect_engine)" in
  sqlite) backup_sqlite ;;
  postgres) backup_postgres ;;
  *)
    echo "ERROR: DATABASE_URL_PRISMA is set to something this script does not recognize (expected unset, file:..., or postgres(ql)://...)." >&2
    exit 1
    ;;
esac

# OPTIONAL off-box copy (uncomment & set a target — meets the 3-2-1 rule):
#   rsync -a "$OFFBOX_FILE" backups@offsite:/srv/bot-backups/   || echo "WARN: off-box rsync failed" >&2
#   aws s3 cp "$OFFBOX_FILE" "s3://my-bucket/bot-backups/"      || echo "WARN: s3 upload failed"   >&2
