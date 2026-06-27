// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  createBybitBscOrder,
  createBybitOrder,
  deliverPaidBybitBscOrder,
  deliverPaidBybitOrder,
  recordUnmatchedBybitBscTx,
  listInFlightBybitBscOrders,
  resolveBybitBscConfig,
  setSetting,
  getSetting,
  deleteSetting,
  setOrderPaymentMessage,
  BYBIT_BSC_DEPOSIT_ADDRESS_KEY,
  BYBIT_API_KEY_KEY,
  BYBIT_API_SECRET_KEY,
  BYBIT_BSC_POLL_HEALTH_KEY,
} from "@app/db";
import type { Api } from "grammy";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { OrderStatus, PaymentMethod, StockStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { normalizeOnchainDeposit, processDeposits, pollOnce, type BybitBscDeposit } from "../src/payments/bybitBscDeposit";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedBybitTx.deleteMany(); // shared with Internal Transfer, not covered by resetDb
  sample = await buildSampleData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const DEPOSIT_ADDRESS = "0xMERCHANTADDR";

// rate 1 keeps the USDT totals numerically equal to the fixture's central-IDR
// price ("5.00"), so the amount-matching assertions below stay exact.
const makeBybitBscOrder = (qty = 1) =>
  prisma.$transaction((tx) =>
    createBybitBscOrder(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: qty, rate: 1 }),
  );
const makeBybitOrder = (qty = 1) =>
  prisma.$transaction((tx) =>
    createBybitOrder(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: qty, rate: 1 }),
  );

// ===========================================================================
// normalizeOnchainDeposit — Bybit /v5/asset/deposit/query-record row shape
// ===========================================================================

describe("normalizeOnchainDeposit (Bybit on-chain deposit payload shape)", () => {
  // Realistic on-chain deposit row (BEP20 transfer) per Bybit V5 docs.
  const real = {
    id: "1700000000000-0xabc123",
    txID: "0x" + "a".repeat(64),
    coin: "USDT",
    amount: "746.99",
    status: 3, // on-chain ledger: 3=success (DIFFERS from internal-deposit mapping)
    chain: "BSC",
    address: DEPOSIT_ADDRESS,
    createdTime: "1700000000000",
  };
  const cfg = { chain: "BSC", depositAddress: DEPOSIT_ADDRESS };

  it("maps a successful on-chain USDT deposit", () => {
    const d = normalizeOnchainDeposit(real, cfg)!;
    expect(d.txId).toBe(real.txID);
    expect(d.amount).toBeCloseTo(746.99);
  });

  // INTENTIONAL behavior change: status 1/2 used to be discarded entirely
  // (the only consumer was delivery, which only ever wants status 3). Now
  // they're kept too, so a still-confirming deposit can be tracked
  // (PAYMENT_DETECTED) before Bybit itself reports it Success — delivery
  // still only ever happens on status 3, unchanged.
  it("accepts status 1/2 (still confirming) and 3 (Success); rejects unknown/failure codes", () => {
    expect(normalizeOnchainDeposit({ ...real, status: 1 }, cfg)).not.toBeNull(); // toBeConfirmed
    expect(normalizeOnchainDeposit({ ...real, status: 2 }, cfg)).not.toBeNull(); // processing
    expect(normalizeOnchainDeposit({ ...real, status: 3 }, cfg)).not.toBeNull(); // success
    expect(normalizeOnchainDeposit({ ...real, status: 0 }, cfg)).toBeNull(); // unknown
    expect(normalizeOnchainDeposit({ ...real, status: 4 }, cfg)).toBeNull(); // failed (not handled here)
  });

  it("attaches the raw Bybit status to the normalized row", () => {
    expect(normalizeOnchainDeposit({ ...real, status: 1 }, cfg)!.bybitStatus).toBe(1);
    expect(normalizeOnchainDeposit({ ...real, status: 3 }, cfg)!.bybitStatus).toBe(3);
  });

  it("rejects a non-USDT coin", () => {
    expect(normalizeOnchainDeposit({ ...real, coin: "USDC" }, cfg)).toBeNull();
  });

  it("filters by chain — a deposit on a different chain never matches a BSC-only order", () => {
    expect(normalizeOnchainDeposit({ ...real, chain: "BSC" }, cfg)).not.toBeNull();
    expect(normalizeOnchainDeposit({ ...real, chain: "TRX" }, cfg)).toBeNull();
    expect(normalizeOnchainDeposit({ ...real, chain: "ETH" }, cfg)).toBeNull();
  });

  it("filters by destination address when present (belt-and-suspenders, not the primary key)", () => {
    expect(normalizeOnchainDeposit({ ...real, address: DEPOSIT_ADDRESS }, cfg)).not.toBeNull();
    expect(normalizeOnchainDeposit({ ...real, address: "0xSOMEONEELSE" }, cfg)).toBeNull();
    // Address case-insensitive.
    expect(normalizeOnchainDeposit({ ...real, address: DEPOSIT_ADDRESS.toLowerCase() }, cfg)).not.toBeNull();
  });

  it("rejects non-received / malformed rows", () => {
    expect(normalizeOnchainDeposit({ ...real, amount: "0" }, cfg)).toBeNull();
    expect(normalizeOnchainDeposit({ ...real, amount: "-5" }, cfg)).toBeNull();
    expect(normalizeOnchainDeposit({ coin: "USDT", status: 3, chain: "BSC" }, cfg)).toBeNull(); // no txID/amount
  });
});

