#!/bin/sh
# Container entrypoint: fix the bind-mounted data dir's ownership, bring the
# database schema up to date (snapshot first), then drop privileges to the
# non-root `app` user before running the service.
#
# Why the chown: ./data is bind-mounted from the host (docker-compose.yml). A
# bind mount keeps the host's ownership, so after `git clone` the dir is
# root-owned and the non-root runtime user (UID 999) cannot write the logs,
# uploads or the auto-generated credential key. Starting as root lets us chown
# it, so a fresh clone just works with no manual `chown` on the host.
#
# Why the schema step lives here: CLAUDE.md requires the schema to be applied
# BEFORE the new code runs, or every query touching a new column dies with
# `P2022 column ... does not exist`. The entrypoint is the only place that
# guarantees that order on EVERY start path — `up`, `restart`, and the
# automatic restart after a crash all pass through it, whereas a compose
# `depends_on` migrator service is only evaluated on `up` (so
# `docker compose restart server` would silently skip it). Full background,
# including the manual equivalent, is in docs/MIGRATIONS.md.
#
# The database is PostgreSQL (postgresql:// in DATABASE_URL_PRISMA): `prisma db
# push`, then the ledger chart-of-accounts seed, then the data-only migrations
# listed in $DATA_MIGRATIONS. No snapshot is taken: the Postgres dump runs on the
# host, not in this container (see postgres_migrate's own comment). A deploy is
# therefore just `docker compose ... up -d --build`.
set -e

# Where the app is installed. Always /app in this image (Dockerfile WORKDIR);
# overridable so the schema logic below can be exercised outside a container.
APP_ROOT="${APP_ROOT:-/app}"
DATA_DIR="$APP_ROOT/data"
SKIP_SENTINEL="$DATA_DIR/SKIP_AUTO_MIGRATE"
PRISMA="$APP_ROOT/node_modules/.bin/prisma"
TSX="$APP_ROOT/node_modules/.bin/tsx"
SCHEMA="$APP_ROOT/prisma/schema.prisma"
CREDENTIAL_KEY_FILE="$DATA_DIR/credential_encryption.key"
LEDGER_SEED="$APP_ROOT/scripts/seed-chart-of-accounts.ts"

# Data-only migrations re-applied after every successful schema push on the
# Postgres path. These are the releases' steps that `prisma db push` cannot
# carry: db push only ever syncs STRUCTURE, so a migration that seeds or
# backfills ROWS has to be executed separately or it silently never happens.
#
# Every file named here MUST be safe to run again on an already-migrated
# database — an `ON CONFLICT DO NOTHING` insert, an idempotent `UPDATE ... WHERE
# <not yet done>`, or equivalent. The entrypoint re-runs the whole list on EVERY
# start, because there is nothing to consult about what already ran: this repo
# deploys with `db push`, which never writes `_prisma_migrations`
# (docs/MIGRATIONS.md). A file that is not idempotent would therefore be
# re-applied on every restart.
#
# When a release ships a new data-only migration, append its folder name here
# (space-separated, oldest first) and state in the migration's own header comment
# why re-running it is safe.
DATA_MIGRATIONS="20260919120000_seed_usdt_rounding_ceil_since"

# Bounded wait for the database to accept connections before the schema push.
# Overridable so the wait can be shortened in tests; 10 x 2s is the default.
DB_WAIT_ATTEMPTS="${DB_WAIT_ATTEMPTS:-10}"
DB_WAIT_SECONDS="${DB_WAIT_SECONDS:-2}"

# Set once the effective user is known: the prefix that runs a command as the
# unprivileged `app` user (empty when we are already that user).
RUN_AS=""

log() { echo "entrypoint: $*"; }

# `prisma db push` syncs schema.prisma → DB. Deliberately WITHOUT
# --accept-data-loss: if a change would drop data, the push must fail and
# crash-loop the container (loud, visible) rather than quietly delete rows.
# Resolve those by hand — docs/MIGRATIONS.md has the procedure.
db_push() {
  # shellcheck disable=SC2086 # RUN_AS is an intentional word-split prefix
  if ! $RUN_AS "$PRISMA" db push --schema "$SCHEMA" --skip-generate; then
    log "ERROR: 'prisma db push' failed, so the container will not start. The most common cause is a change Prisma cannot apply without dropping data (it refuses non-interactively on purpose). Fix it by making the change additive first — add the column as nullable or with a default, backfill, then tighten it in a second push. Procedure: docs/MIGRATIONS.md." >&2
    exit 1
  fi
}

