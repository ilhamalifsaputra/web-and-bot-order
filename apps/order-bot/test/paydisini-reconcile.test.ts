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
  adoptTransactionMessage,
  setSetting,
  bulkAddStock,
  getPollHealth,
  updateDenomination,
  deliverPaidPaydisiniOrder,
  triggerDigiflazzDispatch,
} from "@app/db";
import { routeOrderToDigiflazz } from "../../../tests/helpers/digiflazzRouting";

// The instant Digiflazz dispatch is observed, not run: these tests check that the
// poller starts it for a PROCESSING settlement, not what Digiflazz answers.
vi.mock("@app/db", async (orig) => ({
  ...(await orig<typeof import("@app/db")>()),
  triggerDigiflazzDispatch: vi.fn(),
}));
import { gatewayLedgerTrxId } from "@app/core/payments/ledgerKey";
import type { Api } from "grammy";
import { DeliveryType, OrderStatus, OrderCurrency, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { registerOutboxNudge } from "@app/core/nudge";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { telegramError } from "./helpers/ctx";
import { onlyBubbleEdit } from "./helpers/settledBubble";
import { FulfillmentMessageWorker, type FulfillmentTelegramApi } from "../../../packages/outbox-dispatcher/src/fulfillmentMessages";
import { reconcileOrder, pollOnce, MAX_ORDERS_PER_CYCLE } from "../src/payments/paydisiniReconcile";
import { PAYDISINI_USERKEY_KEY, PAYDISINI_APIKEY_KEY } from "@app/core/payments/paydisini";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedPaydisiniTx.deleteMany(); // new table, not covered by resetDb
  sample = await buildSampleData(prisma);
  vi.mocked(triggerDigiflazzDispatch).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  registerOutboxNudge(null);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const CREDS = { userKey: "uk", apiKey: "ak", channel: "QRIS", minAmount: null };

/** A different ID makes an accidental replacement detectable. */
const REPLACEMENT_MSG_ID = 90210;

/** The coordinator edits a saved text message or QR caption in place. */
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

/** Telegram identifies a saved photo, whose caption the worker then edits. */
const noTextToEdit = () => telegramError(400, "Bad Request: there is no text in the message to edit");

/** Stub the gateway status call. */
function stubStatus(data: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "success", data }) }),
  );
}

