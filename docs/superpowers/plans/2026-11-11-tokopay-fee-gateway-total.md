# TokoPay QRIS Fee (Gateway Total) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match TokoPay payments against the fee-inclusive total TokoPay itself reports for each order, and remove every fee formula from the code.

**Architecture:** A nullable column `Order.gatewayChargeAmount` stores TokoPay's `total_bayar` in the same write that caches the gateway result. One pure resolver, `expectedTokopayCharge(order)`, returns that snapshot (or the bare order total when none exists); every matching and bookkeeping site calls it. Before a QR exists the buyer sees no fee figure, only a note that a QRIS admin fee is added.

**Tech Stack:** TypeScript, pnpm workspaces, Prisma (PostgreSQL), Fastify (storefront), React (storefront client), grammY (order-bot), Vitest, decimal.js via `@app/core/money`.

**Spec:** `docs/superpowers/specs/2026-11-11-tokopay-fee-settings-design.md` (revised: no tariff table, no drift alert).

**Revision note:** Tasks 1 and 2 were implemented against the first version of this plan (commits `42265d4d`, `f116ef01`). Task 1 added `packages/core/src/payments/tokopayFee.ts` with a tariff table, and Task 2 added `getTokopayChannel`; both are now unneeded and Task 3 removes them. Task 2's column, migrations and `commitGatewayResult` change stand.

## Global Constraints

- All money is `Decimal` from `@app/core/money`; never `number`/`parseFloat`.
- No raw SQL in routes or handlers; database access goes in `packages/db/src/crud/*`.
- The web (storefront, admin) never sends Telegram.
- Pino log messages are full English sentences that say what happened and why it matters; no secrets, no truncated id lists.
- Comparison rules do not change: paid below the expected charge is UNDERPAID, above is overpaid, no tolerance.
- No fee formula, tariff table, tariff setting or tariff alert exists anywhere after this plan.
- Bot message counts must not change; tests that touch a bot flow pin exact `sendMessage` / `edit*` / `deleteMessage` / `sendDocument` counts.
- Stage files by name (`git add <path>`), never `git add -A` or `-a`: a hook regenerates `graphify-out/` during the task.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>` and no other attribution.
- Per task run only the affected tests (`pnpm exec vitest run <path>`) and `pnpm --filter <pkg> typecheck`. `pnpm --filter <pkg> test` runs nothing in this repo.
- Never `git stash`, never switch branch, never `git reset --hard`.

---

### Task 1: Core tariff module — DONE (`42265d4d`), superseded by Task 3

### Task 2: Order snapshot column and channel helper — DONE (`f116ef01`); the channel helper is removed in Task 3

Produced and still in force:
- `Order.gatewayChargeAmount: Decimal | null` (`gateway_charge_amount`), migrations `20261111090000_order_gateway_charge_amount` and `20261111090100_order_gateway_charge_amount_backfill`.
- `commitGatewayResult(db: Db, orderId: number, sentinel: string, payload: unknown, gatewayChargeAmount?: Decimal.Value | null): Promise<boolean>` in `packages/db/src/crud/orders.ts`.

---

### Task 3: Replace the tariff module with a charge reader, drop the channel helper

**Files:**
- Delete: `packages/core/src/payments/tokopayFee.ts`, `packages/core/src/payments/tokopayFee.test.ts`
- Create: `packages/core/src/payments/tokopayCharge.ts`, `packages/core/src/payments/tokopayCharge.test.ts`
- Modify: `packages/core/package.json` (export `./payments/tokopayFee` → `./payments/tokopayCharge`)
- Delete: `packages/db/src/crud/_tokopayChannel.ts`
- Modify: `packages/db/src/crud/tokopay.ts` (`getTokopayCreds` back to reading `TOKOPAY_CHANNEL_KEY` itself; remove the `getTokopayChannel` import and re-export), `packages/db/src/crud/tokopay.test.ts` (remove the `getTokopayChannel` describe block)

**Interfaces:**
- Produces (from `@app/core/payments/tokopayCharge`):
  - `TOKOPAY_MAX_FEE_PERCENT: Decimal` (50), `TOKOPAY_MAX_FEE_FLAT: Decimal` (10000)
  - `type TokopayChargeReading = { kind: "ok"; charge: Decimal } | { kind: "missing" } | { kind: "implausible" }`
  - `readTokopayCharge(totalAmount: Decimal.Value, totalBayar: string | null | undefined): TokopayChargeReading`
  - `expectedTokopayCharge(order: { totalAmount: Decimal.Value; gatewayChargeAmount?: Decimal.Value | null }): Decimal`
- Removed: everything `tokopayFee.ts` exported, and `getTokopayChannel`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/payments/tokopayCharge.test.ts
import { describe, it, expect } from "vitest";
import { Decimal } from "../money";
import { readTokopayCharge, expectedTokopayCharge } from "./tokopayCharge";

describe("readTokopayCharge", () => {
  it("accepts a whole-rupiah total at or above the order total", () => {
    expect(readTokopayCharge("50000", "50025")).toEqual({ kind: "ok", charge: new Decimal("50025") });
    expect(readTokopayCharge("50000", "50000")).toEqual({ kind: "ok", charge: new Decimal("50000") });
    expect(readTokopayCharge("50000", " 50450 ")).toEqual({ kind: "ok", charge: new Decimal("50450") });
  });

  it("reports a null or blank total as missing", () => {
    expect(readTokopayCharge("50000", null)).toEqual({ kind: "missing" });
    expect(readTokopayCharge("50000", undefined)).toEqual({ kind: "missing" });
    expect(readTokopayCharge("50000", "  ")).toEqual({ kind: "missing" });
  });

  it("rejects anything that is not plain digits", () => {
    for (const bad of ["abc", "50025.5", "5e4", "0x1F", "-50025", "50 025", "50.025"]) {
      expect(readTokopayCharge("50000", bad), bad).toEqual({ kind: "implausible" });
    }
  });

  it("rejects a total below the nominal sent to TokoPay", () => {
    expect(readTokopayCharge("50000", "49999")).toEqual({ kind: "implausible" });
  });

  it("compares against the rounded nominal (toFixed(0) of the order total)", () => {
    expect(readTokopayCharge("50000.4", "50025").kind).toBe("ok");
    expect(readTokopayCharge("50000.5", "50000").kind).toBe("implausible"); // nominal sent is 50001
  });

  it("caps the implied fee at 50% of the total plus Rp10.000", () => {
    expect(readTokopayCharge("50000", "85000").kind).toBe("ok");
    expect(readTokopayCharge("50000", "85001").kind).toBe("implausible");
  });
});

describe("expectedTokopayCharge", () => {
  it("returns the stored gateway charge when there is one", () => {
    expect(expectedTokopayCharge({ totalAmount: "50000", gatewayChargeAmount: "50025" }).toString()).toBe("50025");
    expect(expectedTokopayCharge({ totalAmount: "50000", gatewayChargeAmount: new Decimal("50450") }).toString()).toBe("50450");
  });

  it("returns the order total when no gateway charge was stored", () => {
    expect(expectedTokopayCharge({ totalAmount: "50000", gatewayChargeAmount: null }).toString()).toBe("50000");
    expect(expectedTokopayCharge({ totalAmount: "50000" }).toString()).toBe("50000");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run packages/core/src/payments/tokopayCharge.test.ts`
