# Digiflazz Catalog Auto-Sync (Import Wizard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin bulk-create Top Up Game catalog entries from Digiflazz's own price list (grouped by game/brand, reviewed before going live) instead of hand-typing every Supplier SKU, and keep already-imported items' price/status current on a recurring schedule without ever overwriting a hand-edited price.

**Architecture:** A "preview then apply" wizard — mirroring the existing CSV catalog-import pattern already in this codebase (`apps/web-admin/src/routes/api/catalog.ts`'s `/api/catalog/products/import` + `/import/apply`) — fetches Digiflazz's price list, groups it by the `brand` field, and lets the admin bulk-create Products/Denominations from selected brands in one transaction. A separate hourly cron job re-syncs price/status on everything already imported, skipping any row the admin has hand-edited.

**Tech Stack:** Fastify (admin API), Prisma/SQLite, React + TanStack Query + shadcn/ui (admin client), Vitest, `croner` (cron).

## Global Constraints

- Decimal for all money (`@app/core/money`), never `float` — every price value (Digiflazz's raw `price`, computed sell price, `costPrice`) stays `Decimal` end to end.
- No raw SQL in routes/handlers — all DB access goes through `packages/db/src/crud/*` helpers.
- Shared SQLite is single-writer — keep every `$transaction` short; a Digiflazz HTTP call never happens inside an open `$transaction`.
- Audit every state change with `logAdminAction`.
- Never send Telegram directly from web/db code — not applicable to this plan (no buyer-facing notification here); if it were, it would go through `notification_outbox`.
- Never log secrets — the Digiflazz API key must never appear in a thrown `Error` or a log line.
- Follow this codebase's existing admin UI conventions: hand-rolled `useState` forms (no React Hook Form / Zod on the client), TanStack Query mutations, shadcn/ui components, `text-rust` inline errors.

## Context carried in from prior work (already done, do not redo)

- **Task 1 of the original plan** (`prisma/schema.prisma` fields `Denomination.supplierSku`/`autoDeliverySource`, `Category.checkoutFlow`, `Order.digiflazzDispatchedAt`; `packages/core/src/suppliers/digiflazz.ts` — `getPriceList`, `createTransaction`, `verifyCallback`) is complete and committed (`4e77974`) on branch `worktree-storefront-topup-game`.
- **`packages/db/src/crud/digiflazz.ts`** already has a substantially complete implementation from an interrupted session: `getDigiflazzCreds`, `buildDigiflazzCustomerNo`, `dispatchPendingDigiflazzOrders`, `fulfillDigiflazzOrder` — all present, uncommitted. `packages/db/src/crud/orders.ts:1649` already has the one-line `export` fix on `finalizeDeliverySideEffects` these depend on. **Task 1 below finishes this (tests + verify + commit) before any new code is added to the same file.**
- **Confirmed Digiflazz price-list field names** (from `developer.digiflazz.com/api/buyer/daftar-harga/`, already reflected in `packages/core/src/suppliers/digiflazz.ts`'s `DigiflazzPriceListItem`): `buyerSkuCode`, `productName`, `category`, `brand`, `type`, `price` (`Decimal`), `buyerProductStatus`, `sellerProductStatus`, `stock`.
- **Scope note for later:** the original approved plan's Task 5 ("Category checkout-flow toggle + Digiflazz Settings credentials card") had the Digiflazz-credentials half superseded by this plan's Task 3 below — when Task 5 eventually runs, it only needs to add the Category checkout-flow toggle, not credentials (already done here).

---

### Task 1: Finish, test, and commit the existing Digiflazz db crud (creds/poller/fulfillment)

**Files:**
- Modify (verify only, already correct): `packages/db/src/crud/orders.ts:1649` (the `export` keyword on `finalizeDeliverySideEffects`)
- Modify (verify only, already substantially complete): `packages/db/src/crud/digiflazz.ts`
- Test: `packages/db/src/crud/digiflazz.test.ts` (new)

**Interfaces:**
- Consumes: `getPriceList`, `createTransaction`, `DigiflazzCreds` from `@app/core/suppliers/digiflazz` (Task 1 of the original plan, already built).
- Produces (already implemented, confirm signatures while writing tests):
  - `getDigiflazzCreds(db: Db): Promise<DigiflazzCreds | null>`
  - `buildDigiflazzCustomerNo(product: { additionalFields: string | null }, customerDataJson: string | null): string`
  - `dispatchPendingDigiflazzOrders(db: PrismaClient): Promise<DigiflazzDispatchSummary>` where `DigiflazzDispatchSummary = { claimed: number; delivered: number; pending: number; failed: number }`
  - `fulfillDigiflazzOrder(db: Db, orderId: number, args: { sn: string }): Promise<{ order: OrderWithIncludes }>`
  - Setting key constants: `DIGIFLAZZ_USERNAME_KEY`, `DIGIFLAZZ_API_KEY_KEY`, `DIGIFLAZZ_ENABLED_KEY`

- [ ] **Step 1: Read the current file end to end**

Read `packages/db/src/crud/digiflazz.ts` and `packages/db/src/crud/orders.ts:1640-1660` in full. Confirm: `finalizeDeliverySideEffects` is exported (it is — one-word diff already applied); `getDigiflazzCreds`/`buildDigiflazzCustomerNo`/`dispatchPendingDigiflazzOrders`/`fulfillDigiflazzOrder` all exist with the signatures above. If anything is missing or diverges from these signatures, stop and report — do not silently rewrite the file's approach.

- [ ] **Step 2: Write `packages/db/src/crud/digiflazz.test.ts`**

```typescript
/**
 * Tests for the Digiflazz dispatch poller and auto-fulfillment path —
 * getDigiflazzCreds, buildDigiflazzCustomerNo, dispatchPendingDigiflazzOrders,
 * fulfillDigiflazzOrder. Follows crud/tokopay.test.ts's makeTestDb +
 * buildSampleData shape; mocks @app/core/suppliers/digiflazz's
 * createTransaction since this file never makes a real HTTP call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const digiflazzMock = vi.hoisted(() => ({
  createTransaction: vi.fn(),
}));
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()),
  createTransaction: digiflazzMock.createTransaction,
}));

import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  setSetting,
  deleteSetting,
  getOrder,
  upsertUser,
} from "@app/db";
import {
  getDigiflazzCreds,
  buildDigiflazzCustomerNo,
  dispatchPendingDigiflazzOrders,
  fulfillDigiflazzOrder,
  DIGIFLAZZ_USERNAME_KEY,
  DIGIFLAZZ_API_KEY_KEY,
  DIGIFLAZZ_ENABLED_KEY,
} from "@app/db";
import { OrderStatus, DeliveryType } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  digiflazzMock.createTransaction.mockReset();
  await setSetting(prisma, DIGIFLAZZ_USERNAME_KEY, "shopuser");
  await setSetting(prisma, DIGIFLAZZ_API_KEY_KEY, "shopkey");
});

/** Flip the sample denomination into a Digiflazz-mapped, manual_with_info SKU
 * and place a PROCESSING order against it — the state the poller looks for. */
async function makeProcessingDigiflazzOrder(supplierSku = "ml100") {
  await prisma.denomination.update({
    where: { id: sample.product.id },
    data: {
      autoDeliverySource: "digiflazz",
      supplierSku,
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      ]),
    },
  });
  const order = (await createOrderDirect(prisma, {
    user: sample.user,
    productId: sample.product.id,
    quantity: 1,
    customerData: JSON.stringify([{ user_id: "123456789" }]),
  }))!;
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });
  return order;
}

describe("getDigiflazzCreds", () => {
  it("returns credentials when username/apiKey are set and not disabled", async () => {
    const creds = await getDigiflazzCreds(prisma);
    expect(creds).toEqual({ username: "shopuser", apiKey: "shopkey" });
  });

  it("returns null when credentials are missing", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
    expect(await getDigiflazzCreds(prisma)).toBeNull();
  });

  it("returns null when explicitly disabled", async () => {
    await setSetting(prisma, DIGIFLAZZ_ENABLED_KEY, "false");
    expect(await getDigiflazzCreds(prisma)).toBeNull();
  });
});

describe("buildDigiflazzCustomerNo", () => {
  it("joins non-empty answers in field-definition order", () => {
    const product = {
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
        { key: "server_id", label: { id: "Server", en: "Server" }, type: "text", required: false, options: [], placeholder: "" },
      ]),
    };
    const customerData = JSON.stringify([{ user_id: "123456789", server_id: "2001" }]);
    expect(buildDigiflazzCustomerNo(product, customerData)).toBe("123456789 2001");
  });

  it("skips blank answers", () => {
    const product = {
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
        { key: "server_id", label: { id: "Server", en: "Server" }, type: "text", required: false, options: [], placeholder: "" },
      ]),
    };
    const customerData = JSON.stringify([{ user_id: "123456789", server_id: "" }]);
    expect(buildDigiflazzCustomerNo(product, customerData)).toBe("123456789");
  });
});

describe("dispatchPendingDigiflazzOrders", () => {
  it("delivers a Sukses order and flips it to DELIVERED", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Sukses",
      sn: "SN-12345",
      message: "ok",
      price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 1, pending: 0, failed: 0 });

    const refreshed = await getOrder(prisma, order.id);
    expect(refreshed!.status).toBe(OrderStatus.DELIVERED);
    expect(refreshed!.deliveredContent).toBe("SN-12345");
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("never calls Digiflazz twice for the same order (double-dispatch guard)", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Pending", sn: null, message: null, price: null,
    });

    await dispatchPendingDigiflazzOrders(prisma);
    const second = await dispatchPendingDigiflazzOrders(prisma);

    expect(second).toEqual({ claimed: 0, delivered: 0, pending: 0, failed: 0 });
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("leaves a Pending order PROCESSING with the claim set", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Pending", sn: null, message: null, price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 1, failed: 0 });

    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.status).toBe(OrderStatus.PROCESSING);
    expect(refreshed!.digiflazzDispatchedAt).not.toBeNull();
  });

  it("alerts admins and leaves PROCESSING on Gagal, without fulfilling", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Gagal", sn: null, message: "Saldo tidak cukup", price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });

    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.status).toBe(OrderStatus.PROCESSING);
    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull();
  });

  it("is a no-op when Digiflazz isn't configured", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
    await makeProcessingDigiflazzOrder();
    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 0, delivered: 0, pending: 0, failed: 0 });
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();
  });
});

describe("fulfillDigiflazzOrder", () => {
  it("delivers, records history, and audits as a system actor", async () => {
    const order = await makeProcessingDigiflazzOrder();
    const { order: delivered } = await fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-999" });
    expect(delivered.status).toBe(OrderStatus.DELIVERED);
    expect(delivered.deliveredContent).toBe("SN-999");

    const history = await prisma.orderStatusHistory.findFirst({
      where: { orderId: order.id, status: OrderStatus.DELIVERED },
    });
    expect(history).not.toBeNull();

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "order.auto_fulfill_digiflazz", targetId: order.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.adminId).toBeNull();
  });

  it("rejects a second claim on an already-delivered order", async () => {
    const order = await makeProcessingDigiflazzOrder();
    await fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-1" });
    await expect(fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-2" })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the new test file**

Run: `pnpm exec vitest run packages/db/src/crud/digiflazz.test.ts`
Expected: all tests pass. If `notificationOutbox`, `auditLog`, or `orderStatusHistory` aren't the exact Prisma model names used elsewhere in this package, fix the test to match the names `orders.test.ts`/`tokopay.test.ts` already use for the same assertions — check those files if any model name errors.

- [ ] **Step 4: Typecheck and full suite**

Run: `pnpm typecheck && pnpm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/digiflazz.ts packages/db/src/crud/digiflazz.test.ts packages/db/src/crud/orders.ts
git commit -m "feat(digiflazz): dispatch poller, auto-fulfillment, and tests (Task 2 of the original plan)"
```

---

### Task 2: Schema — `Product.digiflazzBrand`, `Denomination.priceOverridden`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_digiflazz_sync_fields/migration.sql`

**Interfaces:**
- Produces: `Product.digiflazzBrand: string | null`, `Denomination.priceOverridden: boolean` (default `false`) — consumed by Task 4's brand-matching and price-recompute logic.

- [ ] **Step 1: Add the two fields to `prisma/schema.prisma`**

In the `Product` model (`prisma/schema.prisma:177-214`), add after `imageFileId`:

```prisma
  /// The exact Digiflazz `brand` string this Product was imported from (Import
  /// Wizard). Null for hand-created products. Re-sync matching key — chosen
  /// over matching by name so the admin can rename the display name freely
  /// without breaking future syncs.
  digiflazzBrand String? @map("digiflazz_brand")
```

In the `Denomination` model (`prisma/schema.prisma:221-...`), add after `supplierSku`:

```prisma
  /// True once an admin has manually edited this SKU's price after import.
  /// The Digiflazz re-sync job (packages/db/src/crud/digiflazz.ts,
  /// resyncDigiflazzCatalog) skips price recomputation for any row where this
  /// is true, so a deliberate manual price change is never silently
  /// overwritten by the next sync tick.
  priceOverridden Boolean @default(false) @map("price_overridden")
```

- [ ] **Step 2: Hand-write the migration**

Following the exact pattern of `prisma/migrations/20260816020000_add_digiflazz_topup_fields/migration.sql` (Task 1's migration — additive `ALTER TABLE ADD COLUMN`, never a Prisma-diff rebuild, because a `NOT NULL DEFAULT` column makes Prisma's SQLite differ choose a full table rebuild otherwise), create `prisma/migrations/20260816030000_add_digiflazz_sync_fields/migration.sql`:

```sql
-- Digiflazz catalog auto-sync: two additive schema fields.
--
-- Hand-written for the same reason as 20260816020000_add_digiflazz_topup_fields
-- and 20260801000000_catchup_missing_columns_and_indexes: SQLite's own
-- `ALTER TABLE ADD COLUMN` accepts `NOT NULL DEFAULT <constant>` fine, but
-- Prisma's SQLite differ unconditionally rebuilds the table for any new
-- NOT NULL+DEFAULT column. This file produces the identical resulting schema
-- state via a plain ADD COLUMN instead.
--
-- Verify with: pnpm run check-migration-drift
--
-- SAFETY: purely additive. `products.digiflazz_brand` is a nullable ADD
-- COLUMN (every existing row gets NULL — no prior Product was
-- Digiflazz-imported). `denominations.price_overridden` is NOT NULL DEFAULT
-- 0, so every existing denomination is backfilled to "not overridden" (0 =
-- false) by the ADD COLUMN statement itself.
--
-- DEPLOY: apply with `pnpm exec prisma db push` (see docs/MIGRATIONS.md),
-- then restart order-bot/web/storefront before any code that reads/writes
-- these columns runs.

-- AlterTable: products — the Digiflazz brand string this Product was
-- imported from (Import Wizard re-sync matching key).
ALTER TABLE "products" ADD COLUMN "digiflazz_brand" TEXT;

-- AlterTable: denominations — set once an admin hand-edits price after
-- import, so the recurring re-sync job never overwrites a deliberate change.
ALTER TABLE "denominations" ADD COLUMN "price_overridden" BOOLEAN NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Verify no drift and apply**

Run: `pnpm run check-migration-drift`
Expected: "No difference detected."

Run: `pnpm exec prisma db push`
Expected: applies cleanly against this worktree's dev DB.

Run: `pnpm typecheck`
Expected: clean (generated Prisma client now exposes both new fields).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260816030000_add_digiflazz_sync_fields
git commit -m "feat(digiflazz): schema fields for catalog auto-sync (digiflazzBrand, priceOverridden)"
```

---

### Task 3: Digiflazz credentials + markup settings in admin Settings

Unblocks both this plan's wizard and the already-built dispatch poller (Task 1), which both call `getDigiflazzCreds` — neither can be exercised end-to-end without this. Supersedes the credentials half of the original plan's Task 5.

**Files:**
- Modify: `apps/web-admin/src/routes/api/settings.ts`
- Modify: `apps/web-admin/src/lib/connectionTest.ts`
- Modify: `apps/web-admin/client/src/pages/SettingsPage.tsx`
- Test: `apps/web-admin/src/routes/api/settings.test.ts` (extend existing, if present — otherwise skip a new test file; this task's server-side change is additive config, covered by the existing settings route test suite running against the new keys)

**Interfaces:**
- Produces: `Setting` rows `digiflazz_username`, `digiflazz_api_key` (secret), `digiflazz_enabled`, `digiflazz_markup_type` (`"percent" | "flat"`), `digiflazz_markup_value` (decimal string) — consumed by Task 4's price computation and already by Task 1's `getDigiflazzCreds`.

- [ ] **Step 1: Register the new EDITABLE/SECRET_KEYS entries**

In `apps/web-admin/src/routes/api/settings.ts`, add to `EDITABLE` (near the other gateway entries, alongside `bybit_api_key` etc.):

```typescript
  digiflazz_username: "Digiflazz username",
  digiflazz_api_key: "Digiflazz API key",
  digiflazz_enabled: "Digiflazz enabled",
  digiflazz_markup_type: "Digiflazz markup type (percent or flat)",
  digiflazz_markup_value: "Digiflazz markup value",
```

Add `"digiflazz_api_key"` to the `SECRET_KEYS` set (line ~111). `digiflazz_username`, `digiflazz_enabled`, `digiflazz_markup_type`, `digiflazz_markup_value` are NOT secrets — do not add them there.

- [ ] **Step 2: Add a "test connection" entry**

In `apps/web-admin/src/lib/connectionTest.ts`, add `testDigiflazz`:

```typescript
async function testDigiflazz(db: Db): Promise<TestResult> {
  const creds = await getDigiflazzCreds(db);
  if (!creds) return { ok: false, detail: "Digiflazz credentials are not set." };
  try {
    const items = await getPriceList(creds);
    return { ok: true, detail: `Connected — ${items.length} SKU(s) in the price list.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Connection failed." };
  }
}
```

Add the necessary imports at the top of the file (`getDigiflazzCreds` from `@app/db`, `getPriceList` from `@app/core/suppliers/digiflazz`), and register it in the `CONNECTION_TESTS` map: `digiflazz: testDigiflazz,`.

- [ ] **Step 3: Add a Digiflazz card to the Settings client**

In `apps/web-admin/client/src/pages/SettingsPage.tsx`, add a grouping set near `PAY_CRED_GROUPS` (`~line 101`):

```typescript
const DIGIFLAZZ_KEYS = new Set([
  "digiflazz_username",
  "digiflazz_api_key",
  "digiflazz_enabled",
  "digiflazz_markup_type",
  "digiflazz_markup_value",
]);
```

Render it as its own `Card` (same shape as the `FX_KEYS`/`SMTP_KEYS` sections — a titled `Card` containing each field's `FieldRow`, not the `GatewayCard`/`PAY_CRED_GROUPS` machinery, since Digiflazz isn't a checkout payment method and doesn't need the enable-switch-tied-to-payment-selection behavior those have). Title: "Digiflazz (Top Up Game)". Include a "Test Connection" button wired to `POST /api/settings/payments/digiflazz/test` (the existing generic test-connection route already dispatches through `CONNECTION_TESTS` by key — confirm the route's `:method` param accepts any key present in `CONNECTION_TESTS`, not just `PAY_CRED_GROUPS` methods, while implementing; if it's gated to payment methods only, widen that gate to accept any `CONNECTION_TESTS` key). For `digiflazz_markup_type`, render as a `Select` with options `"percent"`/`"flat"` rather than a free-text `Input` (matches the "Answer Type" `Select` idiom already used in `AdditionalFieldsEditor.tsx`). For `digiflazz_markup_value`, a plain numeric `Input` with helper text: "Percent (e.g. 8 for 8%) or a flat IDR amount, depending on the type above."

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: clean.

Manual check: start the admin dev server, open Settings, confirm the Digiflazz card renders, save a username/API key, click Test Connection (expect a failure detail against fake credentials — confirms the round trip works end to end without needing a real Digiflazz account yet).

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/routes/api/settings.ts apps/web-admin/src/lib/connectionTest.ts apps/web-admin/client/src/pages/SettingsPage.tsx
git commit -m "feat(digiflazz): credentials and markup-rule settings in admin"
```

---

### Task 4: Brand-grouping, matching, price computation, import, and re-sync logic

**Files:**
- Modify: `packages/db/src/crud/catalog.ts` (extend `createCatalogProduct`, `createDenomination`)
- Modify: `packages/db/src/crud/digiflazz.ts` (add sync functions)
- Test: `packages/db/src/crud/digiflazz.test.ts` (extend)

**Interfaces:**
- Consumes: `getPriceList`, `DigiflazzPriceListItem` from `@app/core/suppliers/digiflazz`; `getDigiflazzCreds`, `DIGIFLAZZ_*_KEY` from this same file (Task 1); `getSetting` from `./settings`.
- Produces (consumed by Task 5's routes):
  - `interface DigiflazzBrandGroup { brand: string; items: DigiflazzPriceListItem[]; existingProductId: number | null }`
  - `groupDigiflazzPriceListByBrand(db: Db, items: DigiflazzPriceListItem[]): Promise<DigiflazzBrandGroup[]>`
  - `computeDigiflazzMarkupPrice(db: Db, cost: Decimal): Promise<Decimal>`
  - `interface DigiflazzImportRow { buyerSkuCode: string; productName: string; price: Decimal.Value }`
  - `importDigiflazzBrand(db: Db, args: { brand: string; categoryId: number; rows: DigiflazzImportRow[] }): Promise<{ productId: number; denominationCount: number }>`
  - `resyncDigiflazzCatalog(db: PrismaClient): Promise<{ updated: number; deactivated: number; reactivated: number }>`

- [ ] **Step 1: Extend `createCatalogProduct` and `createDenomination`**

In `packages/db/src/crud/catalog.ts:155-171`, add `digiflazzBrand?: string | null` to `createCatalogProduct`'s `args` type and pass it through: `digiflazzBrand: args.digiflazzBrand ?? null,` in the `data` object.

In `packages/db/src/crud/catalog.ts:302-321`, add `supplierSku?: string | null` to `createDenomination`'s `args` type and pass it through: `supplierSku: args.supplierSku ?? null,` in the `data` object.

- [ ] **Step 2: Write the grouping/matching/price tests first**

Append to `packages/db/src/crud/digiflazz.test.ts`:

```typescript
import {
  groupDigiflazzPriceListByBrand,
  computeDigiflazzMarkupPrice,
  importDigiflazzBrand,
  resyncDigiflazzCatalog,
  DIGIFLAZZ_MARKUP_TYPE_KEY,
  DIGIFLAZZ_MARKUP_VALUE_KEY,
} from "@app/db";
import { Decimal } from "@app/core/money";
import type { DigiflazzPriceListItem } from "@app/core/suppliers/digiflazz";

function priceListItem(overrides: Partial<DigiflazzPriceListItem> = {}): DigiflazzPriceListItem {
  return {
    buyerSkuCode: "ml100",
    productName: "Mobile Legends 100 Diamond",
    category: "Game",
    brand: "Mobile Legends",
    type: "Umum",
    price: new Decimal(15000),
    buyerProductStatus: true,
    sellerProductStatus: true,
    stock: null,
    ...overrides,
  };
}

describe("groupDigiflazzPriceListByBrand", () => {
  it("groups items by brand and flags brands with no existing Product as new", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends" }),
      priceListItem({ buyerSkuCode: "ml250", brand: "Mobile Legends", productName: "Mobile Legends 250 Diamond" }),
      priceListItem({ buyerSkuCode: "ff100", brand: "Free Fire", productName: "Free Fire 100 Diamond" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(2);
    const ml = groups.find((g) => g.brand === "Mobile Legends")!;
    expect(ml.items).toHaveLength(2);
    expect(ml.existingProductId).toBeNull();
  });

  it("separates region variants that Digiflazz reports as distinct brand strings", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends" }),
      priceListItem({ buyerSkuCode: "mlglobal100", brand: "Mobile Legends (Region Lain)" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups.map((g) => g.brand).sort()).toEqual(["Mobile Legends", "Mobile Legends (Region Lain)"]);
  });

  it("flags a brand already imported via digiflazzBrand as existing", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const product = await prisma.product.create({
      data: { categoryId: category.id, name: "Mobile Legends", slug: "mobile-legends-x", digiflazzBrand: "Mobile Legends" },
    });
    const groups = await groupDigiflazzPriceListByBrand(prisma, [priceListItem({ brand: "Mobile Legends" })]);
    expect(groups[0]!.existingProductId).toBe(product.id);
  });
});

describe("computeDigiflazzMarkupPrice", () => {
  it("applies a percent markup", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    const price = await computeDigiflazzMarkupPrice(prisma, new Decimal(10000));
    expect(price.toString()).toBe("11000");
  });

  it("applies a flat markup", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "flat");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "1500");
    const price = await computeDigiflazzMarkupPrice(prisma, new Decimal(10000));
    expect(price.toString()).toBe("11500");
  });

  it("defaults to zero markup (equals cost) when unset", async () => {
    const price = await computeDigiflazzMarkupPrice(prisma, new Decimal(10000));
    expect(price.toString()).toBe("10000");
  });
});

describe("importDigiflazzBrand", () => {
  it("creates a Product with digiflazzBrand set and one Denomination per row", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const result = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends",
      categoryId: category.id,
      rows: [
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500" },
        { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000" },
      ],
    });
    expect(result.denominationCount).toBe(2);

    const product = await prisma.product.findUnique({ where: { id: result.productId }, include: { denominations: true } });
    expect(product!.digiflazzBrand).toBe("Mobile Legends");
    expect(product!.isActive).toBe(false); // imported inactive — review-before-live
    expect(product!.denominations).toHaveLength(2);
    const denom = product!.denominations.find((d) => d.supplierSku === "ml100")!;
    expect(denom.autoDeliverySource).toBe("digiflazz");
    expect(denom.deliveryType).toBe("manual_with_info");
    expect(JSON.parse(denom.additionalFields!)).toEqual([
      { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      { key: "server_id", label: { id: "Server / Zone", en: "Server / Zone" }, type: "text", required: false, options: [], placeholder: "" },
    ]);
  });

  it("reuses the existing Product on a second import for the same brand rather than duplicating it", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const first = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500" }],
    });
    const second = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000" }],
    });
    expect(second.productId).toBe(first.productId);
    const count = await prisma.product.count({ where: { digiflazzBrand: "Mobile Legends" } });
    expect(count).toBe(1);
  });
});

describe("resyncDigiflazzCatalog", () => {
  async function importedDenom(supplierSku: string, initialCost: string) {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: supplierSku, productName: "Mobile Legends 100 Diamond", price: initialCost }],
    });
    return prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku } });
  }

  it("updates costPrice, recomputed price, and isActive from a fresh price list", async () => {
    const denom = await importedDenom("ml100", "15000");
    digiflazzMock.getPriceList = vi.fn();
    vi.doMock("@app/core/suppliers/digiflazz", () => ({}));
    // Re-mocked per-test below via direct monkeypatch on the module import at
    // top of the file is not needed: getPriceList is already covered by the
    // vi.mock at the top of this file (digiflazzMock.createTransaction) — add
    // getPriceList to that same hoisted mock object instead of a second mock
    // block here (see Step 3 note below on consolidating the two mocks).
  });
});
```

**Note on the last `describe` block above:** the `vi.mock("@app/core/suppliers/digiflazz", ...)` at the top of this test file currently only stubs `createTransaction`. Before writing `resyncDigiflazzCatalog`'s tests for real, extend that single hoisted mock object (`digiflazzMock`) to also include `getPriceList: vi.fn()`, and change the `vi.mock` factory to return `getPriceList: digiflazzMock.getPriceList` alongside `createTransaction: digiflazzMock.createTransaction` — one mock block for the whole file, not two. Then write:

```typescript
describe("resyncDigiflazzCatalog", () => {
  it("updates costPrice/price from a fresh price list and leaves priceOverridden rows untouched", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500" },
        { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000" },
      ],
    });
    // Admin hand-edits ml250's price after import.
    const ml250 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml250" } });
    await prisma.denomination.update({ where: { id: ml250.id }, data: { price: "50000", priceOverridden: true } });

    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(20000), buyerProductStatus: true }),
      priceListItem({ buyerSkuCode: "ml250", price: new Decimal(45000), buyerProductStatus: false }),
    ]);

    const result = await resyncDigiflazzCatalog(prisma);
    expect(result.updated).toBe(1); // only ml100 — ml250 is priceOverridden
    expect(result.deactivated).toBe(1); // ml250's isActive still flips off from buyerProductStatus, independent of price

    const ml100 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    expect(ml100.costPrice!.toString()).toBe("20000");
    expect(ml100.price.toString()).toBe("22000"); // 20000 + 10%

    const ml250After = await prisma.denomination.findFirstOrThrow({ where: { id: ml250.id } });
    expect(ml250After.price.toString()).toBe("50000"); // untouched
    expect(ml250After.isActive).toBe(false); // status still mirrors buyerProductStatus
  });

  it("is a no-op when Digiflazz isn't configured", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
    const result = await resyncDigiflazzCatalog(prisma);
    expect(result).toEqual({ updated: 0, deactivated: 0, reactivated: 0 });
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail (RED)**

Run: `pnpm exec vitest run packages/db/src/crud/digiflazz.test.ts`
Expected: FAIL — `groupDigiflazzPriceListByBrand`, `computeDigiflazzMarkupPrice`, `importDigiflazzBrand`, `resyncDigiflazzCatalog`, `DIGIFLAZZ_MARKUP_TYPE_KEY`, `DIGIFLAZZ_MARKUP_VALUE_KEY` are not defined.

- [ ] **Step 4: Implement, appending to `packages/db/src/crud/digiflazz.ts`**

```typescript
import { Decimal } from "@app/core/money";
import { ProductType, DeliveryType } from "@app/core/enums";
import { createCatalogProduct, createDenomination, updateDenomination } from "./catalog";
import type { DigiflazzPriceListItem } from "@app/core/suppliers/digiflazz";
import { getPriceList } from "@app/core/suppliers/digiflazz";

export const DIGIFLAZZ_MARKUP_TYPE_KEY = "digiflazz_markup_type";
export const DIGIFLAZZ_MARKUP_VALUE_KEY = "digiflazz_markup_value";

/** The two-field Game ID + Server template every Digiflazz-imported
 * denomination gets by default — the same shape the original plan's Task 4
 * (manual admin entry) would have had the admin type by hand. Admin can still
 * edit or delete a field afterward through the existing field-builder UI. */
const DEFAULT_DIGIFLAZZ_FIELDS = [
  { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
  { key: "server_id", label: { id: "Server / Zone", en: "Server / Zone" }, type: "text", required: false, options: [], placeholder: "" },
];

export interface DigiflazzBrandGroup {
  brand: string;
  items: DigiflazzPriceListItem[];
  /** Non-null when a Product with this exact digiflazzBrand already exists —
   * the wizard renders this group read-only ("Sudah ada"; updates flow
   * through resyncDigiflazzCatalog, not a re-import). */
  existingProductId: number | null;
}

/**
 * Group a raw Digiflazz price-list fetch by its `brand` field (each distinct
 * brand string — including region variants Digiflazz already reports
 * separately — becomes its own group), and mark which groups already have a
 * matching Product via Product.digiflazzBrand.
 */
export async function groupDigiflazzPriceListByBrand(
  db: Db,
  items: DigiflazzPriceListItem[],
): Promise<DigiflazzBrandGroup[]> {
  const byBrand = new Map<string, DigiflazzPriceListItem[]>();
  for (const item of items) {
    if (!item.brand) continue;
    const list = byBrand.get(item.brand) ?? [];
    list.push(item);
    byBrand.set(item.brand, list);
  }
  const brands = [...byBrand.keys()];
  const existing = await db.product.findMany({
    where: { digiflazzBrand: { in: brands } },
    select: { id: true, digiflazzBrand: true },
  });
  const existingByBrand = new Map(existing.map((p) => [p.digiflazzBrand!, p.id]));
  return brands.map((brand) => ({
    brand,
    items: byBrand.get(brand)!,
    existingProductId: existingByBrand.get(brand) ?? null,
  }));
}

/** Suggest a sell price from a Digiflazz cost using the admin's configured
 * global markup rule. Defaults to zero markup (sell === cost) when unset —
 * a deliberately visible "no markup configured yet" price rather than a
 * silently wrong guess, so an admin who hasn't set a rule notices at the
 * review screen instead of shipping a $0-margin catalog unknowingly. */
export async function computeDigiflazzMarkupPrice(db: Db, cost: Decimal): Promise<Decimal> {
  const [type, value] = await Promise.all([
    getSetting(db, DIGIFLAZZ_MARKUP_TYPE_KEY),
    getSetting(db, DIGIFLAZZ_MARKUP_VALUE_KEY),
  ]);
  const amount = value ? new Decimal(value) : new Decimal(0);
  if (type === "percent") return cost.plus(cost.times(amount).dividedBy(100));
  if (type === "flat") return cost.plus(amount);
  return cost;
}

export interface DigiflazzImportRow {
  buyerSkuCode: string;
  productName: string;
  price: Decimal.Value;
}

/**
 * Bulk-create (or add to, on a repeat call for the same brand) one Product +
 * one Denomination per row, all inside one transaction. Imported inactive —
 * "review before it goes live" per the design: the import itself is
 * automatic, publishing is a separate explicit step.
 */
export async function importDigiflazzBrand(
  db: PrismaClient,
  args: { brand: string; categoryId: number; rows: DigiflazzImportRow[] },
): Promise<{ productId: number; denominationCount: number }> {
  return db.$transaction(async (tx) => {
    let product = await tx.product.findFirst({ where: { digiflazzBrand: args.brand } });
    if (!product) {
      product = await createCatalogProduct(tx, {
        categoryId: args.categoryId,
        name: args.brand,
        digiflazzBrand: args.brand,
        isActive: false,
      });
    }
    for (const row of args.rows) {
      await createDenomination(tx, {
        productId: product.id,
        name: row.productName,
        // ProductType only accepts SHARED | PRIVATE (packages/core/src/enums.ts)
        // — Digiflazz top-ups have no such distinction, SHARED is the neutral
        // default, same as this codebase's own sample/test data.
        type: ProductType.SHARED,
        durationLabel: row.productName,
        price: row.price,
        autoDeliverySource: "digiflazz",
        supplierSku: row.buyerSkuCode,
        deliveryType: DeliveryType.MANUAL_WITH_INFO,
        additionalFields: JSON.stringify(DEFAULT_DIGIFLAZZ_FIELDS),
        isActive: false,
      });
    }
    return { productId: product.id, denominationCount: args.rows.length };
  });
}

/**
 * The recurring re-sync: for every Denomination with a non-null supplierSku,
 * refresh costPrice + recompute price (unless priceOverridden) from a fresh
 * Digiflazz price list, and mirror buyerProductStatus into isActive. Never
 * creates or renames anything — a genuinely new SKU only ever enters the
 * catalog through importDigiflazzBrand (the wizard), reviewed by an admin
 * first. No-op if Digiflazz isn't configured.
 */
export async function resyncDigiflazzCatalog(
  db: PrismaClient,
): Promise<{ updated: number; deactivated: number; reactivated: number }> {
  const zero = { updated: 0, deactivated: 0, reactivated: 0 };
  const creds = await getDigiflazzCreds(db);
  if (!creds) return zero;

  const [priceList, mapped] = await Promise.all([
    getPriceList(creds),
    db.denomination.findMany({ where: { supplierSku: { not: null } } }),
  ]);
  const bySku = new Map(priceList.map((item) => [item.buyerSkuCode, item]));

  const result = { ...zero };
  for (const denom of mapped) {
    const item = bySku.get(denom.supplierSku!);
    if (!item) continue; // Digiflazz no longer lists this SKU — leave it as-is, not this job's concern.

    const data: Record<string, unknown> = { costPrice: item.price };
    if (!denom.priceOverridden) {
      data.price = await computeDigiflazzMarkupPrice(db, item.price);
      result.updated++;
    }
    if (denom.isActive && !item.buyerProductStatus) {
      data.isActive = false;
      result.deactivated++;
    } else if (!denom.isActive && item.buyerProductStatus) {
      data.isActive = true;
      result.reactivated++;
    }
    await updateDenomination(db, denom.id, data);
  }
  return result;
}
```

Add `import { getSetting } from "./settings";` if not already present in the file (it already is, per Step 1's read).

- [ ] **Step 5: Run tests to confirm they pass (GREEN)**

Run: `pnpm exec vitest run packages/db/src/crud/digiflazz.test.ts`
Expected: all pass. Fix the `resyncDigiflazzCatalog` "no-op" test's exact expected shape if `getDigiflazzCreds`'s null path differs from `zero`'s literal shape once run for real.

- [ ] **Step 6: Typecheck and full suite**

Run: `pnpm typecheck && pnpm test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/crud/catalog.ts packages/db/src/crud/digiflazz.ts packages/db/src/crud/digiflazz.test.ts
git commit -m "feat(digiflazz): brand grouping, markup pricing, bulk import, and re-sync"
```

---

### Task 5: Admin backend — sync preview/apply routes

**Files:**
- Create: `apps/web-admin/src/routes/api/digiflazzSync.ts`
- Modify: `apps/web-admin/src/server.ts` (register the new route)
- Test: `apps/web-admin/test/digiflazz-sync-api.test.ts` (new — this app's route
  tests live under the top-level `apps/web-admin/test/` directory, not
  colocated with the route file; confirmed against the existing
  `apps/web-admin/test/catalog-denomination-edit.test.ts`)

**Interfaces:**
- Consumes: `groupDigiflazzPriceListByBrand`, `computeDigiflazzMarkupPrice`, `importDigiflazzBrand`, `getDigiflazzCreds`, `listAllCategories`, `logAdminAction` from `@app/db`; `getPriceList` from `@app/core/suppliers/digiflazz`.
- Produces: `POST /api/catalog/digiflazz/sync/preview` → `{ groups: Array<{ brand: string; existingProductId: number | null; skus: Array<{ buyerSkuCode: string; productName: string; costPrice: string; suggestedPrice: string }> }> }`; `POST /api/catalog/digiflazz/sync/apply` (body `{ categoryId: number; brands: Array<{ brand: string; rows: Array<{ buyerSkuCode: string; productName: string; price: string }> }> }`) → `{ ok: true; brandsImported: number; denominationsImported: number }`.

- [ ] **Step 1: Write the route file**

```typescript
import type { FastifyInstance } from "fastify";
import {
  prisma,
  getDigiflazzCreds,
  groupDigiflazzPriceListByBrand,
  computeDigiflazzMarkupPrice,
  importDigiflazzBrand,
  listAllCategories,
  logAdminAction,
} from "@app/db";
import { getPriceList } from "@app/core/suppliers/digiflazz";
import { Decimal } from "@app/core/money";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

export default async function digiflazzSyncApiRoutes(app: FastifyInstance): Promise<void> {
  // Step 1: fetch + group (dry run, no write) — same "preview then apply"
  // shape as /api/catalog/products/import, just sourced from Digiflazz's
  // live price list instead of a pasted CSV.
  app.post("/api/catalog/digiflazz/sync/preview", { preHandler: currentAdmin }, async (_req, reply) => {
    const creds = await getDigiflazzCreds(prisma);
    if (!creds) {
      return reply.code(400).send({ error: "Digiflazz credentials are not configured. Set them in Settings first." });
    }
    let items;
    try {
      items = await getPriceList(creds);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "Failed to reach Digiflazz." });
    }
    const gameItems = items.filter((i) => i.category === "Game");
    const groups = await groupDigiflazzPriceListByBrand(prisma, gameItems);
    const withPrices = await Promise.all(
      groups.map(async (g) => ({
        brand: g.brand,
        existingProductId: g.existingProductId,
        skus: await Promise.all(
          g.items.map(async (item) => ({
            buyerSkuCode: item.buyerSkuCode,
            productName: item.productName,
            costPrice: item.price.toString(),
            suggestedPrice: (await computeDigiflazzMarkupPrice(prisma, item.price)).toString(),
          })),
        ),
      })),
    );
    return reply.send({ groups: withPrices });
  });

  // Step 2: commit selected brands/rows in one transaction per brand.
  app.post(
    "/api/catalog/digiflazz/sync/apply",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        categoryId?: number;
        brands?: Array<{ brand: string; rows: Array<{ buyerSkuCode: string; productName: string; price: string }> }>;
      };
      const categoryId = Number(body.categoryId);
      if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return reply.code(400).send({ error: "A target category is required." });
      }
      const brands = Array.isArray(body.brands) ? body.brands : [];
      if (brands.length === 0) {
        return reply.code(400).send({ error: "Select at least one brand to import." });
      }
      for (const b of brands) {
        for (const row of b.rows) {
          if (!row.buyerSkuCode || !row.productName || !row.price || new Decimal(row.price).lessThanOrEqualTo(0)) {
            return reply.code(400).send({ error: `Invalid price for "${row.productName || row.buyerSkuCode}".` });
          }
        }
      }

      let brandsImported = 0;
      let denominationsImported = 0;
      for (const b of brands) {
        const result = await importDigiflazzBrand(prisma, { brand: b.brand, categoryId, rows: b.rows });
        brandsImported++;
        denominationsImported += result.denominationCount;
      }

      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "digiflazz_catalog_import",
        targetType: "product",
        targetId: null,
        details: `Imported ${brandsImported} game(s) / ${denominationsImported} denomination(s) from Digiflazz.`,
      });
      return reply.send({ ok: true, brandsImported, denominationsImported });
    },
  );

  // Categories for the target-category picker (existing categories only —
  // this wizard never auto-creates one).
  app.get("/api/catalog/digiflazz/categories", { preHandler: currentAdmin }, async (_req, reply) => {
    return reply.send({ categories: await listAllCategories(prisma) });
  });
}
```

- [ ] **Step 2: Register the route**

In `apps/web-admin/src/server.ts`, add `import digiflazzSyncApiRoutes from "./routes/api/digiflazzSync";` near the other `...ApiRoutes` imports, and `await app.register(digiflazzSyncApiRoutes);` next to `await app.register(catalogApiRoutes);` (`~line 141`).

- [ ] **Step 3: Write `apps/web-admin/test/digiflazz-sync-api.test.ts`**

Follows `apps/web-admin/test/catalog-denomination-edit.test.ts`'s exact convention: `buildApp()` takes no arguments (uses the shared `@app/db` `prisma` singleton), `initDb()` once in `beforeAll`, `resetDb(prisma)` per test, an admin session built via `makeSession`, and `app.inject()` with the session cookie + `x-csrf-token` header for mutating routes.

```typescript
import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const digiflazzMock = vi.hoisted(() => ({ getPriceList: vi.fn() }));
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()),
  getPriceList: digiflazzMock.getPriceList,
}));

