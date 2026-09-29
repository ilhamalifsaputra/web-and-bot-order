#!/usr/bin/env bash
# Run with: bash deploy/backup/test-restore-postgres.sh
# Executes the real .dump restore path; only Docker and the HTTP probe are stubbed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."
TMP_ROOT="$(mktemp -d 'deploy/backup/.restore-postgres-test.XXXXXX')"
cleanup() {
  rm -f "$TMP_ROOT/bin/docker" "$TMP_ROOT/bin/curl" \
    "$TMP_ROOT/data/SKIP_AUTO_MIGRATE" "$TMP_ROOT/backups/test.dump"
  for dump in "$TMP_ROOT"/backups/pg-pre-restore-*.dump; do
    [ ! -f "$dump" ] || rm -f "$dump"
  done
  rmdir "$TMP_ROOT/bin" "$TMP_ROOT/data" "$TMP_ROOT/backups" "$TMP_ROOT"
}
trap cleanup EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/data" "$TMP_ROOT/backups"
printf 'fixture dump\n' > "$TMP_ROOT/backups/test.dump"

cat > "$TMP_ROOT/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" pg_dump "*) printf 'safety dump\n' ;;
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
printf '200'
EOF
chmod +x "$TMP_ROOT/bin/docker" "$TMP_ROOT/bin/curl"

export PATH="$TMP_ROOT/bin:$PATH"
export DB="$TMP_ROOT/data/bot.db"
export DB_SENTINEL_TEST_PATH="$TMP_ROOT/data/SKIP_AUTO_MIGRATE"
if ! output="$(bash "$SCRIPT_DIR/restore.sh" "$TMP_ROOT/backups/test.dump" 2>&1)"; then
  printf '%s\n' "$output" >&2
  exit 1
fi

if [ ! -f "$DB_SENTINEL_TEST_PATH" ]; then
  echo "FAIL: successful restore left no SKIP_AUTO_MIGRATE sentinel" >&2
  exit 1
fi
case "$output" in
  *"NOTE: automatic schema updates are PAUSED"*"rm $DB_SENTINEL_TEST_PATH"*) ;;
  *) echo "FAIL: Postgres restore did not remind the operator to remove the sentinel" >&2; exit 1 ;;
esac
echo "PASS: Postgres restore pauses migration before server start and prints the removal reminder"
