// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createOrderDirect, finalizeOrderPayment, setOrderPaymentMessage } from "@app/db";
import type { Api } from "grammy";
import { OrderStatus, OrderCurrency } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { autoCancelExpiredOrders } from "../src/jobs";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const fakeApi = (overrides: Partial<{ editMessageCaption: unknown; editMessageText: unknown }> = {}) =>
  ({
    sendMessage: vi.fn().mockResolvedValue(undefined),
    editMessageCaption: overrides.editMessageCaption ?? vi.fn().mockResolvedValue(undefined),
    editMessageText: overrides.editMessageText ?? vi.fn().mockResolvedValue(undefined),
  }) as unknown as Api;

/** A PENDING_PAYMENT order whose window already expired (picked up by the job). */
async function makeExpiredOrder() {
  const created = await prisma.$transaction(async (tx) => {
    const o = await createOrderDirect(tx, {
      user: { id: sample.user.id, role: sample.user.role },
      productId: sample.product.id,
      quantity: 1,
    });
    return finalizeOrderPayment(tx, o!.id, { currency: OrderCurrency.IDR });
  });
  await prisma.order.update({ where: { id: created!.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  return created!;
}

describe("autoCancelExpiredOrders", () => {
  it("edits the anchored text bubble in place instead of sending a new message", async () => {
    const order = await makeExpiredOrder();
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const api = fakeApi({ editMessageCaption: vi.fn().mockRejectedValue(new Error("no caption to edit")) });

    await autoCancelExpiredOrders(api);

    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, msgId, , payload] = (api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chatId).toBe(555);
    expect(msgId).toBe(777);
    const flat = (payload.reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>)
      .flat()
      .map((b) => b.callback_data);
    expect(flat).toContain("v1:order:list");
    expect(api.sendMessage).not.toHaveBeenCalled();

    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.status).toBe(OrderStatus.CANCELLED);
  });

  it("edits the anchored photo (QR) bubble's caption when available", async () => {
    const order = await makeExpiredOrder();
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const api = fakeApi();

    await autoCancelExpiredOrders(api);

    expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to a fresh DM when the order has no anchored bubble", async () => {
    await makeExpiredOrder();
    const api = fakeApi();

    await autoCancelExpiredOrders(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessageCaption).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("falls back to a fresh DM when the anchored bubble can no longer be edited", async () => {
    const order = await makeExpiredOrder();
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const api = fakeApi({
      editMessageCaption: vi.fn().mockRejectedValue(new Error("gone")),
      editMessageText: vi.fn().mockRejectedValue(new Error("gone")),
    });

    await autoCancelExpiredOrders(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
});
