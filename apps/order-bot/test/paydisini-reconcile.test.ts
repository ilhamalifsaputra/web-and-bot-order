// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createOrderDirect,
  finalizeOrderPayment,
  listPendingPaydisiniOrders,
  setOrderPaymentMessage,
  deliverPaidPaydisiniOrder,
} from "@app/db";
import type { Api } from "grammy";
import { OrderStatus, OrderCurrency, PaymentMethod } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { reconcileOrder, sweepDeliveredAwaitingEdit } from "../src/payments/paydisiniReconcile";

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

describe("sweepDeliveredAwaitingEdit (PayDisini webhook-delivered bubbles)", () => {
  it("flips a webhook-delivered order's bubble exactly once, then is a no-op", async () => {
    const created = await makePaydisiniOrder();
    await setOrderPaymentMessage(prisma, created!.id, 555, 777);
    const r = await deliverPaidPaydisiniOrder(prisma, {
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