# Wait until the datasource actually answers a query, then hand over to db_push.
#
# docker-compose.postgres.prod.yml already gates `server` on the postgres
# service's `service_healthy` condition, so by the time this runs `pg_isready`
# has succeeded at least once. That proves the server answered a health probe —
# not that it is accepting this role's connections: a first-boot Postgres
# container runs its init scripts against a temporary server and restarts the
# real one afterwards, and an external/managed Postgres has no depends_on gate at
# all. A few seconds of retrying turns that race into a short pause instead of a
# crash-loop.
#
# Only a connection problem is retried. Anything else — wrong password, missing
# database, a schema change Prisma refuses — falls through to db_push(), whose
# own error message is the one an operator needs to read.
wait_for_database() {
  _attempt=1
  while [ "$_attempt" -le "$DB_WAIT_ATTEMPTS" ]; do
    # shellcheck disable=SC2086 # RUN_AS is an intentional word-split prefix
    if printf 'SELECT 1;\n' | $RUN_AS "$PRISMA" db execute --schema "$SCHEMA" --stdin >/dev/null 2>&1; then
      return 0
    fi
    log "The database is not accepting connections yet (attempt $_attempt of $DB_WAIT_ATTEMPTS) — waiting ${DB_WAIT_SECONDS}s before trying again."
    sleep "$DB_WAIT_SECONDS"
    _attempt=$((_attempt + 1))
  done
  log "WARNING: the database still did not answer a 'SELECT 1' after $DB_WAIT_ATTEMPTS attempts. Attempting the schema push anyway, so that its own error message — which names the real cause — reaches this log instead of a generic timeout."
  return 0
}

# Installs the Financial Ledger's chart of accounts (scripts/seed-chart-of-accounts.ts,
# also `pnpm seed-chart-of-accounts`). Every ledger posting site resolves the
# account it needs by `code`, so on a database where this has never run, order
# settlements, wallet top-ups, manual wallet adjustments and referral commissions
# record NOTHING — the posting is skipped, not retried. The script is an
# idempotent upsert keyed on `code`, so re-running it on every start is a no-op
# once the accounts exist.
#
# Why a failure here warns instead of refusing to start: the schema push above
# has already succeeded by this point, so exiting would crash-loop the container
# with the schema half-deployed and no running service to fix it from. Worse, the
# script exits non-zero for two things that are NOT failures — an account whose
# stored type/currency disagrees with CHART_OF_ACCOUNTS, and an active account the
# chart no longer lists. Both are accounting decisions about rows that may already
# carry posted entries (see the script's own header), and taking the shop offline
# over a bookkeeping question is the wrong trade.
seed_ledger_accounts() {
  if [ ! -f "$LEDGER_SEED" ] || [ ! -x "$TSX" ]; then
    log "WARNING: skipped the ledger chart-of-accounts seed because $LEDGER_SEED or $TSX is missing from this image — if it was built from this repo's Dockerfile, this should never happen. Until the seed runs, every ledger posting fails to resolve its account and the money that moved is not recorded. Run it by hand after fixing the image: docker compose run --rm server pnpm seed-chart-of-accounts" >&2
    return 0
  fi

  log "Seeding the ledger chart of accounts (idempotent upsert on the account code)."
  set +e
  # shellcheck disable=SC2086 # RUN_AS is an intentional word-split prefix
  $RUN_AS "$TSX" "$LEDGER_SEED"
  _rc=$?
  set -e
  if [ "$_rc" -ne 0 ]; then
    log "WARNING: the ledger chart-of-accounts seed exited $_rc — read its own output just above to tell the two cases apart. A drifted chart (an account classified differently from CHART_OF_ACCOUNTS, or an active account the chart no longer lists) needs an accounting decision, not a re-run. A genuine failure needs the cause fixed and this command re-run: docker compose run --rm server pnpm seed-chart-of-accounts. Start-up continues either way, because the schema push already succeeded — but ledger postings for accounts that are missing will be skipped until this is resolved." >&2
    return 0
  fi
  log "Ledger chart of accounts is seeded."
}

