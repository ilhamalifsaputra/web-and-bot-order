# TokoPay QRIS Fee (Gateway Total) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match TokoPay payments against the fee-inclusive total TokoPay itself reports for each order, and replace the hard-coded Rp100 + 0.7% with a built-in per-channel tariff table used for estimates only.

**Architecture:** A new nullable column `Order.gatewayChargeAmount` stores TokoPay's `total_bayar` in the same write that caches the gateway result. One pure resolver, `expectedTokopayCharge(order, channel)`, returns that snapshot or, when it is null, an estimate from a built-in tariff table; every matching and bookkeeping site calls it. A drift alert tells admins when TokoPay's figure differs from the estimate.

**Tech Stack:** TypeScript, pnpm workspaces, Prisma (PostgreSQL), Fastify (storefront), grammY (order-bot), Vitest, decimal.js via `@app/core/money`.

**Spec:** `docs/superpowers/specs/2026-11-11-tokopay-fee-settings-design.md`

## Global Constraints

- All money is `Decimal` from `@app/core/money`; never `number`/`parseFloat`.
- No raw SQL in routes or handlers; database access goes in `packages/db/src/crud/*`.
- The web (storefront, admin) never sends Telegram; it enqueues to `notification_outbox`.
- Pino log messages are full English sentences that say what happened and why it matters; no secrets, no truncated id lists.
- Comparison rules do not change: paid below the expected charge is UNDERPAID, above is overpaid, no tolerance.
- No admin setting, route or Settings UI is added for the tariff.
- Bot message counts must not change; tests that touch a bot flow pin exact `sendMessage` / `edit*` / `deleteMessage` / `sendDocument` counts.
- Stage files by name (`git add <path>`), never `git add -A` or `-a`: a hook regenerates `graphify-out/` during the task.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>` and no other attribution.
- Per task run only the affected tests (`pnpm exec vitest run <path>`) and `pnpm --filter <pkg> typecheck`. `pnpm --filter <pkg> test` runs nothing in this repo.
- Never `git stash`, never switch branch, never `git reset --hard`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/payments/tokopayFee.ts` (new) | Tariff table, `estimateTokopayFee`, `estimatedTokopayCharge`, `readTokopayCharge`, `expectedTokopayCharge`. Pure. |
| `packages/core/src/payments/tokopayFee.test.ts` (new) | Unit tests for the above. |
| `packages/core/src/payments/tokopay.ts` | Loses `computeQrisAdminFee`, `qrisChargeAmount` and the two constants (Task 8). |
| `prisma/schema.prisma`, `prisma/migrations/*` | `Order.gatewayChargeAmount`, backfill. |
| `packages/db/src/crud/_tokopayChannel.ts` (new) | `getTokopayChannel(db)` leaf helper (no import cycle). |
| `packages/db/src/crud/orders.ts` | `commitGatewayResult` writes the snapshot. |
| `packages/db/src/crud/notifications.ts` | `enqueueAdminTokopayFeeDrift`. |
| `packages/db/src/crud/tokopay.ts` | `commitTokopayGateway`; settlement reads the resolver. |
| `packages/db/src/crud/{overpayments,orderStatus,manualMatch,wallet_topup}.ts` | Read the resolver. |
| `packages/outbox-dispatcher/src/{dispatcher,templates}.ts`, `packages/core/src/enums.ts` | New admin DM event. |
| `apps/storefront/src/routes/checkout.ts` | Preview estimate, pay page snapshot, webhook check. |
| `apps/order-bot/src/{util/qrisCaption.ts,handlers/checkout.ts,handlers/walletTopup.ts,payments/tokopayReconcile.ts}` | Caption from snapshot, reconcile check. |
| `packages/core/locales/{id,en}.json` | Rate-free `web.qris_admin_fee_note`. |

---

### Task 1: Core tariff module

**Files:**
- Create: `packages/core/src/payments/tokopayFee.ts`
- Test: `packages/core/src/payments/tokopayFee.test.ts`

**Interfaces:**
- Consumes: `Decimal` from `packages/core/src/money`.
- Produces:
  - `TOKOPAY_FEE_TABLE: Readonly<Record<string, readonly TokopayFeeTier[]>>`
  - `estimateTokopayFee(channel: string, amount: Decimal.Value): Decimal | null`
  - `estimatedTokopayCharge(channel: string, totalAmount: Decimal.Value): Decimal`
  - `readTokopayCharge(channel: string, totalAmount: Decimal.Value, totalBayar: string | null | undefined): TokopayChargeReading`
  - `expectedTokopayCharge(order: { totalAmount: Decimal.Value; gatewayChargeAmount?: Decimal.Value | null }, channel: string): Decimal`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/payments/tokopayFee.test.ts
import { describe, it, expect } from "vitest";
import { Decimal } from "../money";
import {
  TOKOPAY_FEE_TABLE,
  estimateTokopayFee,
  estimatedTokopayCharge,
  readTokopayCharge,
  expectedTokopayCharge,
} from "./tokopayFee";

describe("estimateTokopayFee", () => {
  it("charges QRIS Rp25 below Rp100.000 and Rp100 + 0.70% from Rp100.000", () => {
    expect(estimateTokopayFee("QRIS", "50000")!.toString()).toBe("25");
    expect(estimateTokopayFee("QRIS", "99999")!.toString()).toBe("25");
    expect(estimateTokopayFee("QRIS", "100000")!.toString()).toBe("800");
    expect(estimateTokopayFee("QRIS", "150000")!.toString()).toBe("1150");
  });

  it("charges QRIS_CUSTOM Rp25 below Rp100.000 and Rp250 + 0.70% from Rp100.000", () => {
    expect(estimateTokopayFee("QRIS_CUSTOM", "99999")!.toString()).toBe("25");
    expect(estimateTokopayFee("QRIS_CUSTOM", "100000")!.toString()).toBe("950");
  });

  it("does not apply the Rp25 rule to QRISREALTIME", () => {
    expect(estimateTokopayFee("QRISREALTIME", "50000")!.toString()).toBe("850");
  });

  it("handles flat-only and percent-only channels", () => {
    expect(estimateTokopayFee("BRIVA", "20000")!.toString()).toBe("3000");
    expect(estimateTokopayFee("BCAVA", "20000")!.toString()).toBe("4200");
    expect(estimateTokopayFee("GOPAY", "10000")!.toString()).toBe("300");
    expect(estimateTokopayFee("TELKOMSEL", "10000")!.toString()).toBe("3200");
  });

  it("rounds half up to whole rupiah", () => {
    // 100 + 100.050 * 0.7% = 800.35 -> 800 ; 100 + 100.072 * 0.7% = 800.504 -> 801
    expect(estimateTokopayFee("QRIS", "100050")!.toString()).toBe("800");
    expect(estimateTokopayFee("QRIS", "100072")!.toString()).toBe("801");
  });

  it("trims and upper-cases the channel code, and returns null for an unknown one", () => {
    expect(estimateTokopayFee(" qris ", "50000")!.toString()).toBe("25");
    expect(estimateTokopayFee("NOT_A_CHANNEL", "50000")).toBeNull();
  });

  it("has a well-formed table: ascending bounds and exactly the last tier open-ended", () => {
    for (const [code, tiers] of Object.entries(TOKOPAY_FEE_TABLE)) {
      expect(tiers.length, code).toBeGreaterThan(0);
      tiers.forEach((tier, index) => {
        const last = index === tiers.length - 1;
        expect(tier.upTo === null, `${code} tier ${index}`).toBe(last);
        expect(new Decimal(tier.flat).greaterThanOrEqualTo(0), code).toBe(true);
        expect(new Decimal(tier.percent).greaterThanOrEqualTo(0), code).toBe(true);
        if (index > 0 && tier.upTo !== null) {
          expect(new Decimal(tier.upTo).greaterThan(tiers[index - 1]!.upTo!), code).toBe(true);
        }
      });
    }
  });
});

describe("estimatedTokopayCharge", () => {
  it("adds the estimate to the total, and adds nothing for an unknown channel", () => {
    expect(estimatedTokopayCharge("QRIS", "50000").toString()).toBe("50025");
    expect(estimatedTokopayCharge("NOT_A_CHANNEL", "50000").toString()).toBe("50000");
  });
});

describe("readTokopayCharge", () => {
  it("accepts a whole-rupiah total at or above the order total", () => {
    expect(readTokopayCharge("QRIS", "50000", "50025")).toEqual({ kind: "ok", charge: new Decimal("50025") });
    expect(readTokopayCharge("QRIS", "50000", "50000")).toEqual({ kind: "ok", charge: new Decimal("50000") });
  });

  it("reports a null or blank total as missing", () => {
    expect(readTokopayCharge("QRIS", "50000", null)).toEqual({ kind: "missing" });
    expect(readTokopayCharge("QRIS", "50000", undefined)).toEqual({ kind: "missing" });
    expect(readTokopayCharge("QRIS", "50000", "  ")).toEqual({ kind: "missing" });
  });

  it("rejects a total below the order total, a non-number and a fractional rupiah", () => {
    expect(readTokopayCharge("QRIS", "50000", "49999")).toEqual({ kind: "implausible" });
    expect(readTokopayCharge("QRIS", "50000", "abc")).toEqual({ kind: "implausible" });
    expect(readTokopayCharge("QRIS", "50000", "50025.5")).toEqual({ kind: "implausible" });
  });

  it("caps the fee at 10% of the total plus Rp10.000 for a low-percent channel", () => {
    expect(readTokopayCharge("QRIS", "50000", "65000").kind).toBe("ok");
    expect(readTokopayCharge("QRIS", "50000", "65001").kind).toBe("implausible");
    expect(readTokopayCharge("NOT_A_CHANNEL", "50000", "65001").kind).toBe("implausible");
  });

  it("widens the cap to twice the table percent for a high-percent channel", () => {
    // TELKOMSEL is 32%: cap = 64% of 10.000 + 10.000 = 16.400
    expect(readTokopayCharge("TELKOMSEL", "10000", "13200").kind).toBe("ok");
    expect(readTokopayCharge("TELKOMSEL", "10000", "26400").kind).toBe("ok");
    expect(readTokopayCharge("TELKOMSEL", "10000", "26401").kind).toBe("implausible");
  });

  it("compares against the rounded nominal that is sent to TokoPay", () => {
    expect(readTokopayCharge("QRIS", "50000.4", "50025").kind).toBe("ok");
  });
});

