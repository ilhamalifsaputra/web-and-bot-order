#!/bin/sh
# Manual test harness for docker-entrypoint.sh's auto_migrate() — specifically
# the Postgres deploy sequence it automates (schema push → ledger chart-of-accounts
# seed → data-only migrations) and the four ways that sequence is allowed to stop.
#
# No container and no database needed: the same APP_ROOT override plus
# ENTRYPOINT_TEST_SOURCE_ONLY that deploy/test-entrypoint-credential-key.sh uses
# (see docker-entrypoint.sh's own comment) sources the functions, with a temp dir
# standing in for /app. The `prisma` and `tsx` binaries in that temp dir are stubs
# that record the command they were given and return an exit code the case picks,
# so every assertion is about WHICH steps ran, in WHAT order — which is the part
# that decides whether a deploy leaves the schema current and the ledger postable.
#
# Run: bash deploy/test-entrypoint-auto-migrate.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENTRYPOINT="$SCRIPT_DIR/docker-entrypoint.sh"
FAILURES=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# Read the real $DATA_MIGRATIONS list out of the entrypoint rather than repeating
# it here, so adding a data-only migration cannot leave this test asserting the
# old list. Sourced in a child shell because the entrypoint turns on `set -e`.
DATA_MIGRATIONS_LIST="$(
  APP_ROOT=/nonexistent ENTRYPOINT_TEST_SOURCE_ONLY=1 \
    sh -c '. "$1"; printf "%s" "$DATA_MIGRATIONS"' _ "$ENTRYPOINT"
)"

# --- fake /app -------------------------------------------------------------
# Sets TMP_ROOT and STUB_LOG. Exit codes come from the environment (STUB_*_RC)
# so one pair of stubs covers both the success and the failure cases.
make_app_root() {
  TMP_ROOT="$(mktemp -d)"
  mkdir -p "$TMP_ROOT/data" "$TMP_ROOT/node_modules/.bin" "$TMP_ROOT/prisma" "$TMP_ROOT/scripts"
  : > "$TMP_ROOT/prisma/schema.prisma"
  : > "$TMP_ROOT/scripts/seed-chart-of-accounts.ts"
  for _name in $DATA_MIGRATIONS_LIST; do
    mkdir -p "$TMP_ROOT/prisma/migrations/$_name"
    : > "$TMP_ROOT/prisma/migrations/$_name/migration.sql"
  done

  cat > "$TMP_ROOT/node_modules/.bin/prisma" <<'STUB'
#!/bin/sh
printf 'prisma %s\n' "$*" >> "$STUB_LOG"
case " $* " in
  *" --stdin "*) cat >/dev/null; exit "${STUB_PROBE_RC:-0}" ;;
  *" db push "*) exit "${STUB_PUSH_RC:-0}" ;;
  *" --file "*) exit "${STUB_EXECUTE_RC:-0}" ;;
esac
exit 0
STUB
  cat > "$TMP_ROOT/node_modules/.bin/tsx" <<'STUB'
#!/bin/sh
printf 'tsx %s\n' "$*" >> "$STUB_LOG"
exit "${STUB_SEED_RC:-0}"
STUB
  chmod +x "$TMP_ROOT/node_modules/.bin/prisma" "$TMP_ROOT/node_modules/.bin/tsx"

  STUB_LOG="$TMP_ROOT/stub.log"
  : > "$STUB_LOG"
  export STUB_LOG
}

# The recorded commands reduced to one word each, in order, so a case can assert
# the whole sequence as a single string: probe push seed data.
steps() {
  _out=""
  while IFS= read -r _line; do
    case "$_line" in
      *--stdin*) _out="$_out probe" ;;
      *"db push"*) _out="$_out push" ;;
      tsx*seed-chart-of-accounts.ts) _out="$_out seed" ;;
      *--file*) _out="$_out data" ;;
      *) _out="$_out unexpected[$_line]" ;;
    esac
  done < "$STUB_LOG"
  printf '%s' "${_out# }"
}

