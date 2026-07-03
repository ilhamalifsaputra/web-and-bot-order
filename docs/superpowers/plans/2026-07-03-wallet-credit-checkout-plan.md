# Wallet-Credit Checkout Submenu + Zero-Total Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the duplicate "USDT" checkout button label, consolidate the two direct wallet-credit buttons into a single "Use Wallet Credit" submenu, and add a real "Complete Order" path for orders fully paid by wallet credit (today there is no code path that finishes such an order at all).

**Architecture:** A new `PaymentMethod.WALLET` rail, implemented as a thin composition of existing primitives (`createOrderDirect` → `finalizeOrderPayment` → optionally `applyUsdtWalletToOrder` → `approveOrder`) — the same shape `createInternalOrder` (Binance) already uses, plus the same "claim → deliver → notify" tail `deliverPaidTokopayOrder` uses for auto-confirmed payments. On the bot side, the two direct wallet buttons become one entry point that opens a submenu (mirroring the existing `usdtMethodsKb` pattern), and the confirmation screen swaps its gateway buttons for a single "Complete Order" button whenever the active wallet credit brings the total to exactly zero.

**Tech Stack:** TypeScript, grammY (Telegram bot), Prisma (SQLite), Vitest.

## Global Constraints

- Money is always `Decimal` (`@app/core/money`), never `float`.
- `en.json`/`id.json` must keep identical key sets and identical `{placeholder}` sets per key (enforced by `packages/core/src/locales.test.ts`).
- No raw SQL — new DB logic goes in `packages/db/src/crud/*`, colocated Vitest tests.
- IDR credit and USDT credit are mutually exclusive on a single order (never combined) — the schema has one `walletUsed`/`currency` per `Order`, and refund-on-cancel credits back based on `order.currency` (`packages/db/src/crud/orders.ts:597-605`).
- `pnpm typecheck` and `pnpm test` must stay green after every task.
- Design source: `docs/superpowers/specs/2026-07-03-wallet-credit-checkout-design.md`. Two deviations from that spec, discovered during planning:
  1. The completion logic reuses `createOrderDirect`/`finalizeOrderPayment`/`applyUsdtWalletToOrder` directly instead of re-deriving pricing from scratch, and lives in its own file (`crud/wallet_checkout.ts`) rather than inside `orders.ts` — this matches how every other payment rail (`tokopay.ts`, `binance_internal.ts`, `nowpayments.ts`, ...) already gets its own file.
  2. The spec's §7 called for a web-admin "WALLET → Wallet" label entry. Checked `apps/web-admin/client/src/pages/OrdersPage.tsx:189-193`: `paymentMethod` is rendered as a raw string with no label map at all (`TOKOPAY`/`BINANCE_INTERNAL`/etc. already show as-is today) — so `WALLET` needs no new mapping and this plan makes no web-admin changes.

---

### Task 1: `PaymentMethod.WALLET` + `finalizeOrderPayment` support

**Files:**
- Modify: `packages/core/src/enums.ts` (the `PaymentMethod` const, ~line 128-154)
- Modify: `packages/db/src/crud/pricing.ts` (the `PaymentChoice` type, lines 92-116, and the `cents` line inside `finalizeOrderPayment`, line 160)
- Test: `packages/db/src/crud/pricing.test.ts`

**Interfaces:**
- Produces: `PaymentMethod.WALLET` (string `"WALLET"`), usable anywhere a `PaymentMethod` is accepted. `finalizeOrderPayment(db, orderId, { currency: "IDR", method: PaymentMethod.WALLET })` and `finalizeOrderPayment(db, orderId, { currency: "USDT", rate, method: PaymentMethod.WALLET })` both now type-check and, for the USDT case, never attach unique cents.

- [ ] **Step 1: Write the failing test — WALLET method skips unique cents even when `USE_UNIQUE_CENTS` is on**

Add to `packages/db/src/crud/pricing.test.ts`, inside a new `describe` block placed after the existing `"finalizeOrderPayment — PaymentChoice widening (PAYDISINI/NOWPAYMENTS)"` block (after line 115):

```ts
describe("finalizeOrderPayment — WALLET method never attaches unique cents", () => {
  let sample: SampleData;
  let orderId: number;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const created = await createOrderFromCart(prisma, { user: sample.user });
    orderId = created!.id;
  });

  it("IDR + method: WALLET strips unique cents (same as the no-method default)", async () => {
    const order = await finalizeOrderPayment(prisma, orderId, {
      currency: "IDR",
      method: PaymentMethod.WALLET,
    });
    expect(order!.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(new Decimal(order!.uniqueCents).equals(0)).toBe(true);
  });

  it("USDT + method: WALLET stays at exactly the converted total even with USE_UNIQUE_CENTS on", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      const order = await finalizeOrderPayment(prisma, orderId, {
        currency: "USDT",
        rate: "16000",
        method: PaymentMethod.WALLET,
      });
      expect(order!.paymentMethod).toBe(PaymentMethod.WALLET);
      expect(new Decimal(order!.uniqueCents).equals(0)).toBe(true);
      expect(new Decimal(order!.totalAmount).equals(usdtFromIdr(new Decimal("5.00"), "16000"))).toBe(true);
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/db/src/crud/pricing.test.ts`
Expected: FAIL — TypeScript error, `PaymentMethod.WALLET` doesn't exist yet / isn't assignable to `PaymentChoice["method"]`.

- [ ] **Step 3: Add `WALLET` to the `PaymentMethod` const**

In `packages/core/src/enums.ts`, inside the `PaymentMethod` const object (find the closing lines around `TOKOPAY: "TOKOPAY",` / `PAYDISINI: "PAYDISINI",`), add:

```ts
  /** Order fully paid by the buyer's wallet credit (IDR or USDT) — no
   *  external gateway involved. Created and delivered synchronously in one
   *  request (see packages/db/src/crud/wallet_checkout.ts); never sits in
   *  PENDING_PAYMENT long enough for a poller to see it. */
  WALLET: "WALLET",
```

- [ ] **Step 4: Widen `PaymentChoice` and guard unique cents in `finalizeOrderPayment`**

In `packages/db/src/crud/pricing.ts`, replace the `PaymentChoice` type (lines 92-116):

