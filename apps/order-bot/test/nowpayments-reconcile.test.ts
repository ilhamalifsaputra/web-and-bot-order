// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createOrderDirect,
  createWalletTopupOrder,
  finalizeOrderPayment,
  listPendingNowpaymentsOrders,
  setOrderPaymentMessage,
  updateDenomination,
  setSetting,
  bulkAddStock,
  getPollHealth,
} from "@app/db";
import type { Api } from "grammy";
import { OrderStatus, OrderCurrency, PaymentMethod, DeliveryType, NotificationEvent } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { registerOutboxNudge } from "@app/core/nudge";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { telegramError } from "./helpers/ctx";
import { reconcileOrder, pollOnce, MAX_ORDERS_PER_CYCLE } from "../src/payments/nowpaymentsReconcile";
import { NOWPAYMENTS_API_KEY_KEY, NOWPAYMENTS_IPN_SECRET_KEY } from "@app/core/payments/nowpayments";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedNowpaymentsTx.deleteMany(); // new table, not covered by resetDb
  sample = await buildSampleData(prisma);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const CREDS = { apiKey: "ak", ipnSecret: "secret", payCurrency: "usdttrc20", minAmount: null };

/** `editMessageCaption` is still on the double even though nothing should
 *  ever call it — the QRIS rails' own fakeApi carries the identical comment:
 *  this rail used to have no bubble-flip call at all (Task E3 gives it one,
 *  through the same `editPaymentBubble`/`editMessageText` path the QRIS
 *  rails use), so a test that finds it called is finding a regression back
 *  toward the caption-edit bug those rails already fixed. */
const REPLACEMENT_MSG_ID = 90211;
const fakeApi = (
  overrides: Partial<{ editMessageText: unknown; deleteMessage: unknown; sendMessage: unknown }> = {},
) =>
  ({
    sendMessage: overrides.sendMessage ?? vi.fn().mockResolvedValue({ message_id: REPLACEMENT_MSG_ID }),
    editMessageCaption: vi.fn().mockResolvedValue(undefined),
    editMessageText: overrides.editMessageText ?? vi.fn().mockResolvedValue(undefined),
    deleteMessage: overrides.deleteMessage ?? vi.fn().mockResolvedValue(true),
  }) as unknown as Api;

/** Telegram's answer to `editMessageText` on a PHOTO message — the one signal
 *  that says "this bubble carries a QR image, not text". */
const noTextToEdit = () => telegramError(400, "Bad Request: there is no text in the message to edit");

/** Stub the gateway's GET /v1/invoice/{id} status call. */
function stubStatus(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }),
  );
}

/** Create a pending NOWPAYMENTS order with a cached invoice id in paymentRef
 * (the same tagged-JSON convention TokoPay/PayDisini use — see
 * apps/storefront/src/routes/checkout.ts `CachedGateway` and
 * nowpaymentsReconcile.ts's `extractInvoiceId`). */
async function makeNowpaymentsOrder(invoiceId = "INV-1") {
  const created = await prisma.$transaction(async (tx) => {
    const o = await createOrderDirect(tx, {
      user: { id: sample.user.id, role: sample.user.role },
      productId: sample.product.id,
      quantity: 1,
    });
    return finalizeOrderPayment(tx, o!.id, {
      currency: OrderCurrency.USDT,
      rate: "16000",
      method: PaymentMethod.NOWPAYMENTS,
    });
  });
  await prisma.order.update({
    where: { id: created!.id },
    data: { paymentRef: JSON.stringify({ gateway: "nowpayments", invoiceId }) },
  });
  return created!;
}

/** A pending NOWPAYMENTS order that never got a hosted invoice created —
 * `paymentRef` stays whatever finalizeOrderPayment left it (null/unrelated),
 * so `extractInvoiceId` returns null and `reconcileOrder` skips it without a
 * gateway call. Mirrors the checkout.ts outage shape (module doc-comment
 * `INVOICE ID` section): a buyer who checks out WHILE the gateway is down
 * never gets an invoice cached at all. */
async function makeNowpaymentsOrderWithoutInvoice() {
  const created = await prisma.$transaction(async (tx) => {
    const o = await createOrderDirect(tx, {
      user: { id: sample.user.id, role: sample.user.role },
      productId: sample.product.id,
      quantity: 1,
    });
    return finalizeOrderPayment(tx, o!.id, {
      currency: OrderCurrency.USDT,
      rate: "16000",
      method: PaymentMethod.NOWPAYMENTS,
    });
  });
  return created!;
}