// ===========================================================================
// Order creation
// ===========================================================================

describe("createBybitBscOrder", () => {
  it("creates a BYBIT_BSC order with an expiry and NO paymentRef (BEP20 has no memo)", async () => {
    const order = await makeBybitBscOrder();
    expect(order).toBeTruthy();
    expect(order!.paymentMethod).toBe(PaymentMethod.BYBIT_BSC);
    expect(order!.paymentRef).toBeNull();
    expect(order!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order!.expiresAt).not.toBeNull();
    expect(order!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  // Same collision-avoidance contract as Internal Transfer (Checkout-4), now
  // generalized to scope by `paymentMethod: method` instead of a hardcoded
  // BYBIT literal — this proves the BSC pool is checked, not skipped.
  it("totalAmount stays unique across many simultaneous orders for the same product (no two share a bucket)", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      await prisma.stockItem.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          productId: sample.product.id,
          credentials: `bybit-bsc-uniq-${i}@x.com:pw`,
          status: StockStatus.AVAILABLE,
        })),
      });
      const orders = [];
      for (let i = 0; i < 20; i++) orders.push(await makeBybitBscOrder());
      const totals = orders.map((o) => new Decimal(o!.totalAmount).toString());
      expect(new Set(totals).size).toBe(totals.length); // all 20 distinct
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });

  // The two Bybit rails are independent pools — a BYBIT order and a
  // BYBIT_BSC order sharing the same base amount must NOT trigger each
  // other's collision-avoidance retry (each poller only ever reads its own
  // method's pending orders).
  it("does not collide with a same-amount Internal Transfer (BYBIT) order — independent pools", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      await prisma.stockItem.createMany({
        data: [
          { productId: sample.product.id, credentials: "bybit-pool-a@x.com:pw", status: StockStatus.AVAILABLE },
          { productId: sample.product.id, credentials: "bybit-pool-b@x.com:pw", status: StockStatus.AVAILABLE },
        ],
      });
      const internal = (await makeBybitOrder())!;
      const bsc = (await makeBybitBscOrder())!;
      // Both seeded from the same product/rate, so their base USDT amount is
      // identical; the unique-cents bucket is also seeded from order.id, which
      // can coincidentally match too — either way, cross-method collision
      // avoidance must never fire (it's scoped to paymentMethod: method).
      expect(internal.paymentMethod).toBe(PaymentMethod.BYBIT);
      expect(bsc.paymentMethod).toBe(PaymentMethod.BYBIT_BSC);
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });
});