```ts
export type PaymentChoice =
  | {
      currency: typeof OrderCurrency.IDR;
      /** TOKOPAY (default jika tidak diisi — caller existing TIDAK pass ini,
       *  jadi perilaku TokoPay byte-identik), PAYDISINI, atau WALLET (dibayar
       *  penuh dari saldo kredit, tanpa gateway). */
      method?: typeof PaymentMethod.TOKOPAY | typeof PaymentMethod.PAYDISINI | typeof PaymentMethod.WALLET;
    }
  /** Pay in USDT via Binance — charged the derived, rounded USDT total. */
  | {
      currency: typeof OrderCurrency.USDT;
      rate: Decimal.Value;
      /**
       * BINANCE_INTERNAL (auto-confirm via note, default), BYBIT (auto-confirm
       * via Bybit Internal Transfer UID, matched by unique amount), BYBIT_BSC
       * (auto-confirm via on-chain BSC deposit, also matched by unique
       * amount), BINANCE_PAY (manual proof, bot only), NOWPAYMENTS
       * (auto-confirm via hosted invoice IPN webhook), or WALLET (dibayar
       * penuh dari saldo kredit USDT, tanpa gateway).
       */
      method?:
        | typeof PaymentMethod.BINANCE_INTERNAL
        | typeof PaymentMethod.BYBIT
        | typeof PaymentMethod.BYBIT_BSC
        | typeof PaymentMethod.BINANCE_PAY
        | typeof PaymentMethod.NOWPAYMENTS
        | typeof PaymentMethod.WALLET;
    };
```

Then replace line 160 (`let cents = config.USE_UNIQUE_CENTS ? computeUniqueCents(order.id) : new Decimal(0);`) with:

```ts
  // WALLET orders are pure ledger entries — there is no on-chain/gateway
  // transfer to disambiguate, so unique cents (which would otherwise leave a
  // nonzero remainder even when wallet credit fully covers the order) never
  // apply here.
  let cents =
    config.USE_UNIQUE_CENTS && method !== PaymentMethod.WALLET
      ? computeUniqueCents(order.id)
      : new Decimal(0);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/db/src/crud/pricing.test.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/enums.ts packages/db/src/crud/pricing.ts packages/db/src/crud/pricing.test.ts
git commit -m "feat(db): add PaymentMethod.WALLET, exempt it from unique-cents"
```

---

### Task 2: `completeOrderWithWalletCredit` crud function

**Files:**
- Create: `packages/db/src/crud/wallet_checkout.ts`
- Test: `packages/db/src/crud/wallet_checkout.test.ts`
- Modify: `packages/db/src/index.ts` (add the export line)

**Interfaces:**
- Consumes: `createOrderDirect`, `getOrder`, `approveOrder`, `applyUsdtWalletToOrder` (all from `./orders`); `finalizeOrderPayment` (from `./pricing`); `transitionOrderStatus` (from `./orderStatus`); `enqueueNotification` (from `./notifications`); `PaymentMethod.WALLET` (Task 1).
- Produces:
  ```ts
  export type WalletCheckoutResult = {
    order: NonNullable<Awaited<ReturnType<typeof getOrder>>>;
    credentials: string[];
  };
  export async function completeOrderWithWalletCredit(
    db: Db,
    args: {
      user: { id: number; role: string; walletBalance?: Decimal.Value; walletBalanceUsdt?: Decimal.Value };
      productId: number;
      quantity: number;
      voucherCode?: string | null;
      currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT;
      rate?: Decimal.Value; // required when currency === "USDT"
    },
  ): Promise<WalletCheckoutResult>
  ```
  Throws `ValidationError` with key `error.insufficient_wallet` if, after applying the requested credit, the order's total isn't exactly zero; propagates `error.out_of_stock` / `error.voucher_not_found` / etc. unchanged from `createOrderDirect`. Callers MUST run this inside `prisma.$transaction(...)` — a thrown error must roll back the wallet deduction `createOrderDirect` already applied.

- [ ] **Step 1: Write the failing tests**

Create `packages/db/src/crud/wallet_checkout.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { OrderCurrency, OrderStatus, PaymentMethod, StockStatus } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { adjustWallet, getOrder, markStockDead } from "@app/db";
import { completeOrderWithWalletCredit } from "./wallet_checkout";

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
  sample = await buildSampleData(prisma); // product price "5.00" IDR
});

async function freshUser() {
  return prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
}

describe("completeOrderWithWalletCredit — IDR track", () => {
  it("fully covered by IDR credit: delivers immediately, debits exactly the price, method WALLET", async () => {
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.IDR,
      }),
    );

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(result.order.currency).toBe(OrderCurrency.IDR);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);
    expect(new Decimal(result.order.walletUsed).equals("5.00")).toBe(true);
    expect(result.credentials).toHaveLength(1);

    const after = await freshUser();
    expect(Number(after.walletBalance)).toBeCloseTo(5); // 10 - 5.00

    const sold = await prisma.stockItem.findMany({ where: { productId: sample.product.id, status: StockStatus.SOLD } });
    expect(sold).toHaveLength(1);
  });

  it("insufficient IDR balance: throws, makes no wallet or stock change", async () => {
    await adjustWallet(prisma, sample.user.id, "2", { currency: "IDR", reason: "admin_adjust" }); // less than the 5.00 price
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
          productId: sample.product.id,
          quantity: 1,
          currency: OrderCurrency.IDR,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.insufficient_wallet" });

    const after = await freshUser();
    expect(Number(after.walletBalance)).toBeCloseTo(2); // untouched — the transaction rolled back
    const sold = await prisma.stockItem.findMany({ where: { productId: sample.product.id, status: StockStatus.SOLD } });
    expect(sold).toHaveLength(0);
  });

  it("voucher discount + IDR credit combine to reach zero", async () => {
    // SAVE10 = 10% off, minPurchase 3 — product is 5.00, discount 0.50, net 4.50.
    await adjustWallet(prisma, sample.user.id, "4.50", { currency: "IDR", reason: "admin_adjust" });
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalance: user.walletBalance },
        productId: sample.product.id,
        quantity: 1,
        voucherCode: sample.voucher.code,
        currency: OrderCurrency.IDR,
      }),
    );
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);
    expect(new Decimal(result.order.discountAmount).equals("0.50")).toBe(true);
  });
});

describe("completeOrderWithWalletCredit — USDT track", () => {
  it("fully covered by USDT credit: delivers immediately, debits the converted total, IDR balance untouched", async () => {
    // rate 1 keeps the USDT total numerically equal to the 5.00 central price.
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    await adjustWallet(prisma, sample.user.id, "100", { currency: "IDR", reason: "admin_adjust" });
    const user = await freshUser();

    const result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: { id: user.id, role: user.role, walletBalanceUsdt: user.walletBalanceUsdt },
        productId: sample.product.id,
        quantity: 1,
        currency: OrderCurrency.USDT,
        rate: 1,
      }),
    );

    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.order.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(result.order.currency).toBe(OrderCurrency.USDT);
    expect(new Decimal(result.order.totalAmount).equals(0)).toBe(true);

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(0); // 5 - 5
    expect(Number(after.walletBalance)).toBeCloseTo(100); // IDR untouched
  });

  it("insufficient USDT balance: throws, IDR and USDT balances both untouched", async () => {
    await adjustWallet(prisma, sample.user.id, "1", { currency: "USDT", reason: "admin_adjust" }); // less than 5
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalanceUsdt: user.walletBalanceUsdt },
          productId: sample.product.id,
          quantity: 1,
          currency: OrderCurrency.USDT,
          rate: 1,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.insufficient_wallet" });

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(1);
  });

  it("out of stock at completion time: throws, wallet untouched", async () => {
    // Mark all 5 seeded stock items dead so none remain available (same
    // technique as order_creation.test.ts's own out-of-stock test).
    const items = await prisma.stockItem.findMany({ where: { productId: sample.product.id } });
    for (const it of items) await markStockDead(prisma, it.id, "test");
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    const user = await freshUser();

    await expect(
      prisma.$transaction((tx) =>
        completeOrderWithWalletCredit(tx, {
          user: { id: user.id, role: user.role, walletBalanceUsdt: user.walletBalanceUsdt },
          productId: sample.product.id,
          quantity: 1,
          currency: OrderCurrency.USDT,
          rate: 1,
        }),
      ),
    ).rejects.toMatchObject({ key: "error.out_of_stock" });

    const after = await freshUser();
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/db/src/crud/wallet_checkout.test.ts`
Expected: FAIL — `Cannot find module './wallet_checkout'`.

