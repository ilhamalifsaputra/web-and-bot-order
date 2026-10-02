// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createOrderDirect,
  createWalletTopupOrder,
  finalizeOrderPayment,
  listPendingTokopayOrders,
  setOrderPaymentMessage,
  setSetting,
  bulkAddStock,
  getPollHealth,
  updateDenomination,
  deliverPaidTokopayOrder,
} from "@app/db";
import { gatewayLedgerTrxId } from "@app/core/payments/ledgerKey";
import type { Api } from "grammy";
import { DeliveryType, OrderStatus, OrderCurrency, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import { config } from "@app/core/config";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { telegramError } from "./helpers/ctx";
import { onlyBubbleEdit } from "./helpers/settledBubble";
import { reconcileOrder, pollOnce, MAX_ORDERS_PER_CYCLE } from "../src/payments/tokopayReconcile";
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

/** The id `sendMessage` hands back for a replacement bubble — deliberately not
 *  the anchored message's id, so a test cannot pass by confusing the two. */
const REPLACEMENT_MSG_ID = 90210;

/** `editMessageCaption` is still on the double even though nothing should ever
 *  call it: this rail used to flip a paid order's bubble through the caption,
 *  which "succeeded" while leaving the useless QR image in the buyer's chat, so
 *  a test that finds it called is finding that bug back. */
const fakeApi = (
  overrides: Partial<{
    editMessageText: unknown;
    deleteMessage: unknown;
    sendMessage: unknown;
  }> = {},
) =>
  ({
    sendMessage: overrides.sendMessage ?? vi.fn().mockResolvedValue({ message_id: REPLACEMENT_MSG_ID }),
    editMessageCaption: vi.fn().mockResolvedValue(undefined),
    editMessageText: overrides.editMessageText ?? vi.fn().mockResolvedValue(undefined),
    deleteMessage: overrides.deleteMessage ?? vi.fn().mockResolvedValue(true),
  }) as unknown as Api;

/** Telegram's answer to `editMessageText` on a PHOTO message — the one signal
 *  that says "this bubble carries a QR image, not text". Deliberately absent
 *  from `isPermanentBubbleEditFailure`'s permanent list, which is what routes
 *  it onto the delete-and-resend path. */
const noTextToEdit = () => telegramError(400, "Bad Request: there is no text in the message to edit");

/** The callback data on whatever keyboard a grammY call carried. */
const buttonsOf = (payload: { reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> } }) =>
  payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);

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

  it("never delivers when the gateway reports only the bare order total (no admin fee) — flagged UNDERPAID instead", async () => {
    const created = await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    stubStatus({ status: "Paid", trx_id: "TRX-NOFEE", total_bayar: pending!.totalAmount.toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created!.id } });
    expect(after?.status).toBe(OrderStatus.UNDERPAID);
  });

  // The poller used to claim `reconcile-<orderCode>` when TokoPay's status
  // response carried no trx_id — a UNIQUE ledger row the storefront webhook
  // can never write, so one payment confirmed from both directions produced
  // TWO rows and the ledger (the primary idempotency gate) caught neither.
  // Both paths now derive the key the same way: the live call's id, falling
  // back to the order code, which is the ref_id we handed TokoPay.
  it("keys the ledger on the order code, not a synthetic reconcile- key, when the gateway returns no trx_id", async () => {
    const created = await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    stubStatus({ status: "Paid", total_bayar: qrisChargeAmount(pending!.totalAmount).toString() }); // no trx_id

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const rows = await prisma.processedTokopayTx.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trxId).toBe(created!.orderCode);
    expect(rows[0]!.outcome).toBe("matched");
  });

  // The collision the shared key buys: a webhook arriving after the poller
  // already settled the payment hits the row the poller claimed, in the
  // ledger, instead of inserting a second one. `deliverPaidTokopayOrder` is
  // the exact function the storefront webhook route calls, with the exact key
  // that route now derives for a live response carrying no trx_id.
  it("makes a later webhook for the same payment collide on the poller's own ledger row", async () => {
    const created = await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    const charge = qrisChargeAmount(pending!.totalAmount);
    stubStatus({ status: "Paid", total_bayar: charge.toString() }); // no trx_id

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const webhook = await deliverPaidTokopayOrder(prisma, {
      orderId: created!.id,
      trxId: gatewayLedgerTrxId(null, created!.orderCode),
      amount: charge,
      shopUrl: null,
    });

    expect(webhook.status).toBe("already_processed");
    expect(await prisma.processedTokopayTx.count()).toBe(1);
  });

  it("leaves the order pending when the gateway reports unpaid", async () => {
    await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    stubStatus({ status: "Unpaid" });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const [stillPending] = await listPendingTokopayOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
  });

  it("never delivers on an underpayment, flags the order UNDERPAID, and alerts admins", async () => {
    const created = await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    const shortAmount = pending!.totalAmount.minus(1);
    stubStatus({ status: "Paid", trx_id: "TRX-SHORT", total_bayar: shortAmount.toString() });
    const api = fakeApi();

    await reconcileOrder(api, CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created!.id } });
    expect(after?.status).toBe(OrderStatus.UNDERPAID);
    // ADMIN_IDS = "999,1000" in test setup — one alert per admin.
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const [, text] = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(text)).toMatch(/[Uu]nderpaid/);
    expect(String(text)).toContain(created!.orderCode);
    expect(String(text)).toContain("TokoPay");
  });

  // The poller re-checks the same order.id every cycle — the order's own
  // status IS the idempotency guard (no separate ledger table needed, unlike
  // the crypto rails). A second cycle before a human resolves the order must
  // be a silent no-op: no double alert, no throw.
  it("does not alert a second time when an already-UNDERPAID order is reconciled again", async () => {
    await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    stubStatus({ status: "Paid", trx_id: "TRX-SHORT-2", total_bayar: pending!.totalAmount.minus(1).toString() });
    const api = fakeApi();

    await reconcileOrder(api, CREDS, pending!);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);

    await expect(reconcileOrder(api, CREDS, pending!)).resolves.toBe("ok");
    expect(api.sendMessage).toHaveBeenCalledTimes(2); // no additional alert on the second cycle
  });

  /** Deliver the one pending order with its bubble anchored at (555, 777), and
   *  hand back the row so the anchor can be read afterwards. */
  async function deliverAnchored(api: Api, trxId: string) {
    const created = await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    await setOrderPaymentMessage(prisma, created!.id, 555, 777);
    stubStatus({ status: "Paid", trx_id: trxId, total_bayar: qrisChargeAmount(pending!.totalAmount).toString() });

    await reconcileOrder(api, CREDS, pending!);

    return prisma.order.findUnique({ where: { id: created!.id } });
  }

  it("immediately flips an anchored TEXT bubble to success in place when it delivers the order", async () => {
    const api = fakeApi();

    const after = await deliverAnchored(api, "TRX-FLIP");

    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, msgId, , payload] = (api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chatId).toBe(555);
    expect(msgId).toBe(777);
    expect(buttonsOf(payload)).toContain("v1:browse:prods");
    // A bubble that took the edit is left exactly where it is.
    expect(api.editMessageCaption).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();

    expect(after?.paymentMsgChatId).toBeNull();
    expect(after?.paymentMsgId).toBeNull();
  });

  // The bug this rail's share of the change exists for: a photo bubble's
  // CAPTION can be edited, so the old caption-first flip "succeeded" while
  // Telegram left the now-meaningless QR image parked above the "payment
  // received" line — on the path QRIS payments actually take most often.
  // Telegram offers no way to turn a photo message into a text one, so the only
  // way to get rid of the image is to delete the bubble and send it afresh.
  it("replaces an anchored PHOTO (QR) bubble with a fresh message instead of leaving the QR image behind", async () => {
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(noTextToEdit()) });

    const after = await deliverAnchored(api, "TRX-FLIP-PHOTO");

    expect(api.editMessageCaption).not.toHaveBeenCalled();
    expect(api.deleteMessage).toHaveBeenCalledWith(555, 777);
    // Sent into the bubble's own chat, taking the deleted bubble's place —
    // not as a fallback DM, which would only repeat news the buyer already got
    // with their account file.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [target, text, payload] = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(target).toBe(555);
    expect(String(text)).toContain("Payment received");
    expect(buttonsOf(payload)).toContain("v1:browse:prods");

    expect(after?.paymentMsgChatId).toBeNull();
    expect(after?.paymentMsgId).toBeNull();
  });

  // The anchor IS the work queue: `sweepPaidOrderBubbles` (jobs/index.ts)
  // lists exactly the settled orders that still carry one, so clearing it
  // after an edit Telegram merely refused THIS minute leaves nothing in the
  // system that would ever retry — the buyer stares at a stale QRIS QR for an
  // order that is already paid and delivered. QRIS is this shop's dominant
  // payment method, so this rail is where that bug hurts most.
  describe("a failed success-bubble flip only drops the anchor when the failure is final", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    /** True when the rail explained, in the log, why it is holding the anchor. */
    const warnedAboutTheBubble = () =>
      warnSpy.mock.calls.some((args) => args.some((arg) => typeof arg === "string" && arg.includes("payment bubble")));

    /** An outage hits every call to Telegram, not just the first: an edit that
     *  merely failed THIS minute is followed by a delete that fails the same
     *  way, which is exactly what keeps the bubble (and the anchor) intact. A
     *  delete that succeeded would mean the bubble really was a photo and the
     *  replacement path could finish the job. */
    const flipWith = (editError: unknown, deleteError = editError) =>
      fakeApi({
        editMessageText: vi.fn().mockRejectedValue(editError),
        deleteMessage: vi.fn().mockRejectedValue(deleteError),
      });

    /** A delivered order with an anchored bubble whose flip failed as given. */
    async function deliverWithFailedFlip(api: Api) {
      const created = await makeTokopayOrder();
      const [pending] = await listPendingTokopayOrders(prisma, new Date());
      await setOrderPaymentMessage(prisma, created!.id, 555, 777);
      stubStatus({ status: "Paid", trx_id: "TRX-EDITFAIL", total_bayar: qrisChargeAmount(pending!.totalAmount).toString() });

      await reconcileOrder(api, CREDS, pending!);

      return prisma.order.findUnique({ where: { id: created!.id } });
    }

    it.each([
      ["Telegram flood control", () => telegramError(429, "Too Many Requests: retry after 30")],
      ["a Telegram server error", () => telegramError(502, "Bad Gateway")],
      ["something that is not a Telegram API error at all, such as a network fault", () => new Error("socket hang up")],
    ])("keeps the anchor when the flip fails with %s, so the paid-order bubble sweep retries it", async (_label, makeError) => {
      const api = flipWith(makeError());

      const after = await deliverWithFailedFlip(api);

      expect(after?.status).toBe(OrderStatus.DELIVERED);
      expect(after?.paymentMsgChatId).not.toBeNull();
      expect(after?.paymentMsgId).not.toBeNull();
      // Nothing was sent: a replacement standing next to a bubble that is still
      // there would tell the buyer the same news twice.
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(warnedAboutTheBubble()).toBe(true);
    });

    // A bubble Telegram has declared dead, or that already shows this exact
    // text, must never be deleted: there is nothing there worth replacing, and
    // on "message is not modified" deleting would destroy a bubble that is
    // already correct.
    it.each([
      ["the bubble is gone for good", "Bad Request: message to edit not found"],
      ["the bubble already shows this exact text", "Bad Request: message is not modified"],
    ])("clears the anchor when Telegram says %s, so it self-heals out of the sweep's queue", async (_label, description) => {
      const api = flipWith(telegramError(400, description));

      const after = await deliverWithFailedFlip(api);

      expect(after?.paymentMsgChatId).toBeNull();
      expect(after?.paymentMsgId).toBeNull();
      expect(api.deleteMessage).not.toHaveBeenCalled();
      expect(api.sendMessage).not.toHaveBeenCalled();
    });
  });

  // A wallet top-up settled on this rail used to be flipped with the PRODUCT
  // sale's sentence and the "My Orders" keyboard, with no mention of the
  // buyer's balance at all — and then had its anchor cleared, so the generic
  // sweeper (`sweepPaidOrderBubbles`, jobs/index.ts), which words a top-up
  // correctly, never got the chance to repair it. Both bubbles are now built
  // by `settledPaymentBubble` (util/delivery.ts), the single mapping the
  // sweeper and the buyer's own "🔄 Refresh Status" tap already share, so all
  // six payment methods end a top-up identically. The PRODUCT cases below are
  // the regression half of that: adopting the shared mapping must not reword
  // an ordinary QRIS product sale.
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

    /** Reconcile the one pending TokoPay order, with the gateway reporting it
     *  paid in full (order total + the QRIS admin fee). */
    async function reconcilePaid(api: Api, trxId: string): Promise<void> {
      const [pending] = await listPendingTokopayOrders(prisma, new Date());
      stubStatus({ status: "Paid", trx_id: trxId, total_bayar: qrisChargeAmount(pending!.totalAmount).toString() });
      await reconcileOrder(api, CREDS, pending!);
    }

    async function makeAnchoredTopup() {
      await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalance: STARTING_IDR } });
      const order = await prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: sample.user.id,
          amount: TOPUP_IDR,
          currency: "IDR",
          method: PaymentMethod.TOKOPAY,
        }),
      );
      // `createWalletTopupOrder`'s IDR branch leaves `expiresAt` null (only its
      // USDT branch stamps one), and `listPendingTokopayOrders` filters on
      // `expiresAt > now` — so a real IDR top-up is invisible to this poller
      // today. That is a separate gap in order creation, not this bubble's
      // behavior, so the fixture stamps the window the order should have had
      // and lets the poller do its real job.
      await prisma.order.update({
        where: { id: order.id },
        data: { expiresAt: new Date(Date.now() + 30 * 60_000) },
      });
      await setOrderPaymentMessage(prisma, order.id, 555, 777);
      return order;
    }

    it("words a settled wallet top-up as a neutral 'payment received' status — the balance-quoting success sentence now lives in the outbox DM instead", async () => {
      const topup = await makeAnchoredTopup();
      const api = fakeApi();

      await reconcilePaid(api, "TRX-TOPUP");

      const edit = bubbleEdit(api);
      expect(edit.chatId).toBe(555);
      expect(edit.msgId).toBe(777);
      expect(edit.text).toContain("Payment received");
      expect(edit.text).toContain("top-up has been credited");
      // The bubble no longer quotes the order code or the credited balance —
      // that now lives exclusively in the outbox DM (WALLET_TOPUP_CREDITED_DM).
      expect(edit.text).not.toContain(topup.orderCode);
      expect(edit.text).not.toContain("Rp173.456"); // Rp123.456 already held + Rp50.000 topped up
      expect(edit.text).not.toContain("Rp123.456"); // never the pre-credit snapshot either
      // Nor the English spelling (prices follow the buyer's language).
      expect(edit.text).not.toContain("Rp173,456");
      expect(edit.text).not.toContain("Rp123,456");

      // The wallet WAS actually credited even though the bubble stays silent
      // about the number — that number is what the outbox DM carries.
      const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
      expect(new Decimal(user.walletBalance).toString()).toBe("173456");
    });

    it("offers a settled wallet top-up the wallet keyboard, never the product sale's order history", async () => {
      await makeAnchoredTopup();
      const api = fakeApi();

      await reconcilePaid(api, "TRX-TOPUP-KB");

      const edit = bubbleEdit(api);
      expect(edit.buttons).toContain("v1:topup:open");
      expect(edit.buttons).not.toContain("v1:order:list");
    });

    // Task E2: a settled wallet top-up's photo (QR) bubble is deleted with NO
    // replacement — the buyer's outbox WALLET_TOPUP_CREDITED_DM already told
    // them the news, so a second message here would be the exact duplicate
    // this task removes. The anchor still clears afterwards.
    it("deletes a settled wallet top-up's photo (QR) bubble and sends nothing in its place", async () => {
      const topup = await makeAnchoredTopup();
      const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(noTextToEdit()) });

      await reconcilePaid(api, "TRX-TOPUP-PHOTO");

      expect(api.deleteMessage).toHaveBeenCalledWith(555, 777);
      expect(api.sendMessage).not.toHaveBeenCalled();

      const after = await prisma.order.findUnique({ where: { id: topup.id } });
      expect(after?.paymentMsgChatId).toBeNull();
      expect(after?.paymentMsgId).toBeNull();
    });

    it("still tells a delivered product sale its items are on the way, with the product keyboard", async () => {
      const created = await makeTokopayOrder();
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
      const created = await makeTokopayOrder();
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

// TokoPay's own per-rail bubble sweep (`sweepDeliveredAwaitingEdit`,
// including its "flips once then no-op" and black-holed-bubble-edit bound
// tests) was removed in Task T2-F: the generic paid-order bubble sweeper
// (`sweepPaidOrderBubbles`, apps/order-bot/src/jobs/index.ts, Task T2-E)
// replaced it, and its own test suite (apps/order-bot/test/jobs.test.ts,
// `describe("sweepPaidOrderBubbles")`) already covers the identical
// flip-once/no-op behavior and the identical black-holed-bubble-edit/
// whole-sweep-budget bounds for every rail including TokoPay — see
// jobs.test.ts's `it.each(matrix)` and its
// "safety bounds against a black-holed bubble edit" describe block. Moving
// these tests there instead of deleting them would have duplicated that
// coverage.

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

// A gateway HTTP 429 arms this rail's backoff gate (pollBackoff.ts, one poll
// interval doubling to a 30s cap), the same one binanceInternal.ts and the
// Bybit rails use. The gate lives at module scope, so it outlives a single
// test: every test here drives `Date.now()` from a frozen clock (no flakiness
// under a slow suite) and ends on a clean cycle that clears the gate, so no
// other test inherits a skipped cycle.
describe("pollOnce rate-limit backoff (HTTP 429)", () => {
  // The gate's base window is one full poll interval (tokopayReconcile.ts).
  const baseMs = config.POLL_INTERVAL_SECONDS * 1000;
  let clock: number;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clock = Date.now();
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  const rateLimited = () => Promise.resolve({ ok: false, status: 429, json: async () => ({}) });
  const unpaid = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "success", data: { status: "Unpaid" } }) });

  it("a 429 makes the next cycle skip without a gateway call, and a clean cycle afterwards resets the backoff", async () => {
    await seedTokopayCreds();
    await makeTokopayOrder();
    const start = clock;
    const fetchMock = vi.fn(rateLimited);
    vi.stubGlobal("fetch", fetchMock);

    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Still a failed gateway call as far as the heartbeat is concerned.
    const afterHit = await getPollHealth(prisma, "tokopay");
    expect(afterHit.consecutiveFailures).toBe(1);

    clock = start + baseMs - 1; // just short of the next poll tick — still inside the base window
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(1); // skipped: the gateway was never called
    expect((await getPollHealth(prisma, "tokopay")).lastRun).toEqual(afterHit.lastRun); // and no heartbeat written

    clock = start + 60_000; // well past the window
    fetchMock.mockImplementation(unpaid);
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Proof the clean cycle RESET the gate rather than just outliving it: a
    // fresh 429 must arm the base window (hit #1) again, not the doubled one a
    // second consecutive hit would get — so a poll 1s past the base window
    // goes through.
    fetchMock.mockImplementation(rateLimited);
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    clock = start + 60_000 + baseMs + 1_000;
    fetchMock.mockImplementation(unpaid);
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(4); // also leaves the gate clear for later tests
  });

  it("keeps the backoff armed when one order in a batch was rate-limited even though a later one got through", async () => {
    await seedTokopayCreds();
    await makeTokopayOrder();
    await makeTokopayOrder();
    const start = clock;
    let call = 0;
    const fetchMock = vi.fn(() => (++call === 1 ? rateLimited() : unpaid()));
    vi.stubGlobal("fetch", fetchMock);

    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // One answered call is not an outage — heartbeat semantics are unchanged.
    expect((await getPollHealth(prisma, "tokopay")).consecutiveFailures).toBe(0);

    clock = start + 1_000; // inside the base window the first order's 429 armed
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2); // skipped — the later success did not wipe the 429

    clock = start + 60_000;
    await pollOnce(fakeApi()); // clean cycle — clears the gate for later tests
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not back off on a non-429 gateway error", async () => {
    await seedTokopayCreds();
    await makeTokopayOrder();
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);

    await pollOnce(fakeApi());
    await pollOnce(fakeApi()); // same instant — would be skipped if a 500 had armed the gate
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
