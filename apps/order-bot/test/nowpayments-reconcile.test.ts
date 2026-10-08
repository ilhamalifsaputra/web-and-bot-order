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
  adoptTransactionMessage,
  updateDenomination,
  setSetting,
  bulkAddStock,
  getPollHealth,
  triggerDigiflazzDispatch,
} from "@app/db";
import { routeOrderToDigiflazz } from "../../../tests/helpers/digiflazzRouting";

// The instant Digiflazz dispatch is observed, not run: these tests check that the
// poller starts it for a PROCESSING settlement, not what Digiflazz answers.
vi.mock("@app/db", async (orig) => ({
  ...(await orig<typeof import("@app/db")>()),
  triggerDigiflazzDispatch: vi.fn(),
}));
import type { Api } from "grammy";
import { OrderStatus, OrderCurrency, PaymentMethod, DeliveryType, NotificationEvent } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { registerOutboxNudge } from "@app/core/nudge";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { telegramError } from "./helpers/ctx";
import { reconcileOrder, pollOnce, MAX_ORDERS_PER_CYCLE } from "../src/payments/nowpaymentsReconcile";
import { NOWPAYMENTS_API_KEY_KEY, NOWPAYMENTS_IPN_SECRET_KEY, nowpaymentsInvoicePrice } from "@app/core/payments/nowpayments";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedNowpaymentsTx.deleteMany(); // new table, not covered by resetDb
  sample = await buildSampleData(prisma);
  vi.mocked(triggerDigiflazzDispatch).mockReset();
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

/** A "finished" status body for `total` paid in a NON-USDT coin. Task B fix
 *  round: actually_paid/pay_amount are in the PAY currency (here BNB, worth
 *  far more than a dollar, so the coin figure is numerically far below the
 *  USDT total), and the value is judged through price_amount/price_currency
 *  — the invoice's own usd price, exactly what createInvoice sends. */
function finishedStatus(total: Decimal.Value, extra: Record<string, unknown> = {}) {
  return {
    payment_status: "finished",
    price_amount: nowpaymentsInvoicePrice(total).toFixed(2),
    price_currency: "usd",
    pay_amount: "0.0125",
    actually_paid: "0.0125",
    pay_currency: "bnbbsc",
    ...extra,
  };
}

/** Create a pending NOWPAYMENTS order with a cached invoice id in paymentRef
 * (the same tagged-JSON convention TokoPay/PayDisini use — see
 * apps/storefront/src/routes/checkout.ts `CachedGateway` and
 * nowpaymentsReconcile.ts's `extractInvoiceId`). */