- [ ] **Step 3: Implement `completeOrderWithWalletCredit`**

Create `packages/db/src/crud/wallet_checkout.ts`:

```ts
/**
 * "Pay entirely with wallet credit" checkout rail — for an order fully
 * covered by either the IDR or USDT credit balance, with no external
 * gateway involved. Composes the same primitives createInternalOrder uses
 * (createOrderDirect -> finalizeOrderPayment -> applyUsdtWalletToOrder for
 * the USDT track — packages/db/src/crud/binance_internal.ts), then runs the
 * same claim -> deliver -> notify tail deliverPaidTokopayOrder uses for an
 * auto-confirmed payment (packages/db/src/crud/tokopay.ts): there is
 * nothing to wait for, the credit already fully paid for the order.
 */
import { Decimal } from "@app/core/money";
import { OrderCurrency, OrderStatus, PaymentMethod, NotificationEvent, langCode } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import type { Db } from "./_types";
import { createOrderDirect, getOrder, approveOrder, applyUsdtWalletToOrder } from "./orders";
import { finalizeOrderPayment } from "./pricing";
import { transitionOrderStatus } from "./orderStatus";
import { enqueueNotification } from "./notifications";

export type WalletCheckoutResult = {
  order: NonNullable<Awaited<ReturnType<typeof getOrder>>>;
  credentials: string[];
};

/**
 * Create + immediately deliver an order paid entirely by wallet credit.
 * Re-derives price/discount/stock from scratch via createOrderDirect — never
 * trusts a caller's "this is fully covered" claim. Throws
 * error.insufficient_wallet if, after applying the requested credit, the
 * order's total isn't exactly zero (balance changed since the caller last
 * checked, or the requested currency's credit didn't actually cover it).
 * Must run inside the caller's prisma.$transaction — a thrown error needs to
 * roll back the wallet deduction createOrderDirect already applied.
 */
export async function completeOrderWithWalletCredit(
  db: Db,
  args: {
    user: { id: number; role: string; walletBalance?: Decimal.Value; walletBalanceUsdt?: Decimal.Value };
    productId: number;
    quantity: number;
    voucherCode?: string | null;
    currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT;
    /** Rupiah per 1 USDT — required when currency is USDT. */
    rate?: Decimal.Value;
  },
): Promise<WalletCheckoutResult> {
  const created = await createOrderDirect(db, {
    user: { id: args.user.id, role: args.user.role, walletBalance: args.user.walletBalance },
    productId: args.productId,
    quantity: args.quantity,
    voucherCode: args.voucherCode,
    // Only the IDR track spends IDR credit during creation — the USDT track
    // leaves this order's walletAmount unset and applies USDT credit below,
    // exactly like createInternalOrder does for a partial USDT credit today.
    walletAmount: args.currency === OrderCurrency.IDR ? args.user.walletBalance : undefined,
  });
  if (!created) throw new ValidationError("error.order_not_found");

  if (args.currency === OrderCurrency.IDR) {
    await finalizeOrderPayment(db, created.id, { currency: OrderCurrency.IDR, method: PaymentMethod.WALLET });
  } else {
    if (!args.rate) throw new ValidationError("error.generic");
    await finalizeOrderPayment(db, created.id, {
      currency: OrderCurrency.USDT,
      rate: args.rate,
      method: PaymentMethod.WALLET,
    });
    await applyUsdtWalletToOrder(db, created.id, args.user.walletBalanceUsdt);
  }

  const finalized = await getOrder(db, created.id);
  if (!finalized) throw new ValidationError("error.order_not_found");
  if (new Decimal(finalized.totalAmount).greaterThan(0)) {
    // The requested credit didn't actually cover the order (stale preview,
    // or the balance moved between preview and this call) — refuse to
    // "complete" an order that still has money owing on it.
    throw new ValidationError("error.insufficient_wallet");
  }

  await db.order.update({ where: { id: finalized.id }, data: { paidAt: new Date() } });
  await transitionOrderStatus(db, {
    orderId: finalized.id,
    from: OrderStatus.PENDING_PAYMENT,
    to: OrderStatus.PENDING_VERIFICATION,
    meta: "wallet_full_credit",
  });
  const { order: delivered, credentials } = await approveOrder(db, finalized.id, { adminId: 0 });

  if (delivered.user.telegramId != null) {
    await enqueueNotification(db, NotificationEvent.ORDER_DELIVERED_DM, delivered.id, {
      chat_id: Number(delivered.user.telegramId),
      order_code: delivered.orderCode,
      order_url: null,
      buyer_language: langCode(delivered.user.language),
    });
  }

  return { order: delivered, credentials };
}
```

- [ ] **Step 4: Export it from the package index**

In `packages/db/src/index.ts`, add (after the `export * from "./crud/nowpayments";` line):

