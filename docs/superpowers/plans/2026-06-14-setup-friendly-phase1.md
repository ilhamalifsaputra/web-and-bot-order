# Phase 1 — Setup-Friendly Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hilangkan tiga penghalang setup awam tanpa mengubah perilaku deploy yang sudah ada: `BINANCE_PAY_ID` tak lagi memblokir boot, `WEB_COOKIE_SECRET` ter-generate otomatis bila kosong, dan daftar admin bisa berasal dari DB (gabungan env ∪ DB) — fondasi untuk wizard Fase 2.

**Architecture:** Mengikuti pola `runtime.ts` (state proses ter-resolve saat boot, fallback ke env) + resolver di `@app/db` (pola `resolveBotCredentials`). Sumber kebenaran admin/secret dipindah ke `@app/core/runtime`; semua pemakai `isAdmin`/`config.ADMIN_IDS` dialihkan ke sana. Composition root menstempel nilai ter-resolve saat boot. Tidak ada perubahan skema DB (pakai tabel `Setting` yang sudah ada).

**Tech Stack:** TypeScript (ESM), zod (`@app/core/config`), Prisma/SQLite (`@app/db`), Vitest, Fastify (web-admin). Acuan spec: [`docs/superpowers/specs/2026-06-14-web-setup-wizard-design.md`](../specs/2026-06-14-web-setup-wizard-design.md).

---

## File Structure

**Dibuat:**
- `packages/core/src/runtime.test.ts` — unit test state runtime (admin ids + cookie secret).
- `packages/db/src/crud/admins.ts` — `resolveAdminIds()`, `ADMIN_IDS_KEY`, helper add/remove admin id di Setting.
- `packages/db/src/crud/admins.test.ts` — unit test resolver (stub `Db`).
- `packages/db/src/crud/web_secret.ts` — `resolveWebCookieSecret()`, `WEB_COOKIE_SECRET_KEY`.
- `packages/db/src/crud/web_secret.test.ts` — unit test (generate sekali, env-wins).

**Dimodifikasi:**
- `packages/core/src/config.ts` — `BINANCE_PAY_ID` opsional; hapus `isAdmin` (pindah ke runtime).
- `packages/core/src/runtime.ts` — tambah `adminIds`/`isAdmin`/`setAdminIds`/`addAdminId` + `webCookieSecret`/`setWebSecret`.
- `packages/db/src/index.ts` — ekspor crud baru.
- `apps/web-admin/src/auth.ts` & `apps/storefront/src/auth.ts` — `cookieSecret()` baca runtime.
- Pemakai `isAdmin` (7 file) — ganti sumber import ke `@app/core/runtime`.
- Pemakai fan-out `config.ADMIN_IDS` (≈10 file) — ganti ke `adminIds()`.
- `apps/server/src/index.ts`, `apps/web-admin/src/main.ts`, `apps/storefront/src/main.ts`, `apps/order-bot/src/main.ts`, `apps/notifier/src/main.ts` — stempel `adminIds` + `webCookieSecret` saat boot.
- `apps/web-admin/src/routes/admins.ts` — tampilkan admin DB + form tambah/hapus admin id.

---

## Task 1: `BINANCE_PAY_ID` jadi opsional

**Files:**
- Modify: `packages/core/src/config.ts:52,63` (ekspor schema `Env` + jadikan `BINANCE_PAY_ID` opsional)
- Test: `packages/core/src/config.test.ts` (create)

> Kenapa ekspor `Env`: `config` di-parse sekali saat import (cached), jadi tak bisa
> diuji ulang dengan menghapus env. Menguji **schema** langsung itu deterministik.
> `BINANCE_PAY_ID` saat ini satu-satunya field tanpa default/optional, jadi
> `Env.parse({})` gagal hanya karenanya.

- [ ] **Step 1: Tulis test yang gagal**

