#!/usr/bin/env bash
#
# Online backup of the shop database (execution/06, M-5). The database is
# PostgreSQL, so this takes a dump of it.
#
# `pg_dump -Fc` (custom format —
# already compressed and restorable with `pg_restore`) run *inside* the
# `postgres` container via `docker compose exec`, since the prod compose
# overlay deliberately does not publish Postgres's port to the host
# (docker-compose.postgres.prod.yml). The dump is also VERIFIED inside that
# same container, so the only host requirement on this path is `docker` — no
# host-side postgresql-client/pg_restore is needed (and a host client older
# than the server would in fact reject a perfectly good PG16 dump).
#
# Run on the HOST (the `postgres` container's data lives in its own named
# volume; backups are written to the host's ./data/backups by default). The script
# `cd`s to the repo root itself (see below), so it can be invoked from any
# directory — including cron, whose working directory is $HOME.
#
# Usage:
#   deploy/backup/backup.sh                 # uses defaults below
#   DEST=/srv/backups RETENTION=28 deploy/backup/backup.sh
#   # POSTGRES_USER/POSTGRES_DB come from .env (docker compose
#   # reads it automatically for variable interpolation); DEST/RETENTION are
#   # optional overrides.
#
# Cron (every 6h, log to file) — `crontab -e`:
#   0 */6 * * * DEST=/srv/backups /srv/app/deploy/backup/backup.sh >> /var/log/bot-backup.log 2>&1
set -euo pipefail

# Make the script self-locating: it runs `docker compose -f docker-compose.yml
# -f docker-compose.postgres.prod.yml ...` with RELATIVE compose-file paths,
# which only resolve from the repo root. Cron runs jobs with the working
# directory set to $HOME, so without this every scheduled run would fail with
# "no configuration file provided". deploy/backup/ -> ../.. is the repo root.
# NOTE: as a result, a relative DEST= value is interpreted relative to the repo
# root, not to the directory you invoked the script from.
cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." || {
  echo "ERROR: could not cd to the repo root from $(dirname "${BASH_SOURCE[0]:-$0}")" >&2
  exit 1
}

DEST="${DEST:-./data/backups}"
RETENTION="${RETENTION:-28}"          # how many timestamped backups to keep
STAMP="$(date +%F-%H%M%S)"

# Guard against a stale non-Postgres URL: the app itself refuses to start with
# one, so a backup taken against it would not be a backup of the live database.
# Unset is fine — cron jobs rarely export it, and compose reads .env itself.
case "${DATABASE_URL_PRISMA:-}" in
  "" | postgres://* | postgresql://*) ;;
  *)
    echo "ERROR: DATABASE_URL_PRISMA is set to something this script does not recognize (expected a postgres(ql):// URL)." >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Safety properties: verify before trusting the backup, retention pruning,
# never touching credentials.
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

  # Verify the dump's table of contents parses before we trust/rotate it — a
  # cheap integrity check that doesn't require restoring into a scratch
  # database.
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
  # diagnostic.
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

backup_postgres

# OPTIONAL off-box copy (uncomment & set a target — meets the 3-2-1 rule):
#   rsync -a "$OFFBOX_FILE" backups@offsite:/srv/bot-backups/   || echo "WARN: off-box rsync failed" >&2
#   aws s3 cp "$OFFBOX_FILE" "s3://my-bucket/bot-backups/"      || echo "WARN: s3 upload failed"   >&2
