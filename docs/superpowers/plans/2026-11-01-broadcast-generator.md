# Broadcast Generator (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin pick products in the web admin and get (a) a bot DM broadcast and (b) a copy-ready Telegram channel post. Both are generated from the same availability data the storefront uses, with status re-resolved when a scheduled DM is actually sent.

**Architecture:**
- **Snapshot** (`packages/db/src/crud/broadcastPosts.ts`): resolves each selected denomination to ✅/⛔/🔧. It uses the existing `resolveDenominationAvailability` plus the Digiflazz auto-deactivated list.
- **Renderer** (`packages/core/src/broadcastRender.ts`): a pure function that turns a snapshot into Telegram HTML for DM or channel.
- **Admin API** (`/api/broadcast/posts/*`): previews, copies and queues. Queuing goes through the existing `Broadcast` table.
- **Bot worker** (`drainBroadcasts`): gets a second branch for generated rows. It rebuilds the snapshot at send time, then sends HTML and buttons in each recipient's language.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Fastify, grammY, React + TanStack Query + shadcn/ui, Vitest, RTL.

**Spec:** `docs/superpowers/specs/2026-11-01-broadcast-generator-design.md` (read it first).

## Global Constraints

- **Work only in** `.claude/worktrees/broadcast-generator` on branch `worktree-broadcast-generator`. Never touch the main checkout.
- **Staging:** stage files **by name**. Never `git add -A` / `-a`, because the Stop hook regenerates `graphify-out/` mid-task. Never `git stash`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Statuses:** only `✅` Tersedia/Available, `⛔` Habis/Sold out, `🔧` Gangguan/Disrupted. No stock numbers anywhere in a message. No "menipis"/"low stock" wording.
- **Read-only generator:** it never writes stock, price, product/denomination active state, or flash sales.
- **No Telegram calls from the web.** The web enqueues `Broadcast` rows; the bot sends.
- **Admin client** (`apps/web-admin/client`) may not import `@app/core` or `@app/db` (`pnpm run check-frontend-boundaries`).
- **Premium vs Game:** product group comes from `groupForCategory(category.group)` (`packages/core/src/productGroups.ts`), never from names. Icons come from the product's own `emoji` → category `emoji` → group emoji.
- **Fulfillment source:** decided only via `fulfillmentSourceOf` / `resolveDenominationAvailability` (`tests/availability-guard.test.ts` forbids inline `deliveryType === "auto"` checks).
- **Limits:** DM text `4000` chars, DM photo caption `1024`, channel part `4000`, all measured with `broadcastLength` (= `string.length`, the same rule as `apps/web-admin/src/routes/api/broadcast.ts`).
- **Button labels:** measured with `visualWidth` from `packages/core/src/buttonLimits.ts`, single-column ≤ `TARGET_LABEL_WIDTH`.
- **Locale strings:** live in `packages/core/locales/id.json` and `en.json`, prefix `bcast.`. Both files get the same keys (`packages/core/src/locales.test.ts`). Buyer-facing copy must pass `tests/no-fake-claims.test.ts`: no "instant", "24/7", "guaranteed", or fixed times.
- **Logs and audit:** pino messages are full English sentences. `logAdminAction` `details` is a short natural sentence, never `key=value`.
- **Tests:** run with `pnpm exec vitest run <path>`. Per-package `pnpm --filter X test` runs nothing.

## File map

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (modify) | `BroadcastPost`, `BroadcastPreset`, back-relation on `Broadcast` |
| `prisma/migrations/20261101120000_broadcast_posts/migration.sql` (create) | Additive migration |
| `packages/core/src/broadcastPost.ts` (create) | Shared types + constants (types, statuses, snapshot shape, limits, visibility rules, staleness) |
| `packages/core/src/broadcastRender.ts` (create) | Pure renderer: DM + channel |
| `packages/core/locales/{id,en}.json` (modify) | `bcast.*` strings |
| `packages/db/src/crud/broadcastPosts.ts` (create) | Snapshot builder, settings, posts, presets, history, worker helpers |
| `packages/db/src/index.ts` (modify) | Export the new crud module |
| `apps/order-bot/src/jobs/index.ts` (modify) | Generated-broadcast branch in `drainBroadcasts` |
| `apps/web-admin/src/lib/broadcastImage.ts` (create) | Shared image-ref check, extracted from `routes/api/broadcast.ts` |
| `apps/web-admin/src/routes/api/broadcast.ts` (modify) | Use the shared image check |
| `apps/web-admin/src/routes/api/broadcastPosts.ts` (create) | Generator API |
| `apps/web-admin/src/server.ts` (modify) | Register routes |
| `apps/web-admin/src/routes/api/settings.ts` (modify) | 3 editable settings |
| `apps/web-admin/client/src/pages/broadcast/*` (create) | Generator tab UI |
| `apps/web-admin/client/src/pages/BroadcastPage.tsx` (modify) | Tabs + replace Restock/Maintenance templates |
| `apps/web-admin/client/src/pages/SettingsPage.tsx` (modify) | Group + describe the 3 settings |

---

### Task 1: Schema, migration and shared types

**Files:**
- Modify: `prisma/schema.prisma` (the `Broadcast` model ~line 1795, plus new models after it)
- Create: `prisma/migrations/20261101120000_broadcast_posts/migration.sql`
- Create: `packages/core/src/broadcastPost.ts`
- Test: `packages/core/src/broadcastPost.test.ts`

**Interfaces:**
- Produces (`@app/core/broadcastPost`):
  - `POST_TYPES`, `type PostType`, `isPostType`
  - `type ItemStatus`, `type PostItemInput`, `type PostSnapshot`, `type SnapshotProduct`, `type SnapshotItem`, `type PostFields`
  - `DM_TEXT_MAX`, `DM_CAPTION_MAX`, `CHANNEL_PART_MAX`, `broadcastLength`
  - `visibleStatuses(type, target)`, `isDmSendable(type, visibleCount)`
  - `providerFreshness(snapshot, now, staleMinutes)`
  - `DEFAULT_STALE_MINUTES = 90`
- Produces (Prisma): models `BroadcastPost` (table `broadcast_posts`), `BroadcastPreset` (table `broadcast_presets`), relation `Broadcast.post`.

- [ ] **Step 1: Write the failing test** `packages/core/src/broadcastPost.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  POST_TYPES, isPostType, visibleStatuses, isDmSendable, providerFreshness,
  broadcastLength, DM_TEXT_MAX, DM_CAPTION_MAX, DEFAULT_STALE_MINUTES, type PostSnapshot,
} from "./broadcastPost";

const snap = (over: Partial<PostSnapshot> = {}): PostSnapshot => ({
  resolvedAt: "2026-11-01T07:00:00.000Z", providerSyncedAt: "2026-11-01T06:30:00.000Z",
  providerLastRunFailed: false, groups: [], missingIds: [], ...over,
});

describe("broadcastPost shared rules", () => {
  it("lists the five v1 types", () => {
    expect(POST_TYPES).toEqual(["STOCK_UPDATE", "RESTOCK", "OUTAGE", "RESTORED", "ANNOUNCEMENT"]);
    expect(isPostType("RESTOCK")).toBe(true);
    expect(isPostType("FLASH_SALE")).toBe(false);
  });

  it("DM shows only available items except for an outage post", () => {
    expect(visibleStatuses("STOCK_UPDATE", "dm")).toEqual(["AVAILABLE"]);
    expect(visibleStatuses("STOCK_UPDATE", "channel")).toEqual(["AVAILABLE", "OUTAGE", "SOLD_OUT"]);
    expect(visibleStatuses("RESTOCK", "channel")).toEqual(["AVAILABLE"]);
    expect(visibleStatuses("RESTORED", "dm")).toEqual(["AVAILABLE"]);
    expect(visibleStatuses("OUTAGE", "dm")).toEqual(["OUTAGE"]);
    expect(visibleStatuses("ANNOUNCEMENT", "dm")).toEqual(["AVAILABLE"]);
  });

  it("only an announcement may be sent with no product lines", () => {
    expect(isDmSendable("ANNOUNCEMENT", 0)).toBe(true);
    expect(isDmSendable("STOCK_UPDATE", 0)).toBe(false);
    expect(isDmSendable("OUTAGE", 2)).toBe(true);
  });

  it("measures length exactly like the existing broadcast route (string length)", () => {
    expect(broadcastLength("<b>ab</b>")).toBe(9);
    expect(DM_TEXT_MAX).toBe(4000);
    expect(DM_CAPTION_MAX).toBe(1024);
  });

  it("reports provider data age and staleness", () => {
    const now = new Date("2026-11-01T07:00:00.000Z");
    expect(providerFreshness(snap(), now, DEFAULT_STALE_MINUTES)).toEqual({ ageMinutes: 30, stale: false, reason: null });
    expect(providerFreshness(snap({ providerSyncedAt: "2026-11-01T05:00:00.000Z" }), now, 90))
      .toEqual({ ageMinutes: 120, stale: true, reason: "old" });
    expect(providerFreshness(snap({ providerSyncedAt: null }), now, 90)).toEqual({ ageMinutes: null, stale: true, reason: "never" });
    expect(providerFreshness(snap({ providerLastRunFailed: true }), now, 90).reason).toBe("last_run_failed");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run packages/core/src/broadcastPost.test.ts`
Expected: FAIL, "Cannot find module './broadcastPost'".

- [ ] **Step 3: Implement** `packages/core/src/broadcastPost.ts`

```ts
/**
 * Shared vocabulary of the broadcast generator: post types, item statuses,
 * the frozen snapshot shape, Telegram size limits and the "which statuses does
 * this post show where" rule. Pure — imported by the renderer, the snapshot
 * builder (packages/db), the admin API and the bot drainer.
 */
export const POST_TYPES = ["STOCK_UPDATE", "RESTOCK", "OUTAGE", "RESTORED", "ANNOUNCEMENT"] as const;
export type PostType = (typeof POST_TYPES)[number];
export const isPostType = (s: unknown): s is PostType => typeof s === "string" && (POST_TYPES as readonly string[]).includes(s);

/** INACTIVE (admin switched off) and GONE (archived) are never rendered. */
export type ItemStatus = "AVAILABLE" | "SOLD_OUT" | "OUTAGE" | "INACTIVE" | "GONE";
export type RenderTarget = "dm" | "channel";

export interface PostItemInput {
  denominationId: number;
  /** Per-post override: show this SKU as sold out (manual SKUs can't know). */
  markSoldOut?: boolean;
  /** Restock/Baru label. */
  label?: "NEW" | "BACK" | null;
}

export interface SnapshotItem {
  denominationId: number;
  name: string;
  status: ItemStatus;
  source: "INTERNAL_INVENTORY" | "PROVIDER_API" | "MANUAL";
  overridden: boolean;
  label: "NEW" | "BACK" | null;
}
export interface SnapshotProduct { productId: number; name: string; icon: string; items: SnapshotItem[] }
export interface SnapshotGroup { group: "PREMIUM_APPS" | "GAME_TOPUP"; products: SnapshotProduct[] }
export interface PostSnapshot {
  resolvedAt: string; // ISO UTC
  /** finishedAt of the last SUCCESSFUL Digiflazz catalog sync, else null. */
  providerSyncedAt: string | null;
  providerLastRunFailed: boolean;
  groups: SnapshotGroup[];
  /** Selected denomination ids that no longer exist. */
  missingIds: number[];
}

export interface PostFields {
  /** Blank → the type's localized default title. */
  title: string | null;
  intro: string | null;
  /** "Keterangan" — required for OUTAGE and RESTORED (validated by the API). */
  details: string | null;
  /** Blank → the language's default footer from Settings. */
  footer: string | null;
}

export const DM_TEXT_MAX = 4000;
export const DM_CAPTION_MAX = 1024;
export const CHANNEL_PART_MAX = 4000;
export const DEFAULT_STALE_MINUTES = 90;

/** Same measure as POST /api/broadcast (`message.length`). */
export const broadcastLength = (s: string): number => s.length;

export function visibleStatuses(type: PostType, target: RenderTarget): ItemStatus[] {
  if (type === "OUTAGE") return ["OUTAGE"];
  if (type === "RESTOCK" || type === "RESTORED") return ["AVAILABLE"];
  return target === "dm" ? ["AVAILABLE"] : ["AVAILABLE", "OUTAGE", "SOLD_OUT"];
}

export const isDmSendable = (type: PostType, visibleCount: number): boolean =>
  type === "ANNOUNCEMENT" || visibleCount > 0;

export interface ProviderFreshness {
  ageMinutes: number | null;
  stale: boolean;
  reason: "never" | "last_run_failed" | "old" | null;
}

export function providerFreshness(s: PostSnapshot, now: Date, staleMinutes: number): ProviderFreshness {
  if (!s.providerSyncedAt) return { ageMinutes: null, stale: true, reason: "never" };
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - Date.parse(s.providerSyncedAt)) / 60_000));
  if (s.providerLastRunFailed) return { ageMinutes, stale: true, reason: "last_run_failed" };
  if (ageMinutes > staleMinutes) return { ageMinutes, stale: true, reason: "old" };
  return { ageMinutes, stale: false, reason: null };
}
```

Check `packages/core/package.json` `exports`. If it uses explicit subpaths rather than a `./*` pattern, add `"./broadcastPost"` and `"./broadcastRender"` (the latter is used by Task 2) the same way as the neighbouring entries.

- [ ] **Step 4: Run the test**

Run: `pnpm exec vitest run packages/core/src/broadcastPost.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the Prisma models.** In `prisma/schema.prisma`, add one line to `model Broadcast` (after `sentAt`):

```prisma
  post          BroadcastPost?
```

After the `Broadcast` model, add:

```prisma
/// A broadcast-generator run: what the admin picked, the frozen snapshot it
/// rendered from, and (for a DM) the Broadcast row it queued. action COPIED =
/// copied for the channel only; QUEUED = handed to the bot drainer.
model BroadcastPost {
  id              Int        @id @default(autoincrement())
  type            String
  language        String
  title           String?
  intro           String?
  details         String?
  footer          String?
  items           Json
  plannedSnapshot Json       @map("planned_snapshot")
  sentSnapshot    Json?      @map("sent_snapshot")
  action          String
  broadcastId     Int?       @unique @map("broadcast_id")
  idempotencyKey  String     @unique @map("idempotency_key")
  createdById     Int?       @map("created_by_id")
  createdAt       DateTime   @default(now()) @map("created_at")
  broadcast       Broadcast? @relation(fields: [broadcastId], references: [id], onDelete: SetNull)

  @@index([createdAt], map: "ix_broadcast_posts_created_at")
  @@map("broadcast_posts")
}