```ts
export * from "./crud/wallet_checkout";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/db/src/crud/wallet_checkout.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Typecheck and run the full DB package test suite**

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm vitest run packages/db`
Expected: PASS — confirms Task 1/2's changes didn't regress any existing order/pricing/wallet test.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/crud/wallet_checkout.ts packages/db/src/crud/wallet_checkout.test.ts packages/db/src/index.ts
git commit -m "feat(db): add completeOrderWithWalletCredit — pay-entirely-by-wallet checkout rail"
```

---

### Task 3: Locale fixes — duplicate "USDT" + new wallet-credit strings

**Files:**
- Modify: `packages/core/locales/en.json`
- Modify: `packages/core/locales/id.json`
- Test: `packages/core/src/locales.test.ts` (already exists — no changes needed, just must keep passing)

**Interfaces:**
- Produces these keys (both files, matching `{placeholder}` sets): `checkout.use_wallet_btn`, `checkout.wallet_active_btn` (`{currency}`, `{amount}`), `checkout.wallet_menu_idr_btn` (`{amount}`), `checkout.wallet_menu_idr_active_btn`, `checkout.wallet_menu_usdt_btn` (`{amount}`), `checkout.wallet_menu_usdt_active_btn`, `checkout.confirm_wallet_usdt_line` (`{usdt_amount}`, `{idr_amount}`), `checkout.complete_order_btn`, `checkout.wallet_paid` (`{code}`).
- Removes: `checkout.use_wallet_idr_btn`, `checkout.wallet_idr_active_btn`, `checkout.use_wallet_usdt_btn`, `checkout.wallet_usdt_active_btn` (superseded — Task 4 rewrites the keyboard code that referenced them).

- [ ] **Step 1: Run the locale parity test to see the current green baseline**

Run: `pnpm vitest run packages/core/src/locales.test.ts`
Expected: PASS (2/2) — confirms the starting point before editing.

- [ ] **Step 2: Edit `packages/core/locales/en.json`**

Replace these four lines (currently):
```json
  "checkout.use_wallet_idr_btn": "💳 Use IDR Credit ({amount})",
  "checkout.wallet_idr_active_btn": "✅ IDR Credit Applied (−{amount})",
  "checkout.use_wallet_usdt_btn": "💎 Use USDT Credit ({amount} USDT)",
  "checkout.wallet_usdt_active_btn": "✅ USDT Credit Applied (−{amount} USDT)",
```
with:
```json
  "checkout.use_wallet_btn": "💳 Use Wallet Credit",
  "checkout.wallet_active_btn": "✅ Wallet Credit Applied ({currency} −{amount})",
  "checkout.wallet_menu_idr_btn": "💳 IDR Credit ({amount} available)",
  "checkout.wallet_menu_idr_active_btn": "✅ IDR Credit",
  "checkout.wallet_menu_usdt_btn": "💎 USDT Credit ({amount} available)",
  "checkout.wallet_menu_usdt_active_btn": "✅ USDT Credit",
```

Also update `checkout.confirm_wallet_line` (keep as-is, it's still used for the IDR branch) and add a new key right after it:
```json
  "checkout.confirm_wallet_line": "IDR Credit: −{amount}\n",
  "checkout.confirm_wallet_usdt_line": "USDT Credit: −{usdt_amount} (≈ {idr_amount})\n",
```

Add two more new keys near `checkout.complete` / `checkout.confirm_btn` (alphabetical-ish grouping already used in the file — place next to `checkout.confirm_btn`):
```json
  "checkout.complete_order_btn": "✅ Complete Order",
```

And near `checkout.qris_paid` (same "payment confirmed" family):
```json
  "checkout.wallet_paid": "✅ <b>Payment received!</b>\n\nOrder <code>{code}</code> is fully covered by your wallet credit — your items are being delivered now.",
```

- [ ] **Step 3: Make the matching edits in `packages/core/locales/id.json`**

Replace:
```json
  "checkout.use_wallet_idr_btn": "💳 Pakai Kredit IDR ({amount})",
  "checkout.wallet_idr_active_btn": "✅ Kredit IDR Dipakai (−{amount})",
  "checkout.use_wallet_usdt_btn": "💎 Pakai Kredit USDT ({amount} USDT)",
  "checkout.wallet_usdt_active_btn": "✅ Kredit USDT Dipakai (−{amount} USDT)",
```
with:
```json
  "checkout.use_wallet_btn": "💳 Pakai Kredit Wallet",
  "checkout.wallet_active_btn": "✅ Kredit Wallet Dipakai ({currency} −{amount})",
  "checkout.wallet_menu_idr_btn": "💳 Kredit IDR ({amount} tersedia)",
  "checkout.wallet_menu_idr_active_btn": "✅ Kredit IDR",
  "checkout.wallet_menu_usdt_btn": "💎 Kredit USDT ({amount} tersedia)",
  "checkout.wallet_menu_usdt_active_btn": "✅ Kredit USDT",
```

Add next to `checkout.confirm_wallet_line`:
```json
  "checkout.confirm_wallet_line": "Kredit IDR: −{amount}\n",
  "checkout.confirm_wallet_usdt_line": "Kredit USDT: −{usdt_amount} (≈ {idr_amount})\n",
```

Add near `checkout.confirm_btn`:
```json
  "checkout.complete_order_btn": "✅ Selesaikan Pesanan",
```

Add near `checkout.qris_paid`:
```json
  "checkout.wallet_paid": "✅ <b>Pembayaran diterima!</b>\n\nPesanan <code>{code}</code> sudah lunas dari kredit wallet Anda — item Anda sedang dikirim sekarang.",
