# Phase 2 — Web Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pembeli awam menyelesaikan SELURUH konfigurasi aplikasi lewat wizard browser di `/setup` (sambungkan bot → buat owner → setelan toko → selesai + auto-login), tanpa menyentuh `.env`, dengan storefront menampilkan halaman "toko belum aktif" selama setup belum selesai.

**Architecture:** Deteksi first-run hidup di `@app/db` (`crud/setup.ts`) sebagai sumber kebenaran bersama (web-admin + storefront tak saling impor). Sebuah preHandler `onRequest` global di tiap app mengalihkan request ke `/setup` (web-admin) atau merender halaman statis (storefront) selama `setupNeeded()`. Route group `/setup` (web-admin) memproses 3 langkah memakai helper yang SUDAH ada dari Fase 1 (`addAdminIdToDb`/`addAdminId`, `resolveAdminIds`, `webCookieSecret`, `BINANCE_PAY_ID` opsional) + auth primitives (`makeSession`, `hashPassword`, `upsertUser`). Tombol restart terkontrol menulis `tmp/restart.txt` (Passenger).

**Tech Stack:** TypeScript (ESM), Fastify 5 + `@fastify/cookie`/`formbody`, Nunjucks, Prisma/SQLite (`@app/db`), `@app/core/runtime`, Vitest (`app.inject`). Acuan spec: [`docs/superpowers/specs/2026-06-14-web-setup-wizard-design.md`](../specs/2026-06-14-web-setup-wizard-design.md) — Fase 2 = §3, §4, §7 (item 4–7 di §9). Fase 1 (item 1–3) sudah selesai & ter-commit.

---

## File Structure

**Dibuat:**
- `packages/db/src/crud/setup.ts` — `SETUP_COMPLETED_KEY`, `anyAdminPasswordSet`, `isSetupCompleted`, `setupNeeded`, `markSetupComplete` (sumber kebenaran bersama).
- `packages/db/src/crud/setup.test.ts` — unit test resolver (stub `Db` + runtime `setAdminIds`).
- `apps/web-admin/src/plugins/setupGate.ts` — preHandler global: redirect 303 → `/setup` saat `setupNeeded()`.
- `apps/web-admin/src/routes/setup.ts` — route group wizard 3 langkah + finish + restart, plus `setTokenValidator` (test hook).
- `apps/web-admin/views/setup_bot.njk` — Langkah 1 (sambungkan bot).
- `apps/web-admin/views/setup_owner.njk` — Langkah 2 (buat owner).
- `apps/web-admin/views/setup_shop.njk` — Langkah 3 (setelan toko, skippable).
- `apps/web-admin/views/setup_done.njk` — layar selesai + tombol restart.
- `apps/storefront/src/plugins/setupGate.ts` — preHandler global: render "toko belum aktif".
- `apps/storefront/views/setup_pending.njk` — halaman statis "toko belum aktif".

**Dimodifikasi:**
- `packages/db/src/index.ts` — ekspor `./crud/setup`.
- `apps/web-admin/src/server.ts` — register `setupGate` + `setupRoutes`.
- `apps/web-admin/src/routes/auth.ts` — pakai `anyAdminPasswordSet(prisma)` dari `@app/db` (hapus duplikat lokal).
- `apps/web-admin/test/web.test.ts` — seed `setup_completed="true"` di `beforeEach` + tes gate baru.
- `apps/storefront/src/server.ts` — register `setupGate` (storefront).
- `apps/storefront/test/storefront.test.ts` — seed `setup_completed="true"` di `beforeAll`.
- `apps/server/test/bootstrap.test.ts` — seed `setup_completed="true"` (top-level `beforeAll`).
- `DOCS.md` Bagian 5 + `README.md` — alur wizard.

---

## Catatan desain (baca dulu)

- **Gate vs kunci wizard.** Setelah Langkah 2 menyetel password owner, `anyAdminPasswordSet()` jadi `true` → `setupNeeded()` jadi `false`. Karena itu **gate** (yang memakai `setupNeeded`) tak boleh dipakai untuk mengunci halaman `/setup` itu sendiri — `/setup*` selalu DIKECUALIKAN dari gate. Penguncian wizard memakai cek terpisah `isSetupCompleted()` (`Setting setup_completed === "true"`), yang HANYA diset di langkah Selesai. Jadi wizard tetap bisa dilanjutkan dari Langkah 2 → 3 → Selesai meski password sudah terpasang.
- **Kompat mundur.** Deploy lama (admin sudah punya password) → `setupNeeded()` false → wizard tak pernah muncul. Suite test lama memakai `makeSession` tanpa menyetel password, jadi mereka harus menstempel `setup_completed="true"` agar gate tetap terbuka (diatur di task gate/storefront).
- **Pra-auth.** Wizard berjalan sebelum ada sesi, jadi POST wizard TIDAK pakai `csrfProtect` (sama seperti `/bootstrap` & `/login` yang sudah ada). Mitigasi: bind `127.0.0.1` + jendela setup pendek + kunci permanen setelah selesai (spec §8).
- **Login web tetap via Telegram ID + password** (seperti `/login` sekarang). Field "username" di Langkah 2 hanya nama tampilan (`User.username`).
- **Step 3 efektif.** Hanya field yang benar-benar dibaca runtime lewat `Setting` yang diminta: `shop_name`, `shop_tagline`. `timezone`/`bahasa` tetap dari env (`config.TIMEZONE`/`DEFAULT_LANGUAGE`) dan kurs USDT→IDR auto lewat `scheduleFxRefresh` — jadi tak ada field "mati" di wizard. (Jika nanti diinginkan, timezone/bahasa lewat DB adalah pekerjaan terpisah seperti pola runtime Fase 1.)

---

## Task 1: Deteksi first-run di `@app/db` (`crud/setup.ts`)

**Files:**
- Create: `packages/db/src/crud/setup.ts`
- Create: `packages/db/src/crud/setup.test.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Tulis test yang gagal**

Create `packages/db/src/crud/setup.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@app/core/config", () => ({ config: { ADMIN_IDS: [] as number[] } }));

