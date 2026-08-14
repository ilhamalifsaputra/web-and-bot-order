// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createOrderDirect,
  finalizeOrderPayment,
  listPendingPaydisiniOrders,
  setOrderPaymentMessage,
  setSetting,
  bulkAddStock,
  getPollHealth,
} from "@app/db";
import type { Api } from "grammy";
import { OrderStatus, OrderCurrency, PaymentMethod } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { reconcileOrder, pollOnce, MAX_ORDERS_PER_CYCLE } from "../src/payments/paydisiniReconcile";
import { PAYDISINI_USERKEY_KEY, PAYDISINI_APIKEY_KEY } from "@app/core/payments/paydisini";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedPaydisiniTx.deleteMany(); // new table, not covered by resetDb
  sample = await buildSampleData(prisma);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const CREDS = { userKey: "uk", apiKey: "ak", channel: "QRIS", minAmount: null };
const fakeApi = () =>
  ({
    sendMessage: vi.fn().mockResolvedValue(undefined),
    editMessageCaption: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  }) as unknown as Api;

/** Stub the gateway status call. */
function stubStatus(data: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "success", data }) }),
  );
}

async function makePaydisiniOrder() {
  return prisma.$transaction(async (tx) => {
    const o = await createOrderDirect(tx, {
      user: { id: sample.user.id, role: sample.user.role },
      productId: sample.product.id,
      quantity: 1,
    });
    return finalizeOrderPayment(tx, o!.id, { currency: OrderCurrency.IDR, method: PaymentMethod.PAYDISINI });
  });
}

