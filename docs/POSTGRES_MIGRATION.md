# Postgres migration cutover runbook

Step-by-step, copy-pasteable commands for migrating a **real production**
shop from the SQLite-based stack (`docker-compose.yml`) to the Postgres
production layer (`docker-compose.postgres.prod.yml`). Run every command
below yourself, on your own VPS, from the repo root — Claude Code cannot
reach your VPS and has not run any of this against production.

Run the numbered sections in order. Do not skip section 7 (the
reconciliation gate) no matter how confident section 6 looked.

---

## 1. Prerequisites

- **Docker + Docker Compose v2.24+** on the VPS (the app's `server` service
  uses `env_file: path/required: false`, which needs 2.24+). Check with:

  ```bash
  docker compose version
  ```

- **This repository checked out with this branch's changes present** — i.e.
  `docker-compose.postgres.prod.yml`, `scripts/migrate-sqlite-to-postgres.ts`,
  and `scripts/reconcile-sqlite-postgres.ts` must exist at the repo root /
  `scripts/`. Confirm:

  ```bash
  git log --oneline -1 -- docker-compose.postgres.prod.yml scripts/migrate-sqlite-to-postgres.ts scripts/reconcile-sqlite-postgres.ts
  ```

- **A real production `.env` with the Postgres block filled in.** Open
  `.env.example` and find the `--- PostgreSQL produksi
  (docker-compose.postgres.prod.yml) ---` block. Uncomment and fill in, in
  your real `.env` (not `.env.example`):

  ```
  POSTGRES_DB=bot_order
  POSTGRES_USER=bot_order
  POSTGRES_PASSWORD=<a strong random password>
  DATABASE_URL_PRISMA=postgresql://bot_order:<the same password>@postgres:5432/bot_order
  ```

  The `DATABASE_URL_PRISMA` host **must** be the literal service name
  `postgres`, not `localhost`/`127.0.0.1` — that only resolves on the
  internal Compose network between the `server` and `postgres` containers
  (`docker-compose.postgres.prod.yml`'s own header comment). Comment out (or
  remove) the existing `DATABASE_URL_PRISMA=file:../data/bot.db` line so only
  one `DATABASE_URL_PRISMA` is active — the file explicitly warns "isi salah
  satu... bukan dua-duanya sekaligus" (fill in exactly one, not both).

  If you run more than one shop on this host, `POSTGRES_DB`/`POSTGRES_USER`/
  `POSTGRES_PASSWORD` must be unique per shop (`.env.example`'s own `[multi]`
  note).