import { setAdminIds, resetBotIdentity } from "@app/core/runtime";
import {
  setupNeeded,
  isSetupCompleted,
  anyAdminPasswordSet,
  SETUP_COMPLETED_KEY,
} from "./setup";
import type { Db } from "./_types";

/** In-memory Setting store as a Db stub (only `setting.findUnique` is used). */
function stubDb(values: Record<string, string>): Db {
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        values[where.key] != null ? { key: where.key, value: values[where.key] } : null,
    },
  } as unknown as Db;
}

beforeEach(() => resetBotIdentity());

describe("setupNeeded", () => {
  it("is true on a virgin install (no setup flag, no admin password)", async () => {
    setAdminIds([111]);
    const db = stubDb({});
    expect(await setupNeeded(db)).toBe(true);
  });

  it("is false once setup_completed is 'true'", async () => {
    setAdminIds([111]);
    const db = stubDb({ [SETUP_COMPLETED_KEY]: "true" });
    expect(await isSetupCompleted(db)).toBe(true);
    expect(await setupNeeded(db)).toBe(false);
  });

  it("is false (backward compat) when an admin already has a password", async () => {
    setAdminIds([111]);
    const db = stubDb({ "web_admin_password_hash:111": "$2b$12$hash" });
    expect(await anyAdminPasswordSet(db)).toBe(true);
    expect(await setupNeeded(db)).toBe(false);
  });
});
```

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/db test -- setup.test.ts`
Expected: FAIL — module `./setup` belum ada.

- [ ] **Step 3: Implementasi**

Create `packages/db/src/crud/setup.ts`:

```ts
/**
 * First-run (setup wizard) detection — spec §3. Shared source of truth so
 * web-admin and storefront (which must not import each other) agree on whether
 * the buyer has finished onboarding.
 *
 *   setupNeeded = setup_completed !== "true" && no admin has a web password yet
 *
 * The second clause keeps existing deploys (an admin already bootstrapped a
 * password) out of the wizard forever — backward compatible.
 */
import { adminIds } from "@app/core/runtime";
import type { Db } from "./_types";
import { getSetting, setSetting } from "./settings";

export const SETUP_COMPLETED_KEY = "setup_completed";

// Storage contract mirrored from apps/web-admin/src/auth.ts `passwordHashKey`.
// Kept here (not imported) so @app/db stays free of an app-layer dependency.
const PWD_HASH_PREFIX = "web_admin_password_hash:";

/** True if ANY admin (env ∪ DB) already has a web password hash stored. */
export async function anyAdminPasswordSet(db: Db): Promise<boolean> {
  for (const tgId of adminIds()) {
    if ((await getSetting(db, `${PWD_HASH_PREFIX}${tgId}`)) !== null) return true;
  }
  return false;
}

/** True once the wizard's final step has run. */
export async function isSetupCompleted(db: Db): Promise<boolean> {
  return (await getSetting(db, SETUP_COMPLETED_KEY)) === "true";
}

/** True while first-run setup is still pending (drives the setup gate). */
export async function setupNeeded(db: Db): Promise<boolean> {
  if (await isSetupCompleted(db)) return false;
  return !(await anyAdminPasswordSet(db));
}

/** Mark first-run setup finished (idempotent). */
export async function markSetupComplete(db: Db): Promise<void> {
  await setSetting(db, SETUP_COMPLETED_KEY, "true");
}
```

- [ ] **Step 4: Ekspor dari index**

Di `packages/db/src/index.ts`, tambahkan baris ekspor (setelah ekspor crud lain, mis. dekat `export * from "./crud/admins";`):

```ts
export * from "./crud/setup";
```

- [ ] **Step 5: Jalankan test → lulus**

Run: `pnpm --filter @app/db test -- setup.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/crud/setup.ts packages/db/src/crud/setup.test.ts packages/db/src/index.ts
git commit -m "feat(db): first-run setup detection (setupNeeded/markSetupComplete)"
```

---

## Task 2: Gate web-admin + rapikan `anyAdminPasswordSet` duplikat

**Files:**
- Create: `apps/web-admin/src/plugins/setupGate.ts`
- Modify: `apps/web-admin/src/server.ts`
- Modify: `apps/web-admin/src/routes/auth.ts`
- Modify: `apps/web-admin/test/web.test.ts`
- Modify: `apps/server/test/bootstrap.test.ts`

- [ ] **Step 1: Buat plugin gate**

Create `apps/web-admin/src/plugins/setupGate.ts`:

```ts
/**
 * First-run gate (spec §3). While setup is pending, every request is bounced to
 * the wizard at /setup, except the wizard itself, static/uploads, health, and
 * the favicon. Registered as a non-encapsulated onRequest hook so it covers all
 * routes regardless of registration order.
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { prisma, setupNeeded } from "@app/db";

const EXCLUDED = ["/setup", "/static", "/uploads", "/healthz", "/favicon.ico"];
const isExcluded = (path: string): boolean =>
  EXCLUDED.some((p) => path === p || path.startsWith(p + "/"));

const setupGate: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    const path = (req.url.split("?")[0] || req.url) ?? "/";
    if (isExcluded(path)) return;
    if (await setupNeeded(prisma)) {
      return reply.code(303).redirect("/setup");
    }
  });
};

export default fp(setupGate, { name: "setupGate" });
```

- [ ] **Step 2: Register gate di server.ts**

Di `apps/web-admin/src/server.ts`, tambahkan import setelah `import authPlugin from "./plugins/auth";` (baris 17):

```ts
import setupGatePlugin from "./plugins/setupGate";
```

Lalu, tepat setelah `await app.register(authPlugin);` (baris 53), tambahkan:

```ts
  await app.register(setupGatePlugin);
```

> Belum daftarkan `setupRoutes` di sini — itu Task 3 (route `/setup` belum ada,
> jadi sementara gate akan redirect ke `/setup` yang 404; test di Step 5 hanya
> mengecek REDIRECT-nya, bukan tujuan akhirnya).

