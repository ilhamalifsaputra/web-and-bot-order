# Fase 0 — Pondasi Postgres Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrasikan satu-satunya DB dari SQLite (`data/bot.db`) ke Postgres tanpa mengubah logika bisnis, sehingga bot, notifier, dan web lama berjalan di Postgres dengan suite Vitest hijau — pondasi yang dibutuhkan sebelum Next.js/Auth.js (Fase 1+).

**Architecture:** Prisma `datasource` diubah ke `postgresql`; semua kolom `Decimal` diberi anotasi presisi eksplisit `@db.Decimal(12,4)` (kontrak uang lama Numeric(12,4)). `initDb()` jadi no-op aman-Postgres. Test harness membuat schema Postgres unik per-run. Sebuah skrip sekali-jalan menyalin data SQLite→Postgres dalam urutan FK lalu mereset sequence. Docker Compose mendapat service `postgres`; semua app menunjuk ke sana.

**Tech Stack:** Prisma 5.22, PostgreSQL 16, Vitest 2, better-sqlite3 (hanya skrip migrasi), Docker Compose, pg_dump.

## Global Constraints

- **Decimal untuk semua uang**, presisi `@db.Decimal(12, 4)` (sumber: `packages/core/src/money.ts` — "All monetary values use 4 decimal places (Numeric(12,4))"). Jangan pernah `float`.
- **Jangan ubah nama tabel/kolom** — setiap `@map`/`@@map` harus tetap byte-identik (schema.prisma header).
- **No raw SQL in routes/handlers** — kode produksi tetap lewat `packages/db/src/crud/*`. (Raw SQL hanya boleh di skrip migrasi & test harness.)
- **UTC di DB.** Semua DateTime tetap UTC; tidak ada konversi timezone saat migrasi.
- **`pnpm typecheck` + `pnpm test` wajib hijau** di akhir tiap task yang menyentuh kode.
- **Node engine** `>=20`; pnpm `9.15.9`.
- **Provider Postgres tunggal**: `postgresql`. URL via `DATABASE_URL_PRISMA`. Test pakai `TEST_DATABASE_URL`.

---

## File Structure

- `prisma/schema.prisma` — Modify: `datasource` provider → `postgresql`; tambah `@db.Decimal(12,4)` ke semua field Decimal; tambahkan `binaryTargets` runtime Linux untuk Docker. (Nama @map TIDAK berubah.)
- `prisma/migrations/` — Modify: arsipkan migrasi SQLite lama; buat baseline Postgres baru `0_init`.
- `packages/db/src/client.ts` — Modify: `initDb()` jadi no-op aman-Postgres (hapus PRAGMA SQLite); pertahankan BigInt `toJSON`.
- `tests/helpers/testdb.ts` — Modify: buat schema Postgres unik per-`makeTestDb()` (bukan file SQLite sementara); cleanup `DROP SCHEMA … CASCADE`.
- `scripts/migrate-sqlite-to-postgres.ts` — Create: penyalin data sekali-jalan SQLite→Postgres.
- `scripts/migrate-sqlite-to-postgres.test.ts` — Create: test integrasi penyalin (SQLite kecil → Postgres test schema).
- `scripts/db-backup.sh`, `scripts/db-restore.sh` — Create: `pg_dump`/`pg_restore` (mengganti backup WAL-SQLite M-5).
- `.env.example` — Modify: `DATABASE_URL_PRISMA` Postgres + `TEST_DATABASE_URL`.
- `docker-compose.yml` — Modify: tambah service `postgres` + volume; app menunjuk ke Postgres; volume `./data` hanya untuk uploads.
- `Dockerfile` — Modify: dummy `DATABASE_URL_PRISMA` saat generate → URL Postgres dummy; tambah `postgresql-client` untuk skrip backup.
- `package.json` (root) — Modify: tambah script `db:migrate-pg` dan `prisma:push`.

---

## Task 1: Switch Prisma datasource ke Postgres + presisi Decimal

**Files:**
- Modify: `prisma/schema.prisma:8-19` (generator + datasource) dan setiap baris field `Decimal`.