```

- [ ] **Step 4: Run the locale parity test to verify it still passes**

Run: `pnpm vitest run packages/core/src/locales.test.ts`
Expected: PASS (2/2) — same key sets, same `{placeholder}` sets in both languages.

- [ ] **Step 5: Commit**

```bash
git add packages/core/locales/en.json packages/core/locales/id.json
git commit -m "fix(bot): stop doubling \"USDT\" in the wallet-credit button; add wallet-submenu strings"
```

---

### Task 4: Bot UI — wallet-credit submenu, zero-total Complete Order, routing

**Files:**
- Modify: `apps/order-bot/src/keyboards/customer.ts` (`orderConfirmKb`, lines 401-456; new `walletCreditKb` after `usdtMethodsKb`)
- Modify: `apps/order-bot/src/handlers/checkout.ts` (`ConfirmRender`/`computeConfirmation`, lines 135-228; `showOrderConfirmation`, lines 230-298; `renderOrderConfirmation`, lines 301-347; `showUsdtMethods`, lines 355-392; new `showWalletCreditMenu` and `completeOrderWithWallet`)
- Modify: `apps/order-bot/src/handlers/callbacks.ts` (`dispatchWallet`, lines 141-150; `DOMAIN_ROUTES`, lines 181-204)

**Interfaces:**
- Consumes: `PaymentMethod.WALLET`, `completeOrderWithWalletCredit` (Task 2), the new locale keys (Task 3).
- Produces: `ckb.walletCreditKb(productId, qty, lang, idrBalance, useWalletIdr, usdtBalance, useWalletUsdt): InlineKeyboard`; `checkout.showWalletCreditMenu(ctx, productId, quantity): Promise<void>`; `checkout.completeOrderWithWallet(ctx, productId, quantity): Promise<void>`. `ckb.orderConfirmKb`'s signature changes (see Step 2) — every caller in this task is updated in the same task so the repo never sits in a half-migrated, non-compiling state.

This task has no new automated tests of its own — this codebase has zero existing tests under `apps/order-bot/src/keyboards/` or for the interactive checkout handlers (verified: only crud-layer logic gets Vitest coverage here; bot rendering is verified manually). The gate for this task is `pnpm typecheck` plus the manual walkthrough at the end of the plan.

- [ ] **Step 1: Rewrite `orderConfirmKb` in `apps/order-bot/src/keyboards/customer.ts`**

Replace the whole function (currently lines 401-456):

```ts
export function orderConfirmKb(
  productId: number,
  qty: number,
  lang: string,
  voucherCode = "",
  internalEnabled = false,
  bybitEnabled = false,
  tokopayEnabled = false,
  paydisiniEnabled = false,
  nowpaymentsEnabled = false,
  bybitBscEnabled = false,
  idrBalance: Decimal | null = null,
  usdtBalance: Decimal | null = null,
  walletDeduction: { currency: "IDR" | "USDT"; amount: string } | null = null,
  fullyCovered = false,
): InlineKeyboard {
  const rows: Btn[][] = [];
  if (voucherCode) {
    rows.push([
      { text: coreT("checkout.voucher_remove_btn", lang), data: cb("voucher", "remove", productId, qty) },
    ]);
  } else {
    rows.push([
      { text: coreT("checkout.use_voucher", lang), data: cb("voucher", "start", productId, qty) },
    ]);
  }
  // Single entry point for both wallet-credit currencies — opens walletCreditKb
  // instead of toggling directly, so this screen doesn't grow a new row per
  // credit type (or per future payment method).
  const hasWalletBalance = (idrBalance != null && idrBalance.greaterThan(0)) || (usdtBalance != null && usdtBalance.greaterThan(0));
  if (hasWalletBalance) {
    rows.push([
      walletDeduction
        ? {
            text: coreT("checkout.wallet_active_btn", lang, { currency: walletDeduction.currency, amount: walletDeduction.amount }),
            data: cb("walletm", "open", productId, qty),
          }
        : { text: coreT("checkout.use_wallet_btn", lang), data: cb("walletm", "open", productId, qty) },
    ]);
  }
  if (fullyCovered) {
    // The active wallet credit already brings the total to zero — a gateway
    // button here would mean charging Rp0/​$0 through TokoPay/PayDisini/USDT,
    // which is meaningless. Offer the one action that actually applies.
    rows.push([
      { text: coreT("checkout.complete_order_btn", lang), data: cb("walletpay", productId, qty) },
    ]);
  } else {
    const hasUsdt = internalEnabled || bybitEnabled || bybitBscEnabled || nowpaymentsEnabled;
    if (tokopayEnabled) rows.push([{ text: coreT("checkout.pay_qris_btn", lang), data: cb("payq", productId, qty) }]);
    if (paydisiniEnabled) rows.push([{ text: coreT("checkout.pay_paydisini_btn", lang), data: cb("payd", productId, qty) }]);
    if (hasUsdt) rows.push([{ text: coreT("checkout.pay_usdt_btn", lang), data: cb("usdt", productId, qty) }]);
  }
  rows.push([
    { text: coreT("checkout.cancel_btn", lang), data: cb("browse", "denom", productId) },
  ]);
  return ik(rows);
}
```

- [ ] **Step 2: Add `walletCreditKb` right after `usdtMethodsKb`**

In the same file, after the closing brace of `usdtMethodsKb` (currently ending around line 480), add:

```ts
/**
 * Wallet-credit submenu — reached from the "Use Wallet Credit" entry on the
 * order confirmation. Mirrors usdtMethodsKb's shape (one row per option, a
 * Back row returns to the confirmation). IDR and USDT credit are mutually
 * exclusive on a single order (packages/db/src/crud/orders.ts's
 * releaseOrderHolds refunds by order.currency) — the walletm callback
 * dispatcher clears the other flag whenever one is turned on, so at most one
 * row here is ever "active" at a time.
 */