describe("expectedTokopayCharge", () => {
  it("returns the stored snapshot when there is one", () => {
    expect(expectedTokopayCharge({ totalAmount: "50000", gatewayChargeAmount: "50450" }, "QRIS").toString()).toBe("50450");
  });

  it("falls back to the estimate when the snapshot is null or absent", () => {
    expect(expectedTokopayCharge({ totalAmount: "50000", gatewayChargeAmount: null }, "QRIS").toString()).toBe("50025");
    expect(expectedTokopayCharge({ totalAmount: "50000" }, "QRIS").toString()).toBe("50025");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/payments/tokopayFee.test.ts`
Expected: FAIL — cannot resolve `./tokopayFee`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/payments/tokopayFee.ts
/**
 * TokoPay's admin fee, per channel — for ESTIMATES only.
 *
 * The fee is TokoPay's own cut, paid by the buyer on top of the order total.
 * What a buyer is actually charged is whatever TokoPay returns as `total_bayar`
 * when the transaction is created; that figure is stored on the order
 * (`Order.gatewayChargeAmount`) and is what payments are matched against. This
 * table is used only where that figure does not exist yet (the storefront
 * checkout preview) or was never reported (`expectedTokopayCharge` fallback).
 *
 * Source: the shop owner's TokoPay dashboard tariff list and TokoPay's merchant
 * announcement, both dated 2026-11-11 (QRIS and QRIS_CUSTOM below Rp100.000 are
 * charged 0% + Rp25; QRISREALTIME is not). TokoPay has no API that lists
 * tariffs, so a tariff change needs an edit here; payments keep matching in
 * the meantime because they use the stored gateway figure.
 */
import { Decimal } from "../money";

export interface TokopayFeeTier {
  /** The tier applies when `amount < upTo`. Null on the last tier only. */
  upTo: string | null;
  /** Whole rupiah. */
  flat: string;
  /** Percent of the amount, e.g. "0.7" for 0.70%. */
  percent: string;
}

const flatFee = (rupiah: string): readonly TokopayFeeTier[] => [{ upTo: null, flat: rupiah, percent: "0" }];
const percentFee = (percent: string): readonly TokopayFeeTier[] => [{ upTo: null, flat: "0", percent }];

export const TOKOPAY_FEE_TABLE: Readonly<Record<string, readonly TokopayFeeTier[]>> = {
  // QRIS
  QRIS: [
    { upTo: "100000", flat: "25", percent: "0" },
    { upTo: null, flat: "100", percent: "0.7" },
  ],
  QRIS_CUSTOM: [
    { upTo: "100000", flat: "25", percent: "0" },
    { upTo: null, flat: "250", percent: "0.7" },
  ],
  QRISREALTIME: percentFee("1.7"),
  QRIS_WK: percentFee("1.2"),
  // Virtual account
  BRIVA: flatFee("3000"),
  BCAVA: flatFee("4200"),
  BNIVA: flatFee("3500"),
  MANDIRIVA: flatFee("3500"),
  PERMATAVA: flatFee("2000"),
  CIMBVA: flatFee("2500"),
  DANAMONVA: flatFee("2500"),
  BSIVA: flatFee("3500"),
  BNCVA: flatFee("3000"),
  PERMATAVAA: flatFee("3000"),
  // E-money
  SHOPEEPAY: percentFee("2.5"),
  GOPAY: percentFee("3"),
  DANA: percentFee("2.5"),
  LINKAJA: percentFee("3"),
  VIRGO: percentFee("2"),
  ASTRAPAY: percentFee("2.5"),
  OVOPUSH: percentFee("2.5"),
  DANA_REALTIME: percentFee("3.2"),
  SHOPEEPAY_REALTIME: percentFee("3"),
  GOPAY_REALTIME: percentFee("3.5"),
  OVOPUSH_REALTIME: percentFee("2.7"),
  // E-money custom name
  DANA_CUSTOM: percentFee("2.5"),
  SHOPEE_CUSTOM: percentFee("2.5"),
  OVO_CUSTOM: percentFee("2.5"),
  LINKAJA_CUSTOM: percentFee("2.5"),
  // Retail
  ALFAMART: flatFee("3000"),
  INDOMARET: flatFee("3000"),
  // Pulsa
  TELKOMSEL: percentFee("32"),
  AXIS: percentFee("25"),
  XL: percentFee("25"),
  TRI: percentFee("25"),
  SMARTFREN: percentFee("25"),
};

function tiersFor(channel: string): readonly TokopayFeeTier[] | undefined {
  return TOKOPAY_FEE_TABLE[channel.trim().toUpperCase()];
}

/** The estimated admin fee for `amount` on `channel`, in whole rupiah (half-up);
 *  null when the channel code is not in the table. */
export function estimateTokopayFee(channel: string, amount: Decimal.Value): Decimal | null {
  const tiers = tiersFor(channel);
  if (!tiers) return null;
  const value = new Decimal(amount);
  const tier = tiers.find((candidate) => candidate.upTo === null || value.lessThan(candidate.upTo));
  if (!tier) return null;
  return new Decimal(tier.flat)
    .plus(value.times(tier.percent).dividedBy(100))
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/** `totalAmount` plus the estimated fee; an unknown channel adds nothing. */
export function estimatedTokopayCharge(channel: string, totalAmount: Decimal.Value): Decimal {
  return new Decimal(totalAmount).plus(estimateTokopayFee(channel, totalAmount) ?? 0);
}

/** Plausibility cap on the fee implied by TokoPay's `total_bayar`:
 *  max(10%, twice the channel's highest table percent) of the total, plus Rp10.000. */
export const TOKOPAY_MAX_FEE_PERCENT = new Decimal(10);
export const TOKOPAY_MAX_FEE_FLAT = new Decimal(10000);

export type TokopayChargeReading =
  | { kind: "ok"; charge: Decimal }
  | { kind: "missing" }
  | { kind: "implausible" };

/**
 * Read TokoPay's `total_bayar` for an order. "ok" is a whole-rupiah figure at or
 * above the nominal sent to TokoPay whose implied fee is within the cap;
 * "missing" is a null or blank value; anything else is "implausible" and must
 * not be shown to a buyer or stored.
 */
export function readTokopayCharge(
  channel: string,
  totalAmount: Decimal.Value,
  totalBayar: string | null | undefined,
): TokopayChargeReading {
  if (totalBayar == null || totalBayar.trim() === "") return { kind: "missing" };
  let charge: Decimal;
  try {
    charge = new Decimal(totalBayar.trim());
  } catch {
    return { kind: "implausible" };
  }
  if (!charge.isFinite() || !charge.isInteger()) return { kind: "implausible" };
  // createTransaction sends `nominal` as `toFixed(0)` of the order total.
  const nominal = new Decimal(new Decimal(totalAmount).toFixed(0));
  if (charge.lessThan(nominal)) return { kind: "implausible" };
  const tiers = tiersFor(channel);
  const highestPercent = tiers ? Decimal.max(...tiers.map((tier) => new Decimal(tier.percent))) : new Decimal(0);
  const capPercent = Decimal.max(TOKOPAY_MAX_FEE_PERCENT, highestPercent.times(2));
  const cap = nominal.times(capPercent).dividedBy(100).plus(TOKOPAY_MAX_FEE_FLAT);
  if (charge.minus(nominal).greaterThan(cap)) return { kind: "implausible" };
  return { kind: "ok", charge };
}

/**
 * What the buyer must pay on a TokoPay order: the figure TokoPay reported when
 * the transaction was created, or — only when none was stored — the table
 * estimate. The ONE place this is decided; every paid-amount check, overpayment
 * check and fee figure derives from it (fee = charge - totalAmount).
 */
export function expectedTokopayCharge(
  order: { totalAmount: Decimal.Value; gatewayChargeAmount?: Decimal.Value | null },
  channel: string,
): Decimal {
  if (order.gatewayChargeAmount != null) return new Decimal(order.gatewayChargeAmount);
  return estimatedTokopayCharge(channel, order.totalAmount);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/payments/tokopayFee.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Check the package export and typecheck**

`@app/core/payments/tokopay` is imported by subpath elsewhere. Open `packages/core/package.json` and confirm the `exports` map covers `./payments/*` by wildcard; if each file is listed individually, add `./payments/tokopayFee` beside `./payments/tokopay` in the same form.

Run: `pnpm --filter @app/core typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/payments/tokopayFee.ts packages/core/src/payments/tokopayFee.test.ts packages/core/package.json
git commit -m "feat(core): TokoPay tariff table and expected-charge resolver" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```
(Leave `packages/core/package.json` out of `git add` if it was not changed.)

---

### Task 2: Order snapshot column and channel helper

**Files:**
- Modify: `prisma/schema.prisma` (model `Order`, after `paymentRef`, about line 688)
- Create: `prisma/migrations/20261111090000_order_gateway_charge_amount/migration.sql`
- Create: `prisma/migrations/20261111090100_order_gateway_charge_amount_backfill/migration.sql`
- Create: `packages/db/src/crud/_tokopayChannel.ts`
- Modify: `packages/db/src/crud/orders.ts:373-384` (`commitGatewayResult`)
- Modify: `packages/db/src/crud/tokopay.ts:46-62` (`getTokopayCreds` uses the helper)
- Test: `packages/db/src/crud/orders.test.ts` (or the existing test file that covers `commitGatewayResult`; find it with `grep -rn "commitGatewayResult" packages/db/src/crud/*.test.ts`), `packages/db/src/crud/tokopay.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `Order.gatewayChargeAmount: Decimal | null`
  - `commitGatewayResult(db: Db, orderId: number, sentinel: string, payload: unknown, gatewayChargeAmount?: Decimal.Value | null): Promise<boolean>`
  - `getTokopayChannel(db: Db): Promise<string>` exported from `packages/db/src/crud/_tokopayChannel.ts` and re-exported from `packages/db/src/crud/tokopay.ts`

- [ ] **Step 1: Write the failing tests**

Add to the test file that already covers `commitGatewayResult` (use that file's existing order-creation helper and `claimGatewaySlot`):

```ts
it("stores the gateway charge together with the cached gateway result", async () => {
  const order = await createPendingOrder(); // the file's existing helper
  const sentinel = await claimGatewaySlot(prisma, order.id);
  const ok = await commitGatewayResult(prisma, order.id, sentinel!, { gateway: "tokopay", trxId: "TP1" }, new Decimal("50025"));
  expect(ok).toBe(true);
  const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(row.gatewayChargeAmount!.toString()).toBe("50025");
  expect(JSON.parse(row.paymentRef!).trxId).toBe("TP1");
});

it("writes neither the cache nor the charge when the claim sentinel no longer matches", async () => {
  const order = await createPendingOrder();
  const ok = await commitGatewayResult(prisma, order.id, "not-the-sentinel", { gateway: "tokopay" }, new Decimal("50025"));
  expect(ok).toBe(false);
  const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(row.gatewayChargeAmount).toBeNull();
});

it("leaves the charge null when none is passed", async () => {
  const order = await createPendingOrder();
  const sentinel = await claimGatewaySlot(prisma, order.id);
  await commitGatewayResult(prisma, order.id, sentinel!, { gateway: "paydisini" });
  const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(row.gatewayChargeAmount).toBeNull();
});
```

Add to `packages/db/src/crud/tokopay.test.ts`, next to the existing `getTokopayCreds` minAmount tests (about line 846):

```ts
describe("getTokopayChannel", () => {
  it("defaults to QRIS when the setting is absent or blank", async () => {
    expect(await getTokopayChannel(prisma)).toBe("QRIS");
    await setSetting(prisma, "tokopay_default_channel", "   ");
    expect(await getTokopayChannel(prisma)).toBe("QRIS");
  });

  it("returns the trimmed configured channel", async () => {
    await setSetting(prisma, "tokopay_default_channel", " QRISREALTIME ");
    expect(await getTokopayChannel(prisma)).toBe("QRISREALTIME");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/db/src/crud/tokopay.test.ts <the commitGatewayResult test file>`
Expected: FAIL — `getTokopayChannel` is not exported; `gatewayChargeAmount` does not exist on the Order type.

- [ ] **Step 3: Add the column to the schema**

In `prisma/schema.prisma`, model `Order`, directly after the `paymentRef` line:

```prisma
  /// What the gateway said the buyer must pay, fee included (TokoPay's
  /// `total_bayar`), written in the same statement that caches the gateway
  /// result in `paymentRef`. TokoPay payments are matched against THIS figure,
  /// so a tariff change at the gateway can never make a paid order look short.
  /// Null = the gateway reported no total (or this is not a TokoPay order);
  /// readers then fall back to an estimate — see `expectedTokopayCharge`
  /// (@app/core/payments/tokopayFee).
  gatewayChargeAmount    Decimal?  @map("gateway_charge_amount")
```

- [ ] **Step 4: Write the two migrations**

`prisma/migrations/20261111090000_order_gateway_charge_amount/migration.sql`:

```sql
-- The fee-inclusive amount the payment gateway said the buyer must pay.
ALTER TABLE "orders" ADD COLUMN "gateway_charge_amount" DECIMAL(65,30);
```

`prisma/migrations/20261111090100_order_gateway_charge_amount_backfill/migration.sql`:

```sql
-- Freeze every existing TokoPay order at the fee formula that was in force when
-- it was created (Rp100 + 0.70%, rounded half up to whole rupiah), so replacing
-- that formula in code does not change how past overpaid/underpaid orders are
-- evaluated. Idempotent: only rows without a stored figure are touched.
UPDATE "orders"
SET "gateway_charge_amount" = "total_amount" + ROUND(100 + "total_amount" * 0.007)
WHERE "payment_method" = 'TOKOPAY'
  AND "currency" = 'IDR'
  AND "gateway_charge_amount" IS NULL;
```

Run: `pnpm prisma:generate`
Then apply to the worktree's own database only (confirm `DATABASE_URL_PRISMA` in this worktree's `.env` points at it): `pnpm exec prisma db push --skip-generate`
Expected: "Your database is now in sync with your Prisma schema."

- [ ] **Step 5: Add the channel helper**

```ts
// packages/db/src/crud/_tokopayChannel.ts
/**
 * The TokoPay channel code the shop sends as `metode` (default "QRIS").
 * A leaf module — it imports only the settings reader — so crud files that
 * crud/tokopay.ts itself imports (orderStatus.ts, wallet_topup.ts) can read
 * the channel without an import cycle.
 */
import { TOKOPAY_CHANNEL_KEY } from "@app/core/payments/tokopay";
import type { Db } from "./_types";
import { getSetting } from "./settings";

export async function getTokopayChannel(db: Db): Promise<string> {
  return ((await getSetting(db, TOKOPAY_CHANNEL_KEY)) ?? "QRIS").trim() || "QRIS";
}
```

In `packages/db/src/crud/tokopay.ts`: add `export { getTokopayChannel } from "./_tokopayChannel";` and `import { getTokopayChannel } from "./_tokopayChannel";`, then make `getTokopayCreds` use it — replace `getSetting(db, TOKOPAY_CHANNEL_KEY)` in the `Promise.all` with `getTokopayChannel(db)` and the return field with `channel,`. Remove the now-unused `TOKOPAY_CHANNEL_KEY` import if nothing else in the file uses it.

- [ ] **Step 6: Extend `commitGatewayResult`**

Replace the function body in `packages/db/src/crud/orders.ts`:

```ts
export async function commitGatewayResult(
  db: Db,
  orderId: number,
  sentinel: string,
  payload: unknown,
  /** The fee-inclusive amount the gateway reported (TokoPay's `total_bayar`),
   *  stored with the cache in ONE statement so the two can never disagree.
   *  Omitted or null leaves `gatewayChargeAmount` untouched. */
  gatewayChargeAmount?: Decimal.Value | null,
): Promise<boolean> {
  const committed = await db.order.updateMany({
    where: { id: orderId, paymentRef: sentinel },
    data: {
      paymentRef: JSON.stringify(payload),
      ...(gatewayChargeAmount != null ? { gatewayChargeAmount: new Decimal(gatewayChargeAmount) } : {}),
    },
  });
  return committed.count === 1;
}
```

Keep the existing doc comment above it. Add `import { Decimal } from "@app/core/money";` if the file does not already import it.

- [ ] **Step 7: Run the tests and typecheck**

Run: `pnpm exec vitest run packages/db/src/crud/tokopay.test.ts <the commitGatewayResult test file>`
Expected: PASS.
Run: `pnpm --filter @app/db typecheck`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261111090000_order_gateway_charge_amount prisma/migrations/20261111090100_order_gateway_charge_amount_backfill packages/db/src/crud/_tokopayChannel.ts packages/db/src/crud/orders.ts packages/db/src/crud/tokopay.ts packages/db/src/crud/tokopay.test.ts <the commitGatewayResult test file>
git commit -m "feat(db): store the gateway's fee-inclusive charge on the order" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 3: Tariff-drift admin alert

**Files:**
- Modify: `packages/core/src/enums.ts` (after `ADMIN_OVERPAID`, about line 559)
- Modify: `packages/db/src/crud/notifications.ts` (after `enqueueAdminOverpaid`)
- Modify: `packages/outbox-dispatcher/src/dispatcher.ts:106` (`ADMIN_DM_EVENTS`)
- Modify: `packages/outbox-dispatcher/src/templates.ts` (after the `ADMIN_OVERPAID` branch, about line 836)
- Test: `packages/db/src/crud/notifications.test.ts`, and the dispatcher's template test (find with `grep -rln "ADMIN_OVERPAID" packages/outbox-dispatcher`)

**Interfaces:**
- Produces:
  - `NotificationEvent.ADMIN_TOKOPAY_FEE_DRIFT = "ADMIN_TOKOPAY_FEE_DRIFT"`
  - `TOKOPAY_FEE_DRIFT_ALERTED_AT_KEY = "tokopay_fee_drift_alerted_at"`
  - `TOKOPAY_FEE_DRIFT_ALERT_INTERVAL_MS = 86_400_000`
  - `enqueueAdminTokopayFeeDrift(db: PrismaClient, args: { orderId: number; orderCode: string; channel: string; total: Decimal; estimated: Decimal; reported: string; reason: "drift" | "implausible" }, now?: Date): Promise<boolean>` — true when the alert was queued, false when one was already sent in the last 24 hours.

- [ ] **Step 1: Write the failing tests**

In `packages/db/src/crud/notifications.test.ts` (reuse the file's existing admin seeding so `resolveAdminIds` returns at least one admin):

```ts
describe("enqueueAdminTokopayFeeDrift", () => {
  const args = {
    orderId: 0, // replaced per test with a real order id
    orderCode: "ORD-DRIFT",
    channel: "QRIS",
    total: new Decimal("50000"),
    estimated: new Decimal("50025"),
    reported: "50450",
    reason: "drift" as const,
  };

  it("queues one DM per admin carrying both figures", async () => {
    const order = await createPendingOrder(); // the file's existing helper
    const queued = await enqueueAdminTokopayFeeDrift(prisma, { ...args, orderId: order.id });
    expect(queued).toBe(true);
    const rows = await prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.ADMIN_TOKOPAY_FEE_DRIFT } });
    expect(rows).toHaveLength((await resolveAdminIds(prisma)).length);
    expect(JSON.parse(rows[0]!.payloadJson)).toMatchObject({
      order_code: "ORD-DRIFT",
      channel: "QRIS",
      total: "50000",
      estimated: "50025",
      reported: "50450",
      reason: "drift",
    });
  });

  it("queues nothing a second time within 24 hours, and queues again after that", async () => {
    const order = await createPendingOrder();
    const t0 = new Date("2026-11-11T00:00:00Z");
    expect(await enqueueAdminTokopayFeeDrift(prisma, { ...args, orderId: order.id }, t0)).toBe(true);
    const almostADayLater = new Date(t0.getTime() + TOKOPAY_FEE_DRIFT_ALERT_INTERVAL_MS - 1);
    expect(await enqueueAdminTokopayFeeDrift(prisma, { ...args, orderId: order.id }, almostADayLater)).toBe(false);
    const aDayLater = new Date(t0.getTime() + TOKOPAY_FEE_DRIFT_ALERT_INTERVAL_MS);
    expect(await enqueueAdminTokopayFeeDrift(prisma, { ...args, orderId: order.id }, aDayLater)).toBe(true);
    const admins = (await resolveAdminIds(prisma)).length;
    expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.ADMIN_TOKOPAY_FEE_DRIFT } })).toBe(admins * 2);
  });
});
```

In the dispatcher's template test, mirroring the existing `ADMIN_OVERPAID` case:

```ts
it("renders the TokoPay tariff-drift alert in both languages with both figures", () => {
  const text = renderTemplate(NotificationEvent.ADMIN_TOKOPAY_FEE_DRIFT, {
    order_code: "ORD-1", channel: "QRIS", total: "50000", estimated: "50025", reported: "50450", reason: "drift",
  });
  expect(text).toContain("ORD-1");
  expect(text).toContain("50025");
  expect(text).toContain("50450");
  expect(text).toContain("TokoPay");
  expect(text).toContain("tarif");
});

