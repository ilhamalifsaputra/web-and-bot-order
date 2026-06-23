// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  createBybitOrder,
  deliverPaidBybitOrder,
  recordUnmatchedBybitTx,
  listPendingBybitOrders,
  resolveBybitConfig,
  setSetting,
  getSetting,
  deleteSetting,
  setOrderPaymentMessage,
  BYBIT_UID_KEY,
  BYBIT_API_KEY_KEY,
  BYBIT_API_SECRET_KEY,
  BYBIT_POLL_HEALTH_KEY,
} from "@app/db";
import type { Api } from "grammy";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { OrderStatus, PaymentMethod, StockStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { normalizeInternalDeposit, processDeposits, pollOnce, type BybitDeposit } from "../src/payments/bybitDeposit";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedBybitTx.deleteMany(); // new table, not covered by resetDb
  sample = await buildSampleData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

// rate 1 keeps the USDT totals numerically equal to the fixture's central-IDR
// price ("5.00"), so the amount-matching assertions below stay exact.
const makeBybitOrder = (qty = 1) =>
  prisma.$transaction((tx) =>
    createBybitOrder(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: qty, rate: 1 }),
  );

// ===========================================================================
// normalizeInternalDeposit — Bybit /v5/asset/deposit/query-internal-record row shape
// ===========================================================================

describe("normalizeInternalDeposit (Bybit internal-deposit payload shape)", () => {
  // Realistic internal-deposit row (off-chain UID→UID transfer) per Bybit V5 docs.
  const real = {
    id: "9000000000000000001",
    txID: "9000000000000000001",
    coin: "USDT",
    amount: "746.99",
    status: 2, // 1=Processing, 2=Success, 3=Failed (DIFFERS from on-chain mapping)
    address: "uid:1234567",
    createdTime: "1700000000000",
  };

  it("maps a successful internal-transfer USDT deposit", () => {
    const d = normalizeInternalDeposit(real)!;
    expect(d.txId).toBe(real.txID);
    expect(d.amount).toBeCloseTo(746.99);
  });

  it("accepts status 2 (Success) and rejects 1 (Processing) and 3 (Failed)", () => {
    expect(normalizeInternalDeposit({ ...real, status: 2 })).not.toBeNull();
    expect(normalizeInternalDeposit({ ...real, status: 1 })).toBeNull();
    expect(normalizeInternalDeposit({ ...real, status: 3 })).toBeNull();
  });

  it("rejects a non-USDT coin", () => {
    expect(normalizeInternalDeposit({ ...real, coin: "USDC" })).toBeNull();
  });

  it("has no chain filtering (internal transfers carry no chain)", () => {
    // A row with an arbitrary/absent chain field still maps successfully —
    // there is no chain parameter or chain filter for internal deposits.
    expect(normalizeInternalDeposit({ ...real, chain: "TRX" })).not.toBeNull();
    const { chain, ...withoutChain } = real as typeof real & { chain?: string };
    expect(normalizeInternalDeposit(withoutChain)).not.toBeNull();
  });

  it("rejects non-received / malformed rows", () => {
    expect(normalizeInternalDeposit({ ...real, amount: "0" })).toBeNull();
    expect(normalizeInternalDeposit({ ...real, amount: "-5" })).toBeNull();
    expect(normalizeInternalDeposit({ coin: "USDT", status: 2 })).toBeNull(); // no txID/amount
  });
});

// ===========================================================================
// Order creation
// ===========================================================================

describe("createBybitOrder", () => {
  it("creates a BYBIT order with an expiry and NO paymentRef (internal transfer has no memo)", async () => {
    const order = await makeBybitOrder();
    expect(order).toBeTruthy();
    expect(order!.paymentMethod).toBe(PaymentMethod.BYBIT);
    expect(order!.paymentRef).toBeNull();
    expect(order!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order!.expiresAt).not.toBeNull();
    expect(order!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  // Checkout-4 (security audit, 2026-06-23): computeUniqueCents only has 49
  // buckets — two orders for the SAME base amount whose ids happen to land in
  // the same bucket used to get an IDENTICAL totalAmount, and Bybit has no
  // memo to disambiguate beyond the amount. finalizeOrderPayment now retries
  // within the bucket space against the SAME pool the matcher reads
  // (PENDING_PAYMENT, BYBIT, not-yet-expired), so amounts must stay distinct
  // well past the point where raw `id % 49` would have collided.
  it("totalAmount stays unique across many simultaneous orders for the same product (no two share a bucket)", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      // Stock up enough credentials for 20 single-unit orders.
      await prisma.stockItem.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          productId: sample.product.id,
          credentials: `bybit-uniq-${i}@x.com:pw`,
          status: StockStatus.AVAILABLE,
        })),
      });
      const orders = [];
      for (let i = 0; i < 20; i++) orders.push(await makeBybitOrder());
      const totals = orders.map((o) => new Decimal(o!.totalAmount).toString());
      expect(new Set(totals).size).toBe(totals.length); // all 20 distinct
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });
});

// ===========================================================================
// Idempotent delivery / unmatched
// ===========================================================================