Expected: FAIL — cannot resolve `./tokopayCharge`.

- [ ] **Step 3: Write the module and delete the old one**

```ts
// packages/core/src/payments/tokopayCharge.ts
/**
 * What a buyer must pay on a TokoPay order.
 *
 * TokoPay's admin fee is its own cut, paid by the buyer on top of the order
 * total, and TokoPay changes it without notice (it has no API that lists
 * tariffs). So this codebase holds NO fee formula: the figure TokoPay returns
 * as `total_bayar` when a transaction is created is stored on the order
 * (`Order.gatewayChargeAmount`) and every paid-amount check, overpayment check
 * and fee figure derives from that stored figure.
 */
import { Decimal } from "../money";

/** Guard against a broken gateway response, not a tariff: the fee implied by
 *  `total_bayar` may be at most 50% of the order total plus Rp10.000. */
export const TOKOPAY_MAX_FEE_PERCENT = new Decimal(50);
export const TOKOPAY_MAX_FEE_FLAT = new Decimal(10000);

export type TokopayChargeReading =
  | { kind: "ok"; charge: Decimal }
  | { kind: "missing" }
  | { kind: "implausible" };

/**
 * Read TokoPay's `total_bayar` for an order. "ok" is plain digits (whole
 * rupiah), at or above the nominal sent to TokoPay, with an implied fee within
 * the cap. "missing" is null or blank. Anything else is "implausible". Only an
 * "ok" figure may be shown to a buyer or stored.
 */
export function readTokopayCharge(
  totalAmount: Decimal.Value,
  totalBayar: string | null | undefined,
): TokopayChargeReading {
  if (totalBayar == null || totalBayar.trim() === "") return { kind: "missing" };
  const text = totalBayar.trim();
  if (!/^\d+$/.test(text)) return { kind: "implausible" };
  const charge = new Decimal(text);
  // createTransaction sends `nominal` as `toFixed(0)` of the order total.
  const nominal = new Decimal(new Decimal(totalAmount).toFixed(0));
  if (charge.lessThan(nominal)) return { kind: "implausible" };
  const cap = nominal.times(TOKOPAY_MAX_FEE_PERCENT).dividedBy(100).plus(TOKOPAY_MAX_FEE_FLAT);
  if (charge.minus(nominal).greaterThan(cap)) return { kind: "implausible" };
  return { kind: "ok", charge };
}

/**
 * The amount the buyer was asked to pay on a TokoPay order: the figure TokoPay
 * reported when the transaction was created. The ONE place this is decided;
 * the buyer-side fee is always `expectedTokopayCharge(order) - order.totalAmount`.
 *
 * An order with no stored figure never had its TokoPay transaction recorded;
 * the bare order total is then the least a payment must cover, so a real
 * payment still settles and its fee portion surfaces as an overpayment for an
 * admin to look at instead of the order getting stuck.
 */
export function expectedTokopayCharge(order: {
  totalAmount: Decimal.Value;
  gatewayChargeAmount?: Decimal.Value | null;
}): Decimal {
  return new Decimal(order.gatewayChargeAmount ?? order.totalAmount);
}
```

Delete `packages/core/src/payments/tokopayFee.ts` and `tokopayFee.test.ts` with `git rm`. In `packages/core/package.json` rename the export entry `./payments/tokopayFee` to `./payments/tokopayCharge` (same shape as the neighbouring `./payments/tokopay` entry).

- [ ] **Step 4: Remove the channel helper**

`git rm packages/db/src/crud/_tokopayChannel.ts`. In `packages/db/src/crud/tokopay.ts` remove its import and the `export { getTokopayChannel } ...` line, and restore `getTokopayCreds` to read the channel itself:

```ts
  const [merchantId, secret, enabled, channel, minAmountSetting] = await Promise.all([
    getSetting(db, TOKOPAY_MERCHANT_KEY),
    getDecryptedSetting(db, TOKOPAY_SECRET_KEY),
    getSetting(db, TOKOPAY_ENABLED_KEY),
    getSetting(db, TOKOPAY_CHANNEL_KEY),
    getSetting(db, TOKOPAY_MIN_AMOUNT_KEY),
  ]);
  if (!merchantId || !secret) return null;
  if ((enabled ?? "").trim().toLowerCase() === "false") return null;
  return {
    merchantId,
    secret,
    channel: (channel ?? "QRIS").trim() || "QRIS",
    minAmount: parseMinAmount(minAmountSetting),
  };
```
(restore the `TOKOPAY_CHANNEL_KEY` import). Remove the `describe("getTokopayChannel", …)` block and its import from `packages/db/src/crud/tokopay.test.ts`.

