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
  deleteSetting,
  BYBIT_ADDRESS_KEY,
  BYBIT_API_KEY_KEY,
  BYBIT_API_SECRET_KEY,
} from "@app/db";
import type { Api } from "grammy";
import { OrderStatus, PaymentMethod, StockStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { normalizeDeposit, processDeposits, type BybitDeposit } from "../src/payments/bybitDeposit";

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
// normalizeDeposit — real Bybit /v5/asset/deposit/query-record row shape
// ===========================================================================

describe("normalizeDeposit (real Bybit deposit payload shape)", () => {
  // Captured (redacted) from scripts/bybit-probe.ts against the live account.
  const real = {
    coin: "USDT", chain: "BSC", amount: "746.99",
    txID: "0xf7de73e5a87ade81104ebc6912c073f2aba834f1b106cf742d9fe14e55363d31",
    status: 3, tag: "", toAddress: "0x27dfb0aab6940bcfda706817a9310e24dea5fea4", depositType: "0",
  };

  it("maps a successful BSC USDT deposit", () => {
    const d = normalizeDeposit(real)!;
    expect(d.txId).toBe(real.txID);
    expect(d.amount).toBeCloseTo(746.99);
    expect(d.chain).toBe("BSC");
  });

  it("skips deposits that are not yet credited (status != 3)", () => {
    expect(normalizeDeposit({ ...real, status: 2 })).toBeNull(); // processing
    expect(normalizeDeposit({ ...real, status: 1 })).toBeNull();
  });

  it("rejects the wrong chain or coin", () => {
    expect(normalizeDeposit({ ...real, chain: "TRX" })).toBeNull();
    expect(normalizeDeposit({ ...real, coin: "USDC" })).toBeNull();
  });

  it("rejects non-received / malformed rows", () => {
    expect(normalizeDeposit({ ...real, amount: "0" })).toBeNull();
    expect(normalizeDeposit({ ...real, amount: "-5" })).toBeNull();
    expect(normalizeDeposit({ coin: "USDT", chain: "BSC", status: 3 })).toBeNull(); // no txID/amount
  });
});

// ===========================================================================
// Order creation
// ===========================================================================

describe("createBybitOrder", () => {
  it("creates a BYBIT order with an expiry and NO paymentRef (BEP20 has no memo)", async () => {
    const order = await makeBybitOrder();
    expect(order).toBeTruthy();
    expect(order!.paymentMethod).toBe(PaymentMethod.BYBIT);
    expect(order!.paymentRef).toBeNull();
    expect(order!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order!.expiresAt).not.toBeNull();
    expect(order!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
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
    const api = {
      sendMessage: async (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return { message_id: 1 };
      },
      editMessageText: async () => ({}),
    } as unknown as Api;
    return { api, sent };
  }

  const pending = () => listPendingBybitOrders(prisma, new Date());
  const dep = (over: Partial<BybitDeposit> & { txId: string; amount: number }): BybitDeposit => ({
    chain: "BSC", ...over,
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
    deleteSetting(prisma, BYBIT_ADDRESS_KEY),
    deleteSetting(prisma, BYBIT_API_KEY_KEY),
    deleteSetting(prisma, BYBIT_API_SECRET_KEY),
  ]);

  it("is disabled when no settings (and no env) are present", async () => {
    await clear();
    const cfg = await resolveBybitConfig(prisma);
    expect(cfg.enabled).toBe(false);
  });

  it("is disabled until ALL THREE of address + key + secret are set", async () => {
    await clear();
    await setSetting(prisma, BYBIT_ADDRESS_KEY, "0xabc");
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    expect((await resolveBybitConfig(prisma)).enabled).toBe(false); // secret still missing
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
    const cfg = await resolveBybitConfig(prisma);
    expect(cfg.enabled).toBe(true);
    expect(cfg.depositAddress).toBe("0xabc");
    expect(cfg.apiKey).toBe("k");
    expect(cfg.apiSecret).toBe("s");
  });

  it("treats a blank/whitespace setting as unset", async () => {
    await clear();
    await setSetting(prisma, BYBIT_ADDRESS_KEY, "  ");
    await setSetting(prisma, BYBIT_API_KEY_KEY, "k");
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "s");
    expect((await resolveBybitConfig(prisma)).enabled).toBe(false);
    await clear();
  });
});

describe("recordUnmatchedBybitTx", () => {
  it("records once and dedupes", async () => {
    expect(await recordUnmatchedBybitTx(prisma, { bybitTxId: "0xUNM", amount: "9.99" })).toBe(true);
    expect(await recordUnmatchedBybitTx(prisma, { bybitTxId: "0xUNM", amount: "9.99" })).toBe(false);
    expect(await prisma.processedBybitTx.count({ where: { bybitTxId: "0xUNM", outcome: "unmatched" } })).toBe(1);
  });
});