export function walletCreditKb(
  productId: number,
  qty: number,
  lang: string,
  idrBalance: Decimal,
  useWalletIdr: boolean,
  usdtBalance: Decimal,
  useWalletUsdt: boolean,
): InlineKeyboard {
  const rows: Btn[][] = [];
  if (idrBalance.greaterThan(0)) {
    rows.push([
      useWalletIdr
        ? { text: coreT("checkout.wallet_menu_idr_active_btn", lang), data: cb("walletm", "idr", productId, qty) }
        : {
            text: coreT("checkout.wallet_menu_idr_btn", lang, { amount: formatIdr(idrBalance) }),
            data: cb("walletm", "idr", productId, qty),
          },
    ]);
  }
  if (usdtBalance.greaterThan(0)) {
    rows.push([
      useWalletUsdt
        ? { text: coreT("checkout.wallet_menu_usdt_active_btn", lang), data: cb("walletm", "usdt", productId, qty) }
        : {
            text: coreT("checkout.wallet_menu_usdt_btn", lang, { amount: formatPrice(usdtBalance, "USDT", 4) }),
            data: cb("walletm", "usdt", productId, qty),
          },
    ]);
  }
  rows.push([{ text: coreT("menu.back", lang), data: cb("walletm", "back", productId, qty) }]);
  return ik(rows);
}
```

- [ ] **Step 3: Extend `ConfirmRender` and `computeConfirmation` in `apps/order-bot/src/handlers/checkout.ts`**

Replace the `ConfirmRender` interface (currently lines 135-146):

```ts
interface ConfirmRender {
  productName: string;
  unitPrice: Decimal;
  subtotal: Decimal;
  voucherLine: string;
  voucherCode: string;
  walletLine: string;
  idrBalance: Decimal;
  usdtBalance: Decimal;
  useWalletIdr: boolean;
  useWalletUsdt: boolean;
  /** Which currency's credit is active and how much it deducted — drives the
   *  entry button's "Applied" label. Null when no credit is toggled on. */
  walletDeduction: { currency: "IDR" | "USDT"; amount: string } | null;
  /** True once the active credit brings subtotal to exactly (or below) zero —
   *  the signal to swap the gateway buttons for "Complete Order". */
  fullyCovered: boolean;
}
```

Replace `computeConfirmation` (currently lines 148-228) — it now takes a `rate` parameter and adds the USDT-credit branch:

```ts
/** Compute the confirmation totals (shared by the inline path + voucher conv). */
async function computeConfirmation(
  ctx: MyContext,
  productId: number,
  quantity: number,
  rate: Decimal | null,
): Promise<ConfirmRender | null> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  const [product, user] = await Promise.all([
    getDenomination(prisma, productId),
    getUser(prisma, info.id),
  ]);
  if (product === null || user === null) return null;
  const bulkRule = await getBulkPricingForDenomination(prisma, productId);

  const isReseller = info.role === UserRole.RESELLER;
  const unitPrice = new Decimal(
    isReseller && product.resellerPrice != null ? product.resellerPrice : product.price,
  );
  let subtotal = unitPrice.times(quantity);
  if (bulkRule && quantity >= bulkRule.minQuantity) {
    subtotal = subtotal.times(new Decimal(1).minus(new Decimal(bulkRule.discountPercent).div(100)));
  }

  let voucherCode = (ctx.session.scratch.appliedVoucherCode as string | undefined) ?? "";
  let voucherLine = "";
  if (voucherCode) {
    try {
      const voucherObj = await getVoucherByCode(prisma, voucherCode);
      if (voucherObj) {
        const discount = applyVoucherToSubtotal(voucherObj, subtotal);
        voucherLine = coreT("checkout.confirm_voucher_line", lang, {
          code: voucherCode,
          discount: formatIdr(discount),
        });
        subtotal = subtotal.minus(discount);
      } else {
        delete ctx.session.scratch.appliedVoucherCode;
        voucherCode = "";
      }
    } catch (e) {
      // The voucher was valid when first applied but no longer is (expired /
      // used up / minimum purchase no longer met after a quantity or wallet-
      // toggle change) — this is EXPECTED, so surface the *specific* reason
      // instead of silently dropping the discount (the customer would
      // otherwise just see the total jump with zero explanation). Reuses the
      // same slot checkout.confirm_order's {voucher_line} already renders
      // into on success — matches how the first-apply path
      // (conversations/checkout.ts:81-87) surfaces the same ValidationError.
      if (e instanceof ValidationError) {
        voucherLine = `${coreT(e.key, lang, e.formatArgs)}\n`;
      } else {
        // Anything else (DB error, etc.) is unexpected — log it under a ref
        // so a customer report maps to the stack trace, same convention as
        // customer.ts's browse_denomination catch block.
        const ref = logErrorRef(e, `computeConfirmation: voucher re-validation failed for code=${voucherCode}`, {
          userId: info.id,
          productId,
        });
        voucherLine = `${coreT("error.generic_ref", lang, { ref })}\n`;
      }
      delete ctx.session.scratch.appliedVoucherCode;
      voucherCode = "";
    }
  }

  const idrBalance = new Decimal(user.walletBalance);
  const usdtBalance = new Decimal(user.walletBalanceUsdt);
  // Mutually exclusive — enforced by the walletm callback dispatcher
  // (callbacks.ts), which clears the other flag whenever one is turned on.
  const useWalletIdr = Boolean(ctx.session.scratch.useWalletIdr);
  const useWalletUsdt = Boolean(ctx.session.scratch.useWalletUsdt);

  let walletLine = "";
  let walletDeduction: ConfirmRender["walletDeduction"] = null;
  if (useWalletIdr && idrBalance.greaterThan(0)) {
    const deduction = Decimal.min(idrBalance, subtotal);
    walletLine = coreT("checkout.confirm_wallet_line", lang, { amount: formatIdr(deduction) });
    subtotal = subtotal.minus(deduction);
    walletDeduction = { currency: "IDR", amount: formatIdr(deduction) };
  } else if (useWalletUsdt && usdtBalance.greaterThan(0) && rate) {
    // Convert at the live rate so this preview matches what
    // completeOrderWithWalletCredit will actually compute — the two can
    // differ by at most the same +/-0.1 USDT rounding the whole app already
    // accepts for every USDT order (usdtFromIdr's doc-comment). That's only a
    // preview-display nuance; the crud layer re-derives its own zero-total
    // check authoritatively, so a rounding-sized mismatch here never causes
    // an incorrect charge.
    const usdtTotal = usdtFromIdr(subtotal, rate);
    const usdtDeduction = Decimal.min(usdtBalance, usdtTotal);
    const idrEquivalent = usdtDeduction.times(rate);
    walletLine = coreT("checkout.confirm_wallet_usdt_line", lang, {
      usdt_amount: formatPrice(usdtDeduction, "USDT", 4),
      idr_amount: formatIdr(idrEquivalent),
    });
    subtotal = subtotal.minus(idrEquivalent);
    walletDeduction = { currency: "USDT", amount: formatPrice(usdtDeduction, "USDT", 4) };
  }

  return {
    productName: product.name,
    unitPrice,
    subtotal,
    voucherLine,
    voucherCode,
    walletLine,
    idrBalance,
    usdtBalance,
    useWalletIdr,
    useWalletUsdt,
    walletDeduction,
    fullyCovered: subtotal.lessThanOrEqualTo(0),
  };
}
```

This needs `usdtFromIdr` in scope — add it to the existing format-utils import near the top of the file (currently `import { esc, formatPrice, formatIdr, priceIdr } from "../util/format";`):

```ts
import { esc, formatPrice, formatIdr, priceIdr, usdtFromIdr } from "../util/format";
```

- [ ] **Step 4: Update `showOrderConfirmation`**

Replace the function body (currently lines 230-298) so `rate` is fetched before `computeConfirmation` and threaded through, and the `orderConfirmKb` call matches its new signature:

```ts
export async function showOrderConfirmation(
  ctx: MyContext,
  productId: number,
  quantity: number,
): Promise<void> {
  const lang = ctx.session.lang;

  const product = await getDenomination(prisma, productId);
  if (product === null) {
    // Product vanished between render and tap. Toast for immediacy, then edit
    // the stale "Confirm & Pay" bubble into a recovery screen so the dead
    // confirm button is replaced by a forward action (never strand the user).
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.try_again"), show_alert: true });
    await smartEdit(ctx, t(ctx, "error.try_again"), ckb.backToMain(lang));
    return;
  }
  const stock = await countAvailableStock(prisma, productId);
  if (stock < quantity) {
    // Stock disappeared under the user. Toast, then replace the now-invalid
    // confirmation bubble with an out-of-stock notice + a forward action so the
    // dead "Confirm & Pay" button is gone (never strand the user).
    if (ctx.callbackQuery)
      await ctx.answerCallbackQuery({ text: t(ctx, "error.out_of_stock", { product: product.name }), show_alert: true });
    await smartEdit(
      ctx,
      t(ctx, "error.out_of_stock", { product: esc(product.name) }),
      ckb.backToMain(lang),
    );
    return;
  }

  const rate = await currentUsdtRate();
  const r = await computeConfirmation(ctx, productId, quantity, rate);
  if (!r) return;

  const binanceEnabled = (await resolveBinanceInternalConfig(prisma)).enabled;
  const bybitEnabled = (await resolveBybitConfig(prisma)).enabled;
  const bybitBscEnabled = (await resolveBybitBscConfig(prisma)).enabled;
  const tokopayEnabled = (await getTokopayCreds(prisma)) != null;
  const paydisiniEnabled = (await getPaydisiniCreds(prisma)) != null;
  const nowpaymentsEnabled = (await getNowpaymentsCreds(prisma)) != null;
  await smartEdit(
    ctx,
    t(ctx, "checkout.confirm_order", {
      product: esc(r.productName),
      qty: quantity,
      unit_price: priceIdr(r.unitPrice, rate),
      voucher_line: r.voucherLine,
      wallet_line: r.walletLine,
      total: priceIdr(r.subtotal, rate),
    }),
    ckb.orderConfirmKb(
      productId,
      quantity,
      lang,
      r.voucherCode,
      binanceEnabled && rate !== null,
      bybitEnabled && rate !== null,
      tokopayEnabled,
      paydisiniEnabled,
      nowpaymentsEnabled && rate !== null,
      bybitBscEnabled && rate !== null,
      r.idrBalance,
      r.usdtBalance,
      r.walletDeduction,
      r.fullyCovered,
    ),
  );
}
```

- [ ] **Step 5: Update `renderOrderConfirmation`**

Apply the same two changes (fetch `rate` before `computeConfirmation`, pass it in; update the `ckb.orderConfirmKb(...)` call args) to `renderOrderConfirmation` (currently lines 301-347+). Its body becomes:

```ts
/** Re-render confirmation as a fresh message (used after voucher entry). */
export async function renderOrderConfirmation(
  ctx: MyContext,
  productId: number,
  quantity: number,
): Promise<void> {
  const lang = ctx.session.lang;
  const rate = await currentUsdtRate();
  const r = await computeConfirmation(ctx, productId, quantity, rate);
  if (!r) return;
  const binanceEnabled = (await resolveBinanceInternalConfig(prisma)).enabled;
  const bybitEnabled = (await resolveBybitConfig(prisma)).enabled;
  const bybitBscEnabled = (await resolveBybitBscConfig(prisma)).enabled;
  const tokopayEnabled = (await getTokopayCreds(prisma)) != null;
  const paydisiniEnabled = (await getPaydisiniCreds(prisma)) != null;
  const nowpaymentsEnabled = (await getNowpaymentsCreds(prisma)) != null;
  const msg = await ctx.api.sendMessage(
    ctx.chat!.id,
    t(ctx, "checkout.confirm_order", {
      product: esc(r.productName),
      qty: quantity,
      unit_price: priceIdr(r.unitPrice, rate),
      voucher_line: r.voucherLine,
      wallet_line: r.walletLine,
      total: priceIdr(r.subtotal, rate),
    }),
    {
      parse_mode: "HTML",
      reply_markup: ckb.orderConfirmKb(
        productId,
        quantity,
        lang,
        r.voucherCode,
        binanceEnabled && rate !== null,
        bybitEnabled && rate !== null,
        tokopayEnabled,
        paydisiniEnabled,
        nowpaymentsEnabled && rate !== null,
        bybitBscEnabled && rate !== null,
        r.idrBalance,
        r.usdtBalance,
        r.walletDeduction,
        r.fullyCovered,
      ),
    },
  );
  ctx.session.menuMsgId = msg.message_id;
}
```

- [ ] **Step 6: Thread `rate` into `showUsdtMethods`'s `computeConfirmation` call**

In `showUsdtMethods` (currently lines 355-392), it already fetches `rate` at what is currently line 367 (`const rate = await currentUsdtRate();`) — move that line up so it runs before the `computeConfirmation` call, and pass it in. Its body becomes:

```ts
export async function showUsdtMethods(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const lang = ctx.session.lang;

  const product = await getDenomination(prisma, productId);
  if (product === null) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.try_again"), show_alert: true });
    await smartEdit(ctx, t(ctx, "error.try_again"), ckb.backToMain(lang));
    return;
  }
  const rate = await currentUsdtRate();
  const r = await computeConfirmation(ctx, productId, quantity, rate);
  if (!r) return;

  const binanceEnabled = (await resolveBinanceInternalConfig(prisma)).enabled;
  const bybitEnabled = (await resolveBybitConfig(prisma)).enabled;
  const bybitBscEnabled = (await resolveBybitBscConfig(prisma)).enabled;
  const nowpaymentsEnabled = (await getNowpaymentsCreds(prisma)) != null;
  await smartEdit(
    ctx,
    t(ctx, "checkout.confirm_order", {
      product: esc(r.productName),
      qty: quantity,
      unit_price: priceIdr(r.unitPrice, rate),
      voucher_line: r.voucherLine,
      wallet_line: r.walletLine,
      total: priceIdr(r.subtotal, rate),
    }),
    ckb.usdtMethodsKb(
      productId,
      quantity,
      lang,
      binanceEnabled && rate !== null,
      bybitEnabled && rate !== null,
      nowpaymentsEnabled && rate !== null,
      bybitBscEnabled && rate !== null,
    ),
  );
}
```

- [ ] **Step 7: Add `showWalletCreditMenu`**

Add this new function right after `showUsdtMethods` in `apps/order-bot/src/handlers/checkout.ts`:

```ts
/**
 * Wallet-credit submenu — keeps the order-summary bubble but swaps the
 * keyboard for walletCreditKb (IDR / USDT credit options). Reached from the
 * "Use Wallet Credit" entry on the confirmation screen; Back returns to
 * showOrderConfirmation.
 */
