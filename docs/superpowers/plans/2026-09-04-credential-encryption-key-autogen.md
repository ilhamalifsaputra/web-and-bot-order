# Auto-generate CREDENTIAL_ENCRYPTION_KEY Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Docker production path, `CREDENTIAL_ENCRYPTION_KEY` becomes available with zero manual `.env` steps on first boot, and stays stable across restarts/redeploys.

**Architecture:** `docker-entrypoint.sh` gains a new `ensure_credential_key()` function, called before `auto_migrate`. Priority: existing `$CREDENTIAL_ENCRYPTION_KEY` env var (operator override) > existing `data/credential_encryption.key` file > generate with `openssl rand -hex 32` and persist to that file. A corrupted (wrong-length/non-hex) key file is a hard failure (`exit 1`), never a silent regenerate — that would orphan every row already encrypted under the old key. The key is deliberately stored in a file under the bind-mounted `data/` directory, not in `.env` or the database, so a Postgres-only compromise doesn't also leak the key that decrypts what it contains.

**Tech Stack:** POSIX `sh` (docker-entrypoint.sh already targets `#!/bin/sh`, must stay portable — no bashisms), `openssl rand -hex 32` (already installed in the runtime image per `Dockerfile`).

**Full spec:** `docs/superpowers/specs/2026-09-04-credential-encryption-key-autogen-design.md`

## Global Constraints