Run: `grep -rn "tokopayFee\|getTokopayChannel\|_tokopayChannel" apps packages --include=*.ts --include=*.tsx --include=*.json --exclude-dir=node_modules --exclude-dir=dist`
Expected: no output.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm exec vitest run packages/core/src/payments/tokopayCharge.test.ts packages/db/src/crud/tokopay.test.ts`
Expected: PASS.
Run: `pnpm --filter @app/core typecheck && pnpm --filter @app/db typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/payments/tokopayCharge.ts packages/core/src/payments/tokopayCharge.test.ts packages/core/package.json packages/db/src/crud/tokopay.ts packages/db/src/crud/tokopay.test.ts
git commit -m "refactor: drop the TokoPay tariff table; keep only the gateway-charge reader" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```
(`git rm` already staged the three deletions.)

---

### Task 4: `commitTokopayGateway`

**Files:**
- Modify: `packages/db/src/crud/tokopay.ts` (add after `getTokopayCreds`)
- Test: `packages/db/src/crud/tokopay.test.ts`

**Interfaces:**
- Consumes: `readTokopayCharge` (Task 3); `commitGatewayResult(db, orderId, sentinel, payload, gatewayChargeAmount?)` from `./orders`; `TokopayOrderInfo` from `@app/core/payments/tokopay` (`{ trxId: string; payUrl: string | null; qrLink: string | null; qrString: string | null; totalBayar: string | null }`).
- Produces:
  - `class TokopayChargeUnavailableError extends Error`
  - `commitTokopayGateway(db: Db, args: { order: { id: number; orderCode: string; totalAmount: Decimal.Value }; sentinel: string; gateway: TokopayOrderInfo }): Promise<{ committed: boolean; charge: Decimal }>` — stores TokoPay's total with the cached transaction and returns it. Throws `TokopayChargeUnavailableError` (storing nothing) when TokoPay's total is missing or implausible.

- [ ] **Step 1: Write the failing tests**

In `packages/db/src/crud/tokopay.test.ts`, using the file's existing helper for a pending TokoPay order (create one whose `totalAmount` is 50000) and `claimGatewaySlot` from `./orders`:

```ts
describe("commitTokopayGateway", () => {
  const gatewayInfo = (totalBayar: string | null) => ({
    trxId: "TP-COMMIT", payUrl: null, qrLink: "https://qr.example/x.png", qrString: null, totalBayar,
  });

  it("stores TokoPay's total with the cached transaction and returns it", async () => {
    const order = await createPendingTokopayOrder("50000");
    const sentinel = (await claimGatewaySlot(prisma, order.id))!;
    const r = await commitTokopayGateway(prisma, { order, sentinel, gateway: gatewayInfo("50025") });
    expect(r.committed).toBe(true);
    expect(r.charge.toString()).toBe("50025");
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.gatewayChargeAmount!.toString()).toBe("50025");
    expect(JSON.parse(row.paymentRef!)).toMatchObject({ gateway: "tokopay", trxId: "TP-COMMIT", totalBayar: "50025" });
  });

  it("reports committed=false and stores nothing when the claim no longer matches", async () => {
    const order = await createPendingTokopayOrder("50000");
    const r = await commitTokopayGateway(prisma, { order, sentinel: "not-the-sentinel", gateway: gatewayInfo("50025") });
    expect(r.committed).toBe(false);
    expect(r.charge.toString()).toBe("50025");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).gatewayChargeAmount).toBeNull();
  });

  it.each([
    ["missing", null],
    ["below the order total", "49000"],
    ["not a number", "abc"],
    ["absurdly high", "999999999"],
  ])("throws and stores nothing when TokoPay's total is %s", async (_label, totalBayar) => {
    const order = await createPendingTokopayOrder("50000");
    const sentinel = (await claimGatewaySlot(prisma, order.id))!;
    await expect(
      commitTokopayGateway(prisma, { order, sentinel, gateway: gatewayInfo(totalBayar) }),
    ).rejects.toBeInstanceOf(TokopayChargeUnavailableError);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.gatewayChargeAmount).toBeNull();
    expect(row.paymentRef).toBe(sentinel);
  });
});
```
(Use the real name and argument shape of the file's order helper.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/db/src/crud/tokopay.test.ts -t "commitTokopayGateway"`
Expected: FAIL — `commitTokopayGateway` is not exported.

- [ ] **Step 3: Implement**

Add the imports (`readTokopayCharge` from `@app/core/payments/tokopayCharge`; `type TokopayOrderInfo` from `@app/core/payments/tokopay`; `commitGatewayResult` from `./orders`) and, after `getTokopayCreds`:

```ts
/** TokoPay created a transaction but did not report a usable total for the
 *  buyer to pay (`readTokopayCharge`), so no payment instructions may be shown. */
export class TokopayChargeUnavailableError extends Error {}

/**
 * Cache a freshly created TokoPay transaction on its order AND record what
 * TokoPay says the buyer must pay — the figure every later paid-amount check
 * reads (`expectedTokopayCharge`). The three places that create a TokoPay
 * transaction (storefront pay page, bot checkout, bot wallet top-up) all go
 * through here, so none of them can cache a transaction without its charge.
 *
 * Returns that charge for the caller to print beside the QR. Throws
 * `TokopayChargeUnavailableError`, storing nothing, when TokoPay's total is
 * missing or implausible: without it the payment could not be verified later,
 * so the caller must treat this exactly like a failed transaction creation.
 */
export async function commitTokopayGateway(
  db: Db,
  args: {
    order: { id: number; orderCode: string; totalAmount: Decimal.Value };
    sentinel: string;
    gateway: TokopayOrderInfo;
  },
): Promise<{ committed: boolean; charge: Decimal }> {
  const reading = readTokopayCharge(args.order.totalAmount, args.gateway.totalBayar);
  if (reading.kind !== "ok") {
    throw new TokopayChargeUnavailableError(
      reading.kind === "missing"
        ? `TokoPay created a transaction for order ${args.order.orderCode} without reporting the total the buyer must pay, so no payment instructions were shown — the payment could not have been verified against anything`
        : `TokoPay reported an implausible total for order ${args.order.orderCode} (order total ${new Decimal(args.order.totalAmount).toString()}), so no payment instructions were shown — check the transaction in the TokoPay dashboard`,
    );
  }
  const committed = await commitGatewayResult(
    db,
    args.order.id,
    args.sentinel,
    { gateway: "tokopay", ...args.gateway },
    reading.charge,
  );
  return { committed, charge: reading.charge };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm exec vitest run packages/db/src/crud/tokopay.test.ts`
Expected: PASS (whole file).
Run: `pnpm --filter @app/db typecheck`
Expected: exits 0.

Check how `apps/storefront` and `apps/order-bot` import `getTokopayCreds` (from `@app/db` or a subpath). If `packages/db` lists its exports by name in a barrel or in `package.json`, make `commitTokopayGateway` and `TokopayChargeUnavailableError` reachable the same way and include that file in the commit.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/tokopay.ts packages/db/src/crud/tokopay.test.ts
git commit -m "feat(db): commitTokopayGateway stores TokoPay's own total on the order" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 5: Matching and bookkeeping read the resolver (db package)

**Files:**
- Modify: `packages/db/src/crud/tokopay.ts` (`deliverPaidTokopayOrder`: the lines using `qrisChargeAmount` / `computeQrisAdminFee` and the comments around them)
- Modify: `packages/db/src/crud/overpayments.ts` (`findOverpaidExcess`)
- Modify: `packages/db/src/crud/orderStatus.ts` (`markOrderUnderpaid`)
- Modify: `packages/db/src/crud/manualMatch.ts` (`requiredAmount` and its two callers)
- Modify: `packages/db/src/crud/wallet_topup.ts` (`creditUnderpaidTopupAnyway`)
- Modify: `packages/db/src/crud/ledgerPostings.ts` (one comment naming the old formula)
- Test: `packages/db/src/crud/tokopay.test.ts`, `overpayments.test.ts`, `manualMatch.test.ts`, `wallet_topup_overpaid.test.ts`, `ledger.regression.test.ts`, `idrDiscountRounding.test.ts`, and the test files covering `markOrderUnderpaid` and `creditUnderpaidTopupAnyway` (find with `grep -rln "markOrderUnderpaid\|creditUnderpaidTopupAnyway" packages/db/src/crud/*.test.ts`)

**Interfaces:**
- Consumes: `expectedTokopayCharge(order: { totalAmount; gatewayChargeAmount? }): Decimal` from `@app/core/payments/tokopayCharge`; `Order.gatewayChargeAmount`.
- Produces: no new exports. After this task nothing under `packages/db/src` imports `computeQrisAdminFee` or `qrisChargeAmount`.