export async function showWalletCreditMenu(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const lang = ctx.session.lang;

  const product = await getDenomination(prisma, productId);
  if (product === null) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.try_again"), show_alert: true });
    await smartEdit(ctx, t(ctx, "error.try_again"), ckb.backToMain(lang));
    return;
  }
  const rate = await currentUsdtRate();
  const r = await computeConfirmation(ctx, productId, quantity, rate);
  if (!r) return;

  await smartEdit(
    ctx,
    t(ctx, "checkout.confirm_order", {
      product: esc(r.productName),
      qty: quantity,
      unit_price: priceIdr(r.unitPrice, rate),
      voucher_line: r.voucherLine,
      wallet_line: r.walletLine,
      total: priceIdr(r.subtotal, rate),
    }),
    ckb.walletCreditKb(productId, quantity, lang, r.idrBalance, r.useWalletIdr, r.usdtBalance, r.useWalletUsdt),
  );
}
```

- [ ] **Step 8: Add `completeOrderWithWallet`**

Add this new function near the other `buyNow*` functions in `apps/order-bot/src/handlers/checkout.ts` (e.g. right after `buyNowPaydisini`):

```ts
/**
 * "Complete Order" — the order's active wallet credit (IDR or USDT) already
 * brings the total to zero. No gateway involved: creates the order, applies
 * the credit, and delivers it in the same request via
 * completeOrderWithWalletCredit (packages/db/src/crud/wallet_checkout.ts).
 */