# Runs auto_migrate() against the fake /app with the case's environment applied.
# Writes its combined output to $TMP_ROOT/out.log and returns auto_migrate's own
# exit status, so a case can assert "refused to start" as well as the step list.
run_auto_migrate() {
  (
    export APP_ROOT="$TMP_ROOT"
    export ENTRYPOINT_TEST_SOURCE_ONLY=1
    # Never wait on a real clock in a test — the stubbed probe answers on the
    # first attempt anyway.
    export DB_WAIT_ATTEMPTS=1
    export DB_WAIT_SECONDS=0
    . "$ENTRYPOINT"
    auto_migrate
  ) >"$TMP_ROOT/out.log" 2>&1
}

expect_steps() {
  _want="$1"
  _got="$(steps)"
  [ "$_got" = "$_want" ] && return 0
  echo "  steps were [$_got], want [$_want]" >&2
  sed 's/^/  | /' "$TMP_ROOT/out.log" >&2
  return 1
}

expect_output() {
  grep -q "$1" "$TMP_ROOT/out.log" && return 0
  echo "  output does not mention [$1]" >&2
  sed 's/^/  | /' "$TMP_ROOT/out.log" >&2
  return 1
}

# --- Case 1: the full Postgres sequence, in order ---------------------------
case_postgres_runs_push_then_seed_then_data() {
  make_app_root
  _want="probe push seed"
  for _name in $DATA_MIGRATIONS_LIST; do _want="$_want data"; done

  rc=0
  DATABASE_URL_PRISMA="postgresql://u:p@postgres:5432/db" run_auto_migrate || rc=1
  if [ "$rc" -ne 0 ]; then
    echo "  auto_migrate refused to start but should have succeeded" >&2
    sed 's/^/  | /' "$TMP_ROOT/out.log" >&2
  else
    expect_steps "$_want" || rc=1
  fi
  rm -rf "$TMP_ROOT"
  return $rc
}

# --- Case 2: a failed push refuses to start and skips everything after -------
case_push_failure_exits_and_skips_rest() {
  make_app_root
  rc=0
  if DATABASE_URL_PRISMA="postgresql://u:p@postgres:5432/db" STUB_PUSH_RC=1 run_auto_migrate; then
    echo "  auto_migrate succeeded but a failed 'db push' must refuse to start" >&2
    rc=1
  else
    # Nothing after the push may run: seeding or backfilling rows against a
    # schema that was not applied is exactly the P2022 order the entrypoint exists
    # to prevent.
    expect_steps "probe push" || rc=1
    expect_output "will not start" || rc=1
  fi
  rm -rf "$TMP_ROOT"
  return $rc
}

# --- Case 3: a non-zero seed warns and start-up continues -------------------
case_seed_failure_warns_and_continues() {
  make_app_root
  _want="probe push seed"
  for _name in $DATA_MIGRATIONS_LIST; do _want="$_want data"; done

  rc=0
  if DATABASE_URL_PRISMA="postgresql://u:p@postgres:5432/db" STUB_SEED_RC=1 run_auto_migrate; then
    expect_steps "$_want" || rc=1
    expect_output "WARNING: the ledger chart-of-accounts seed exited 1" || rc=1
  else
    echo "  auto_migrate refused to start, but a drifted/failed seed must only warn" >&2
    sed 's/^/  | /' "$TMP_ROOT/out.log" >&2
    rc=1
  fi
  rm -rf "$TMP_ROOT"
  return $rc
}

# --- Case 4: AUTO_MIGRATE=0 skips the whole sequence ------------------------
case_auto_migrate_off_skips_everything() {
  make_app_root
  rc=0
  if DATABASE_URL_PRISMA="postgresql://u:p@postgres:5432/db" AUTO_MIGRATE=0 run_auto_migrate; then
    expect_steps "" || rc=1
    expect_output "AUTO_MIGRATE is off" || rc=1
  else
    echo "  AUTO_MIGRATE=0 must start normally, not refuse" >&2
    rc=1
  fi
  rm -rf "$TMP_ROOT"
  return $rc
}

