# RUN.md — Running & Cutover Runbook (Node stack)

Operational guide for deploying the migrated Node services and performing the
strangler-fig cutover from the Python stack. Pairs with `migrate.md` (Fase 1/3/5).

The three Node services (`order-bot`, `web-admin`, `notifier`) share **one**
SQLite file in WAL mode, mounted at `/app/data/bot.db`.

---

## 0. Prerequisites

- Docker + Docker Compose v2 on the host (`docker compose version`).
- A `.env` at repo root with the keys the services read (see `packages/core/src/config.ts`).
  Required: `BOT_TOKEN`, `BOT_USERNAME`, `ADMIN_IDS`, `BINANCE_PAY_ID`,
  `WEB_COOKIE_SECRET` (≥32 chars), `DATABASE_URL_PRISMA`. For the notifier also
  `NOTIF_BOT_TOKEN`, `PUBLIC_CHANNEL_ID`.
- The shared DB reachable under `./data/` (see §1).

### ⚠ Database path inside the container
Prisma `file:` URLs are ambiguous with relative paths. **For container runs set an
absolute URL** in `.env`:

```dotenv
DATABASE_URL_PRISMA=file:/app/data/bot.db
```

The compose file mounts `./data` → `/app/data`, so `./data/bot.db` on the host is
`/app/data/bot.db` in the container. (The dev value in `.env` may point at the
root `data/` copy — repoint it to the absolute path before deploying.)

---

## 1. Put the database in place

Dev/staging works against the **copy** at `./data/bot.db`. For production cutover,
place (or bind-mount) the live DB there:

```bash
mkdir -p ./data
cp /path/to/prod/data/bot.db        ./data/bot.db
cp /path/to/prod/data/bot.db-wal    ./data/ 2>/dev/null || true
cp /path/to/prod/data/bot.db-shm    ./data/ 2>/dev/null || true
```

> The schema is **never** changed during cutover. Node reads the exact same
> tables the Python stack wrote (enum names stored UPPERCASE — see the schema).

### ⚠⚠ MANDATORY: convert datetime columns before Node reads the DB
Prisma stores SQLite `DateTime` as INTEGER epoch-ms; Python/SQLAlchemy stored it
as TEXT. Prisma **cannot read the Python rows** until converted (every query
throws `P2023`). Run once, against the DB you just placed:

```bash
# preview first:
pnpm exec tsx scripts/convert-datetimes.ts --url "file:/app/data/bot.db"
# then apply (idempotent; back up first!):
pnpm exec tsx scripts/convert-datetimes.ts --apply --url "file:/app/data/bot.db"
```

**This is one-way w.r.t. the Python stack**: after conversion, SQLAlchemy can no
longer read the datetimes, so:
- You **cannot parallel-run** a Python *writer* and a Node *reader* on the same DB.
  The per-service strangler (notifier first, etc.) does NOT apply to the shared
  writable data — treat cutover as atomic: **stop all Python → backup → convert →
  start Node.**
- **Rollback = restore the pre-conversion backup**, then start Python (do not
  point Python at converted data).

(Decimals are unaffected — both stacks use SQLite numeric affinity.)

---

## 2. Build the image

```bash
docker compose build          # builds bot-order-node:latest (shared by all 3)
```

The image runs the apps via `tsx` (no compile step) and bakes in the generated
Prisma client + query-engine binaries.

---

## 3. Phased bring-up (maps to migrate.md fases)

Bring services up one at a time so each fase stays independently rollback-able.

### Fase 1 — Notifier (safest; status-only writes)
Safe to **parallel-run** with the Python notifier on a test channel first.
```bash
docker compose up -d notifier
docker compose logs -f notifier
```
Cutover: stop the Python notifier, keep the Node one. Rollback: the reverse.

### Fase 3 — Web admin
bcrypt hashes are compatible, so existing admins log in without a reset.
```bash
docker compose up -d web-admin
# health: GET http://<host>:${WEB_PORT:-8000}/login should return 200
```
Cutover: repoint your reverse proxy (Caddy/nginx) from uvicorn → this service
(`WEB_PORT`, default 8000). Rollback: point it back.