- `docker-entrypoint.sh` stays POSIX `sh`-compatible (no bash-only syntax) — it's invoked directly, not via bash, in the runtime image.
- Never write the key value itself to stdout/stderr/logs — only the file path and a backup warning (matches `packages/core/src/credentialCrypto.ts`'s existing "never log secrets" convention).
- `set -e` is active for the whole script — every new conditional must use patterns (`if`, `||`, `!`) that are exempt from it, matching the existing `auto_migrate()`/`db_push()` style.
- Local dev (`pnpm dev:*`) is explicitly out of scope — this only runs through `docker-entrypoint.sh`.

---

### Task 1: `ensure_credential_key()` in docker-entrypoint.sh + test harness

**Files:**
- Modify: `docker-entrypoint.sh`
- Create: `deploy/test-entrypoint-credential-key.sh`

**Interfaces:**
- Produces: shell function `ensure_credential_key()` (no args) — on success, `$CREDENTIAL_ENCRYPTION_KEY` is exported in the current shell as a 64-hex-char string, and `$DATA_DIR/credential_encryption.key` exists containing that same string. On a corrupted existing file, it prints an error to stderr and calls `exit 1`. Also produces `$CREDENTIAL_KEY_FILE` (= `"$DATA_DIR/credential_encryption.key"`), a `main()` function wrapping the existing bottom-of-script logic, and an `ENTRYPOINT_TEST_SOURCE_ONLY` env-var guard that skips calling `main` when set — this is what lets the test harness `source` the script safely.

- [ ] **Step 1: Refactor the bottom of docker-entrypoint.sh into `main()` behind a test-source guard (no behavior change yet)**

This is a pure refactor so the script becomes safely `source`-able by a test harness — without it, sourcing the script would immediately run the real `auto_migrate`/`exec` sequence.

Replace the current end of the file (everything from the `# chown only when needed` comment to the final `exec "$@"`):

```sh
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

auto_migrate

if [ -n "$RUN_AS" ]; then
  exec gosu app "$@"
fi

# Already non-root (e.g. compose `user:` override) — run as-is.
exec "$@"
```

with:

```sh
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
# migration/exec sequence.
if [ -z "${ENTRYPOINT_TEST_SOURCE_ONLY:-}" ]; then
  main "$@"
fi
```

- [ ] **Step 2: Verify the refactor didn't change real behavior**

Run: `APP_ROOT=/tmp/entrypoint-refactor-check sh -n docker-entrypoint.sh`
Expected: no output (syntax check only — `sh -n` parses without executing). If your `sh` is dash/ash, this also catches any accidental bashism from the refactor.

- [ ] **Step 3: Add `CREDENTIAL_KEY_FILE`**

Modify the variable block near the top of `docker-entrypoint.sh`:

```sh
APP_ROOT="${APP_ROOT:-/app}"
DATA_DIR="$APP_ROOT/data"
SKIP_SENTINEL="$DATA_DIR/SKIP_AUTO_MIGRATE"
PRISMA="$APP_ROOT/node_modules/.bin/prisma"
SCHEMA="$APP_ROOT/prisma/schema.prisma"
BACKUP="$APP_ROOT/deploy/backup/backup.sh"
```

becomes:

```sh
APP_ROOT="${APP_ROOT:-/app}"
DATA_DIR="$APP_ROOT/data"
SKIP_SENTINEL="$DATA_DIR/SKIP_AUTO_MIGRATE"
PRISMA="$APP_ROOT/node_modules/.bin/prisma"
SCHEMA="$APP_ROOT/prisma/schema.prisma"
BACKUP="$APP_ROOT/deploy/backup/backup.sh"
CREDENTIAL_KEY_FILE="$DATA_DIR/credential_encryption.key"
```

- [ ] **Step 4: Write the (failing) test harness**

Create `deploy/test-entrypoint-credential-key.sh`:

```sh
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
```

- [ ] **Step 5: Run the test harness and verify it fails (function doesn't exist yet)**

Run: `sh deploy/test-entrypoint-credential-key.sh`
Expected: all 4 cases print `FAIL`, with an error mentioning `ensure_credential_key: not found` (or your shell's equivalent "command not found" phrasing) in each subshell's stderr, and the script exits non-zero with `4 case(s) failed.`

- [ ] **Step 6: Implement `ensure_credential_key()`**

Insert this function into `docker-entrypoint.sh` immediately after the closing `}` of `auto_migrate()` (i.e. between `auto_migrate()`'s body and the `main() {` block added in Step 1):

```sh
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
    if ! printf '%s' "$_key" | grep -Eq '^[0-9a-f]{64}$'; then
      log "ERROR: $CREDENTIAL_KEY_FILE does not contain a valid 64-character hex key. Refusing to start: regenerating would silently orphan every credential already encrypted under the old key. Restore the correct file from backup, or if you accept the data loss, remove the file and restart." >&2
      exit 1
    fi
    export CREDENTIAL_ENCRYPTION_KEY="$_key"
    return 0
  fi

  _key="$(openssl rand -hex 32)"
  printf '%s' "$_key" > "$CREDENTIAL_KEY_FILE"
  chmod 600 "$CREDENTIAL_KEY_FILE"
  if [ "$(id -u)" = "0" ]; then
    chown app:app "$CREDENTIAL_KEY_FILE"
  fi
  log "Generated a new credential encryption key at $CREDENTIAL_KEY_FILE. This file must be part of your backups — losing it makes every already-encrypted credential (Settings like the Digiflazz API key, and any manual-account stock item) permanently unreadable. The key itself is never written to this log."
  export CREDENTIAL_ENCRYPTION_KEY="$_key"
}
```

- [ ] **Step 7: Wire it into `main()`**

In `main()` (added in Step 1), change:

```sh
  auto_migrate
```

to:

```sh
  ensure_credential_key
  auto_migrate
```

- [ ] **Step 8: Run the test harness and verify it passes**

Run: `sh deploy/test-entrypoint-credential-key.sh`
Expected:
```
PASS: generates on missing
PASS: reuses on existing
PASS: fails on corrupted
PASS: respects env override
All 4 cases passed.
```

- [ ] **Step 9: Re-check script syntax**

Run: `sh -n docker-entrypoint.sh`
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add docker-entrypoint.sh deploy/test-entrypoint-credential-key.sh
git commit -m "feat(deploy): auto-generate CREDENTIAL_ENCRYPTION_KEY on first boot

Production deploys no longer need a manual CREDENTIAL_ENCRYPTION_KEY in
.env. docker-entrypoint.sh now generates one on first boot (openssl rand
-hex 32) and persists it to data/credential_encryption.key, separate
from the database it protects. An operator-set env var always wins; a
corrupted key file refuses to start rather than silently orphaning
already-encrypted data.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Document the auto-generated key

**Files:**
- Modify: `.env.example`
- Modify: `DOCS.md`

**Interfaces:**
- Consumes: nothing from Task 1 at the code level — this is documentation only. Read Task 1's summary first so the wording stays accurate to what was actually built.

- [ ] **Step 1: Add the Docker auto-gen note to `.env.example`**

Find this block in `.env.example`:

```
# CREDENTIAL_ENCRYPTION_KEY=ganti-dengan-64-karakter-hex-acak
```

Replace it with:

```
# CREDENTIAL_ENCRYPTION_KEY=ganti-dengan-64-karakter-hex-acak
#
# Deploy Docker (docker-entrypoint.sh): kalau variabel ini dikosongkan, key
# di-generate otomatis sekali saat container pertama kali start, lalu
# disimpan di data/credential_encryption.key — BUKAN di .env atau database,
# supaya kebocoran DB saja tidak ikut membocorkan key-nya. File itu WAJIB
# ikut ter-backup bersama ./data host kamu (deploy/backup/backup.sh hanya
# mem-backup database, bukan file ini). Kalau file itu hilang, semua
# credential yang sudah terenkripsi tidak bisa dibaca lagi selamanya.
```

- [ ] **Step 2: Add the same pointer to `DOCS.md`**

Find this line in `DOCS.md` (§14, "Setup lewat wizard (default)"):

```
`WEB_COOKIE_SECRET` boleh dikosongkan (di-generate & disimpan otomatis saat boot).
```

Replace it with:

```
`WEB_COOKIE_SECRET` boleh dikosongkan (di-generate & disimpan otomatis saat boot).

`CREDENTIAL_ENCRYPTION_KEY` juga boleh dikosongkan di deploy Docker — di-generate
otomatis sekali oleh `docker-entrypoint.sh` dan disimpan di
`data/credential_encryption.key` (lihat `.env.example`). Pastikan file itu ikut
ter-backup: kalau hilang, semua credential yang sudah terenkripsi (Digiflazz
API key, akun manual di stok) tidak bisa dibaca lagi selamanya.
```

- [ ] **Step 3: Proofread both edits in place**

Run: `grep -n -A 8 "CREDENTIAL_ENCRYPTION_KEY=ganti" .env.example`
Expected: the new paragraph appears directly after the existing key line, no stray blank-comment-line mistakes (every added line starts with `#`).

Run: `grep -n -A 6 "WEB_COOKIE_SECRET.*boleh dikosongkan" DOCS.md`
Expected: the new `CREDENTIAL_ENCRYPTION_KEY` paragraph appears right after it, before the `### Jalur manual /bootstrap` heading.

- [ ] **Step 4: Commit**

```bash
git add .env.example DOCS.md
git commit -m "docs: document the auto-generated CREDENTIAL_ENCRYPTION_KEY

Points operators at data/credential_encryption.key and the backup
implication, next to the existing WEB_COOKIE_SECRET auto-gen note this
mirrors.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