Create `packages/core/src/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Env } from "./config";

describe("config schema", () => {
  it("parses with no env at all (BINANCE_PAY_ID not required)", () => {
    expect(() => Env.parse({})).not.toThrow();
  });

  it("defaults BINANCE_PAY_ID to empty string", () => {
    expect(Env.parse({}).BINANCE_PAY_ID).toBe("");
  });
});
```

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/core test -- config.test.ts`
Expected: FAIL — `Env` belum diekspor, dan `Env.parse({})` melempar karena
`BINANCE_PAY_ID` wajib.

- [ ] **Step 3: Implementasi minimal**

Di `packages/core/src/config.ts`:

(a) Ekspor schema — ubah baris 52 dari:
```ts
const Env = z.object({
```
jadi:
```ts
export const Env = z.object({
```

(b) Baris 63, ubah:
```ts
  BINANCE_PAY_ID: z.string(),
```
jadi:
```ts
  // Optional: kosong = Binance Pay manual tidak dikonfigurasi (boot tetap jalan).
  BINANCE_PAY_ID: z.string().default(""),
```

- [ ] **Step 4: Jalankan test → lulus**

Run: `pnpm --filter @app/core test -- config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts
git commit -m "feat(config): BINANCE_PAY_ID optional so minimal boot succeeds"
```

---

## Task 2: Runtime state untuk admin ids + cookie secret

**Files:**
- Modify: `packages/core/src/runtime.ts`
- Test: `packages/core/src/runtime.test.ts` (create)

- [ ] **Step 1: Tulis test yang gagal**

Create `packages/core/src/runtime.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  adminIds,
  isAdmin,
  setAdminIds,
  addAdminId,
  resetBotIdentity,
  webCookieSecret,
  setWebSecret,
} from "./runtime";

beforeEach(() => resetBotIdentity());

describe("runtime admin ids", () => {
  it("isAdmin reads the stamped set", () => {
    setAdminIds([111, 222]);
    expect(isAdmin(111)).toBe(true);
    expect(isAdmin(999)).toBe(false);
  });

  it("addAdminId extends the live set without duplicates", () => {
    setAdminIds([111]);
    addAdminId(222);
    addAdminId(222);
    expect(adminIds().sort()).toEqual([111, 222]);
    expect(isAdmin(222)).toBe(true);
  });
});

describe("runtime web cookie secret", () => {
  it("returns the stamped secret", () => {
    setWebSecret("a".repeat(40));
    expect(webCookieSecret()).toBe("a".repeat(40));
  });
});
```

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/core test -- runtime.test.ts`
Expected: FAIL — `adminIds`, `isAdmin`, `setAdminIds`, `addAdminId`, `webCookieSecret`, `setWebSecret` belum diekspor.

- [ ] **Step 3: Implementasi**

Ganti isi `packages/core/src/runtime.ts` menjadi:

```ts
/**
 * Process-wide resolved identity (plan.md §16 + setup-wizard spec §5/§6).
 *
 * Bot token/username/notifier token, the admin allow-list, and the web cookie
 * secret primarily live in the `Setting` table (web-admin editable / wizard).
 * The composition root resolves them ONCE at boot and stamps them here so
 * synchronous consumers don't each need a DB read. Before boot stamps anything
 * (unit tests, standalone dev) getters fall back to env config.
 */
import { config } from "./config";

interface Resolved {
  botToken?: string;
  botUsername?: string;
  notifBotToken?: string;
  adminIds?: number[];
  webCookieSecret?: string;
}

let resolved: Resolved = {};

/** Stamp boot-resolved bot credentials (composition root / service start). */
export function setBotIdentity(identity: {
  botToken?: string;
  botUsername?: string;
  notifBotToken?: string;
}): void {
  resolved = { ...resolved, ...identity };
}

/** Test hook: forget all stamped values so getters fall back to env again. */
export function resetBotIdentity(): void {
  resolved = {};
}

export function botToken(): string | undefined {
  return resolved.botToken ?? config.BOT_TOKEN;
}

export function botUsername(): string | undefined {
  return resolved.botUsername ?? config.BOT_USERNAME;
}

export function notifBotToken(): string | undefined {
  return resolved.notifBotToken ?? config.NOTIF_BOT_TOKEN;
}

// ---- Admin allow-list (env ∪ DB) -----------------------------------------

/** Stamp the boot-resolved admin id set (union of env + DB Setting). */
export function setAdminIds(ids: number[]): void {
  resolved.adminIds = Array.from(new Set(ids.map(Number)));
}

/** Add one admin id live (single process — wizard / /admins). Idempotent. */
export function addAdminId(id: number): void {
  const next = new Set((resolved.adminIds ?? config.ADMIN_IDS).map(Number));
  next.add(Number(id));
  resolved.adminIds = Array.from(next);
}

/** Resolved admin ids if stamped, else env config (historical behaviour). */
export function adminIds(): number[] {
  return resolved.adminIds ?? config.ADMIN_IDS;
}

/** True if the Telegram id is an admin (env ∪ DB). */
export function isAdmin(telegramId: number | bigint): boolean {
  return adminIds().includes(Number(telegramId));
}

// ---- Web cookie secret ----------------------------------------------------

/** Stamp the boot-resolved web cookie secret (env, else DB, else generated). */
export function setWebSecret(secret: string): void {
  resolved.webCookieSecret = secret;
}

/** Resolved secret if stamped, else env config (may be undefined pre-boot). */
export function webCookieSecret(): string | undefined {
  return resolved.webCookieSecret ?? config.WEB_COOKIE_SECRET;
}
```

- [ ] **Step 4: Jalankan test → lulus**

Run: `pnpm --filter @app/core test -- runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime.ts packages/core/src/runtime.test.ts
git commit -m "feat(core): runtime admin allow-list + web cookie secret state"
```

---

## Task 3: Pindahkan `isAdmin` keluar dari config (hindari impor melingkar)

**Files:**
- Modify: `packages/core/src/config.ts:184-186`

- [ ] **Step 1: Hapus `isAdmin` dari config**

Di `packages/core/src/config.ts`, hapus blok:

```ts
/** True if the given Telegram user ID is in the admin allow-list. */
export const isAdmin = (telegramId: number | bigint): boolean =>
  config.ADMIN_IDS.includes(Number(telegramId));
```

> `isAdmin` kini hanya hidup di `@app/core/runtime` (Task 2). `config.ts` tetap
> tidak meng-impor `runtime` (mencegah lingkaran). `isBinanceInternalEnabled` &
> `isSmtpEnabled` tetap di config.

- [ ] **Step 2: Jalankan typecheck → gagal terkontrol**

Run: `pnpm -r typecheck`
Expected: FAIL di semua file yang masih `import { isAdmin } from "@app/core/config"`. Daftar ini jadi peta kerja Task 4.

- [ ] **Step 3: Commit (WIP, diselesaikan Task 4)**

Jangan commit sendiri — lanjut Task 4 lalu commit bersama (typecheck harus hijau dulu).

---

## Task 4: Alihkan semua pemakai `isAdmin` ke `@app/core/runtime`

**Files (tepat — hasil pemetaan grep):**
- `packages/db/src/crud/users.ts:5`
- `apps/web-admin/src/routes/auth.ts:5`
- `apps/order-bot/src/middleware.ts:14`
- `apps/order-bot/src/handlers/admin.ts:11`
- `apps/order-bot/src/conversations/admin.ts:14`
- `apps/order-bot/src/conversations/reject.ts:10`
- `scripts/reset-admin-password.ts:19`

- [ ] **Step 1: Ubah tiap import**

Pola: pisahkan `isAdmin` agar diambil dari runtime.

`packages/db/src/crud/users.ts:5` — dari:
```ts
import { config, isAdmin } from "@app/core/config";
```
jadi:
```ts
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
```

`apps/web-admin/src/routes/auth.ts:5` — dari:
```ts
import { config, isAdmin } from "@app/core/config";
```
jadi:
```ts
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
```

`apps/order-bot/src/middleware.ts:14` — dari:
```ts
import { config, isAdmin } from "@app/core/config";
```
jadi:
```ts
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
```

`apps/order-bot/src/handlers/admin.ts:11` — dari:
```ts
import { config, isAdmin } from "@app/core/config";
```
jadi:
```ts
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
```

`apps/order-bot/src/conversations/admin.ts:14` — dari:
```ts
import { config, isAdmin } from "@app/core/config";
```
jadi:
```ts
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
```

`apps/order-bot/src/conversations/reject.ts:10` — dari:
```ts
import { isAdmin } from "@app/core/config";
```
jadi:
```ts
import { isAdmin } from "@app/core/runtime";
```

`scripts/reset-admin-password.ts:19` — dari:
```ts
import { config, isAdmin } from "@app/core/config";
```
jadi:
```ts
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
```

- [ ] **Step 2: Jalankan typecheck → lulus**

Run: `pnpm -r typecheck`
Expected: PASS (tak ada lagi referensi `isAdmin` dari config).

- [ ] **Step 3: Jalankan test → lulus**

Run: `pnpm test`
Expected: PASS — perilaku identik karena `adminIds()` fallback ke `config.ADMIN_IDS` saat belum distempel.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/config.ts packages/db/src/crud/users.ts apps/web-admin/src/routes/auth.ts apps/order-bot/src/middleware.ts apps/order-bot/src/handlers/admin.ts apps/order-bot/src/conversations/admin.ts apps/order-bot/src/conversations/reject.ts scripts/reset-admin-password.ts
git commit -m "refactor: source isAdmin from runtime (env-or-DB ready)"
```

---

## Task 5: Alihkan fan-out `config.ADMIN_IDS` → `adminIds()`

Tempat yang mengirim DM ke SEMUA admin harus pakai daftar gabungan.

**Files (tepat):**
- `apps/order-bot/src/jobs/index.ts:106,109,163,197`
- `apps/order-bot/src/conversations/checkout.ts:198`
- `apps/order-bot/src/handlers/verification.ts:257`
- `apps/order-bot/src/main.ts:181`
- `apps/order-bot/src/payments/binanceInternal.ts:226`
- `apps/order-bot/src/payments/bybitDeposit.ts:184`
- `apps/order-bot/src/conversations/support.ts:112`
- `apps/order-bot/src/conversations/customer.ts:69`
- `apps/order-bot/src/handlers/callbacks.ts:239`

- [ ] **Step 1: Tambahkan import `adminIds` di tiap file**

Pada tiap file di atas, tambahkan (atau gabungkan ke import runtime yang ada):
```ts
import { adminIds } from "@app/core/runtime";
```

- [ ] **Step 2: Ganti pemakaian**

Ganti setiap `config.ADMIN_IDS` (dalam konteks fan-out / iterasi penerima) menjadi `adminIds()`. Contoh:

`apps/order-bot/src/jobs/index.ts` — dari:
```ts
    for (const adminId of config.ADMIN_IDS) {
```
jadi:
```ts
    for (const adminId of adminIds()) {
```
dan `config.ADMIN_IDS.length` → `adminIds().length`, `config.ADMIN_IDS[0]!` → `adminIds()[0]!`.

Fallback support (`support.ts:112`, `customer.ts:69`, `callbacks.ts:239`) — dari:
```ts
  const targets = config.SUPPORT_GROUP_ID ? [config.SUPPORT_GROUP_ID] : config.ADMIN_IDS;
```
jadi:
```ts
  const targets = config.SUPPORT_GROUP_ID ? [config.SUPPORT_GROUP_ID] : adminIds();
```

> Bila setelah penggantian `config` tak terpakai lagi di sebuah file, hapus
> import `config` agar typecheck (noUnusedLocals bila aktif) tetap bersih.

- [ ] **Step 3: Typecheck + test**

Run: `pnpm -r typecheck && pnpm test`
Expected: PASS (perilaku identik; fallback ke env saat belum distempel).

- [ ] **Step 4: Commit**

```bash
git add apps/order-bot/src
git commit -m "refactor: admin fan-out reads runtime adminIds() (env or DB)"
```

---

## Task 6: `resolveAdminIds()` di `@app/db`

**Files:**
- Create: `packages/db/src/crud/admins.ts`
- Create: `packages/db/src/crud/admins.test.ts`
- Modify: `packages/db/src/index.ts:25` (tambah export)

- [ ] **Step 1: Tulis test yang gagal**

Create `packages/db/src/crud/admins.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@app/core/config", () => ({ config: { ADMIN_IDS: [111] } }));

import { resolveAdminIds, ADMIN_IDS_KEY } from "./admins";
import type { Db } from "./_types";

function stubDb(settingValue: string | null): Db {
  return {
    setting: { findUnique: async () => (settingValue == null ? null : { key: ADMIN_IDS_KEY, value: settingValue }) },
  } as unknown as Db;
}

describe("resolveAdminIds", () => {
  it("returns union of env and DB, deduped", async () => {
    const ids = await resolveAdminIds(stubDb("222, 333, 111"));
    expect(ids.sort()).toEqual([111, 222, 333]);
  });

  it("returns env only when the Setting is empty/absent", async () => {
    expect(await resolveAdminIds(stubDb(null))).toEqual([111]);
    expect(await resolveAdminIds(stubDb(""))).toEqual([111]);
  });
});
```

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/db test -- admins.test.ts`
Expected: FAIL — module `./admins` belum ada.

- [ ] **Step 3: Implementasi**

Create `packages/db/src/crud/admins.ts`:

```ts
/**
 * Admin allow-list resolution (setup-wizard spec §5).
 *
 * The list of admin Telegram ids is the union of the env ADMIN_IDS and the
 * `admin_ids` Setting (CSV). The composition root resolves this once at boot and
 * stamps it into @app/core/runtime; the wizard / /admins can add ids live.
 */
import { config } from "@app/core/config";
import type { Db } from "./_types";
import { getSetting, setSetting } from "./settings";

export const ADMIN_IDS_KEY = "admin_ids";

function parseCsvIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n));
}

/** Union of env ADMIN_IDS and the DB `admin_ids` Setting (deduped). */
export async function resolveAdminIds(db: Db): Promise<number[]> {
  const dbIds = parseCsvIds(await getSetting(db, ADMIN_IDS_KEY));
  return Array.from(new Set([...config.ADMIN_IDS, ...dbIds].map(Number)));
}

/** Persist a new admin id into the DB Setting (idempotent). Returns full list. */
export async function addAdminIdToDb(db: Db, telegramId: number): Promise<number[]> {
  const current = parseCsvIds(await getSetting(db, ADMIN_IDS_KEY));
  const next = Array.from(new Set([...current, Number(telegramId)]));
  await setSetting(db, ADMIN_IDS_KEY, next.join(","));
  return next;
}

/** Remove an admin id from the DB Setting (does not touch env). Returns list. */
export async function removeAdminIdFromDb(db: Db, telegramId: number): Promise<number[]> {
  const next = parseCsvIds(await getSetting(db, ADMIN_IDS_KEY)).filter((n) => n !== Number(telegramId));
  await setSetting(db, ADMIN_IDS_KEY, next.join(","));
  return next;
}
```

- [ ] **Step 4: Export dari index**

Di `packages/db/src/index.ts`, setelah baris 25 tambahkan:
```ts
export * from "./crud/admins";
```

- [ ] **Step 5: Jalankan test → lulus**

Run: `pnpm --filter @app/db test -- admins.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/crud/admins.ts packages/db/src/crud/admins.test.ts packages/db/src/index.ts
git commit -m "feat(db): resolveAdminIds (env union DB) + add/remove helpers"
```

---

## Task 7: `resolveWebCookieSecret()` di `@app/db`

**Files:**
- Create: `packages/db/src/crud/web_secret.ts`
- Create: `packages/db/src/crud/web_secret.test.ts`
- Modify: `packages/db/src/index.ts` (tambah export)

- [ ] **Step 1: Tulis test yang gagal**

Create `packages/db/src/crud/web_secret.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@app/core/config", () => ({ config: { WEB_COOKIE_SECRET: undefined } }));

import { resolveWebCookieSecret, WEB_COOKIE_SECRET_KEY } from "./web_secret";
import type { Db } from "./_types";

function stubDb(initial: string | null) {
  const store: Record<string, string> = {};
  if (initial != null) store[WEB_COOKIE_SECRET_KEY] = initial;
  const db = {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        store[where.key] != null ? { key: where.key, value: store[where.key] } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        store[where.key] = create.value;
        return { key: where.key, value: create.value };
      },
    },
  } as unknown as Db;
  return { db, store };
}

describe("resolveWebCookieSecret", () => {
  it("generates + persists a >=32 char secret when none exists", async () => {
    const { db, store } = stubDb(null);
    const secret = await resolveWebCookieSecret(db);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(store[WEB_COOKIE_SECRET_KEY]).toBe(secret);
  });

  it("reuses the persisted secret on the next boot", async () => {
    const { db } = stubDb("x".repeat(64));
    expect(await resolveWebCookieSecret(db)).toBe("x".repeat(64));
  });
});
```

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/db test -- web_secret.test.ts`
Expected: FAIL — module belum ada.

- [ ] **Step 3: Implementasi**

Create `packages/db/src/crud/web_secret.ts`:

```ts
/**
 * Web cookie secret resolution (setup-wizard spec §6).
 *
 * Priority: env WEB_COOKIE_SECRET (operator override) > DB Setting > generated.
 * When neither env nor DB has one, generate a 32-byte hex secret and persist it
 * so sessions survive restarts without the buyer ever editing .env.
 */
import { randomBytes } from "node:crypto";
import { config } from "@app/core/config";
import type { Db } from "./_types";
import { getSetting, setSetting } from "./settings";

export const WEB_COOKIE_SECRET_KEY = "web_cookie_secret";

export async function resolveWebCookieSecret(db: Db): Promise<string> {
  const env = config.WEB_COOKIE_SECRET;
  if (env && env.length >= 32) return env;

  const existing = await getSetting(db, WEB_COOKIE_SECRET_KEY);
  if (existing && existing.length >= 32) return existing;

  const generated = randomBytes(32).toString("hex"); // 64 hex chars
  await setSetting(db, WEB_COOKIE_SECRET_KEY, generated);
  return generated;
}
```

- [ ] **Step 4: Export dari index**

Di `packages/db/src/index.ts` tambahkan:
```ts
export * from "./crud/web_secret";
```

- [ ] **Step 5: Jalankan test → lulus**

Run: `pnpm --filter @app/db test -- web_secret.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/crud/web_secret.ts packages/db/src/crud/web_secret.test.ts packages/db/src/index.ts
git commit -m "feat(db): auto-generate + persist web cookie secret"
```

---

## Task 8: `cookieSecret()` baca runtime (web-admin + storefront)

**Files:**
- Modify: `apps/web-admin/src/auth.ts:228-232`
- Modify: `apps/storefront/src/auth.ts:95-99`

- [ ] **Step 1: web-admin**

Di `apps/web-admin/src/auth.ts`, tambahkan import runtime (gabungkan ke import `@app/core/...` yang ada):
```ts
import { webCookieSecret } from "@app/core/runtime";
```
Ganti `cookieSecret()`:
```ts
function cookieSecret(): string {
  const s = webCookieSecret();
  if (!s) throw new Error("WEB_COOKIE_SECRET is required for the web admin");
  return s;
}
```

- [ ] **Step 2: storefront**

Di `apps/storefront/src/auth.ts`, tambahkan:
```ts
import { webCookieSecret } from "@app/core/runtime";
```
Ganti `cookieSecret()`:
```ts
function cookieSecret(): string {
  const s = webCookieSecret();
  if (!s) throw new Error("WEB_COOKIE_SECRET is required for the storefront");
  return s;
}
```

- [ ] **Step 3: Typecheck + test**

Run: `pnpm -r typecheck && pnpm test`
Expected: PASS (test set `WEB_COOKIE_SECRET` env → `webCookieSecret()` fallback ke env, identik).

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/src/auth.ts apps/storefront/src/auth.ts
git commit -m "refactor: cookie secret sourced from runtime resolver"
```

---

## Task 9: Stempel `adminIds` + `webCookieSecret` saat boot

**Files:**
- Modify: `apps/server/src/index.ts` (composition root — utama)
- Modify: `apps/web-admin/src/main.ts`, `apps/storefront/src/main.ts`, `apps/order-bot/src/main.ts`, `apps/notifier/src/main.ts` (entri standalone dev)

- [ ] **Step 1: Composition root**

Di `apps/server/src/index.ts`, di dalam `start()` tepat setelah `await initDb();`
dan import yang ada, tambahkan resolusi + stempel. Perbarui import dari `@app/db`:
```ts
import { initDb, prisma, resolveBotCredentials, resolveAdminIds, resolveWebCookieSecret } from "@app/db";
import { botToken as runtimeBotToken, notifBotToken, setBotIdentity, setAdminIds, setWebSecret } from "@app/core/runtime";
```
Setelah `await initDb();`:
```ts
  setAdminIds(await resolveAdminIds(prisma));
  setWebSecret(await resolveWebCookieSecret(prisma));
```
(letakkan sebelum `resolveBotCredentials` / sebelum bot & worker dijalankan).

- [ ] **Step 2: Entri standalone (tiap `start()`/`main()` setelah `initDb()`)**

Tambahkan dua baris yang sama di tiap entri dev agar `cookieSecret()` & `isAdmin`
berfungsi saat menjalankan satu app sendiri:

`apps/web-admin/src/main.ts` dan `apps/storefront/src/main.ts` — setelah `await initDb();`:
```ts
  const { resolveAdminIds, resolveWebCookieSecret } = await import("@app/db");
  const { setAdminIds, setWebSecret } = await import("@app/core/runtime");
  setAdminIds(await resolveAdminIds(prisma));
  setWebSecret(await resolveWebCookieSecret(prisma));
```
> Sesuaikan: bila file sudah meng-impor `prisma`/fungsi terkait secara statis,
> pakai import statis, bukan dinamis. Tujuannya konsisten dengan gaya file.

`apps/order-bot/src/main.ts` & `apps/notifier/src/main.ts` — cukup `setAdminIds`
(bot tak butuh cookie secret):
```ts
  setAdminIds(await resolveAdminIds(prisma));
```

- [ ] **Step 3: Typecheck + test**

Run: `pnpm -r typecheck && pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/index.ts apps/web-admin/src/main.ts apps/storefront/src/main.ts apps/order-bot/src/main.ts apps/notifier/src/main.ts
git commit -m "feat(server): stamp admin ids + web cookie secret at boot"
```

---

## Task 10: `/admins` menampilkan & mengelola admin DB

**Files:**
- Modify: `apps/web-admin/src/routes/admins.ts`
- Test: `apps/web-admin/test/web.test.ts` (tambah kasus)

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan ke `apps/web-admin/test/web.test.ts` (ikuti pola login+CSRF yang ada di file itu):

```ts
it("adds a DB admin id and recognizes it via isAdmin", async () => {
  const { isAdmin } = await import("@app/core/runtime");
  // (login as a super-admin using the existing helper in this test file)
  const agent = await loginAsSuper(app); // pakai helper yang sudah ada di file
  const res = await agent.post("/admins/add", { telegram_id: "555000555" });
  expect([200, 303]).toContain(res.statusCode);
  expect(isAdmin(555000555)).toBe(true);
});
```

> Bila helper login berbeda namanya, sesuaikan dengan yang ada di `web.test.ts`.

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/web-admin test -- web.test.ts`
Expected: FAIL — route `/admins/add` belum ada.

- [ ] **Step 3: Implementasi route tambah/hapus admin**

Di `apps/web-admin/src/routes/admins.ts`:
- Tambah import:
```ts
import { addAdminIdToDb, removeAdminIdFromDb } from "@app/db";
import { adminIds, addAdminId, setAdminIds } from "@app/core/runtime";
```
- Ganti iterasi `config.ADMIN_IDS` (baris 27) menjadi `adminIds()` agar daftar
  menampilkan admin env + DB.
- Tambah handler (super-only, CSRF) untuk menambah:
```ts
app.post("/admins/add", { preHandler: csrfProtect }, async (req, reply) => {
  const tgId = Number((req.body as Record<string, string>).telegram_id);
  if (!Number.isInteger(tgId)) {
    return redirectWithFlash(reply, "/admins", "Telegram ID harus angka.", "error");
  }
  await addAdminIdToDb(prisma, tgId);
  addAdminId(tgId); // live, tanpa restart
  await logAdminAction(prisma, {
    adminId: req.admin!.userId,
    action: "web_admin_add",
    targetType: "web_admin",
    targetId: null,
    details: `telegram_id=${tgId}`,
  });
  return redirectWithFlash(reply, "/admins", `Admin ${tgId} ditambahkan.`, "success");
});
```
- Tambah handler hapus (tidak boleh hapus diri sendiri / admin env):
```ts
app.post("/admins/remove", { preHandler: csrfProtect }, async (req, reply) => {
  const tgId = Number((req.body as Record<string, string>).telegram_id);
  if (tgId === req.admin!.telegramId) {
    return redirectWithFlash(reply, "/admins", "Tak bisa menghapus diri sendiri.", "error");
  }
  if (config.ADMIN_IDS.includes(tgId)) {
    return redirectWithFlash(reply, "/admins", "Admin dari .env tak bisa dihapus di sini.", "error");
  }
  const next = await removeAdminIdFromDb(prisma, tgId);
  setAdminIds(Array.from(new Set([...config.ADMIN_IDS, ...next])));
  await logAdminAction(prisma, {
    adminId: req.admin!.userId,
    action: "web_admin_remove",
    targetType: "web_admin",
    targetId: null,
    details: `telegram_id=${tgId}`,
  });
  return redirectWithFlash(reply, "/admins", `Admin ${tgId} dihapus.`, "success");
});
```
- Di `admins.njk`, tambah form kecil (input `telegram_id` + tombol) untuk
  add/remove dengan `csrf_field(admin)` (ikuti macro yang sudah dipakai panel).

> Pakai `redirectWithFlash`, `csrfProtect`, `logAdminAction`, dan guard role
> super yang SUDAH dipakai di `admins.ts` (lihat handler `/admins/:tgId/role`).
> Jangan buat util baru.

- [ ] **Step 4: Jalankan test → lulus**

Run: `pnpm --filter @app/web-admin test -- web.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/routes/admins.ts apps/web-admin/views/admins.njk apps/web-admin/test/web.test.ts
git commit -m "feat(web-admin): manage DB admins (add/remove) live via /admins"
```

---

## Task 11: Verifikasi akhir & dokumentasi

**Files:**
- Modify: `.env.example` (komentar `BINANCE_PAY_ID` & `WEB_COOKIE_SECRET` jadi opsional)
- Modify: `DOCS.md` Bagian 5 (catat: secret auto-generate, admin bisa dari /admins)

- [ ] **Step 1: Perbarui `.env.example`**

`BINANCE_PAY_ID=...` beri komentar: opsional (kosong = Binance Pay manual mati).
`WEB_COOKIE_SECRET=...` beri komentar: opsional — auto-generate & tersimpan bila kosong.

- [ ] **Step 2: Perbarui DOCS.md Bagian 5**

Catat di §5.2/§5.5: (a) `WEB_COOKIE_SECRET` boleh dikosongkan (otomatis),
(b) `BINANCE_PAY_ID` boleh dikosongkan, (c) admin tambahan bisa lewat
**web-admin → Admins** tanpa edit env.

- [ ] **Step 3: Suite penuh hijau**

Run: `pnpm -r typecheck && pnpm test`
Expected: PASS semuanya.

- [ ] **Step 4: Commit**

```bash
git add .env.example DOCS.md
git commit -m "docs: env optional (secret/binance) + DB-managed admins"
```

---

## Catatan untuk eksekutor

- **Tujuan kompatibilitas:** sebelum boot menstempel apa pun (mis. unit test
  `@app/core`/`@app/db` yang tak menjalankan composition root), semua getter
  fallback ke `config` — jadi perilaku lama identik. Itu sebabnya `pnpm test`
  harus tetap hijau di tiap task.
- **Tanpa perubahan skema DB** — hanya baris `Setting` baru (`admin_ids`,
  `web_cookie_secret`) yang dibuat saat runtime. Tak perlu `prisma db push`.
- **Jangan log** secret/token (aturan CLAUDE.md). `web_cookie_secret` &
  `admin_ids` tidak boleh muncul di log atau di tabel "All saved options" — bila
  `admin_ids` perlu tampil di /settings, perlakukan `web_cookie_secret` sebagai
  secret (tambah ke `SECRET_KEYS`/`SECRET_PREFIXES` di `settings.ts`).
- Setelah Fase 1 hijau & ter-commit, lanjut ke plan **Fase 2 (wizard)** dari spec
  yang sama.