async function makeNowpaymentsOrder(invoiceId = "INV-1") {
  const created = await prisma.$transaction(async (tx) => {
    // M11: the shared fixture SKU costs Rp5, which converts to 0.0 USDT at the
    // 16000 rate below — finalizeOrderPayment now refuses to put a
    // nothing-to-collect total on a gateway. Price it realistically; every
    // amount this file asserts on is derived from the order's own totalAmount,
    // never from a hard-coded figure.
    await tx.denomination.update({ where: { id: sample.product.id }, data: { price: "80000" } });
    const o = await createOrderDirect(tx, { channel: "bot",
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
    // Same M11 fixture pricing as makeNowpaymentsOrder above — see its comment.
    await tx.denomination.update({ where: { id: sample.product.id }, data: { price: "80000" } });
    const o = await createOrderDirect(tx, { channel: "bot",
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
    stubStatus(finishedStatus(pending!.totalAmount, { payment_id: "TRX-RC" }));

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
    stubStatus(finishedStatus(pending!.totalAmount)); // no payment_id

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
    stubStatus(finishedStatus(pending!.totalAmount)); // no payment_id

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
    stubStatus(finishedStatus(pending!.totalAmount));

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

  it("records trusted partially_paid evidence once and never fulfills it", async () => {
    const order = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus(finishedStatus(pending!.totalAmount, { payment_status: "partially_paid", payment_id: "TRX-PARTIAL-VALUED", actually_paid: "0.00625", order_id: order.orderCode }));
    await reconcileOrder(fakeApi(), CREDS, pending!);
    await reconcileOrder(fakeApi(), CREDS, pending!);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe(OrderStatus.UNDERPAID);
    expect(after.paymentState).toBe("UNDERPAID");
    expect(after.paidAt).toBeNull();
    expect(await prisma.qrisUnderpaidTx.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.processedNowpaymentsTx.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("refuses an authenticated invoice response carrying another order's ownership", async () => {
    const order = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus(finishedStatus(pending!.totalAmount, { payment_id: "TRX-WRONG-ORDER", order_id: "ANOTHER-ORDER" }));
    await reconcileOrder(fakeApi(), CREDS, pending!);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await prisma.processedNowpaymentsTx.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("never delivers on an underpayment (finished but short), flags the order UNDERPAID, and alerts admins", async () => {
    const created = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus(finishedStatus(pending!.totalAmount, { payment_id: "TRX-SHORT", actually_paid: "0.01" })); // 0.01 of the quoted 0.0125 BNB
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
    stubStatus(finishedStatus(pending!.totalAmount, { payment_id: "TRX-SHORT-2", actually_paid: "0.01" }));
    const api = fakeApi();

    await reconcileOrder(api, CREDS, pending!);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);

    await expect(reconcileOrder(api, CREDS, pending!)).resolves.toBe("ok");
    expect(api.sendMessage).toHaveBeenCalledTimes(2); // no additional alert on the second cycle
  });
  // Task B fix round: the poller compared actually_paid (PAY-currency coins)
  // with the USDT order total, the same unit error B3a fixed in the IPN
  // webhook. A coin worth more than a dollar made every full payment look
  // short (marked UNDERPAID); one worth less than a dollar let a short payment
  // through. Both now go through checkNowpaymentsAmount.
  it("delivers a full payment made in a coin worth more than a dollar (actually_paid numerically below the USDT total)", async () => {
    const created = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    expect(new Decimal("0.0125").lessThan(pending!.totalAmount)).toBe(true); // the old comparison's trap
    stubStatus(finishedStatus(pending!.totalAmount, { payment_id: "TRX-BNB" }));

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created.id } });
    expect(after?.status).toBe(OrderStatus.DELIVERED);
    const tx = await prisma.processedNowpaymentsTx.findFirst({ where: { orderId: created.id } });
    expect(tx?.outcome).toBe("matched");
    // Recorded in the order's own currency, not as 0.0125 coins.
    expect(tx?.amount?.toString()).toBe(new Decimal(pending!.totalAmount).toString());
  });

  it("flags UNDERPAID (in USDT) a short payment in a coin worth less than a dollar, which the old comparison delivered", async () => {
    const created = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    const total = new Decimal(pending!.totalAmount);
    const quote = total.times(10); // 10 coins per dollar
    const paid = quote.times("0.4"); // 40% of the quote, still numerically above the USDT total
    expect(paid.greaterThan(total)).toBe(true);
    stubStatus(finishedStatus(total, { payment_id: "TRX-TRX", pay_currency: "trx", pay_amount: quote.toString(), actually_paid: paid.toString() }));

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created.id } });
    expect(after?.status).toBe(OrderStatus.UNDERPAID);
    const underpaid = await prisma.qrisUnderpaidTx.findFirst({ where: { orderId: created.id } });
    expect(underpaid?.receivedAmount.toString()).toBe(total.times("0.4").toString());
    expect(await prisma.processedNowpaymentsTx.count()).toBe(0);
  });

  it("never delivers or flags UNDERPAID when the status carries no usd price to judge the value by, and alerts admins once instead", async () => {
    const created = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus({ payment_status: "finished", payment_id: "TRX-NOPRICE", actually_paid: "999", pay_amount: "999" });

    await reconcileOrder(fakeApi(), CREDS, pending!);
    await reconcileOrder(fakeApi(), CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created.id } });
    expect(after?.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await prisma.processedNowpaymentsTx.count()).toBe(0);
    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.ADMIN_UNCONFIRMABLE_PAYMENT, orderId: created.id },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(rows.length); // once per admin, across both cycles
    expect((JSON.parse(rows[0]!.payloadJson) as { reason?: string }).reason).toBe("unverified_amount");
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
describe("reconcileOrder delegates payment bubbles to their durable coordinator", () => {
  async function deliverAnchored(api: Api, trxId: string) {
    const created = await makeNowpaymentsOrder();
    await prisma.$transaction(async (tx) => {
      await adoptTransactionMessage(tx, created.id, 555, 777);
      await setOrderPaymentMessage(tx, created.id, 555, 777);
    });
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus(finishedStatus(pending!.totalAmount, { payment_id: trxId }));
    await reconcileOrder(api, CREDS, pending!);
    return prisma.order.findUniqueOrThrow({ where: { id: created.id } });
  }

  async function expectOwned(orderId: number, messageId = 777) {
    const row = await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId } });
    expect(row.chatId).toBe(555n);
    expect(row.messageId).toBe(messageId);
    expect(row.state).toBe("ACTIVE");
    expect(await prisma.fulfillmentMessage.count({ where: { orderId } })).toBe(1);
  }

  it("commits the canonical update before nudging and avoids racing the worker", async () => {
    const sequence: string[] = [];
    registerOutboxNudge(() => sequence.push("nudge"));
    try {
      const api = fakeApi();
      const after = await deliverAnchored(api, "TRX-ORDERING");
      expect(sequence).toContain("nudge");
      await expectOwned(after.id);
      expect(api.editMessageText).not.toHaveBeenCalled();
      expect(api.deleteMessage).not.toHaveBeenCalled();
      expect(api.sendMessage).not.toHaveBeenCalled();
    } finally { registerOutboxNudge(null); }
  });

  it("preserves a text anchor on stock completion for the worker's final edit", async () => {
    const api = fakeApi();
    const after = await deliverAnchored(api, "TRX-E3-FLIP");
    expect(after.status).toBe(OrderStatus.DELIVERED);
    expect(after.paymentMsgChatId).toBe(555n);
    expect(after.paymentMsgId).toBe(777);
    await expectOwned(after.id);
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(triggerDigiflazzDispatch).not.toHaveBeenCalled();
  });

  it("preserves a QR photo ID so the coordinator can edit its caption", async () => {
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(noTextToEdit()) });
    const after = await deliverAnchored(api, "TRX-E3-PHOTO");
    await expectOwned(after.id);
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("wakes the same anchor for a static manual queue without a direct bubble edit", async () => {
    await updateDenomination(prisma, sample.product.id, { deliveryType: DeliveryType.MANUAL });
    const api = fakeApi();
    const after = await deliverAnchored(api, "TRX-E3-PROCESSING");
    expect(after.status).toBe(OrderStatus.PROCESSING);
    await expectOwned(after.id);
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("credits a wallet once and preserves its canonical message for completion", async () => {
    await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalanceUsdt: "10" } });
    const topup = await prisma.$transaction((tx) => createWalletTopupOrder(tx, {
      userId: sample.user.id, amount: "5", currency: "USDT", method: PaymentMethod.NOWPAYMENTS, rate: "16000",
    }));
    await prisma.order.update({ where: { id: topup.id }, data: { paymentRef: JSON.stringify({ gateway: "nowpayments", invoiceId: "INV-E3-TOPUP" }) } });
    await prisma.$transaction(async (tx) => {
      await adoptTransactionMessage(tx, topup.id, 555, 888);
      await setOrderPaymentMessage(tx, topup.id, 555, 888);
    });
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(noTextToEdit()) });
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus(finishedStatus(pending!.totalAmount, { payment_id: "TRX-E3-TOPUP" }));
    await reconcileOrder(api, CREDS, pending!);
    await reconcileOrder(api, CREDS, pending!);
    await expectOwned(topup.id, 888);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: topup.id } });
    expect(after.paymentState).toBe("PAID");
    expect(after.walletCreditState).toBe("CREDITED");
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalanceUsdt).toString()).toBe("15");
  });

  it("starts automatic Digiflazz dispatch once while leaving message updates to the coordinator", async () => {
    const created = await makeNowpaymentsOrder();
    await routeOrderToDigiflazz(prisma, created.id);
    await prisma.$transaction(async (tx) => {
      await adoptTransactionMessage(tx, created.id, 555, 777);
      await setOrderPaymentMessage(tx, created.id, 555, 777);
    });
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    stubStatus(finishedStatus(pending!.totalAmount, { payment_id: "TRX-DIGIFLAZZ" }));
    const api = fakeApi();
    await reconcileOrder(api, CREDS, pending!);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: created.id } })).status).toBe(OrderStatus.PROCESSING);
    expect(triggerDigiflazzDispatch).toHaveBeenCalledTimes(1);
    expect(triggerDigiflazzDispatch).toHaveBeenCalledWith(created.id);
    await expectOwned(created.id);
    expect(api.editMessageText).not.toHaveBeenCalled();
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