**Interfaces:**
- Produces: schema Postgres valid; tipe Prisma Client tak berubah (Decimal tetap `Decimal`). Tidak ada simbol baru.

- [ ] **Step 1: Ubah generator + datasource**

Ganti blok `generator client { … }` dan `datasource db { … }` (baris 8–19) menjadi:

```prisma
generator client {
  provider      = "prisma-client-js"
  // Engine Linux untuk image Docker; "native" tetap dipakai di host dev/CI.
  binaryTargets = ["native", "debian-openssl-3.0.x"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL_PRISMA")
}
```

- [ ] **Step 2: Beri anotasi presisi ke SEMUA field Decimal**

Postgres butuh presisi eksplisit (default Prisma `Decimal(65,30)` salah untuk uang). Tambahkan `@db.Decimal(12, 4)` ke setiap field `Decimal`/`Decimal?` berikut (pertahankan `@map`/`@default` yang sudah ada). Daftar lengkap field Decimal di schema:

- `User.walletBalance` → `Decimal @default(0) @map("wallet_balance") @db.Decimal(12, 4)`
- `User.walletBalanceUsdt` → `Decimal @default(0) @map("wallet_balance_usdt") @db.Decimal(12, 4)`
- `WalletTransaction.delta` → `Decimal @db.Decimal(12, 4)`
- `WalletTransaction.balanceAfter` → `Decimal @map("balance_after") @db.Decimal(12, 4)`
- `Product.price` → `Decimal @db.Decimal(12, 4)`
- `Product.resellerPrice` → `Decimal? @map("reseller_price") @db.Decimal(12, 4)`
- `Order.subtotalAmount` → `Decimal @map("subtotal_amount") @db.Decimal(12, 4)`
- `Order.discountAmount` → `Decimal @default(0) @map("discount_amount") @db.Decimal(12, 4)`
- `Order.uniqueCents` → `Decimal @default(0) @map("unique_cents") @db.Decimal(12, 4)`
- `Order.totalAmount` → `Decimal @map("total_amount") @db.Decimal(12, 4)`
- `Order.walletUsed` → `Decimal @default(0) @map("wallet_used") @db.Decimal(12, 4)`
- `Order.bulkDiscountAmount` → `Decimal @default(0) @map("bulk_discount_amount") @db.Decimal(12, 4)`
- `Order.fxRate` → `Decimal? @map("fx_rate") @db.Decimal(12, 4)`
- `OrderItem.unitPrice` → `Decimal @map("unit_price") @db.Decimal(12, 4)`
- `Voucher.value` → `Decimal @db.Decimal(12, 4)`
- `Voucher.minPurchase` → `Decimal @default(0) @map("min_purchase") @db.Decimal(12, 4)`
- `Referral.commission` → `Decimal @db.Decimal(12, 4)`
- `BulkPricing.discountPercent` → `Decimal @map("discount_percent") @db.Decimal(12, 4)`
- `ProcessedBinanceTx.amount` → `Decimal? @db.Decimal(12, 4)`
- `ProcessedBybitTx.amount` → `Decimal? @db.Decimal(12, 4)`
- `ProcessedTokopayTx.amount` → `Decimal? @db.Decimal(12, 4)`

- [ ] **Step 3: Validasi schema**