- **Expected downtime (freeze-to-cutover window).** The real validation runs
  in this worktree (Tasks 5–7, against a full production snapshot — 124
  users, 273 orders, 6,501 rows across 36 tables) completed the data-transform
  and reconciliation without any observed slowness, but **no task report
  captured a wall-clock duration** for those steps, so there is no measured
  number to quote here. Do not treat any number below as verified — it is
  a rough estimate based on the row counts and the migration script's own
  batching (`BATCH_SIZE = 500`, one Prisma transaction, a few dozen round
  trips total for this dataset's size):
  - Sections 2–5 (freeze, backup, bring up Postgres, push schema): a few
    minutes, dominated by container startup and `docker compose down`/`up`,
    not data volume.
  - Section 6 (data transform) at this dataset's size: likely under a minute.
  - Section 7 (reconciliation): comparable to section 6, since it reads
    every row on both sides.
  - **Before your real cutover**, rehearse sections 2–8 once against a
    staging copy of your actual production data and time it yourself — that
    measured number, not this estimate, is what you should tell users/admins
    to expect. If your production database is much larger than the
    124-user/6,501-row snapshot this was validated against, scale the
    estimate accordingly; the migration script's per-batch round trips and
    the reconciliation's per-row Decimal comparison are both roughly linear
    in row count.

---

## 2. Freeze application writes

Stop the currently-running SQLite-based stack so no further writes land
after the backup in section 3 is taken. Per `docker-compose.yml`'s own
documented commands:

```bash
docker compose down
```

This stops and removes the `server` container (data is safe — `./data` is a
bind mount, untouched by `down`). Confirm nothing is left running:

```bash
docker compose ps
```

Do **not** run `docker compose down -v` — that would remove named volumes.
`docker-compose.yml`'s stack doesn't declare any for the app itself, but
avoid the habit regardless; the Postgres layer's `postgres_data` volume
(section 4) matters and must not be touched here.

---

## 3. Back up the real production SQLite database

Use the repo's existing SQLite backup tooling (`deploy/backup/backup.sh`) —
do **not** build new Postgres backup tooling; the target is empty at this
point in the runbook, there is nothing to back up there yet, and a Postgres
backup mechanism is explicitly out of scope for this migration.

`backup.sh` takes an **online, WAL-safe** snapshot via SQLite's own
`.backup` API (folds in any un-checkpointed `-wal` contents), so it is safe
to run even against a live DB — but since the stack is already stopped
(section 2), this also doubles as a clean, fully-quiesced snapshot. Run it
with the real production DB path:

```bash
DB=./data/bot.db DEST=./data/backups RETENTION=28 deploy/backup/backup.sh
```

(Adjust `DB`/`DEST` if your production `./data` lives at a different
absolute path, e.g. `DB=/srv/app/data/bot.db DEST=/srv/backups` — both forms
are documented in `deploy/backup/backup.sh`'s own header comment and
`deploy/backup/README.md`.)

Expected output ends with a line like:

```
OK  backup=./data/backups/bot-2026-08-27-153000.db (XXX K, integrity=ok)  gz=./data/backups/bot-2026-08-27-153000.db.gz
```

`backup.sh` already runs `PRAGMA integrity_check` on the snapshot and
refuses (deletes the file, exits non-zero) if it fails — do not proceed past
a failed backup. **Note the exact `bot-<timestamp>.db` filename it prints**
— you need it for section 6, and it is the file section 9's rollback
restores from if anything goes wrong.

This step never touches or modifies the original `data/bot.db` — it only
reads it to produce the snapshot in `data/backups/`.

---

## 4. Bring up the Postgres container (schema-empty)

Bring up **only** the `postgres` service first — not `server` — since
`server` will crash-loop with Prisma `P2021` (`table ... does not exist`)
until the schema is pushed in section 5 (confirmed in Task 8's own
verification: this is the real, reproduced failure mode, not a hypothetical
one).

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml up -d postgres
```

Wait for it to report healthy:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml ps postgres
```

Look for `Up ... (healthy)` in the `STATUS` column — the container's own
`pg_isready` healthcheck (`interval: 10s, timeout: 5s, retries: 5`) needs
up to ~50 seconds worst case on a cold start. Do not proceed to section 5
until it shows healthy.

---

## 5. Apply the schema to the empty Postgres database

`docker-entrypoint.sh`'s `auto_migrate()` only knows how to snapshot-and-push
a `file:` (SQLite) URL — for a `postgresql://` `DATABASE_URL_PRISMA` it
deliberately no-ops (`resolve_db_path()` returns non-zero, so `auto_migrate()`
logs "Skipping the automatic schema update; apply it yourself." and returns
0, no crash). This is confirmed directly in `docker-compose.postgres.prod.yml`'s
own header comment and reproduced end-to-end in Task 8's verification. So the
schema push is an explicit manual step here, run once against the still-empty
database:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml \
  run --rm server pnpm exec prisma db push --schema prisma/schema.prisma
```

Expected output ends with:

```
🚀  Your database is now in sync with your Prisma schema. Done in X.XXs
```

`db push` here is safe to run against an empty database without
`--accept-data-loss` — there is no existing Postgres data yet to lose. Do
not add `--accept-data-loss` to this specific invocation; it is unnecessary
and you want to notice if `db push` ever unexpectedly refuses.

---

## 6. Run the data-transform script against the real backup

Runs `scripts/migrate-sqlite-to-postgres.ts` (Task 5) inside the `server`
container, since it needs the built app + `node_modules` (`node:sqlite` +
the generated Postgres-provider `@prisma/client`) — this mirrors how Task
5/6/7 actually ran the scripts in this worktree (via `pnpm tsx`/`pnpm exec
tsx`), adapted to run inside the production container via `docker compose
run --rm server` the same way section 5's `prisma db push` does.

The script takes the source SQLite path as `argv[2]` (default `./data/bot.db`
— see the script's own `resolveSqlitePath()`) and reads `DATABASE_URL_PRISMA`
from the environment for the Postgres target (already set correctly in your
`.env`, which `server`'s `env_file: .env` in `docker-compose.yml` loads).
Point it explicitly at the section-3 backup file, not the live `./data/bot.db`,
so there is no ambiguity about which snapshot was actually imported:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml \
  run --rm server pnpm exec tsx scripts/migrate-sqlite-to-postgres.ts data/backups/bot-<your-timestamp>.db
```

Replace `bot-<your-timestamp>.db` with the exact filename section 3 printed.
The path is relative to the container's `/app` working directory, where
`./data` is bind-mounted (`docker-compose.yml`'s `volumes: - ./data:/app/data`)
— `data/backups/bot-<timestamp>.db` inside the container is the same file as
`./data/backups/bot-<timestamp>.db` on the host.

Expected output ends with a per-table row-count comparison and:

```
[migrate] DONE — <N> rows imported across 36 tables, all row counts match.
```

with process exit code 0. If it instead throws `Refusing to run: target
already has rows in ...` — this means the target already has data (e.g. a
retry after a partial attempt) — do **not** re-run blindly. Investigate
first; the fix, once you're sure it's safe, is to reset the target schema —
the script's own header comment recommends exactly this (`prisma db push
--force-reset`, discarding whatever partial import is there):

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml \
  run --rm server pnpm exec prisma db push --schema prisma/schema.prisma --force-reset
```

and re-run this step.

This step never writes to the source file — `migrate-sqlite-to-postgres.ts`
opens it `new DatabaseSync(sqlitePath, { readOnly: true })` (script source,
confirmed directly), so the section-3 backup (and the original
`data/bot.db`, which this step doesn't even touch) is untouched no matter
what happens next.

---

## 7. Run reconciliation — required gate

**Do not proceed to section 8 unless this step exits 0 and prints `Overall
verdict: PASS`.** If it reports `FAIL`, stop here and follow the rollback
procedure in section 9 — do not attempt to "fix forward" past a failed
reconciliation.

Same invocation pattern as section 6, pointed at the same backup file:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml \
  run --rm server pnpm exec tsx scripts/reconcile-sqlite-postgres.ts data/backups/bot-<your-timestamp>.db
```

This script (Task 6) is read-only on both sides — it opens the SQLite source
`readOnly: true` and only ever runs `SELECT`s against Postgres — so it is
safe to re-run as many times as you want. It checks two things:

1. Row counts for all 36 tables match between source and target.
2. Every Decimal-typed column's value (29 fields across 16 tables) matches
   exactly, compared as strings, for every row.

Expected output ends with:

```
=== SUMMARY ===
Tables checked:        36
Row-count matches:     36/36
Decimal values checked: <N>
Decimal value matches:  <N>/<N>
Overall verdict: PASS
```

and exit code 0. If any row-count or Decimal mismatch is reported, the
script prints exactly which table/id/column disagreed and how (see the
`Mismatches (up to first 50 shown)` section of its output) — save that
output before starting section 9, since it is the evidence you'll want when
diagnosing what went wrong before attempting the migration again.

---

## 8. Cutover — start the full stack

Only after section 7 printed `PASS`: bring up the complete stack, including
`server` this time. Because `server` now `depends_on: postgres: condition:
service_healthy` (`docker-compose.postgres.prod.yml`), and Postgres is
already healthy and schema-applied from sections 4–5, `server` should start
clean this time (no P2021 crash-loop, since the schema and data already
exist):

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml up -d
```

Confirm it's healthy the same way Task 7's validation did — `server`'s own
Docker healthcheck hits `/healthz` internally, but check it directly too:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml ps server
curl -i http://127.0.0.1:${WEB_PORT:-8000}/healthz
curl -i http://127.0.0.1:${STOREFRONT_PORT:-8100}/healthz
```

Expect `Up ... (healthy)` from `ps`, and `HTTP/1.1 200 OK` with body
`{"status":"ok"}` from both `curl`s (substitute your real `WEB_PORT`/
`STOREFRONT_PORT` from `.env` if you didn't leave them at the
`docker-compose.yml` defaults of 8000/8100). Both ports are published
`127.0.0.1`-only (`docker-compose.yml`'s convention — nginx is the only
public surface), so run these `curl`s from the VPS itself, not remotely.

Once both `/healthz` checks pass, the stack is live on Postgres. Proceed to
section 10 for what to watch next — do not consider the migration finished
yet.

---

## 9. Rollback procedure

If anything in sections 4–8 fails, or post-cutover monitoring (section 10)
finds a real problem: revert to the SQLite-based stack pointed at the
section-3 backup. This is safe because **the original `data/bot.db` was
never touched by any step above** — section 6's migration script opens its
SQLite source `readOnly: true` (confirmed in the script's own source, see
section 6 above), and every step before section 8 only ever wrote to the new
Postgres container, never to `./data/bot.db`.

1. **Bring the Postgres-based stack down:**

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml down
   ```

   (Leave off `-v` — do not delete the `postgres_data` volume yet; keep it
   around in case you want to inspect what went wrong before discarding it.)

2. **Bring the original SQLite-based stack back up.** Since `data/bot.db`
   was never modified, this is just:

   ```bash
   docker compose up -d
   ```

   If for any reason you need to restore from the section-3 backup instead
   of trusting the live `data/bot.db` (e.g. you're not sure what state it
   was left in), use the existing restore tooling instead of a manual copy:

   ```bash
   deploy/backup/restore.sh ./data/backups/bot-<your-timestamp>.db
   ```

   `restore.sh` stops `server`, writes `data/SKIP_AUTO_MIGRATE` (so the
   entrypoint doesn't try to auto-migrate the restored DB forward again),
   swaps the file, clears stale `-wal`/`-shm` sidecars, verifies
   `integrity_check`, restarts `server`, and smoke-tests `/healthz` itself —
   see `deploy/backup/README.md` for the full step list. Remember to remove
   the sentinel once you're ready for automatic schema updates again:

   ```bash
   rm ./data/SKIP_AUTO_MIGRATE
   docker compose restart server
   ```

3. **Confirm the rollback is healthy:**

   ```bash
   curl -i http://127.0.0.1:${WEB_PORT:-8000}/healthz
   ```

**Keep the section-3 SQLite backup until Postgres has run successfully in
production for a reasonable observation period** (section 10) — do not
delete it right after a cutover that merely *looks* successful. A cutover
that passes section 7's reconciliation and section 8's `/healthz` checks can
still surface a real problem hours later under live traffic (a code path
section 7 didn't exercise, a Decimal edge case not present in the snapshot,
etc.); the backup is your only way back to a known-good state until you're
confident that risk has passed.

---

## 10. Post-cutover monitoring

Before considering the migration final, watch all of the following for at
least a full day of real traffic (adjust upward for a low-traffic shop where
a day may not exercise every code path — order placement, payment
confirmation, refunds, wallet top-ups, and admin actions should each have
happened at least once):

- **Container logs**, watching for anything Postgres-shaped that wouldn't
  have occurred under SQLite (constraint violations, connection pool
  exhaustion, unexpected `P20xx` Prisma error codes):

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml logs -f server
  docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml logs -f postgres
  ```

- **`/healthz`**, periodically, on both listeners:

  ```bash
  curl -i http://127.0.0.1:${WEB_PORT:-8000}/healthz
  curl -i http://127.0.0.1:${STOREFRONT_PORT:-8100}/healthz
  ```

- **Order and payment flows actually completing**, not just the health
  endpoint returning 200 — place (or watch a real customer place) at least
  one real order through to a completed/paid status, confirm a refund and a
  wallet top-up each work end-to-end, and spot-check that a few Decimal
  amounts displayed in the admin panel and storefront match what you'd
  expect (the migration's Decimal handling was verified exhaustively against
  the migrated snapshot in Tasks 5/6, but that's not a substitute for
  watching real new writes behave correctly too).
- **Postgres container health**, not just the app's:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml ps postgres
  ```

Once you've observed a normal traffic day with no Postgres-shaped errors and
have watched real orders/payments/refunds/top-ups complete successfully,
consider the migration final — at that point (and not before), the
section-3 SQLite backup can move to your normal backup retention/off-box
rotation instead of being kept as an active rollback target.
