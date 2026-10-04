#!/usr/bin/env bash
# Run with: bash deploy/backup/test-backup-postgres.sh
# Executes the real backup.sh; only Docker is stubbed.
#
# Covers: POSTGRES_USER/POSTGRES_DB come from the env file when the environment
# does not set them (parsed as text, never evaluated, nothing secret printed),
# the environment wins over the env file, the bot_order defaults apply without
# one, and every docker call uses both compose files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."
TMP_ROOT="$(mktemp -d 'deploy/backup/.backup-postgres-test.XXXXXX')"
TMP_ABS="$PWD/$TMP_ROOT"
cleanup() { rm -rf "$TMP_ABS"; }
trap cleanup EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/dest"

FAILURES=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; FAILURES=$((FAILURES + 1)); }

cat > "$TMP_ROOT/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  *" pg_dump "*) printf 'fixture dump\n' ;;
  *" pg_restore --list "*) cat >/dev/null ;;
esac
EOF
chmod +x "$TMP_ROOT/bin/docker"

printf '%s\r\n' \
  'export POSTGRES_USER="shop_user"' \
  "POSTGRES_DB='shop_db'  # second shop" \
  "POSTGRES_PASSWORD=s3cr3t-\$(touch $TMP_ABS/pwned)" \
  > "$TMP_ROOT/test.env"

export PATH="$TMP_ROOT/bin:$PATH"
export BACKUP_ENV_FILE="$TMP_ROOT/test.env"
export DOCKER_LOG="$TMP_ABS/docker.log"
export DEST="$TMP_ROOT/dest"
unset POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD DATABASE_URL_PRISMA || true

COMPOSE_FILES="compose -f docker-compose.yml -f docker-compose.postgres.prod.yml"
check_compose_files() {
  local label="$1" line bad=0
  while IFS= read -r line; do
    case "$line" in
      "$COMPOSE_FILES "*) ;;
      *) fail "$label: docker call without both compose files: $line"; bad=1 ;;
    esac
  done < "$DOCKER_LOG"
  [ "$bad" = 1 ] || pass "$label: every docker call uses both compose files"
}

run_backup() {
  : > "$DOCKER_LOG"
  if ! output="$("$@" bash "$SCRIPT_DIR/backup.sh" 2>&1)"; then
    printf '%s\n' "$output" >&2
    echo "FAIL: backup.sh exited non-zero" >&2
    exit 1
  fi
}

run_backup env
grep -q "exec -T postgres pg_dump -U shop_user -Fc shop_db$" "$DOCKER_LOG" \
  && pass "dump uses POSTGRES_USER/POSTGRES_DB from the env file" \
  || fail "dump did not use shop_user/shop_db: $(cat "$DOCKER_LOG")"
check_compose_files "env file"
[ ! -e "$TMP_ABS/pwned" ] && pass "env file values are never evaluated" || fail "a value in the env file was executed"
case "$output" in
  *s3cr3t*) fail "the password from the env file was printed" ;;
  *"database shop_db"*) pass "OK line names the dumped database and prints no secret" ;;
  *) fail "OK line does not name the dumped database: $output" ;;
esac

run_backup env POSTGRES_DB=env_db
grep -q "pg_dump -U shop_user -Fc env_db$" "$DOCKER_LOG" \
  && pass "POSTGRES_DB from the environment wins over the env file" \
  || fail "environment POSTGRES_DB was not honoured"

run_backup env BACKUP_ENV_FILE="$TMP_ROOT/missing.env"
grep -q "pg_dump -U bot_order -Fc bot_order$" "$DOCKER_LOG" \
  && pass "without an env file the compose defaults (bot_order) are used" \
  || fail "missing env file did not fall back to bot_order"
check_compose_files "no env file"

if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES check(s) failed" >&2
  exit 1
fi
echo "PASS: backup.sh — .env loading, env precedence, compose file selection"
