#!/usr/bin/env bash
# Run with: bash deploy/backup/test-restore-postgres.sh
# Executes the real .dump restore path; only Docker and the HTTP probe are stubbed.
#
# Covers:
#   1. the SKIP_AUTO_MIGRATE sentinel exists before the server starts, and the
#      operator is reminded to remove it;
#   2. POSTGRES_USER/POSTGRES_DB/WEB_PORT/DATA_DIR come from the env file when
#      the environment does not set them — parsed as text, never evaluated, and
#      no secret from it is printed;
#   3. a value set in the environment wins over the env file;
#   4. EVERY docker compose call (exec, stop, start) uses both compose files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."
TMP_ROOT="$(mktemp -d 'deploy/backup/.restore-postgres-test.XXXXXX')"
TMP_ABS="$PWD/$TMP_ROOT"
cleanup() { rm -rf "$TMP_ABS"; }
trap cleanup EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/data" "$TMP_ROOT/env-data" "$TMP_ROOT/backups"
printf 'fixture dump\n' > "$TMP_ROOT/backups/test.dump"

FAILURES=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; FAILURES=$((FAILURES + 1)); }

# Records every invocation (one line each) so the test can check the arguments.
cat > "$TMP_ROOT/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  *" pg_restore --list "*) cat >/dev/null ;;
  *" pg_dump "*) printf 'safety dump\n' ;;
  *" pg_restore "*) cat >/dev/null ;;
  *" start server "*)
    if [ ! -f "$DB_SENTINEL_TEST_PATH" ]; then
      echo "FAIL: server started before SKIP_AUTO_MIGRATE existed" >&2
      exit 42
    fi
    ;;
esac
EOF
cat > "$TMP_ROOT/bin/curl" <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do last="$arg"; done
printf '%s\n' "$last" >> "$CURL_LOG"
printf '200'
EOF
chmod +x "$TMP_ROOT/bin/docker" "$TMP_ROOT/bin/curl"

# A .env the way operators actually write one: `export`, quotes, CRLF, inline
# comments, a repeated key (last wins), and a password that must never be
# evaluated or printed.
printf '%s\r\n' \
  '# shop settings' \
  'POSTGRES_USER=wrong_user' \
  'export POSTGRES_USER=shop_user   # overrides the line above' \
  'POSTGRES_DB="shop_db"' \
  "POSTGRES_PASSWORD=s3cr3t-\$(touch $TMP_ABS/pwned)" \
  "DATA_DIR='$TMP_ROOT/env-data'" \
  'WEB_PORT=8765 # this shop' \
  > "$TMP_ROOT/test.env"

export PATH="$TMP_ROOT/bin:$PATH"
export BACKUP_ENV_FILE="$TMP_ROOT/test.env"
export DOCKER_LOG="$TMP_ABS/docker.log"
export CURL_LOG="$TMP_ABS/curl.log"
unset POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD WEB_PORT DATA_DIR DATABASE_URL_PRISMA SERVICES || true

COMPOSE_FILES="compose -f docker-compose.yml -f docker-compose.postgres.prod.yml"

# Every recorded docker call must be a compose call with both files.
check_compose_files() {
  local label="$1" line bad=0
  while IFS= read -r line; do
    case "$line" in
      "$COMPOSE_FILES "*) ;;
      *) fail "$label: docker call without both compose files: $line"; bad=1 ;;
    esac
  done < "$DOCKER_LOG"
  [ "$bad" = 1 ] || pass "$label: every docker call uses both compose files"
  grep -q "^$COMPOSE_FILES stop server$" "$DOCKER_LOG" && grep -q "^$COMPOSE_FILES start server$" "$DOCKER_LOG" \
    || fail "$label: stop/start were not issued through the prod compose files"
}

# --- run 1: everything from the env file -------------------------------------
: > "$DOCKER_LOG"; : > "$CURL_LOG"
export DB_SENTINEL_TEST_PATH="$TMP_ROOT/env-data/SKIP_AUTO_MIGRATE"
if ! output="$(bash "$SCRIPT_DIR/restore.sh" "$TMP_ROOT/backups/test.dump" 2>&1)"; then
  printf '%s\n' "$output" >&2
  echo "FAIL: restore.sh exited non-zero" >&2
  exit 1
fi