it("says no QR was shown when TokoPay's total was implausible", () => {
  const text = renderTemplate(NotificationEvent.ADMIN_TOKOPAY_FEE_DRIFT, {
    order_code: "ORD-2", channel: "QRIS", total: "50000", estimated: "50025", reported: "9999999", reason: "implausible",
  });
  expect(text).toContain("no QR");
  expect(text).toContain("tidak ditampilkan");
});
```
(Use the function name that file already imports for rendering if it is not `renderTemplate`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/db/src/crud/notifications.test.ts <the template test file>`
Expected: FAIL — `ADMIN_TOKOPAY_FEE_DRIFT` and `enqueueAdminTokopayFeeDrift` do not exist.

- [ ] **Step 3: Add the event**

In `packages/core/src/enums.ts`, directly after the `ADMIN_OVERPAID: "ADMIN_OVERPAID",` line:

```ts
  // Admin DM (not a channel post): TokoPay's fee-inclusive total for a new
  // order differed from the built-in tariff estimate (the tariff changed at
  // the gateway), or was implausible and no QR was shown. At most one per 24
  // hours. payload carries `chat_id` plus order_code/channel/total/estimated/
  // reported/reason. Same fan-out-per-admin shape as ADMIN_OVERPAID.
  ADMIN_TOKOPAY_FEE_DRIFT: "ADMIN_TOKOPAY_FEE_DRIFT",
```