/// A named, shared list of denominations for the broadcast generator.
model BroadcastPreset {
  id              Int      @id @default(autoincrement())
  name            String   @unique
  denominationIds Int[]    @map("denomination_ids")
  createdById     Int?     @map("created_by_id")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@map("broadcast_presets")
}
```

- [ ] **Step 6: Write the migration** `prisma/migrations/20261101120000_broadcast_posts/migration.sql`

```sql
-- CreateTable
CREATE TABLE "broadcast_posts" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT,
    "intro" TEXT,
    "details" TEXT,
    "footer" TEXT,
    "items" JSONB NOT NULL,
    "planned_snapshot" JSONB NOT NULL,
    "sent_snapshot" JSONB,
    "action" TEXT NOT NULL,
    "broadcast_id" INTEGER,
    "idempotency_key" TEXT NOT NULL,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_presets" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "denomination_ids" INTEGER[],
    "created_by_id" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcast_presets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_posts_broadcast_id_key" ON "broadcast_posts"("broadcast_id");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_posts_idempotency_key_key" ON "broadcast_posts"("idempotency_key");

-- CreateIndex
CREATE INDEX "ix_broadcast_posts_created_at" ON "broadcast_posts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_presets_name_key" ON "broadcast_presets"("name");

-- AddForeignKey
ALTER TABLE "broadcast_posts" ADD CONSTRAINT "broadcast_posts_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 7: Verify the schema and migration agree**

Run: `pnpm prisma:generate && pnpm run check-migration-drift && pnpm run check-migration-timestamps`
Expected: "No difference detected" and timestamps OK. If drift prints a diff, change **the SQL file** (never the schema) until the drift check passes. Then apply the migration to your worktree database: `pnpm exec prisma db push --skip-generate`. Only do this after confirming `DATABASE_URL_PRISMA` points at this worktree's own database.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261101120000_broadcast_posts/migration.sql packages/core/src/broadcastPost.ts packages/core/src/broadcastPost.test.ts packages/core/package.json
git commit -m "feat(broadcast): add post/preset tables and the shared generator rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(Drop `packages/core/package.json` from the list if you did not need to change it.)

---

### Task 2: Pure renderer + locale strings

**Files:**
- Create: `packages/core/src/broadcastRender.ts`
- Modify: `packages/core/locales/id.json`, `packages/core/locales/en.json`
- Test: `packages/core/src/broadcastRender.test.ts`

**Interfaces:**
- Consumes: everything from Task 1; `t` from `./i18n`; `esc` from `./formatters`; `DateTime` from `./datetime`; `visualWidth`, `TARGET_LABEL_WIDTH` from `./buttonLimits`; `PRODUCT_GROUPS` from `./productGroups`.
- Produces:
  - `type RenderLang = "id" | "en"`
  - `type DmButton = { text: string; url: string } | { text: string; callbackData: string }`
  - `interface RenderInput { snapshot: PostSnapshot; type: PostType; fields: PostFields; lang: RenderLang; defaultFooter: string | null; botUsername: string | null; now: Date; timezone: string }`
  - `renderDm(input): { html: string; length: number; visibleItemCount: number; buttons: DmButton[][] }`
  - `renderChannel(input): { parts: { html: string; plain: string; length: number }[] }`
  - `htmlToPlain(html: string): string`
  - `toRenderLang(userLanguage: string | null | undefined): RenderLang`

- [ ] **Step 1: Add the locale keys.** Insert these into `packages/core/locales/id.json` (keep the file's existing key order style; add them as one block):

```json
"bcast.title.STOCK_UPDATE": "UPDATE STOK",
"bcast.title.RESTOCK": "RESTOCK & PRODUK BARU",
"bcast.title.OUTAGE": "GANGGUAN LAYANAN",
"bcast.title.RESTORED": "LAYANAN SUDAH NORMAL",
"bcast.title.ANNOUNCEMENT": "PENGUMUMAN",
"bcast.status.AVAILABLE": "Tersedia",
"bcast.status.SOLD_OUT": "Habis",
"bcast.status.OUTAGE": "Gangguan",
"bcast.all_sold_out": "Habis semua",
"bcast.disclaimer": "Stok bisa berubah, cek terbaru di bot.",
"bcast.outage_note": "Status pesanan kami kabari lewat bot.",
"bcast.cta_channel": "👉 Order: {url}",
"bcast.btn_buy": "🛒 Beli sekarang",
"bcast.group.PREMIUM_APPS": "Premium Apps",
"bcast.group.GAME_TOPUP": "Game Top Up",
"bcast.part": "Bagian {n}/{total}"
```

Insert the same keys into `en.json`:

```json
"bcast.title.STOCK_UPDATE": "STOCK UPDATE",
"bcast.title.RESTOCK": "RESTOCK & NEW PRODUCTS",
"bcast.title.OUTAGE": "SERVICE DISRUPTION",
"bcast.title.RESTORED": "SERVICE BACK TO NORMAL",
"bcast.title.ANNOUNCEMENT": "ANNOUNCEMENT",
"bcast.status.AVAILABLE": "Available",
"bcast.status.SOLD_OUT": "Sold out",
"bcast.status.OUTAGE": "Disrupted",
"bcast.all_sold_out": "All sold out",
"bcast.disclaimer": "Stock can change at any time; check the bot for the latest.",
"bcast.outage_note": "We will update your order status in the bot.",
"bcast.cta_channel": "👉 Order: {url}",
"bcast.btn_buy": "🛒 Buy now",
"bcast.group.PREMIUM_APPS": "Premium Apps",
"bcast.group.GAME_TOPUP": "Game Top Up",
"bcast.part": "Part {n}/{total}"
```

Run `pnpm exec vitest run packages/core/src/locales.test.ts tests/no-fake-claims.test.ts`. Expected: PASS. If `locales.test.ts` enforces a placeholder or format rule that `{url}` / `{n}` breaks, follow what the failure message asks for.

- [ ] **Step 2: Write the failing test** `packages/core/src/broadcastRender.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { renderDm, renderChannel, htmlToPlain, toRenderLang, type RenderInput } from "./broadcastRender";
import { visualWidth, TARGET_LABEL_WIDTH } from "./buttonLimits";
import type { PostSnapshot, SnapshotItem } from "./broadcastPost";

const item = (id: number, name: string, status: SnapshotItem["status"], over: Partial<SnapshotItem> = {}): SnapshotItem =>
  ({ denominationId: id, name, status, source: "INTERNAL_INVENTORY", overridden: false, label: null, ...over });

const snapshot: PostSnapshot = {
  resolvedAt: "2026-11-01T07:30:00.000Z",
  providerSyncedAt: "2026-11-01T07:00:00.000Z",
  providerLastRunFailed: false,
  missingIds: [],
  groups: [
    { group: "PREMIUM_APPS", products: [
      { productId: 1, name: "Netflix Premium", icon: "🎬", items: [item(11, "1 Bulan Private", "SOLD_OUT"), item(10, "1 Bulan Sharing", "AVAILABLE")] },
      { productId: 2, name: "Spotify <Premium>", icon: "🎵", items: [item(20, "1 Bulan", "SOLD_OUT")] },
    ] },
    { group: "GAME_TOPUP", products: [
      { productId: 3, name: "Mobile Legends", icon: "🎮", items: [
        item(30, "86 Diamonds", "AVAILABLE", { source: "PROVIDER_API" }),
        item(31, "172 Diamonds", "OUTAGE", { source: "PROVIDER_API" }),
      ] },
    ] },
  ],
};

const base = (over: Partial<RenderInput> = {}): RenderInput => ({
  snapshot, type: "STOCK_UPDATE",
  fields: { title: null, intro: null, details: null, footer: null },
  lang: "id", defaultFooter: "CS: @tokocs", botUsername: "tokobot",
  now: new Date("2026-11-01T07:30:00.000Z"), timezone: "Asia/Jakarta", ...over,
});

describe("renderDm", () => {
  it("shows only available items, with a WIB time header and the disclaimer", () => {
    const r = renderDm(base());
    expect(r.html).toContain("📦 <b>UPDATE STOK</b>");
    expect(r.html).toContain("1 Nov 2026, 14.30 WIB");
    expect(r.html).toContain("• 1 Bulan Sharing — ✅ Tersedia");
    expect(r.html).toContain("• 86 Diamonds — ✅ Tersedia");
    expect(r.html).not.toContain("Habis");
    expect(r.html).not.toContain("Gangguan");
    expect(r.html).not.toContain("Spotify"); // product with nothing visible is dropped
    expect(r.html).toContain("Stok bisa berubah, cek terbaru di bot.");
    expect(r.html).toContain("CS: @tokocs");
    expect(r.visibleItemCount).toBe(2);
    expect(r.length).toBe(r.html.length);
  });

  it("outage post lists only disrupted items with 🔧 and never promises an outcome", () => {
    const r = renderDm(base({ type: "OUTAGE", fields: { title: null, intro: null, details: "Sejak 14.00 WIB", footer: null } }));
    expect(r.html).toContain("🔧 <b>GANGGUAN LAYANAN</b>");
    expect(r.html).toContain("• 172 Diamonds — 🔧 Gangguan");
    expect(r.html).not.toContain("86 Diamonds");
    expect(r.html).toContain("Sejak 14.00 WIB");
    expect(r.html).toContain("Status pesanan kami kabari lewat bot.");
    expect(r.html).not.toMatch(/tetap diproses/);
    expect(r.buttons).toEqual([[{ text: "🏠 Menu", callbackData: "v1:menu:main" }]]); // no "Buy" on an outage
  });

  it("escapes admin text and product names", () => {
    const r = renderDm(base({ type: "ANNOUNCEMENT", fields: { title: "Promo <b>x</b> & y", intro: null, details: null, footer: "a<b" } }));
    expect(r.html).toContain("Promo &lt;b&gt;x&lt;/b&gt; &amp; y");
    expect(r.html).toContain("a&lt;b");
  });

  it("one visible SKU → deep-link buy button + menu; several → a single buy button to the menu", () => {
    const one: PostSnapshot = { ...snapshot, groups: [snapshot.groups[1]!] };
    const r1 = renderDm(base({ snapshot: one }));
    expect(r1.buttons).toEqual([
      [{ text: "🛒 Beli sekarang", url: "https://t.me/tokobot?start=prod_30" }],
      [{ text: "🏠 Menu", callbackData: "v1:menu:main" }],
    ]);
    const r2 = renderDm(base());
    expect(r2.buttons).toEqual([[{ text: "🛒 Beli sekarang", callbackData: "v1:menu:main" }]]);
    for (const row of [...r1.buttons, ...r2.buttons]) for (const b of row) expect(visualWidth(b.text)).toBeLessThanOrEqual(TARGET_LABEL_WIDTH);
  });

  it("renders English strings for an English recipient", () => {
    const r = renderDm(base({ lang: "en" }));
    expect(r.html).toContain("<b>STOCK UPDATE</b>");
    expect(r.html).toContain("✅ Available");
    expect(r.html).toContain("Nov 2026");
  });

  it("marks restock items labelled NEW", () => {
    const s: PostSnapshot = { ...snapshot, groups: [{ group: "PREMIUM_APPS", products: [
      { productId: 1, name: "Netflix Premium", icon: "🎬", items: [item(10, "1 Bulan Sharing", "AVAILABLE", { label: "NEW" })] },
    ] }] };
    expect(renderDm(base({ snapshot: s, type: "RESTOCK" })).html).toContain("• 🆕 1 Bulan Sharing — ✅ Tersedia");
  });
});

describe("renderChannel", () => {
  it("shows sold-out and disrupted items, available first, and collapses an all-sold-out product", () => {
    const { parts } = renderChannel(base());
    expect(parts).toHaveLength(1);
    const html = parts[0]!.html;
    expect(html.indexOf("1 Bulan Sharing")).toBeLessThan(html.indexOf("1 Bulan Private"));
    expect(html).toContain("• 1 Bulan Private — ⛔ Habis");
    expect(html).toContain("• 172 Diamonds — 🔧 Gangguan");
    expect(html).toContain("🎵 <b>Spotify &lt;Premium&gt;</b>: ⛔ Habis semua");
    expect(html).toContain("👉 Order: https://t.me/tokobot?start=channel");
  });

  it("splits per group when too long, every part complete with header and CTA", () => {
    const many = Array.from({ length: 120 }, (_, i) => item(1000 + i, `Varian panjang nomor ${i} dengan nama yang cukup panjang`, "AVAILABLE"));
    const s: PostSnapshot = { ...snapshot, groups: [
      { group: "PREMIUM_APPS", products: [{ productId: 1, name: "Netflix Premium", icon: "🎬", items: many }] },
      snapshot.groups[1]!,
    ] };
    const { parts } = renderChannel(base({ snapshot: s }));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(4000);
      expect(p.html).toContain("<b>UPDATE STOK");
      expect(p.html).toContain("👉 Order:");
    }
    expect(parts.some((p) => p.html.includes("Game Top Up"))).toBe(true);
  });

  it("produces plain text without tags or entities", () => {
    const { parts } = renderChannel(base());
    expect(parts[0]!.plain).not.toMatch(/<\/?b>|&lt;|&amp;/);
    expect(parts[0]!.plain).toContain("Spotify <Premium>");
    expect(htmlToPlain("<b>a &amp; b</b>")).toBe("a & b");
  });
});

describe("toRenderLang", () => {
  it("maps stored user languages", () => {
    expect(toRenderLang("ID")).toBe("id");
    expect(toRenderLang("id")).toBe("id");
    expect(toRenderLang("EN")).toBe("en");
    expect(toRenderLang(null)).toBe("en");
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm exec vitest run packages/core/src/broadcastRender.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement** `packages/core/src/broadcastRender.ts`

```ts
/**
 * Broadcast generator renderer — snapshot → Telegram HTML. Pure (no DB, no
 * network, no config reads): callers pass the time, zone, bot username and the
 * default footer, so the bot drainer and the admin preview render byte-identical
 * text from the same snapshot.
 */
import {
  CHANNEL_PART_MAX, broadcastLength, visibleStatuses,
  type ItemStatus, type PostFields, type PostSnapshot, type PostType, type SnapshotGroup, type SnapshotProduct,
} from "./broadcastPost";
import { DateTime } from "./datetime";
import { esc } from "./formatters";
import { t } from "./i18n";

export type RenderLang = "id" | "en";
export type DmButton = { text: string; url: string } | { text: string; callbackData: string };

export interface RenderInput {
  snapshot: PostSnapshot;
  type: PostType;
  fields: PostFields;
  lang: RenderLang;
  defaultFooter: string | null;
  botUsername: string | null;
  now: Date;
  timezone: string;
}

const TYPE_ICON: Record<PostType, string> = {
  STOCK_UPDATE: "📦", RESTOCK: "🔔", OUTAGE: "🔧", RESTORED: "✅", ANNOUNCEMENT: "📢",
};
const STATUS_ICON: Partial<Record<ItemStatus, string>> = { AVAILABLE: "✅", SOLD_OUT: "⛔", OUTAGE: "🔧" };
const STATUS_ORDER: ItemStatus[] = ["AVAILABLE", "OUTAGE", "SOLD_OUT"];
const ZONE_LABEL: Record<string, string> = { "Asia/Jakarta": "WIB", "Asia/Pontianak": "WIB", "Asia/Makassar": "WITA", "Asia/Jayapura": "WIT" };
const MENU_CALLBACK = "v1:menu:main";

export const toRenderLang = (l: string | null | undefined): RenderLang => ((l ?? "").toLowerCase() === "id" ? "id" : "en");

const blank = (s: string | null | undefined): boolean => s == null || s.trim() === "";

function stamp(now: Date, timezone: string, lang: RenderLang): string {
  const dt = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone).setLocale(lang);
  const zone = ZONE_LABEL[timezone] ?? dt.toFormat("ZZZZ");
  return `${dt.toFormat("d LLL yyyy, HH.mm")} ${zone}`;
}