# --- Case 5: the post-rollback sentinel skips the whole sequence ------------
case_sentinel_skips_everything() {
  make_app_root
  printf 'restored pg-20260919T000000.dump; do not migrate forward\n' > "$TMP_ROOT/data/SKIP_AUTO_MIGRATE"
  rc=0
  if DATABASE_URL_PRISMA="postgresql://u:p@postgres:5432/db" run_auto_migrate; then
    expect_steps "" || rc=1
    expect_output "SKIP_AUTO_MIGRATE" || rc=1
  else
    echo "  the sentinel must start normally, not refuse" >&2
    rc=1
  fi
  rm -rf "$TMP_ROOT"
  return $rc
}

# --- Case 6: no DATABASE_URL_PRISMA still refuses to start ------------------
case_missing_url_refuses() {
  make_app_root
  rc=0
  if (unset DATABASE_URL_PRISMA; run_auto_migrate); then
    echo "  auto_migrate succeeded without DATABASE_URL_PRISMA, but must refuse" >&2
    rc=1
  else
    expect_steps "" || rc=1
    expect_output "DATABASE_URL_PRISMA is not set" || rc=1
  fi
  rm -rf "$TMP_ROOT"
  return $rc
}

# --- Case 7: the SQLite branch is untouched --------------------------------
# A `file:` URL with no database file yet is the SQLite fresh-install path: one
# push, no snapshot (nothing to back up), and none of the Postgres-only steps.
case_sqlite_fresh_install_unchanged() {
  make_app_root
  rc=0
  if DATABASE_URL_PRISMA="file:../data/bot.db" run_auto_migrate; then
    expect_steps "push" || rc=1
    expect_output "fresh install" || rc=1
  else
    echo "  the SQLite fresh-install path must succeed" >&2
    sed 's/^/  | /' "$TMP_ROOT/out.log" >&2
    rc=1
  fi
  rm -rf "$TMP_ROOT"
  return $rc
}

# --- Case 8: every listed data migration exists in this repo ---------------
# Guards against a typo or a renamed folder in $DATA_MIGRATIONS, which in
# production would only surface as a WARNING nobody reads.
case_listed_data_migrations_exist() {
  rc=0
  for _name in $DATA_MIGRATIONS_LIST; do
    if [ ! -f "$SCRIPT_DIR/prisma/migrations/$_name/migration.sql" ]; then
      echo "  \$DATA_MIGRATIONS lists $_name, but prisma/migrations/$_name/migration.sql does not exist" >&2
      rc=1
    fi
  done
  return $rc
}

if [ -z "$DATA_MIGRATIONS_LIST" ]; then
  echo "FAIL: could not read \$DATA_MIGRATIONS from $ENTRYPOINT"
  exit 1
fi

case_postgres_runs_push_then_seed_then_data && pass "postgres runs push then seed then data migrations" || fail "postgres runs push then seed then data migrations"
case_push_failure_exits_and_skips_rest && pass "push failure exits 1 and skips the rest" || fail "push failure exits 1 and skips the rest"
case_seed_failure_warns_and_continues && pass "non-zero seed warns and continues" || fail "non-zero seed warns and continues"
case_auto_migrate_off_skips_everything && pass "AUTO_MIGRATE=0 skips everything" || fail "AUTO_MIGRATE=0 skips everything"
case_sentinel_skips_everything && pass "SKIP_AUTO_MIGRATE sentinel skips everything" || fail "SKIP_AUTO_MIGRATE sentinel skips everything"
case_missing_url_refuses && pass "missing DATABASE_URL_PRISMA refuses to start" || fail "missing DATABASE_URL_PRISMA refuses to start"
case_sqlite_fresh_install_unchanged && pass "SQLite fresh install unchanged" || fail "SQLite fresh install unchanged"
case_listed_data_migrations_exist && pass "every listed data migration exists" || fail "every listed data migration exists"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES case(s) failed."
  exit 1
fi
echo "All 8 cases passed."
