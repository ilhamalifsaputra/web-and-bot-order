// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createOrderDirect,
  finalizeOrderPayment,
  listPendingTokopayOrders,
  setOrderPaymentMessage,
  deliverPaidTokopayOrder,
  setSetting,
  bulkAddStock,
  getPollHealth,
} from "@app/db";
import type { Api } from "grammy";
import { OrderStatus, OrderCurrency } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import {
  reconcileOrder,
  sweepDeliveredAwaitingEdit,
  pollOnce,
  MAX_ORDERS_PER_CYCLE,
} from "../src/payments/tokopayReconcile";
import { qrisChargeAmount } from "@app/core/payments/tokopay";
import { TOKOPAY_MERCHANT_KEY, TOKOPAY_SECRET_KEY } from "@app/core/payments/tokopay";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedTokopayTx.deleteMany(); // new table, not covered by resetDb
  sample = await buildSampleData(prisma);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const CREDS = { merchantId: "M", secret: "s", channel: "QRIS", minAmount: null };
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

async function makeTokopayOrder() {
  return prisma.$transaction(async (tx) => {
    const o = await createOrderDirect(tx, {
      user: { id: sample.user.id, role: sample.user.role },
      productId: sample.product.id,
      quantity: 1,
    });
    return finalizeOrderPayment(tx, o!.id, { currency: OrderCurrency.IDR });
  });
}

