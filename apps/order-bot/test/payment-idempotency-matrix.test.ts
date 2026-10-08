// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

/**
 * The guarantee this whole branch exists to provide, asserted in one place.
 *
 * > One valid payment produces one confirmation, one fulfilment, one wallet
 * > credit, and one success notification — no matter how many refreshes,
 * > webhook retries, poller detections, bot callbacks or process restarts
 * > happen around it.
 *
 * The per-rail suites already cover most of the matrix well: each of the six
 * rails pins its own "a repeated transaction id is already_processed", "a
 * duplicate gateway tx does not double-credit the wallet", and "delivers and
 * enqueues exactly one outbox top-up DM". This file deliberately does NOT
 * restate any of that. It covers the four things none of them could, because
 * each spans two mechanisms that only meet at runtime:
 *
 *  1. The buyer's Refresh tap arriving AFTER settlement. Every rail asserts one
 *     DM at settle time; none asserts the count still holds once the buyer taps
 *     🔄 on an order that is already paid — which is exactly when they tap it.
 *  2. Settlement commits before the dispatcher is nudged. The message worker
 *     then edits the owned checkout screen while legacy refreshes defer.
 *  3. Dedupe surviving a restart, i.e. that the guard is in the DATABASE and
 *     not in a module-level Set that a process bounce would clear.
 *  4. The full acceptance load — many refreshes, retries, detections and
 *     callbacks against ONE payment — as a single arithmetic assertion.
 *
 * Assertions are on state (ledger rows, outbox rows, wallet transactions,
 * order status) rather than on how often a private function ran, except where
 * ordering IS the property under test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createOrderDirect,
  createWalletTopupOrder,
  finalizeOrderPayment,
  setOrderPaymentMessage,
  adoptTransactionMessage,
  deliverPaidTokopayOrder,
  listPendingTokopayOrders,
  bulkAddStock,
  enqueueWalletTopupCreditedDm,
} from "@app/db";
import type { Api } from "grammy";
import { NotificationEvent, OrderCurrency, OrderKind, OrderStatus, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { registerOutboxNudge } from "@app/core/nudge";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { telegramError } from "./helpers/ctx";
import { flipSettledOrderBubble } from "../src/jobs";
import { FulfillmentMessageWorker, type FulfillmentTelegramApi } from "../../../packages/outbox-dispatcher/src/fulfillmentMessages";
import { reconcileOrder } from "../src/payments/tokopayReconcile";
import { qrisChargeAmount } from "@app/core/payments/tokopay";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedTokopayTx.deleteMany();
  sample = await buildSampleData(prisma);
});

afterEach(() => {
  vi.unstubAllGlobals();
  registerOutboxNudge(null);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const CREDS = { merchantId: "M", secret: "s", channel: "QRIS", minAmount: null };

/** Telegram identifies a saved QR photo; the worker edits its caption. */
const noTextToEdit = () => telegramError(400, "Bad Request: there is no text in the message to edit");

/**
 * A Telegram double that records the ORDER of every call across all methods,
 * not just the count per method. `calls` is the interleaved sequence, which is
 * what regression 2 needs — per-method spies cannot tell you when the worker
 * edited the saved screen relative to the committed settlement's nudge.
 */
function recordingApi(opts: { photoBubble?: boolean } = {}) {
  const calls: string[] = [];
  const record = (name: string, result: unknown, throws?: () => Error) =>
    vi.fn(async () => {
      calls.push(name);
      if (throws) throw throws();
      return result;
    });
  return {
    calls,
    api: {
      sendMessage: record("sendMessage", { message_id: 90210 }),
      sendDocument: record("sendDocument", { message_id: 90211 }),
      editMessageCaption: record("editMessageCaption", undefined),
      editMessageText: opts.photoBubble
        ? record("editMessageText", undefined, noTextToEdit)
        : record("editMessageText", undefined),
      deleteMessage: record("deleteMessage", true),
    } as unknown as Api,
  };
}

/** Stub TokoPay's status endpoint. */
function stubStatus(data: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "success", data }) }),
  );
}

/** A PENDING_PAYMENT TokoPay order of either kind, anchored to a payment
 *  bubble the way a real checkout leaves it. */