function header(input: RenderInput, groupSuffix: string | null): string[] {
  const title = blank(input.fields.title) ? t(`bcast.title.${input.type}`, input.lang) : input.fields.title!.trim();
  const suffix = groupSuffix ? ` — ${esc(groupSuffix)}` : "";
  const lines = [`${TYPE_ICON[input.type]} <b>${esc(title)}${suffix}</b>`, stamp(input.now, input.timezone, input.lang)];
  if (!blank(input.fields.intro)) lines.push("", esc(input.fields.intro!.trim()));
  if (!blank(input.fields.details)) lines.push("", esc(input.fields.details!.trim()));
  return lines;
}

function closing(input: RenderInput, target: "dm" | "channel"): string[] {
  const lines: string[] = [];
  if (input.type === "STOCK_UPDATE" || input.type === "RESTOCK") lines.push(t("bcast.disclaimer", input.lang));
  if (input.type === "OUTAGE") lines.push(t("bcast.outage_note", input.lang));
  const footer = blank(input.fields.footer) ? input.defaultFooter : input.fields.footer;
  if (!blank(footer)) lines.push(esc(footer!.trim()));
  if (target === "channel" && input.botUsername) {
    lines.push(t("bcast.cta_channel", input.lang, { url: `https://t.me/${input.botUsername}?start=channel` }));
  }
  return lines.length ? ["", ...lines] : [];
}

/** One product's lines, or [] when nothing of it is visible for this target. */
function productLines(p: SnapshotProduct, visible: ItemStatus[], lang: RenderLang, collapseSoldOut: boolean): string[] {
  const items = p.items
    .filter((i) => visible.includes(i.status))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  if (!items.length) return [];
  const head = `${p.icon} <b>${esc(p.name)}</b>`;
  if (collapseSoldOut && items.every((i) => i.status === "SOLD_OUT")) {
    return [`${head}: ⛔ ${t("bcast.all_sold_out", lang)}`];
  }
  return [
    head,
    ...items.map((i) => {
      const tag = i.label === "NEW" ? "🆕 " : "";
      return `• ${tag}${esc(i.name)} — ${STATUS_ICON[i.status]} ${t(`bcast.status.${i.status}`, lang)}`;
    }),
  ];
}

function bodyBlocks(groups: SnapshotGroup[], visible: ItemStatus[], lang: RenderLang, collapse: boolean): string[][] {
  const blocks: string[][] = [];
  for (const g of groups) for (const p of g.products) {
    const lines = productLines(p, visible, lang, collapse);
    if (lines.length) blocks.push(lines);
  }
  return blocks;
}

const join = (head: string[], blocks: string[][], tail: string[]): string =>
  [...head, ...blocks.flatMap((b) => ["", ...b]), ...tail].join("\n");

export function renderDm(input: RenderInput): { html: string; length: number; visibleItemCount: number; buttons: DmButton[][] } {
  const visible = visibleStatuses(input.type, "dm");
  const blocks = bodyBlocks(input.snapshot.groups, visible, input.lang, false);
  const html = join(header(input, null), blocks, closing(input, "dm"));
  const shown = input.snapshot.groups.flatMap((g) => g.products.flatMap((p) => p.items.filter((i) => visible.includes(i.status))));
  const buy = t("bcast.btn_buy", input.lang);
  const menu: DmButton = { text: t("menu.main", input.lang), callbackData: MENU_CALLBACK };
  // An outage post lists SKUs that can't be bought right now — never offer "Buy".
  const buttons: DmButton[][] =
    input.type === "OUTAGE"
      ? [[menu]]
      : shown.length === 1 && input.botUsername
      ? [[{ text: buy, url: `https://t.me/${input.botUsername}?start=prod_${shown[0]!.denominationId}` }], [menu]]
      : [[{ text: buy, callbackData: MENU_CALLBACK }]];
  return { html, length: broadcastLength(html), visibleItemCount: shown.length, buttons };
}

export function htmlToPlain(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const part = (html: string) => ({ html, plain: htmlToPlain(html), length: broadcastLength(html) });

/** Greedy split of `blocks` so every part (with head + tail) fits the limit. */
function chunk(headFor: (n: number, total: number) => string[], blocks: string[][], tail: string[]): string[] {
  const groups: string[][][] = [[]];
  for (const b of blocks) {
    const cur = groups[groups.length - 1]!;
    if (cur.length && broadcastLength(join(headFor(9, 9), [...cur, b], tail)) > CHANNEL_PART_MAX) groups.push([b]);
    else cur.push(b);
  }
  return groups.map((g, i) => join(headFor(i + 1, groups.length), g, tail));
}

export function renderChannel(input: RenderInput): { parts: { html: string; plain: string; length: number }[] } {
  const visible = visibleStatuses(input.type, "channel");
  const tail = closing(input, "channel");
  const whole = join(header(input, null), bodyBlocks(input.snapshot.groups, visible, input.lang, true), tail);
  if (broadcastLength(whole) <= CHANNEL_PART_MAX) return { parts: [part(whole)] };

  const out: string[] = [];
  for (const g of input.snapshot.groups) {
    const blocks = bodyBlocks([g], visible, input.lang, true);
    if (!blocks.length) continue;
    const groupName = t(`bcast.group.${g.group}`, input.lang);
    out.push(...chunk((n, total) => header(input, total > 1 ? `${groupName} (${t("bcast.part", input.lang, { n, total })})` : groupName), blocks, tail));
  }
  return { parts: out.map(part) };
}
```

Notes for the implementer:
- `t()` lower-cases the language and falls back to English, so `"id"`/`"en"` are correct.
- Verify `DateTime` is re-exported from `./datetime` (it is: `export { DateTime }`).
- If `d LLL` renders "Nov" differently in the `id` locale on this Node build (e.g. "Nov" vs "Nov."), adjust **the test expectation** to the actual Luxon output, not the format string.

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run packages/core/src/broadcastRender.test.ts packages/core/src/broadcastPost.test.ts packages/core/src/locales.test.ts tests/no-fake-claims.test.ts`
Expected: all PASS. Then `pnpm --filter @app/core typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/broadcastRender.ts packages/core/src/broadcastRender.test.ts packages/core/locales/id.json packages/core/locales/en.json
git commit -m "feat(broadcast): render generator posts for DM and channel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Snapshot builder, settings, posts, presets (packages/db)

**Files:**
- Create: `packages/db/src/crud/broadcastPosts.ts`
- Modify: `packages/db/src/index.ts` (add `export * from "./crud/broadcastPosts";` next to `./crud/broadcasts`)
- Test: `packages/db/src/crud/broadcastPosts.test.ts`

**Interfaces:**
- Consumes:
  - `resolveDenominationAvailability`, `fulfillmentSourceOf` (`@app/core/productAvailability`)
  - `groupForCategory`, `PRODUCT_GROUPS` (`@app/core/productGroups`)
  - Task 1 types
  - `availableStockCountsByDenomination` (`./stock`), `getDigiflazzAutoDeactivatedIds` (`./digiflazzAutoDeactivated`), `getDigiflazzSyncStatus` (`./digiflazzSyncStatus`)
  - `getSetting`, `setSetting` (`./settings`), `createBroadcast`, `type BroadcastSegment` (`./broadcasts`)
- Produces:
  - `BROADCAST_FOOTER_ID_KEY = "broadcast_footer_id"`, `BROADCAST_FOOTER_EN_KEY = "broadcast_footer_en"`, `BROADCAST_STALE_MINUTES_KEY = "broadcast_stale_minutes"`
  - `getBroadcastPostSettings(db): Promise<{ footerId: string | null; footerEn: string | null; staleMinutes: number }>`
  - `buildPostSnapshot(db, items: PostItemInput[], now: Date): Promise<PostSnapshot>`
  - `listPostCandidates(db, now): Promise<{ snapshot: PostSnapshot; categories: { id: number; name: string; group: "PREMIUM_APPS" | "GAME_TOPUP" }[]; productCategory: Record<number, number> }>`
  - `createCopiedPost(db, args: NewPostArgs): Promise<{ postId: number; reused: boolean }>`
  - `createQueuedPost(db, args: NewPostArgs & { message: string; segment: BroadcastSegment; scheduledAt: Date | null; total: number; webImageUrl: string | null }): Promise<{ postId: number; broadcastId: number; reused: boolean }>`
  - `listPostHistory(db, limit?): Promise<PostHistoryRow[]>`
  - `lastPostForReuse(db): Promise<PostHistoryRow | null>`
  - `listPresets(db)`, `savePreset(db, { name, denominationIds, createdById })`, `deletePreset(db, id): Promise<boolean>`
  - `loadGeneratedPost(db, broadcastId): Promise<GeneratedPost | null>`
  - `recordSentSnapshot(db, postId, snapshot): Promise<void>`
  - `autoCancelSendingBroadcast(db, broadcastId, reason): Promise<boolean>`
  - types `NewPostArgs`, `PostHistoryRow`, `GeneratedPost`

- [ ] **Step 1: Write the failing test** `packages/db/src/crud/broadcastPosts.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb } from "../../../../tests/helpers/sampleData";
import { setSetting } from "./settings";
import { DIGIFLAZZ_AUTO_DEACTIVATED_IDS_KEY } from "./digiflazzAutoDeactivated";
import { DIGIFLAZZ_SYNC_STATUS_KEY } from "./digiflazzSyncStatus";
import {
  buildPostSnapshot, getBroadcastPostSettings, createCopiedPost, createQueuedPost, listPostHistory,
  lastPostForReuse, savePreset, listPresets, deletePreset, loadGeneratedPost, recordSentSnapshot,
  autoCancelSendingBroadcast, BROADCAST_STALE_MINUTES_KEY, BROADCAST_FOOTER_ID_KEY,
} from "./broadcastPosts";

let db: TestDb;
let prisma: PrismaClient;
beforeAll(async () => { db = await makeTestDb(); prisma = db.prisma; });
afterAll(async () => { await db.cleanup(); });

let sample: Awaited<ReturnType<typeof buildSampleData>>;
const now = new Date("2026-11-01T07:30:00.000Z");
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

async function addDenom(name: string, over: Record<string, unknown> = {}) {
  return prisma.denomination.create({
    data: { productId: sample.parentProduct.id, name, type: "SHARED", durationLabel: "1 Month", price: "5", ...over } as never,
  });
}
const flat = (s: Awaited<ReturnType<typeof buildPostSnapshot>>) => s.groups.flatMap((g) => g.products.flatMap((p) => p.items));

describe("buildPostSnapshot", () => {
  it("maps local stock, sold-out, manual override, Digiflazz outage and admin-off", async () => {
    const empty = await addDenom("Empty"); // auto + no stock rows
    const manual = await addDenom("Manual", { deliveryType: "manual" });
    const dfOut = await addDenom("DF out", { autoDeliverySource: "digiflazz", supplierSku: "X1", isActive: false });
    const adminOff = await addDenom("Admin off", { isActive: false });
    await setSetting(prisma, DIGIFLAZZ_AUTO_DEACTIVATED_IDS_KEY, JSON.stringify([dfOut.id]));

    const snap = await buildPostSnapshot(prisma, [
      { denominationId: sample.product.id },
      { denominationId: empty.id },
      { denominationId: manual.id, markSoldOut: true },
      { denominationId: dfOut.id },
      { denominationId: adminOff.id },
      { denominationId: 999_999 },
    ], now);

    const byId = new Map(flat(snap).map((i) => [i.denominationId, i]));
    expect(byId.get(sample.product.id)!.status).toBe("AVAILABLE");
    expect(byId.get(empty.id)!.status).toBe("SOLD_OUT");
    expect(byId.get(manual.id)).toMatchObject({ status: "SOLD_OUT", overridden: true, source: "MANUAL" });
    expect(byId.get(dfOut.id)).toMatchObject({ status: "OUTAGE", source: "PROVIDER_API" });
    expect(byId.get(adminOff.id)!.status).toBe("INACTIVE");
    expect(snap.missingIds).toEqual([999_999]);
    expect(snap.resolvedAt).toBe(now.toISOString());
    expect(JSON.stringify(snap)).not.toContain("pwd1"); // never credentials
  });

  it("keeps the admin's order and never reads a product name to pick the group", async () => {
    const second = await addDenom("Second");
    const snap = await buildPostSnapshot(prisma, [{ denominationId: second.id }, { denominationId: sample.product.id }], now);
    expect(flat(snap).map((i) => i.denominationId)).toEqual([second.id, sample.product.id]);
    expect(snap.groups[0]!.products[0]!.icon).toBe("🎬"); // category emoji fallback
  });

  it("archived products are GONE", async () => {
    await prisma.product.update({ where: { id: sample.parentProduct.id }, data: { isArchived: true } });
    const snap = await buildPostSnapshot(prisma, [{ denominationId: sample.product.id }], now);
    expect(flat(snap)[0]!.status).toBe("GONE");
  });

  it("reads provider freshness from the last catalog sync", async () => {
    await setSetting(prisma, DIGIFLAZZ_SYNC_STATUS_KEY, JSON.stringify({
      status: "error", updated: 0, deactivated: 0, added: 0, reactivated: 0, abortReason: null, finishedAt: "2026-11-01T07:00:00.000Z",
    }));
    const snap = await buildPostSnapshot(prisma, [], now);
    expect(snap.providerSyncedAt).toBe("2026-11-01T07:00:00.000Z");
    expect(snap.providerLastRunFailed).toBe(true);
  });
});

describe("settings", () => {
  it("defaults the stale threshold to 90 and ignores junk", async () => {
    expect((await getBroadcastPostSettings(prisma)).staleMinutes).toBe(90);
    await setSetting(prisma, BROADCAST_STALE_MINUTES_KEY, "abc");
    expect((await getBroadcastPostSettings(prisma)).staleMinutes).toBe(90);
    await setSetting(prisma, BROADCAST_STALE_MINUTES_KEY, "30");
    expect((await getBroadcastPostSettings(prisma)).staleMinutes).toBe(30);
  });

  it("builds the default footer from existing settings, never showing a numeric channel id", async () => {
    await setSetting(prisma, "bot_username", "tokobot");
    await setSetting(prisma, "support_contact", "@tokocs");
    await setSetting(prisma, "public_channel_id", "-1001234567890");
    expect((await getBroadcastPostSettings(prisma)).footerId).toBe("Order: @tokobot · CS: @tokocs");
    await setSetting(prisma, "public_channel_id", "@tokochannel");
    expect((await getBroadcastPostSettings(prisma)).footerEn).toBe("Order: @tokobot · CS: @tokocs · Channel: @tokochannel");
    await setSetting(prisma, BROADCAST_FOOTER_ID_KEY, "Footer khusus");
    expect((await getBroadcastPostSettings(prisma)).footerId).toBe("Footer khusus");
  });
});