- [ ] **Step 3: Hapus duplikat `anyAdminPasswordSet` di routes/auth.ts**

Di `apps/web-admin/src/routes/auth.ts`:

(a) Tambahkan `anyAdminPasswordSet` ke import `@app/db` (gabung ke daftar import yang ada di baris 10–17):

```ts
import {
  prisma,
  getSetting,
  setSetting,
  deleteSetting,
  getUserByTelegramId,
  enqueueAdminPasswordReset,
  logAdminAction,
  anyAdminPasswordSet,
} from "@app/db";
```

(b) Hapus fungsi lokal (baris 39–44):

```ts
async function anyAdminPasswordSet(): Promise<boolean> {
  for (const tgId of config.ADMIN_IDS) {
    if ((await getSetting(prisma, passwordHashKey(tgId))) !== null) return true;
  }
  return false;
}
```

(c) Ganti ketiga pemanggilan `await anyAdminPasswordSet()` (di `/bootstrap` GET, `/bootstrap` POST, `/login` GET) menjadi `await anyAdminPasswordSet(prisma)`.

> Hasil: definisi tunggal di `@app/db`, kini berbasis `adminIds()` (env ∪ DB),
> bukan hanya `config.ADMIN_IDS`. Perilaku bootstrap identik untuk deploy env-only.

- [ ] **Step 4: Seed `setup_completed` di suite yang sudah ada**

Di `apps/web-admin/test/web.test.ts`, di dalam `beforeEach` (setelah `await resetDb(prisma);`, sekitar baris 85), tambahkan:

```ts
  // Existing suites model a CONFIGURED deploy — keep the first-run gate open.
  await setSetting(prisma, "setup_completed", "true");
```

Di `apps/server/test/bootstrap.test.ts`, tambahkan import `setSetting` + sebuah `beforeAll` top-level SEBELUM `describe("combined server bootstrap", ...)` (baris 20). Ubah baris 6:

```ts
import { prisma, setSetting } from "@app/db";
```

dan tepat sebelum `describe("combined server bootstrap"`:

```ts
beforeAll(async () => {
  // Combined-server suite models a configured deploy; open the setup gate so
  // /bootstrap and the host-dispatch login redirect behave as before.
  await setSetting(prisma, "setup_completed", "true");
});
```

Pastikan `beforeAll` ada di import vitest (sudah ada di baris 5).

- [ ] **Step 5: Tulis tes gate (web.test.ts)**

Tambahkan di `apps/web-admin/test/web.test.ts` (akhir file, ikuti gaya `it(...)` + helper `app.inject` yang sudah ada; `deleteSetting` perlu ditambah ke import `@app/db` di baris 7–27):

```ts
describe("first-run setup gate", () => {
  it("redirects to /setup when setup is pending (no flag, no admin password)", async () => {
    await deleteSetting(prisma, "setup_completed"); // seeded admin has no password
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/setup");
  });

  it("does NOT gate once an admin already has a password (backward compat)", async () => {
    await deleteSetting(prisma, "setup_completed");
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("password123"));
    const res = await app.inject({ method: "GET", url: "/", headers: { cookie: `${COOKIE}=${seed.cookie}` } });
    expect(res.statusCode).toBe(200); // dashboard renders, gate stayed open
  });

  it("never gates excluded paths (/healthz)", async () => {
    await deleteSetting(prisma, "setup_completed");
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 6: Jalankan test → lulus**

Run: `pnpm --filter @app/web-admin test -- web.test.ts && pnpm --filter @app/server test`
Expected: PASS (suite lama hijau berkat seed, tes gate baru hijau).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/web-admin/src/plugins/setupGate.ts apps/web-admin/src/server.ts apps/web-admin/src/routes/auth.ts apps/web-admin/test/web.test.ts apps/server/test/bootstrap.test.ts
git commit -m "feat(web-admin): first-run gate redirects to /setup until configured"
```

---

## Task 3: Wizard Langkah 1 — sambungkan bot

**Files:**
- Create: `apps/web-admin/src/routes/setup.ts`
- Create: `apps/web-admin/views/setup_bot.njk`
- Modify: `apps/web-admin/src/server.ts`
- Modify: `apps/web-admin/test/web.test.ts`

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan di `apps/web-admin/test/web.test.ts`. Tambahkan import test hook di dekat import `setTokenValidator` settings (baris 30):

```ts
import { setTokenValidator as setSetupTokenValidator } from "../src/routes/setup";
```

Lalu tambahkan:

```ts
describe("setup wizard — step 1 (connect bot)", () => {
  beforeEach(async () => {
    await deleteSetting(prisma, "setup_completed"); // open the wizard
  });

  it("renders the connect-bot form at GET /setup", async () => {
    const res = await app.inject({ method: "GET", url: "/setup" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Bot token");
  });

  it("rejects a bad token (getMe fails) and saves nothing", async () => {
    setSetupTokenValidator(async () => ({ ok: false }));
    const res = await app.inject({
      method: "POST",
      url: "/setup/bot",
      payload: { bot_token: "garbage" },
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });

  it("saves token + username on a valid token and advances to step 2", async () => {
    setSetupTokenValidator(async () => ({ ok: true, username: "ShopBot" }));
    const res = await app.inject({
      method: "POST",
      url: "/setup/bot",
      payload: { bot_token: "123:VALID" },
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/setup/owner");
    expect(await getSetting(prisma, "bot_token")).toBe("123:VALID");
    expect(await getSetting(prisma, "bot_username")).toBe("ShopBot");
  });

  it("can skip step 1 (Atur nanti) without saving a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/setup/bot",
      payload: { skip: "1" },
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/setup/owner");
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });
});
```

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/web-admin test -- web.test.ts`
Expected: FAIL — module `../src/routes/setup` belum ada.

- [ ] **Step 3: Implementasi route Langkah 1**

Create `apps/web-admin/src/routes/setup.ts`:

```ts
/**
 * Setup wizard (spec §4) — first-run onboarding entirely in the browser.
 * Pre-auth (no session yet), so like /bootstrap these POSTs carry no CSRF token;
 * the bind-127.0.0.1 + short setup window + permanent lock (spec §8) are the
 * mitigations. /setup* is excluded from the setup gate (see plugins/setupGate),
 * and locks itself once `setup_completed` is set (final step only).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { logger } from "@app/core/logger";
import { prisma, getSetting, setSetting, isSetupCompleted } from "@app/db";

// ---- Injectable Telegram token check (mirrors routes/settings.ts) ----------
type TokenCheck = { ok: boolean; username?: string };

async function checkTokenWithTelegram(token: string): Promise<TokenCheck> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return data.ok ? { ok: true, username: data.result?.username } : { ok: false };
  } catch {
    return { ok: false };
  }
}

let tokenValidator: (token: string) => Promise<TokenCheck> = checkTokenWithTelegram;
/** Test hook: stub the Telegram call so tests never hit the network. */
export function setTokenValidator(fn: typeof tokenValidator): void {
  tokenValidator = fn;
}

