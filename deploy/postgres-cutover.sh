#!/usr/bin/env bash
#
# Orchestrates the SQLite -> Postgres production cutover documented
# command-by-command in docs/POSTGRES_MIGRATION.md (sections 1-10). This
# script automates sections 2-8: freeze, backup, build, bring up Postgres,
# push schema, run the data migration, run the reconciliation gate, and
# cutover. Sections 1 (prerequisites), 8a (point cron at Postgres), 9
# (rollback), and 10 (post-cutover monitoring) are NOT automated — they need
# human judgment and are left for the operator to do manually, exactly as
# docs/POSTGRES_MIGRATION.md describes them. Read that file in full before
# running this script; it is the source of truth for WHY each step exists.
#
# This is a real production cutover: it stops the live stack (section 2) and
# is not reversible by re-running this script. Run it on the VPS, from the
# repo root, with a real production .env already configured per runbook §1.
#
# Every docker-compose invocation below is copied verbatim from
# docs/POSTGRES_MIGRATION.md §2-8 (same -f file order, same service names,
# same flags) so the runbook and this script never silently diverge. If you
# change one, change the other.
#
# Usage:
#   deploy/postgres-cutover.sh [--dry-run] [--yes] \
#     [--sqlite-db PATH] [--dest DIR] [--retention N]
#
#   --sqlite-db PATH   SQLite DB to back up (default ./data/bot.db).
#                       Forwarded to deploy/backup/backup.sh as DB.
#   --dest DIR          Backup destination directory (default ./data/backups).
#                       Forwarded to deploy/backup/backup.sh as DEST.
#   --retention N       How many timestamped backups to keep (default 28).
#                       Forwarded to deploy/backup/backup.sh as RETENTION.
#   --yes, -y           Skip the interactive "type yes" confirmation before
#                       freezing the stack (section 2). For a scripted
#                       rehearsal run only — think twice before using this
#                       against real production.
#   --dry-run            Print every command this script would run, in order,
#                       without executing any of them (check_prereqs's
#                       read-only file/version checks still run for real).
#   -h, --help           Show this usage and exit 0.
#
# Any step failing prints which numbered runbook section to consult and
# stops — this script never attempts automatic rollback or "fix forward";
# runbook §9 needs a human to judge whether the failure is real and whether
# the backup is still trustworthy.
set -euo pipefail

# Make the script self-locating, same convention as deploy/backup/backup.sh:
# the docker-compose invocations below use RELATIVE compose-file paths,
# which only resolve from the repo root. deploy/postgres-cutover.sh lives
# directly under deploy/, one level shallower than deploy/backup/backup.sh,
# so this needs only one ".." to reach the repo root.
cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." || {
  echo "ERROR: could not cd to the repo root from $(dirname "${BASH_SOURCE[0]:-$0}")" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Flags / defaults
# ---------------------------------------------------------------------------
SQLITE_DB="./data/bot.db"
DEST="./data/backups"
RETENTION="28"
ASSUME_YES="false"
DRY_RUN="false"

usage() {
  cat <<'EOF'
Usage: deploy/postgres-cutover.sh [--dry-run] [--yes] \
         [--sqlite-db PATH] [--dest DIR] [--retention N]

Automates docs/POSTGRES_MIGRATION.md sections 2-8 (freeze, backup, build,
bring up Postgres, push schema, migrate data, reconcile, cutover). Sections
1, 8a, 9, and 10 remain manual — see the runbook.

Options:
  --sqlite-db PATH   SQLite DB to back up (default ./data/bot.db)
  --dest DIR         Backup destination directory (default ./data/backups)
  --retention N      Backups to keep (default 28)
  --yes, -y          Skip the interactive confirmation before freezing (§2)
  --dry-run          Print the command sequence without running anything
  -h, --help         Show this help and exit 0
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --sqlite-db)
      SQLITE_DB="${2:-}"
      [ -n "$SQLITE_DB" ] || { echo "ERROR: --sqlite-db requires a value" >&2; exit 1; }
      shift 2
      ;;
    --dest)
      DEST="${2:-}"
      [ -n "$DEST" ] || { echo "ERROR: --dest requires a value" >&2; exit 1; }
      shift 2
      ;;
    --retention)
      RETENTION="${2:-}"
      [ -n "$RETENTION" ] || { echo "ERROR: --retention requires a value" >&2; exit 1; }
      shift 2
      ;;
    --yes|-y)
      ASSUME_YES="true"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unrecognized argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

COMPOSE_BASE=(docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml)