describe("posts", () => {
  const args = async () => ({
    type: "STOCK_UPDATE" as const, language: "id" as const,
    fields: { title: null, intro: null, details: null, footer: null },
    items: [{ denominationId: sample.product.id }],
    snapshot: await buildPostSnapshot(prisma, [{ denominationId: sample.product.id }], now),
    idempotencyKey: "k-1", createdById: sample.user.id,
  });

  it("copy is idempotent per key", async () => {
    const a = await createCopiedPost(prisma, await args());
    const b = await createCopiedPost(prisma, await args());
    expect(b).toEqual({ postId: a.postId, reused: true });
    expect(await prisma.broadcastPost.count()).toBe(1);
  });

  it("queue creates one Broadcast + post atomically and is idempotent", async () => {
    const q = { ...(await args()), idempotencyKey: "k-2", message: "x", segment: "ALL" as const, scheduledAt: null, total: 3, webImageUrl: null };
    const a = await createQueuedPost(prisma, q);
    const b = await createQueuedPost(prisma, q);
    expect(b).toEqual({ ...a, reused: true });
    expect(await prisma.broadcast.count()).toBe(1);
    const gen = await loadGeneratedPost(prisma, a.broadcastId);
    expect(gen).toMatchObject({ postId: a.postId, type: "STOCK_UPDATE", items: [{ denominationId: sample.product.id }] });
    expect(await loadGeneratedPost(prisma, 424242)).toBeNull();
  });

  it("history and reuse expose the latest post with the admin's name", async () => {
    await createCopiedPost(prisma, await args());
    const hist = await listPostHistory(prisma);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ action: "COPIED", type: "STOCK_UPDATE", itemCount: 1, adminName: "Test User", broadcast: null });
    expect((await lastPostForReuse(prisma))!.items).toEqual([{ denominationId: sample.product.id }]);
  });

  it("records the sent snapshot and auto-cancels only a SENDING row", async () => {
    const q = { ...(await args()), idempotencyKey: "k-3", message: "x", segment: "ALL" as const, scheduledAt: null, total: 1, webImageUrl: null };
    const { postId, broadcastId } = await createQueuedPost(prisma, q);
    expect(await autoCancelSendingBroadcast(prisma, broadcastId, "r")).toBe(false); // still PENDING
    await prisma.broadcast.update({ where: { id: broadcastId }, data: { status: "SENDING" } });
    const snap = await buildPostSnapshot(prisma, [], now);
    await recordSentSnapshot(prisma, postId, snap);
    expect(await autoCancelSendingBroadcast(prisma, broadcastId, "Semua item habis saat jam kirim")).toBe(true);
    const bc = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
    expect(bc).toMatchObject({ status: "CANCELLED", failureReason: "Semua item habis saat jam kirim" });
    expect((await prisma.broadcastPost.findUnique({ where: { id: postId } }))!.sentSnapshot).toEqual(snap);
  });
});

describe("presets", () => {
  it("saves by name (upsert), drops ids that no longer exist, deletes", async () => {
    await savePreset(prisma, { name: "Harian", denominationIds: [sample.product.id, 999_999], createdById: null });
    await savePreset(prisma, { name: "Harian", denominationIds: [sample.product.id], createdById: null });
    const list = await listPresets(prisma);
    expect(list).toHaveLength(1);
    expect(list[0]!.denominationIds).toEqual([sample.product.id]);
    expect(await deletePreset(prisma, list[0]!.id)).toBe(true);
    expect(await deletePreset(prisma, list[0]!.id)).toBe(false);
  });
});
```

Before relying on `resetDb`/`buildSampleData` from `makeTestDb`, check how another crud test that uses both does it (e.g. `grep -l buildSampleData packages/db/src/crud/*.test.ts`) and mirror that file's imports and setup exactly. If `resetDb` does not clear the new tables, add `prisma.broadcastPost.deleteMany()` and `prisma.broadcastPreset.deleteMany()` at the top of `beforeEach` rather than editing the shared helper.

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run packages/db/src/crud/broadcastPosts.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `packages/db/src/crud/broadcastPosts.ts`

```ts
/**
 * Broadcast generator storage + the availability snapshot it renders from.
 * Read-only towards the catalog: nothing here writes stock, prices, flash
 * sales or active flags. The snapshot carries names and statuses only — never
 * credentials or raw stock counts.
 */
import {
  DEFAULT_STALE_MINUTES, type PostFields, type PostItemInput, type PostSnapshot, type PostType,
  type SnapshotGroup, type SnapshotItem,
} from "@app/core/broadcastPost";
import { config } from "@app/core/config";
import { BroadcastStatus } from "@app/core/enums";
import { fulfillmentSourceOf, resolveDenominationAvailability } from "@app/core/productAvailability";
import { PRODUCT_GROUPS, groupForCategory } from "@app/core/productGroups";
import { Prisma } from "@prisma/client";
import type { Db } from "./_types";
import { createBroadcast, type BroadcastSegment } from "./broadcasts";
import { getDigiflazzAutoDeactivatedIds } from "./digiflazzAutoDeactivated";
import { getDigiflazzSyncStatus } from "./digiflazzSyncStatus";
import { getSetting } from "./settings";
import { availableStockCountsByDenomination } from "./stock";

export const BROADCAST_FOOTER_ID_KEY = "broadcast_footer_id";
export const BROADCAST_FOOTER_EN_KEY = "broadcast_footer_en";
export const BROADCAST_STALE_MINUTES_KEY = "broadcast_stale_minutes";

const nonBlank = (s: string | null | undefined): string | null => (s && s.trim() ? s : null);

const handle = (s: string | null | undefined): string | null => {
  const v = (s ?? "").trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(v) ? `@${v}` : null;
};

/** Footer built from settings the shop already has, used when the broadcast
 * footer settings are empty. A numeric channel id is never shown. */
async function fallbackFooter(db: Db): Promise<string | null> {
  const [bot, support, channel] = await Promise.all([
    getSetting(db, "bot_username"), getSetting(db, "support_contact"), getSetting(db, "public_channel_id"),
  ]);
  const parts = [
    handle(bot ?? config.BOT_USERNAME) && `Order: ${handle(bot ?? config.BOT_USERNAME)}`,
    nonBlank(support) && `CS: ${support!.trim()}`,
    handle(channel) && `Channel: ${handle(channel)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export async function getBroadcastPostSettings(db: Db) {
  const [footerId, footerEn, staleRaw, fallback] = await Promise.all([
    getSetting(db, BROADCAST_FOOTER_ID_KEY), getSetting(db, BROADCAST_FOOTER_EN_KEY), getSetting(db, BROADCAST_STALE_MINUTES_KEY), fallbackFooter(db),
  ]);
  const n = Number.parseInt(staleRaw ?? "", 10);
  return {
    footerId: nonBlank(footerId) ?? fallback,
    footerEn: nonBlank(footerEn) ?? fallback,
    staleMinutes: Number.isInteger(n) && n > 0 ? n : DEFAULT_STALE_MINUTES,
  };
}

const denomSelect = {
  id: true, name: true, isActive: true, deliveryType: true, autoDeliverySource: true,
  product: { select: { id: true, name: true, emoji: true, isActive: true, isArchived: true,
    category: { select: { id: true, name: true, emoji: true, isActive: true, group: true } } } },
} satisfies Prisma.DenominationSelect;
type DenomRow = Prisma.DenominationGetPayload<{ select: typeof denomSelect }>;

const groupEmoji = (g: string) => PRODUCT_GROUPS.find((d) => d.key === g)?.emoji ?? "•";

async function snapshotFromRows(db: Db, rows: DenomRow[], inputs: PostItemInput[], now: Date, missingIds: number[]): Promise<PostSnapshot> {
  const internalIds = rows.filter((r) => fulfillmentSourceOf(r) === "INTERNAL_INVENTORY").map((r) => r.id);
  const [counts, autoOff, sync] = await Promise.all([
    availableStockCountsByDenomination(db, internalIds), getDigiflazzAutoDeactivatedIds(db), getDigiflazzSyncStatus(db),
  ]);
  const autoOffSet = new Set(autoOff);
  const inputById = new Map(inputs.map((i) => [i.denominationId, i]));
  const byGroup = new Map<string, SnapshotGroup>();

  for (const r of rows) {
    const input = inputById.get(r.id);
    const source = fulfillmentSourceOf(r);
    const avail = resolveDenominationAvailability({
      denom: r, productActive: r.product.isActive, productArchived: false, categoryActive: r.product.category.isActive,
      availableStock: source === "INTERNAL_INVENTORY" ? counts.get(r.id) ?? 0 : null,
    });
    let status: SnapshotItem["status"];
    if (r.product.isArchived) status = "GONE";
    else if (avail.reason === "admin_inactive") {
      status = !r.isActive && autoOffSet.has(r.id) && r.product.isActive && r.product.category.isActive ? "OUTAGE" : "INACTIVE";
    } else if (avail.state === "UNAVAILABLE") status = "SOLD_OUT";
    else status = input?.markSoldOut ? "SOLD_OUT" : "AVAILABLE";

    const groupKey = groupForCategory(r.product.category.group) as SnapshotGroup["group"];
    let group = byGroup.get(groupKey);
    if (!group) { group = { group: groupKey, products: [] }; byGroup.set(groupKey, group); }
    let product = group.products.find((p) => p.productId === r.product.id);
    if (!product) {
      product = { productId: r.product.id, name: r.product.name, icon: r.product.emoji ?? r.product.category.emoji ?? groupEmoji(groupKey), items: [] };
      group.products.push(product);
    }
    product.items.push({
      denominationId: r.id, name: r.name, status, source,
      overridden: Boolean(input?.markSoldOut) && status === "SOLD_OUT" && avail.state === "AVAILABLE",
      label: input?.label ?? null,
    });
  }

  const order = PRODUCT_GROUPS.map((g) => g.key as string);
  return {
    resolvedAt: now.toISOString(),
    providerSyncedAt: sync?.finishedAt ?? null,
    providerLastRunFailed: sync != null && sync.status !== "success",
    groups: [...byGroup.values()].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group)),
    missingIds,
  };
}

/** Snapshot of the admin's selection, in the admin's order. */
export async function buildPostSnapshot(db: Db, items: PostItemInput[], now: Date): Promise<PostSnapshot> {
  const ids = [...new Set(items.map((i) => i.denominationId))];
  const found = ids.length ? await db.denomination.findMany({ where: { id: { in: ids } }, select: denomSelect }) : [];
  const byId = new Map(found.map((r) => [r.id, r]));
  const rows = ids.map((id) => byId.get(id)).filter((r): r is DenomRow => r !== undefined);
  return snapshotFromRows(db, rows, items, now, ids.filter((id) => !byId.has(id)));
}

/** Every non-archived denomination, for the picker. */
export async function listPostCandidates(db: Db, now: Date) {
  const rows = await db.denomination.findMany({
    where: { product: { isArchived: false } },
    select: denomSelect,
    orderBy: [{ product: { category: { name: "asc" } } }, { product: { name: "asc" } }, { id: "asc" }],
  });
  const snapshot = await snapshotFromRows(db, rows, [], now, []);
  const categories = new Map<number, { id: number; name: string; group: SnapshotGroup["group"] }>();
  const productCategory: Record<number, number> = {};
  for (const r of rows) {
    categories.set(r.product.category.id, { id: r.product.category.id, name: r.product.category.name, group: groupForCategory(r.product.category.group) as SnapshotGroup["group"] });
    productCategory[r.product.id] = r.product.category.id;
  }
  return { snapshot, categories: [...categories.values()], productCategory };
}

export interface NewPostArgs {
  type: PostType;
  language: "id" | "en";
  fields: PostFields;
  items: PostItemInput[];
  snapshot: PostSnapshot;
  idempotencyKey: string;
  createdById: number | null;
}

const postData = (a: NewPostArgs, action: "COPIED" | "QUEUED") => ({
  type: a.type, language: a.language, title: a.fields.title, intro: a.fields.intro, details: a.fields.details,
  footer: a.fields.footer, items: a.items as unknown as Prisma.InputJsonValue,
  plannedSnapshot: a.snapshot as unknown as Prisma.InputJsonValue, action, idempotencyKey: a.idempotencyKey, createdById: a.createdById,
});

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export async function createCopiedPost(db: Db, a: NewPostArgs): Promise<{ postId: number; reused: boolean }> {
  const existing = await db.broadcastPost.findUnique({ where: { idempotencyKey: a.idempotencyKey }, select: { id: true } });
  if (existing) return { postId: existing.id, reused: true };
  try {
    const p = await db.broadcastPost.create({ data: postData(a, "COPIED"), select: { id: true } });
    return { postId: p.id, reused: false };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const p = await db.broadcastPost.findUniqueOrThrow({ where: { idempotencyKey: a.idempotencyKey }, select: { id: true } });
    return { postId: p.id, reused: true };
  }
}

export async function createQueuedPost(
  db: Db,
  a: NewPostArgs & { message: string; segment: BroadcastSegment; scheduledAt: Date | null; total: number; webImageUrl: string | null },
): Promise<{ postId: number; broadcastId: number; reused: boolean }> {
  const find = () => db.broadcastPost.findUnique({ where: { idempotencyKey: a.idempotencyKey }, select: { id: true, broadcastId: true } });
  const existing = await find();
  if (existing?.broadcastId != null) return { postId: existing.id, broadcastId: existing.broadcastId, reused: true };
  try {
    return await db.$transaction(async (tx) => {
      const bc = await createBroadcast(tx, {
        message: a.message, segment: a.segment, scheduledAt: a.scheduledAt, createdById: a.createdById,
        total: a.total, webImageUrl: a.webImageUrl, status: BroadcastStatus.PENDING,
      });
      const p = await tx.broadcastPost.create({ data: { ...postData(a, "QUEUED"), broadcastId: bc.id }, select: { id: true } });
      return { postId: p.id, broadcastId: bc.id, reused: false };
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const p = await find();
    if (p?.broadcastId == null) throw e;
    return { postId: p.id, broadcastId: p.broadcastId, reused: true };
  }
}

export interface PostHistoryRow {
  id: number;
  type: string;
  action: string;
  language: string;
  createdAt: Date;
  adminName: string | null;
  itemCount: number;
  items: PostItemInput[];
  plannedSnapshot: PostSnapshot;
  sentSnapshot: PostSnapshot | null;
  broadcast: { id: number; status: string; segment: string; sentCount: number; totalCount: number; failureReason: string | null } | null;
}

async function shapeHistory(db: Db, rows: Prisma.BroadcastPostGetPayload<{ include: { broadcast: true } }>[]): Promise<PostHistoryRow[]> {
  const adminIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is number => x != null))];
  const admins = adminIds.length ? await db.user.findMany({ where: { id: { in: adminIds } }, select: { id: true, fullName: true, username: true } }) : [];
  const name = new Map(admins.map((u) => [u.id, u.fullName ?? u.username ?? null]));
  return rows.map((r) => {
    const items = r.items as unknown as PostItemInput[];
    return {
      id: r.id, type: r.type, action: r.action, language: r.language, createdAt: r.createdAt,
      adminName: r.createdById != null ? name.get(r.createdById) ?? null : null,
      itemCount: items.length, items,
      plannedSnapshot: r.plannedSnapshot as unknown as PostSnapshot,
      sentSnapshot: (r.sentSnapshot as unknown as PostSnapshot | null) ?? null,
      broadcast: r.broadcast
        ? { id: r.broadcast.id, status: r.broadcast.status, segment: r.broadcast.segment, sentCount: r.broadcast.sentCount, totalCount: r.broadcast.totalCount, failureReason: r.broadcast.failureReason }
        : null,
    };
  });
}

export async function listPostHistory(db: Db, limit = 50): Promise<PostHistoryRow[]> {
  const rows = await db.broadcastPost.findMany({ orderBy: { id: "desc" }, take: limit, include: { broadcast: true } });
  return shapeHistory(db, rows);
}

export async function lastPostForReuse(db: Db): Promise<PostHistoryRow | null> {
  const rows = await db.broadcastPost.findMany({ orderBy: { id: "desc" }, take: 1, include: { broadcast: true } });
  return (await shapeHistory(db, rows))[0] ?? null;
}

export function listPresets(db: Db) {
  return db.broadcastPreset.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, denominationIds: true, updatedAt: true } });
}

/** Upsert by name; ids of denominations that no longer exist are dropped. */
export async function savePreset(db: Db, a: { name: string; denominationIds: number[]; createdById: number | null }) {
  const ids = [...new Set(a.denominationIds)];
  const existing = ids.length ? await db.denomination.findMany({ where: { id: { in: ids } }, select: { id: true } }) : [];
  const keep = new Set(existing.map((d) => d.id));
  const denominationIds = ids.filter((id) => keep.has(id));
  return db.broadcastPreset.upsert({
    where: { name: a.name },
    create: { name: a.name, denominationIds, createdById: a.createdById },
    update: { denominationIds },
    select: { id: true, name: true, denominationIds: true, updatedAt: true },
  });
}

export async function deletePreset(db: Db, id: number): Promise<boolean> {
  const res = await db.broadcastPreset.deleteMany({ where: { id } });
  return res.count > 0;
}

export interface GeneratedPost {
  postId: number;
  type: PostType;
  fields: PostFields;
  items: PostItemInput[];
  createdById: number | null;
}

/** The generator post behind a Broadcast row, or null for a legacy row. */
export async function loadGeneratedPost(db: Db, broadcastId: number): Promise<GeneratedPost | null> {
  const p = await db.broadcastPost.findUnique({ where: { broadcastId } });
  if (!p) return null;
  return {
    postId: p.id, type: p.type as PostType,
    fields: { title: p.title, intro: p.intro, details: p.details, footer: p.footer },
    items: p.items as unknown as PostItemInput[], createdById: p.createdById,
  };
}

export async function recordSentSnapshot(db: Db, postId: number, snapshot: PostSnapshot): Promise<void> {
  await db.broadcastPost.update({ where: { id: postId }, data: { sentSnapshot: snapshot as unknown as Prisma.InputJsonValue } });
}

/** SENDING → CANCELLED with a reason (the drainer found nothing to send). */
export async function autoCancelSendingBroadcast(db: Db, broadcastId: number, reason: string): Promise<boolean> {
  const res = await db.broadcast.updateMany({
    where: { id: broadcastId, status: BroadcastStatus.SENDING },
    data: { status: BroadcastStatus.CANCELLED, failureReason: reason },
  });
  return res.count > 0;
}
```

Implementer checks:
- `createBroadcast` takes `db: Db`. Confirm `Db` accepts the transaction client. Other crud functions in this repo are called with `tx` the same way; if `Db` does not accept it, type `tx` the way `./_types` documents.
- If a field name differs from the schema (e.g. `fullName`), fix it from `prisma/schema.prisma` and keep the behaviour.

- [ ] **Step 4: Export and run**

Add `export * from "./crud/broadcastPosts";` to `packages/db/src/index.ts` next to the `broadcasts` export.
Run: `pnpm exec vitest run packages/db/src/crud/broadcastPosts.test.ts`
Expected: PASS. Then `pnpm --filter @app/db typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/broadcastPosts.ts packages/db/src/crud/broadcastPosts.test.ts packages/db/src/index.ts
git commit -m "feat(broadcast): build availability snapshots and store generator posts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Bot drainer sends generated broadcasts

**Files:**
- Modify: `apps/order-bot/src/jobs/index.ts` (`drainBroadcasts`, ~line 1326)
- Test: `apps/order-bot/test/jobs.test.ts` (inside `describe("drainBroadcasts")`, ~line 1207)

**Interfaces:**
- Consumes:
  - `loadGeneratedPost`, `buildPostSnapshot`, `recordSentSnapshot`, `autoCancelSendingBroadcast`, `getBroadcastPostSettings`, `createQueuedPost`, `logAdminAction` (`@app/db`)
  - `renderDm`, `toRenderLang` (`@app/core/broadcastRender`)
  - `isDmSendable`, `DM_CAPTION_MAX` (`@app/core/broadcastPost`)
  - `botUsername` (`@app/core/runtime`), `config.TIMEZONE`
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests.** Add them to the existing `describe("drainBroadcasts")` block in `apps/order-bot/test/jobs.test.ts`, reusing its `addRecipient`, `fakeApi`, `sample` and `prisma`. Add `buildPostSnapshot, createQueuedPost` to the file's `@app/db` import.

```ts
  async function queueGenerated(items: { denominationId: number; markSoldOut?: boolean }[], type: "STOCK_UPDATE" | "ANNOUNCEMENT" = "STOCK_UPDATE") {
    const snapshot = await buildPostSnapshot(prisma, items, new Date());
    return createQueuedPost(prisma, {
      type, language: "id", fields: { title: null, intro: null, details: null, footer: "CS: @tokocs" },
      items, snapshot, idempotencyKey: `k-${Math.random()}`, createdById: null,
      message: "planned", segment: "ALL", scheduledAt: null, total: 0, webImageUrl: null,
    });
  }

  it("legacy broadcasts still go out as plain text with no parse mode", async () => {
    await addRecipient(5001);
    await createBroadcast(prisma, { message: "a < b", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
    const api = fakeApi();
    await drainBroadcasts(api);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0]![1]).toBe("a < b");
    expect(api.sendMessage.mock.calls[0]![2]).toBeUndefined();
  });

  it("a generated broadcast re-resolves at send time and sends HTML + buttons in each recipient's language", async () => {
    await addRecipient(5101);
    await prisma.user.create({ data: { telegramId: BigInt(5102), referralCode: "r5102", role: "CUSTOMER", language: "ID" } });
    const { broadcastId, postId } = await queueGenerated([{ denominationId: sample.product.id }]);
    const api = fakeApi();

    await drainBroadcasts(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);   // exactly one message per recipient
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
    const byChat = new Map(api.sendMessage.mock.calls.map((c) => [c[0], c]));
    expect(byChat.get(5102)![1]).toContain("UPDATE STOK");
    expect(byChat.get(5101)![1]).toContain("STOCK UPDATE");
    expect(byChat.get(5102)![2]).toMatchObject({ parse_mode: "HTML" });
    expect(byChat.get(5102)![2].reply_markup).toBeDefined();
    const post = await prisma.broadcastPost.findUnique({ where: { id: postId } });
    expect(post!.sentSnapshot).not.toBeNull();
    expect((await prisma.broadcast.findUnique({ where: { id: broadcastId } }))!.status).toBe("SENT");
  });

  it("cancels instead of sending when every item became unavailable before send time", async () => {
    await addRecipient(5201);
    const { broadcastId } = await queueGenerated([{ denominationId: sample.product.id }]);
    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: "SOLD" } });
    const api = fakeApi();

    await drainBroadcasts(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.sendPhoto).not.toHaveBeenCalled();
    const bc = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
    expect(bc).toMatchObject({ status: "CANCELLED", failureReason: "Semua item habis saat jam kirim" });
    expect(await prisma.auditLog.count({ where: { action: "broadcast_auto_cancel", targetId: broadcastId } })).toBe(1);
  });
