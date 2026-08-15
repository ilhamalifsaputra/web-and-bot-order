// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createOrderDirect,
  createWalletTopupOrder,
  finalizeOrderPayment,
  listPendingPaydisiniOrders,
  setOrderPaymentMessage,
  setSetting,
  bulkAddStock,
  getPollHealth,
  updateDenomination,
} from "@app/db";
import type { Api } from "grammy";
import { DeliveryType, OrderStatus, OrderCurrency, PaymentMethod } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { telegramError } from "./helpers/ctx";
import { onlyBubbleEdit } from "./helpers/settledBubble";
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

  // Twin of the identical suite in tokopay-reconcile.test.ts — see there for
  // why dropping the anchor after a merely-retryable failure strands the buyer
  // on a stale QRIS QR with nothing left in the system that would retry it.
  describe("a failed success-bubble flip only drops the anchor when the failure is final", () => {
    const flipWith = (captionError: unknown, textError = captionError) =>
      ({
        sendMessage: vi.fn().mockResolvedValue(undefined),
        editMessageCaption: vi.fn().mockRejectedValue(captionError),
        editMessageText: vi.fn().mockRejectedValue(textError),
      }) as unknown as Api;

    /** A delivered order with an anchored bubble whose flip failed as given. */
    async function deliverWithFailedFlip(api: Api) {
      const created = await makePaydisiniOrder();
      const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
      await setOrderPaymentMessage(prisma, created!.id, 555, 777);
      stubStatus({ status: "success", unique_code: "TRX-EDITFAIL", amount: pending!.totalAmount.toString() });

      await reconcileOrder(api, CREDS, pending!);

      return prisma.order.findUnique({ where: { id: created!.id } });
    }

    it.each([
      ["Telegram flood control", telegramError(429, "Too Many Requests: retry after 30")],
      ["a Telegram server error", telegramError(502, "Bad Gateway")],
      ["something that is not a Telegram API error at all, such as a network fault", new Error("socket hang up")],
    ])("keeps the anchor when the flip fails with %s, so the paid-order bubble sweep retries it", async (_label, error) => {
      const after = await deliverWithFailedFlip(flipWith(error));

      expect(after?.status).toBe(OrderStatus.DELIVERED);
      expect(after?.paymentMsgChatId).not.toBeNull();
      expect(after?.paymentMsgId).not.toBeNull();
    });

    it("clears the anchor when Telegram says the bubble is gone for good, so it self-heals out of the sweep's queue", async () => {
      const after = await deliverWithFailedFlip(flipWith(telegramError(400, "Bad Request: message to edit not found")));

      expect(after?.paymentMsgChatId).toBeNull();
      expect(after?.paymentMsgId).toBeNull();
    });

    it("clears the anchor when only the caption attempt says the bubble already shows this exact text", async () => {
      const after = await deliverWithFailedFlip(
        flipWith(
          telegramError(400, "Bad Request: message is not modified"),
          telegramError(400, "Bad Request: there is no text in the message to edit"),
        ),
      );

      expect(after?.paymentMsgChatId).toBeNull();
      expect(after?.paymentMsgId).toBeNull();
    });
  });

  // Twin of the identical suite in tokopay-reconcile.test.ts — see there for
  // why a top-up settled on a QRIS rail used to end on the product sale's
  // sentence and keyboard with no balance in sight, and why the anchor being
  // cleared right afterwards meant the generic sweeper could never repair it.
  describe("the success bubble a settled order is flipped to", () => {
    /** Pre-credit balance, deliberately distinct from the post-credit one so a
     *  bubble quoting a stale snapshot is visibly wrong rather than plausible. */
    const STARTING_IDR = "123456";
    const TOPUP_IDR = "50000";

    const bubbleEdit = (api: Api) =>
      onlyBubbleEdit(
        (api.editMessageCaption as ReturnType<typeof vi.fn>).mock.calls,
        (api.editMessageText as ReturnType<typeof vi.fn>).mock.calls,
      );

    /** Reconcile the one pending PayDisini order, with the gateway reporting
     *  it paid in full. */
    async function reconcilePaid(api: Api, trxId: string): Promise<void> {
      const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
      stubStatus({ status: "success", unique_code: trxId, amount: pending!.totalAmount.toString() });
      await reconcileOrder(api, CREDS, pending!);
    }

    async function makeAnchoredTopup() {
      await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalance: STARTING_IDR } });
      const order = await prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: TOPUP_IDR,
          currency: "IDR",
          method: PaymentMethod.PAYDISINI,
        }),
      );
      // Same pre-existing gap the TokoPay twin documents: an IDR top-up is
      // created with a null `expiresAt`, so `listPendingPaydisiniOrders` never
      // lists it. Stamped here so the poller can do its real job.
      await prisma.order.update({
        where: { id: order.id },
        data: { expiresAt: new Date(Date.now() + 30 * 60_000) },
      });
      await setOrderPaymentMessage(prisma, order.id, 555, 777);
      return order;
    }

    it("words a settled wallet top-up as a top-up, quoting the balance AFTER the credit landed", async () => {
      const topup = await makeAnchoredTopup();
      const api = fakeApi();

      await reconcilePaid(api, "TRX-TOPUP");

      const edit = bubbleEdit(api);
      expect(edit.chatId).toBe(555);
      expect(edit.msgId).toBe(777);
      expect(edit.text).toContain("Top-up successful");
      expect(edit.text).toContain(topup.orderCode);
      expect(edit.text).toContain("Rp173.456"); // Rp123.456 already held + Rp50.000 topped up
      expect(edit.text).not.toContain("Rp123.456"); // never the pre-credit snapshot
    });

    it("offers a settled wallet top-up the wallet keyboard, never the product sale's order history", async () => {
      await makeAnchoredTopup();
      const api = fakeApi();

      await reconcilePaid(api, "TRX-TOPUP-KB");

      const edit = bubbleEdit(api);
      expect(edit.buttons).toContain("v1:topup:open");
      expect(edit.buttons).not.toContain("v1:order:list");
    });

    it("still tells a delivered product sale its items are on the way, with the product keyboard", async () => {
      const created = await makePaydisiniOrder();
      await setOrderPaymentMessage(prisma, created!.id, 555, 778);
      const api = fakeApi();

      await reconcilePaid(api, "TRX-PRODUCT-DELIVERED");

      expect((await prisma.order.findUnique({ where: { id: created!.id } }))?.status).toBe(OrderStatus.DELIVERED);
      const edit = bubbleEdit(api);
      expect(edit.text).toContain("Payment received");
      expect(edit.text).toContain("being delivered now");
      expect(edit.buttons).toContain("v1:order:list");
      expect(edit.buttons).not.toContain("v1:topup:open");
    });

    it("tells a manual-fulfilment product sale it is being prepared, with the same product keyboard", async () => {
      await updateDenomination(prisma, sample.product.id, { deliveryType: DeliveryType.MANUAL });
      const created = await makePaydisiniOrder();
      await setOrderPaymentMessage(prisma, created!.id, 555, 779);
      const api = fakeApi();

      await reconcilePaid(api, "TRX-PRODUCT-PROCESSING");

      expect((await prisma.order.findUnique({ where: { id: created!.id } }))?.status).toBe(OrderStatus.PROCESSING);
      const edit = bubbleEdit(api);
      expect(edit.text).toContain("Payment received");
      expect(edit.text).toContain("being prepared for delivery manually");
      expect(edit.buttons).toContain("v1:order:list");
      expect(edit.buttons).not.toContain("v1:topup:open");
    });
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