# Re-applies every file in $DATA_MIGRATIONS (see its comment for the idempotency
# contract). A failure warns rather than exits for the same reason the seed does:
# the schema is already pushed, and a container that refuses to start cannot be
# used to repair anything.
apply_data_migrations() {
  for _name in $DATA_MIGRATIONS; do
    _file="$APP_ROOT/prisma/migrations/$_name/migration.sql"
    if [ ! -f "$_file" ]; then
      log "WARNING: the data-only migration $_name is listed in docker-entrypoint.sh but $_file is not in this image, so it was skipped. Either the image predates that migration (rebuild it) or the list and prisma/migrations/ disagree." >&2
      continue
    fi
    set +e
    # shellcheck disable=SC2086 # RUN_AS is an intentional word-split prefix
    $RUN_AS "$PRISMA" db execute --schema "$SCHEMA" --file "$_file"
    _rc=$?
    set -e
    if [ "$_rc" -ne 0 ]; then
      log "WARNING: the data-only migration $_name failed (prisma db execute exited $_rc). Start-up continues, because the schema push already succeeded and these migrations only seed or backfill rows. Each one documents in its header what an unapplied state means for the app; fix the cause, then re-run just that file: docker compose run --rm server pnpm exec prisma db execute --schema prisma/schema.prisma --file prisma/migrations/$_name/migration.sql" >&2
      continue
    fi
    log "Applied the data-only migration $_name (it is written to be safe to re-run, so this is a no-op once it has taken effect)."
  done
}

# The whole Postgres deploy sequence: schema, then the row-level steps a schema
# push cannot carry. Automating it here is what lets a release deploy with a
# plain `docker compose ... up -d --build`, with the guarantee that the schema is
# current BEFORE any application code runs, on every start path including
# `restart` and the automatic restart after a crash.
postgres_migrate() {
  log "DATABASE_URL_PRISMA points at PostgreSQL — bringing the schema up to date, then applying this release's row-level steps."
  # No pre-push snapshot exists on this path, deliberately. deploy/backup/backup.sh's
  # Postgres branch dumps by running pg_dump INSIDE the postgres container via
  # `docker compose exec` (deploy/backup/README.md), which needs a Docker socket
  # this container does not have; installing postgresql-client here instead would
  # ship a client older than the postgres:16 server and produce dumps that server
  # rejects. What protects the data is db_push()'s refusal to accept data loss:
  # any change that would drop rows fails the push and stops the container.
  log "No pre-deploy snapshot is taken on the Postgres path (the dump runs on the host, not in this container). 'prisma db push' below still refuses any change that would drop data. Recommended before every deploy: take a dump yourself — see 'Backup — Postgres' in deploy/backup/README.md."
  wait_for_database
  db_push
  log "Schema is in sync with schema.prisma."
  seed_ledger_accounts
  apply_data_migrations
}

auto_migrate() {
  case "$(printf '%s' "${AUTO_MIGRATE:-1}" | tr 'A-Z' 'a-z')" in
    0 | false | no | off)
      log "AUTO_MIGRATE is off — starting without checking the schema. Apply changes yourself (docs/MIGRATIONS.md) or new columns will fail with P2022."
      return 0
      ;;
  esac

  # Escape hatch for a rollback: deploy/backup/restore.sh drops this file after
  # restoring an older backup, so the container does not immediately migrate
  # that DB forward again and undo the rollback.
  if [ -f "$SKIP_SENTINEL" ]; then
    log "Found $SKIP_SENTINEL, so the database schema is left exactly as it is. Delete that file when you want automatic schema updates back. It says:"
    sed 's/^/  | /' "$SKIP_SENTINEL" 2>/dev/null || true
    return 0
  fi

  if [ ! -x "$PRISMA" ]; then
    log "WARNING: no Prisma CLI at $PRISMA, so the schema cannot be checked. Starting anyway — if the image was built correctly this should never happen."
    return 0
  fi

  # schema.prisma's datasource provider is "postgresql", so there is no default
  # to fall back to. Fail loud and immediately with a clear "you forgot to set
  # this" error instead of a confusing `prisma db push` failure.
  if [ -z "${DATABASE_URL_PRISMA:-}" ]; then
    log "ERROR: DATABASE_URL_PRISMA is not set. schema.prisma requires a postgresql:// connection string — set DATABASE_URL_PRISMA=postgresql://<user>:<password>@postgres:5432/<db> in .env (see .env.example). Refusing to start." >&2
    exit 1
  fi

  # Handled in full (schema push, ledger chart-of-accounts seed, data-only
  # migrations), so a release deploys with nothing but
  # `docker compose ... up -d --build`.
  case "$DATABASE_URL_PRISMA" in
    postgres://* | postgresql://*)
      postgres_migrate
      return 0
      ;;
  esac

  log "ERROR: DATABASE_URL_PRISMA is not a postgresql:// URL, and PostgreSQL is the only supported database. Refusing to start. Set DATABASE_URL_PRISMA=postgresql://<user>:<password>@postgres:5432/<db> in .env (see .env.example)." >&2
  exit 1
}