```

Adjust only to the real fixture shapes:
- If `fakeApi()` has no `editMessageText`/`deleteMessage` mocks, drop those two assertions.
- Use whatever non-AVAILABLE stock status the `StockStatus` enum defines in place of `"SOLD"`.
- Use the stored language casing that `User.language` really holds.

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm exec vitest run apps/order-bot/test/jobs.test.ts -t drainBroadcasts`
Expected: the two generated-broadcast tests FAIL (plain text sent, no cancel). The legacy test passes.

- [ ] **Step 3: Implement.** In `drainBroadcasts`, right after the `isBroadcastSegment` guard and before `resolveSegmentRecipients`, insert:

```ts
  // Generated broadcasts (web-admin "Buat dari Produk") are rebuilt from live
  // availability at the moment they go out, so a scheduled stock update never
  // announces an item that sold out in the meantime. Legacy rows (no post) keep
  // the plain-text path below unchanged.
  const generated = await loadGeneratedPost(prisma, bc.id);
  let generatedRender: Record<"id" | "en", { html: string; markup: InlineKeyboard }> | null = null;
  if (generated) {
    const now = new Date();
    const snapshot = await buildPostSnapshot(prisma, generated.items, now);
    await recordSentSnapshot(prisma, generated.postId, snapshot);
    const settings = await getBroadcastPostSettings(prisma);
    const render = (lang: "id" | "en") =>
      renderDm({
        snapshot, type: generated.type, fields: generated.fields, lang,
        defaultFooter: lang === "id" ? settings.footerId : settings.footerEn,
        botUsername: botUsername() ?? null, now, timezone: config.TIMEZONE,
      });
    const id = render("id");
    if (!isDmSendable(generated.type, id.visibleItemCount)) {
      const reason = "Semua item habis saat jam kirim";
      if (await autoCancelSendingBroadcast(prisma, bc.id, reason)) {
        await logAdminAction(prisma, {
          adminId: generated.createdById, action: "broadcast_auto_cancel", targetType: "broadcast", targetId: bc.id,
          details: "Cancelled a scheduled product broadcast automatically because none of its products were available when it was due to send.",
        });
      }
      logger.info(`Broadcast #${bc.id} was cancelled at send time because none of its selected products were still available, so no customer was messaged`);
      return;
    }
    const toKeyboard = (rows: ReturnType<typeof renderDm>["buttons"]) => {
      const kb = new InlineKeyboard();
      rows.forEach((row, i) => {
        if (i > 0) kb.row();
        for (const b of row) "url" in b ? kb.url(b.text, b.url) : kb.text(b.text, b.callbackData);
      });
      return kb;
    };
    const en = render("en");
    generatedRender = { id: { html: id.html, markup: toKeyboard(id.buttons) }, en: { html: en.html, markup: toKeyboard(en.buttons) } };
    if (photoArgFor(bc) && Math.max(id.length, en.length) > DM_CAPTION_MAX) {
      logger.warn(`Broadcast #${bc.id} grew past the photo caption limit when it was rendered at send time; Telegram may reject the caption for some recipients`);
    }
  }
```

Then change `deliver` to take the recipient's language and use the generated text when present:

```ts
  const deliver = async (telegramId: bigint | null, language: string | null) => {
    const gen = generatedRender ? generatedRender[toRenderLang(language)] : null;
    if (photoArg) {
      const photo = cachedFileId ?? photoArg.photo;
      const msg = gen
        ? await api.sendPhoto(Number(telegramId), photo, { caption: gen.html, parse_mode: "HTML", reply_markup: gen.markup })
        : await api.sendPhoto(Number(telegramId), photo, { caption: bc.message });
      if (!cachedFileId && photoArg.needsCache && msg.photo?.length) {
        cachedFileId = msg.photo[msg.photo.length - 1]!.file_id;
        await cacheFileId(cachedFileId);
      }
    } else if (gen) {
      await api.sendMessage(Number(telegramId), gen.html, { parse_mode: "HTML", reply_markup: gen.markup });
    } else {
      // Plain text — the operator types raw content; no parse_mode so '<' / '&'
      // can't break the message.
      await api.sendMessage(Number(telegramId), bc.message);
    }
  };
```

Update the single call site to `await deliver(r.telegramId, r.language);`. `resolveSegmentRecipients` already selects `language`.

Notes:
- `photoArgFor(bc)` stands for whatever expression the function already uses (`broadcastPhotoArg(bc)`). Reuse the existing `photoArg` variable by moving the generated block below its declaration, rather than calling the function twice.
- Change the `grammy` import from `import { GrammyError, type Api, type InlineKeyboard }` to a value import of `InlineKeyboard`.
- The caption is never longer than the planned one, because send-time re-resolve only drops items. Task 5's API refuses a planned caption over 1024, so the warn above is a safety log only.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/order-bot/test/jobs.test.ts -t drainBroadcasts`, then `pnpm --filter @app/order-bot typecheck`, then the guards: `pnpm exec vitest run apps/order-bot/test/keyboard-label-guard.test.ts apps/order-bot/test/money-input-guard.test.ts tests/availability-guard.test.ts`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/order-bot/src/jobs/index.ts apps/order-bot/test/jobs.test.ts
git commit -m "feat(order-bot): send generated broadcasts with live status, HTML and buttons

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Admin API for the generator + settings keys

**Files:**
- Create: `apps/web-admin/src/lib/broadcastImage.ts`
- Modify: `apps/web-admin/src/routes/api/broadcast.ts` (use the shared image check; behaviour unchanged)
- Create: `apps/web-admin/src/routes/api/broadcastPosts.ts`
- Modify: `apps/web-admin/src/server.ts` (register next to `broadcastApiRoutes`, ~line 186)
- Modify: `apps/web-admin/src/routes/api/settings.ts` (`EDITABLE`, ~line 66)
- Test: `apps/web-admin/test/broadcastPosts.test.ts`

**Interfaces:**
- Consumes: Task 1–3 exports; `currentAdmin`, `csrfProtect` (`../../plugins/auth`); `countSegment`, `isBroadcastSegment`, `BROADCAST_SEGMENTS`, `logAdminAction` (`@app/db`); `botUsername` (`@app/core/runtime`); `config.TIMEZONE`.
- Produces (HTTP, consumed by Task 6). JSON bodies use these exact names:
  - `GET /api/broadcast/posts/options` → `{ products: OptionProduct[]; categories: {id,name,group}[]; provider: { syncedAt: string|null; ageMinutes: number|null; stale: boolean; reason: "never"|"last_run_failed"|"old"|null; staleMinutes: number }; presets: {id,name,denominationIds}[]; last: { type, items, createdAt, adminName } | null; segments: string[]; counts: Record<string, number>; defaults: { footerId: string|null; footerEn: string|null } }`
    - `OptionProduct = { productId, name, icon, group, categoryId, items: { denominationId, name, status, source }[] }`
  - `POST /api/broadcast/posts/preview` body `PostBody` → `{ dm: { html, length, limit, visibleItemCount, sendable, blockReason: string|null }; channel: { parts: {html, plain, length}[] }; provider: …same as options…; missingIds: number[] }`
  - `POST /api/broadcast/posts/copy` body `PostBody & { idempotency_key }` → `{ postId, reused, parts }`
  - `POST /api/broadcast/posts/send` body `PostBody & { idempotency_key, segment, scheduled_at, image_url }` → 201 `{ postId, broadcastId, reused, total }`
  - `GET /api/broadcast/posts/history` → `{ history: PostHistoryRow[] }`, with `createdAtDisplay` added per row
  - `POST /api/broadcast/posts/presets` `{ name, denomination_ids }` → `{ preset }`
  - `POST /api/broadcast/posts/presets/:id/delete` → `{ ok: true }`
  - `PostBody = { type, language: "id"|"en", title, intro, details, footer, items: PostItemInput[], has_image?: boolean, ack_stale?: boolean }`
  - copy/send answer **409** `{ code: "stale_provider", error }` when a Digiflazz item is selected, provider data is stale, and `ack_stale !== true`.

