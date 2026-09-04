#!/bin/sh
# Manual test harness for docker-entrypoint.sh's ensure_credential_key().
# No container needed: reuses the entrypoint's existing APP_ROOT override
# plus ENTRYPOINT_TEST_SOURCE_ONLY (see docker-entrypoint.sh) to source the
# script's functions without running its real migration/exec sequence.
#
# Run: sh deploy/test-entrypoint-credential-key.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENTRYPOINT="$SCRIPT_DIR/docker-entrypoint.sh"
FAILURES=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# --- Case 1: generates on missing -----------------------------------------
case_generates_on_missing() {
  TMP_ROOT="$(mktemp -d)"
  mkdir -p "$TMP_ROOT/data"
  (
    export APP_ROOT="$TMP_ROOT"
    export ENTRYPOINT_TEST_SOURCE_ONLY=1
    unset CREDENTIAL_ENCRYPTION_KEY
    . "$ENTRYPOINT"
    ensure_credential_key
    [ -f "$APP_ROOT/data/credential_encryption.key" ] || { echo "no key file was created" >&2; exit 1; }
    key_len=$(printf '%s' "$CREDENTIAL_ENCRYPTION_KEY" | wc -c | tr -d ' ')
    [ "$key_len" = "64" ] || { echo "exported key is $key_len chars, want 64" >&2; exit 1; }
    file_contents="$(cat "$APP_ROOT/data/credential_encryption.key")"
    [ "$file_contents" = "$CREDENTIAL_ENCRYPTION_KEY" ] || { echo "file contents don't match exported env var" >&2; exit 1; }
  )
  rc=$?
  rm -rf "$TMP_ROOT"
  return $rc
}

# --- Case 2: reuses on existing --------------------------------------------
case_reuses_on_existing() {
  TMP_ROOT="$(mktemp -d)"
  mkdir -p "$TMP_ROOT/data"
  existing_key="$(printf '%064d' 0 | tr '0' 'a')"
  printf '%s' "$existing_key" > "$TMP_ROOT/data/credential_encryption.key"
  (
    export APP_ROOT="$TMP_ROOT"
    export ENTRYPOINT_TEST_SOURCE_ONLY=1
    unset CREDENTIAL_ENCRYPTION_KEY
    . "$ENTRYPOINT"
    ensure_credential_key
    [ "$CREDENTIAL_ENCRYPTION_KEY" = "$existing_key" ] || { echo "exported key doesn't match pre-existing file" >&2; exit 1; }
    file_contents="$(cat "$APP_ROOT/data/credential_encryption.key")"
    [ "$file_contents" = "$existing_key" ] || { echo "file was modified" >&2; exit 1; }
  )
  rc=$?
  rm -rf "$TMP_ROOT"
  return $rc
}

# --- Case 3: fails on corrupted --------------------------------------------
case_fails_on_corrupted() {
  TMP_ROOT="$(mktemp -d)"
  mkdir -p "$TMP_ROOT/data"
  printf 'not-a-valid-key' > "$TMP_ROOT/data/credential_encryption.key"
  (
    export APP_ROOT="$TMP_ROOT"
    export ENTRYPOINT_TEST_SOURCE_ONLY=1
    unset CREDENTIAL_ENCRYPTION_KEY
    . "$ENTRYPOINT"
    ERR_FILE="$APP_ROOT/stderr.log"
    if ( ensure_credential_key ) 2>"$ERR_FILE"; then
      echo "ensure_credential_key succeeded but should have failed" >&2
      exit 1
    fi
    grep -q "does not contain a valid" "$ERR_FILE" || { echo "missing expected error message" >&2; exit 1; }
    file_contents="$(cat "$APP_ROOT/data/credential_encryption.key")"
    [ "$file_contents" = "not-a-valid-key" ] || { echo "corrupted file was modified despite failure" >&2; exit 1; }
  )
  rc=$?
  rm -rf "$TMP_ROOT"
  return $rc
}

# --- Case 4: respects env override -----------------------------------------
case_respects_env_override() {
  TMP_ROOT="$(mktemp -d)"
  mkdir -p "$TMP_ROOT/data"
  override_key="$(printf '%064d' 0 | tr '0' 'b')"
  conflicting_file_key="$(printf '%064d' 0 | tr '0' 'c')"
  printf '%s' "$conflicting_file_key" > "$TMP_ROOT/data/credential_encryption.key"
  (
    export APP_ROOT="$TMP_ROOT"
    export ENTRYPOINT_TEST_SOURCE_ONLY=1
    export CREDENTIAL_ENCRYPTION_KEY="$override_key"
    . "$ENTRYPOINT"
    ensure_credential_key
    [ "$CREDENTIAL_ENCRYPTION_KEY" = "$override_key" ] || { echo "env override was not respected" >&2; exit 1; }
    file_contents="$(cat "$APP_ROOT/data/credential_encryption.key")"
    [ "$file_contents" = "$conflicting_file_key" ] || { echo "conflicting file was overwritten" >&2; exit 1; }
  )
  rc=$?
  rm -rf "$TMP_ROOT"
  return $rc
}

case_generates_on_missing && pass "generates on missing" || fail "generates on missing"
case_reuses_on_existing && pass "reuses on existing" || fail "reuses on existing"
case_fails_on_corrupted && pass "fails on corrupted" || fail "fails on corrupted"
case_respects_env_override && pass "respects env override" || fail "respects env override"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES case(s) failed."
  exit 1
fi
echo "All 4 cases passed."