describe("reconcileOrder (NOWPayments poller safety net)", () => {
  it('delivers a pending NOWPAYMENTS order when the gateway reports "finished"', async () => {
    const created = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    expect(pending).toBeDefined();
    stubStatus({ payment_status: "finished", payment_id: "TRX-RC", actually_paid: pending!.totalAmount.toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created.id } });
    expect(after?.status).toBe(OrderStatus.DELIVERED);
    const tx = await prisma.processedNowpaymentsTx.findFirst({ where: { orderId: created.id } });
    expect(tx?.outcome).toBe("matched");
  });

  // This rail's ledger key IS the gateway's `payment_id`, and `verifyIpn`
  // refuses an IPN that carries no usable one rather than inventing a
  // substitute (the M-12 fix). The poller used to invent
  // `reconcile-<orderCode>` instead — a UNIQUE row the webhook could never
  // collide with, so one payment confirmed from both directions produced two
  // rows. Unlike TokoPay/PayDisini there is no order-scoped fallback that
  // converges the two paths here, because the webhook has no fallback at all,
  // so the poller matches its strictness.
  it('refuses to deliver a "finished" payment the gateway reports without a payment_id, instead of inventing a ledger key', async () => {
    const created = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus({ payment_status: "finished", actually_paid: pending!.totalAmount.toString() }); // no payment_id

    const outcome = await reconcileOrder(fakeApi(), CREDS, pending!);

    // The gateway DID answer, so this is not evidence of an outage.
    expect(outcome).toBe("ok");
    // Nothing was claimed under any key — synthetic or otherwise.
    expect(await prisma.processedNowpaymentsTx.count()).toBe(0);
    // And the order is left for the IPN webhook (or a later cycle) to settle.
    const after = await prisma.order.findUnique({ where: { id: created.id } });
    expect(after?.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  // Task E5 item 4: refusing to deliver is right, but its cost is that if the
  // IPN never arrives either, this order auto-cancels with the buyer already
  // charged. These pin that the refusal is never silent, and that saying so
  // repeatedly does not turn into a per-cycle DM storm.
  it("alerts every admin once when it refuses, so a human can settle the order before it auto-cancels", async () => {
    const created = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus({ payment_status: "finished", actually_paid: pending!.totalAmount.toString() }); // no payment_id

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.ADMIN_UNCONFIRMABLE_PAYMENT, orderId: created.id },
    });
    expect(rows.length).toBeGreaterThan(0);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.order_code).toBe(created.orderCode);
    expect(payload.gateway).toBe("NOWPayments");
    // One row per admin, each keyed by (order, admin) — an order-only key
    // would have let the first admin's row swallow all the others.
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(rows.length);
  });

  it("does not re-alert on later cycles, however many times it re-enters that branch", async () => {
    const created = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus({ payment_status: "finished", actually_paid: pending!.totalAmount.toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);
    const afterFirst = await prisma.notificationOutbox.count({
      where: { event: NotificationEvent.ADMIN_UNCONFIRMABLE_PAYMENT, orderId: created.id },
    });

    await reconcileOrder(fakeApi(), CREDS, pending!);
    await reconcileOrder(fakeApi(), CREDS, pending!);

    const afterThree = await prisma.notificationOutbox.count({
      where: { event: NotificationEvent.ADMIN_UNCONFIRMABLE_PAYMENT, orderId: created.id },
    });
    expect(afterThree).toBe(afterFirst);
  });

  it('leaves the order pending on in-flight statuses ("waiting"/"confirming")', async () => {
    await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());

    stubStatus({ payment_status: "waiting" });
    await reconcileOrder(fakeApi(), CREDS, pending!);
    let [stillPending] = await listPendingNowpaymentsOrders(prisma, new Date());
    expect(stillPending).toBeDefined();

    stubStatus({ payment_status: "confirming" });
    await reconcileOrder(fakeApi(), CREDS, pending!);
    [stillPending] = await listPendingNowpaymentsOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
  });

  it('never delivers on "partially_paid" — exact-match on "finished" only, not an allowlist', async () => {
    await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    // Even if the reported amount looks sufficient, a non-"finished" status
    // must never trigger delivery — partially_paid is terminal-but-not-success.
    stubStatus({ payment_status: "partially_paid", payment_id: "TRX-PARTIAL", actually_paid: pending!.totalAmount.toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const [stillPending] = await listPendingNowpaymentsOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
    const tx = await prisma.processedNowpaymentsTx.findFirst({ where: { orderId: pending!.id } });
    expect(tx).toBeNull();
  });

  it("never delivers on an underpayment (finished but short), flags the order UNDERPAID, and alerts admins", async () => {
    const created = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus({ payment_status: "finished", payment_id: "TRX-SHORT", actually_paid: pending!.totalAmount.minus(1).toString() });
    const api = fakeApi();

    await reconcileOrder(api, CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created!.id } });
    expect(after?.status).toBe(OrderStatus.UNDERPAID);
    // ADMIN_IDS = "999,1000" in test setup — one alert per admin.
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const [, text] = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(text)).toMatch(/[Uu]nderpaid/);
    expect(String(text)).toContain(created!.orderCode);
    expect(String(text)).toContain("NOWPayments");
  });

  // The poller re-checks the same order.id every cycle — the order's own
  // status IS the idempotency guard (no separate ledger table needed, unlike
  // the crypto rails). A second cycle before a human resolves the order must
  // be a silent no-op: no double alert, no throw.
  it("does not alert a second time when an already-UNDERPAID order is reconciled again", async () => {
    await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus({ payment_status: "finished", payment_id: "TRX-SHORT-2", actually_paid: pending!.totalAmount.minus(1).toString() });
    const api = fakeApi();

    await reconcileOrder(api, CREDS, pending!);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);

    await expect(reconcileOrder(api, CREDS, pending!)).resolves.toBe("ok");
    expect(api.sendMessage).toHaveBeenCalledTimes(2); // no additional alert on the second cycle
  });
});