export default async function setupRoutes(app: FastifyInstance): Promise<void> {
  /** Once setup is locked, the wizard is gone — send to the normal login. */
  async function lockedRedirect(reply: FastifyReply): Promise<FastifyReply | null> {
    if (await isSetupCompleted(prisma)) {
      void reply.code(303).redirect("/login");
      return reply;
    }
    return null;
  }

  // ---- Step 1: connect bot ----
  app.get("/setup", async (_req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    return reply.view("setup_bot.njk", { error: null });
  });

  app.post("/setup/bot", async (req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    const body = (req.body ?? {}) as Record<string, string>;
    if (body.skip) return reply.code(303).redirect("/setup/owner");

    const token = (body.bot_token ?? "").trim();
    if (!token) {
      return reply.code(400).view("setup_bot.njk", { error: "Tempel token bot dari BotFather, atau pilih ‘Atur nanti’." });
    }
    const check = await tokenValidator(token);
    if (!check.ok) {
      return reply.code(400).view("setup_bot.njk", { error: "Token salah atau bot tidak ditemukan. Cek lagi dari BotFather." });
    }
    await setSetting(prisma, "bot_token", token);
    if (check.username) await setSetting(prisma, "bot_username", check.username);
    logger.info("Setup: bot token saved"); // never log the token
    return reply.code(303).redirect("/setup/owner");
  });
}
```

> Task 3 hanya butuh impor di atas. Langkah 2/3/Selesai (Task 4) akan MEMPERLUAS
> blok impor + menambah handler di file yang sama.

- [ ] **Step 4: View Langkah 1**

Create `apps/web-admin/views/setup_bot.njk`:

```njk
{% extends "base.njk" %}
{% block title %}Setup · Sambungkan bot{% endblock %}
{% block nav %}{% endblock %}

{% block content %}
<div class="min-h-[70vh] flex items-center justify-center">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <span class="inline-flex items-center gap-2 font-display text-2xl font-semibold text-pine">
        <i data-lucide="store" class="w-6 h-6"></i> Setup Toko
      </span>
      <p class="page-lead">Langkah 1 dari 3 — Sambungkan bot Telegram</p>
    </div>

    <div class="card card-pad">
      <p class="text-sm text-ink-soft mb-6">
        Buka <b>@BotFather</b> di Telegram → <code>/mybots</code> → pilih bot kamu → <b>API Token</b>,
        lalu tempel di bawah. Bot baru aktif setelah langkah terakhir memicu restart.
      </p>

      {% if error %}
        <div class="mb-4 rounded-xl border border-rust/30 bg-rust-tint px-4 py-3 text-sm text-rust-dark">{{ error }}</div>
      {% endif %}

      <form method="post" action="/setup/bot" class="space-y-4">
        <div>
          <label class="field-label" for="bot_token">Bot token</label>
          <input id="bot_token" name="bot_token" type="text" autocomplete="off" class="field" placeholder="123456:ABC-DEF...">
        </div>
        <button type="submit" class="btn btn-primary w-full"><i data-lucide="plug" class="w-4 h-4"></i> Sambungkan & lanjut</button>
        <button type="submit" name="skip" value="1" class="btn btn-ghost w-full">Atur nanti</button>
      </form>
    </div>
  </div>
</div>
{% endblock %}
```

- [ ] **Step 5: Register route di server.ts**

Di `apps/web-admin/src/server.ts`, tambahkan import setelah `import authRoutes from "./routes/auth";` (baris 18):

```ts
import setupRoutes from "./routes/setup";
```

Lalu daftarkan tepat setelah `await app.register(authRoutes);` (baris 68):

```ts
  await app.register(setupRoutes);