- [ ] **Step 1: Extract the image check.** Create `apps/web-admin/src/lib/broadcastImage.ts`. Move the block from `routes/api/broadcast.ts` (lines ~72-81, the `BROADCAST_IMAGE_RE` check + `stat` on disk) into:

```ts
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { UPLOADS_DIR } from "../paths";

export const BROADCAST_IMAGE_RE = /^\/uploads\/broadcasts\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/;

/** null = no image; { error } = refuse with 400; { url } = a verified upload. */
export async function checkBroadcastImage(raw: string): Promise<{ url: string } | { error: string } | null> {
  const v = raw.trim();
  if (!v) return null;
  if (!BROADCAST_IMAGE_RE.test(v)) return { error: "Invalid image reference." };
  const filename = v.slice("/uploads/broadcasts/".length);
  const onDisk = await stat(join(UPLOADS_DIR, "broadcasts", filename)).then(() => true).catch(() => false);
  return onDisk ? { url: v } : { error: "Attached image was not found — please re-upload." };
}
```

Make `broadcast.ts` call it with identical responses. Confirm the relative path of `UPLOADS_DIR` from `src/lib` (`broadcast.ts` imports it as `../../paths`). Run `pnpm exec vitest run apps/web-admin/test/broadcast.test.ts apps/web-admin/test/broadcastPhoto.test.ts`. Expected: PASS, unchanged.

- [ ] **Step 2: Write the failing API test** `apps/web-admin/test/broadcastPosts.test.ts`. Copy the setup block of `apps/web-admin/test/broadcast.test.ts` (lines 1-50: `setup-env` import first, `buildApp`, session cookie, `postJson`, `getJson`) verbatim, then add `buildSampleData` from `../../../tests/helpers/sampleData` and:

```ts
let denomId: number;
beforeEach(async () => {
  const s = await buildSampleData(prisma);
  denomId = s.product.id;
});

const body = (over: Record<string, unknown> = {}) => ({
  type: "STOCK_UPDATE", language: "id", title: "", intro: "", details: "", footer: "",
  items: [{ denominationId: denomId }], ...over,
});

describe("broadcast generator API", () => {
  it("options lists products with statuses, provider freshness and defaults", async () => {
    const res = await getJson("/api/broadcast/posts/options", cookie);
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.products.some((p: { items: { denominationId: number; status: string }[] }) =>
      p.items.some((i) => i.denominationId === denomId && i.status === "AVAILABLE"))).toBe(true);
    expect(j.provider).toMatchObject({ stale: true, reason: "never", staleMinutes: 90 });
    expect(j.segments).toEqual(["ALL", "RESELLERS", "RECENT_BUYERS"]);
  });

  it("preview renders DM + channel and writes nothing", async () => {
    const res = await postJson("/api/broadcast/posts/preview", cookie, csrf, body());
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.dm).toMatchObject({ sendable: true, limit: 4000, blockReason: null });
    expect(j.dm.html).toContain("UPDATE STOK");
    expect(j.channel.parts).toHaveLength(1);
    expect(await prisma.broadcastPost.count()).toBe(0);
  });

  it("preview blocks DM send when nothing is available, and explains why", async () => {
    await prisma.stockItem.deleteMany({ where: { productId: denomId } });
    const j = (await postJson("/api/broadcast/posts/preview", cookie, csrf, body())).json();
    expect(j.dm.sendable).toBe(false);
    expect(j.dm.blockReason).toMatch(/no product is available/i);
  });

  it("requires Keterangan for an outage post and rejects unknown types", async () => {
    expect((await postJson("/api/broadcast/posts/preview", cookie, csrf, body({ type: "OUTAGE" }))).statusCode).toBe(400);
    expect((await postJson("/api/broadcast/posts/preview", cookie, csrf, body({ type: "FLASH_SALE" }))).statusCode).toBe(400);
  });

  it("copy is idempotent and audited once", async () => {
    const a = await postJson("/api/broadcast/posts/copy", cookie, csrf, body({ idempotency_key: "c1" }));
    const b = await postJson("/api/broadcast/posts/copy", cookie, csrf, body({ idempotency_key: "c1" }));
    expect(a.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ postId: a.json().postId, reused: true });
    expect(await prisma.auditLog.count({ where: { action: "broadcast_post_copy" } })).toBe(1);
  });

  it("send queues one PENDING broadcast linked to the post", async () => {
    const res = await postJson("/api/broadcast/posts/send", cookie, csrf, body({ idempotency_key: "s1", segment: "ALL", scheduled_at: "", image_url: "" }));
    expect(res.statusCode).toBe(201);
    const { broadcastId } = res.json();
    const bc = await prisma.broadcast.findUnique({ where: { id: broadcastId }, include: { post: true } });
    expect(bc).toMatchObject({ status: "PENDING", segment: "ALL" });
    expect(bc!.post).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "broadcast_post_send" } })).toBe(1);
  });

  it("send refuses an invalid segment and a DM with nothing available", async () => {
    expect((await postJson("/api/broadcast/posts/send", cookie, csrf, body({ idempotency_key: "s2", segment: "NOPE" }))).statusCode).toBe(400);
    await prisma.stockItem.deleteMany({ where: { productId: denomId } });
    expect((await postJson("/api/broadcast/posts/send", cookie, csrf, body({ idempotency_key: "s3", segment: "ALL" }))).statusCode).toBe(400);
  });

  it("presets save, list via options, and delete", async () => {
    const saved = await postJson("/api/broadcast/posts/presets", cookie, csrf, { name: "Harian", denomination_ids: [denomId] });
    expect(saved.statusCode).toBe(200);
    expect((await getJson("/api/broadcast/posts/options", cookie, )).json().presets[0]).toMatchObject({ name: "Harian", denominationIds: [denomId] });
    const del = await postJson(`/api/broadcast/posts/presets/${saved.json().preset.id}/delete`, cookie, csrf);
    expect(del.statusCode).toBe(200);
  });

  it("history returns the copied post with its admin", async () => {
    await postJson("/api/broadcast/posts/copy", cookie, csrf, body({ idempotency_key: "h1" }));
    const j = (await getJson("/api/broadcast/posts/history", cookie)).json();
    expect(j.history[0]).toMatchObject({ action: "COPIED", adminName: "Admin" });
  });

  it("refuses copy/send of a Digiflazz item on stale data unless acknowledged", async () => {
    await prisma.denomination.update({ where: { id: denomId }, data: { autoDeliverySource: "digiflazz", supplierSku: "ML86" } });
    const res = await postJson("/api/broadcast/posts/copy", cookie, csrf, body({ idempotency_key: "stale1" })); // never synced → stale
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("stale_provider");
    const ok = await postJson("/api/broadcast/posts/copy", cookie, csrf, body({ idempotency_key: "stale2", ack_stale: true }));
    expect(ok.statusCode).toBe(200);
  });

  it("does not ask for acknowledgement when no provider item is selected", async () => {
    expect((await postJson("/api/broadcast/posts/copy", cookie, csrf, body({ idempotency_key: "nostale" }))).statusCode).toBe(200);
  });

  it("refuses mutations without CSRF", async () => {
    expect((await postJson("/api/broadcast/posts/copy", cookie, "bad", body({ idempotency_key: "x" }))).statusCode).toBe(403);
  });
});
```

If `broadcast.test.ts` already has a readonly-role test, copy its role setup and add one case: a readonly admin gets 403 on `/api/broadcast/posts/send`. If the existing CSRF-failure tests in `broadcast.test.ts` expect a status other than 403, use theirs.

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm exec vitest run apps/web-admin/test/broadcastPosts.test.ts`
Expected: FAIL (404s).

- [ ] **Step 4: Implement** `apps/web-admin/src/routes/api/broadcastPosts.ts`

```ts
/**
 * Broadcast generator API ("Buat dari Produk"). Read-only towards the catalog;
 * the DM is only ENQUEUED as a Broadcast row — the order-bot sends it (the web
 * never calls Telegram). RBAC: every path is under /api/broadcast, so
 * canMutate's CONFIG_PREFIXES rule applies unchanged.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "@app/core/config";
import { botUsername } from "@app/core/runtime";
import { localize } from "@app/core/datetime";
import {
  DM_CAPTION_MAX, DM_TEXT_MAX, isDmSendable, isPostType, providerFreshness,
  type PostFields, type PostItemInput, type PostType,
} from "@app/core/broadcastPost";
import { renderChannel, renderDm, type RenderLang } from "@app/core/broadcastRender";
import {
  prisma, BROADCAST_SEGMENTS, countSegment, isBroadcastSegment, logAdminAction,
  buildPostSnapshot, listPostCandidates, getBroadcastPostSettings, createCopiedPost, createQueuedPost,
  listPostHistory, lastPostForReuse, listPresets, savePreset, deletePreset,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { checkBroadcastImage } from "../../lib/broadcastImage";

const TYPE_NOUN: Record<PostType, string> = {
  STOCK_UPDATE: "stock-update", RESTOCK: "restock", OUTAGE: "service-disruption", RESTORED: "service-restored", ANNOUNCEMENT: "announcement",
};
const MAX_ITEMS = 300;
const MAX_FIELD = 1000;

interface Parsed { type: PostType; lang: RenderLang; fields: PostFields; items: PostItemInput[] }

function parseBody(raw: unknown): Parsed | { error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (!isPostType(b.type)) return { error: "Pick a valid broadcast type." };
  const lang: RenderLang = b.language === "en" ? "en" : "id";
  const text = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim() : "";
    return s ? s.slice(0, MAX_FIELD) : null;
  };
  const fields: PostFields = { title: text(b.title), intro: text(b.intro), details: text(b.details), footer: text(b.footer) };
  if ((b.type === "OUTAGE" || b.type === "RESTORED") && !fields.details) {
    return { error: "Add a short note (Keterangan) saying since when and the expected recovery time." };
  }
  if (!Array.isArray(b.items) || b.items.length > MAX_ITEMS) return { error: `Pick up to ${MAX_ITEMS} products.` };
  const items: PostItemInput[] = [];
  for (const it of b.items as Record<string, unknown>[]) {
    const id = Number(it?.denominationId);
    if (!Number.isInteger(id) || id <= 0) return { error: "One of the selected products is invalid — reload the page." };
    const label = it.label === "NEW" || it.label === "BACK" ? it.label : null;
    items.push({ denominationId: id, markSoldOut: it.markSoldOut === true, label });
  }
  if (b.type !== "ANNOUNCEMENT" && items.length === 0) return { error: "Pick at least one product." };
  return { type: b.type, lang, fields, items };
}

async function render(p: Parsed, hasImage: boolean) {
  const now = new Date();
  const [snapshot, settings] = await Promise.all([buildPostSnapshot(prisma, p.items, now), getBroadcastPostSettings(prisma)]);
  const common = { snapshot, type: p.type, fields: p.fields, botUsername: botUsername() ?? null, now, timezone: config.TIMEZONE };
  const footerFor = (l: RenderLang) => (l === "id" ? settings.footerId : settings.footerEn);
  const dm = renderDm({ ...common, lang: p.lang, defaultFooter: footerFor(p.lang) });
  // Both languages go out (each recipient gets theirs) — the longer one decides.
  const other = renderDm({ ...common, lang: p.lang === "id" ? "en" : "id", defaultFooter: footerFor(p.lang === "id" ? "en" : "id") });
  const limit = hasImage ? DM_CAPTION_MAX : DM_TEXT_MAX;
  const longest = Math.max(dm.length, other.length);
  let blockReason: string | null = null;
  if (!isDmSendable(p.type, dm.visibleItemCount)) blockReason = "No product is available to send right now, so a bot message would be empty. You can still copy the channel post.";
  else if (longest > limit) blockReason = hasImage
    ? `Too long for a photo caption (${longest}/${limit}). Remove some products or the photo.`
    : `Too long for one message (${longest}/${limit}). Remove some products.`;
  const channel = renderChannel({ ...common, lang: p.lang, defaultFooter: footerFor(p.lang) });
  const fresh = providerFreshness(snapshot, now, settings.staleMinutes);
  return {
    snapshot, dm, channel,
    view: {
      dm: { html: dm.html, length: longest, limit, visibleItemCount: dm.visibleItemCount, sendable: blockReason === null, blockReason },
      channel,
      provider: { syncedAt: snapshot.providerSyncedAt, ...fresh, staleMinutes: settings.staleMinutes },
      missingIds: snapshot.missingIds,
    },
  };
}

const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });

/** Source spec §12.2-B: never present stale provider status without the
 * admin's explicit acknowledgement. Only matters when a provider SKU is in the
 * selection. */
function staleBlocked(r: Awaited<ReturnType<typeof render>>, raw: Record<string, unknown>): boolean {
  const hasProvider = r.snapshot.groups.some((g) => g.products.some((p) => p.items.some((i) => i.source === "PROVIDER_API")));
  return hasProvider && r.view.provider.stale && raw.ack_stale !== true;
}
const STALE_BODY = {
  code: "stale_provider",
  error: "The Digiflazz status has not been refreshed recently. Run Sync now, or confirm that you want to use the last known status.",
};
const idemKey = (raw: unknown): string | null => {
  const k = typeof raw === "string" ? raw.trim() : "";
  return /^[A-Za-z0-9_-]{8,80}$/.test(k) ? k : null;
};