/**
 * Task E3: this rail never flipped its own anchored payment bubble at all
 * before this task — a delivered order's bubble sat stale until the generic
 * `sweepPaidOrderBubbles` cron sweep next ticked (up to ~60s later). These
 * tests mirror tokopay-reconcile.test.ts's own "the success bubble a settled
 * order is flipped to" suite (same shared `editPaymentBubble`/
 * `settledPaymentBubble` mapping, via the shared `flipSettledOrderBubble`,
 * jobs/index.ts), proving this rail now flips immediately like TokoPay/
 * PayDisini instead of waiting on the sweep.
 */
describe("reconcileOrder flips the settled payment bubble (Task E3)", () => {
  /** Deliver the one pending order with its bubble anchored at (555, 777). */
  async function deliverAnchored(api: Api, trxId: string) {
    const created = await makeNowpaymentsOrder();
    await setOrderPaymentMessage(prisma, created.id, 555, 777);
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus({ payment_status: "finished", payment_id: trxId, actually_paid: pending!.totalAmount.toString() });

    await reconcileOrder(api, CREDS, pending!);

    return prisma.order.findUnique({ where: { id: created.id } });
  }

  // Task E9 follow-up (I-1): the flip-before-nudge ORACLE for this rail.
  // `nudgeOutboxDispatcher()` is otherwise unobserved here, so this rail could
  // silently revert to `nudge(); flip();` — the reported credential-before-
  // confirmation ordering — with the whole suite still green. The dispatcher's
  // flush hook makes such a regression cosmetic in the combined server, but
  // the standalone order-bot binary registers no flush hook at all, so there
  // it is fully user-visible.
  it("flips the bubble BEFORE nudging the outbox dispatcher", async () => {
    const sequence: string[] = [];
    registerOutboxNudge(() => sequence.push("nudge"));
    const api = {
      sendMessage: vi.fn(async () => {
        sequence.push("bubble");
        return { message_id: 90210 };
      }),
      editMessageCaption: vi.fn(async () => undefined),
      editMessageText: vi.fn(async () => {
        sequence.push("bubble");
      }),
      deleteMessage: vi.fn(async () => {
        sequence.push("bubble");
        return true;
      }),
    } as unknown as Api;

    await deliverAnchored(api, "TRX-ORDERING");

    // Both must have happened — a pass because neither ran is worthless.
    expect(sequence).toContain("bubble");
    expect(sequence).toContain("nudge");
    // `lastIndexOf`, not the first: a photo bubble is a delete AND a send, and
    // the DM must not be triggered while the replacement is still in flight.
    expect(sequence.lastIndexOf("bubble")).toBeLessThan(sequence.indexOf("nudge"));
    registerOutboxNudge(null);
  });

  it("immediately flips an anchored TEXT bubble to success in place when it delivers the order", async () => {
    const api = fakeApi();

    const after = await deliverAnchored(api, "TRX-E3-FLIP");

    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, msgId, , payload] = (api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chatId).toBe(555);
    expect(msgId).toBe(777);
    expect(payload.reply_markup.inline_keyboard.flat().map((b: { callback_data?: string }) => b.callback_data)).toContain("v1:order:list");
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(after?.paymentMsgChatId).toBeNull();
    expect(after?.paymentMsgId).toBeNull();
  });

  it("replaces an anchored PHOTO (QR) bubble with a fresh message instead of leaving the QR image behind", async () => {
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(noTextToEdit()) });

    const after = await deliverAnchored(api, "TRX-E3-PHOTO");

    expect(api.deleteMessage).toHaveBeenCalledWith(555, 777);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(after?.paymentMsgChatId).toBeNull();
    expect(after?.paymentMsgId).toBeNull();
  });

  it("also flips the bubble for a manual-fulfilment order queued as PROCESSING", async () => {
    await updateDenomination(prisma, sample.product.id, { deliveryType: DeliveryType.MANUAL });
    const api = fakeApi();

    const after = await deliverAnchored(api, "TRX-E3-PROCESSING");

    expect(after?.status).toBe(OrderStatus.PROCESSING);
    const [, , , payload] = (api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(payload.reply_markup.inline_keyboard.flat().map((b: { callback_data?: string }) => b.callback_data)).toContain("v1:order:list");
    expect(after?.paymentMsgChatId).toBeNull();
  });

  it("keeps the anchor when the bubble flip is flood-controlled, so the paid-order bubble sweep retries it", async () => {
    const api = fakeApi({
      editMessageText: vi.fn().mockRejectedValue(telegramError(429, "Too Many Requests: retry after 30")),
      deleteMessage: vi.fn().mockRejectedValue(telegramError(429, "Too Many Requests: retry after 30")),
    });

    const after = await deliverAnchored(api, "TRX-E3-FLOOD");

    expect(after?.status).toBe(OrderStatus.DELIVERED); // delivery itself is unaffected by a bubble problem
    expect(after?.paymentMsgChatId).not.toBeNull();
    expect(after?.paymentMsgId).not.toBeNull();
  });

  it("words a settled wallet top-up as a neutral 'payment received' status and deletes a photo (QR) bubble with no replacement", async () => {
    const STARTING_USDT = "10";
    const TOPUP_USDT = "5";
    await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalanceUsdt: STARTING_USDT } });
    const topup = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: sample.user.id,
        amount: TOPUP_USDT,
        currency: "USDT",
        method: PaymentMethod.NOWPAYMENTS,
        rate: "16000",
      }),
    );
    // finalizeWalletTopupPayment's NOWPAYMENTS branch stamps expiresAt/
    // paymentMethod but not paymentRef — no live invoice call is made by
    // this test util (that only happens in real checkout, over HTTP). Stamp
    // the same tagged-JSON `extractInvoiceId` reads, mirroring
    // makeNowpaymentsOrder above.
    await prisma.order.update({
      where: { id: topup.id },
      data: { paymentRef: JSON.stringify({ gateway: "nowpayments", invoiceId: "INV-E3-TOPUP" }) },
    });
    await setOrderPaymentMessage(prisma, topup.id, 555, 888);
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(noTextToEdit()) });
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus({ payment_status: "finished", payment_id: "TRX-E3-TOPUP", actually_paid: pending!.totalAmount.toString() });

    await reconcileOrder(api, CREDS, pending!);

    expect(api.deleteMessage).toHaveBeenCalledWith(555, 888);
    expect(api.sendMessage).not.toHaveBeenCalled(); // no replacement — the outbox WALLET_TOPUP_CREDITED_DM already told the buyer
    const after = await prisma.order.findUnique({ where: { id: topup.id } });
    expect(after?.paymentMsgChatId).toBeNull();
    expect(after?.paymentMsgId).toBeNull();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalanceUsdt).toString()).toBe("15");
  });
});