async function makeAnchoredTokopayOrder(kind: string) {
  const order =
    kind === OrderKind.WALLET_TOPUP
      ? await prisma.$transaction((tx) =>
          createWalletTopupOrder(tx, {
            userId: sample.user.id,
            amount: "50000",
            currency: "IDR",
            method: PaymentMethod.TOKOPAY,
            channel: "bot",
          }),
        )
      : await prisma.$transaction(async (tx) => {
          const created = await createOrderDirect(tx, { channel: "bot",
            user: { id: sample.user.id, role: sample.user.role },
            productId: sample.product.id,
            quantity: 1,
          });
          return finalizeOrderPayment(tx, created!.id, {
            currency: OrderCurrency.IDR,
            method: PaymentMethod.TOKOPAY,
          });
        });
  await prisma.$transaction(async (tx) => {
    await adoptTransactionMessage(tx, order!.id, 555, 4242);
    await setOrderPaymentMessage(tx, order!.id, 555, 4242);
  });
  return order!;
}

async function render(api: Api, orderId: number) {
  await new FulfillmentMessageWorker(api as unknown as FulfillmentTelegramApi, { db: prisma }).tick(orderId);
}

async function expectCanonicalCompletion(orderId: number) {
  expect(await prisma.fulfillmentMessage.findUniqueOrThrow({ where: { orderId } })).toMatchObject({ chatId: 555n, messageId: 4242, state: "FINISHED" });
  expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ paymentMsgChatId: 555n, paymentMsgId: 4242 });
}

const countTopupDms = (orderId: number) =>
  prisma.notificationOutbox.count({
    where: { event: NotificationEvent.WALLET_TOPUP_CREDITED_DM, orderId },
  });