Run: `pnpm exec prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 4: Generate client**

Run: `pnpm exec prisma generate`
Expected: `Generated Prisma Client` tanpa error.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (tipe Decimal tak berubah, jadi `crud/*` tetap kompilasi).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): switch Prisma datasource to Postgres + explicit Decimal(12,4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Buat Postgres tersedia + baseline migration

**Files:**
- Modify: `.env.example` (bagian DATABASE)
- Modify: `docker-compose.yml` (service `postgres` minimal untuk dev/test)
- Modify: `prisma/migrations/` (arsipkan SQLite, buat `0_init` Postgres)
- Modify: `package.json` root (script `prisma:push`)

**Interfaces:**
- Produces: instance Postgres lokal di `localhost:5432` db `botorder`; `DATABASE_URL_PRISMA` Postgres; baseline migration Postgres.

- [ ] **Step 1: Tambah service postgres ke docker-compose.yml**

Tambahkan di bawah `services:` (sebelum `order-bot`):

```yaml
  postgres:
    image: postgres:16-alpine
    container_name: bot-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: botorder
      POSTGRES_PASSWORD: botorder
      POSTGRES_DB: botorder
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U botorder -d botorder"]
      interval: 10s
      timeout: 5s
      retries: 5
```

Dan tambahkan di akhir file (top-level):

```yaml
volumes:
  pgdata:
```

- [ ] **Step 2: Update bagian DATABASE di .env.example**

Ganti baris `DATABASE_URL_PRISMA=file:../data/bot.db` (dan komentarnya) menjadi:

```bash
# ---------------------------------------------------------------------
# DATABASE (Postgres)
# ---------------------------------------------------------------------
# Dev lokal lewat docker compose service `postgres`:
DATABASE_URL_PRISMA=postgresql://botorder:botorder@localhost:5432/botorder?schema=public
# DB terpisah untuk test (suite membuat schema unik per-run di dalamnya):
TEST_DATABASE_URL=postgresql://botorder:botorder@localhost:5432/botorder
```

- [ ] **Step 3: Nyalakan Postgres lokal & set env lokal**

Run:
```bash
docker compose up -d postgres
cp -n .env.example .env || true
```
Set `DATABASE_URL_PRISMA` dan `TEST_DATABASE_URL` di `.env` ke nilai Postgres di atas.
Verifikasi: `docker compose exec postgres pg_isready -U botorder` → `accepting connections`.

- [ ] **Step 4: Arsipkan migrasi SQLite & buat baseline Postgres**

Migrasi lama berisi SQL khusus-SQLite (`AUTOINCREMENT`, `DATETIME`) yang tidak jalan di Postgres.

Run:
```bash
mkdir -p prisma/migrations-sqlite-archive
git mv prisma/migrations/* prisma/migrations-sqlite-archive/ 2>/dev/null || mv prisma/migrations/* prisma/migrations-sqlite-archive/
pnpm exec prisma migrate dev --name init
```
Expected: folder baru `prisma/migrations/<timestamp>_init/migration.sql` berisi SQL Postgres (`SERIAL`/`createSequence`, `DECIMAL(12,4)`, `TIMESTAMP(3)`), dan migrasi diterapkan ke DB lokal. `migration_lock.toml` berisi `provider = "postgresql"`.

- [ ] **Step 5: Tambah script root**

Di `package.json` root, bagian `scripts`, tambahkan:
```json
    "prisma:push": "prisma db push",
    "db:migrate-pg": "tsx scripts/migrate-sqlite-to-postgres.ts",
```

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example prisma/migrations prisma/migrations-sqlite-archive package.json
git commit -m "feat(db): add postgres service + Postgres baseline migration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `initDb()` aman-Postgres

**Files:**
- Modify: `packages/db/src/client.ts:24-36`
- Test: `packages/db/src/client.test.ts` (Create)

**Interfaces:**
- Consumes: `prisma` dari `./client`.
- Produces: `initDb(): Promise<void>` tetap diekspor dengan signature sama; kini tanpa PRAGMA SQLite (idempotent no-op yang hanya memastikan koneksi).

- [ ] **Step 1: Tulis test yang gagal**

Create `packages/db/src/client.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { initDb, prisma } from "./client";

describe("initDb (Postgres-safe)", () => {
  it("runs without issuing SQLite PRAGMAs and is idempotent", async () => {
    await initDb();
    await initDb(); // second call must be a no-op, not throw
    // proves the client is connected to Postgres
    const rows = await prisma.$queryRawUnsafe<{ ok: number }[]>("SELECT 1 AS ok");
    expect(rows[0]?.ok).toBe(1);
    await prisma.$disconnect();
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `TEST_DATABASE_URL set; DATABASE_URL_PRISMA=$TEST_DATABASE_URL pnpm exec vitest run packages/db/src/client.test.ts`
Expected: FAIL — `initDb` saat ini menjalankan `PRAGMA …` yang error di Postgres (`syntax error at or near "PRAGMA"`).

- [ ] **Step 3: Implementasi minimal**

Ganti body `initDb()` (baris 24–36) menjadi:
```typescript
let initialized = false;

/**
 * Postgres connection warm-up. SQLite PRAGMAs (FK/WAL/busy_timeout) are not
 * applicable on Postgres — FK enforcement and concurrency are native. Kept as
 * an idempotent export so existing call sites (apps/server, tests) are unchanged.
 */