export async function completeOrderWithWallet(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  const user = await getUser(prisma, info.id);
  if (user === null) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  const pendingCount = await countUserPendingOrders(prisma, info.id);
  if (pendingCount >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }
  if (await refuseDuplicateCheckout(ctx, user.id, productId, PaymentMethod.WALLET)) return;

  const useWalletIdr = Boolean(ctx.session.scratch.useWalletIdr);
  const useWalletUsdt = Boolean(ctx.session.scratch.useWalletUsdt);
  if (!useWalletIdr && !useWalletUsdt) {
    // Stale tap on an old bubble whose credit toggle no longer applies —
    // re-render a fresh, correct confirmation instead of stranding the user.
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
    await showOrderConfirmation(ctx, productId, quantity);
    return;
  }
  const rate = useWalletUsdt ? await currentUsdtRate() : null;
  const voucherCode = (ctx.session.scratch.appliedVoucherCode as string | undefined) ?? null;

  let result: Awaited<ReturnType<typeof completeOrderWithWalletCredit>>;
  try {
    result = await prisma.$transaction((tx) =>
      completeOrderWithWalletCredit(tx, {
        user: {
          id: user.id,
          role: user.role,
          walletBalance: user.walletBalance,
          walletBalanceUsdt: user.walletBalanceUsdt,
        },
        productId,
        quantity,
        voucherCode,
        currency: useWalletIdr ? OrderCurrency.IDR : OrderCurrency.USDT,
        rate: rate ?? undefined,
      }),
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }

  // Consume the voucher and wallet toggle now that an order actually exists —
  // same convention as every other buyNow* rail.
  delete ctx.session.scratch.appliedVoucherCode;
  delete ctx.session.scratch.useWalletIdr;
  delete ctx.session.scratch.useWalletUsdt;

  await smartEdit(
    ctx,
    t(ctx, "checkout.wallet_paid", { code: result.order.orderCode }),
    ckb.paymentSuccessKb(lang),
  );
  // No waiting/polling screen (the order is already DELIVERED) — just nudge
  // the outbox so the credential DM goes out immediately, same call
  // reconcileOrder makes after a TokoPay auto-deliver.
  nudgeOutboxDispatcher();
}
```

This needs two new imports at the top of `apps/order-bot/src/handlers/checkout.ts`. Add `completeOrderWithWalletCredit` to the existing `@app/db` import block (the one starting `import { prisma, getOrder, ... } from "@app/db";`):

```ts
  completeOrderWithWalletCredit,
```

And add a new import line for the outbox nudge:

```ts
import { nudgeOutboxDispatcher } from "@app/core/nudge";
```

- [ ] **Step 9: Rewrite `dispatchWallet` and add the two new dispatchers in `apps/order-bot/src/handlers/callbacks.ts`**

Replace `dispatchWallet` (currently lines 141-150):

```ts
const dispatchWallet: DomainDispatcher = async (ctx, parts) => {
  if (parts[2] === "view") await customer.viewWallet(ctx);
};

const dispatchWalletMenu: DomainDispatcher = async (ctx, parts) => {
  // v1:walletm:open|idr|usdt|back:<pid>:<qty>
  const action = parts[2];
  const productId = parseInt(parts[3]!, 10);
  const qty = parseInt(parts[4]!, 10);
  if (action === "open") {
    await checkout.showWalletCreditMenu(ctx, productId, qty);
  } else if (action === "idr") {
    ctx.session.scratch.useWalletIdr = !ctx.session.scratch.useWalletIdr;
    // Mutually exclusive with USDT credit — a single order can only spend one
    // currency's wallet balance (packages/db/src/crud/orders.ts's refund
    // logic keys off the order's single `currency` column).
    if (ctx.session.scratch.useWalletIdr) ctx.session.scratch.useWalletUsdt = false;
    await checkout.showWalletCreditMenu(ctx, productId, qty);
  } else if (action === "usdt") {
    ctx.session.scratch.useWalletUsdt = !ctx.session.scratch.useWalletUsdt;
    if (ctx.session.scratch.useWalletUsdt) ctx.session.scratch.useWalletIdr = false;
    await checkout.showWalletCreditMenu(ctx, productId, qty);
  } else if (action === "back") {
    await checkout.showOrderConfirmation(ctx, productId, qty);
  }
};

const dispatchWalletPay: DomainDispatcher = async (ctx, parts) => {
  // v1:walletpay:<pid>:<qty> — the order's active wallet credit already
  // covers the total; complete it with no gateway.
  await checkout.completeOrderWithWallet(ctx, parseInt(parts[2]!, 10), parseInt(parts[3]!, 10));
};
```

Then add the two new domains to `DOMAIN_ROUTES` (currently lines 181-204), right after the existing `wallet: dispatchWallet,` line:

```ts
  walletm: dispatchWalletMenu,
  walletpay: dispatchWalletPay,
```

- [ ] **Step 10: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. If it fails on a leftover reference to the removed `checkout.use_wallet_idr_btn`/`wallet_idr_active_btn`/`use_wallet_usdt_btn`/`wallet_usdt_active_btn` locale keys, or on an `orderConfirmKb(...)` call still passing the old trailing args (`idrBalance, useWalletIdr, usdtBalance, useWalletUsdt` instead of the new `idrBalance, usdtBalance, walletDeduction, fullyCovered`), that means Steps 1-9 didn't fully replace every call site — search for `orderConfirmKb(` across `apps/order-bot/src` and check each call's last four arguments against Step 1's new signature.

- [ ] **Step 11: Run the full test suite**

Run: `pnpm test`
Expected: PASS — no regressions anywhere in the monorepo.

- [ ] **Step 12: Commit**

```bash
git add apps/order-bot/src/keyboards/customer.ts apps/order-bot/src/handlers/checkout.ts apps/order-bot/src/handlers/callbacks.ts
git commit -m "feat(bot): wallet-credit submenu + Complete Order for wallet-covered checkouts"
```

---

## Manual Verification (after Task 4)

This plan's automated gates are `pnpm typecheck` and `pnpm test`; the bot's interactive flow itself needs a live run since there is no bot-level test harness in this codebase. Using a shop with an admin-adjustable wallet (`/wallet` admin command or the web-admin customer detail page):

1. Give a test buyer IDR credit that exactly covers a cheap product's price. Open checkout → tap "Use Wallet Credit" → tap "IDR Credit" in the submenu → Back. Confirm the entry button now reads "✅ Wallet Credit Applied (IDR −Rp...)", the gateway buttons (QRIS/PayDisini/USDT) are gone, and a "✅ Complete Order" button is shown instead. Tap it — confirm the bubble flips to a "Payment received!" screen and the credential DM arrives.
2. Repeat with USDT credit instead (give the buyer USDT credit covering the USDT-equivalent price; requires `usd_idr_rate` configured). Confirm the same Complete Order flow works and only the USDT wallet balance is debited (check via the admin wallet ledger).
3. Give the buyer IDR credit that only *partially* covers a product. Confirm the normal QRIS/PayDisini/USDT gateway buttons still appear (no regression to the existing partial-credit flow) and the Total line reflects the partial deduction.
4. In the wallet-credit submenu, toggle IDR on, then toggle USDT on — confirm IDR turns back off automatically (mutual exclusivity), and vice versa.
5. Confirm the USDT credit button/label no longer shows "USDT" twice anywhere (entry button, submenu row, and the `Total` line's USDT-credit line).