// ===========================================================================
// Idempotent delivery / unmatched — shares ProcessedBybitTx with Internal
// Transfer; the format-based non-collision claim is the critical thing to
// prove here.
// ===========================================================================

describe("deliverPaidBybitBscOrder (idempotency + delivery)", () => {
  it("delivers once and is idempotent on the same tx id", async () => {
    const order = await makeBybitBscOrder();
    const amount = order!.totalAmount;
    const txId = "0x" + "b".repeat(64);

    const first = await deliverPaidBybitBscOrder(prisma, { orderId: order!.id, bybitTxId: txId, amount });
    expect(first.status).toBe("delivered");
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.bybitTxid).toBe(txId);
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: txId } })).toBe(1);

    // Same tx again → already processed, no second delivery.
    const second = await deliverPaidBybitBscOrder(prisma, { orderId: order!.id, bybitTxId: txId, amount });
    expect(second.status).toBe("already_processed");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
  });

  it("returns 'stale' when a different tx targets an already-delivered order", async () => {
    const order = await makeBybitBscOrder();
    await deliverPaidBybitBscOrder(prisma, { orderId: order!.id, bybitTxId: "0x" + "1".repeat(64), amount: order!.totalAmount });
    const res = await deliverPaidBybitBscOrder(prisma, { orderId: order!.id, bybitTxId: "0x" + "2".repeat(64), amount: order!.totalAmount });
    expect(res.status).toBe("stale");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1); // not re-delivered
  });

  it("a delivery throw (out of stock) flags the ledger row, transitions the order to FAILED, and enqueues an admin alert via the outbox", async () => {
    const order = (await makeBybitBscOrder())!;
    // Force approveOrder's out-of-stock path: invalidate the order's own
    // reserved stock item and leave no replacement available for the product.
    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.DEAD } });
    const txId = "0x" + "8".repeat(64);

    await expect(
      deliverPaidBybitBscOrder(prisma, { orderId: order.id, bybitTxId: txId, amount: order.totalAmount }),
    ).rejects.toMatchObject({ key: "error.cannot_deliver_out_of_stock" });

    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: txId } }))!.outcome).toBe("delivery_failed");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.FAILED);
    const failedRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: "ORDER_PIPELINE_FAILED" },
    });
    expect(failedRows.length).toBeGreaterThan(0);
  });

  // The single most important test proving the shared-ledger reuse decision
  // is safe: an Internal Transfer (BYBIT) order and an on-chain (BYBIT_BSC)
  // order, each delivered with a realistic-format tx id for their own rail,
  // succeed independently — no cross-contamination in processed_bybit_tx.
  it("a BYBIT order and a BYBIT_BSC order with the same totalAmount deliver independently on the shared ledger", async () => {
    await prisma.stockItem.createMany({
      data: [
        { productId: sample.product.id, credentials: "shared-ledger-a@x.com:pw", status: StockStatus.AVAILABLE },
        { productId: sample.product.id, credentials: "shared-ledger-b@x.com:pw", status: StockStatus.AVAILABLE },
      ],
    });
    const internalOrder = (await makeBybitOrder())!;
    const bscOrder = (await makeBybitBscOrder())!;

    const internalTxId = "9000000000000000123"; // Internal Transfer: short numeric ledger id
    const onchainTxId = "0x" + "c".repeat(64); // on-chain BEP20: 0x-prefixed 64-hex hash

    const internalResult = await deliverPaidBybitOrder(prisma, { orderId: internalOrder.id, bybitTxId: internalTxId, amount: internalOrder.totalAmount });
    const bscResult = await deliverPaidBybitBscOrder(prisma, { orderId: bscOrder.id, bybitTxId: onchainTxId, amount: bscOrder.totalAmount });

    expect(internalResult.status).toBe("delivered");
    expect(bscResult.status).toBe("delivered");
    expect((await prisma.order.findUnique({ where: { id: internalOrder.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect((await prisma.order.findUnique({ where: { id: bscOrder.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: internalTxId, orderId: internalOrder.id } })).toBe(1);
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: onchainTxId, orderId: bscOrder.id } })).toBe(1);
    // Both rows exist on the same shared table, distinguishable only by their
    // txId format — no discriminator column needed.
    expect(await prisma.processedBybitTx.count()).toBe(2);
  });
});