if [ -f "$DB_SENTINEL_TEST_PATH" ]; then
  pass "sentinel written to DATA_DIR from the env file"
else
  fail "successful restore left no SKIP_AUTO_MIGRATE sentinel in DATA_DIR from the env file"
fi
case "$output" in
  *"NOTE: automatic schema updates are PAUSED"*"rm $DB_SENTINEL_TEST_PATH && docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml restart server"*)
    pass "operator is reminded to remove the sentinel, with the prod compose files" ;;
  *) fail "restore did not print the sentinel reminder with the prod compose files" ;;
esac
grep -q "exec -T postgres pg_dump -U shop_user -Fc shop_db$" "$DOCKER_LOG" \
  && pass "safety dump uses POSTGRES_USER/POSTGRES_DB from the env file" \
  || fail "safety dump did not use shop_user/shop_db: $(cat "$DOCKER_LOG")"
grep -q "pg_restore --clean --if-exists --single-transaction -U shop_user -d shop_db$" "$DOCKER_LOG" \
  && pass "restore targets POSTGRES_DB from the env file" \
  || fail "restore did not target shop_db as shop_user"
grep -q "^http://127.0.0.1:8765/healthz$" "$CURL_LOG" \
  && pass "smoke test probes WEB_PORT from the env file" \
  || fail "smoke test did not probe port 8765: $(cat "$CURL_LOG")"
check_compose_files "run 1"
[ ! -e "$TMP_ABS/pwned" ] && pass "env file values are never evaluated" || fail "a value in the env file was executed"
case "$output" in
  *s3cr3t*) fail "the password from the env file was printed" ;;
  *) pass "no secret from the env file is printed" ;;
esac

# --- run 2: the environment wins over the env file ---------------------------
: > "$DOCKER_LOG"; : > "$CURL_LOG"
export DB_SENTINEL_TEST_PATH="$TMP_ROOT/data/SKIP_AUTO_MIGRATE"
if ! output="$(POSTGRES_DB=env_db DATA_DIR="$TMP_ROOT/data" WEB_PORT=8111 bash "$SCRIPT_DIR/restore.sh" "$TMP_ROOT/backups/test.dump" 2>&1)"; then
  printf '%s\n' "$output" >&2
  echo "FAIL: restore.sh exited non-zero with environment overrides" >&2
  exit 1
fi
grep -q "pg_restore --clean --if-exists --single-transaction -U shop_user -d env_db$" "$DOCKER_LOG" \
  && pass "POSTGRES_DB from the environment wins over the env file" \
  || fail "environment POSTGRES_DB was not honoured"
[ -f "$DB_SENTINEL_TEST_PATH" ] && pass "DATA_DIR from the environment wins" || fail "environment DATA_DIR was not honoured"
grep -q "^http://127.0.0.1:8111/healthz$" "$CURL_LOG" && pass "WEB_PORT from the environment wins" || fail "environment WEB_PORT was not honoured"
check_compose_files "run 2"

# --- run 3: no env file at all falls back to the compose defaults -------------
: > "$DOCKER_LOG"; : > "$CURL_LOG"
export DB_SENTINEL_TEST_PATH="$TMP_ROOT/data/SKIP_AUTO_MIGRATE"
rm -f "$DB_SENTINEL_TEST_PATH"
if ! output="$(BACKUP_ENV_FILE="$TMP_ROOT/missing.env" DATA_DIR="$TMP_ROOT/data" bash "$SCRIPT_DIR/restore.sh" "$TMP_ROOT/backups/test.dump" 2>&1)"; then
  printf '%s\n' "$output" >&2
  echo "FAIL: restore.sh exited non-zero without an env file" >&2
  exit 1
fi
grep -q "pg_restore --clean --if-exists --single-transaction -U bot_order -d bot_order$" "$DOCKER_LOG" \
  && pass "without an env file the compose defaults (bot_order) are used" \
  || fail "missing env file did not fall back to bot_order"
grep -q "^http://127.0.0.1:8000/healthz$" "$CURL_LOG" && pass "without an env file WEB_PORT defaults to 8000" || fail "WEB_PORT default not used"

if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES check(s) failed" >&2
  exit 1
fi
echo "PASS: restore.sh — sentinel, .env loading, env precedence, compose file selection"