# run CMD... — executes a command for real, or just echoes it under --dry-run.
run() {
  if [ "$DRY_RUN" = "true" ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

fail() {
  # fail SECTION MESSAGE — print which runbook section to consult and stop.
  echo "ERROR: $2" >&2
  echo "See docs/POSTGRES_MIGRATION.md $1 before proceeding." >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 1. check_prereqs (§1) — read-only, runs even under --dry-run.
# ---------------------------------------------------------------------------
check_prereqs() {
  echo "==> Checking prerequisites (runbook §1)"

  if ! command -v docker >/dev/null 2>&1; then
    fail "§1" "docker not found on PATH."
  fi

  VERSION_OUTPUT="$(docker compose version 2>&1)" || fail "§1" "'docker compose version' failed to run."
  VERSION="$(echo "$VERSION_OUTPUT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
  [ -n "$VERSION" ] || fail "§1" "could not parse a version number out of: $VERSION_OUTPUT"
  MAJOR="${VERSION%%.*}"
  REST="${VERSION#*.}"
  MINOR="${REST%%.*}"
  if [ "$MAJOR" -lt 2 ] || { [ "$MAJOR" -eq 2 ] && [ "$MINOR" -lt 24 ]; }; then
    fail "§1" "docker compose version $VERSION is older than the required 2.24+ (env_file: path/required: false needs it)."
  fi
  echo "    docker compose $VERSION (>= 2.24 required) OK"

  for f in docker-compose.postgres.prod.yml scripts/migrate-sqlite-to-postgres.ts scripts/reconcile-sqlite-postgres.ts; do
    if [ ! -f "$f" ]; then
      fail "§1" "required file missing: $f (this branch's Postgres-cutover changes are not checked out)."
    fi
  done
  echo "    required files present OK"

  if [ ! -f .env ]; then
    fail "§1" ".env not found — copy .env.example to .env and fill in the Postgres block first."
  fi
  ACTIVE_COUNT="$(grep -cE '^DATABASE_URL_PRISMA=postgresql://' .env || true)"
  if [ "$ACTIVE_COUNT" -eq 0 ]; then
    fail "§1" "no active DATABASE_URL_PRISMA=postgresql://... line in .env (only a commented-out or file: line found)."
  elif [ "$ACTIVE_COUNT" -gt 1 ]; then
    fail "§1" "more than one active DATABASE_URL_PRISMA=postgresql://... line in .env — exactly one must be active."
  fi
  if grep -qE '^DATABASE_URL_PRISMA=file:' .env; then
    fail "§1" "an active DATABASE_URL_PRISMA=file:... (legacy SQLite) line is also present in .env — comment it out, only the postgresql:// line may be active."
  fi
  echo "    .env has exactly one active DATABASE_URL_PRISMA=postgresql://... line OK"
}

# ---------------------------------------------------------------------------
# 2. tag_pre_migration_image (§1)
# ---------------------------------------------------------------------------
PRE_POSTGRES_COMMIT_FILE="deploy/backup/pre-postgres-commit.txt"

tag_pre_migration_image() {
  echo "==> Tagging pre-migration image (runbook §1)"

  if [ "$DRY_RUN" = "true" ]; then
    echo "[dry-run] docker image inspect bot-order-node:pre-postgres"
    echo "[dry-run] docker tag bot-order-node:latest bot-order-node:pre-postgres"
    echo "[dry-run] git rev-parse HEAD > $PRE_POSTGRES_COMMIT_FILE"
    return 0
  fi

  if docker image inspect bot-order-node:pre-postgres >/dev/null 2>&1; then
    echo "WARNING: bot-order-node:pre-postgres already exists — skipping tag so an existing rollback target is never silently overwritten."
    return 0
  fi

  docker tag bot-order-node:latest bot-order-node:pre-postgres
  git rev-parse HEAD > "$PRE_POSTGRES_COMMIT_FILE"
  echo "    tagged bot-order-node:pre-postgres; commit recorded in $PRE_POSTGRES_COMMIT_FILE"
}

# ---------------------------------------------------------------------------
# 3. freeze_stack (§2)
# ---------------------------------------------------------------------------
freeze_stack() {
  echo "==> Freezing application writes (runbook §2)"

  if [ "$DRY_RUN" = "true" ]; then
    echo "[dry-run] would prompt \"Type 'yes' to continue\" here unless --yes is given (nothing to confirm under --dry-run since nothing executes)"
  elif [ "$ASSUME_YES" != "true" ]; then
    echo "This will run 'docker compose down', stopping the live stack now."
    read -r -p "Type 'yes' to continue: " CONFIRM
    [ "$CONFIRM" = "yes" ] || fail "§2" "confirmation not given; aborting before touching the live stack."
  fi

  run docker compose down

  if [ "$DRY_RUN" = "true" ]; then
    echo "[dry-run] docker compose ps"
    return 0
  fi

  PS_OUTPUT="$(docker compose ps)" || fail "§2" "'docker compose ps' failed to run."
  echo "$PS_OUTPUT"
  # Header line only ("NAME  IMAGE  ...") means nothing is left running.
  REMAINING="$(echo "$PS_OUTPUT" | tail -n +2 | grep -c . || true)"
  if [ "$REMAINING" -ne 0 ]; then
    fail "§2" "'docker compose ps' still shows running containers after 'docker compose down'."
  fi
  echo "    stack is down, nothing app-related remains OK"
}

# ---------------------------------------------------------------------------
# 4. backup_sqlite (§3)
# ---------------------------------------------------------------------------
BACKUP_FILENAME=""

backup_sqlite() {
  echo "==> Backing up the SQLite database (runbook §3)"

  if [ "$DRY_RUN" = "true" ]; then
    echo "[dry-run] DB=$SQLITE_DB DEST=$DEST RETENTION=$RETENTION deploy/backup/backup.sh"
    BACKUP_FILENAME="bot-<timestamp>.db"
    return 0
  fi

  BACKUP_OUTPUT="$(DB="$SQLITE_DB" DEST="$DEST" RETENTION="$RETENTION" deploy/backup/backup.sh)" \
    || fail "§3" "deploy/backup/backup.sh failed (it already deleted any corrupt/partial snapshot and exited non-zero itself)."
  echo "$BACKUP_OUTPUT"

  BACKUP_FILENAME="$(echo "$BACKUP_OUTPUT" | grep -oE 'bot-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\.db' | head -n1)"
  [ -n "$BACKUP_FILENAME" ] || fail "§3" "could not extract the bot-<timestamp>.db filename from backup.sh's output."
  echo "    captured backup filename: $BACKUP_FILENAME"
}

# ---------------------------------------------------------------------------
# 5. build_image (§3a)
# ---------------------------------------------------------------------------
build_image() {
  echo "==> Building the application image (runbook §3a)"
  run "${COMPOSE_BASE[@]}" build
}

# ---------------------------------------------------------------------------
# 6. bring_up_postgres (§4)
# ---------------------------------------------------------------------------
bring_up_postgres() {
  echo "==> Bringing up the Postgres container (runbook §4)"

  run "${COMPOSE_BASE[@]}" up -d postgres

  if [ "$DRY_RUN" = "true" ]; then
    echo "[dry-run] docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml ps postgres (poll for healthy, ~60s bound)"
    return 0
  fi

  echo -n "    waiting for postgres to report healthy "
  for i in $(seq 1 30); do
    if "${COMPOSE_BASE[@]}" ps postgres | grep -q '(healthy)'; then
      echo "OK"
      return 0
    fi
    echo -n "."
    sleep 2
  done
  echo
  fail "§4" "postgres never reported (healthy) within ~60s of 'docker compose ... up -d postgres'."
}

# ---------------------------------------------------------------------------
# 7. push_schema (§5)
# ---------------------------------------------------------------------------
push_schema() {
  echo "==> Applying the schema to the empty Postgres database (runbook §5)"
  if ! run "${COMPOSE_BASE[@]}" run --rm server pnpm exec prisma db push --schema prisma/schema.prisma; then
    fail "§5" "'prisma db push' failed. Do NOT blindly re-run or add --accept-data-loss/--force-reset here — investigate manually per the runbook."
  fi
}

# ---------------------------------------------------------------------------
# 8. run_migrate (§6)
# ---------------------------------------------------------------------------
run_migrate() {
  echo "==> Running the data-transform script (runbook §6)"

  if [ "$DRY_RUN" = "true" ]; then
    run "${COMPOSE_BASE[@]}" run --rm server pnpm exec tsx scripts/migrate-sqlite-to-postgres.ts "data/backups/$BACKUP_FILENAME"
    return 0
  fi

  # if/else (not a bare assignment) so `set -e` does not abort before we get
  # a chance to inspect $? and print our own fail() message below.
  if MIGRATE_OUTPUT="$("${COMPOSE_BASE[@]}" run --rm server pnpm exec tsx scripts/migrate-sqlite-to-postgres.ts "data/backups/$BACKUP_FILENAME" 2>&1)"; then
    MIGRATE_STATUS=0
  else
    MIGRATE_STATUS=$?
  fi
  echo "$MIGRATE_OUTPUT"
  if [ "$MIGRATE_STATUS" -ne 0 ]; then
    fail "§6" "migrate-sqlite-to-postgres.ts exited non-zero. If it reported 'Refusing to run: target already has rows', do NOT blindly re-run — see the runbook's manual remediation."
  fi
  echo "$MIGRATE_OUTPUT" | grep -qE 'DONE.*all row counts match' \
    || fail "§6" "migrate-sqlite-to-postgres.ts exited 0 but its summary line did not confirm all row counts match."
  echo "    migration completed, all row counts match OK"
}

# ---------------------------------------------------------------------------
# 9. run_reconcile (§7) — required gate
# ---------------------------------------------------------------------------
run_reconcile() {
  echo "==> Running reconciliation (runbook §7 — required gate)"

  if [ "$DRY_RUN" = "true" ]; then
    run "${COMPOSE_BASE[@]}" run --rm server pnpm exec tsx scripts/reconcile-sqlite-postgres.ts "data/backups/$BACKUP_FILENAME"
    return 0
  fi

  # if/else (not a bare assignment) so `set -e` does not abort before we get
  # a chance to inspect $? and print our own fail() message below.
  if RECONCILE_OUTPUT="$("${COMPOSE_BASE[@]}" run --rm server pnpm exec tsx scripts/reconcile-sqlite-postgres.ts "data/backups/$BACKUP_FILENAME" 2>&1)"; then
    RECONCILE_STATUS=0
  else
    RECONCILE_STATUS=$?
  fi
  echo "$RECONCILE_OUTPUT"

  SAVED_OUTPUT="$DEST/reconcile-output-$(date +%F-%H%M%S).txt"
  echo "$RECONCILE_OUTPUT" > "$SAVED_OUTPUT"

  if [ "$RECONCILE_STATUS" -ne 0 ] || ! echo "$RECONCILE_OUTPUT" | grep -q 'Overall verdict: PASS'; then
    echo "Reconciliation output saved to: $SAVED_OUTPUT" >&2
    fail "§9 (rollback)" "reconciliation did not report 'Overall verdict: PASS' (exit code $RECONCILE_STATUS). Do not attempt to fix forward."
  fi
  echo "    reconciliation PASSED OK (output saved to $SAVED_OUTPUT)"
}

# ---------------------------------------------------------------------------
# 10. cutover (§8)
# ---------------------------------------------------------------------------
cutover() {
  echo "==> Cutover — starting the full stack (runbook §8)"

  run "${COMPOSE_BASE[@]}" up -d --build

  if [ "$DRY_RUN" = "true" ]; then
    WEB_PORT_D="${WEB_PORT:-8000}"
    STOREFRONT_PORT_D="${STOREFRONT_PORT:-8100}"
    echo "[dry-run] docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml ps server"
    echo "[dry-run] curl -i http://127.0.0.1:${WEB_PORT_D}/healthz (poll, bounded retries)"
    echo "[dry-run] curl -i http://127.0.0.1:${STOREFRONT_PORT_D}/healthz (poll, bounded retries)"
    return 0
  fi

  WEB_PORT="${WEB_PORT:-8000}"
  STOREFRONT_PORT="${STOREFRONT_PORT:-8100}"

  for name in "web:$WEB_PORT" "storefront:$STOREFRONT_PORT"; do
    LABEL="${name%%:*}"
    PORT="${name##*:}"
    echo -n "    waiting for $LABEL /healthz on :$PORT "
    OK="false"
    for i in $(seq 1 30); do
      CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/healthz" || true)"
      if [ "$CODE" = "200" ]; then
        echo "OK (200)"
        OK="true"
        break
      fi
      echo -n "."
      sleep 2
    done
    [ "$OK" = "true" ] || { echo; fail "§8" "$LABEL /healthz on :$PORT never returned 200."; }
  done

  echo
  echo "==> Cutover healthy. Remaining manual steps (NOT automated by this script):"
  echo "    - runbook §8a: point the backup cron at Postgres"
  echo "    - runbook §10: post-cutover monitoring for at least a full day of traffic"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
  if [ "$DRY_RUN" = "true" ]; then
    echo "==> --dry-run: no docker/git/compose commands below will actually execute."
  fi
  check_prereqs
  tag_pre_migration_image
  freeze_stack
  backup_sqlite
  build_image
  bring_up_postgres
  push_schema
  run_migrate
  run_reconcile
  cutover
}

main "$@"