// ===========================================================================
// processDeposits — the poll-loop wiring (amount-only match + unmatched)
// ===========================================================================

describe("processDeposits (poll-loop wiring)", () => {
  function fakeApi() {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const edits: Array<{ chatId: number | string; messageId: number; text: string; extra?: unknown }> = [];
    const api = {
      sendMessage: async (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return { message_id: 1 };
      },
      sendDocument: async () => ({ message_id: 1 }),
      editMessageText: async (chatId: number | string, messageId: number, text: string, extra?: unknown) => {
        edits.push({ chatId, messageId, text, extra });
        return {};
      },
    } as unknown as Api;
    return { api, sent, edits };
  }

  const inFlight = () => listInFlightBybitBscOrders(prisma, new Date());
  // Default bybitStatus to Success (3) so every existing test below — written
  // before still-confirming tracking existed — keeps its original immediate-
  // delivery behavior unless a test explicitly overrides it.
  const dep = (over: Partial<BybitBscDeposit> & { txId: string; amount: number }): BybitBscDeposit => ({
    bybitStatus: 3,
    ...over,
  });

  it("flips the anchored payment bubble to the success message with paymentSuccessKb", async () => {
    const order = (await makeBybitBscOrder())!;
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApi();
    await processDeposits(api, [dep({ txId: "0x" + "f".repeat(64), amount: Number(order.totalAmount) })], await inFlight(), "BSC");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.chatId).toBe(555);
    expect(edits[0]!.messageId).toBe(777);
    const markup = (edits[0]!.extra as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } })
      .reply_markup;
    const flat = (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    expect(flat).toContain("v1:browse:prods");
    expect(flat).toContain("v1:order:list");
  });

  it("delivers on a unique-amount match", async () => {
    const order = (await makeBybitBscOrder())!;
    const { api } = fakeApi();
    const txId = "0x" + "d".repeat(64);
    await processDeposits(api, [dep({ txId, amount: Number(order.totalAmount) })], await inFlight(), "BSC");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: txId } }))!.outcome).toBe("matched");
  });

  it("refuses on a collision (two equal-total orders) → unmatched", async () => {
    const a = (await makeBybitBscOrder())!;
    const b = (await makeBybitBscOrder())!; // unique-cents off in tests → equal totals
    expect(a.totalAmount).toEqual(b.totalAmount);
    const { api } = fakeApi();
    const txId = "0x" + "e".repeat(64);
    await processDeposits(api, [dep({ txId, amount: Number(a.totalAmount) })], await inFlight(), "BSC");
    expect((await prisma.order.findUnique({ where: { id: a.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.order.findUnique({ where: { id: b.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: txId } }))!.outcome).toBe("unmatched");
  });

  it("records a no-candidate deposit as unmatched", async () => {
    await makeBybitBscOrder();
    const { api } = fakeApi();
    const txId = "0x" + "9".repeat(64);
    await processDeposits(api, [dep({ txId, amount: 999.99 })], await inFlight(), "BSC");
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: txId } }))!.outcome).toBe("unmatched");
  });

  // ── Gap #1 + #2 regression tests ──────────────────────────────────────────
  // These came from re-reading how the existing code actually behaves, not
  // from the original feature request — without them, a still-confirming
  // deposit would silently lose its order (gap #1) or its eventual real
  // delivery would be rejected as stale (gap #2).

  it("a still-confirming deposit (status 1/2) is recorded as PAYMENT_DETECTED, not delivered, and not claimed in the ledger yet", async () => {
    const order = (await makeBybitBscOrder())!;
    const { api } = fakeApi();
    const txId = "0x" + "1".repeat(64);
    await processDeposits(api, [dep({ txId, amount: Number(order.totalAmount), bybitStatus: 1 })], await inFlight(), "BSC");

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe(OrderStatus.PAYMENT_DETECTED);
    expect(updated.bybitTxid).toBe(txId);
    expect(updated.network).toBe("BSC");
    expect(updated.firstDetectedAt).not.toBeNull();
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: txId } })).toBe(0);
  });

  it("re-seeing the same still-confirming deposit on a later cycle matches by txid, not amount — no spurious 'unmatched' row (gap #1)", async () => {
    const order = (await makeBybitBscOrder())!;
    const { api } = fakeApi();
    const txId = "0x" + "2".repeat(64);

    // Cycle 1: first sighting, still toBeConfirmed.
    await processDeposits(api, [dep({ txId, amount: Number(order.totalAmount), bybitStatus: 1 })], await inFlight(), "BSC");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PAYMENT_DETECTED);

    // Cycle 2: still not final (now "processing"). The order is no longer
    // PENDING_PAYMENT, so listInFlightBybitBscOrders is what makes it visible
    // at all here — must match by its own txid, not fall through to
    // "no candidate -> unmatched" for money that's already accounted for.
    await processDeposits(api, [dep({ txId, amount: Number(order.totalAmount), bybitStatus: 2 })], await inFlight(), "BSC");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.PAYMENT_DETECTED);
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: txId } })).toBe(0); // still not claimed

    // Cycle 3: Bybit finally reports Success — delivers exactly as the
    // existing status-3 path always has.
    await processDeposits(api, [dep({ txId, amount: Number(order.totalAmount), bybitStatus: 3 })], await inFlight(), "BSC");
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: txId } })).toBe(1);
  });

  it("pushes the live tracking screen to the anchored bubble exactly once — on the cycle that actually detects, not on later still-confirming cycles", async () => {
    const order = (await makeBybitBscOrder())!;
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApi();
    const txId = "0x" + "7".repeat(64);

    // Cycle 1: first sighting — pushes the tracking screen once.
    await processDeposits(api, [dep({ txId, amount: Number(order.totalAmount), bybitStatus: 1 })], await inFlight(), "BSC");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.chatId).toBe(555);
    expect(edits[0]!.messageId).toBe(777);
    expect(edits[0]!.text).toContain("Waiting for the first on-chain confirmation");

    // Cycle 2: same deposit, still not final — must NOT push again (already
    // detected; re-pushing here would stomp on whatever the confirmation
    // tracker has since rendered, e.g. an actual confirmation count).
    await processDeposits(api, [dep({ txId, amount: Number(order.totalAmount), bybitStatus: 2 })], await inFlight(), "BSC");
    expect(edits).toHaveLength(1);
  });

  it("delivers from PAYMENT_DETECTED/CONFIRMING/CONFIRMED, not just PENDING_PAYMENT (gap #2)", async () => {
    const statuses = [OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED];
    for (let i = 0; i < statuses.length; i++) {
      const order = (await makeBybitBscOrder())!;
      await prisma.order.update({ where: { id: order.id }, data: { status: statuses[i] } });
      const txId = "0x" + String(i).repeat(64);
      const result = await deliverPaidBybitBscOrder(prisma, { orderId: order.id, bybitTxId: txId, amount: order.totalAmount });
      expect(result.status).toBe("delivered");
      expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);
    }
  });
});