In `packages/outbox-dispatcher/src/dispatcher.ts`, add to `ADMIN_DM_EVENTS` after the `ADMIN_OVERPAID` line:

```ts
  NotificationEvent.ADMIN_TOKOPAY_FEE_DRIFT, // admin DM (TokoPay's total differs from the built-in tariff estimate)
```

- [ ] **Step 4: Add the enqueue helper**

In `packages/db/src/crud/notifications.ts`, after `enqueueAdminOverpaid` (add `import type { PrismaClient } from "../client";` and `import { isUniqueViolation } from "./_types";` if missing):

```ts
export const TOKOPAY_FEE_DRIFT_ALERTED_AT_KEY = "tokopay_fee_drift_alerted_at";
export const TOKOPAY_FEE_DRIFT_ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Tell every admin that TokoPay's fee-inclusive total for a new order is not
 * what the built-in tariff table predicts — the gateway changed its tariff —
 * or that the total was implausible and no QR was shown.
 *
 * At most one alert per 24 hours: a changed tariff makes EVERY new order
 * differ, and one message is enough to get the table updated. The limiter is a
 * timestamp under an internal settings key (not shown in the admin Settings
 * page), claimed with a compare-and-swap BEFORE the rows are written, so two
 * checkouts racing here queue one alert, not two. It is claimed outside a
 * transaction on purpose: a lost race surfaces as a unique violation, which
 * would abort an enclosing Postgres transaction.
 *
 * Returns true when the alert was queued.
 */
export async function enqueueAdminTokopayFeeDrift(
  db: PrismaClient,
  args: {
    orderId: number;
    orderCode: string;
    channel: string;
    total: Decimal;
    estimated: Decimal;
    /** TokoPay's `total_bayar` exactly as received (it may not be a number). */
    reported: string;
    reason: "drift" | "implausible";
  },
  now: Date = new Date(),
): Promise<boolean> {
  const stamp = now.toISOString();
  const prior = await db.setting.findUnique({ where: { key: TOKOPAY_FEE_DRIFT_ALERTED_AT_KEY } });
  if (prior) {
    const last = Date.parse(prior.value);
    if (Number.isFinite(last) && now.getTime() - last < TOKOPAY_FEE_DRIFT_ALERT_INTERVAL_MS) return false;
    const claimed = await db.setting.updateMany({
      where: { key: TOKOPAY_FEE_DRIFT_ALERTED_AT_KEY, value: prior.value },
      data: { value: stamp },
    });
    if (claimed.count !== 1) return false;
  } else {
    try {
      await db.setting.create({ data: { key: TOKOPAY_FEE_DRIFT_ALERTED_AT_KEY, value: stamp } });
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  }
  for (const adminId of await resolveAdminIds(db)) {
    await db.notificationOutbox.create({
      data: {
        event: NotificationEvent.ADMIN_TOKOPAY_FEE_DRIFT,
        orderId: args.orderId,
        payloadJson: JSON.stringify({
          chat_id: adminId,
          order_code: args.orderCode,
          channel: args.channel,
          total: args.total.toString(),
          estimated: args.estimated.toString(),
          reported: args.reported.slice(0, 40),
          reason: args.reason,
        }),
      },
    });
  }
  return true;
}
```

- [ ] **Step 5: Add the template**

In `packages/outbox-dispatcher/src/templates.ts`, directly before the `if (event === NotificationEvent.ADMIN_OVERPAID) {` branch:

```ts
  if (event === NotificationEvent.ADMIN_TOKOPAY_FEE_DRIFT) {
    // Admin DM: TokoPay's fee-inclusive total for a new order is not what the
    // built-in tariff table predicts. `reported` is gateway text, so it is
    // escaped like everything else.
    const code = escape(String(payload.order_code ?? ""));
    const channel = escape(String(payload.channel ?? ""));
    const total = escape(String(payload.total ?? "0"));
    const estimated = escape(String(payload.estimated ?? "0"));
    const reported = escape(String(payload.reported ?? ""));
    const implausible = payload.reason === "implausible";
    const outcomeEn = implausible
      ? `That total is not plausible, so no QR was shown and the buyer was asked to try again. Check the TokoPay dashboard.`
      : `The payment is processed with TokoPay's figure, so nothing is stuck. TokoPay's tariff appears to have changed: ask the developer to update the built-in estimate table so the storefront checkout shows the right fee.`;
    const outcomeId = implausible
      ? `Angka itu tidak wajar, jadi QR tidak ditampilkan dan pembeli diminta mencoba lagi. Cek dashboard TokoPay.`
      : `Pembayaran diproses dengan angka TokoPay, jadi tidak ada yang tertahan. Tampaknya tarif TokoPay berubah: minta developer memperbarui tabel perkiraan supaya checkout web menampilkan biaya yang benar.`;
    return (
      `⚠️ <b>TokoPay total differs from the estimate — order <code>${code}</code></b>\n` +
      `Channel: <b>${channel}</b>\n` +
      `Order total: <b>${total} IDR</b>\n` +
      `Our estimate: <b>${estimated} IDR</b>\n` +
      `TokoPay says: <b>${reported} IDR</b>\n` +
      `${outcomeEn}\n\n` +
      `⚠️ <b>Total TokoPay berbeda dari perkiraan — pesanan <code>${code}</code></b>\n` +
      `Channel: <b>${channel}</b>\n` +
      `Total pesanan: <b>${total} IDR</b>\n` +
      `Perkiraan kita: <b>${estimated} IDR</b>\n` +
      `Angka TokoPay: <b>${reported} IDR</b>\n` +
      `${outcomeId}`
    );
  }
```

