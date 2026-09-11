#!/bin/sh
# Container entrypoint: fix the bind-mounted data dir's ownership, bring the
# database schema up to date (snapshot first), then drop privileges to the
# non-root `app` user before running the service.
#
# Why the chown: ./data is bind-mounted from the host (docker-compose.yml). A
# bind mount keeps the host's ownership, so after `git clone` the dir is
# root-owned and the non-root runtime user (UID 999) cannot write the SQLite DB
# — the web-admin upsert then fails with "attempt to write a readonly database"
# (HTTP 500). Starting as root lets us chown it, so a fresh clone just works
# with no manual `chown` on the host.
#
# Why the schema step lives here: CLAUDE.md requires the schema to be applied
# BEFORE the new code runs, or every query touching a new column dies with
# `P2022 column ... does not exist`. The entrypoint is the only place that
# guarantees that order on EVERY start path — `up`, `restart`, and the
# automatic restart after a crash all pass through it, whereas a compose
# `depends_on` migrator service is only evaluated on `up` (so
# `docker compose restart server` would silently skip it). Full background,
# including the manual equivalent, is in docs/MIGRATIONS.md.
set -e

# Where the app is installed. Always /app in this image (Dockerfile WORKDIR);
# overridable so the schema logic below can be exercised outside a container.
APP_ROOT="${APP_ROOT:-/app}"
DATA_DIR="$APP_ROOT/data"
SKIP_SENTINEL="$DATA_DIR/SKIP_AUTO_MIGRATE"
PRISMA="$APP_ROOT/node_modules/.bin/prisma"
SCHEMA="$APP_ROOT/prisma/schema.prisma"
BACKUP="$APP_ROOT/deploy/backup/backup.sh"
CREDENTIAL_KEY_FILE="$DATA_DIR/credential_encryption.key"

# Set once the effective user is known: the prefix that runs a command as the
# unprivileged `app` user (empty when we are already that user).
RUN_AS=""

log() { echo "entrypoint: $*"; }

# Absolute path of the SQLite file behind DATABASE_URL_PRISMA. A relative
# `file:` URL resolves against the SCHEMA's directory (Prisma's rule), not the
# CWD, so the `file:../data/bot.db` default means /app/data/bot.db.
resolve_db_path() {
  _url="${DATABASE_URL_PRISMA:-file:../data/bot.db}"
  case "$_url" in
    file:*) _path="${_url#file:}" ;;
    *) return 1 ;; # not a SQLite file URL — no snapshot path exists
  esac
  _path="${_path%%\?*}" # drop any ?connection_limit=... query string
  case "$_path" in
    /*) ;;
    *) _path="$APP_ROOT/prisma/$_path" ;;
  esac
  printf '%s\n' "$_path"
}

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

  # schema.prisma's datasource provider is "postgresql" (engine-swap) — there
  # is no SQLite fallback to default to any more. Fail loud and immediately
  # instead of silently substituting the old file: URL, which used to produce
  # a confusing SQLite-flavored `prisma db push` failure instead of a clear
  # "you forgot to set this" error.
  if [ -z "${DATABASE_URL_PRISMA:-}" ]; then
    log "ERROR: DATABASE_URL_PRISMA is not set. schema.prisma requires a postgresql:// connection string — set DATABASE_URL_PRISMA=postgresql://<user>:<password>@postgres:5432/<db> in .env (see .env.example and docs/POSTGRES_MIGRATION.md). Refusing to start." >&2
    exit 1
  fi

  if ! db_path="$(resolve_db_path)"; then
    log "DATABASE_URL_PRISMA does not point at a SQLite file, so there is no file to snapshot. Skipping the automatic schema update; apply it yourself."
    return 0
  fi

  if [ ! -f "$db_path" ]; then
    # Fresh install: `migrate diff` cannot read a database that does not exist
    # (it fails with P1003), and an absent file has nothing worth backing up,
    # so go straight to creating the schema.
    log "No database file at $db_path yet, so this is a fresh install — creating the schema from scratch."
    db_push
    log "Schema created."
    return 0
  fi

  # --exit-code: 0 = database already matches, 2 = it differs, 1 = the
  # comparison itself failed. Verified against this repo's own DB.
  set +e
  # shellcheck disable=SC2086 # RUN_AS is an intentional word-split prefix
  $RUN_AS "$PRISMA" migrate diff \
    --from-schema-datasource "$SCHEMA" \
    --to-schema-datamodel "$SCHEMA" \
    --exit-code >/dev/null 2>&1
  _rc=$?
  set -e

  case "$_rc" in
    0)
      log "Database schema already matches schema.prisma — nothing to apply."
      return 0
      ;;
    2)
      log "Database schema differs from schema.prisma — taking a snapshot, then applying the change."
      ;;
    *)
      log "ERROR: could not compare $db_path with schema.prisma (prisma migrate diff exited $_rc). Refusing to start, because guessing here risks either an unmigrated database that fails every order query with P2022, or an unnecessary schema rewrite. Investigate with: docker compose run --rm server pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma" >&2
      exit 1
      ;;
  esac

  # A snapshot is mandatory before the schema is touched, so every prerequisite
  # for taking one is a hard failure rather than something to skip past.
  if [ ! -f "$BACKUP" ]; then
    log "ERROR: no backup script at $BACKUP, so the required pre-migration snapshot cannot be taken. Refusing to change the schema. Restore the script, or set AUTO_MIGRATE=0 and migrate manually after your own backup." >&2
    exit 1
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    log "ERROR: sqlite3 is missing from this image, so the required pre-migration snapshot cannot be taken (backup.sh needs it for a WAL-safe .backup). Refusing to change the schema. Rebuild the image (docker compose build), which installs sqlite3." >&2
    exit 1
  fi

  # backup.sh uses the SQLite online-backup API, so the snapshot folds in the
  # un-checkpointed -wal contents and is verified with PRAGMA integrity_check.
  #
  # Invoked through `bash` rather than executed directly: a Windows git checkout
  # does not preserve the +x bit (the same reason the Dockerfile chmods the
  # entrypoint), and the script is bash-specific anyway — it uses mapfile.
  # shellcheck disable=SC2086 # RUN_AS is an intentional word-split prefix
  if ! DB="$db_path" DEST="$DATA_DIR/backups" RETENTION="${BACKUP_RETENTION:-28}" \
    $RUN_AS bash "$BACKUP"; then
    log "ERROR: the pre-migration snapshot failed, so the schema was left untouched — a schema change without a usable backup has no rollback path. Fix the backup failure above and start again." >&2
    exit 1
  fi

  db_push
  log "Schema updated. The snapshot taken just before the change is in $DATA_DIR/backups (roll back with deploy/backup/restore.sh)."
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
    # Run the schema work as `app` too, so the SQLite sidecars (-wal/-shm) and the
    # backup files it creates are owned by the user that later runs the app.
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