describe("deliverPaidBybitOrder (idempotency + delivery)", () => {
  it("delivers once and is idempotent on the same tx id", async () => {
    const order = await makeBybitOrder();
    const amount = order!.totalAmount;

    const first = await deliverPaidBybitOrder(prisma, { orderId: order!.id, bybitTxId: "0xAAA", amount });
    expect(first.status).toBe("delivered");
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect((await prisma.order.findUnique({ where: { id: order!.id } }))!.bybitTxid).toBe("0xAAA");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: "0xAAA" } })).toBe(1);

    // Same tx again → already processed, no second delivery.
    const second = await deliverPaidBybitOrder(prisma, { orderId: order!.id, bybitTxId: "0xAAA", amount });
    expect(second.status).toBe("already_processed");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
  });

  it("returns 'stale' when a different tx targets an already-delivered order", async () => {
    const order = await makeBybitOrder();
    await deliverPaidBybitOrder(prisma, { orderId: order!.id, bybitTxId: "0x1", amount: order!.totalAmount });
    const res = await deliverPaidBybitOrder(prisma, { orderId: order!.id, bybitTxId: "0x2", amount: order!.totalAmount });
    expect(res.status).toBe("stale");
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1); // not re-delivered
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

  const pending = () => listPendingBybitOrders(prisma, new Date());
  const dep = (over: Partial<BybitDeposit> & { txId: string; amount: number }): BybitDeposit => ({
    ...over,
  });

  it("flips the anchored payment bubble to the success message with paymentSuccessKb (§9.1)", async () => {
    const order = (await makeBybitOrder())!;
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const { api, edits } = fakeApi();
    await processDeposits(api, [dep({ txId: "0xFLIP", amount: Number(order.totalAmount) })], await pending());
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
    const order = (await makeBybitOrder())!;
    const { api } = fakeApi();
    await processDeposits(api, [dep({ txId: "0xT1", amount: Number(order.totalAmount) })], await pending());
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe(OrderStatus.DELIVERED);
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xT1" } }))!.outcome).toBe("matched");
  });

  it("refuses on a collision (two equal-total orders) → unmatched", async () => {
    const a = (await makeBybitOrder())!;
    const b = (await makeBybitOrder())!; // unique-cents off in tests → equal totals
    expect(a.totalAmount).toEqual(b.totalAmount);
    const { api } = fakeApi();
    await processDeposits(api, [dep({ txId: "0xT2", amount: Number(a.totalAmount) })], await pending());
    expect((await prisma.order.findUnique({ where: { id: a.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.order.findUnique({ where: { id: b.id } }))!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xT2" } }))!.outcome).toBe("unmatched");
  });

  it("records a no-candidate deposit as unmatched", async () => {
    await makeBybitOrder();
    const { api } = fakeApi();
    await processDeposits(api, [dep({ txId: "0xT3", amount: 999.99 })], await pending());
    expect((await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0xT3" } }))!.outcome).toBe("unmatched");
  });
});

// ===========================================================================
// resolveBybitConfig — web-admin Settings win over .env (the gate for poller +
// checkout). In tests no BYBIT_* env is set, so Settings is the only source.
// ===========================================================================

describe("resolveBybitConfig (Settings-backed config)", () => {
  const clear = () => Promise.all([
    deleteSetting(prisma, BYBIT_UID_KEY),
    deleteSetting(prisma, BYBIT_API_KEY_KEY),
    deleteSetting(prisma, BYBIT_API_SECRET_KEY),
  ]);

  it("is disabled when no settings (and no env) are present", async () => {
    await clear();
    const cfg = await resolveBybitConfig(prisma);
    expect(cfg.enabled).toBe(false);
  });

  it("is disabled until ALL THREE of uid + key + secret are set", async () => {
    await clear();
    await setSetting(prisma, BYBIT_UID_KEY, "123456");
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    expect((await resolveBybitConfig(prisma)).enabled).toBe(false); // secret still missing
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
    const cfg = await resolveBybitConfig(prisma);
    expect(cfg.enabled).toBe(true);
    expect(cfg.uid).toBe("123456");
    expect(cfg.apiKey).toBe("k");
    expect(cfg.apiSecret).toBe("s");
  });

  it("treats a blank/whitespace setting as unset", async () => {
    await clear();
    await setSetting(prisma, BYBIT_UID_KEY, "  ");
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
    expect((await resolveBybitConfig(prisma)).enabled).toBe(false);
    await clear();
  });
});

// ===========================================================================
// pollOnce — refuses to run at all when enabled but USE_UNIQUE_CENTS is off
// (Payment-2 fix). Internal Transfer has no memo, so without unique cents two
// orders can share a total — a confused-deputy risk, not just an availability
// one. Asserting the tick returns immediately (no poll-health row written)
// proves it never reached the network call.
// ===========================================================================

describe("pollOnce — USE_UNIQUE_CENTS hard gate", () => {
  beforeEach(async () => {
    await setSetting(prisma, BYBIT_UID_KEY, "123456");
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
  });
  afterAll(async () => {
    await deleteSetting(prisma, BYBIT_UID_KEY);
    await deleteSetting(prisma, BYBIT_API_KEY_KEY);
    await deleteSetting(prisma, BYBIT_API_SECRET_KEY);
  });

  it("refuses to poll (no network call, no health setting written) when USE_UNIQUE_CENTS is off", async () => {
    expect(config.USE_UNIQUE_CENTS).toBe(false); // test-env default (setup-db.ts)
    await deleteSetting(prisma, BYBIT_POLL_HEALTH_KEY);
    const fakeApi = {} as Api; // never called — pollOnce must return before touching it
    await pollOnce(fakeApi);
    expect(await getSetting(prisma, BYBIT_POLL_HEALTH_KEY)).toBeNull(); // never reached fetchRecentDeposits
  });
});

describe("recordUnmatchedBybitTx", () => {
  it("records once and dedupes", async () => {
    expect(await recordUnmatchedBybitTx(prisma, { bybitTxId: "0xUNM", amount: "9.99" })).toBe(true);
    expect(await recordUnmatchedBybitTx(prisma, { bybitTxId: "0xUNM", amount: "9.99" })).toBe(false);
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: "0xUNM", outcome: "unmatched" } })).toBe(1);
  });
});