// ===========================================================================
// resolveBybitBscConfig — web-admin Settings win over .env (the gate for
// poller + checkout). In tests no BYBIT_* env is set, so Settings is the
// only source.
// ===========================================================================

describe("resolveBybitBscConfig (Settings-backed config)", () => {
  const clear = () => Promise.all([
    deleteSetting(prisma, BYBIT_BSC_DEPOSIT_ADDRESS_KEY),
    deleteSetting(prisma, BYBIT_API_KEY_KEY),
    deleteSetting(prisma, BYBIT_API_SECRET_KEY),
  ]);

  it("is disabled when no settings (and no env) are present", async () => {
    await clear();
    const cfg = await resolveBybitBscConfig(prisma);
    expect(cfg.enabled).toBe(false);
  });

  it("is disabled until ALL THREE of address + key + secret are set", async () => {
    await clear();
    await setSetting(prisma, BYBIT_BSC_DEPOSIT_ADDRESS_KEY, DEPOSIT_ADDRESS);
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    expect((await resolveBybitBscConfig(prisma)).enabled).toBe(false); // secret still missing
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
    const cfg = await resolveBybitBscConfig(prisma);
    expect(cfg.enabled).toBe(true);
    expect(cfg.depositAddress).toBe(DEPOSIT_ADDRESS);
    expect(cfg.apiKey).toBe("k");
    expect(cfg.apiSecret).toBe("s");
    expect(cfg.chain).toBe("BSC");
  });

  it("treats a blank/whitespace setting as unset", async () => {
    await clear();
    await setSetting(prisma, BYBIT_BSC_DEPOSIT_ADDRESS_KEY, "  ");
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
    expect((await resolveBybitBscConfig(prisma)).enabled).toBe(false);
    await clear();
  });

  it("defaults minAmount to null when unset, and parses a configured value", async () => {
    await clear();
    await setSetting(prisma, BYBIT_BSC_DEPOSIT_ADDRESS_KEY, DEPOSIT_ADDRESS);
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
    expect((await resolveBybitBscConfig(prisma)).minAmount).toBeNull();
    await setSetting(prisma, "bybit_bsc_min_amount", "10");
    expect((await resolveBybitBscConfig(prisma)).minAmount).toEqual(new Decimal("10"));
    await deleteSetting(prisma, "bybit_bsc_min_amount");
    await clear();
  });
});