export async function initDb(): Promise<void> {
  if (initialized) return;
  await prisma.$queryRawUnsafe("SELECT 1");
  initialized = true;
}
```

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `DATABASE_URL_PRISMA=$TEST_DATABASE_URL pnpm exec vitest run packages/db/src/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/client.ts packages/db/src/client.test.ts
git commit -m "feat(db): Postgres-safe initDb (drop SQLite PRAGMAs)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Test harness Postgres (schema unik per-run)

**Files:**
- Modify: `tests/helpers/testdb.ts`

**Interfaces:**
- Consumes: `process.env.TEST_DATABASE_URL`.
- Produces: `makeTestDb(): Promise<TestDb>` dan `interface TestDb { prisma: PrismaClient; cleanup: () => Promise<void> }` — signature TIDAK berubah (semua test lama tetap memanggil sama).

- [ ] **Step 1: Ganti isi testdb.ts**

Ganti seluruh file dengan implementasi berbasis schema Postgres unik:
```typescript
/**
 * Test DB helper (Postgres): create an isolated, uniquely-named schema in the
 * TEST_DATABASE_URL database, push the canonical schema into it, and hand back a
 * PrismaClient bound to it. Schemas are dropped on cleanup, so test files run in
 * parallel without touching each other or the dev DB. Signature is unchanged
 * from the old SQLite helper, so every crud/*.test.ts keeps working as-is.
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

export interface TestDb {
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}

function baseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required to run the test suite");
  return url;
}

/** Append/replace the `schema=` query param on a Postgres URL. */
function withSchema(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set("schema", schema);
  return u.toString();
}

export async function makeTestDb(): Promise<TestDb> {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const url = withSchema(baseUrl(), schema);

  // db push creates all tables in this schema in FK-correct order.
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL_PRISMA: url },
    stdio: "ignore",
  });

  const prisma = new PrismaClient({ datasourceUrl: url });

  return {
    prisma,
    cleanup: async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await prisma.$disconnect();
    },
  };
}
```

- [ ] **Step 2: Jalankan satu test crud sebagai bukti**

Run: `pnpm exec vitest run packages/db/src/crud/bulk_pricing.test.ts`
Expected: PASS (harness membuat schema, `activeBulkPricingByProduct` jalan di Postgres).

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/testdb.ts
git commit -m "test(db): Postgres per-run schema isolation in makeTestDb

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Gerbang paritas — seluruh suite hijau di Postgres

**Files:** (tidak ada perubahan kode; gerbang verifikasi. Perbaikan kecil bila ada drift.)

**Interfaces:**
- Consumes: harness Task 4, schema Task 1.

- [ ] **Step 1: Jalankan seluruh suite**

Run: `pnpm test`
Expected: SEMUA test lulus. Suite ini mencakup `pricing`, `orders`, `stock`, `reconciliation`, `vouchers`, `wallet`, `reviews`, dsb. — bukti paritas perilaku crud di Postgres.

- [ ] **Step 2: Bila ada kegagalan terkait Decimal/teks**

Jika sebuah test gagal karena format Decimal (mis. `"10"` vs `"10.0000"`), itu drift presisi: konfirmasi anotasi `@db.Decimal(12, 4)` di Task 1 terpasang pada field terkait, regenerate (`pnpm exec prisma generate`), lalu ulangi Step 1. Jangan melonggarkan assertion test.

- [ ] **Step 3: Typecheck penuh**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit (bila ada perbaikan drift)**