describe("reconcileOrder (PayDisini poller safety net)", () => {
  it("delivers a pending PAYDISINI order the gateway reports paid", async () => {
    const created = await makePaydisiniOrder();
    const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
    expect(pending).toBeDefined();
    stubStatus({ status: "success", unique_code: "TRX-RC", amount: pending!.totalAmount.toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created!.id } });
    expect(after?.status).toBe(OrderStatus.DELIVERED);
    const tx = await prisma.processedPaydisiniTx.findFirst({ where: { orderId: created!.id } });
    expect(tx?.outcome).toBe("matched");
  });

  it("leaves the order pending when the gateway reports unpaid", async () => {
    await makePaydisiniOrder();
    const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
    stubStatus({ status: "pending" });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const [stillPending] = await listPendingPaydisiniOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
  });

  it("never delivers on an underpayment", async () => {
    await makePaydisiniOrder();
    const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
    stubStatus({ status: "success", unique_code: "TRX-SHORT", amount: pending!.totalAmount.minus(1).toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const [stillPending] = await listPendingPaydisiniOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
  });

  it("immediately flips the anchored QR bubble to success when it delivers the order", async () => {
    const created = await makePaydisiniOrder();
    const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
    await setOrderPaymentMessage(prisma, created!.id, 555, 777);
    stubStatus({ status: "success", unique_code: "TRX-FLIP", amount: pending!.totalAmount.toString() });

    const api = fakeApi();
    await reconcileOrder(api, CREDS, pending!);

    expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
    const [chatId, msgId, payload] = (api.editMessageCaption as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chatId).toBe(555);
    expect(msgId).toBe(777);
    const flat = (payload.reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>).flat().map((b) => b.callback_data);
    expect(flat).toContain("v1:browse:prods");

    const after = await prisma.order.findUnique({ where: { id: created!.id } });
    expect(after?.paymentMsgChatId).toBeNull();
    expect(after?.paymentMsgId).toBeNull();
  });
});

// PayDisini's own per-rail bubble sweep (`sweepDeliveredAwaitingEdit`,
// including its "flips once then no-op" and black-holed-bubble-edit bound
// tests) was removed in Task T2-F: the generic paid-order bubble sweeper
// (`sweepPaidOrderBubbles`, apps/order-bot/src/jobs/index.ts, Task T2-E)
// replaced it, and its own test suite (apps/order-bot/test/jobs.test.ts,
// `describe("sweepPaidOrderBubbles")`) already covers the identical
// flip-once/no-op behavior and the identical black-holed-bubble-edit/
// whole-sweep-budget bounds for every rail including PayDisini — see
// jobs.test.ts's `it.each(matrix)` and its
// "safety bounds against a black-holed bubble edit" describe block. Moving
// these tests there instead of deleting them would have duplicated that
// coverage.

async function seedPaydisiniCreds() {
  await setSetting(prisma, PAYDISINI_USERKEY_KEY, "uk");
  await setSetting(prisma, PAYDISINI_APIKEY_KEY, "ak");
}

describe("pollOnce (heartbeat + bounded cycle — Task 11)", () => {
  it("records a heartbeat even when there are no pending orders to reconcile", async () => {
    await seedPaydisiniCreds();

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "paydisini");
    expect(health.lastRun).not.toBeNull();
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.lastTxCount).toBe(0);
  });

  it("does not record a heartbeat when the rail has no credentials configured", async () => {
    // No seedPaydisiniCreds() call — the rail is genuinely off.
    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "paydisini");
    expect(health.lastRun).toBeNull();
  });

  it("records a failed heartbeat when every gateway status call in the cycle fails", async () => {
    await seedPaydisiniCreds();
    await makePaydisiniOrder();
    await makePaydisiniOrder();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "paydisini");
    expect(health.lastSuccessAt).toBeNull();
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBeTruthy();
  });

  it("leaves the cycle healthy when only some gateway status calls fail (one flaky order is not an outage)", async () => {
    await seedPaydisiniCreds();
    await makePaydisiniOrder();
    await makePaydisiniOrder();
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) return Promise.reject(new Error("transient"));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "success", data: { status: "pending" } }) });
      }),
    );

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "paydisini");
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.consecutiveFailures).toBe(0);
  });

  it("checks at most MAX_ORDERS_PER_CYCLE orders in one cycle", async () => {
    await seedPaydisiniCreds();
    const extraCreds = Array.from({ length: MAX_ORDERS_PER_CYCLE + 5 }, (_, i) => `stock-extra-${i}`);
    await bulkAddStock(prisma, sample.product.id, extraCreds);
    for (let i = 0; i < MAX_ORDERS_PER_CYCLE + 3; i++) await makePaydisiniOrder();
    stubStatus({ status: "pending" });
    const fetchMock = vi.mocked(globalThis.fetch);

    await pollOnce(fakeApi());

    expect(fetchMock).toHaveBeenCalledTimes(MAX_ORDERS_PER_CYCLE);
    const health = await getPollHealth(prisma, "paydisini");
    expect(health.lastTxCount).toBe(MAX_ORDERS_PER_CYCLE);
  });

  // followup-review-fixes-2: MAX_ORDERS_PER_CYCLE used to always cap the same
  // oldest-first slice (listPendingPaydisiniOrders' own ordering) — a backlog
  // over the cap left orders 51+ unchecked by this safety net until enough
  // older ones expired out. The rotating cursor (rotatingCursor.ts) instead
  // rotates which slice gets checked, so the SAME backlog gets full coverage
  // across a couple of cycles instead of the tail starving indefinitely.
  it("rotates which orders are checked across cycles, covering the whole backlog instead of always the same oldest N", async () => {
    await seedPaydisiniCreds();
    const total = MAX_ORDERS_PER_CYCLE + 3;
    const extraCreds = Array.from({ length: total + 2 }, (_, i) => `stock-extra-rot-${i}`);
    await bulkAddStock(prisma, sample.product.id, extraCreds);
    for (let i = 0; i < total; i++) await makePaydisiniOrder();

    const seenRefIds = new Set<string>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const match = /ref_id=([^&]+)/.exec(url);
        if (match?.[1]) seenRefIds.add(decodeURIComponent(match[1]));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "success", data: { status: "pending" } }) });
      }),
    );

    await pollOnce(fakeApi());
    expect(seenRefIds.size).toBe(MAX_ORDERS_PER_CYCLE); // never all `total` in one cycle

    await pollOnce(fakeApi()); // the rotating window's next slice picks up the rest
    expect(seenRefIds.size).toBe(total); // full coverage within 2 cycles, no starved tail
  });
});