// ===========================================================================
// pollOnce — refuses to run at all when enabled but USE_UNIQUE_CENTS is off
// (same hard gate as Internal Transfer). BEP20 has no memo, so without
// unique cents two orders can share a total — a confused-deputy risk, not
// just an availability one.
// ===========================================================================

describe("pollOnce — USE_UNIQUE_CENTS hard gate", () => {
  beforeEach(async () => {
    await setSetting(prisma, BYBIT_BSC_DEPOSIT_ADDRESS_KEY, DEPOSIT_ADDRESS);
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
  });
  afterAll(async () => {
    await deleteSetting(prisma, BYBIT_BSC_DEPOSIT_ADDRESS_KEY);
    await deleteSetting(prisma, BYBIT_API_KEY_KEY);
    await deleteSetting(prisma, BYBIT_API_SECRET_KEY);
  });

  it("refuses to poll (no network call, no health setting written) when USE_UNIQUE_CENTS is off", async () => {
    expect(config.USE_UNIQUE_CENTS).toBe(false); // test-env default (setup-db.ts)
    await deleteSetting(prisma, BYBIT_BSC_POLL_HEALTH_KEY);
    const fakeApi = {} as Api; // never called — pollOnce must return before touching it
    await pollOnce(fakeApi);
    expect(await getSetting(prisma, BYBIT_BSC_POLL_HEALTH_KEY)).toBeNull(); // never reached fetchRecentDeposits
  });
});

describe("recordUnmatchedBybitBscTx", () => {
  it("records once and dedupes", async () => {
    const txId = "0x" + "0".repeat(64);
    expect(await recordUnmatchedBybitBscTx(prisma, { bybitTxId: txId, amount: "9.99" })).toBe(true);
    expect(await recordUnmatchedBybitBscTx(prisma, { bybitTxId: txId, amount: "9.99" })).toBe(false);
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: txId, outcome: "unmatched" } })).toBe(1);
  });
});