// ───────────────────────────────────────────────────────────────────────────
// Reported bug 1: a QRIS wallet top-up produced TWO "top-up successful"
// messages, worded differently.
//
// A durable coordinator owns the original QR caption. Refresh defers to it;
// repeated worker ticks and delivery retries must never create another screen.
// ───────────────────────────────────────────────────────────────────────────
describe("regression: a settled QRIS top-up yields exactly one success message, even after Refresh", () => {
  it("edits the original QR caption once without sending a replacement or adding a second outbox DM", async () => {
    const order = await makeAnchoredTokopayOrder(OrderKind.WALLET_TOPUP);
    const { calls, api } = recordingApi({ photoBubble: true });

    await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "TRX-TOPUP-1",
      amount: qrisChargeAmount(order.totalAmount),
      shopUrl: null,
    });
    const settled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    await flipSettledOrderBubble(api, { ...settled, user: { language: "en" } }, 5000);
    expect(calls).toEqual([]); // Legacy refresh defers to the registered owner.
    await render(api, order.id);
    expect(calls.filter((c) => c === "editMessageCaption")).toHaveLength(1);
    const [, messageId, payload] = vi.mocked(api.editMessageCaption).mock.calls[0]!;
    expect(messageId).toBe(4242);
    expect(payload).toMatchObject({ caption: expect.stringContaining(order.orderCode) });
    expect(calls).not.toContain("deleteMessage");
    expect(calls).not.toContain("sendMessage");
    expect(await countTopupDms(order.id)).toBe(1);
    await expectCanonicalCompletion(order.id);
  });

  it("still yields one message after ten Refresh taps on the settled order", async () => {
    const order = await makeAnchoredTokopayOrder(OrderKind.WALLET_TOPUP);
    await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "TRX-TOPUP-2",
      amount: qrisChargeAmount(order.totalAmount),
      shopUrl: null,
    });

    const { calls, api } = recordingApi({ photoBubble: true });
    for (let tap = 0; tap < 10; tap++) {
      const current = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      await flipSettledOrderBubble(api, { ...current, user: { language: "en" } }, 5000);
      await render(api, order.id);
    }

    // Persisted FINISHED ownership makes the nine later worker ticks no-ops.
    expect(calls.filter((c) => c === "editMessageCaption")).toHaveLength(1);
    expect(calls).not.toContain("deleteMessage");
    expect(calls).not.toContain("sendMessage");
    expect(await countTopupDms(order.id)).toBe(1);
    await expectCanonicalCompletion(order.id);
  });

  it("credits the wallet exactly once across those taps", async () => {
    const order = await makeAnchoredTokopayOrder(OrderKind.WALLET_TOPUP);
    await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "TRX-TOPUP-3",
      amount: qrisChargeAmount(order.totalAmount),
      shopUrl: null,
    });
    const { api } = recordingApi({ photoBubble: true });
    for (let tap = 0; tap < 10; tap++) {
      const current = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      await flipSettledOrderBubble(api, { ...current, user: { language: "en" } }, 5000);
      await render(api, order.id);
    }

    const credits = await prisma.walletTransaction.findMany({
      where: { orderId: order.id, reason: "wallet_topup" },
    });
    expect(credits).toHaveLength(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalance).toString()).toBe(new Decimal(order.totalAmount).toString());
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Payment settlement and message ownership commit before the dispatcher wakes.
// The rail defers Telegram writes to the worker, which edits the original ID.
// ───────────────────────────────────────────────────────────────────────────
describe("regression: settlement commits before the durable message worker is nudged", () => {
  it("nudges only after canonical settlement and lets the worker edit the owned message", async () => {
    await bulkAddStock(prisma, sample.product.id, ["cred-ordering-1"]);
    const order = await makeAnchoredTokopayOrder(OrderKind.PRODUCT);
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    stubStatus({
      status: "Paid",
      trx_id: "TRX-ORDER-1",
      total_bayar: qrisChargeAmount(pending!.totalAmount).toString(),
    });

    const sequence: string[] = [];
    let committed = false;
    registerOutboxNudge(async () => {
      sequence.push("nudge");
      committed = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status === OrderStatus.DELIVERED;
    });
    const api = {
      sendMessage: vi.fn(async () => {
        sequence.push("bubble");
        return { message_id: 90210 };
      }),
      editMessageCaption: vi.fn(async () => { sequence.push("caption"); }),
      editMessageText: vi.fn(async () => {
        sequence.push("bubble");
        throw noTextToEdit();
      }),
      deleteMessage: vi.fn(async () => {
        sequence.push("bubble");
        return true;
      }),
    } as unknown as Api;

    await reconcileOrder(api, CREDS, pending!);

    expect(sequence).toEqual(["nudge"]);
    await vi.waitFor(() => expect(committed).toBe(true));
    await render(api, order.id);
    expect(sequence).toEqual(["nudge", "bubble", "caption"]);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
    await expectCanonicalCompletion(order.id);
  });

  it("leaves the settled bubble carrying no Refresh button once it is flipped", async () => {
    // The other half of what the buyer saw: a live "🔄 Refresh Status" button
    // sitting under a paid order invites the tap that produced the confusing
    // sequence in the first place.
    await bulkAddStock(prisma, sample.product.id, ["cred-ordering-2"]);
    const order = await makeAnchoredTokopayOrder(OrderKind.PRODUCT);
    await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "TRX-ORDER-2",
      amount: qrisChargeAmount(order.totalAmount),
      shopUrl: null,
    });
    const settled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const edited: Array<{ caption?: string; reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } }> = [];
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: 90210 })),
      editMessageCaption: vi.fn(async (_chat: number, id: number, opts: (typeof edited)[number]) => {
        expect(id).toBe(4242);
        edited.push(opts);
      }),
      editMessageText: vi.fn(async () => {
        throw noTextToEdit();
      }),
      deleteMessage: vi.fn(async () => true),
    } as unknown as Api;

    await flipSettledOrderBubble(api, { ...settled, user: { language: "en" } }, 5000);
    expect(edited).toHaveLength(0);
    await render(api, order.id);
    expect(edited).toHaveLength(1);
    expect(edited[0]!.caption).toContain("100%");
    const buttons = (edited[0]!.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? "");
    expect(buttons.some((b) => b.startsWith("refresh"))).toBe(false);
    expect(buttons.some((b) => b.startsWith("cancel"))).toBe(false);
    expect(buttons.some((b) => b.includes("refresh") || b.includes("cancel"))).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
    await expectCanonicalCompletion(order.id);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Reported bug 3's structural guard: the dedupe key must live in the database,