async function makePaydisiniOrder() {
  return prisma.$transaction(async (tx) => {
    const o = await createOrderDirect(tx, { channel: "bot",
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

  // Twin of the TokoPay case (apps/order-bot/test/tokopay-reconcile.test.ts):
  // this poller used to claim `reconcile-<orderCode>` when PayDisini's status
  // response carried no id, a UNIQUE ledger row the storefront webhook can
  // never write. Both paths now derive the key the same way.
  it("keys the ledger on the order code, not a synthetic reconcile- key, when the gateway returns no id", async () => {
    const created = await makePaydisiniOrder();
    const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
    stubStatus({ status: "success", amount: pending!.totalAmount.toString() }); // no unique_code/trx_id

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const rows = await prisma.processedPaydisiniTx.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trxId).toBe(created!.orderCode);
    expect(rows[0]!.outcome).toBe("matched");
  });

  it("makes a later webhook for the same payment collide on the poller's own ledger row", async () => {
    const created = await makePaydisiniOrder();
    const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
    stubStatus({ status: "success", amount: pending!.totalAmount.toString() }); // no unique_code/trx_id

    await reconcileOrder(fakeApi(), CREDS, pending!);

    // Exactly what the storefront's PayDisini route now passes when the live
    // status call comes back without an id of its own.
    const webhook = await deliverPaidPaydisiniOrder(prisma, {
      orderId: created!.id,
      trxId: gatewayLedgerTrxId(null, created!.orderCode),
      amount: pending!.totalAmount,
      shopUrl: null,
    });

    expect(webhook.status).toBe("already_processed");
    expect(await prisma.processedPaydisiniTx.count()).toBe(1);
  });

  // Fix round for Task B: a PAID status without an amount is not proof of
  // payment, so it is never delivered — but it used to vanish entirely (no
  // record, no alert) while the order quietly auto-cancelled. It is now parked
  // in the unmatched manual-review queue and alerts the admins exactly once.
  it("parks a paid status without an amount for manual review, alerts admins once, and never delivers", async () => {
    const created = await makePaydisiniOrder();
    const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
    stubStatus({ status: "Paid", unique_code: "TRX-PD-UNV" }); // no amount at all
    const api = fakeApi();

    await expect(reconcileOrder(api, CREDS, pending!)).resolves.toBe("ok");

    const after = await prisma.order.findUnique({ where: { id: created!.id } });
    expect(after?.status).toBe(OrderStatus.PENDING_PAYMENT);
    const row = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "TRX-PD-UNV" } });
    expect(row?.outcome).toBe("unmatched");
    expect(row?.amount?.toFixed(0)).toBe("0");
    expect(row?.orderId).toBeNull();
    const alerts = await prisma.notificationOutbox.findMany({ where: { event: "ADMIN_UNCONFIRMABLE_PAYMENT", orderId: created!.id } });
    expect(alerts.length).toBeGreaterThan(0);
    const payload = JSON.parse(alerts[0]!.payloadJson) as { gateway: string; reason?: string; order_code: string };
    expect(payload).toMatchObject({ gateway: "PayDisini", reason: "unverified_amount", order_code: created!.orderCode });

    // The next cycle sees the same status: still parked, no second alert.
    await reconcileOrder(api, CREDS, pending!);
    expect(await prisma.notificationOutbox.count({ where: { event: "ADMIN_UNCONFIRMABLE_PAYMENT", orderId: created!.id } })).toBe(alerts.length);
    expect(await prisma.processedPaydisiniTx.count()).toBe(1);
  });

  it("leaves the order pending when the gateway reports unpaid", async () => {
    await makePaydisiniOrder();
    const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
    stubStatus({ status: "pending" });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const [stillPending] = await listPendingPaydisiniOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
  });

  it("never delivers on an underpayment, flags the order UNDERPAID, and alerts admins", async () => {
    const created = await makePaydisiniOrder();
    const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
    stubStatus({ status: "success", unique_code: "TRX-SHORT", amount: pending!.totalAmount.minus(1).toString() });
    const api = fakeApi();

    await reconcileOrder(api, CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created!.id } });
    expect(after?.status).toBe(OrderStatus.UNDERPAID);
    // ADMIN_IDS = "999,1000" in test setup — one alert per admin.
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const [, text] = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(text)).toMatch(/[Uu]nderpaid/);
    expect(String(text)).toContain(created!.orderCode);
    expect(String(text)).toContain("PayDisini");
  });

  // The poller re-checks the same order.id every cycle — the order's own
  // status IS the idempotency guard (no separate ledger table needed, unlike
  // the crypto rails). A second cycle before a human resolves the order must
  // be a silent no-op: no double alert, no throw.
  it("does not alert a second time when an already-UNDERPAID order is reconciled again", async () => {
    await makePaydisiniOrder();
    const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
    stubStatus({ status: "success", unique_code: "TRX-SHORT-2", amount: pending!.totalAmount.minus(1).toString() });
    const api = fakeApi();

    await reconcileOrder(api, CREDS, pending!);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);

    await expect(reconcileOrder(api, CREDS, pending!)).resolves.toBe("ok");
    expect(api.sendMessage).toHaveBeenCalledTimes(2); // no additional alert on the second cycle
  });

  /** Acknowledge the real checkout screen before a provider can settle it. */
  async function anchor(orderId: number, messageId = 777) {
    await prisma.$transaction(async (tx) => {
      await adoptTransactionMessage(tx, orderId, 555, messageId);
      await setOrderPaymentMessage(tx, orderId, 555, messageId);
    });
  }

  function expectNoDirectMutation(api: Api) {
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.editMessageCaption).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  }

  async function render(api: Api, orderId: number) {
    await new FulfillmentMessageWorker(api as unknown as FulfillmentTelegramApi, { db: prisma }).tick(orderId);
  }

  const bubbleEdit = (api: Api) => onlyBubbleEdit(
    (api.editMessageCaption as ReturnType<typeof vi.fn>).mock.calls,
    (api.editMessageText as ReturnType<typeof vi.fn>).mock.calls,
  );

  async function reconcilePaid(api: Api, trxId: string): Promise<void> {
    const [pending] = await listPendingPaydisiniOrders(prisma, new Date());
    stubStatus({ status: "success", unique_code: trxId, amount: pending!.totalAmount.toString() });
    await reconcileOrder(api, CREDS, pending!);
  }

  async function deliverAnchored(api: Api, trxId: string) {
    const created = await makePaydisiniOrder();
    await anchor(created!.id);
    await reconcilePaid(api, trxId);
    return prisma.order.findUniqueOrThrow({ where: { id: created!.id } });
  }

  it("commits settlement and wakes the owned message before nudging, without direct Telegram mutations", async () => {
    const api = fakeApi();
    let nudged = 0;
    let committed = false;
    const created = await makePaydisiniOrder();
    await anchor(created!.id);
    registerOutboxNudge(async () => {
      nudged++;
      const current = await prisma.order.findUniqueOrThrow({ where: { id: created!.id } });
      committed = current.status === OrderStatus.DELIVERED;
    });
    await reconcilePaid(api, "TRX-ORDERING");
    expect(nudged).toBe(1);
    // The registered callback observes the committed canonical state.
    await vi.waitFor(() => expect(committed).toBe(true));
    expectNoDirectMutation(api);
    expect(await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: created!.id } })).toMatchObject({ chatId: 555n, messageId: 777, state: "ACTIVE" });
  });

  it("lets the worker edit the original stock completion text once and retain its anchor", async () => {
    const api = fakeApi();
    const after = await deliverAnchored(api, "TRX-FLIP");
    expectNoDirectMutation(api);
    await render(api, after.id);
    const edit = bubbleEdit(api);
    expect(String(edit.chatId)).toBe("555");
    expect(edit.msgId).toBe(777);
    expect(edit.text).toContain(after.orderCode);
    expect(edit.text).toContain("100%");
    expect(edit.buttons).toContain("v1:browse:prods");
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await prisma.order.findUniqueOrThrow({ where: { id: after.id } })).toMatchObject({ paymentMsgChatId: 555n, paymentMsgId: 777 });
    await render(api, after.id);
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
  });

  it("edits the original product QR caption without deletion or replacement", async () => {
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(noTextToEdit()) });
    const after = await deliverAnchored(api, "TRX-FLIP-PHOTO");
    expectNoDirectMutation(api);
    await render(api, after.id);
    expect(api.editMessageCaption).toHaveBeenCalledWith("555", 777, expect.objectContaining({ caption: expect.stringContaining("100%") }), expect.anything());
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: after.id } })).toMatchObject({ chatId: 555n, messageId: 777, state: "FINISHED" });
  });

  it.each([
    ["Telegram flood control", () => telegramError(429, "Too Many Requests: retry after 30")],
    ["a Telegram server error", () => telegramError(502, "Bad Gateway")],
    ["a network fault", () => new Error("socket hang up")],
  ])("lets the worker retain the anchor and schedule a retry after %s", async (_label, makeError) => {
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(makeError()) });
    const after = await deliverAnchored(api, "TRX-EDITFAIL");
    expectNoDirectMutation(api);
    await render(api, after.id);
    const row = await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: after.id } });
    expect(row).toMatchObject({ state: "ACTIVE", messageId: 777, claimedAt: null, finishedAt: null });
    expect(row.nextUpdateAt.getTime()).toBeGreaterThan(Date.now());
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await prisma.order.findUniqueOrThrow({ where: { id: after.id } })).toMatchObject({ status: OrderStatus.DELIVERED, paymentMsgId: 777 });
  });

  it.each([
    ["a missing message", "Bad Request: message to edit not found", "STOPPED"],
    ["an unchanged completed message", "Bad Request: message is not modified", "FINISHED"],
  ])("lets the worker record %s without clearing ownership or sending a duplicate", async (_label, description, state) => {
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(telegramError(400, description)) });
    const after = await deliverAnchored(api, "TRX-PERMANENT");
    expectNoDirectMutation(api);
    await render(api, after.id);
    expect(await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: after.id } })).toMatchObject({ state, chatId: 555n, messageId: 777 });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: after.id } })).toMatchObject({ paymentMsgChatId: 555n, paymentMsgId: 777 });
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  describe("the worker's completed wallet message", () => {
    async function makeAnchoredTopup() {
      await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalance: "123456" } });
      const order = await prisma.$transaction((tx) => createWalletTopupOrder(tx, {
        userId: sample.user.id, amount: "50000", currency: "IDR", method: PaymentMethod.PAYDISINI, channel: "bot",
      }));
      await prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() + 30 * 60_000) } });
      await anchor(order.id);
      return order;
    }

    it("shows the full reference, 100% completion and the credited balance on the same message", async () => {
      const topup = await makeAnchoredTopup();
      const api = fakeApi();
      await reconcilePaid(api, "TRX-TOPUP");
      expectNoDirectMutation(api);
      await render(api, topup.id);
      const edit = bubbleEdit(api);
      expect(String(edit.chatId)).toBe("555");
      expect(edit.msgId).toBe(777);
      expect(edit.text).toContain(topup.orderCode);
      expect(edit.text).toContain("100%");
      expect(edit.text).toMatch(/173[.,]456/);
      expect(edit.text).not.toMatch(/123[.,]456/);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
      expect(new Decimal(user.walletBalance).toString()).toBe("173456");
      expect(await prisma.walletTransaction.count({ where: { orderId: topup.id, reason: "wallet_topup" } })).toBe(1);
    });

    it("offers the completed wallet keyboard", async () => {
      const topup = await makeAnchoredTopup();
      const api = fakeApi();
      await reconcilePaid(api, "TRX-TOPUP-KB");
      expectNoDirectMutation(api);
      await render(api, topup.id);
      expect(bubbleEdit(api).buttons).toContain("v1:wallet:view");
      expect(bubbleEdit(api).buttons).not.toContain("v1:order:list");
    });

    it("keeps and edits the wallet QR caption with the full completion receipt", async () => {
      const topup = await makeAnchoredTopup();
      const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(noTextToEdit()) });
      await reconcilePaid(api, "TRX-TOPUP-PHOTO");
      expectNoDirectMutation(api);
      await render(api, topup.id);
      const captionCalls = vi.mocked(api.editMessageCaption).mock.calls;
      const payload = captionCalls[0]![2] as { caption: string };
      expect(payload.caption).toContain(topup.orderCode);
      expect(payload.caption).toContain("100%");
      expect(payload.caption).toMatch(/173[.,]456/);
      expect(api.deleteMessage).not.toHaveBeenCalled();
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(await prisma.order.findUniqueOrThrow({ where: { id: topup.id } })).toMatchObject({ paymentMsgChatId: 555n, paymentMsgId: 777 });
    });
  });

  it("renders a delivered product with its full reference and product keyboard", async () => {
    const api = fakeApi();
    const after = await deliverAnchored(api, "TRX-PRODUCT-DELIVERED");
    expectNoDirectMutation(api);
    await render(api, after.id);
    const edit = bubbleEdit(api);
    expect(edit.text).toContain(after.orderCode);
    expect(edit.text).toContain("100%");
    expect(edit.buttons).toContain("v1:order:list");
    expect(edit.buttons).not.toContain("v1:wallet:view");
  });

  it("renders a manual product queue as a static wait on the same message", async () => {
    await updateDenomination(prisma, sample.product.id, { deliveryType: DeliveryType.MANUAL });
    const api = fakeApi();
    const after = await deliverAnchored(api, "TRX-PRODUCT-PROCESSING");
    expect(after.status).toBe(OrderStatus.PROCESSING);
    expectNoDirectMutation(api);
    await render(api, after.id);
    const edit = bubbleEdit(api);
    expect(edit.text).toContain(after.orderCode);
    expect(edit.text).not.toContain("%");
    expect(edit.text).not.toMatch(/[â£¾â£½â£»â¢¿â¡¿â£Ÿâ£¯â£·]/u);
    expect(await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId: after.id } })).toMatchObject({ state: "WAITING", messageId: 777 });
    await render(api, after.id);
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
  });

  describe("instant Digiflazz dispatch", () => {
    it("starts dispatch exactly once before the worker renders the saved anchor", async () => {
      const created = await makePaydisiniOrder();
      await routeOrderToDigiflazz(prisma, created!.id);
      await anchor(created!.id);
      const api = fakeApi();
      await reconcilePaid(api, "TRX-DIGIFLAZZ");
      expectNoDirectMutation(api);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: created!.id } })).toMatchObject({ status: OrderStatus.PROCESSING });
      const trigger = vi.mocked(triggerDigiflazzDispatch);
      expect(trigger).toHaveBeenCalledTimes(1);
      expect(trigger).toHaveBeenCalledWith(created!.id);
      await render(api, created!.id);
      const edit = vi.mocked(api.editMessageText);
      expect(edit).toHaveBeenCalledTimes(1);
      expect(trigger.mock.invocationCallOrder[0]!).toBeLessThan(edit.mock.invocationCallOrder[0]!);
    });

    it("does not start dispatch for stock completion", async () => {
      const after = await deliverAnchored(fakeApi(), "TRX-STOCK");
      expect(after.status).toBe(OrderStatus.DELIVERED);
      expect(triggerDigiflazzDispatch).not.toHaveBeenCalled();
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

// A gateway HTTP 429 arms this rail's backoff gate (pollBackoff.ts, one poll
// interval doubling to a 30s cap) — same shape as tokopay-reconcile.test.ts's
// own block. The gate lives at module scope, so every test here drives
// `Date.now()` from a frozen clock and ends on a clean cycle that clears the
// gate for later tests.
describe("pollOnce rate-limit backoff (HTTP 429)", () => {
  // The gate's base window is one full poll interval (paydisiniReconcile.ts).
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
  const pending = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "success", data: { status: "pending" } }) });

  it("a 429 makes the next cycle skip without a gateway call, and a clean cycle afterwards resets the backoff", async () => {
    await seedPaydisiniCreds();
    await makePaydisiniOrder();
    const start = clock;
    const fetchMock = vi.fn(rateLimited);
    vi.stubGlobal("fetch", fetchMock);

    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const afterHit = await getPollHealth(prisma, "paydisini");
    expect(afterHit.consecutiveFailures).toBe(1);

    clock = start + baseMs - 1; // just short of the next poll tick — still inside the base window
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getPollHealth(prisma, "paydisini")).lastRun).toEqual(afterHit.lastRun);

    clock = start + 60_000;
    fetchMock.mockImplementation(pending);
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A fresh 429 after the reset arms the base window again (hit #1), not
    // the doubled one a second consecutive hit would get.
    fetchMock.mockImplementation(rateLimited);
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    clock = start + 60_000 + baseMs + 1_000;
    fetchMock.mockImplementation(pending);
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps the backoff armed when one order in a batch was rate-limited even though a later one got through", async () => {
    await seedPaydisiniCreds();
    await makePaydisiniOrder();
    await makePaydisiniOrder();
    const start = clock;
    let call = 0;
    const fetchMock = vi.fn(() => (++call === 1 ? rateLimited() : pending()));
    vi.stubGlobal("fetch", fetchMock);

    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await getPollHealth(prisma, "paydisini")).consecutiveFailures).toBe(0);

    clock = start + 1_000;
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clock = start + 60_000;
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not back off on a non-429 gateway error", async () => {
    await seedPaydisiniCreds();
    await makePaydisiniOrder();
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);

    await pollOnce(fakeApi());
    await pollOnce(fakeApi());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