// A gateway HTTP 429 arms this rail's backoff gate (pollBackoff.ts, one poll
// interval doubling to a 30s cap) — same shape as tokopay-reconcile.test.ts's
// own block. The gate lives at module scope, so every test here drives
// `Date.now()` from a frozen clock and ends on a clean cycle that clears the
// gate for later tests.
describe("pollOnce rate-limit backoff (HTTP 429)", () => {
  // The gate's base window is one full poll interval (nowpaymentsReconcile.ts).
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
  const waiting = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ payment_status: "waiting" }) });

  it("a 429 makes the next cycle skip without a gateway call, and a clean cycle afterwards resets the backoff", async () => {
    await seedNowpaymentsCreds();
    await makeNowpaymentsOrder("INV-RL");
    const start = clock;
    const fetchMock = vi.fn(rateLimited);
    vi.stubGlobal("fetch", fetchMock);

    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const afterHit = await getPollHealth(prisma, "nowpayments");
    expect(afterHit.consecutiveFailures).toBe(1);

    clock = start + baseMs - 1; // just short of the next poll tick — still inside the base window
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getPollHealth(prisma, "nowpayments")).lastRun).toEqual(afterHit.lastRun);

    clock = start + 60_000;
    fetchMock.mockImplementation(waiting);
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A fresh 429 after the reset arms the base window again (hit #1), not
    // the doubled one a second consecutive hit would get.
    fetchMock.mockImplementation(rateLimited);
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    clock = start + 60_000 + baseMs + 1_000;
    fetchMock.mockImplementation(waiting);
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps the backoff armed when one order in a batch was rate-limited even though a later one got through", async () => {
    await seedNowpaymentsCreds();
    await makeNowpaymentsOrder("INV-RL-1");
    await makeNowpaymentsOrder("INV-RL-2");
    const start = clock;
    let call = 0;
    const fetchMock = vi.fn(() => (++call === 1 ? rateLimited() : waiting()));
    vi.stubGlobal("fetch", fetchMock);

    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await getPollHealth(prisma, "nowpayments")).consecutiveFailures).toBe(0);

    clock = start + 1_000;
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clock = start + 60_000;
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // An invoice-less order makes no gateway call ("skipped"), so a cycle of
  // nothing but those is no evidence the gateway recovered — it must not
  // reset the hit count a real 429 left behind.
  it("an all-skipped (invoice-less) cycle neither arms nor resets the backoff", async () => {
    await seedNowpaymentsCreds();
    await makeNowpaymentsOrderWithoutInvoice();
    const invoiced = await makeNowpaymentsOrder("INV-RL-SKIP");
    const start = clock;
    const fetchMock = vi.fn(rateLimited);
    vi.stubGlobal("fetch", fetchMock);

    await pollOnce(fakeApi()); // hit #1 → base window
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Take the invoiced order out of the pending set, leaving only the
    // invoice-less one: the next cycle makes zero gateway calls.
    await prisma.order.update({ where: { id: invoiced.id }, data: { paymentRef: null } });
    const hit2At = start + baseMs + 1_000; // past hit #1's base window
    clock = hit2At;
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Hit #2 must now arm the doubled window — the skipped cycle did not
    // reset the count — so a poll 1s past a base window later is still skipped.
    await prisma.order.update({
      where: { id: invoiced.id },
      data: { paymentRef: JSON.stringify({ gateway: "nowpayments", invoiceId: "INV-RL-SKIP" }) },
    });
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clock = hit2At + baseMs + 1_000;
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clock = start + 60_000;
    fetchMock.mockImplementation(waiting);
    await pollOnce(fakeApi()); // clean cycle — clears the gate for later tests
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not back off on a non-429 gateway error", async () => {
    await seedNowpaymentsCreds();
    await makeNowpaymentsOrder("INV-RL-500");
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);

    await pollOnce(fakeApi());
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