- [ ] **Step 1: Write the failing tests**

Each new case uses a TokoPay order with `totalAmount` 50000 and sets the snapshot directly: `await prisma.order.update({ where: { id: order.id }, data: { gatewayChargeAmount: new Decimal("50025") } })`. Use each file's existing helpers and call shapes; every test must be written out in full.

`tokopay.test.ts`:
1. Paid 50025 with snapshot 50025 → result is `delivered` or `processing`; `processedTokopayTx.outcome === "matched"`; no `ADMIN_OVERPAID` outbox row.
2. Paid 50100 with snapshot 50025 → `outcome === "overpaid"`; the `ADMIN_OVERPAID` payload has `expected: "50025"`, `excess: "75"`.
3. Fee capture (copy the setup of the existing "fee capture (Financial Ledger M3)" test, about line 369): snapshot 50025, paid 50025 → `payment.fee.toString() === "25"`, `payment.netAmount.toString() === "50000"`.
4. No snapshot, paid 50000 → `outcome === "matched"`, `payment.fee.toString() === "0"`.
5. Wallet top-up order with snapshot 50025, paid 50100 → balance credited 50000, ledger `outcome === "overpaid"`.

`overpayments.test.ts`: TokoPay order, snapshot 50025, ledger row `overpaid` with amount 50100 → `findOverpaidExcess` returns `expectedAmount "50025"`, `excess "75"`.

`manualMatch.test.ts`: snapshot 50025; an unmatched TokoPay row of 50000 → rejects with key `error.manual_match_amount_short` and `required: "50025"`; a row of 50025 matches.

`markOrderUnderpaid` test file:

```ts
it("accepts an expected amount equal to the order's stored gateway charge", async () => {
  const order = await createPendingTokopayOrder("50000");
  await prisma.order.update({ where: { id: order.id }, data: { gatewayChargeAmount: new Decimal("50025") } });
  expect(await markOrderUnderpaid(prisma, { orderId: order.id, gateway: "TokoPay", receivedAmount: "50000", expectedAmount: "50025" })).toBe(true);
});

it("refuses an expected amount that is neither the total nor the stored gateway charge", async () => {
  const order = await createPendingTokopayOrder("50000");
  await prisma.order.update({ where: { id: order.id }, data: { gatewayChargeAmount: new Decimal("50025") } });
  expect(await markOrderUnderpaid(prisma, { orderId: order.id, gateway: "TokoPay", receivedAmount: "50000", expectedAmount: "50450" })).toBe(false);
});
```

`creditUnderpaidTopupAnyway` test file: UNDERPAID TokoPay wallet top-up, total 50000, snapshot 50025, recorded received 40025 → `credited.toString() === "40000"`.

- [ ] **Step 2: Run to verify the new cases fail**

Run: `pnpm exec vitest run packages/db/src/crud/tokopay.test.ts packages/db/src/crud/overpayments.test.ts packages/db/src/crud/manualMatch.test.ts <the two found test files>`
Expected: new cases FAIL (figures derived from Rp100 + 0.7% instead of the snapshot).

- [ ] **Step 3: `deliverPaidTokopayOrder`**

Inside the `$transaction` callback, directly after the `pendingPayment` lookup and before `if (order.kind === OrderKind.WALLET_TOPUP)`:

```ts
        // What this buyer was asked to pay: TokoPay's own figure, stored on the
        // order when its transaction was created (`expectedTokopayCharge`). The
        // buyer-side surcharge is the difference to the order total.
        const expectedCharge = expectedTokopayCharge(order);
        const gatewayFee = expectedCharge.minus(order.totalAmount);
```

Then: `expected: qrisChargeAmount(order.totalAmount),` → `expected: expectedCharge,`; both `fee: computeQrisAdminFee(order.totalAmount),` → `fee: gatewayFee,`; delete the later `const expectedCharge = qrisChargeAmount(order.totalAmount);` in the product branch.

Rewrite the two comments that describe the old estimate:
- The wallet top-up overpayment comment (the sentences from "TokoPay bills the QRIS surcharge on top of the total" to "a Rp1 rounding case is recognisable.") becomes:

```ts
          // TokoPay bills its surcharge on top of the total, so the comparison
          // is against what TokoPay said this buyer must pay (`expectedCharge`
          // above), exactly like the product branch. No tolerance is added.
```
- In the fee-capture comment, replace the paragraphs from "`fee` is `computeQrisAdminFee(order.totalAmount)`" through "Pinned by a test in crud/tokopay.test.ts." with:

```ts
            // `fee` is the surcharge the buyer pays ON TOP of the order total —
            // the order's stored gateway charge minus its total — so
            // `netAmount` is the total itself, not `amount - fee`. The
            // surcharge never becomes this shop's money; the total IS what the
            // shop nets.
            //
            // Captured as DATA only — no `FEE` ledger posting is made from it.
            // It is the BUYER-side surcharge, not a cut TokoPay reported having
            // deducted from the shop, and the `ORDER_PAYMENT` posting that
            // settling this order already made (crud/ledgerPostings.ts) books
            // `order.totalAmount` — the net receipt — so booking the surcharge
            // separately would double-count. `payment_fee.idr` and
            // `FinancialTransactionType.FEE` stay unused until a rail reports a
            // real merchant fee. Pinned by a test in crud/tokopay.test.ts.
```
Update the imports: drop `computeQrisAdminFee, qrisChargeAmount`; import `expectedTokopayCharge` from `@app/core/payments/tokopayCharge`.

- [ ] **Step 4: `overpayments.ts`**

Add `gatewayChargeAmount: true` to the order `select` in `findOverpaidExcess`, and change the TokoPay candidate to:

```ts
    { gateway: PaymentMethod.TOKOPAY, amount: tokopay?.amount ?? null, expected: q4(expectedTokopayCharge(order)) },
```
In the comment above the array replace "`qrisChargeAmount(total)` is what the buyer was asked for" with "`expectedTokopayCharge(order)` — the gateway charge stored on the order — is what the buyer was asked for". Fix the file-header comment the same way if it names the old helper. Swap the import.

- [ ] **Step 5: `orderStatus.ts`**

Add `gatewayChargeAmount: true` to the `select` in `markOrderUnderpaid`, and replace the guard line with:

```ts
    if (!expected.equals(order.totalAmount) && !(gateway === "TOKOPAY" && expected.equals(expectedTokopayCharge(order)))) return false;
```
Swap the import.

- [ ] **Step 6: `manualMatch.ts`**

```ts
function requiredAmount(
  gateway: keyof typeof GATEWAY_METHODS,
  order: { totalAmount: Decimal.Value; gatewayChargeAmount?: Decimal.Value | null },
): Decimal {
  switch (gateway) {
    case "tokopay":
      return expectedTokopayCharge(order);
    case "paydisini":
      return new Decimal(order.totalAmount);
    case "bybit":
      return new Decimal(order.totalAmount).minus(AMOUNT_TOLERANCE);
  }
}
```
In its doc comment change the TokoPay bullet to "TokoPay: what TokoPay said the buyer must pay (the gateway charge stored on the order), as the callback checks". Callers: in `assertNotUnderpaidShortPayment` add `gatewayChargeAmount: true` to the `suggested` select and call `requiredAmount(gateway, suggested)`; in the main function call `requiredAmount(gateway, order)`. Swap the import.