async function seedNowpaymentsCreds() {
  await setSetting(prisma, NOWPAYMENTS_API_KEY_KEY, "ak");
  await setSetting(prisma, NOWPAYMENTS_IPN_SECRET_KEY, "secret");
}

describe("pollOnce (heartbeat + bounded cycle — Task 11)", () => {
  it("records a heartbeat even when there are no pending orders to reconcile", async () => {
    await seedNowpaymentsCreds();

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "nowpayments");
    expect(health.lastRun).not.toBeNull();
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.lastTxCount).toBe(0);
  });

  it("does not record a heartbeat when the rail has no credentials configured", async () => {
    // No seedNowpaymentsCreds() call — the rail is genuinely off.
    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "nowpayments");
    expect(health.lastRun).toBeNull();
  });

  it("records a failed heartbeat when every gateway status call in the cycle fails", async () => {
    await seedNowpaymentsCreds();
    await makeNowpaymentsOrder("INV-1");
    await makeNowpaymentsOrder("INV-2");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "nowpayments");
    expect(health.lastSuccessAt).toBeNull();
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBeTruthy();
  });

  // Task 11 review follow-up, Critical #1: reconcileOrder returns "ok" (not
  // "gateway_error") for an invoice-less order — no gateway call was even
  // made. Before the fix, pollOnce's outage check divided by orders.length,
  // so this invoice-less order inflated the denominator and the cycle read
  // as healthy even though every ACTUAL gateway call failed — exactly the
  // outage-during-checkout shape the module doc-comment describes: an
  // outage stops both invoice creation (new orders arrive invoice-less) and
  // existing invoices' status checks (those fail) at the same time.
  it("an invoice-less order must not dilute the all-failed outage check — the cycle stays unhealthy", async () => {
    await seedNowpaymentsCreds();
    await makeNowpaymentsOrderWithoutInvoice(); // no gateway call possible for this one
    await makeNowpaymentsOrder("INV-1");
    await makeNowpaymentsOrder("INV-2");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "nowpayments");
    expect(health.lastSuccessAt).toBeNull();
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBeTruthy();
  });

  it("leaves the cycle healthy when only some gateway status calls fail (one flaky order is not an outage)", async () => {
    await seedNowpaymentsCreds();
    await makeNowpaymentsOrder("INV-1");
    await makeNowpaymentsOrder("INV-2");
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) return Promise.reject(new Error("transient"));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ payment_status: "waiting" }) });
      }),
    );

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "nowpayments");
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.consecutiveFailures).toBe(0);
  });

  it("checks at most MAX_ORDERS_PER_CYCLE orders in one cycle", async () => {
    await seedNowpaymentsCreds();
    const extraCreds = Array.from({ length: MAX_ORDERS_PER_CYCLE + 5 }, (_, i) => `stock-extra-${i}`);
    await bulkAddStock(prisma, sample.product.id, extraCreds);
    for (let i = 0; i < MAX_ORDERS_PER_CYCLE + 3; i++) await makeNowpaymentsOrder(`INV-${i}`);
    stubStatus({ payment_status: "waiting" });
    const fetchMock = vi.mocked(globalThis.fetch);

    await pollOnce(fakeApi());

    expect(fetchMock).toHaveBeenCalledTimes(MAX_ORDERS_PER_CYCLE);
    const health = await getPollHealth(prisma, "nowpayments");
    expect(health.lastTxCount).toBe(MAX_ORDERS_PER_CYCLE);
  });

  // followup-review-fixes-2: MAX_ORDERS_PER_CYCLE used to always cap the same
  // oldest-first slice (listPendingNowpaymentsOrders' own ordering) — a
  // backlog over the cap left orders 51+ unchecked by this safety net until
  // enough older ones expired out. The rotating cursor (rotatingCursor.ts)
  // instead rotates which slice gets checked, so the SAME backlog gets full
  // coverage across a couple of cycles instead of the tail starving
  // indefinitely.
  it("rotates which orders are checked across cycles, covering the whole backlog instead of always the same oldest N", async () => {
    await seedNowpaymentsCreds();
    const total = MAX_ORDERS_PER_CYCLE + 3;
    const extraCreds = Array.from({ length: total + 2 }, (_, i) => `stock-extra-rot-${i}`);
    await bulkAddStock(prisma, sample.product.id, extraCreds);
    for (let i = 0; i < total; i++) await makeNowpaymentsOrder(`INV-ROT-${i}`);

    const seenInvoiceIds = new Set<string>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const match = /\/v1\/invoice\/([^/?]+)/.exec(url);
        if (match?.[1]) seenInvoiceIds.add(decodeURIComponent(match[1]));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ payment_status: "waiting" }) });
      }),
    );

    await pollOnce(fakeApi());
    expect(seenInvoiceIds.size).toBe(MAX_ORDERS_PER_CYCLE); // never all `total` in one cycle

    await pollOnce(fakeApi()); // the rotating window's next slice picks up the rest
    expect(seenInvoiceIds.size).toBe(total); // full coverage within 2 cycles, no starved tail
  });
});