import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";
import { Decimal } from "@app/core/money";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
  digiflazzMock.getPriceList.mockReset();
});

function postJson(url: string, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    cookies: { [COOKIE]: cookie },
    payload: JSON.stringify(body),
  });
}

describe("POST /api/catalog/digiflazz/sync/preview", () => {
  it("rejects when Digiflazz credentials are not configured", async () => {
    const res = await postJson("/api/catalog/digiflazz/sync/preview", {});
    expect(res.statusCode).toBe(400);
  });

  it("groups the Game-category price list by brand once configured", async () => {
    await setSetting(prisma, "digiflazz_username", "u");
    await setSetting(prisma, "digiflazz_api_key", "k");
    digiflazzMock.getPriceList.mockResolvedValue([
      { buyerSkuCode: "ml100", productName: "ML 100", category: "Game", brand: "Mobile Legends", type: "Umum", price: new Decimal(15000), buyerProductStatus: true, sellerProductStatus: true, stock: null },
      { buyerSkuCode: "x100", productName: "XL 100k", category: "Pulsa", brand: "XL", type: "Umum", price: new Decimal(98000), buyerProductStatus: true, sellerProductStatus: true, stock: null },
    ]);
    const res = await postJson("/api/catalog/digiflazz/sync/preview", {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1); // Pulsa filtered out — Game only, this pilot's scope
    expect(body.groups[0].brand).toBe("Mobile Legends");
  });
});

describe("POST /api/catalog/digiflazz/sync/apply", () => {
  it("imports selected brands into the given category", async () => {
    const category = await createCategory(prisma, "Top Up Game");
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [
        {
          brand: "Mobile Legends",
          rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500" }],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ ok: true, brandsImported: 1, denominationsImported: 1 });
  });

  it("rejects a non-positive price", async () => {
    const category = await createCategory(prisma, "Top Up Game");
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [{ brand: "Mobile Legends", rows: [{ buyerSkuCode: "ml100", productName: "X", price: "0" }] }],
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 4: Run and verify**

Run: `pnpm exec vitest run apps/web-admin/test/digiflazz-sync-api.test.ts`
Expected: all pass.

Run: `pnpm typecheck && pnpm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/routes/api/digiflazzSync.ts apps/web-admin/test/digiflazz-sync-api.test.ts apps/web-admin/src/server.ts
git commit -m "feat(digiflazz): sync preview/apply admin API routes"
```

---

### Task 6: Admin frontend — Import Wizard page

**Files:**
- Create: `apps/web-admin/client/src/pages/DigiflazzSyncPage.tsx`
- Modify: `apps/web-admin/client/src/pages/CatalogPage.tsx` (add an entry point)
- Modify: the client router (wherever `CatalogPage` is routed — likely `apps/web-admin/client/src/App.tsx`, confirmed pattern from the earlier admin-UI exploration)

**Interfaces:**
- Consumes: `POST /api/catalog/digiflazz/sync/preview`, `POST /api/catalog/digiflazz/sync/apply`, `GET /api/catalog/digiflazz/categories` (Task 5); `apiPost`/`apiGet` from `../api/client`.

- [ ] **Step 1: Add the page**

```tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { toast } from "sonner";
import { apiPost, apiGet } from "../api/client";
import { describeError } from "../lib/errorMessages";

interface SkuRow {
  buyerSkuCode: string;
  productName: string;
  costPrice: string;
  suggestedPrice: string;
}
interface BrandGroup {
  brand: string;
  existingProductId: number | null;
  skus: SkuRow[];
}
interface PreviewResponse {
  groups: BrandGroup[];
}
interface Category {
  id: number;
  name: string;
}

export function DigiflazzSyncPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: categoriesData } = useQuery({
    queryKey: ["digiflazz-categories"],
    queryFn: () => apiGet<{ categories: Category[] }>("/api/catalog/digiflazz/categories"),
  });
  const categories = categoriesData?.categories ?? [];

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [checkedSkus, setCheckedSkus] = useState<Set<string>>(new Set()); // key: `${brand}::${buyerSkuCode}`
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({}); // key: same as above
  const [importing, setImporting] = useState(false);

  async function runSync() {
    setLoadingPreview(true);
    setPreviewError(null);
    try {
      const res = await apiPost<PreviewResponse>("/api/catalog/digiflazz/sync/preview", {});
      setPreview(res);
      // New brands default to fully checked; existing brands stay unchecked
      // (they're read-only previews here — see the group-level note below).
      const next = new Set<string>();
      for (const g of res.groups) {
        if (g.existingProductId) continue;
        for (const s of g.skus) next.add(`${g.brand}::${s.buyerSkuCode}`);
      }
      setCheckedSkus(next);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to sync from Digiflazz.");
    } finally {
      setLoadingPreview(false);
    }
  }

  function toggleExpanded(brand: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(brand)) n.delete(brand); else n.add(brand);
      return n;
    });
  }

  function toggleSku(key: string) {
    setCheckedSkus((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  function priceFor(key: string, suggested: string): string {
    return priceEdits[key] ?? suggested;
  }

  function priceIsInvalid(key: string, suggested: string): boolean {
    const raw = priceFor(key, suggested);
    const n = Number(raw);
    return !raw || !Number.isFinite(n) || n <= 0;
  }

  async function applyImport() {
    if (!preview || !categoryId) return;
    const newGroups = preview.groups.filter((g) => !g.existingProductId);
    const brands = newGroups
      .map((g) => ({
        brand: g.brand,
        rows: g.skus
          .filter((s) => checkedSkus.has(`${g.brand}::${s.buyerSkuCode}`))
          .map((s) => ({
            buyerSkuCode: s.buyerSkuCode,
            productName: s.productName,
            price: priceFor(`${g.brand}::${s.buyerSkuCode}`, s.suggestedPrice),
          })),
      }))
      .filter((b) => b.rows.length > 0);
    if (brands.length === 0) {
      toast.error("Select at least one SKU to import.");
      return;
    }
    setImporting(true);
    try {
      const res = await apiPost<{ ok: true; brandsImported: number; denominationsImported: number }>(
        "/api/catalog/digiflazz/sync/apply",
        { categoryId: Number(categoryId), brands },
      );
      toast.success(`Imported ${res.brandsImported} game(s), ${res.denominationsImported} denomination(s). Activate them from the Catalog page when ready.`);
      await queryClient.invalidateQueries({ queryKey: ["catalog"] });
      navigate("/catalog");
    } catch (err) {
      toast.error(describeError(err instanceof Error ? err.message : "Import failed."));
    } finally {
      setImporting(false);
    }
  }

  const newGroups = (preview?.groups ?? []).filter(
    (g) => !g.existingProductId && (!filter || g.brand.toLowerCase().includes(filter.toLowerCase())),
  );
  const existingGroups = (preview?.groups ?? []).filter(
    (g) => g.existingProductId && (!filter || g.brand.toLowerCase().includes(filter.toLowerCase())),
  );

  return (
    <PageLayout title="Sync Digiflazz">
      <PageHeader
        title="Sync Digiflazz"
        description="Pull Digiflazz's Game price list, review, and bulk-import new titles into the catalog."
        actions={
          <Button size="sm" onClick={() => void runSync()} disabled={loadingPreview}>
            {loadingPreview ? "Syncing…" : "Sync dari Digiflazz"}
          </Button>
        }
      />

      {previewError && <p className="text-sm text-rust">{previewError}</p>}

      {preview && (
        <>
          <div className="flex items-center gap-3">
            <Input
              placeholder="Filter by game name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-xs"
            />
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="max-w-xs">
                <SelectValue placeholder="Target category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {newGroups.map((g) => (
            <Card key={g.brand}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="cursor-pointer" onClick={() => toggleExpanded(g.brand)}>
                  {g.brand} <span className="text-sm text-ink-soft">— {g.skus.length} SKU(s), Baru</span>
                </CardTitle>
              </CardHeader>
              {expanded.has(g.brand) && (
                <CardContent className="space-y-2">
                  {g.skus.map((s) => {
                    const key = `${g.brand}::${s.buyerSkuCode}`;
                    const invalid = priceIsInvalid(key, s.suggestedPrice);
                    return (
                      <div key={key} className="flex items-center gap-3">
                        <Checkbox checked={checkedSkus.has(key)} onCheckedChange={() => toggleSku(key)} />
                        <span className="flex-1 text-sm">{s.productName}</span>
                        <span className="text-xs text-ink-soft">Cost {s.costPrice}</span>
                        <Input
                          className={invalid ? "max-w-32 border-rust" : "max-w-32"}
                          value={priceFor(key, s.suggestedPrice)}
                          onChange={(e) => setPriceEdits((p) => ({ ...p, [key]: e.target.value }))}
                        />
                      </div>
                    );
                  })}
                </CardContent>
              )}
            </Card>
          ))}

          {existingGroups.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Sudah ada ({existingGroups.length})</CardTitle></CardHeader>
              <CardContent>
                <p className="text-sm text-ink-soft">
                  These games are already imported — price/status updates happen automatically on the hourly
                  sync, not through this wizard.
                </p>
                <ul className="mt-2 text-sm">
                  {existingGroups.map((g) => (
                    <li key={g.brand}>{g.brand} — {g.skus.length} SKU(s)</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {newGroups.length > 0 && (
            <Button onClick={() => void applyImport()} disabled={importing || !categoryId}>
              {importing ? "Importing…" : "Impor Terpilih"}
            </Button>
          )}
        </>
      )}
    </PageLayout>
  );
}
```

- [ ] **Step 2: Link it from the Catalog page**

In `apps/web-admin/client/src/pages/CatalogPage.tsx`, add a button next to the existing "Import CSV" button (`~line 337-347`):

```tsx
            <Button variant="ghost" size="sm" onClick={() => navigate("/catalog/digiflazz-sync")}>
              Sync Digiflazz
            </Button>
```

- [ ] **Step 3: Register the route**

In `apps/web-admin/client/src/App.tsx`, alongside the existing `<Route path="/catalog" element={<CatalogPage />} />`-style entry, add:

```tsx
<Route path="/catalog/digiflazz-sync" element={<DigiflazzSyncPage />} />
```

with a matching `import { DigiflazzSyncPage } from "./pages/DigiflazzSyncPage";` at the top of that file.

- [ ] **Step 4: Build and manually verify**

Run: `pnpm --filter @app/web-admin-client build`
Expected: builds clean.

Manual check: start the admin dev server, open `/catalog/digiflazz-sync`, click "Sync dari Digiflazz" against real or sandbox credentials (or confirm the error path renders cleanly if credentials aren't set — this exercises the "Digiflazz fetch/credential failure" error-handling requirement from the spec), verify brand groups render, checkboxes/price edits work, and Impor Terpilih creates catalog rows (check the Catalog page afterward).

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/DigiflazzSyncPage.tsx apps/web-admin/client/src/pages/CatalogPage.tsx apps/web-admin/client/src/App.tsx
git commit -m "feat(digiflazz): Import Wizard admin page"
```

---

### Task 7: Hourly re-sync cron

**Files:**
- Modify: `apps/order-bot/src/jobs/index.ts`
- Modify: `apps/order-bot/src/main.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/order-bot/test/wiring.test.ts` (extend the existing stub)

**Interfaces:**
- Consumes: `resyncDigiflazzCatalog` from `@app/db` (Task 4).
- Produces: `scheduleDigiflazzCatalogSync(): Cron`

- [ ] **Step 1: Add the job function**

In `apps/order-bot/src/jobs/index.ts`, near `scheduleFxRefresh` (`~line 1361`):

```typescript
/**
 * Hourly Digiflazz catalog re-sync — refreshes costPrice/price/isActive on
 * every already-imported denomination (never creates/renames anything; new
 * SKUs only ever enter the catalog via the admin's Import Wizard). No `Api`
 * needed, so this runs even on a web-only boot, same as scheduleFxRefresh.
 */
export function scheduleDigiflazzCatalogSync(): Cron {
  const run = () =>
    resyncDigiflazzCatalog(prisma)
      .then((r) => {
        if (r.updated || r.deactivated || r.reactivated) {
          logger.info(`Digiflazz catalog re-sync: ${r.updated} price update(s), ${r.deactivated} deactivated, ${r.reactivated} reactivated.`);
        }
      })
      .catch((err) => logger.error({ err }, "Digiflazz catalog re-sync failed — will retry on the next hourly tick"));
  return new Cron("15 * * * *", { protect: true }, run);
}
```

Add `resyncDigiflazzCatalog` to this file's existing `@app/db` import list. Use `"15 * * * *"` (not `"5 * * * *"` like `scheduleFxRefresh`) so the two hourly jobs' ticks don't collide.

- [ ] **Step 2: Wire it into both boot paths**

In `apps/order-bot/src/main.ts`, near `scheduleFxRefresh()` (`~line 268`):

```typescript
  scheduleFxRefresh();
  scheduleDigiflazzCatalogSync();
```

Add `scheduleDigiflazzCatalogSync` to that file's `import { scheduleJobs, scheduleFxRefresh } from "./jobs";` line.

In `apps/server/src/index.ts`, near `jobs = [...jobs, scheduleFxRefresh()];` (`~line 294`):

```typescript
  jobs = [...jobs, scheduleFxRefresh(), scheduleDigiflazzCatalogSync()];
```

Add `scheduleDigiflazzCatalogSync` to that file's `import { scheduleJobs, scheduleFxRefresh, flushSettledOrderBubble } from "@app/order-bot/jobs";` line.

- [ ] **Step 3: Extend the wiring test stub**

In `apps/order-bot/test/wiring.test.ts` (`~line 55-61`), add `scheduleDigiflazzCatalogSync: vi.fn(() => ({ stop: vi.fn() }))` to the `jobsSpies` object, alongside the existing `scheduleFxRefresh` stub — otherwise this suite's real-timer guard will fire a real DB call from the new job during an unrelated test run.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: clean, including `apps/order-bot/test/wiring.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/order-bot/src/jobs/index.ts apps/order-bot/src/main.ts apps/server/src/index.ts apps/order-bot/test/wiring.test.ts
git commit -m "feat(digiflazz): hourly catalog re-sync cron"
```

---

## Verification (whole plan)

- `pnpm typecheck && pnpm test` green after every task, and once more at the end.
- Manual end-to-end walk (after Task 6): Settings → enter Digiflazz credentials + a markup rule → Test Connection succeeds → Catalog → Sync Digiflazz → brand groups render, filtered to Game → pick a target category → check a brand's SKUs → adjust one price → Impor Terpilih → Catalog page shows the new Product (inactive) with its Denominations, each carrying the Game ID + Server template and a `supplierSku` → activate it → confirm the hourly job (trigger `resyncDigiflazzCatalog` directly in a REPL/test if waiting an hour isn't practical) updates `costPrice`/`price` and leaves a hand-edited price alone.
- Confirm `Order.digiflazzDispatchedAt`-based dispatch (Task 1, already built) still works end-to-end against a denomination created by the wizard, not just a hand-created one — the wizard's output must be indistinguishable from manual entry to every downstream consumer.