export default async function broadcastPostRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/broadcast/posts/options", { preHandler: currentAdmin }, async (_req, reply) => {
    const now = new Date();
    const [cand, settings, presets, last, counts] = await Promise.all([
      listPostCandidates(prisma, now), getBroadcastPostSettings(prisma), listPresets(prisma), lastPostForReuse(prisma),
      Promise.all(BROADCAST_SEGMENTS.map(async (s) => [s, await countSegment(prisma, s)] as const)),
    ]);
    const products = cand.snapshot.groups.flatMap((g) => g.products.map((p) => ({
      productId: p.productId, name: p.name, icon: p.icon, group: g.group, categoryId: cand.productCategory[p.productId] ?? null,
      items: p.items.map((i) => ({ denominationId: i.denominationId, name: i.name, status: i.status, source: i.source })),
    })));
    return reply.send({
      products, categories: cand.categories,
      provider: { syncedAt: cand.snapshot.providerSyncedAt, ...providerFreshness(cand.snapshot, now, settings.staleMinutes), staleMinutes: settings.staleMinutes },
      presets: presets.map((p) => ({ id: p.id, name: p.name, denominationIds: p.denominationIds })),
      last: last ? { type: last.type, items: last.items, createdAt: localize(last.createdAt, "HH.mm"), adminName: last.adminName } : null,
      segments: BROADCAST_SEGMENTS, counts: Object.fromEntries(counts),
      defaults: { footerId: settings.footerId, footerEn: settings.footerEn },
    });
  });

  app.post("/api/broadcast/posts/preview", { preHandler: csrfProtect }, async (req, reply) => {
    const p = parseBody(req.body);
    if ("error" in p) return bad(reply, p.error);
    const hasImage = (req.body as Record<string, unknown>)?.has_image === true;
    return reply.send((await render(p, hasImage)).view);
  });

  app.post("/api/broadcast/posts/copy", { preHandler: csrfProtect }, async (req, reply) => {
    const p = parseBody(req.body);
    if ("error" in p) return bad(reply, p.error);
    const key = idemKey((req.body as Record<string, unknown>)?.idempotency_key);
    if (!key) return bad(reply, "Missing request key — reload the page and try again.");
    const r = await render(p, false);
    if (staleBlocked(r, (req.body ?? {}) as Record<string, unknown>)) return reply.code(409).send(STALE_BODY);
    const out = await createCopiedPost(prisma, {
      type: p.type, language: p.lang, fields: p.fields, items: p.items, snapshot: r.snapshot, idempotencyKey: key, createdById: req.admin!.userId,
    });
    if (!out.reused) {
      await logAdminAction(prisma, {
        adminId: req.admin!.userId, action: "broadcast_post_copy", targetType: "broadcast_post", targetId: out.postId,
        details: `Copied a ${TYPE_NOUN[p.type]} post with ${p.items.length} product(s) for the channel.`,
      });
    }
    return reply.send({ ...out, parts: r.channel.parts });
  });

  app.post("/api/broadcast/posts/send", { preHandler: csrfProtect }, async (req, reply) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const p = parseBody(raw);
    if ("error" in p) return bad(reply, p.error);
    const key = idemKey(raw.idempotency_key);
    if (!key) return bad(reply, "Missing request key — reload the page and try again.");
    const segment = String(raw.segment ?? "").toUpperCase();
    if (!isBroadcastSegment(segment)) return bad(reply, "Pick a valid segment.");
    const image = await checkBroadcastImage(String(raw.image_url ?? ""));
    if (image && "error" in image) return bad(reply, image.error);
    let scheduledAt: Date | null = null;
    const sched = String(raw.scheduled_at ?? "").trim();
    if (sched) {
      const d = new Date(sched);
      if (Number.isNaN(d.getTime())) return bad(reply, "Invalid schedule time.");
      scheduledAt = d;
    }
    const r = await render(p, image !== null);
    if (!r.view.dm.sendable) return bad(reply, r.view.dm.blockReason!);
    if (staleBlocked(r, raw)) return reply.code(409).send(STALE_BODY);
    const total = await countSegment(prisma, segment);
    const out = await createQueuedPost(prisma, {
      type: p.type, language: p.lang, fields: p.fields, items: p.items, snapshot: r.snapshot, idempotencyKey: key,
      createdById: req.admin!.userId, message: r.dm.html, segment, scheduledAt, total, webImageUrl: image?.url ?? null,
    });
    if (!out.reused) {
      await logAdminAction(prisma, {
        adminId: req.admin!.userId, action: "broadcast_post_send", targetType: "broadcast", targetId: out.broadcastId,
        details: `${scheduledAt ? `Scheduled for ${localize(scheduledAt)}` : "Queued"} a ${TYPE_NOUN[p.type]} broadcast with ${p.items.length} product(s) to ${total} recipient(s) in segment "${segment}"; stock status is checked again when it is sent.`,
      });
    }
    return reply.code(201).send({ ...out, total });
  });

  app.get("/api/broadcast/posts/history", { preHandler: currentAdmin }, async (_req, reply) => {
    const rows = await listPostHistory(prisma);
    return reply.send({ history: rows.map((r) => ({ ...r, createdAtDisplay: localize(r.createdAt) })) });
  });

  app.post("/api/broadcast/posts/presets", { preHandler: csrfProtect }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? "").trim().slice(0, 60);
    if (!name) return bad(reply, "Give the preset a name.");
    const ids = Array.isArray(b.denomination_ids) ? b.denomination_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) return bad(reply, "Pick at least one product before saving a preset.");
    const preset = await savePreset(prisma, { name, denominationIds: ids.slice(0, MAX_ITEMS), createdById: req.admin!.userId });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId, action: "broadcast_preset_save", targetType: "broadcast_preset", targetId: preset.id,
      details: `Saved the broadcast preset "${name}" with ${preset.denominationIds.length} product(s).`,
    });
    return reply.send({ preset });
  });

  app.post("/api/broadcast/posts/presets/:id/delete", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return bad(reply, "Invalid preset.");
    if (!(await deletePreset(prisma, id))) return reply.code(404).send({ error: "That preset no longer exists." });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId, action: "broadcast_preset_delete", targetType: "broadcast_preset", targetId: id,
      details: "Deleted a broadcast preset.",
    });
    return reply.send({ ok: true });
  });
}
```

Register it in `apps/web-admin/src/server.ts`: `import broadcastPostRoutes from "./routes/api/broadcastPosts";` and `await app.register(broadcastPostRoutes);` right after `broadcastApiRoutes`.

Checks for the implementer:
- `csrfProtect` must also resolve the admin. In `broadcast.ts`, `req.admin!` is used after `csrfProtect` alone, so the same pattern works here.
- If the `@app/db` barrel does not re-export `prisma`, import it the way `broadcast.ts` does.

- [ ] **Step 5: Settings keys.** In `apps/web-admin/src/routes/api/settings.ts` `EDITABLE`, add next to `support_contact`:

```ts
  broadcast_footer_id: "Default footer for product broadcasts (Indonesian)",
  broadcast_footer_en: "Default footer for product broadcasts (English)",
  broadcast_stale_minutes: "Warn that Digiflazz status is stale after (minutes, default 90)",
```

These are free-text fields, the same shape as `fx_quote_ttl_minutes`. `getBroadcastPostSettings` already treats junk as the default. Run the existing settings test: `pnpm exec vitest run apps/web-admin/test/settings*.test.ts`. If a test pins the `EDITABLE` key list, add the three keys there.

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run apps/web-admin/test/broadcastPosts.test.ts apps/web-admin/test/broadcast.test.ts`, then `pnpm --filter @app/web-admin typecheck`.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web-admin/src/lib/broadcastImage.ts apps/web-admin/src/routes/api/broadcast.ts apps/web-admin/src/routes/api/broadcastPosts.ts apps/web-admin/src/server.ts apps/web-admin/src/routes/api/settings.ts apps/web-admin/test/broadcastPosts.test.ts
git commit -m "feat(web-admin): broadcast generator API (options, preview, copy, send, presets, history)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Generator tab UI

**Files:**
- Create: `apps/web-admin/client/src/pages/broadcast/generatorTypes.ts` (client-side mirror of the API shapes; the client may not import `@app/core`)
- Create: `apps/web-admin/client/src/pages/broadcast/GeneratorTab.tsx` (state owner: type, selection, fields, language, preview query)
- Create: `apps/web-admin/client/src/pages/broadcast/ItemPicker.tsx` (presets, "same as last", search/group/category filters, product → denomination tree, per-row "Mark sold out" and NEW/BACK label, stale banner + Sync now)
- Create: `apps/web-admin/client/src/pages/broadcast/PostPreview.tsx` (DM | Channel toggle, counter, copy buttons with clipboard fallback)
- Create: `apps/web-admin/client/src/pages/broadcast/SendDialog.tsx` (segment + counts, schedule, photo via `ImageUploadField`, stale banner, `ConfirmDialog`)
- Create: `apps/web-admin/client/src/pages/broadcast/PostHistory.tsx` (history table, snapshot planned vs sent, "Use again")
- Create: `apps/web-admin/client/src/pages/broadcast/GeneratorTab.test.tsx`
- Modify: `apps/web-admin/client/src/pages/BroadcastPage.tsx`: wrap the existing content in `Tabs` ("Send message" | "Build from products"), and replace the `Restock` and `Maintenance` entries of `TEMPLATES` with a link that switches to the new tab
- Modify: `apps/web-admin/client/src/pages/SettingsPage.tsx`: add the three keys to `TELEGRAM_KEYS` and `FIELD_DESCRIPTIONS`
- Modify: `apps/web-admin/client/src/App.tsx`: add the `/broadcast/generator` and `/broadcast/history` routes

**Interfaces:**
- Consumes: the Task 5 HTTP API; `apiGet`, `apiPost` from `../../api/client`; shadcn `Tabs`, `Button`, `Checkbox`, `Input`, `Textarea`, `Select`, `Dialog`; `ConfirmDialog`, `ImageUploadField`, `DataTable`, `EmptyState`, `StatusBadge`; `toast` from `sonner`; `describeError` from `../../lib/errorMessages`.
- Produces: `export function GeneratorTab({ onUseAgain }: {...})` rendered by `BroadcastPage`.

**Before writing UI code**, invoke the `ui-development-dispatch` and `web-fastify-conventions` skills. Read `BroadcastPage.tsx` fully (shadcn usage, `TelegramPreview`, `ConfirmDialog` usage ~487-500, `ImageUploadField`) and match its patterns. Note `project_appcss_beats_tailwind_utilities`: `.field`/`.card`/`.btn` shorthands beat Tailwind utilities at equal specificity.

- [ ] **Step 1: Write the failing UI tests** `GeneratorTab.test.tsx`. Use the `Wrapper` from `BroadcastPage.test.tsx` and mock `apiGet`/`apiPost` (`vi.mock("../../api/client")`).

```tsx
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import * as client from "../../api/client";
import { GeneratorTab } from "./GeneratorTab";

vi.mock("../../api/client", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const OPTIONS = {
  products: [
    { productId: 1, name: "Netflix Premium", icon: "🎬", group: "PREMIUM_APPS", categoryId: 7, items: [
      { denominationId: 10, name: "1 Bulan Sharing", status: "AVAILABLE", source: "MANUAL" },
      { denominationId: 11, name: "1 Bulan Private", status: "SOLD_OUT", source: "INTERNAL_INVENTORY" },
    ] },
    { productId: 3, name: "Mobile Legends", icon: "🎮", group: "GAME_TOPUP", categoryId: 8, items: [
      { denominationId: 31, name: "172 Diamonds", status: "OUTAGE", source: "PROVIDER_API" },
      { denominationId: 32, name: "Old SKU", status: "INACTIVE", source: "PROVIDER_API" },
    ] },
  ],
  categories: [{ id: 7, name: "Streaming", group: "PREMIUM_APPS" }, { id: 8, name: "MLBB", group: "GAME_TOPUP" }],
  provider: { syncedAt: "2026-11-01T05:00:00.000Z", ageMinutes: 120, stale: true, reason: "old", staleMinutes: 90 },
  presets: [{ id: 5, name: "Harian", denominationIds: [10, 32] }],
  last: { type: "STOCK_UPDATE", items: [{ denominationId: 11 }], createdAt: "13.05", adminName: "Ilham" },
  segments: ["ALL", "RESELLERS", "RECENT_BUYERS"], counts: { ALL: 120, RESELLERS: 4, RECENT_BUYERS: 30 },
  defaults: { footerId: "CS: @tokocs", footerEn: null },
};
const PREVIEW_OK = {
  dm: { html: "📦 <b>UPDATE STOK</b>", length: 640, limit: 4000, visibleItemCount: 1, sendable: true, blockReason: null },
  channel: { parts: [{ html: "<b>UPDATE STOK</b>", plain: "UPDATE STOK", length: 300 }] },
  provider: OPTIONS.provider, missingIds: [],
};

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><GeneratorTab /><Toaster /></QueryClientProvider></MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(client.apiGet).mockImplementation(async (url: string) => (url.includes("history") ? { history: [] } : OPTIONS) as never);
  vi.mocked(client.apiPost).mockImplementation(async (url: string) => (url.includes("preview") ? PREVIEW_OK : { postId: 1, reused: false, parts: PREVIEW_OK.channel.parts }) as never);
});

describe("GeneratorTab", () => {
  it("shows the stale Digiflazz banner with a sync button", async () => {
    renderTab();
    expect(await screen.findByText(/120 min/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
  });

  it("restock defaults select only available items; outage defaults select only disrupted items", async () => {
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: /restock/i }));
    expect(screen.getByRole("checkbox", { name: /1 Bulan Sharing/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /1 Bulan Private/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: /disruption/i }));
    expect(screen.getByRole("checkbox", { name: /172 Diamonds/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /1 Bulan Sharing/ })).not.toBeChecked();
  });

  it("a preset never auto-checks an inactive item", async () => {
    renderTab();
    await userEvent.click(await screen.findByRole("combobox", { name: /preset/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Harian" }));
    expect(screen.getByRole("checkbox", { name: /1 Bulan Sharing/ })).toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: /show inactive/i }));
    expect(screen.getByRole("checkbox", { name: /Old SKU/ })).not.toBeChecked();
  });

  it("'Same as last' says what it reuses and applies it", async () => {
    renderTab();
    const btn = await screen.findByRole("button", { name: /same as last.*13\.05.*Ilham/i });
    await userEvent.click(btn);
    expect(screen.getByRole("checkbox", { name: /1 Bulan Private/ })).toBeChecked();
  });

  it("disables Send with the server's reason", async () => {
    vi.mocked(client.apiPost).mockImplementation(async () => ({ ...PREVIEW_OK, dm: { ...PREVIEW_OK.dm, sendable: false, blockReason: "No product is available to send right now" } }) as never);
    renderTab();
    await userEvent.click(await screen.findByRole("checkbox", { name: /1 Bulan Private/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /send via bot/i })).toBeDisabled());
    expect(screen.getByText(/No product is available/)).toBeInTheDocument();
  });

  it("falls back to a selectable text box when the clipboard is unavailable", async () => {
    Object.assign(navigator, { clipboard: { write: vi.fn().mockRejectedValue(new Error("denied")), writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    renderTab();
    await userEvent.click(await screen.findByRole("checkbox", { name: /1 Bulan Sharing/ }));
    await userEvent.click(await screen.findByRole("button", { name: /copy for channel/i }));
    expect(await screen.findByRole("textbox", { name: /copy manually/i })).toHaveValue("UPDATE STOK");
  });

  it("filters by source and status, hides inactive by default, and summarises the selection", async () => {
    renderTab();
    expect(await screen.findByText("1 Bulan Sharing")).toBeInTheDocument();
    expect(screen.queryByText("Old SKU")).not.toBeInTheDocument(); // inactive hidden by default
    await userEvent.click(screen.getByRole("switch", { name: /show inactive/i }));
    expect(screen.getByText("Old SKU")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /digiflazz/i }));
    expect(screen.queryByText("1 Bulan Sharing")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /select all results/i }));
    expect(screen.getByText(/1 selected · 0 Premium · 1 Game · 1 Digiflazz/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /clear selection/i }));
    expect(screen.getByText(/0 selected/)).toBeInTheDocument();
  });

  it("requires the stale acknowledgement before copying a Digiflazz item", async () => {
    renderTab();
    await userEvent.click(await screen.findByRole("checkbox", { name: /172 Diamonds/ }));
    const copy = await screen.findByRole("button", { name: /copy for channel/i });
    expect(copy).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /I understand the Digiflazz status/i }));
    expect(copy).toBeEnabled();
    expect(screen.getByRole("link", { name: /view digiflazz status/i })).toHaveAttribute("href", "/catalog/digiflazz-sync");
  });

  it("requires the note field for a disruption post", async () => {
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: /disruption/i }));
    expect(screen.getByRole("textbox", { name: /note/i })).toBeRequired();
  });
});
```