If `templates.ts` or the dispatcher has an exhaustive list or switch of events (a typecheck error will say so), add the new event there in the same form as `ADMIN_OVERPAID`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm exec vitest run packages/db/src/crud/notifications.test.ts <the template test file>`
Expected: PASS.
Run: `pnpm --filter @app/core typecheck && pnpm --filter @app/db typecheck && pnpm --filter @app/outbox-dispatcher typecheck`
Expected: exits 0. (Use the package names from each `package.json` if they differ.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/enums.ts packages/db/src/crud/notifications.ts packages/db/src/crud/notifications.test.ts packages/outbox-dispatcher/src/dispatcher.ts packages/outbox-dispatcher/src/templates.ts <the template test file>
git commit -m "feat: admin alert when TokoPay's total differs from the tariff estimate" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 4: `commitTokopayGateway`

**Files:**
- Modify: `packages/db/src/crud/tokopay.ts` (add after `getTokopayCreds`)
- Test: `packages/db/src/crud/tokopay.test.ts`

**Interfaces:**
- Consumes: `readTokopayCharge`, `estimatedTokopayCharge` (Task 1); `commitGatewayResult` with the fifth argument (Task 2); `enqueueAdminTokopayFeeDrift` (Task 3); `TokopayOrderInfo` from `@app/core/payments/tokopay`.
- Produces:
  - `class TokopayImplausibleChargeError extends Error`
  - `commitTokopayGateway(db: PrismaClient, args: { order: { id: number; orderCode: string; totalAmount: Decimal.Value }; channel: string; sentinel: string; gateway: TokopayOrderInfo }): Promise<{ committed: boolean; charge: Decimal }>` — `charge` is what to show the buyer: TokoPay's figure, or the estimate when TokoPay reported none. Throws `TokopayImplausibleChargeError` when the figure is implausible (nothing is stored).

- [ ] **Step 1: Write the failing tests**

In `packages/db/src/crud/tokopay.test.ts` (use the file's existing pending-TokoPay-order helper; totals below assume an order whose `totalAmount` is 50000 — create one with that total):

```ts
describe("commitTokopayGateway", () => {
  const gatewayInfo = (totalBayar: string | null) => ({
    trxId: "TP-COMMIT", payUrl: null, qrLink: "https://qr.example/x.png", qrString: null, totalBayar,
  });
  const driftRows = () => prisma.notificationOutbox.count({ where: { event: NotificationEvent.ADMIN_TOKOPAY_FEE_DRIFT } });

  it("stores TokoPay's total and raises no alert when it equals the estimate", async () => {
    const order = await createPendingTokopayOrder("50000");
    const sentinel = (await claimGatewaySlot(prisma, order.id))!;
    const r = await commitTokopayGateway(prisma, { order, channel: "QRIS", sentinel, gateway: gatewayInfo("50025") });
    expect(r.committed).toBe(true);
    expect(r.charge.toString()).toBe("50025");
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.gatewayChargeAmount!.toString()).toBe("50025");
    expect(await driftRows()).toBe(0);
  });

  it("stores a total that differs from the estimate and alerts the admins", async () => {
    const order = await createPendingTokopayOrder("50000");
    const sentinel = (await claimGatewaySlot(prisma, order.id))!;
    const r = await commitTokopayGateway(prisma, { order, channel: "QRIS", sentinel, gateway: gatewayInfo("50450") });
    expect(r.charge.toString()).toBe("50450");
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.gatewayChargeAmount!.toString()).toBe("50450");
    expect(await driftRows()).toBeGreaterThan(0);
  });

  it("leaves the snapshot null and returns the estimate when TokoPay reports no total", async () => {
    const order = await createPendingTokopayOrder("50000");
    const sentinel = (await claimGatewaySlot(prisma, order.id))!;
    const r = await commitTokopayGateway(prisma, { order, channel: "QRIS", sentinel, gateway: gatewayInfo(null) });
    expect(r.committed).toBe(true);
    expect(r.charge.toString()).toBe("50025");
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.gatewayChargeAmount).toBeNull();
    expect(JSON.parse(row.paymentRef!).trxId).toBe("TP-COMMIT");
    expect(await driftRows()).toBe(0);
  });

  it("stores nothing, alerts and throws when the total is below the order total", async () => {
    const order = await createPendingTokopayOrder("50000");
    const sentinel = (await claimGatewaySlot(prisma, order.id))!;
    await expect(
      commitTokopayGateway(prisma, { order, channel: "QRIS", sentinel, gateway: gatewayInfo("49000") }),
    ).rejects.toBeInstanceOf(TokopayImplausibleChargeError);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.gatewayChargeAmount).toBeNull();
    expect(row.paymentRef).toBe(sentinel);
    expect(await driftRows()).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/db/src/crud/tokopay.test.ts -t "commitTokopayGateway"`
Expected: FAIL — `commitTokopayGateway` is not exported.

- [ ] **Step 3: Implement**

In `packages/db/src/crud/tokopay.ts`, add the imports (`readTokopayCharge`, `estimatedTokopayCharge` from `@app/core/payments/tokopayFee`; `type TokopayOrderInfo` from `@app/core/payments/tokopay`; `commitGatewayResult` from `./orders`; `enqueueAdminTokopayFeeDrift` from `./notifications`) and, after `getTokopayCreds`:

```ts
/** TokoPay's `total_bayar` for a new transaction failed the plausibility check
 *  (`readTokopayCharge`), so no QR may be shown for it. */
export class TokopayImplausibleChargeError extends Error {}

/**
 * Cache a freshly created TokoPay transaction on its order AND record what
 * TokoPay says the buyer must pay — the figure every later paid-amount check
 * reads (`expectedTokopayCharge`). The three places that create a TokoPay
 * transaction (storefront pay page, bot checkout, bot wallet top-up) all go
 * through here so none of them can cache a transaction without its charge.
 *
 * Returns the charge to SHOW the buyer: TokoPay's own figure, or the tariff
 * estimate when TokoPay reported none. Alerts the admins (rate-limited) when
 * TokoPay's figure differs from the estimate, and never lets an alert failure
 * fail the checkout.
 */
export async function commitTokopayGateway(
  db: PrismaClient,
  args: {
    order: { id: number; orderCode: string; totalAmount: Decimal.Value };
    channel: string;
    sentinel: string;
    gateway: TokopayOrderInfo;
  },
): Promise<{ committed: boolean; charge: Decimal }> {
  const total = new Decimal(args.order.totalAmount);
  const estimated = estimatedTokopayCharge(args.channel, total);
  const reading = readTokopayCharge(args.channel, total, args.gateway.totalBayar);
  const alert = (reason: "drift" | "implausible") =>
    enqueueAdminTokopayFeeDrift(db, {
      orderId: args.order.id,
      orderCode: args.order.orderCode,
      channel: args.channel,
      total,
      estimated,
      reported: args.gateway.totalBayar ?? "",
      reason,
    }).catch((err) => {
      logger.error(
        { err, orderId: args.order.id },
        `Could not queue the admin alert that TokoPay's total for order ${args.order.orderCode} differs from the tariff estimate — the checkout itself is unaffected, but nobody was told the tariff may have changed`,
      );
      return false;
    });

  if (reading.kind === "implausible") {
    await alert("implausible");
    throw new TokopayImplausibleChargeError(
      `TokoPay reported an implausible total for order ${args.order.orderCode} (order total ${total.toString()}), so no payment instructions were shown`,
    );
  }
  const committed = await commitGatewayResult(
    db,
    args.order.id,
    args.sentinel,
    { gateway: "tokopay", ...args.gateway },
    reading.kind === "ok" ? reading.charge : null,
  );
  if (reading.kind === "missing") {
    logger.warn(
      `TokoPay created a transaction for order ${args.order.orderCode} without reporting the total the buyer must pay, so the order has no stored gateway charge — its payment will be checked against the built-in tariff estimate (${estimated.toString()}), which is only right while that table matches TokoPay's current tariff`,
    );
    return { committed, charge: estimated };
  }
  if (!reading.charge.equals(estimated)) await alert("drift");
  return { committed, charge: reading.charge };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm exec vitest run packages/db/src/crud/tokopay.test.ts`
Expected: PASS (the whole file, to catch regressions in the settle tests).
Run: `pnpm --filter @app/db typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/tokopay.ts packages/db/src/crud/tokopay.test.ts
git commit -m "feat(db): commitTokopayGateway stores TokoPay's charge and flags tariff drift" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 5: Matching and bookkeeping read the resolver (db package)

**Files:**
- Modify: `packages/db/src/crud/tokopay.ts` (`deliverPaidTokopayOrder`: lines 298, 342, 378, 403 and the comment at 313-338)
- Modify: `packages/db/src/crud/overpayments.ts:110-142`
- Modify: `packages/db/src/crud/orderStatus.ts:297-303`
- Modify: `packages/db/src/crud/manualMatch.ts:130-139`, `:188-199`, `:281`
- Modify: `packages/db/src/crud/wallet_topup.ts:1105-1110`
- Test: `packages/db/src/crud/tokopay.test.ts`, `overpayments.test.ts`, `manualMatch.test.ts`, `wallet_topup_overpaid.test.ts`, `ledger.regression.test.ts`, `idrDiscountRounding.test.ts`, plus the test file covering `markOrderUnderpaid` and `creditUnderpaidTopupAnyway` (find with `grep -rln "markOrderUnderpaid\|creditUnderpaidTopupAnyway" packages/db/src/crud/*.test.ts`)

**Interfaces:**
- Consumes: `expectedTokopayCharge`, `estimatedTokopayCharge`, `estimateTokopayFee` (Task 1); `getTokopayChannel` (Task 2); `Order.gatewayChargeAmount` (Task 2).
- Produces: no new exports. After this task no file under `packages/db/src` imports `computeQrisAdminFee` or `qrisChargeAmount`.

- [ ] **Step 1: Write the failing tests**

Add these cases (each uses its file's existing helpers; set the snapshot directly with `prisma.order.update({ where: { id }, data: { gatewayChargeAmount: new Decimal("50450") } })` on a TokoPay order whose `totalAmount` is 50000 — 50450 deliberately differs from the 50025 estimate):

`packages/db/src/crud/tokopay.test.ts`:

```ts
describe("deliverPaidTokopayOrder — expected charge comes from the order's stored gateway charge", () => {
  it("delivers without an overpaid flag when the payment equals a snapshot above the estimate", async () => {
    const order = await createPendingTokopayOrder("50000");
    await prisma.order.update({ where: { id: order.id }, data: { gatewayChargeAmount: new Decimal("50450") } });
    const r = await deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId: "TP-SNAP-1", amount: "50450" });
    expect(r.status === "delivered" || r.status === "processing").toBe(true);
    const ledger = await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "TP-SNAP-1" } });
    expect(ledger.outcome).toBe("matched");
  });

  it("flags overpaid by the excess over the snapshot, not over the estimate", async () => {
    const order = await createPendingTokopayOrder("50000");
    await prisma.order.update({ where: { id: order.id }, data: { gatewayChargeAmount: new Decimal("50450") } });
    await deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId: "TP-SNAP-2", amount: "50500" });
    const ledger = await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "TP-SNAP-2" } });
    expect(ledger.outcome).toBe("overpaid");
    const alert = await prisma.notificationOutbox.findFirstOrThrow({ where: { event: NotificationEvent.ADMIN_OVERPAID, orderId: order.id } });
    expect(JSON.parse(alert.payloadJson)).toMatchObject({ expected: "50450", excess: "50" });
  });

  it("records Payment.fee as snapshot minus total", async () => {
    // Mirror the existing "fee capture (Financial Ledger M3)" test's setup (a PENDING Payment row),
    // then set gatewayChargeAmount to 50450 on a 50000 order before delivering 50450.
    // Assert: payment.fee.toString() === "450" and payment.netAmount.toString() === "50000".
  });

  it("falls back to the tariff estimate when the order has no snapshot", async () => {
    const order = await createPendingTokopayOrder("50000");
    await deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId: "TP-SNAP-4", amount: "50026" });
    const ledger = await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "TP-SNAP-4" } });
    expect(ledger.outcome).toBe("overpaid"); // 50026 is Rp1 above the 50025 estimate
  });
});
```
Write the third test out in full using the existing M3 fee-capture test in the same file (about line 369) as the setup template; it must not stay a comment.

`overpayments.test.ts` — add beside the existing TokoPay case (about line 168):

```ts
it("measures a TokoPay excess against the order's stored gateway charge", async () => {
  // existing TokoPay overpaid setup, order total 50000, plus:
  await prisma.order.update({ where: { id: order.id }, data: { gatewayChargeAmount: new Decimal("50450") } });
  // ledger row: outcome "overpaid", amount 50500
  const found = await findOverpaidExcess(prisma, order.id);
  expect(found!.expectedAmount.toString()).toBe("50450");
  expect(found!.excess.toString()).toBe("50");
});
```

`manualMatch.test.ts` — add:

```ts
it("requires the stored gateway charge, not the estimate, to match a TokoPay row", async () => {
  // order total 50000 with gatewayChargeAmount 50450; unmatched ledger row of 50025
  await expect(manualMatchLedgerTx(/* existing args shape */)).rejects.toMatchObject({ key: "error.manual_match_amount_short" });
  // the same order with a row of 50450 matches
});
```
Write it out with the file's existing arrange helpers and call shape.

The `markOrderUnderpaid` test file — add:

```ts
it("accepts an expected amount equal to the order's stored gateway charge", async () => {
  const order = await createPendingTokopayOrder("50000");
  await prisma.order.update({ where: { id: order.id }, data: { gatewayChargeAmount: new Decimal("50450") } });
  expect(await markOrderUnderpaid(prisma, { orderId: order.id, gateway: "TokoPay", receivedAmount: "50000", expectedAmount: "50450" })).toBe(true);
});

it("refuses an expected amount that is neither the total nor the stored gateway charge", async () => {
  const order = await createPendingTokopayOrder("50000");
  await prisma.order.update({ where: { id: order.id }, data: { gatewayChargeAmount: new Decimal("50450") } });
  expect(await markOrderUnderpaid(prisma, { orderId: order.id, gateway: "TokoPay", receivedAmount: "50000", expectedAmount: "50025" })).toBe(false);
});
```

The `creditUnderpaidTopupAnyway` test file — add:

```ts
it("deducts the fee implied by the stored gateway charge before crediting an underpaid TokoPay top-up", async () => {
  // UNDERPAID wallet top-up, total 50000, gatewayChargeAmount 50450, received 40450
  const r = await creditUnderpaidTopupAnyway(prisma, { orderId: order.id, adminId: admin.id });
  expect(r.credited.toString()).toBe("40000"); // 40450 - 450
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm exec vitest run packages/db/src/crud/tokopay.test.ts packages/db/src/crud/overpayments.test.ts packages/db/src/crud/manualMatch.test.ts <the two found test files>`
Expected: the new cases FAIL (expected 50450, got 50025-based figures); existing cases still pass.

- [ ] **Step 3: `deliverPaidTokopayOrder`**

In `packages/db/src/crud/tokopay.ts`, inside the `$transaction` callback, directly after the `pendingPayment` lookup (before `if (order.kind === OrderKind.WALLET_TOPUP)`), add:

```ts
        // What this buyer was asked to pay: TokoPay's own figure stored on the
        // order when its transaction was created, or the tariff estimate for an
        // order that has none (`expectedTokopayCharge`). The surcharge is the
        // difference to the order total.
        const expectedCharge = expectedTokopayCharge(order, await getTokopayChannel(tx));
        const gatewayFee = expectedCharge.minus(order.totalAmount);
```

Then:
- line 298: `expected: qrisChargeAmount(order.totalAmount),` → `expected: expectedCharge,`
- lines 342 and 378: `fee: computeQrisAdminFee(order.totalAmount),` → `fee: gatewayFee,`
- line 403: delete `const expectedCharge = qrisChargeAmount(order.totalAmount);` (the outer one is now in scope).

Rewrite the comment block at lines 287-293 and 319-338 to match the new source. Replace the paragraph that begins "`fee` is `computeQrisAdminFee(order.totalAmount)`" through "Pinned by a test in crud/tokopay.test.ts." with:

```ts
            // `fee` is the QRIS surcharge the buyer pays ON TOP of the order
            // total — the order's stored gateway charge minus its total — so
            // `netAmount` is the total itself, not `amount - fee`. The surcharge
            // never becomes this shop's money; the total IS what the shop nets.
            //
            // Captured as DATA only — no `FEE` ledger posting is made from it.
            // It is the BUYER-side surcharge, not a cut TokoPay reported having
            // deducted from the shop, and the `ORDER_PAYMENT` posting that
            // settling this order already made (crud/ledgerPostings.ts) books
            // `order.totalAmount` — the net receipt — so booking the surcharge
            // separately would double-count. For an order without a stored
            // gateway charge the figure is the tariff estimate. `payment_fee.idr`
            // and `FinancialTransactionType.FEE` stay unused until a rail
            // reports a real merchant fee. Pinned by a test in
            // crud/tokopay.test.ts.
```

and the wallet top-up overpayment comment (the sentence starting "`qrisChargeAmount` is our LOCAL estimate") with:

```ts
          // The comparison is against what TokoPay said this buyer must pay
          // (`expectedCharge` above). No tolerance is added, to stay consistent
          // with the product branch; the admin alert shows the excess.
```

Update the import block at the top: drop `computeQrisAdminFee, qrisChargeAmount,` and import `expectedTokopayCharge` from `@app/core/payments/tokopayFee` (merge with the Task 4 import).

- [ ] **Step 4: `overpayments.ts`**

Add `gatewayChargeAmount: true` to the `select` at line 112. Before the `candidates` array add:

```ts
  const tokopayChannel = tokopay ? await getTokopayChannel(db) : "QRIS";
```

and change the TokoPay candidate to:

```ts
    {
      gateway: PaymentMethod.TOKOPAY,
      amount: tokopay?.amount ?? null,
      expected: q4(expectedTokopayCharge({ totalAmount: total, gatewayChargeAmount: order.gatewayChargeAmount }, tokopayChannel)),
    },
```

In the doc comment above the array, replace "`qrisChargeAmount(total)` is what the buyer was asked for" with "`expectedTokopayCharge` (the order's stored gateway charge) is what the buyer was asked for". Swap the imports: remove `qrisChargeAmount`, add `expectedTokopayCharge` from `@app/core/payments/tokopayFee` and `getTokopayChannel` from `./_tokopayChannel`. Also update the comment at the top of the file (about line 32) that names the QRIS admin fee formula if it mentions `qrisChargeAmount`.

- [ ] **Step 5: `orderStatus.ts`**

Add `gatewayChargeAmount: true` to the `select` at line 297 and replace line 303 with:

```ts
    if (
      !expected.equals(order.totalAmount) &&
      !(gateway === "TOKOPAY" && expected.equals(expectedTokopayCharge(order, await getTokopayChannel(tx))))
    ) return false;
```

Swap the imports: remove `qrisChargeAmount`; add `expectedTokopayCharge` from `@app/core/payments/tokopayFee` and `getTokopayChannel` from `./_tokopayChannel` (NOT from `./tokopay` — that file imports this one).

- [ ] **Step 6: `manualMatch.ts`**

Replace `requiredAmount`:

```ts
function requiredAmount(
  gateway: keyof typeof GATEWAY_METHODS,
  order: { totalAmount: Decimal.Value; gatewayChargeAmount?: Decimal.Value | null },
  tokopayChannel: string,
): Decimal {
  switch (gateway) {
    case "tokopay":
      return expectedTokopayCharge(order, tokopayChannel);
    case "paydisini":
      return new Decimal(order.totalAmount);
    case "bybit":
      return new Decimal(order.totalAmount).minus(AMOUNT_TOLERANCE);
  }
}
```

In its doc comment, change the TokoPay bullet to "TokoPay: what TokoPay said the buyer must pay (the order's stored gateway charge, or the tariff estimate when none was stored), as the callback checks".

Callers:
- In `assertNotUnderpaidShortPayment` (about line 188): add `gatewayChargeAmount: true` to the `select`, and change the comparison to `new Decimal(row.amount).lessThan(requiredAmount(gateway, suggested, gateway === "tokopay" ? await getTokopayChannel(db) : "QRIS"))`. Compute the channel once at the top of the function into a `const tokopayChannel` and use it.
- About line 281: `const required = requiredAmount(gateway, order, gateway === "tokopay" ? await getTokopayChannel(db) : "QRIS");`

Swap the imports as in Step 5 (`getTokopayChannel` from `./_tokopayChannel`).

- [ ] **Step 7: `wallet_topup.ts`**

Replace line 1108:

```ts
      const fee =
        order.paymentMethod === PaymentMethod.TOKOPAY
          ? expectedTokopayCharge(order, await getTokopayChannel(tx)).minus(order.totalAmount)
          : ZERO;
```

Swap the imports (`getTokopayChannel` from `./_tokopayChannel`; this file is imported by `./tokopay`). Update the doc comment near line 924 if it names `computeQrisAdminFee` or the Rp100 + 0.7% formula: say "the fee implied by the order's stored gateway charge".

- [ ] **Step 8: Update the existing tests in this package that used the old helpers**

In `tokopay.test.ts`, `manualMatch.test.ts`, `overpayments.test.ts`, `wallet_topup_overpaid.test.ts`, `ledger.regression.test.ts`, `idrDiscountRounding.test.ts`:
- `qrisChargeAmount(x)` → `estimatedTokopayCharge("QRIS", x)`
- `computeQrisAdminFee(x)` → `estimateTokopayFee("QRIS", x)!`
- import both from `@app/core/payments/tokopayFee`.
- `tokopay.test.ts:298-300` re-derives `new Decimal(100).plus(total.times("0.007"))` inline: replace that expression with `estimateTokopayFee("QRIS", total)!`.

These tests create orders without a snapshot, so the estimate is what the code under test uses too. Where a test hard-codes a rupiah figure derived from the old formula for a total below Rp100.000, recompute it with the Rp25 rule.

Also update the one-line comment in `packages/db/src/crud/ledgerPostings.ts` (about line 816) that names the old formula or helper.

- [ ] **Step 9: Run the package's affected tests and typecheck**

Run: `pnpm exec vitest run packages/db/src/crud/tokopay.test.ts packages/db/src/crud/overpayments.test.ts packages/db/src/crud/manualMatch.test.ts packages/db/src/crud/wallet_topup_overpaid.test.ts packages/db/src/crud/ledger.regression.test.ts packages/db/src/crud/idrDiscountRounding.test.ts <the two found test files>`
Expected: PASS.
Run: `grep -rn "qrisChargeAmount\|computeQrisAdminFee" packages/db/src`
Expected: no output.
Run: `pnpm --filter @app/db typecheck`
Expected: exits 0.

Report the before and after test counts of each touched test file in your summary.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/crud/tokopay.ts packages/db/src/crud/overpayments.ts packages/db/src/crud/orderStatus.ts packages/db/src/crud/manualMatch.ts packages/db/src/crud/wallet_topup.ts packages/db/src/crud/ledgerPostings.ts <every test file you changed, by name>
git commit -m "fix(db): match TokoPay payments against the order's stored gateway charge" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 6: Storefront — preview, pay page, webhook

**Files:**
- Modify: `apps/storefront/src/routes/checkout.ts` (imports about `:102-104`; `:293-300`; `:1094-1099`, `:1118-1125`; `:1329`)
- Test: `apps/storefront/test/tokopay-webhook.test.ts`, `apps/storefront/test/spa-api.test.ts` or whichever storefront test covers the pay view and checkout totals (find with `grep -rln "qris_grand_total" apps/storefront/test`)

**Interfaces:**
- Consumes: `estimateTokopayFee`, `expectedTokopayCharge`, `estimatedTokopayCharge` (Task 1); `getTokopayChannel` (Task 2, exported from `@app/db` — check how `getTokopayCreds` is imported in this file and import `getTokopayChannel`, `commitTokopayGateway` the same way; add them to the `@app/db` barrel if exports are listed by name); `commitTokopayGateway` (Task 4).
- Produces: no new exports. API field names (`qris_admin_fee`, `qris_grand_total`) and their string type do not change.

- [ ] **Step 1: Write the failing tests**

In `apps/storefront/test/tokopay-webhook.test.ts` (reuse `createPendingTokopayOrder` and the file's existing `checkTransaction` mock; totals of 50000):

```ts
it("delivers when the live amount equals the stored gateway charge even though the tariff estimate differs", async () => {
  const order = await createPendingTokopayOrder("ORD-SNAP-OK", "50000");
  await prisma.order.update({ where: { id: order.id }, data: { gatewayChargeAmount: new Decimal("50450") } });
  mockLiveStatus({ paid: true, amount: "50450" }); // the file's existing way of stubbing checkTransaction
  const res = await postSignedCallback("ORD-SNAP-OK"); // the file's existing helper
  expect(res.json().status === "delivered" || res.json().status === "processing").toBe(true);
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).not.toBe("UNDERPAID");
});

it("flags UNDERPAID when the live amount is below the stored gateway charge", async () => {
  const order = await createPendingTokopayOrder("ORD-SNAP-SHORT", "50000");
  await prisma.order.update({ where: { id: order.id }, data: { gatewayChargeAmount: new Decimal("50450") } });
  mockLiveStatus({ paid: true, amount: "50025" });
  const res = await postSignedCallback("ORD-SNAP-SHORT");
  expect(res.json().status).toBe("amount mismatch");
  const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(row.status).toBe("UNDERPAID");
  const underpaid = await prisma.qrisUnderpaidTx.findFirstOrThrow({ where: { orderId: order.id } });
  expect(underpaid.expectedAmount.toString()).toBe("50450");
});

it("delivers a new-tariff payment (total + Rp25) on an order without a stored charge", async () => {
  const order = await createPendingTokopayOrder("ORD-NEWTARIFF", "50000");
  mockLiveStatus({ paid: true, amount: "50025" });
  const res = await postSignedCallback("ORD-NEWTARIFF");
  expect(res.json().status).not.toBe("amount mismatch");
});
```

In the storefront test that covers the pay view (mock `createTransaction` the way that file already does):

```ts
it("shows TokoPay's own total on the pay page and stores it on the order", async () => {
  // createTransaction resolves { trxId: "TP1", qrLink: "https://qr/x.png", qrString: null, payUrl: null, totalBayar: "50450" } for a 50000 TokoPay order
  const body = await getPayView(order.orderCode); // the file's existing helper
  expect(body.order.qris_grand_total).toBe("50450");
  expect(body.order.qris_admin_fee).toBe("450");
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).gatewayChargeAmount!.toString()).toBe("50450");
});

it("keeps showing the stored total on a refresh that reads the cached gateway result", async () => {
  // call getPayView twice; createTransaction must have been called once; second body.order.qris_grand_total === "50450"
});

it("shows the contact fallback and stores nothing when TokoPay's total is implausible", async () => {
  // createTransaction resolves totalBayar: "49000" for a 50000 order
  // assert: the body's gateway error flag is set (same flag the existing "gateway failure" test asserts),
  // order.gatewayChargeAmount is null, order.paymentRef is null (slot released)
});

it("previews the built-in estimate before any order exists", async () => {
  // cart total 50000 -> totals.qris_admin_fee "25", qris_grand_total "50025"
  // cart total 150000 -> qris_admin_fee "1150", qris_grand_total "151150"
});
```
Write each of these out in full with that file's existing arrange/act helpers; none may stay a comment.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm exec vitest run apps/storefront/test/tokopay-webhook.test.ts <the pay-view test file>`
Expected: the new cases FAIL.

- [ ] **Step 3: Checkout preview (`computeTotals`, about line 293)**

Replace the comment and the two lines:

```ts
  // QRIS admin fee preview so the checkout page can show it before the buyer
  // has picked a payment method. No TokoPay transaction exists yet, so this is
  // the built-in tariff ESTIMATE (@app/core/payments/tokopayFee) — the pay page
  // shows TokoPay's own figure once the transaction is created. Based on
  // `total` (net of bulk discount/voucher), which is the nominal sent to the
  // gateway. An unknown channel code previews no fee.
  const qrisAdminFee = estimateTokopayFee(await getTokopayChannel(prisma), total) ?? new Decimal(0);
  const qrisGrandTotal = total.plus(qrisAdminFee);
```

- [ ] **Step 4: Pay page (`payView`)**

Replace the comment at lines 1094-1097 and lines 1098-1099 with:

```ts
  // What the buyer must pay on a TokoPay order: TokoPay's own figure, stored on
  // the order when its transaction was created (expectedTokopayCharge). Until
  // that exists this is the tariff estimate; the creation branch below replaces
  // it with the figure TokoPay just returned.
  let qrisGrandTotal = isQris ? expectedTokopayCharge(order, await getTokopayChannel(prisma)) : null;
```

Inside the `try` at lines 1117-1125 replace the `commitGatewayResult` call and its `if (!committed)`:

```ts
            const result = await commitTokopayGateway(prisma, {
              order,
              channel: creds.channel,
              sentinel: claimSentinel,
              gateway,
            });
            qrisGrandTotal = result.charge;
            if (!result.committed) {
              logger.warn(`Created a TokoPay transaction for order ${order.orderCode} but couldn't cache it — the order's payment reference changed elsewhere during the external call.`);
            }
```

`commitTokopayGateway` throws `TokopayImplausibleChargeError` on an implausible total; the existing `catch` already releases the slot and sets `gatewayError = true`. In that `catch`, set `gateway = null;` as its first statement so a QR from the rejected response is never rendered.

Directly after the closing brace of the `if (isQris && state === "waiting") { ... }` block add:

```ts
  const qrisAdminFee = qrisGrandTotal ? qrisGrandTotal.minus(order.totalAmount) : null;
```

- [ ] **Step 5: Webhook (line 1329)**

```ts
    const expectedCharge = expectedTokopayCharge(order, creds.channel);
```

- [ ] **Step 6: Imports**

Remove `computeQrisAdminFee` and `qrisChargeAmount` from the `@app/core/payments/tokopay` import. Add `import { estimateTokopayFee, expectedTokopayCharge } from "@app/core/payments/tokopayFee";` and import `getTokopayChannel`, `commitTokopayGateway` where `getTokopayCreds` is imported. Remove the `commitGatewayResult` import only if the PayDisini/NOWPayments branches no longer use it (they do — keep it).

- [ ] **Step 7: Update existing tests that used the old helpers**

In `apps/storefront/test/tokopay-webhook.test.ts`: `qrisChargeAmount(x)` → `estimatedTokopayCharge("QRIS", x)`, `computeQrisAdminFee(x)` → `estimateTokopayFee("QRIS", x)!`, imported from `@app/core/payments/tokopayFee`. The literals at about `:225` and `:229` (`"70590"`, `"70800"`) come from the old formula on a 70000-ish total: recompute them with the Rp25 rule (for example total 70000 → fee 25 → 70025) and keep the test's intent.

Check `apps/storefront/test/checkout-minimums.test.ts`, `spa-api.test.ts`, `pages-context-business.test.ts` and `wallet-topup-api.test.ts` for fee literals: `grep -n "qris_admin_fee\|qris_grand_total\|1206\|\"240\"" apps/storefront/test/*.ts` and fix any that assert a server-computed fee.

- [ ] **Step 8: Run the tests and typecheck**

Run: `pnpm exec vitest run apps/storefront/test/tokopay-webhook.test.ts <the pay-view test file> <any other storefront test file you changed>`
Expected: PASS.
Run: `grep -n "qrisChargeAmount\|computeQrisAdminFee" apps/storefront/src -r`
Expected: no output.
Run: `pnpm --filter <storefront package name from apps/storefront/package.json> typecheck`
Expected: exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/storefront/src/routes/checkout.ts <every storefront test file you changed, by name> <packages/db barrel file if you added exports>
git commit -m "fix(storefront): pay page and webhook use TokoPay's own total" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 7: Bot — QR caption and reconcile

**Files:**
- Modify: `apps/order-bot/src/util/qrisCaption.ts`
- Modify: `apps/order-bot/src/handlers/checkout.ts:2038-2041`, `:2063-2072`, `:2108-2111`
- Modify: `apps/order-bot/src/handlers/walletTopup.ts:678-679`, `:687-693`, `:709-715`
- Modify: `apps/order-bot/src/payments/tokopayReconcile.ts:184`
- Test: `apps/order-bot/test/qris-caption.test.ts`, `tokopay-reconcile.test.ts`, `handlers.test.ts`, `wallet-topup.test.ts`, `display-currency.test.ts`, `game-topup-e2e.test.ts`, `payment-idempotency-matrix.test.ts`

Read `.claude/skills/bot-ux-grammy/SKILL.md` ("Message budget") before editing the handlers.

**Interfaces:**
- Consumes: `commitTokopayGateway`, `TokopayImplausibleChargeError` (Task 4); `expectedTokopayCharge`, `estimatedTokopayCharge`, `estimateTokopayFee` (Task 1).
- Produces: `qrisCaptionAmounts(order: QrisCaptionOrder, lang: string | null | undefined, chargeAmount: Decimal.Value): QrisCaptionAmounts` — third argument is now required; `adminFee` in the result is `chargeAmount − total`.

- [ ] **Step 1: Write the failing tests**

`apps/order-bot/test/qris-caption.test.ts` — change every existing call to pass the charge as the third argument (`estimatedTokopayCharge("QRIS", order.totalAmount)`), and add:

```ts
it("prints the charge it is given and derives the fee row from it", () => {
  const rows = qrisCaptionAmounts(
    { subtotalAmount: "50000", bulkDiscountAmount: "0", discountAmount: "0", walletUsed: "0", totalAmount: "50000" },
    "id",
    "50450",
  );
  expect(rows.chargeAmount.toString()).toBe("50450");
  expect(rows.adminFee.toString()).toBe("450");
  expect(rows.fee).toBe(formatIdrFor(new Decimal("450"), "id"));
  expect(rows.amount).toBe(formatIdrFor(new Decimal("50450"), "id"));
});
```

`apps/order-bot/test/tokopay-reconcile.test.ts` — add, beside the existing "delivers a pending TOKOPAY order the gateway reports paid" case (about line 121), using the same mocks:

```ts
it("delivers when TokoPay reports the stored gateway charge even though the tariff estimate differs", async () => {
  // pending TokoPay order, total 50000, gatewayChargeAmount 50450; checkTransaction -> { paid: true, amount: 50450 }
  // assert: order leaves PENDING_PAYMENT (delivered/processing), status is not UNDERPAID, no admin underpaid alert was sent
});

it("flags UNDERPAID against the stored gateway charge", async () => {
  // same order; checkTransaction -> { paid: true, amount: 50025 }
  // assert: order.status === "UNDERPAID"; qrisUnderpaidTx.expectedAmount === "50450"
});
```

`apps/order-bot/test/handlers.test.ts` — in the existing TokoPay checkout test (about line 4304) make the `createTransaction` mock return `totalBayar: "50450"` for a 50000 order and assert:

```ts
expect(caption).toContain(formatIdrFor(new Decimal("50450"), lang));       // the payable shown beside the QR
expect(caption).toContain(formatIdrFor(new Decimal("450"), lang));         // the fee row
expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).gatewayChargeAmount!.toString()).toBe("50450");
// message budget unchanged — keep (or add) the exact counts this test already pins:
expect(api.sendPhoto).toHaveBeenCalledTimes(1);
expect(api.sendMessage).toHaveBeenCalledTimes(0);
```
and add a case where `totalBayar` is `"49000"`: no photo is sent, the order ends CANCELLED with reason `gateway_create_failed`, and the buyer's bubble is edited once to `checkout.payment_unavailable` (assert the exact `editMessageText`/`sendPhoto`/`sendMessage` counts using the same spies that test file already uses).

`apps/order-bot/test/wallet-topup.test.ts` — same two cases for the IDR TokoPay top-up path.

Write each of these out in full with the file's existing helpers; none may stay a comment.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm exec vitest run apps/order-bot/test/qris-caption.test.ts apps/order-bot/test/tokopay-reconcile.test.ts apps/order-bot/test/handlers.test.ts apps/order-bot/test/wallet-topup.test.ts`
Expected: the new cases FAIL.

- [ ] **Step 3: `qrisCaption.ts`**

Remove the `computeQrisAdminFee` import. Change the signature and the two lines that derive the fee:

```ts
/**
 * `chargeAmount` is what the buyer must pay — TokoPay's own total for this
 * transaction (commitTokopayGateway, @app/db), so the figure printed beside the
 * QR is exactly what the buyer's banking app shows on scanning. The fee row is
 * derived from it, never computed here.
 */
export function qrisCaptionAmounts(
  order: QrisCaptionOrder,
  lang: string | null | undefined,
  chargeAmount: Decimal.Value,
): QrisCaptionAmounts {
  const subtotal = new Decimal(order.subtotalAmount);
  const total = new Decimal(order.totalAmount);
  const bulk = Decimal.max(ZERO, new Decimal(order.bulkDiscountAmount));
  const wallet = Decimal.max(ZERO, new Decimal(order.walletUsed));
  const voucher = Decimal.max(ZERO, subtotal.minus(bulk).minus(wallet).minus(total));
  const charge = new Decimal(chargeAmount);
  const adminFee = Decimal.max(ZERO, charge.minus(total));
```

and return `chargeAmount: charge` with `amount: formatIdrFor(charge, l)`. Update the header example row from `+Rp660` / `Rp80.660` to `+Rp25` / `Rp80.025`.

- [ ] **Step 4: `handlers/checkout.ts`**

Delete lines 2038-2041 (the comment and the `adminFee` / `chargeAmount` constants). Change `let gateway;` to:

```ts
  let gateway;
  let chargeAmount: Decimal;
```

Inside the `try`, replace the `commitGatewayResult` call and its `if (!committed)` with:

```ts
    // Stores TokoPay's own total on the order with the cached transaction, and
    // hands back the figure to print beside the QR. Throws (caught below, which
    // cancels the order shell) when that total is implausible.
    const result = await commitTokopayGateway(prisma, { order, channel: creds.channel, sentinel: claimSentinel, gateway });
    chargeAmount = result.charge;
    if (!result.committed) {
      logger.warn(`Created a TokoPay transaction for order ${order.orderCode} but couldn't cache it — the order's payment reference changed elsewhere during the external call.`);
    }
```

Keep the comment about the `gateway: "tokopay"` tag only if it still reads true; `commitTokopayGateway` adds that tag itself, so shorten it to say so.

Change line 2111 to `const rows = qrisCaptionAmounts(order, lang, chargeAmount);`. `payText` (line 2108) keeps using `chargeAmount`.

If typecheck reports another use of the removed `adminFee` constant further down this function, replace it with `rows.adminFee`.

Imports: remove `computeQrisAdminFee`; add `commitTokopayGateway` where `getTokopayCreds` / `commitGatewayResult` are imported (keep `commitGatewayResult`; the NOWPayments and PayDisini branches use it).

- [ ] **Step 5: `handlers/walletTopup.ts`**

Same change: delete lines 678-679; `let gateway; let chargeAmount: Decimal;`; replace the `commitGatewayResult` call at line 690 and its warning with the `commitTokopayGateway` block from Step 4 (message text says "wallet top-up order"); line 709 becomes `const rows = qrisCaptionAmounts(order, ctx.session.lang, chargeAmount);`. Fix imports the same way.

- [ ] **Step 6: `payments/tokopayReconcile.ts`**

Line 184:

```ts
  const expectedCharge = expectedTokopayCharge(order, creds.channel);
```

Replace the `qrisChargeAmount` import with `import { expectedTokopayCharge } from "@app/core/payments/tokopayFee";`. `order` comes from `listPendingTokopayOrders`, which returns full rows, so `gatewayChargeAmount` is present; if `PendingOrder` is a hand-written type, add `gatewayChargeAmount: Decimal | null` to it.

- [ ] **Step 7: Update existing bot tests that used the old helpers**

In `handlers.test.ts`, `display-currency.test.ts`, `game-topup-e2e.test.ts`, `payment-idempotency-matrix.test.ts`, `tokopay-reconcile.test.ts`, `qris-caption.test.ts`: `qrisChargeAmount(x)` → `estimatedTokopayCharge("QRIS", x)`, `computeQrisAdminFee(x)` → `estimateTokopayFee("QRIS", x)!`, imported from `@app/core/payments/tokopayFee`.

Many bot tests mock `createTransaction` with a fixed `totalBayar` such as `"100"` that is BELOW their order total; with this change that is an implausible total and the checkout is refused. Find them with `grep -rn "totalBayar" apps/order-bot/test` and change each mock to return a plausible figure for its order — `totalBayar: null` when the test does not care about the fee, or `estimatedTokopayCharge("QRIS", total).toString()` when it asserts the payable. Affected files include `wallet-topup`, `tiered-pricing-bot`, `nickname-check`, `handlers`, `game-account-input`, `display-currency`, `customer-info`, `back-navigation` and `game-topup-e2e`.

- [ ] **Step 8: Run the affected tests and typecheck**

Run: `pnpm exec vitest run apps/order-bot/test/qris-caption.test.ts apps/order-bot/test/tokopay-reconcile.test.ts apps/order-bot/test/handlers.test.ts apps/order-bot/test/wallet-topup.test.ts apps/order-bot/test/display-currency.test.ts apps/order-bot/test/game-topup-e2e.test.ts apps/order-bot/test/payment-idempotency-matrix.test.ts <every other bot test file whose mock you changed>`
Expected: PASS. If a file fails only under load (timeouts), re-run it alone before treating it as a regression.
Run: `pnpm exec vitest run apps/order-bot/test/money-input-guard.test.ts apps/order-bot/test/keyboard-label-guard.test.ts`
Expected: PASS.
Run: `grep -rn "qrisChargeAmount\|computeQrisAdminFee" apps/order-bot/src`
Expected: no output.
Run: `pnpm --filter <order-bot package name from apps/order-bot/package.json> typecheck`
Expected: exits 0.

Report the before and after test counts of each touched test file in your summary.

- [ ] **Step 9: Commit**

```bash
git add apps/order-bot/src/util/qrisCaption.ts apps/order-bot/src/handlers/checkout.ts apps/order-bot/src/handlers/walletTopup.ts apps/order-bot/src/payments/tokopayReconcile.ts <every bot test file you changed, by name>
git commit -m "fix(bot): QR caption and reconcile use TokoPay's own total" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 8: Remove the hard-coded formula, fix buyer copy and docs

**Files:**
- Modify: `packages/core/src/payments/tokopay.ts:90-123` (delete), `packages/core/src/payments/tokopay.test.ts:95-121` (delete the formula tests)
- Modify: `packages/core/locales/id.json:1091`, `packages/core/locales/en.json:1091`
- Modify: `apps/web-admin/test/payments-mutations-idempotency.test.ts` (old helper uses)
- Modify: `docs/arsitektur/FINANCE_ARCHITECTURE.md` (about lines 1061-1064 and 1192), `docs/arsitektur/PAYMENT_GATEWAY.md`, `docs/CHANGELOG.md`
- Test: `packages/core/src/locales.test.ts` (existing, must stay green)

**Interfaces:**
- Consumes: everything above.
- Produces: `computeQrisAdminFee`, `qrisChargeAmount`, `QRIS_ADMIN_FEE_FLAT`, `QRIS_ADMIN_FEE_PERCENT` no longer exist.

- [ ] **Step 1: Confirm nothing in `src` still uses the old helpers**

Run: `grep -rn "qrisChargeAmount\|computeQrisAdminFee\|QRIS_ADMIN_FEE_" apps packages --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=static`
Expected: matches only in `packages/core/src/payments/tokopay.ts`, `packages/core/src/payments/tokopay.test.ts`, `apps/web-admin/test/payments-mutations-idempotency.test.ts`, and comments. Any other source file is a missed caller: migrate it to `expectedTokopayCharge` / `estimatedTokopayCharge` as in Tasks 5-7 before continuing.

- [ ] **Step 2: Delete the old helpers**

In `packages/core/src/payments/tokopay.ts` delete lines 90-123 (the "QRIS admin-fee constants" comment, both constants, `computeQrisAdminFee`, `qrisChargeAmount`). Remove the `Decimal` import only if nothing else in the file uses it (`createTransaction` does — keep it). In the comment inside `checkTransaction` that says the bare order total "is BELOW the fee-inclusive charge callers compare against", leave the wording; it is still true.

In `packages/core/src/payments/tokopay.test.ts` delete the `describe` block(s) for `computeQrisAdminFee` / `qrisChargeAmount` (about lines 95-121) and their imports. `tokopayFee.test.ts` covers the replacement.

In `apps/web-admin/test/payments-mutations-idempotency.test.ts`: `qrisChargeAmount(x)` → `estimatedTokopayCharge("QRIS", x)`, imported from `@app/core/payments/tokopayFee`.

- [ ] **Step 3: Buyer copy**

`packages/core/locales/id.json`: `"web.qris_admin_fee_note": "+ biaya admin QRIS",`
`packages/core/locales/en.json`: `"web.qris_admin_fee_note": "+ QRIS admin fee",`

Run: `grep -rn "0,7%\|0\.7%\|Rp100 &" apps/storefront/client/src apps/web-admin/client/src packages/core/locales`
Expected: no output. If a client test asserts the old note text, update the expected string; if client SOURCE has to change, say so in your summary (it triggers the React Doctor gate).

- [ ] **Step 4: Docs**

- `docs/arsitektur/FINANCE_ARCHITECTURE.md` (about 1061-1064 and 1192): replace the description of `computeQrisAdminFee` (Rp100 + 0.70%) with: the buyer-side QRIS surcharge is `Order.gatewayChargeAmount − Order.totalAmount`, where `gatewayChargeAmount` is TokoPay's `total_bayar` stored when the transaction is created; `expectedTokopayCharge` (`packages/core/src/payments/tokopayFee.ts`) is the one resolver; the built-in tariff table there is an estimate used only before a transaction exists or when TokoPay reported no total.
- `docs/arsitektur/PAYMENT_GATEWAY.md`: in the TokoPay section add a short "Admin fee" paragraph with the same facts, plus: TokoPay has no tariff API (checked 2026-11-11), admins get one `ADMIN_TOKOPAY_FEE_DRIFT` DM per 24 hours when TokoPay's total differs from the estimate, and an implausible total shows no QR.
- `docs/CHANGELOG.md`: add an entry under the newest heading: "TokoPay QRIS: payments are matched against the total TokoPay reports per order instead of a hard-coded Rp100 + 0.7%; QRIS below Rp100.000 is estimated at Rp25. Deploy: apply the two `order_gateway_charge_amount` migrations and restart order-bot before the new code runs."

- [ ] **Step 5: Run the checks**

Run: `pnpm exec vitest run packages/core/src/payments/tokopay.test.ts packages/core/src/payments/tokopayFee.test.ts packages/core/src/locales.test.ts apps/web-admin/test/payments-mutations-idempotency.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: exits 0 (this is the first point where every caller must be migrated).
Run: `pnpm test:changed`
Expected: PASS. The locale JSON change makes this run the whole suite; if a file fails only in the full run, re-run that file alone before calling it a regression.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/payments/tokopay.ts packages/core/src/payments/tokopay.test.ts packages/core/locales/id.json packages/core/locales/en.json apps/web-admin/test/payments-mutations-idempotency.test.ts docs/arsitektur/FINANCE_ARCHITECTURE.md docs/arsitektur/PAYMENT_GATEWAY.md docs/CHANGELOG.md <any other file you changed, by name>
git commit -m "refactor: remove the hard-coded TokoPay fee formula" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

## Final gate (controller, after all tasks)

1. `git fetch` and rebase onto latest `master` (the branch is not pushed).
2. `pnpm typecheck && pnpm test` — full, once.
3. Only if client React source changed: `pnpm doctor:changed`, `pnpm doctor:bugs`, `pnpm doctor:full` at 0 errors and 0 warnings; record in `docs/REACT_DOCTOR_PHASE_1_REPORT.md`.
4. Verify the backfill SQL by hand on the worktree database: insert one TOKOPAY/IDR order with `total_amount = 50000` and a null `gateway_charge_amount`, run the backfill statement, expect `50450`; run it again, expect no change.
5. Whole-branch review on Opus (money-critical).

## Deploy notes

1. Apply both migrations and restart order-bot before the new code runs.
2. Release the server and the storefront client together.
3. Re-enable TokoPay. Nothing has to be configured in Settings.