```bash
git add -A
git commit -m "test(db): green crud suite on Postgres (parity gate)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Skrip migrasi data SQLite → Postgres

**Files:**
- Create: `scripts/migrate-sqlite-to-postgres.ts`
- Create: `scripts/migrate-sqlite-to-postgres.test.ts`
- Modify: `package.json` root devDependencies (`better-sqlite3`)

**Interfaces:**
- Produces: `migrateSqliteToPostgres(opts: { sqlitePath: string; prisma: PrismaClient }): Promise<Record<string, number>>` — menyalin tiap tabel dalam urutan FK, mengembalikan jumlah baris per tabel; lalu mereset sequence id.

- [ ] **Step 1: Tambah better-sqlite3 (devDep)**

Run: `pnpm add -Dw better-sqlite3 @types/better-sqlite3`
Expected: terpasang di root `package.json`.

- [ ] **Step 2: Tulis test yang gagal**

Create `scripts/migrate-sqlite-to-postgres.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeTestDb, type TestDb } from "../tests/helpers/testdb";
import { migrateSqliteToPostgres } from "./migrate-sqlite-to-postgres";

let db: TestDb;
let dir: string;
let sqlitePath: string;

beforeAll(async () => {
  db = await makeTestDb();
  dir = mkdtempSync(join(tmpdir(), "mig-"));
  sqlitePath = join(dir, "src.db");
  // Minimal legacy SQLite with the columns the copier reads.
  const s = new Database(sqlitePath);
  s.exec(`
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT, emoji TEXT, sort_order INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1);
    CREATE TABLE products (id INTEGER PRIMARY KEY, category_id INTEGER, name TEXT, description TEXT, image_file_id TEXT, web_image_url TEXT, type TEXT, duration_label TEXT, price DECIMAL, reseller_price DECIMAL, warranty_days INTEGER DEFAULT 30, is_active INTEGER DEFAULT 1, created_at TEXT, product_group_id INTEGER);
    INSERT INTO categories (id,name,emoji,sort_order,is_active) VALUES (1,'Streaming','🎬',0,1);
    INSERT INTO products (id,category_id,name,type,duration_label,price,warranty_days,is_active,created_at) VALUES (7,1,'Netflix','SHARED','1 Month','59000.0000',30,1,'2026-01-01 00:00:00');
  `);
  s.close();
});
afterAll(async () => {
  await db.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("migrateSqliteToPostgres", () => {
  it("copies rows preserving ids, money, booleans, and resets sequences", async () => {
    const counts = await migrateSqliteToPostgres({ sqlitePath, prisma: db.prisma });
    expect(counts.categories).toBe(1);
    expect(counts.products).toBe(1);

    const p = await db.prisma.product.findUniqueOrThrow({ where: { id: 7 } });
    expect(p.name).toBe("Netflix");
    expect(p.isActive).toBe(true);
    expect(p.price.toFixed(4)).toBe("59000.0000");

    // sequence advanced past the highest imported id → new insert gets id 8
    const created = await db.prisma.product.create({
      data: { categoryId: 1, name: "Spotify", type: "SHARED", durationLabel: "1 Month", price: "30000" },
    });
    expect(created.id).toBe(8);
  });
});
```

- [ ] **Step 3: Jalankan test, pastikan gagal**

Run: `pnpm exec vitest run scripts/migrate-sqlite-to-postgres.test.ts`
Expected: FAIL — `Cannot find module './migrate-sqlite-to-postgres'`.

- [ ] **Step 4: Implementasi skrip**

Create `scripts/migrate-sqlite-to-postgres.ts`:
```typescript
/**
 * One-shot data migration: copy every row from the legacy SQLite DB into the
 * Postgres DB behind the given PrismaClient, in FK-dependency order, then reset
 * each table's id sequence. Booleans (0/1) and datetime strings are coerced to
 * the types Prisma expects; Decimals are passed as strings (exact). Run with:
 *   pnpm db:migrate-pg            (uses DATABASE_URL_PRISMA + SQLITE_PATH)
 */
import Database from "better-sqlite3";
import type { PrismaClient } from "@prisma/client";

/** Tables in FK-safe insertion order; value = Prisma delegate name. */
const ORDER: Array<{ table: string; model: keyof PrismaClient }> = [
  { table: "users", model: "user" },
  { table: "categories", model: "category" },
  { table: "product_groups", model: "productGroup" },
  { table: "products", model: "product" },
  { table: "stock_items", model: "stockItem" },
  { table: "vouchers", model: "voucher" },
  { table: "orders", model: "order" },
  { table: "order_items", model: "orderItem" },
  { table: "reviews", model: "review" },
  { table: "referrals", model: "referral" },
  { table: "support_tickets", model: "supportTicket" },
  { table: "ticket_messages", model: "ticketMessage" },
  { table: "restock_subscriptions", model: "restockSubscription" },
  { table: "cart_items", model: "cartItem" },
  { table: "bulk_pricing", model: "bulkPricing" },
  { table: "wallet_transactions", model: "walletTransaction" },
  { table: "password_reset_tokens", model: "passwordResetToken" },
  { table: "settings", model: "setting" },
  { table: "audit_logs", model: "auditLog" },
  { table: "notification_outbox", model: "notificationOutbox" },
  { table: "broadcasts", model: "broadcast" },
  { table: "processed_binance_tx", model: "processedBinanceTx" },
  { table: "processed_bybit_tx", model: "processedBybitTx" },
  { table: "processed_tokopay_tx", model: "processedTokopayTx" },
];

/** snake_case column → boolean: SQLite stores 0/1, Postgres needs true/false. */
const BOOL_COLS = new Set(["is_active", "banned", "hidden", "paid", "used"]);
/** snake_case datetime columns → Date. */
const DATE_COLS = new Set([
  "created_at", "updated_at", "last_seen_at", "added_at", "reserved_at", "sold_at",
  "expires_at", "paid_at", "delivered_at", "replied_at", "sent_at", "scheduled_at",
  "used_at", "reset_at",
]);

function coerce(col: string, val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (BOOL_COLS.has(col)) return val === 1 || val === "1" || val === true;
  if (DATE_COLS.has(col)) return new Date(typeof val === "number" ? val : String(val).replace(" ", "T") + (String(val).includes("Z") ? "" : "Z"));
  return val; // text / number / Decimal-as-string pass through unchanged
}

export async function migrateSqliteToPostgres(opts: {
  sqlitePath: string;
  prisma: PrismaClient;
}): Promise<Record<string, number>> {
  const sqlite = new Database(opts.sqlitePath, { readonly: true });
  const counts: Record<string, number> = {};
  try {
    for (const { table } of ORDER) {
      const exists = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      if (!exists) { counts[table] = 0; continue; }
      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
      let n = 0;
      for (const row of rows) {
        const cols = Object.keys(row);
        const coerced = cols.map((c) => coerce(c, row[c]));
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const colList = cols.map((c) => `"${c}"`).join(", ");
        await opts.prisma.$executeRawUnsafe(
          `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
          ...coerced,
        );
        n++;
      }
      counts[table] = n;
      // Advance the id sequence so future inserts don't collide with copied ids.
      await opts.prisma.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1), true)`,
      );
    }
    return counts;
  } finally {
    sqlite.close();
  }
}

// CLI entry: only runs when invoked directly (not when imported by the test).
const invokedDirectly = process.argv[1]?.endsWith("migrate-sqlite-to-postgres.ts");
if (invokedDirectly) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const sqlitePath = process.env.SQLITE_PATH ?? "./data/bot.db";
  const counts = await migrateSqliteToPostgres({ sqlitePath, prisma });
  // eslint-disable-next-line no-console
  console.log("Migrated rows:", counts);
  await prisma.$disconnect();
}
```

- [ ] **Step 5: Jalankan test, pastikan lulus**

Run: `pnpm exec vitest run scripts/migrate-sqlite-to-postgres.test.ts`
Expected: PASS (ids dipertahankan, `isActive=true`, `price=59000.0000`, sequence lanjut ke 8).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck` → PASS, lalu:
```bash
git add scripts/migrate-sqlite-to-postgres.ts scripts/migrate-sqlite-to-postgres.test.ts package.json pnpm-lock.yaml
git commit -m "feat(db): one-shot SQLite→Postgres data migrator + test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Backup pg_dump (ganti backup WAL-SQLite M-5)

**Files:**
- Create: `scripts/db-backup.sh`, `scripts/db-restore.sh`
- Modify: `Dockerfile` (tambah `postgresql-client` di stage runtime)

**Interfaces:**
- Produces: `scripts/db-backup.sh [out_dir]` → file `botorder-<ts>.dump`; `scripts/db-restore.sh <dump_file>` → restore.

- [ ] **Step 1: Tulis db-backup.sh**

Create `scripts/db-backup.sh`:
```bash
#!/bin/sh
# Postgres logical backup (replaces the WAL-safe SQLite backup, M-5).
# Reads DATABASE_URL_PRISMA. Usage: scripts/db-backup.sh [out_dir]
set -e
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
TS=$(date +%Y%m%d-%H%M%S)
DEST="$OUT_DIR/botorder-$TS.dump"
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL_PRISMA" --file="$DEST"
echo "Backup written: $DEST"
```

- [ ] **Step 2: Tulis db-restore.sh**

Create `scripts/db-restore.sh`:
```bash
#!/bin/sh
# Restore a custom-format dump produced by db-backup.sh.
# Usage: scripts/db-restore.sh <dump_file>
set -e
DUMP="$1"
[ -z "$DUMP" ] && { echo "usage: db-restore.sh <dump_file>" >&2; exit 1; }
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL_PRISMA" "$DUMP"
echo "Restored from: $DUMP"
```

- [ ] **Step 3: Tambah postgresql-client ke Dockerfile runtime**

Di `Dockerfile`, stage runtime (baris ~45), ubah baris apt-get menjadi termasuk `postgresql-client`:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends openssl tini gosu postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@9.15.9 --activate \
    && groupadd -r app && useradd -r -g app -m -d /home/app app
```
Juga ubah baris dummy generate env (baris 15) → `ENV DATABASE_URL_PRISMA=postgresql://u:p@localhost:5432/db?schema=public` (nilai dummy; Prisma generate tidak konek).

- [ ] **Step 4: Uji backup berjalan (smoke)**

Run:
```bash
chmod +x scripts/db-backup.sh scripts/db-restore.sh
DATABASE_URL_PRISMA="postgresql://botorder:botorder@localhost:5432/botorder" sh scripts/db-backup.sh ./backups
```
Expected: `Backup written: ./backups/botorder-<ts>.dump` dan file ada.

- [ ] **Step 5: Commit**

```bash
git add scripts/db-backup.sh scripts/db-restore.sh Dockerfile
git commit -m "ops(backup): pg_dump backup/restore scripts (replace SQLite WAL backup)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Wire semua service Docker ke Postgres

**Files:**
- Modify: `docker-compose.yml` (x-app env + depends_on; volume data hanya uploads)

**Interfaces:**
- Consumes: service `postgres` (Task 2).

- [ ] **Step 1: Tambah DATABASE_URL + depends_on ke x-app**

Di blok `x-app: &app`, tambahkan `environment` dan `depends_on` agar setiap app menunggu Postgres sehat dan menunjuk ke sana (override `.env` agar host = nama service `postgres`, bukan `localhost`):
```yaml
x-app: &app
  build:
    context: .
  image: bot-order-node:latest
  restart: unless-stopped
  env_file:
    - .env
  environment:
    DATABASE_URL_PRISMA: "postgresql://botorder:botorder@postgres:5432/botorder?schema=public"
  depends_on:
    postgres:
      condition: service_healthy
  volumes:
    - ./data:/app/data   # uploads + logs only; DB now lives in the pgdata volume
  logging:
    driver: json-file
    options:
      max-size: "10m"
      max-file: "5"
```

- [ ] **Step 2: Validasi compose**

Run: `docker compose config >/dev/null && echo OK`
Expected: `OK` (tiap service mewarisi `DATABASE_URL_PRISMA` Postgres + `depends_on: postgres`).

- [ ] **Step 3: Update komentar header docker-compose.yml**

Ganti komentar pembuka yang menyebut "ONE SQLite file (./data/bot.db, WAL mode)" menjadi catatan bahwa DB kini Postgres (service `postgres`, volume `pgdata`) dan `./data` hanya untuk uploads/logs. Hapus peringatan single-writer SQLite yang sudah tak relevan.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(deploy): point all services at Postgres; data volume = uploads only

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Cutover data DB dev (manual, sekali jalan)

**Files:** (tidak ada perubahan kode — prosedur cutover terverifikasi.)

- [ ] **Step 1: Backup SQLite sumber**

Run: `cp data/bot.db data/bot.db.pre-pg-$(date +%Y%m%d-%H%M%S)`
Expected: salinan dibuat.

- [ ] **Step 2: Pastikan schema Postgres terbaru**

Run: `pnpm exec prisma migrate deploy`
Expected: migrasi `0_init` Postgres diterapkan (atau "No pending migrations").

- [ ] **Step 3: Jalankan migrasi data**

Run: `SQLITE_PATH=./data/bot.db pnpm db:migrate-pg`
Expected: `Migrated rows: { users: N, categories: …, products: …, orders: …, … }` tanpa error.

- [ ] **Step 4: Verifikasi jumlah baris**

Run (bandingkan beberapa tabel kunci):
```bash
echo "SQLite:"; for t in users orders products stock_items; do printf "%s=" "$t"; sqlite3 data/bot.db "SELECT COUNT(*) FROM $t"; done
echo "Postgres:"; docker compose exec postgres psql -U botorder -d botorder -c "SELECT 'users',COUNT(*) FROM users UNION ALL SELECT 'orders',COUNT(*) FROM orders UNION ALL SELECT 'products',COUNT(*) FROM products UNION ALL SELECT 'stock_items',COUNT(*) FROM stock_items;"
```
Expected: jumlah baris cocok per tabel. Bila tidak cocok, jangan lanjut — periksa error di Step 3.

- [ ] **Step 5: Smoke test app lama di Postgres**

Run: `pnpm dev:web` (web-admin lama, kini di Postgres), buka `/catalog`, pastikan produk & harga tampil benar (Decimal utuh), lalu hentikan.
Expected: halaman katalog render dengan data yang termigrasi; tidak ada error koneksi/tipe.

- [ ] **Step 6: Catat selesai**

Tidak ada commit (langkah operasional). Fase 0 selesai: seluruh stack lama berjalan di Postgres dengan suite hijau dan data termigrasi.

---

## Self-Review

**Spec coverage (Bagian 3 — Data layer & migrasi Postgres):**
- provider → postgresql ✓ (Task 1) · Decimal presisi ✓ (Task 1) · enum tetap String ✓ (tidak diubah) · skrip migrasi data + verifikasi baris ✓ (Task 6, 9) · test crud paritas di Postgres ✓ (Task 4, 5) · backup pg_dump ✓ (Task 7). Docker Postgres ✓ (Task 2, 8).
- **Deferred ke Fase 1 (dengan alasan):** Auth.js & `packages/ui` (shadcn) & Caddy-untuk-Next — tidak punya konsumen di Fase 0, tak bisa diuji berdiri sendiri.

**Placeholder scan:** Tidak ada TBD/TODO; setiap step berisi perintah/kode konkret.

**Type consistency:** `makeTestDb`/`TestDb` (Task 4) cocok dengan pemakaian di test lama & Task 6. `migrateSqliteToPostgres({ sqlitePath, prisma })` dipanggil identik di test (Task 6 Step 2) dan CLI (Step 4). `initDb()` signature tak berubah (Task 3).

**Catatan risiko:** `db push` per file test menambah waktu suite (beberapa detik/skema). Bila terlalu lambat, optimasi (template schema) bisa jadi follow-up — tidak menghalangi paritas.