```

- [ ] **Step 6: Jalankan test → lulus**

Run: `pnpm --filter @app/web-admin test -- web.test.ts`
Expected: PASS (4 tes Langkah 1 hijau).

- [ ] **Step 7: Commit**

```bash
git add apps/web-admin/src/routes/setup.ts apps/web-admin/views/setup_bot.njk apps/web-admin/src/server.ts apps/web-admin/test/web.test.ts
git commit -m "feat(web-admin): setup wizard step 1 (connect bot, validated/skippable)"
```

---

## Task 4: Wizard Langkah 2 (owner) + Langkah 3 (toko) + Selesai (auto-login + kunci)

**Files:**
- Modify: `apps/web-admin/src/routes/setup.ts`
- Create: `apps/web-admin/views/setup_owner.njk`
- Create: `apps/web-admin/views/setup_shop.njk`
- Create: `apps/web-admin/views/setup_done.njk`
- Modify: `apps/web-admin/test/web.test.ts`

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan di `apps/web-admin/test/web.test.ts`. Prasyarat impor (tambahkan bila belum ada): `UserRole` → ubah baris 6 jadi `import { ProductType, UserRole } from "@app/core/enums";`; dan tambahkan `getUserByTelegramId` ke daftar impor `@app/db` (baris 7–27). (`deleteSetting` & `passwordHashKey` sudah ditambahkan di Task 2.)

```ts
describe("setup wizard — step 2/3/finish", () => {
  const OWNER_TG = 7000123;
  beforeEach(async () => {
    await deleteSetting(prisma, "setup_completed");
    await deleteSetting(prisma, "setup_owner_tg");
    resetAccountFailures(OWNER_TG);
  });

  async function createOwner() {
    return app.inject({
      method: "POST",
      url: "/setup/owner",
      payload: { telegram_id: String(OWNER_TG), username: "owner", password: "supersecret", password_confirm: "supersecret" },
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }

  it("rejects mismatched passwords without creating an admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/setup/owner",
      payload: { telegram_id: String(OWNER_TG), username: "owner", password: "supersecret", password_confirm: "nope" },
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(isAdmin(OWNER_TG)).toBe(false);
  });

  it("creates an ADMIN owner with a password and advances to step 3", async () => {
    const res = await createOwner();
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/setup/shop");
    expect(isAdmin(OWNER_TG)).toBe(true);
    expect(adminIds()).toContain(OWNER_TG);
    const user = await getUser(prisma, (await getUserByTelegramId(prisma, OWNER_TG))!.id);
    expect(user!.role).toBe(UserRole.ADMIN);
    expect(await getSetting(prisma, passwordHashKey(OWNER_TG))).not.toBeNull();
    expect(await getSetting(prisma, "setup_owner_tg")).toBe(String(OWNER_TG));
  });

  it("finish: marks setup complete, sets a session cookie, locks the wizard", async () => {
    await createOwner();
    const res = await app.inject({
      method: "POST",
      url: "/setup/shop",
      payload: { shop_name: "Toko Demo", skip: "" },
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/setup/done");
    expect(await getSetting(prisma, "shop_name")).toBe("Toko Demo");
    expect(await getSetting(prisma, "setup_completed")).toBe("true");
    const setCookie = res.headers["set-cookie"];
    expect(String(setCookie)).toContain(`${COOKIE}=`);
    // Wizard now locked: GET /setup → /login.
    const locked = await app.inject({ method: "GET", url: "/setup" });
    expect(locked.statusCode).toBe(303);
    expect(locked.headers.location).toBe("/login");
  });
});
```

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/web-admin test -- web.test.ts`
Expected: FAIL — route `/setup/owner`, `/setup/shop` belum ada.

- [ ] **Step 3: Perluas impor + implementasi Langkah 2 / 3 / Selesai**

(a) Di `apps/web-admin/src/routes/setup.ts`, perluas blok impor jadi:

```ts
import type { FastifyInstance, FastifyReply } from "fastify";
import { logger } from "@app/core/logger";
import { config } from "@app/core/config";
import { addAdminId } from "@app/core/runtime";
import {
  prisma,
  getSetting,
  setSetting,
  deleteSetting,
  getUserByTelegramId,
  addAdminIdToDb,
  upsertUser,
  isSetupCompleted,
  markSetupComplete,
  logAdminAction,
} from "@app/db";
import { hashPassword, makeSession, newJti, passwordHashKey, sessionJtiKey } from "../auth";
```

dan tambahkan const kunci owner di dekat `setTokenValidator`:

```ts
const OWNER_TG_KEY = "setup_owner_tg"; // carries the owner id from step 2 → finish
```

(b) Tambahkan handler berikut SEBELUM penutup fungsi `setupRoutes` (setelah handler `/setup/bot`):

```ts
  // ---- Step 2: create owner (admin) ----
  app.get("/setup/owner", async (_req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    return reply.view("setup_owner.njk", { error: null });
  });

  app.post("/setup/owner", async (req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    const body = (req.body ?? {}) as Record<string, string>;
    const telegramId = Number(body.telegram_id);
    const username = (body.username ?? "").trim() || null;
    const password = body.password ?? "";
    const passwordConfirm = body.password_confirm ?? "";

    let error: string | null = null;
    if (!Number.isInteger(telegramId) || telegramId <= 0) {
      error = "Telegram ID harus berupa angka. Dapatkan dari @userinfobot.";
    } else if (password.length < 8) {
      error = "Password minimal 8 karakter.";
    } else if (password !== passwordConfirm) {
      error = "Konfirmasi password tidak cocok.";
    }
    if (error) return reply.code(400).view("setup_owner.njk", { error });

    // Make the id an admin in the runtime FIRST so upsertUser resolves role=ADMIN,
    // then persist everything in one short transaction (CLAUDE.md: single-writer).
    addAdminId(telegramId);
    await prisma.$transaction(async (tx) => {
      await addAdminIdToDb(tx, telegramId);
      await upsertUser(tx, { telegramId, username, fullName: null });
      await setSetting(tx, passwordHashKey(telegramId), hashPassword(password));
    });
    await setSetting(prisma, OWNER_TG_KEY, String(telegramId));
    logger.info(`Setup: owner admin created telegram_id=${telegramId}`); // never log the password
    return reply.code(303).redirect("/setup/shop");
  });

  // ---- Step 3: shop basics (skippable) + finish ----
  app.get("/setup/shop", async (_req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    return reply.view("setup_shop.njk", { error: null });
  });

  app.post("/setup/shop", async (req, reply) => {
    if (await lockedRedirect(reply)) return reply;
    const body = (req.body ?? {}) as Record<string, string>;

    // The owner must exist (step 2) before we can finish + auto-login.
    const ownerTg = Number(await getSetting(prisma, OWNER_TG_KEY));
    if (!Number.isInteger(ownerTg) || ownerTg <= 0) {
      return reply.code(303).redirect("/setup/owner");
    }

    if (!body.skip) {
      const shopName = (body.shop_name ?? "").trim();
      const tagline = (body.shop_tagline ?? "").trim();
      if (shopName) await setSetting(prisma, "shop_name", shopName);
      if (tagline) await setSetting(prisma, "shop_tagline", tagline);
    }

    // Finish: lock the wizard, then auto-login the owner (rotate jti).
    await markSetupComplete(prisma);
    const owner = await getUserByTelegramId(prisma, ownerTg);
    if (owner) {
      const jti = newJti();
      await setSetting(prisma, sessionJtiKey(ownerTg), jti);
      const { raw } = makeSession(owner.id, ownerTg, jti);
      reply.setCookie(config.WEB_COOKIE_NAME, raw, {
        path: "/",
        maxAge: config.WEB_SESSION_TTL_HOURS * 3600,
        httpOnly: true,
        sameSite: "lax",
        secure: config.WEB_COOKIE_SECURE,
      });
      await logAdminAction(prisma, {
        adminId: owner.id,
        action: "web_setup_completed",
        targetType: "web_admin",
        targetId: null,
        details: `owner_telegram_id=${ownerTg}`,
      });
    }
    await deleteSetting(prisma, OWNER_TG_KEY);
    logger.info(`Setup completed; owner auto-logged-in telegram_id=${ownerTg}`);
    return reply.code(303).redirect("/setup/done");
  });

  // ---- Done screen (auto-login already set; offers bot restart) ----
  app.get("/setup/done", async (_req, reply) => {
    const botConfigured = (await getSetting(prisma, "bot_token")) !== null;
    return reply.view("setup_done.njk", { bot_configured: botConfigured, error: null, restarted: false });
  });
```

> Semua simbol yang dipakai handler ini sudah ditambahkan di sub-langkah (a).

- [ ] **Step 4: View Langkah 2**

Create `apps/web-admin/views/setup_owner.njk`:

```njk
{% extends "base.njk" %}
{% block title %}Setup · Akun owner{% endblock %}
{% block nav %}{% endblock %}

{% block content %}
<div class="min-h-[70vh] flex items-center justify-center">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <span class="inline-flex items-center gap-2 font-display text-2xl font-semibold text-pine">
        <i data-lucide="user-plus" class="w-6 h-6"></i> Setup Toko
      </span>
      <p class="page-lead">Langkah 2 dari 3 — Buat akun owner</p>
    </div>

    <div class="card card-pad">
      <p class="text-sm text-ink-soft mb-6">
        Telegram ID dipakai bot untuk mengenalimu sebagai admin. Cari ID-mu lewat
        <b>@userinfobot</b> (kirim apa saja, ia membalas angka ID).
      </p>

      {% if error %}
        <div class="mb-4 rounded-xl border border-rust/30 bg-rust-tint px-4 py-3 text-sm text-rust-dark">{{ error }}</div>
      {% endif %}

      <form method="post" action="/setup/owner" class="space-y-4">
        <div>
          <label class="field-label" for="telegram_id">Telegram ID</label>
          <input id="telegram_id" name="telegram_id" type="number" required class="field">
        </div>
        <div>
          <label class="field-label" for="username">Nama tampilan (opsional)</label>
          <input id="username" name="username" type="text" autocomplete="off" class="field">
        </div>
        <div>
          <label class="field-label" for="password">Password</label>
          <input id="password" name="password" type="password" required minlength="8" autocomplete="new-password" class="field">
          <p class="text-xs text-ink-faint mt-1">Minimal 8 karakter. Dipakai untuk login dashboard.</p>
        </div>
        <div>
          <label class="field-label" for="password_confirm">Ulangi password</label>
          <input id="password_confirm" name="password_confirm" type="password" required autocomplete="new-password" class="field">
        </div>
        <button type="submit" class="btn btn-primary w-full"><i data-lucide="arrow-right" class="w-4 h-4"></i> Buat & lanjut</button>
      </form>
    </div>
  </div>
</div>
{% endblock %}
```

- [ ] **Step 5: View Langkah 3**

Create `apps/web-admin/views/setup_shop.njk`:

```njk
{% extends "base.njk" %}
{% block title %}Setup · Setelan toko{% endblock %}
{% block nav %}{% endblock %}

{% block content %}
<div class="min-h-[70vh] flex items-center justify-center">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <span class="inline-flex items-center gap-2 font-display text-2xl font-semibold text-pine">
        <i data-lucide="settings" class="w-6 h-6"></i> Setup Toko
      </span>
      <p class="page-lead">Langkah 3 dari 3 — Setelan dasar (boleh dilewati)</p>
    </div>

    <div class="card card-pad">
      <p class="text-sm text-ink-soft mb-6">
        Semua punya default. Kamu bisa mengubahnya kapan saja di <b>Settings</b>.
      </p>

      {% if error %}
        <div class="mb-4 rounded-xl border border-rust/30 bg-rust-tint px-4 py-3 text-sm text-rust-dark">{{ error }}</div>
      {% endif %}

      <form method="post" action="/setup/shop" class="space-y-4">
        <div>
          <label class="field-label" for="shop_name">Nama toko</label>
          <input id="shop_name" name="shop_name" type="text" class="field" placeholder="Toko Saya">
        </div>
        <div>
          <label class="field-label" for="shop_tagline">Tagline (opsional)</label>
          <input id="shop_tagline" name="shop_tagline" type="text" class="field">
        </div>
        <button type="submit" class="btn btn-primary w-full"><i data-lucide="check" class="w-4 h-4"></i> Simpan & selesai</button>
        <button type="submit" name="skip" value="1" class="btn btn-ghost w-full">Lewati & selesai</button>
      </form>
    </div>
  </div>
</div>
{% endblock %}
```

- [ ] **Step 6: View Selesai**

Create `apps/web-admin/views/setup_done.njk`:

```njk
{% extends "base.njk" %}
{% block title %}Setup selesai{% endblock %}
{% block nav %}{% endblock %}

{% block content %}
<div class="min-h-[70vh] flex items-center justify-center">
  <div class="w-full max-w-md text-center">
    <span class="inline-flex items-center gap-2 font-display text-2xl font-semibold text-pine">
      <i data-lucide="party-popper" class="w-6 h-6"></i> Setup selesai!
    </span>
    <p class="page-lead mb-6">Kamu sudah masuk sebagai owner.</p>

    <div class="card card-pad space-y-4">
      {% if bot_configured %}
        {% if restarted %}
          <p class="text-sm text-pine">Bot sedang dinyalakan ulang. Tunggu beberapa detik lalu coba <code>/start</code> di Telegram.</p>
        {% else %}
          <p class="text-sm text-ink-soft">Bot sudah tersambung tapi belum menyala — restart sekali untuk mengaktifkannya.</p>
          <form method="post" action="/setup/restart">
            <button type="submit" class="btn btn-primary w-full"><i data-lucide="power" class="w-4 h-4"></i> Nyalakan bot sekarang</button>
          </form>
        {% endif %}
      {% else %}
        <p class="text-sm text-ink-soft">Belum menyambungkan bot? Kamu bisa mengaturnya nanti di <b>Settings → Bot token</b>.</p>
      {% endif %}
      <a href="/" class="btn btn-ghost w-full"><i data-lucide="layout-dashboard" class="w-4 h-4"></i> Ke dashboard</a>
    </div>
  </div>
</div>
{% endblock %}
```

- [ ] **Step 7: Jalankan test → lulus**

Run: `pnpm --filter @app/web-admin test -- web.test.ts`
Expected: PASS (Langkah 2/3/finish hijau).

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/web-admin/src/routes/setup.ts apps/web-admin/views/setup_owner.njk apps/web-admin/views/setup_shop.njk apps/web-admin/views/setup_done.njk apps/web-admin/test/web.test.ts
git commit -m "feat(web-admin): setup wizard steps 2-3 + finish (owner, auto-login, lock)"
```

---

## Task 5: Gate storefront + halaman "toko belum aktif"

**Files:**
- Create: `apps/storefront/src/plugins/setupGate.ts`
- Create: `apps/storefront/views/setup_pending.njk`
- Modify: `apps/storefront/src/server.ts`
- Modify: `apps/storefront/test/storefront.test.ts`

- [ ] **Step 1: Seed `setup_completed` di suite storefront (jaga hijau)**

Di `apps/storefront/test/storefront.test.ts`, di dalam `beforeAll` (setelah data dibuat, sebelum tes berjalan — `setSetting` sudah diimpor di baris 10), tambahkan:

```ts
  // Storefront tests model a live shop — keep the setup gate open.
  await setSetting(prisma, "setup_completed", "true");
```

- [ ] **Step 2: Tulis test yang gagal**

Tambahkan di `apps/storefront/test/storefront.test.ts` (impor `deleteSetting` ke daftar `@app/db` di baris 10):

```ts
describe("storefront setup gate", () => {
  it("shows a 'shop not active yet' page while setup is pending", async () => {
    await deleteSetting(prisma, "setup_completed"); // no admin password in this DB
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("belum aktif");
    await setSetting(prisma, "setup_completed", "true"); // restore for other tests
  });

  it("still serves /healthz while setup is pending", async () => {
    await deleteSetting(prisma, "setup_completed");
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    await setSetting(prisma, "setup_completed", "true");
  });
});
```

- [ ] **Step 3: Implementasi plugin gate storefront**

Create `apps/storefront/src/plugins/setupGate.ts`:

```ts
/**
 * Storefront first-run gate (spec §3). The storefront has no /setup route (the
 * wizard lives on the admin host), so while setup is pending we serve a static
 * "shop not active yet" page (HTTP 503) for every page request except health
 * and static assets — never a redirect to a route this host doesn't serve.
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { prisma, setupNeeded } from "@app/db";
import { requestLang } from "../shop";

const EXCLUDED = ["/static", "/uploads", "/healthz", "/favicon.ico"];
const isExcluded = (path: string): boolean =>
  EXCLUDED.some((p) => path === p || path.startsWith(p + "/"));

const setupGate: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    const path = (req.url.split("?")[0] || req.url) ?? "/";
    if (isExcluded(path)) return;
    if (await setupNeeded(prisma)) {
      const lang = requestLang(req);
      return reply.code(503).view("setup_pending.njk", { lang });
    }
  });
};

export default fp(setupGate, { name: "storefrontSetupGate" });
```

> `reply.view` ada lewat `viewsPlugin`. Hook `onRequest` jalan sebelum route,
> tapi `viewsPlugin` mendekorasi `reply.view` saat register (bukan per-request),
> jadi aman dipanggil di hook selama plugin views ter-register sebelum gate.

- [ ] **Step 4: View "toko belum aktif"**

Create `apps/storefront/views/setup_pending.njk`:

```njk
<!doctype html>
<html lang="{{ lang or 'id' }}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Toko belum aktif</title>
  <link rel="stylesheet" href="/static/app.css">
</head>
<body class="min-h-screen flex items-center justify-center bg-sand text-ink">
  <main class="max-w-md text-center px-6">
    <h1 class="font-display text-2xl font-semibold mb-3">Toko belum aktif</h1>
    <p class="text-ink-soft">
      Pemilik toko sedang menyelesaikan setup di panel admin. Silakan kembali sebentar lagi.
    </p>
  </main>
</body>
</html>
```

> Halaman sengaja mandiri (tak `extends` layout toko) karena konteks penuh toko
> (kategori, cart, fx) belum tentu siap selama setup. `/static/app.css` memang
> dilayani oleh `fastifyStatic` (prefix `/static/`).

- [ ] **Step 5: Register gate di storefront server.ts**

Di `apps/storefront/src/server.ts`, tambahkan import setelah `import authPlugin from "./plugins/auth";` (baris 17):

```ts
import setupGatePlugin from "./plugins/setupGate";
```

Lalu register tepat setelah `await app.register(authPlugin);` (baris 42):

```ts
  await app.register(setupGatePlugin);
```

- [ ] **Step 6: Jalankan test → lulus**

Run: `pnpm --filter @app/storefront test && pnpm --filter @app/server test`
Expected: PASS (gate storefront hijau; combined-server tetap hijau karena `setup_completed` di-seed di Task 2).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/storefront/src/plugins/setupGate.ts apps/storefront/views/setup_pending.njk apps/storefront/src/server.ts apps/storefront/test/storefront.test.ts
git commit -m "feat(storefront): show 'shop not active' page until setup completes"
```

---

## Task 6: Restart terkontrol (Passenger `tmp/restart.txt`)

**Files:**
- Modify: `apps/web-admin/src/routes/setup.ts`
- Modify: `apps/web-admin/test/web.test.ts`

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan di `apps/web-admin/test/web.test.ts` (impor node helpers di atas file: `import { readFileSync, existsSync, rmSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";`):

```ts
describe("setup wizard — restart trigger", () => {
  it("writes the Passenger restart file best-effort", async () => {
    const target = join(tmpdir(), `restart-${Date.now()}.txt`);
    process.env.RESTART_TRIGGER_FILE = target;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/setup/restart",
        payload: {},
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(res.statusCode).toBe(200);
      expect(existsSync(target)).toBe(true);
      expect(res.body).toContain("dinyalakan"); // setup_done.njk restarted=true branch
    } finally {
      if (existsSync(target)) rmSync(target);
      delete process.env.RESTART_TRIGGER_FILE;
    }
  });
});
```

- [ ] **Step 2: Jalankan test → gagal**

Run: `pnpm --filter @app/web-admin test -- web.test.ts`
Expected: FAIL — route `/setup/restart` belum ada.

- [ ] **Step 3: Implementasi handler restart**

Di `apps/web-admin/src/routes/setup.ts`, tambahkan import node di bagian atas (setelah import yang ada):

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
```

Lalu tambahkan handler SEBELUM penutup `setupRoutes` (setelah `/setup/done`):

```ts
  // Best-effort Passenger restart: touch tmp/restart.txt so the app reboots and
  // picks up the new bot token/admin (grammY can't hot-swap a token — spec §7).
  app.post("/setup/restart", async (_req, reply) => {
    const target = process.env.RESTART_TRIGGER_FILE ?? join(process.cwd(), "tmp", "restart.txt");
    let ok = true;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, new Date().toISOString());
      logger.info("Setup: wrote Passenger restart trigger");
    } catch (err) {
      ok = false;
      logger.warn({ err }, "Setup: failed to write restart trigger");
    }
    const botConfigured = (await getSetting(prisma, "bot_token")) !== null;
    return reply.view("setup_done.njk", {
      bot_configured: botConfigured,
      restarted: ok,
      error: ok ? null : "Tak bisa menulis file restart otomatis. Pakai tombol Restart di panel hosting.",
    });
  });
```

- [ ] **Step 4: Jalankan test → lulus**

Run: `pnpm --filter @app/web-admin test -- web.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/web-admin/src/routes/setup.ts apps/web-admin/test/web.test.ts
git commit -m "feat(web-admin): best-effort Passenger restart trigger after setup"
```

---

## Task 7: Dokumentasi + verifikasi akhir

**Files:**
- Modify: `DOCS.md` (Bagian 5)
- Modify: `README.md`

- [ ] **Step 1: Perbarui DOCS.md Bagian 5**

Tambahkan sub-bagian "Setup lewat wizard (tanpa edit .env)" di Bagian 5: setelah file ter-upload & app jalan, buka `http(s)://<host-admin>/` → otomatis diarahkan ke `/setup`. Tiga langkah: (1) tempel **Bot token** dari BotFather (boleh "Atur nanti"), (2) isi **Telegram ID** (dari @userinfobot) + password owner, (3) nama toko (opsional). Selesai → otomatis login + tombol **"Nyalakan bot sekarang"** (menulis `tmp/restart.txt`). Catat: selama setup, storefront menampilkan "Toko belum aktif"; setelah selesai wizard terkunci permanen. `BINANCE_PAY_ID` & `WEB_COOKIE_SECRET` tetap boleh kosong (Fase 1).

- [ ] **Step 2: Perbarui README.md**

Di panduan instalasi, ganti instruksi manual `/bootstrap` → `/login` dengan: "Buka panel admin di browser; ikuti wizard setup 3 langkah." Pertahankan `/bootstrap` sebagai catatan kompatibilitas (deploy lama).

- [ ] **Step 3: Suite penuh hijau**

Run: `pnpm -r typecheck && pnpm test`
Expected: PASS semuanya (web-admin, storefront, server, core, db).

- [ ] **Step 4: Commit**

```bash
git add DOCS.md README.md
git commit -m "docs: setup wizard onboarding (no .env editing for buyers)"
```

---

## Catatan untuk eksekutor

- **Urutan penting.** Task 1 (deteksi) → Task 2 (gate + seed suite lama) sebelum
  Task 3–6, agar `pnpm test` tetap hijau di tiap commit. Jangan daftarkan gate
  tanpa menstempel `setup_completed` di suite yang sudah ada (web-admin,
  storefront, combined-server) — kalau tidak, ratusan tes lama akan ter-redirect
  ke `/setup`.
- **Jangan log** token/password/hash (CLAUDE.md). Handler di atas hanya mencatat
  peristiwa, bukan nilainya.
- **Tanpa perubahan skema DB** — hanya baris `Setting` baru (`setup_completed`,
  `setup_owner_tg`, `bot_token`, `bot_username`, `shop_name`, `shop_tagline`)
  dibuat saat runtime. Tak perlu `prisma db push` di deploy.
- **`setup_owner_tg` bersifat sementara** — diisi di Langkah 2, dihapus di
  langkah Selesai. Bila proses mati di antara Langkah 2 dan Selesai, owner sudah
  jadi admin (punya password) sehingga `setupNeeded()` jadi false; buyer cukup
  `/login` manual. Aman.
- **Setelah Fase 2 hijau & ter-commit**, lihat spec §8 untuk opsi pengetatan
  lanjutan (mis. `SETUP_TOKEN`) — di luar lingkup v1.
```
