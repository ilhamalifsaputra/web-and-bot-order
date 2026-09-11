# Auto-generate `CREDENTIAL_ENCRYPTION_KEY` for production deploys

## Problem

Saving an encrypted Setting (e.g. "Digiflazz API key") or a manual-account
stock item's credentials requires `CREDENTIAL_ENCRYPTION_KEY` — a 32-byte
AES-256-GCM key, 64 hex characters — to be present in the process
environment (`packages/core/src/credentialCrypto.ts`). Today that's a manual
step: generate it with `openssl rand -hex 32`, paste it into `.env`. Every
production deploy has to remember to do this before the first save that
needs it, or the save fails with:

> Credential encryption is not configured on this server — set
> CREDENTIAL_ENCRYPTION_KEY and try again.

The user doesn't want to hand-fill this value in production — it should
come into existence automatically.

## Goal

On the Docker production path, `CREDENTIAL_ENCRYPTION_KEY` becomes available
with zero manual steps on first boot, and stays **stable** across restarts,
redeploys, and image rebuilds — losing it after data has been encrypted
under it makes that data permanently unreadable, so stability matters more
than convenience here.

## Non-goals

- Local dev (`pnpm dev:*`, no `docker-entrypoint.sh` in the loop) — still
  requires a manual `.env` entry, same as every other dev secret in this
  repo. Out of scope for this spec.
- Key rotation — already has a documented manual procedure
  (`scripts/backfill-encrypt-stock-credentials.ts` + swap the env var). This
  spec is bootstrap-only: what happens when no key exists yet.
- The legacy manual `/bootstrap` deploy path (`DOCS.md` §"Jalur manual
  /bootstrap (deploy lama)`) — Docker is the only path this spec touches.

## Design

### Where

`docker-entrypoint.sh` gains a new function, `ensure_credential_key()`,
called early — right after the existing root→app chown of `$DATA_DIR`,
before `auto_migrate`. This guarantees every later step (including the app
process itself, once `exec`'d) sees a fully-configured environment.

### Persistence

The key is generated into `$DATA_DIR/credential_encryption.key`
(`$DATA_DIR` = `$APP_ROOT/data`, already bind-mounted from the host per the
entrypoint's existing chown comment). This directory already carries the
entrypoint's durability guarantee for `SKIP_AUTO_MIGRATE`, so the key
survives `docker compose down/up`, redeploys, and image rebuilds without any
new mount configuration.

Storing the key file separately from the database (which now lives in
Postgres's own named volume, not `./data`) is a deliberate security
property: a Postgres-only compromise does not also leak the key needed to
decrypt the credentials it contains.

### Logic

```
ensure_credential_key():
  if $CREDENTIAL_ENCRYPTION_KEY is already set:
    # Operator explicitly configured it (e.g. multi-instance setup, or a
    # deliberate rotation in progress) — never override.
    return

  key_file = $DATA_DIR/credential_encryption.key

  if key_file exists:
    contents = read(key_file)
    if contents does not match ^[0-9a-f]{64}$:
      log ERROR "corrupted key file at $key_file — refusing to start.
        Regenerating would silently orphan every credential already
        encrypted under the old key. Restore the correct file from backup,
        or if you accept the data loss, remove the file and restart."
      exit 1
    export CREDENTIAL_ENCRYPTION_KEY = contents
    return

  # No env var, no file: first boot.
  new_key = $(openssl rand -hex 32)
  write new_key to key_file
  chmod 600 key_file
  chown app:app key_file          # mirrors the existing DATA_DIR chown
  log "Generated a new credential encryption key at $key_file. This file
    must be part of your backups — losing it makes every already-encrypted
    credential (Settings like the Digiflazz API key, and any manual-account
    stock item) permanently unreadable. It is never printed to the log."
  export CREDENTIAL_ENCRYPTION_KEY = new_key
```

`openssl` is already installed in the runtime image (`Dockerfile`, both
build and runtime stages install it for Prisma's query engine), and is the
same command `.env.example`'s own comment already tells operators to run by
hand — this just runs it for them.

The key value itself is never written to the container's stdout/stderr —
only the file path and the "back this up" warning. This matches the
project's existing "never log secrets" convention
(`packages/core/src/credentialCrypto.ts`'s own header comment goes further
and forbids logging even the ciphertext envelope).

### Failure mode

A key file that exists but doesn't decode to exactly 32 bytes of hex is
treated the same way the entrypoint already treats an unrecoverable
migration-comparison failure: log a clear error and `exit 1` rather than
guess. Silently generating a replacement key would leave existing encrypted
rows permanently undecryptable with no error at all until someone tries to
read them — a much worse failure than refusing to boot.

### Documentation

- `.env.example`'s existing `CREDENTIAL ENCRYPTION` section gets a note that
  in the Docker deploy path this is now auto-generated into
  `data/credential_encryption.key` if left unset, and that file must be
  covered by whatever backs up the host's `./data` directory (it is
  intentionally **not** part of `deploy/backup/backup.sh`, which is a
  DB-only, engine-aware dump script).
- `DOCS.md`'s deploy section gets the same pointer, so it's discoverable
  from the deploy runbook without having to already know to look in
  `.env.example`.

## Testing

`docker-entrypoint.sh` has no existing test harness — it's currently only
exercised by building and running the real Docker image. The script already
has a built-in seam for this: `APP_ROOT` is overridable specifically so
"the schema logic below can be exercised outside a container" (existing
comment, line 25).

Add `deploy/test-entrypoint-credential-key.sh`: sources `ensure_credential_key`
out of `docker-entrypoint.sh` (or invokes the script with `APP_ROOT` pointed
at a temp dir and a stub `"$@"`, whichever proves simpler once written) and
covers:

1. **Generates on missing** — no env var, no file → a 64-hex-char file is
   created, `CREDENTIAL_ENCRYPTION_KEY` ends up exported with the same
   value.
2. **Reuses on existing** — a valid pre-existing file → that exact value is
   exported, no new file write.
3. **Fails on corrupted** — a file with the wrong length/non-hex content →
   the function exits non-zero and does not export a value.
4. **Respects env override** — `CREDENTIAL_ENCRYPTION_KEY` already set in
   the environment, with or without a file present → that value passes
   through unchanged, file is left untouched (create a conflicting file in
   this case specifically, to prove it's genuinely ignored, not just
   coincidentally equal).

This is a shell test (no existing JS/TS harness covers `docker-entrypoint.sh`,
and pulling shell logic into Vitest via a subprocess would be more
indirection than the four cases above justify).