// not in a module-level Set or Map that a process bounce would silently clear.
// ───────────────────────────────────────────────────────────────────────────
describe("regression: the top-up DM dedupe survives a process restart", () => {
  it("blocks a second enqueue after the module state has been thrown away", async () => {
    const order = await makeAnchoredTokopayOrder(OrderKind.WALLET_TOPUP);
    const args = {
      orderId: order.id,
      orderCode: order.orderCode,
      chatId: 999,
      amount: new Decimal("50000"),
      currency: "IDR",
      newBalance: new Decimal("50000"),
    };

    await enqueueWalletTopupCreditedDm(prisma, args);
    expect(await countTopupDms(order.id)).toBe(1);

    // Re-import against the SAME database with every module re-evaluated —
    // what a restarted process gets. An in-memory guard would be empty here
    // and would let the second row through.
    vi.resetModules();
    const fresh = await import("@app/db");
    await fresh.enqueueWalletTopupCreditedDm(fresh.prisma, args);

    expect(await countTopupDms(order.id)).toBe(1);
    await fresh.prisma.$disconnect();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The acceptance criterion from the original brief, as one sum.
// ───────────────────────────────────────────────────────────────────────────
describe("acceptance: 10 refreshes + 5 webhook retries + 3 poller detections + 2 callbacks = one of everything", () => {
  it("holds for a PRODUCT order", async () => {
    await bulkAddStock(prisma, sample.product.id, ["cred-acceptance-1"]);
    const order = await makeAnchoredTokopayOrder(OrderKind.PRODUCT);
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    const charge = qrisChargeAmount(pending!.totalAmount);
    stubStatus({ status: "Paid", trx_id: "TRX-ACCEPT-1", total_bayar: charge.toString() });
    const { api } = recordingApi({ photoBubble: true });

    // 5 webhook retries — the gateway resending the same confirmation.
    for (let retry = 0; retry < 5; retry++) {
      await deliverPaidTokopayOrder(prisma, {
        orderId: order.id,
        trxId: "TRX-ACCEPT-1",
        amount: charge,
        shopUrl: null,
      });
    }
    // 3 poller detections of the same payment.
    for (let cycle = 0; cycle < 3; cycle++) {
      await reconcileOrder(api, CREDS, pending!);
    }
    // 10 refreshes + 2 bot callbacks, all landing on an order already settled.
    for (let tap = 0; tap < 12; tap++) {
      const current = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      await flipSettledOrderBubble(api, { ...current, user: { language: "en" } }, 5000);
      await render(api, order.id);
    }

    expect(await prisma.processedTokopayTx.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.financialTransaction.count({ where: { idempotencyKey: `order:${order.id}:payment` } })).toBe(1);
    expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    await expectCanonicalCompletion(order.id);
    expect(
      await prisma.notificationOutbox.count({
        where: { event: NotificationEvent.ORDER_DELIVERED_DM, orderId: order.id },
      }),
    ).toBe(1);
    // One fulfilment: exactly one stock item sold to this order.
    expect(await prisma.stockItem.count({ where: { orderId: order.id } })).toBe(1);
    expect(
      await prisma.orderStatusHistory.count({ where: { orderId: order.id, status: OrderStatus.DELIVERED } }),
    ).toBe(1);
  });

  it("holds for a WALLET_TOPUP order, crediting the balance exactly once", async () => {
    const order = await makeAnchoredTokopayOrder(OrderKind.WALLET_TOPUP);
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    const charge = qrisChargeAmount(pending!.totalAmount);
    stubStatus({ status: "Paid", trx_id: "TRX-ACCEPT-2", total_bayar: charge.toString() });
    const { api } = recordingApi({ photoBubble: true });

    for (let retry = 0; retry < 5; retry++) {
      await deliverPaidTokopayOrder(prisma, {
        orderId: order.id,
        trxId: "TRX-ACCEPT-2",
        amount: charge,
        shopUrl: null,
      });
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      await reconcileOrder(api, CREDS, pending!);
    }
    for (let tap = 0; tap < 12; tap++) {
      const current = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      await flipSettledOrderBubble(api, { ...current, user: { language: "en" } }, 5000);
      await render(api, order.id);
    }

    expect(await prisma.processedTokopayTx.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.financialTransaction.count({ where: { idempotencyKey: `order:${order.id}:topup` } })).toBe(1);
    expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    await expectCanonicalCompletion(order.id);
    expect(await countTopupDms(order.id)).toBe(1);
    expect(
      await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "wallet_topup" } }),
    ).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalance).toString()).toBe(new Decimal(order.totalAmount).toString());
  });
});