- [ ] **Step 7: `wallet_topup.ts`**

In `creditUnderpaidTopupAnyway`:

```ts
      const fee =
        order.paymentMethod === PaymentMethod.TOKOPAY
          ? expectedTokopayCharge(order).minus(order.totalAmount)
          : ZERO;
```
Swap the import. Update the doc comment near `flagWalletTopupOverpayment` (about line 924) and the one in `ledgerPostings.ts` (about line 816) if they name `computeQrisAdminFee` or "Rp100 + 0.70%": say "the fee implied by the gateway charge stored on the order".

- [ ] **Step 8: Update existing tests in this package**

The old helpers still exist in core until Task 8, but no test in this package should depend on them any more. In `tokopay.test.ts`, `manualMatch.test.ts`, `overpayments.test.ts`, `wallet_topup_overpaid.test.ts`, `ledger.regression.test.ts`, `idrDiscountRounding.test.ts`: wherever a test pays or expects `qrisChargeAmount(total)` / `computeQrisAdminFee(total)`, give the order an explicit snapshot instead (`gatewayChargeAmount = total + 25`, set with `prisma.order.update`, or through the file's order helper if it is simple to extend) and assert against that literal. A test that is about an order WITHOUT a snapshot pays and expects the bare total. Remove the old imports. `tokopay.test.ts` about line 298 re-derives `new Decimal(100).plus(total.times("0.007"))` inline: replace it with the explicit snapshot too.

- [ ] **Step 9: Run the package's affected tests and typecheck**

Run: `pnpm exec vitest run packages/db/src/crud/tokopay.test.ts packages/db/src/crud/overpayments.test.ts packages/db/src/crud/manualMatch.test.ts packages/db/src/crud/wallet_topup_overpaid.test.ts packages/db/src/crud/ledger.regression.test.ts packages/db/src/crud/idrDiscountRounding.test.ts <the two found test files>`
Expected: PASS. Re-run a file alone if it fails only under load.
Run: `grep -rn "qrisChargeAmount\|computeQrisAdminFee" packages/db/src`
Expected: no output.
Run: `pnpm --filter @app/db typecheck`
Expected: exits 0.

Report the before and after test counts of each touched test file.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/crud/tokopay.ts packages/db/src/crud/overpayments.ts packages/db/src/crud/orderStatus.ts packages/db/src/crud/manualMatch.ts packages/db/src/crud/wallet_topup.ts packages/db/src/crud/ledgerPostings.ts <every test file you changed, by name>
git commit -m "fix(db): match TokoPay payments against the order's stored gateway charge" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 6: Storefront — no fee figure before the QR, TokoPay's total on the pay page, webhook

**Files:**
- Modify: `apps/storefront/src/routes/checkout.ts` (`computeTotals` about `:293-315`; checkout view about `:478-479`; `payView` about `:1094-1125` and `:1251-1252`; webhook `:1329`; imports about `:102-104`)
- Modify: `apps/storefront/client/src/api/types.ts:383-384`
- Modify: `apps/storefront/client/src/components/shop/OrderSummaryCard.tsx:284-300`, `OrderSummaryCard.helpers.ts:18-32`
- Modify: `apps/storefront/client/src/pages/CheckoutPage.tsx` (`:657`, `:704`, `:788`, `:804`), `apps/storefront/client/src/pages/InstantBuyPage.tsx:783`
- Modify: `packages/core/locales/id.json`, `packages/core/locales/en.json` (`web.qris_admin_fee_note`, new `web.qris_admin_fee_at_payment`)
- Test: `apps/storefront/test/tokopay-webhook.test.ts`, the storefront tests asserting `qris_admin_fee` / `qris_grand_total` (`grep -rln "qris_grand_total\|qris_admin_fee" apps/storefront/test`), `apps/storefront/client/src/components/shop/OrderSummaryCard.test.tsx`, `PaymentMethodSelector.test.tsx`, `pages/CheckoutPage.test.tsx`, `pages/InstantBuyPage.test.tsx`

Read `.claude/skills/web-fastify-conventions/SKILL.md` and `.claude/skills/ui-development-dispatch/SKILL.md` before editing.

**Interfaces:**
- Consumes: `expectedTokopayCharge(order)` (Task 3); `commitTokopayGateway(db, { order, sentinel, gateway })` → `{ committed, charge }`, throws `TokopayChargeUnavailableError` (Task 4).
- Produces:
  - Checkout totals API (`computeTotals` result and the checkout / instant-buy JSON): the fields `qris_admin_fee` and `qris_grand_total` are REMOVED.
  - Pay-page API `order.qris_admin_fee` / `order.qris_grand_total`: unchanged names; `string | null`; non-null only for a TokoPay order that has a stored gateway charge.
  - Locale keys: `web.qris_admin_fee_note` = "+ biaya admin QRIS" (id) / "+ QRIS admin fee" (en); new `web.qris_admin_fee_at_payment` = "Ditambahkan di halaman pembayaran" (id) / "Added on the payment page" (en).

- [ ] **Step 1: Write the failing server tests**

`apps/storefront/test/tokopay-webhook.test.ts` (reuse the file's order helper and its `checkTransaction` stub; order total 50000):

1. Snapshot 50025, live `{ paid: true, amount: 50025 }` → response status `delivered` or `processing`; order is not UNDERPAID.
2. Snapshot 50025, live amount 50000 → response `amount mismatch`; order `UNDERPAID`; `qrisUnderpaidTx.expectedAmount.toString() === "50025"`.
3. Snapshot 50025, live amount 50100 → delivered and the ledger row `outcome === "overpaid"`.

The storefront test that covers the pay view (mock `createTransaction` the way that file does):

4. `createTransaction` resolves `totalBayar: "50025"` for a 50000 order → `body.order.qris_grand_total === "50025"`, `body.order.qris_admin_fee === "25"`, and the order row's `gatewayChargeAmount` is 50025.
5. A second pay-view request reads the cache: `createTransaction` called once in total, `qris_grand_total` still `"50025"`.
6. `createTransaction` resolves `totalBayar: null` → the gateway-error flag the existing "gateway failure" test asserts is set, no QR data is returned, `gatewayChargeAmount` is null and `paymentRef` is null (slot released).
7. Same as 6 with `totalBayar: "49000"`.
8. Checkout totals for a cart: the JSON has no `qris_admin_fee` and no `qris_grand_total` key.

Write all eight out in full.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/storefront/test/tokopay-webhook.test.ts <the pay-view / checkout test files>`
Expected: new cases FAIL.

- [ ] **Step 3: Server — checkout totals**

In `computeTotals` delete the "QRIS admin fee preview" comment, the `qrisAdminFee` / `qrisGrandTotal` constants and both properties from the returned object. In the checkout view (about `:478-479`) delete the `qris_admin_fee` and `qris_grand_total` lines. Typecheck will show any other reader of `totals.qrisAdminFee` / `totals.qrisGrandTotal` (the instant-buy view may be one): delete those lines too.

- [ ] **Step 4: Server — pay page**

Replace the comment and the two constants at about `:1094-1099` with:

```ts
  // What the buyer must pay on a TokoPay order is TokoPay's own figure, stored
  // on the order when its transaction is created (commitTokopayGateway). There
  // is no fee formula in this codebase: until that figure exists the page has
  // no fee and no grand total to show.
  let qrisGrandTotal: Decimal | null =
    isQris && order.gatewayChargeAmount != null ? expectedTokopayCharge(order) : null;
```

In the creation `try`, replace the `commitGatewayResult(...)` call and its `if (!committed)` with:

```ts
            const result = await commitTokopayGateway(prisma, { order, sentinel: claimSentinel, gateway });
            qrisGrandTotal = result.charge;
            if (!result.committed) {
              logger.warn(`Created a TokoPay transaction for order ${order.orderCode} but couldn't cache it — the order's payment reference changed elsewhere during the external call.`);
            }
```
and make `gateway = null;` the first statement of that `catch` block, so a transaction whose total was refused is never rendered.

Directly after the closing brace of the `if (isQris && state === "waiting") { … }` block add:

```ts
  const qrisAdminFee = qrisGrandTotal ? qrisGrandTotal.minus(order.totalAmount) : null;
```

- [ ] **Step 5: Server — webhook and imports**

`:1329` → `const expectedCharge = expectedTokopayCharge(order);`

Remove `computeQrisAdminFee` and `qrisChargeAmount` from the `@app/core/payments/tokopay` import; add `import { expectedTokopayCharge } from "@app/core/payments/tokopayCharge";`; import `commitTokopayGateway` where `getTokopayCreds` is imported. Keep `commitGatewayResult` (PayDisini and NOWPayments use it).

- [ ] **Step 6: Locale**

`packages/core/locales/id.json`: set `"web.qris_admin_fee_note": "+ biaya admin QRIS"` and add `"web.qris_admin_fee_at_payment": "Ditambahkan di halaman pembayaran"` directly after it.
`packages/core/locales/en.json`: `"web.qris_admin_fee_note": "+ QRIS admin fee"` and `"web.qris_admin_fee_at_payment": "Added on the payment page"`.

- [ ] **Step 7: Write the failing client tests**

`OrderSummaryCard.test.tsx`: with `method="qris"`, the row labelled `web.qris_admin_fee` shows the text of `web.qris_admin_fee_at_payment` and no currency figure, and the order total shows `totals.total`. With another method the row is absent. Remove `qris_admin_fee` / `qris_grand_total` from the fixtures.
`CheckoutPage.test.tsx`, `InstantBuyPage.test.tsx`: remove the two fields from fixtures; the pay button / purchase price for QRIS shows the plain total (update the assertions that expected the fee-inclusive `159206` / `20240` to the plain totals `158000` / `20000` — check the fixture's own `total`).
`PaymentMethodSelector.test.tsx`: remove the two fields from fixtures.

Run: `pnpm exec vitest run apps/storefront/client/src/components/shop/OrderSummaryCard.test.tsx apps/storefront/client/src/pages/CheckoutPage.test.tsx apps/storefront/client/src/pages/InstantBuyPage.test.tsx apps/storefront/client/src/components/shop/PaymentMethodSelector.test.tsx`
Expected: the changed assertions FAIL.

- [ ] **Step 8: Client**

- `api/types.ts:383-384`: delete `qris_admin_fee: string;` and `qris_grand_total: string;` from the checkout data type (keep the nullable pair on the pay-page order type at `:525-526`).
- `OrderSummaryCard.tsx`: the QRIS row becomes

```tsx
    {method === "qris" && (
      <div className="flex justify-between gap-3 py-2">
        <span className="text-ink-soft">{t("web.qris_admin_fee")}</span>
        <span className="text-right text-ink-soft">{t("web.qris_admin_fee_at_payment")}</span>
      </div>
    )}
```
and the total becomes `<Price value={totals.total} fx={fx} size="text-2xl" />`. Remove props/variables that are now unused (for example `priceAndPay` or `formatIdr` if nothing else in the file uses them).
- `OrderSummaryCard.helpers.ts`: the payable is `totals.total` for every IDR method; narrow the `Pick` to `"total"` and update the doc comment (QRIS no longer has a fee-inclusive figure before payment).
- `CheckoutPage.tsx:788` and `InstantBuyPage.tsx:783`: use `totals.total` unconditionally. Remove `qris_admin_fee: string; qris_grand_total: string;` from the inline `page` prop types at `CheckoutPage.tsx:657`, `:704`, `:804`.

Do not add suppressions or disable lint rules.

- [ ] **Step 9: Update remaining storefront server tests that used the old helpers**

In `apps/storefront/test/tokopay-webhook.test.ts`: tests that paid `qrisChargeAmount(total)` now set an explicit snapshot on the order (`gatewayChargeAmount = total + 25`) and pay that literal; remove the old imports; recompute the literals at about `:225` / `:229`. Fix any other storefront server test that asserted a server-computed checkout fee (`grep -n "qris_admin_fee\|qris_grand_total" apps/storefront/test/*.ts`).

- [ ] **Step 10: Run tests, typecheck, lint, doctor**

Run: `pnpm exec vitest run apps/storefront/test/tokopay-webhook.test.ts <other storefront server tests you changed> apps/storefront/client/src/components/shop/OrderSummaryCard.test.tsx apps/storefront/client/src/pages/CheckoutPage.test.tsx apps/storefront/client/src/pages/InstantBuyPage.test.tsx apps/storefront/client/src/components/shop/PaymentMethodSelector.test.tsx packages/core/src/locales.test.ts`
Expected: PASS.
Run: `grep -rn "qrisChargeAmount\|computeQrisAdminFee" apps/storefront/src; grep -rn "qris_grand_total\|qris_admin_fee" apps/storefront/client/src --include=*.ts --include=*.tsx | grep -v "\.test\." | grep -v PayPage | grep -v "types.ts"`
Expected: no output.
Run: typecheck for the storefront server package and the storefront client package (names from their `package.json`), the storefront lint script (see root `package.json` `lint`), and `pnpm doctor:changed`.
Expected: all exit 0; doctor reports 0 errors and 0 warnings for the changed files. Paste the doctor summary into your report.

- [ ] **Step 11: Commit**

```bash
git add apps/storefront/src/routes/checkout.ts apps/storefront/client/src/api/types.ts apps/storefront/client/src/components/shop/OrderSummaryCard.tsx apps/storefront/client/src/components/shop/OrderSummaryCard.helpers.ts apps/storefront/client/src/pages/CheckoutPage.tsx apps/storefront/client/src/pages/InstantBuyPage.tsx packages/core/locales/id.json packages/core/locales/en.json <every test file you changed, by name>
git commit -m "fix(storefront): show TokoPay's own total; no fee estimate before the QR" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 7: Bot — QR caption and reconcile

**Files:**
- Modify: `apps/order-bot/src/util/qrisCaption.ts`
- Modify: `apps/order-bot/src/handlers/checkout.ts` (TokoPay branch, about `:2038-2111`)
- Modify: `apps/order-bot/src/handlers/walletTopup.ts` (TokoPay branch, about `:678-715`)
- Modify: `apps/order-bot/src/payments/tokopayReconcile.ts:184`
- Test: `apps/order-bot/test/qris-caption.test.ts`, `tokopay-reconcile.test.ts`, `handlers.test.ts`, `wallet-topup.test.ts`, `display-currency.test.ts`, `game-topup-e2e.test.ts`, `payment-idempotency-matrix.test.ts`, and every bot test that mocks `createTransaction` with a `totalBayar`

Read `.claude/skills/bot-ux-grammy/SKILL.md` ("Message budget") before editing the handlers.

**Interfaces:**
- Consumes: `commitTokopayGateway`, `TokopayChargeUnavailableError` (Task 4); `expectedTokopayCharge` (Task 3).
- Produces: `qrisCaptionAmounts(order: QrisCaptionOrder, lang: string | null | undefined, chargeAmount: Decimal.Value): QrisCaptionAmounts` — third argument required; `adminFee` in the result is `chargeAmount − total` (never below zero).

- [ ] **Step 1: Write the failing tests**

`qris-caption.test.ts` — pass the charge as the third argument in every existing call (order total + 25), and add:

```ts
it("prints the charge it is given and derives the fee row from it", () => {
  const rows = qrisCaptionAmounts(
    { subtotalAmount: "50000", bulkDiscountAmount: "0", discountAmount: "0", walletUsed: "0", totalAmount: "50000" },
    "id",
    "50025",
  );
  expect(rows.chargeAmount.toString()).toBe("50025");
  expect(rows.adminFee.toString()).toBe("25");
  expect(rows.fee).toBe(formatIdrFor(new Decimal("25"), "id"));
  expect(rows.amount).toBe(formatIdrFor(new Decimal("50025"), "id"));
});
```

`tokopay-reconcile.test.ts` (same mocks as the existing "delivers a pending TOKOPAY order" case; order total 50000, snapshot 50025):
1. `checkTransaction` → `{ paid: true, amount: 50025 }` → the order leaves PENDING_PAYMENT, is not UNDERPAID, no admin underpaid alert is sent.
2. `checkTransaction` → `{ paid: true, amount: 50000 }` → order `UNDERPAID`; `qrisUnderpaidTx.expectedAmount.toString() === "50025"`.

`handlers.test.ts` (existing TokoPay checkout test, about line 4304): make `createTransaction` return `totalBayar: "50025"` for a 50000 order and assert the caption contains `formatIdrFor(new Decimal("50025"), lang)` and `formatIdrFor(new Decimal("25"), lang)`, the order row's `gatewayChargeAmount` is 50025, and the exact Telegram call counts that test already pins are unchanged. Add a case with `totalBayar: null`: no photo is sent, the order ends CANCELLED with reason `gateway_create_failed`, and the buyer's bubble is edited once to `checkout.payment_unavailable` (assert exact `sendPhoto` / `sendMessage` / `editMessageText` counts with that file's spies).

`wallet-topup.test.ts`: the same two cases for the IDR TokoPay top-up.

Write every case out in full.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/order-bot/test/qris-caption.test.ts apps/order-bot/test/tokopay-reconcile.test.ts apps/order-bot/test/handlers.test.ts apps/order-bot/test/wallet-topup.test.ts`
Expected: new cases FAIL.

- [ ] **Step 3: `qrisCaption.ts`**

Remove the `computeQrisAdminFee` import; new signature and fee derivation:

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
Return `amount: formatIdrFor(charge, l)` and `chargeAmount: charge`. In the header example change `+Rp660` / `Rp80.660` to `+Rp25` / `Rp80.025`.

- [ ] **Step 4: `handlers/checkout.ts`**

Delete the comment and the `adminFee` / `chargeAmount` constants above the claim (about `:2038-2041`). Change `let gateway;` to `let gateway;` plus `let chargeAmount: Decimal;`. In the `try`, replace the `commitGatewayResult(...)` call and its `if (!committed)` with:

```ts
    // Stores TokoPay's own total on the order together with the cached
    // transaction (tagged `gateway: "tokopay"` for the storefront's cache
    // reader) and hands back the figure to print beside the QR. Throws when
    // TokoPay reported no usable total; the catch below then cancels the order
    // shell exactly as for a failed transaction creation.
    const result = await commitTokopayGateway(prisma, { order, sentinel: claimSentinel, gateway });
    chargeAmount = result.charge;
    if (!result.committed) {
      logger.warn(`Created a TokoPay transaction for order ${order.orderCode} but couldn't cache it — the order's payment reference changed elsewhere during the external call.`);
    }
```
Change the caption rows call to `qrisCaptionAmounts(order, lang, chargeAmount)`. `payText` keeps using `chargeAmount`. Replace any later use of the removed `adminFee` with `rows.adminFee`. Imports: remove `computeQrisAdminFee`; add `commitTokopayGateway` beside `getTokopayCreds`; keep `commitGatewayResult` (other rails use it).

- [ ] **Step 5: `handlers/walletTopup.ts`**

The same change in the TokoPay top-up function: delete the two constants at about `:678-679`; `let gateway; let chargeAmount: Decimal;`; replace the `commitGatewayResult` call at about `:690` and its warning with the `commitTokopayGateway` block (message says "wallet top-up order"); `qrisCaptionAmounts(order, ctx.session.lang, chargeAmount)`. Fix the imports the same way.

- [ ] **Step 6: `payments/tokopayReconcile.ts`**

`:184` → `const expectedCharge = expectedTokopayCharge(order);` and replace the `qrisChargeAmount` import with `import { expectedTokopayCharge } from "@app/core/payments/tokopayCharge";`. If `PendingOrder` is a hand-written type, add `gatewayChargeAmount: Decimal | null`.

- [ ] **Step 7: Update existing bot tests**

- Tests that used `qrisChargeAmount(x)` / `computeQrisAdminFee(x)` (`handlers.test.ts`, `display-currency.test.ts`, `game-topup-e2e.test.ts`, `payment-idempotency-matrix.test.ts`, `tokopay-reconcile.test.ts`, `qris-caption.test.ts`): give the order an explicit snapshot (`gatewayChargeAmount = total + 25`) or have the `createTransaction` mock return that figure as `totalBayar`, and assert against the literal. Remove the old imports.
- Many bot tests mock `createTransaction` with a `totalBayar` below their order total (for example `"100"`) or null; that is now refused and no QR is sent. Find them with `grep -rn "totalBayar" apps/order-bot/test` and make each mock return `String(orderTotal + 25)` for its order. Files include `wallet-topup`, `tiered-pricing-bot`, `nickname-check`, `handlers`, `game-account-input`, `display-currency`, `customer-info`, `back-navigation`, `game-topup-e2e`.

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm exec vitest run apps/order-bot/test/qris-caption.test.ts apps/order-bot/test/tokopay-reconcile.test.ts apps/order-bot/test/handlers.test.ts apps/order-bot/test/wallet-topup.test.ts apps/order-bot/test/display-currency.test.ts apps/order-bot/test/game-topup-e2e.test.ts apps/order-bot/test/payment-idempotency-matrix.test.ts <every other bot test file whose mock you changed> apps/order-bot/test/money-input-guard.test.ts apps/order-bot/test/keyboard-label-guard.test.ts`
Expected: PASS. Re-run a file alone if it fails only under load.
Run: `grep -rn "qrisChargeAmount\|computeQrisAdminFee" apps/order-bot/src`
Expected: no output.
Run: `pnpm --filter <order-bot package name> typecheck`
Expected: exits 0.

Report the before and after test counts of each touched test file.

- [ ] **Step 9: Commit**

```bash
git add apps/order-bot/src/util/qrisCaption.ts apps/order-bot/src/handlers/checkout.ts apps/order-bot/src/handlers/walletTopup.ts apps/order-bot/src/payments/tokopayReconcile.ts <every bot test file you changed, by name>
git commit -m "fix(bot): QR caption and reconcile use TokoPay's own total" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 8: Remove the hard-coded formula, update docs

**Files:**
- Modify: `packages/core/src/payments/tokopay.ts:90-123` (delete), `packages/core/src/payments/tokopay.test.ts` (delete the formula tests, about `:95-121`)
- Modify: `apps/web-admin/test/payments-mutations-idempotency.test.ts`
- Modify: `docs/arsitektur/FINANCE_ARCHITECTURE.md` (about `:1061-1064`, `:1192`), `docs/arsitektur/PAYMENT_GATEWAY.md`, `docs/CHANGELOG.md`, `docs/REACT_DOCTOR_PHASE_1_REPORT.md`

**Interfaces:**
- Produces: `computeQrisAdminFee`, `qrisChargeAmount`, `QRIS_ADMIN_FEE_FLAT`, `QRIS_ADMIN_FEE_PERCENT` no longer exist.

- [ ] **Step 1: Confirm no source file still uses the old helpers**

Run: `grep -rn "qrisChargeAmount\|computeQrisAdminFee\|QRIS_ADMIN_FEE_" apps packages tests --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=static`
Expected: matches only in `packages/core/src/payments/tokopay.ts`, `packages/core/src/payments/tokopay.test.ts`, `apps/web-admin/test/payments-mutations-idempotency.test.ts`, and comments. Any other source file is a missed caller: switch it to `expectedTokopayCharge(order)` before continuing, and say so in your report.

- [ ] **Step 2: Delete**

In `packages/core/src/payments/tokopay.ts` delete the "QRIS admin-fee constants" comment, both constants, `computeQrisAdminFee` and `qrisChargeAmount` (lines 90-123). Keep the `Decimal` import (`createTransaction` uses it). In `tokopay.test.ts` delete the describe block(s) for those helpers and their imports. In `apps/web-admin/test/payments-mutations-idempotency.test.ts` replace each `qrisChargeAmount(total)` with an explicit snapshot on the order (`gatewayChargeAmount = total + 25`) and that literal; remove the import. Fix comments elsewhere that still name the deleted helpers.

- [ ] **Step 3: Docs**

- `docs/arsitektur/FINANCE_ARCHITECTURE.md`: replace the description of `computeQrisAdminFee` (Rp100 + 0.70%) with: the buyer-side QRIS surcharge is `Order.gatewayChargeAmount − Order.totalAmount`, where `gatewayChargeAmount` is TokoPay's `total_bayar` stored when the transaction is created; `expectedTokopayCharge` (`packages/core/src/payments/tokopayCharge.ts`) is the one resolver; there is no fee formula in code.
- `docs/arsitektur/PAYMENT_GATEWAY.md`: in the TokoPay section add an "Admin fee" paragraph with the same facts, plus: TokoPay has no tariff API (checked 2026-11-11); before the QR exists the buyer sees only a note that a fee is added; a transaction without a usable `total_bayar` shows no QR.
- `docs/CHANGELOG.md`: under the newest heading: "TokoPay QRIS: payments are matched against the total TokoPay reports per order; the hard-coded Rp100 + 0.7% is gone and the checkout no longer shows a fee estimate. Deploy: apply the two `order_gateway_charge_amount` migrations and restart order-bot before the new code runs; release server and storefront client together."
- `docs/REACT_DOCTOR_PHASE_1_REPORT.md`: add a dated entry for this change with the results of the three doctor runs in Step 4.

- [ ] **Step 4: Checks**

Run: `pnpm exec vitest run packages/core/src/payments/tokopay.test.ts packages/core/src/payments/tokopayCharge.test.ts apps/web-admin/test/payments-mutations-idempotency.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: exits 0.
Run: `pnpm doctor:changed`, `pnpm doctor:bugs`, `pnpm doctor:full`
Expected: 0 errors and 0 warnings across both clients. Fix any finding at its cause (no suppressions) and re-run until clean; record the final figures in the report file above.
Run: `pnpm test:changed`
Expected: PASS (the locale change from Task 6 makes this run the whole suite; re-run a file alone if it fails only in the full run).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/payments/tokopay.ts packages/core/src/payments/tokopay.test.ts apps/web-admin/test/payments-mutations-idempotency.test.ts docs/arsitektur/FINANCE_ARCHITECTURE.md docs/arsitektur/PAYMENT_GATEWAY.md docs/CHANGELOG.md docs/REACT_DOCTOR_PHASE_1_REPORT.md <any other file you changed, by name>
git commit -m "refactor: remove the hard-coded TokoPay fee formula" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

## Final gate (controller, after all tasks)

1. `git fetch` and rebase onto latest `master` (the branch is not pushed).
2. `pnpm typecheck && pnpm test` — full, once.
3. Verify the backfill SQL by hand on the worktree database: one TOKOPAY/IDR order with `total_amount = 50000` and a null `gateway_charge_amount`; run the backfill statement, expect `50450`; run it again, expect no change.
4. Whole-branch review on Opus (money-critical).

## Deploy notes

1. Apply both migrations and restart order-bot before the new code runs.
2. Release the server and the storefront client together.
3. Re-enable TokoPay. Nothing has to be configured.