# Auto-generates CREDENTIAL_ENCRYPTION_KEY on first boot so a production
# deploy needs no manual secret setup (see .env.example's CREDENTIAL
# ENCRYPTION section for the manual-key path this replaces). Persisted to
# $CREDENTIAL_KEY_FILE — deliberately NOT in .env or the database, so a
# Postgres-only compromise doesn't also leak the key that decrypts what it
# stores (encrypted Settings like the Digiflazz API key, and manual-account
# stock credentials). Losing this file makes all of that permanently
# unreadable, so it must be part of whatever backs up the host's ./data.
ensure_credential_key() {
  if [ -n "${CREDENTIAL_ENCRYPTION_KEY:-}" ]; then
    # Operator already configured it (e.g. multi-instance, or a deliberate
    # rotation in progress) — never override.
    return 0
  fi

  if [ -f "$CREDENTIAL_KEY_FILE" ]; then
    _key="$(cat "$CREDENTIAL_KEY_FILE")"
    if ! printf '%s' "$_key" | grep -Eq '^[0-9a-fA-F]{64}$'; then
      log "ERROR: $CREDENTIAL_KEY_FILE does not contain a valid 64-character hex key. Refusing to start: regenerating would silently orphan every credential already encrypted under the old key. Restore the correct file from backup, or if you accept the data loss, remove the file and restart." >&2
      exit 1
    fi
    # Re-assert permissions in case the file arrived via a restore/tar that
    # didn't preserve them (e.g. 0644) — cheap no-op otherwise.
    chmod 600 "$CREDENTIAL_KEY_FILE" 2>/dev/null || true
    export CREDENTIAL_ENCRYPTION_KEY="$_key"
    return 0
  fi

  _key="$(openssl rand -hex 32)"
  # umask 077 in the same subshell as the write closes the brief window
  # where the file would otherwise exist at the image's default mode
  # (typically 0644) before the chmod below narrows it.
  if ! (umask 077; printf '%s' "$_key" > "$CREDENTIAL_KEY_FILE"); then
    log "ERROR: could not write $CREDENTIAL_KEY_FILE — the data directory must be writable to auto-generate the credential encryption key. Either make it writable, or set CREDENTIAL_ENCRYPTION_KEY yourself (see .env.example)." >&2
    exit 1
  fi
  chmod 600 "$CREDENTIAL_KEY_FILE" 2>/dev/null || true
  if [ "$(id -u)" = "0" ]; then
    chown app:app "$CREDENTIAL_KEY_FILE" 2>/dev/null || true
  fi
  log "Generated a new credential encryption key at $CREDENTIAL_KEY_FILE. This file must be part of your backups — losing it makes every already-encrypted credential (Settings like the Digiflazz API key, and any manual-account stock item) permanently unreadable. The key itself is never written to this log."
  export CREDENTIAL_ENCRYPTION_KEY="$_key"
}

main() {
  # chown only when needed (cheap no-op once owned; tolerate read-only mounts).
  if [ "$(id -u)" = "0" ]; then
    chown -R app:app "$DATA_DIR" 2>/dev/null || true
    # gosu does not reset HOME; point it at app's home so pnpm/corepack caches are
    # writable (PNPM_HOME is already /pnpm via ENV).
    export HOME=/home/app
    # Run the schema work as `app` too, so any file it creates is owned by the
    # user that later runs the app.
    RUN_AS="gosu app"
  fi

  ensure_credential_key
  auto_migrate

  if [ -n "$RUN_AS" ]; then
    exec gosu app "$@"
  fi

  # Already non-root (e.g. compose `user:` override) — run as-is.
  exec "$@"
}

# ENTRYPOINT_TEST_SOURCE_ONLY lets deploy/test-entrypoint-credential-key.sh
# source this file (with APP_ROOT pointed at a temp dir) to reuse
# ensure_credential_key() and its helpers without running the real
# migration/exec sequence. This must never be set in a real container's
# environment — if it were (e.g. an accidental line in .env, which compose
# passes through via env_file), the entrypoint would source the script,
# call nothing, and exit 0 with no diagnostic at all.
if [ -z "${ENTRYPOINT_TEST_SOURCE_ONLY:-}" ]; then
  main "$@"
fi