Also add one test to `BroadcastPage.test.tsx`: the "Restock" and "Maintenance" quick templates are gone, and a "Build from products" tab is present.

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm exec vitest run apps/web-admin/client/src/pages/broadcast/GeneratorTab.test.tsx apps/web-admin/client/src/pages/BroadcastPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `generatorTypes.ts`**

```ts
export type PostType = "STOCK_UPDATE" | "RESTOCK" | "OUTAGE" | "RESTORED" | "ANNOUNCEMENT";
export type ItemStatus = "AVAILABLE" | "SOLD_OUT" | "OUTAGE" | "INACTIVE" | "GONE";
export interface OptionItem { denominationId: number; name: string; status: ItemStatus; source: "INTERNAL_INVENTORY" | "PROVIDER_API" | "MANUAL" }
export interface OptionProduct { productId: number; name: string; icon: string; group: "PREMIUM_APPS" | "GAME_TOPUP"; categoryId: number | null; items: OptionItem[] }
export interface ProviderState { syncedAt: string | null; ageMinutes: number | null; stale: boolean; reason: "never" | "last_run_failed" | "old" | null; staleMinutes: number }
export interface GeneratorOptions {
  products: OptionProduct[];
  categories: { id: number; name: string; group: string }[];
  provider: ProviderState;
  presets: { id: number; name: string; denominationIds: number[] }[];
  last: { type: PostType; items: { denominationId: number }[]; createdAt: string; adminName: string | null } | null;
  segments: string[];
  counts: Record<string, number>;
  defaults: { footerId: string | null; footerEn: string | null };
}
export interface SelectedItem { denominationId: number; markSoldOut?: boolean; label?: "NEW" | "BACK" | null }
export interface PreviewResponse {
  dm: { html: string; length: number; limit: number; visibleItemCount: number; sendable: boolean; blockReason: string | null };
  channel: { parts: { html: string; plain: string; length: number }[] };
  provider: ProviderState;
  missingIds: number[];
}

export const TYPE_LABEL: Record<PostType, string> = {
  STOCK_UPDATE: "Stock update", RESTOCK: "Restock / New", OUTAGE: "Disruption", RESTORED: "Service restored", ANNOUNCEMENT: "Announcement",
};
export const NEEDS_DETAILS: PostType[] = ["OUTAGE", "RESTORED"];

/** Which statuses a type pre-selects when the admin switches to it. */
export function defaultSelection(type: PostType, products: OptionProduct[], current: SelectedItem[]): SelectedItem[] {
  const pick = (s: ItemStatus[]) => products.flatMap((p) => p.items.filter((i) => s.includes(i.status)).map((i) => ({ denominationId: i.denominationId })));
  if (type === "RESTOCK") return pick(["AVAILABLE"]);
  if (type === "OUTAGE") return pick(["OUTAGE"]);
  if (type === "RESTORED") return products.flatMap((p) => p.items.filter((i) => i.status === "AVAILABLE" && i.source === "PROVIDER_API").map((i) => ({ denominationId: i.denominationId })));
  return current;
}

/** Preset/"same as last" ids → selection, never auto-checking INACTIVE/GONE items. */
export function selectionFromIds(ids: number[], products: OptionProduct[]): SelectedItem[] {
  const ok = new Set(products.flatMap((p) => p.items.filter((i) => i.status !== "INACTIVE" && i.status !== "GONE").map((i) => i.denominationId)));
  return ids.filter((id) => ok.has(id)).map((denominationId) => ({ denominationId }));
}

export const STATUS_TEXT: Record<ItemStatus, string> = {
  AVAILABLE: "✅ Available", SOLD_OUT: "⛔ Sold out", OUTAGE: "🔧 Disrupted", INACTIVE: "⚪ Inactive", GONE: "Removed",
};
```

- [ ] **Step 4: Implement the components.** Required behaviour (the tests pin the key parts). Follow `BroadcastPage.tsx` for imports and styling.
  - **`GeneratorTab`** holds `type`, `selected: SelectedItem[]`, `fields {title,intro,details,footer}`, `language "id"|"en"`, `previewTarget "dm"|"channel"` and `hasImage`. It loads `apiGet<GeneratorOptions>("/api/broadcast/posts/options")` through `useQuery(["broadcast-posts","options"])`.
    - **Type buttons:** a row of 5 buttons labelled from `TYPE_LABEL`. Clicking one sets the type and applies `defaultSelection`.
    - **Preview:** a `useQuery(["broadcast-posts","preview", payload])` with the payload debounced 400 ms (`useDeferredValue` or a small debounce hook) calls `apiPost<PreviewResponse>("/api/broadcast/posts/preview", payload)`. It is enabled only when `selected.length > 0 || type === "ANNOUNCEMENT"`.
    - **Idempotency key:** one `crypto.randomUUID().replace(/-/g, "")` held in `useState`, regenerated after a successful send, and when type, selection or fields change after a copy.
    - **Layout:** on desktop (`lg:` grid) the preview sits in a right column. On mobile, a sticky bottom bar shows `{n} items · {length} chars · [Preview]`, which opens the preview in a `Dialog`.
  - **`ItemPicker`**:
    - **Preset `Select`** (accessible name "Preset"). Choosing a preset applies `selectionFromIds`.
    - **"Same as last" button**, shown only when `last` exists. Its label is ``Same as last (${TYPE_LABEL[last.type]}, ${last.createdAt} by ${last.adminName ?? "admin"})``. Clicking it sets the type and the selection from `last.items`.
    - **"+ Save preset"** opens a small dialog for the name, then `POST /presets` and invalidates `options`. Saving is disabled while nothing is selected.
    - **Filters:**
      - search input
      - group segmented control (All / Premium Apps / Game Top Up)
      - **Source** segmented control (All / Local stock / Manual / Digiflazz), mapping `INTERNAL_INVENTORY` / `MANUAL` / `PROVIDER_API`
      - **Status** segmented control (All / ✅ / ⛔ / 🔧)
      - category `Select`
      - **Show inactive** switch, off by default, which hides INACTIVE rows
    - **Selection actions:**
      - **Select all results** adds every non-INACTIVE/GONE item that matches the filters.
      - **Clear selection** empties the selection.
      - A summary line reads `12 selected · 8 Premium · 4 Game · 3 Digiflazz`.
    - **Row labels:** every denomination row shows its source label (Local stock / Manual / Digiflazz). Digiflazz rows also show `data {ageMinutes} min old` from `provider.ageMinutes`.
    - **Tree:** each product row has a tri-state checkbox (all/none/some of its non-inactive items) and is expandable. Each denomination row has a checkbox whose accessible name is its name, the `STATUS_TEXT` badge, and:
      - for `AVAILABLE` items, a small "Mark sold out" toggle that sets `markSoldOut`;
      - for `RESTOCK`, a NEW/BACK toggle.

      INACTIVE rows are greyed. Checking one manually shows an inline note that it will not appear in the message.
    - **Stale banner:** when `provider.stale`, a yellow `Alert` shows "Digiflazz status as of HH.mm ({ageMinutes} min ago)", "Last sync failed", or "Never synced". It has a **Sync now** button that calls `apiPost("/api/catalog/digiflazz/sync/run")`, toasts the server's error text on failure, and invalidates `options` + `preview` on success. Next to it sits a link **View Digiflazz status →** to `/catalog/digiflazz-sync`.
    - **Stale acknowledgement:** when `provider.stale` and the selection contains a Digiflazz item, both the copy area and the send dialog show a required checkbox, "I understand the Digiflazz status has not been refreshed". Copy and Send stay disabled until it is ticked, and the requests send `ack_stale: true`. A 409 `stale_provider` response re-shows the checkbox with the server's message.
  - **Fields:** Title, Intro and Footer (prefilled placeholder from `defaults.footerId`/`footerEn` by language), plus Note (accessible name "Note (Keterangan)", `required` when `NEEDS_DETAILS.includes(type)`), and a language toggle (ID | EN).
  - **`PostPreview`**:
    - DM | Channel toggle. The counter reads `{length} / {limit}`.
    - The preview body shows text from the server's HTML **converted to plain text**, with `<b>` rendered as bold through a tiny safe converter that only maps `<b>…</b>`. Never use `dangerouslySetInnerHTML` with server text.
    - **Send via bot…** is disabled when `!dm.sendable`, and the `blockReason` text is shown under it.
    - **Copy for channel:** one button per part ("Copy part 1/2"…). It writes `new ClipboardItem({ "text/html": new Blob([html], {type:"text/html"}), "text/plain": new Blob([plain], {type:"text/plain"}) })` with a `navigator.clipboard.write` → `writeText(plain)` fallback chain. If both fail, it shows a read-only `Textarea` (accessible name "Copy manually") with the plain text pre-selected and the hint "Long-press → Copy".
    - After the first successful copy it calls `POST /copy` (same idempotency key), so repeats are not re-recorded. Each part shows a persistent "Copied ✓".
  - **`SendDialog`**:
    - Segment `Select` showing `ALL (120)`-style counts, as in the existing page.
    - Optional schedule `datetime-local`. When set, it shows "Stock status is refreshed automatically when it is sent."
    - `ImageUploadField`. Setting an image flips `hasImage`, so the preview re-validates the caption limit.
    - The stale banner is repeated in the dialog.
    - Confirm goes through `ConfirmDialog` with the recipient count and "This cannot be undone once it starts sending". It then calls `POST /send`. On 201 it toasts "Queued", resets the idempotency key and invalidates `history` and the existing `["broadcast"]` query, so the old history table updates too.
  - **`PostHistory`**:
    - A table with time, type, admin, action ("Copied" or "Sent #id" + status badge), and buttons "View snapshot" and "Use again".
    - "View snapshot" opens a dialog listing planned vs sent items. Items present in planned but missing from sent are marked "dropped at send time (sold out)".
    - "Use again" calls the parent to set the type and selection.
  - **`BroadcastPage`** wraps the existing card and history in `<Tabs>` with **URL-backed** tabs:
    - `/broadcast`: "Send message", the existing content
    - `/broadcast/generator`: "Build from products", renders `<GeneratorTab />`
    - `/broadcast/history`: "Product broadcast history", renders `<PostHistory />`

    Add the two routes in `apps/web-admin/client/src/App.tsx` next to `/broadcast`, all rendering `BroadcastPage`. Derive the active tab from `useLocation().pathname` and switch with `navigate()`. Make sure the sidebar's `/broadcast` item stays highlighted on the sub-paths: check how `Sidebar.tsx` decides "active" (the `end` flag) and keep it non-`end`. "Use again" in history navigates to `/broadcast/generator` with the selection passed via router state. Remove `Restock` and `Maintenance` from `TEMPLATES`, and put a small link button "Build a restock or disruption post from products →" under the template picker that switches the tab.
  - **`SettingsPage`:** add `broadcast_footer_id`, `broadcast_footer_en` and `broadcast_stale_minutes` to `TELEGRAM_KEYS`, and give `FIELD_DESCRIPTIONS` a plain sentence for each, for example `broadcast_stale_minutes: "How old the Digiflazz status may be before the broadcast builder shows a warning. Default 90 minutes; the catalog sync runs hourly."`

- [ ] **Step 5: Run tests, typecheck and doctor on the changed files**

Run:
```
pnpm exec vitest run apps/web-admin/client/src/pages/broadcast apps/web-admin/client/src/pages/BroadcastPage.test.tsx apps/web-admin/client/src/pages/SettingsPage.test.tsx
pnpm --filter @app/web-admin-client typecheck
pnpm run check-frontend-boundaries
pnpm doctor:changed
```
Expected: tests PASS, typecheck clean, boundaries OK, doctor 0 errors / 0 warnings on the changed files. Fix causes; never suppress.

- [ ] **Step 6: Commit**

```bash
git add apps/web-admin/client/src/pages/broadcast/generatorTypes.ts apps/web-admin/client/src/pages/broadcast/GeneratorTab.tsx apps/web-admin/client/src/pages/broadcast/ItemPicker.tsx apps/web-admin/client/src/pages/broadcast/PostPreview.tsx apps/web-admin/client/src/pages/broadcast/SendDialog.tsx apps/web-admin/client/src/pages/broadcast/PostHistory.tsx apps/web-admin/client/src/pages/broadcast/GeneratorTab.test.tsx apps/web-admin/client/src/pages/BroadcastPage.tsx apps/web-admin/client/src/pages/BroadcastPage.test.tsx apps/web-admin/client/src/pages/SettingsPage.tsx apps/web-admin/client/src/App.tsx
git commit -m "feat(web-admin): Build from products tab for stock and service broadcasts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification gate + report

**Files:**
- Modify: `docs/REACT_DOCTOR_PHASE_1_REPORT.md` (append the final clean full-scan result)

- [ ] **Step 1: Sync with master.** `git fetch` (if a remote is configured), then `git rebase master` inside this worktree. The branch is unpushed, so a rebase is allowed. Resolve any conflicts here. After the rebase: `CI=true pnpm install`, `pnpm prisma:generate`, `pnpm -r build`, `pnpm exec prisma db push --skip-generate` (worktree DB only).
- [ ] **Step 2: Full gate.** Check free memory first; another session may be running a full suite.
```
pnpm typecheck && pnpm test
pnpm doctor:bugs
pnpm doctor:full
pnpm lint
```
Expected: all green, and `doctor:full` reports **0 errors and 0 warnings**. If a file fails only in the full run, re-run it alone before treating it as a regression.
- [ ] **Step 3: Record and commit.** Append a dated "Broadcast generator" section to `docs/REACT_DOCTOR_PHASE_1_REPORT.md` with the exact `doctor:full` summary line and the test totals.
```bash
git add docs/REACT_DOCTOR_PHASE_1_REPORT.md
git commit -m "docs: record the final gate for the broadcast generator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Deploy notes (for the merge, not a task)

1. Apply migration `20261101120000_broadcast_posts` to the live DB **before** the new order-bot runs (`P2022` otherwise).
2. Release order-bot and web-admin together.
3. Fill `broadcast_footer_id` / `broadcast_footer_en` in Settings.