describe("reconcileOrder (TokoPay poller safety net)", () => {
  it("delivers a pending TOKOPAY order the gateway reports paid (fee-inclusive amount)", async () => {
    const created = await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    expect(pending).toBeDefined();
    const charge = qrisChargeAmount(pending!.totalAmount);
    stubStatus({ status: "Paid", trx_id: "TRX-RC", total_bayar: charge.toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created!.id } });
    expect(after?.status).toBe(OrderStatus.DELIVERED);
    const tx = await prisma.processedTokopayTx.findFirst({ where: { orderId: created!.id } });
    expect(tx?.outcome).toBe("matched");
  });

  it("never delivers when the gateway reports only the bare order total (no admin fee)", async () => {
    await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    stubStatus({ status: "Paid", trx_id: "TRX-NOFEE", total_bayar: pending!.totalAmount.toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const [stillPending] = await listPendingTokopayOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
  });

  it("leaves the order pending when the gateway reports unpaid", async () => {
    await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    stubStatus({ status: "Unpaid" });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const [stillPending] = await listPendingTokopayOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
  });

  it("never delivers on an underpayment", async () => {
    await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    stubStatus({ status: "Paid", trx_id: "TRX-SHORT", total_bayar: pending!.totalAmount.minus(1).toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const [stillPending] = await listPendingTokopayOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
  });

  it("immediately flips the anchored QR bubble to success when it delivers the order", async () => {
    const created = await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    await setOrderPaymentMessage(prisma, created!.id, 555, 777);
    const charge = qrisChargeAmount(pending!.totalAmount);
    stubStatus({ status: "Paid", trx_id: "TRX-FLIP", total_bayar: charge.toString() });

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

describe("sweepDeliveredAwaitingEdit (TokoPay webhook-delivered bubbles)", () => {
  it("flips a webhook-delivered order's bubble exactly once, then is a no-op", async () => {
    const created = await makeTokopayOrder();
    await setOrderPaymentMessage(prisma, created!.id, 555, 777);
    const r = await deliverPaidTokopayOrder(prisma, {
      orderId: created!.id,
      trxId: "TRX-WEBHOOK",
      amount: created!.totalAmount,
      shopUrl: null,
    });
    expect(r.status).toBe("delivered");

    const api = fakeApi();
    await sweepDeliveredAwaitingEdit(api);

    expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
    const after = await prisma.order.findUnique({ where: { id: created!.id } });
    expect(after?.paymentMsgChatId).toBeNull();
    expect(after?.paymentMsgId).toBeNull();

    // Second sweep: the anchor is cleared, so this must be a no-op.
    await sweepDeliveredAwaitingEdit(api);
    expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
  });
});

// Task 11 review follow-up, Minor #6 / Important #2: the whole point of
// SWEEP_EDIT_TIMEOUT_MS/SWEEP_TOTAL_BUDGET_MS (see their own doc-comments in
// tokopayReconcile.ts, and the RECONCILE_CYCLE_TIMEOUT_MS derivation that
// budgets off them) is a bound nothing here actually proved holds until now.
describe("sweepDeliveredAwaitingEdit is bounded against a black-holed bubble edit (Task 11 review follow-up, Minor #6)", () => {
  // Real timers, not fake: `vi.useFakeTimers()` faking `setTimeout` breaks
  // Prisma's own real I/O in this test harness (verified — it hangs the DB
  // calls sweepDeliveredAwaitingEdit itself makes), so these race real
  // timers against genuinely never-resolving grammY calls, at real
  // wall-clock cost. Task 11 review follow-up, Important #2: rather than
  // sleep for the real SWEEP_EDIT_TIMEOUT_MS/SWEEP_TOTAL_BUDGET_MS (10s/30s —
  // ~40s of real sleeping per file), these pass sweepDeliveredAwaitingEdit's
  // own opts to shrink both proportionally (same 1:3 ratio as production) so
  // the identical give-up/budget-break logic is proven in well under a
  // second, with real timers and real Prisma throughout. Production behavior
  // is unchanged — the defaults are still the exported constants.
  const editTimeoutMs = 50;
  const totalBudgetMs = 150;

  it("gives up waiting on a single hung bubble edit after its edit timeout, leaving the anchor in place", async () => {
    const created = await makeTokopayOrder();
    await setOrderPaymentMessage(prisma, created!.id, 555, 777);
    const r = await deliverPaidTokopayOrder(prisma, {
      orderId: created!.id,
      trxId: "TRX-HANG",
      amount: created!.totalAmount,
      shopUrl: null,
    });
    expect(r.status).toBe("delivered");

    const hangingApi = {
      editMessageCaption: vi.fn(() => new Promise(() => {})), // never resolves
      editMessageText: vi.fn(() => new Promise(() => {})),
    } as unknown as Api;

    await sweepDeliveredAwaitingEdit(hangingApi, { editTimeoutMs, totalBudgetMs });

    // The anchor was never cleared — clearOrderPaymentMessage only runs once
    // an edit genuinely completes, and this one timed out instead.
    const after = await prisma.order.findUnique({ where: { id: created!.id } });
    expect(after?.paymentMsgChatId).not.toBeNull();
    expect(after?.paymentMsgId).not.toBeNull();
  });

  it("gives up on the remaining orders once the whole-sweep budget is exceeded, leaving their anchors in place", async () => {
    // Four DELIVERED, anchored orders whose bubble edit hangs forever.
    // editTimeoutMs < totalBudgetMs, so no single row's own per-row timeout
    // can exceed the whole-sweep budget by itself — but three rows each
    // individually timing out (~editTimeoutMs each) cumulatively cross
    // totalBudgetMs, so the budget check before the fourth row must cut the
    // sweep off before it's ever attempted.
    const orderIds: number[] = [];
    for (let i = 0; i < 4; i++) {
      const o = await makeTokopayOrder();
      await setOrderPaymentMessage(prisma, o!.id, 555, 100 + i);
      await deliverPaidTokopayOrder(prisma, { orderId: o!.id, trxId: `TRX-BUDGET-${i}`, amount: o!.totalAmount, shopUrl: null });
      orderIds.push(o!.id);
    }

    const hangingApi = {
      editMessageCaption: vi.fn(() => new Promise(() => {})), // every edit hangs
      editMessageText: vi.fn(() => new Promise(() => {})),
    } as unknown as Api;

    await sweepDeliveredAwaitingEdit(hangingApi, { editTimeoutMs, totalBudgetMs });

    // Exactly 3 rows were attempted (each individually timed out) — the
    // 4th's anchor is untouched because the whole-sweep budget check broke
    // the loop before it was ever reached.
    expect(hangingApi.editMessageCaption).toHaveBeenCalledTimes(3);

    const fourthAfter = await prisma.order.findUnique({ where: { id: orderIds[3] } });
    expect(fourthAfter?.paymentMsgChatId).not.toBeNull();
    expect(fourthAfter?.paymentMsgId).not.toBeNull();
  });
});

async function seedTokopayCreds() {
  await setSetting(prisma, TOKOPAY_MERCHANT_KEY, "M");
  await setSetting(prisma, TOKOPAY_SECRET_KEY, "s");
}

describe("pollOnce (heartbeat + bounded cycle — Task 11)", () => {
  it("records a heartbeat even when there are no pending orders to reconcile", async () => {
    await seedTokopayCreds();

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "tokopay");
    expect(health.lastRun).not.toBeNull();
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.lastTxCount).toBe(0);
  });

  it("does not record a heartbeat when the rail has no credentials configured", async () => {
    // No seedTokopayCreds() call — the rail is genuinely off.
    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "tokopay");
    expect(health.lastRun).toBeNull();
  });

  it("records a failed heartbeat when every gateway status call in the cycle fails", async () => {
    await seedTokopayCreds();
    await makeTokopayOrder();
    await makeTokopayOrder();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "tokopay");
    expect(health.lastSuccessAt).toBeNull();
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBeTruthy();
  });

  it("leaves the cycle healthy when only some gateway status calls fail (one flaky order is not an outage)", async () => {
    await seedTokopayCreds();
    await makeTokopayOrder();
    await makeTokopayOrder();
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) return Promise.reject(new Error("transient"));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "success", data: { status: "Unpaid" } }) });
      }),
    );

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "tokopay");
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.consecutiveFailures).toBe(0);
  });

  it("checks at most MAX_ORDERS_PER_CYCLE orders in one cycle", async () => {
    await seedTokopayCreds();
    const extraCreds = Array.from({ length: MAX_ORDERS_PER_CYCLE + 5 }, (_, i) => `stock-extra-${i}`);
    await bulkAddStock(prisma, sample.product.id, extraCreds);
    for (let i = 0; i < MAX_ORDERS_PER_CYCLE + 3; i++) await makeTokopayOrder();
    stubStatus({ status: "Unpaid" });
    const fetchMock = vi.mocked(globalThis.fetch);

    await pollOnce(fakeApi());

    expect(fetchMock).toHaveBeenCalledTimes(MAX_ORDERS_PER_CYCLE);
    const health = await getPollHealth(prisma, "tokopay");
    expect(health.lastTxCount).toBe(MAX_ORDERS_PER_CYCLE);
  });

  // followup-review-fixes-2: MAX_ORDERS_PER_CYCLE used to always cap the same
  // oldest-first slice (listPendingTokopayOrders' own ordering) — a backlog
  // over the cap left orders 51+ unchecked by this safety net until enough
  // older ones expired out. The rotating cursor (rotatingCursor.ts) instead
  // rotates which slice gets checked, so the SAME backlog gets full coverage
  // across a couple of cycles instead of the tail starving indefinitely.
  it("rotates which orders are checked across cycles, covering the whole backlog instead of always the same oldest N", async () => {
    await seedTokopayCreds();
    const total = MAX_ORDERS_PER_CYCLE + 3;
    const extraCreds = Array.from({ length: total + 2 }, (_, i) => `stock-extra-rot-${i}`);
    await bulkAddStock(prisma, sample.product.id, extraCreds);
    for (let i = 0; i < total; i++) await makeTokopayOrder();

    const seenRefIds = new Set<string>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const match = /ref_id=([^&]+)/.exec(url);
        if (match?.[1]) seenRefIds.add(decodeURIComponent(match[1]));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "success", data: { status: "Unpaid" } }) });
      }),
    );

    await pollOnce(fakeApi());
    expect(seenRefIds.size).toBe(MAX_ORDERS_PER_CYCLE); // never all `total` in one cycle

    await pollOnce(fakeApi()); // the rotating window's next slice picks up the rest
    expect(seenRefIds.size).toBe(total); // full coverage within 2 cycles, no starved tail
  });
});