### Fase 5 — Order bot (highest risk)
**STOP the Python order-bot first.** Never run two order-flow writers on the same
DB (migrate.md §14.12).
```bash
# 1. Back up the DB (see §4).
# 2. Stop the Python bot (its host/compose/systemd unit).
# 3. Start the Node bot:
docker compose up -d order-bot
docker compose logs -f order-bot
```
The Node bot calls `deleteWebhook(drop_pending_updates: true)` on boot, so stale
"Buy"/"Approve" taps queued during the swap are discarded.

---

## 4. Back up before cutover (do this every time)

```bash
ts=$(date +%Y%m%d-%H%M%S)
cp ./data/bot.db ./data/bot.db.bak-$ts
cp ./data/bot.db-wal ./data/bot.db-wal.bak-$ts 2>/dev/null || true
cp ./data/bot.db-shm ./data/bot.db-shm.bak-$ts 2>/dev/null || true
```

---

## 5. Monitor (24–48 h after the bot cutover)

- **Logs**: `docker compose logs -f order-bot` (pino JSON; each line carries
  `updateId`). Watch for `Unhandled error in grammY`.
- **Audit log**: new rows in `audit_logs` for approve/reject/stock/etc.
- **Outbox**: `notification_outbox` rows flip `PENDING → SENT` (the notifier drains them).
- **Reconcile job**: every 6 h; a clean run logs `Reconciliation: clean (no drift)`.
  Drift DMs the first admin and writes a `reconcile_finances.drift` audit row.

---

## 6. Rollback

Each fase is independent and the DB is unchanged, so rollback is "swap the
process back":

```bash
docker compose stop order-bot          # or notifier / web-admin
# then restart the corresponding Python service (and re-point the proxy for web)
```

If you must restore data, stop all writers and copy a `*.bak-*` set back over
`./data/bot.db{,-wal,-shm}`.

---

## 7. Local run without Docker (dev)

```bash
pnpm install
pnpm prisma:generate
pnpm dev:notifier     # or dev:web / dev:bot
```

`pnpm test` runs the full Vitest suite (incl. the order-bot wiring smoke test).

---

## 8. Fase 6 — Post-cutover cleanup (DONE)

The production cutover is complete and the Python stack is retired. Cleanup applied:

- Legacy Python `DATABASE_URL` removed from `.env` / `.env.example` (Node reads
  only `DATABASE_URL_PRISMA`).
- `AlembicVersion` model dropped from the Prisma schema. To remove the orphan
  table from a database, apply the migration once (after a backup):
  ```bash
  pnpm exec prisma db execute --url "file:/app/data/bot.db" \
    --file prisma/migrations/20260531120000_drop_alembic_version/migration.sql
  ```
  (Leaving the table is harmless — the schema no longer references it.)
- Python service trees were already removed; only the Node monorepo remains.

> ⚠ Rollback to Python is **no longer available** post-cleanup — the DateTime
> conversion (§1) is one-way and the Python stack is gone. Keep DB backups.

---

## 9. Optional: SQLite → Postgres (migrate.md §5.4 / §6)

SQLite is fine for a single writer. Move to Postgres only if you need higher
write concurrency. What changes:

- `prisma/schema.prisma`: `datasource db { provider = "postgresql" }`; `DATABASE_URL_PRISMA`
  becomes a `postgresql://…` URL. Re-introspect or `prisma migrate` to recreate
  the schema; **migrate the data** (datetimes become native `timestamptz`, so the
  int-ms hack in §1 is no longer needed; `BigInt` is native).
- **Stock allocation** can use real row locking: `SELECT … FOR UPDATE SKIP LOCKED`
  (via `prisma.$queryRaw`) instead of SQLite's single-writer serialization —
  see `allocateOneAvailableStock` and the `ProcessedBinanceTx` UNIQUE gate, which
  stay correct either way.
- Drop the `busy_timeout`/WAL PRAGMAs in `initDb()` (SQLite-only).
- Re-run the full Vitest suite against a Postgres test DB before cutover.

---

## 10. Known follow-ups

- **Live behavioural test of the bot** against Telegram exercises conversation
  replay end-to-end (the test suite proves logic + DB effects, not the real
  @grammyjs/conversations replay engine).
- **Binance Internal Transfer** auto-confirm is keys-gated and its
  `/sapi/v1/pay/transactions` note-matching assumption is unverified against a
  live read-only key (see `payments/binanceInternal.ts`).
