// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Counts legacy anchor clearing while exercising the real database.
 * Coordinator-owned transaction messages must survive every menu render.
 */
const anchorClears = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@app/db", async () => {
  const actual = await vi.importActual<typeof import("@app/db")>("@app/db");
  return {
    ...actual,
    clearPaymentMessageAnchorsAt: (...args: Parameters<typeof actual.clearPaymentMessageAnchorsAt>) => {
      anchorClears.calls++;
      return actual.clearPaymentMessageAnchorsAt(...args);
    },
  };
});

import { InlineKeyboard, type Api } from "grammy";
import { prisma, createOrderDirect, finalizeOrderPayment } from "@app/db";
import { OrderCurrency, OrderStatus, PaymentMethod } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls } from "./helpers/ctx";
import { smartEdit, renderMenu, menuAnchor } from "../src/util/chat";
import { anchorPaymentMessage, checkoutScreenOf, menuBubbleKind, qrScreenKind } from "../src/util/paymentAnchor";
import { sweepPaidOrderBubbles } from "../src/jobs";

/** The chat every makeCtx double lives in. */
const CHAT_ID = 42;

let sample: SampleData;

beforeEach(async () => {
  anchorClears.calls = 0;
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const fakeApi = () =>
  ({
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPhoto: vi.fn().mockResolvedValue({ photo: [{ file_id: "fid" }] }),
    editMessageCaption: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  }) as unknown as Api;

const kb = () => new InlineKeyboard().text("X", "v1:noop");

/** A PENDING_PAYMENT Binance-Internal order, the shape a text rail leaves behind. */
async function makePendingOrder() {
  const order = await prisma.$transaction(async (tx) => {
    // M11: the fixture SKU costs Rp5, which converts to 0.0 USDT at the rate
    // below — finalizeOrderPayment now refuses to put a nothing-to-collect
    // total on a gateway. Nothing in this file asserts on the amount.
    await tx.denomination.update({ where: { id: sample.product.id }, data: { price: "80000" } });
    const created = await createOrderDirect(tx, { channel: "bot",
      user: { id: sample.user.id, role: sample.user.role },
      productId: sample.product.id,
      quantity: 1,
    });
    return finalizeOrderPayment(tx, created!.id, {
      currency: OrderCurrency.USDT,
      rate: "16000",
      method: PaymentMethod.BINANCE_INTERNAL,
    });
  });
  return order!;
}

/** The (chatId, messageId) an order currently points at. */
async function anchorOf(orderId: number) {
  const row = await prisma.order.findUnique({
    where: { id: orderId },
    select: { paymentMsgChatId: true, paymentMsgId: true },
  });
  return { chatId: row!.paymentMsgChatId, messageId: row!.paymentMsgId };
}

/** A context whose tap landed on `messageId`, sharing one live session. */
function tapOn(messageId: number, session: Record<string, unknown> = {}) {
  return makeCtx({
    callbackData: "v1:menu:main",
    cbMessage: { message_id: messageId, chat: { id: CHAT_ID, type: "private" }, date: 0 },
    session: { menuMsgId: messageId, ...session },
  });
}

describe("anchorPaymentMessage (each checkout keeps its own transaction bubble)", () => {
  it("anchors a second checkout to the new menu and retains the first transaction", async () => {
    const orderA = await makePendingOrder();
    const orderB = await makePendingOrder();
    const { ctx } = tapOn(777);

    await anchorPaymentMessage(ctx, orderA.id, CHAT_ID, "text");
    await smartEdit(ctx, "Main menu", kb());
    const nextMessageId = ctx.session.menuMsgId;
    await anchorPaymentMessage(ctx, orderB.id, CHAT_ID, "text");

    expect(nextMessageId).not.toBe(777);
    expect(await anchorOf(orderA.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(await anchorOf(orderB.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: nextMessageId });
    expect(ctx.session.paymentAnchorMsgId).toBe(nextMessageId);
    expect(await prisma.fulfillmentMessage.findUnique({ where: { orderId: orderA.id } })).toMatchObject({ messageId: 777 });
    expect(await prisma.fulfillmentMessage.findUnique({ where: { orderId: orderB.id } })).toMatchObject({ messageId: nextMessageId });
  });

  it("rejects direct reuse by another order and rolls back its anchor", async () => {
    const orderA = await makePendingOrder();
    const orderB = await makePendingOrder();
    const { ctx } = tapOn(777);
    await anchorPaymentMessage(ctx, orderA.id, CHAT_ID, "text");

    await expect(anchorPaymentMessage(ctx, orderB.id, CHAT_ID, "text")).rejects.toThrow();

    expect(await anchorOf(orderA.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(await anchorOf(orderB.id)).toEqual({ chatId: null, messageId: null });
    expect(await prisma.fulfillmentMessage.findUnique({ where: { orderId: orderA.id } })).toMatchObject({ messageId: 777 });
    expect(await prisma.fulfillmentMessage.findUnique({ where: { orderId: orderB.id } })).toMatchObject({
      messageId: null, state: "WAITING_SCREEN", claimedAt: null,
    });
    expect(ctx.session.paymentAnchorMsgId).toBe(777);
  });

  it("retains the canonical ID when the same order is reanchored from another menu", async () => {
    const order = await makePendingOrder();
    const { ctx } = tapOn(777);
    await anchorPaymentMessage(ctx, order.id, CHAT_ID, "text");
    await smartEdit(ctx, "Main menu", kb());
    expect(ctx.session.menuMsgId).not.toBe(777);

    await anchorPaymentMessage(ctx, order.id, CHAT_ID, "text");

    expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(await prisma.fulfillmentMessage.findUnique({ where: { orderId: order.id } })).toMatchObject({ messageId: 777 });
    expect(ctx.session.paymentAnchorMsgId).toBe(777);
  });

  it.each(["photo", "text"] as const)("persists the %s kind of the anchored payment screen", async (kind) => {
    const order = await makePendingOrder();
    const { ctx } = tapOn(777);

    await anchorPaymentMessage(ctx, order.id, CHAT_ID, kind);

    expect(await prisma.fulfillmentMessage.findUnique({ where: { orderId: order.id } })).toMatchObject({ messageId: 777, messageKind: kind });
  });

  it("reads a caption-edited photo menu bubble as a photo, anything else as text", () => {
    const photoTap = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: { message_id: 801, chat: { id: CHAT_ID, type: "private" }, date: 0, photo: [{ file_id: "f" }] },
      session: { menuMsgId: 801 },
    }).ctx;
    expect(menuBubbleKind(photoTap)).toBe("photo");
    // The tapped photo was not the bubble that ended up as the menu (a fresh text send replaced it).
    photoTap.session.menuMsgId = 802;
    expect(menuBubbleKind(photoTap)).toBe("text");
    expect(menuBubbleKind(tapOn(803).ctx)).toBe("text");
    expect(menuBubbleKind(makeCtx({ text: "hi", session: { menuMsgId: 804 } }).ctx)).toBe("text");
  });

  it("takes a wallet completion's adopted id and kind from the same (tapped) message", () => {
    // The buyer tapped an older text confirmation while the session menu is a banner photo.
    const olderText = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: { message_id: 810, chat: { id: CHAT_ID, type: "private" }, date: 0 },
      session: { menuMsgId: 811 },
    }).ctx;
    expect(checkoutScreenOf(olderText)).toEqual({ messageId: 810, kind: "text" });
    const tappedPhoto = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: { message_id: 812, chat: { id: CHAT_ID, type: "private" }, date: 0, photo: [{ file_id: "f" }] },
      session: { menuMsgId: 813 },
    }).ctx;
    expect(checkoutScreenOf(tappedPhoto)).toEqual({ messageId: 812, kind: "photo" });
    expect(checkoutScreenOf(makeCtx({ text: "hi", session: { menuMsgId: 814 } }).ctx)).toEqual({ messageId: 814, kind: "text" });
    expect(checkoutScreenOf(makeCtx({ text: "hi" }).ctx)).toBeUndefined();
  });

  it("reads a QR screen as a photo only while the sent QR photo is still the menu bubble", () => {
    const { ctx } = tapOn(805);
    ctx.session.menuMsgId = 806;
    expect(qrScreenKind(ctx, 806)).toBe("photo");
    // The photo send was followed by a text fallback that took over the menu bubble.
    ctx.session.menuMsgId = 805;
    expect(qrScreenKind(ctx, 806)).toBe("text");
    expect(qrScreenKind(ctx, undefined)).toBe("text");
  });

  it("does nothing when the chat has no menu bubble to anchor", async () => {
    const order = await makePendingOrder();
    const { ctx } = makeCtx({ text: "hi" });

    await anchorPaymentMessage(ctx, order.id, CHAT_ID, "text");

    expect(await anchorOf(order.id)).toEqual({ chatId: null, messageId: null });
    expect(ctx.session.paymentAnchorMsgId).toBeUndefined();
  });

  it("leaves coordinator-owned messages to the worker when the first order settles", async () => {
    const orderA = await makePendingOrder();
    const orderB = await makePendingOrder();
    const { ctx } = tapOn(777);
    await anchorPaymentMessage(ctx, orderA.id, CHAT_ID, "text");
    await smartEdit(ctx, "Main menu", kb());
    const nextMessageId = ctx.session.menuMsgId;
    await anchorPaymentMessage(ctx, orderB.id, CHAT_ID, "text");
    await prisma.order.update({ where: { id: orderA.id }, data: { status: OrderStatus.DELIVERED } });

    const api = fakeApi();
    await sweepPaidOrderBubbles(api);

    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.editMessageCaption).not.toHaveBeenCalled();
    expect(await anchorOf(orderA.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(await anchorOf(orderB.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: nextMessageId });
  });

  it.each([OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED])(
    "retains a Bybit BSC %s transaction while the next checkout gets a new bubble",
    async (status) => {
      const orderA = await makePendingOrder();
      const orderB = await makePendingOrder();
      const { ctx } = tapOn(777);
      await anchorPaymentMessage(ctx, orderA.id, CHAT_ID, "text");
      await prisma.order.update({ where: { id: orderA.id }, data: { status } });

      await smartEdit(ctx, "Main menu", kb());
      const nextMessageId = ctx.session.menuMsgId;
      await anchorPaymentMessage(ctx, orderB.id, CHAT_ID, "text");

      expect(nextMessageId).not.toBe(777);
      expect(await anchorOf(orderA.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
      expect(await anchorOf(orderB.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: nextMessageId });
    },
  );
});

describe("navigating away from an anchored payment bubble", () => {
  it("sends a fresh menu instead of editing the canonical transaction", async () => {
    const order = await makePendingOrder();
    const { ctx, sink } = tapOn(777);
    await anchorPaymentMessage(ctx, order.id, CHAT_ID, "text");

    await smartEdit(ctx, "🏠 Main menu", kb());

    expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(ctx.session.paymentAnchorMsgId).toBe(777);
    expect(ctx.session.menuMsgId).not.toBe(777);
    expect(calls(sink, "reply")).toHaveLength(1);
    expect(calls(sink, "editMessageText")).toHaveLength(0);
    expect(calls(sink, "editMessageCaption")).toHaveLength(0);
    expect(anchorClears.calls).toBe(0);
  });

  it("keeps the sweeper off the screen the buyer navigated to", async () => {
    const order = await makePendingOrder();
    const { ctx } = tapOn(777);
    await anchorPaymentMessage(ctx, order.id, CHAT_ID, "text");
    await smartEdit(ctx, "🏠 Main menu", kb());
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.DELIVERED } });

    const api = fakeApi();
    await sweepPaidOrderBubbles(api);

    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.editMessageCaption).not.toHaveBeenCalled();
  });

  it("sends a fresh photo menu without editing the payment caption", async () => {
    const order = await makePendingOrder();
    const { ctx, sink } = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: {
        message_id: 777,
        chat: { id: CHAT_ID, type: "private" },
        date: 0,
        photo: [{ file_id: "qr" }],
      },
      session: { menuMsgId: 777 },
    });
    await anchorPaymentMessage(ctx, order.id, CHAT_ID, "text");

    await renderMenu(ctx, "🏠 Main menu", kb(), "banner.jpg");

    expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(ctx.session.menuMsgId).not.toBe(777);
    expect(calls(sink, "replyWithPhoto")).toHaveLength(1);
    expect(calls(sink, "editMessageCaption")).toHaveLength(0);
    expect(calls(sink, "editMessageText")).toHaveLength(0);
    expect(anchorClears.calls).toBe(0);
  });

  it("protects the transaction when typed input renders through menuAnchor", async () => {
    const order = await makePendingOrder();
    const { ctx: payment } = tapOn(777);
    await anchorPaymentMessage(payment, order.id, CHAT_ID, "text");
    const { ctx, sink } = makeCtx({ text: "2", sharedSession: payment.session });

    await menuAnchor(ctx, "Choose a product", kb());

    expect(calls(sink, "reply")).toHaveLength(1);
    expect(calls(sink, "editMessageText")).toHaveLength(0);
    expect(calls(sink, "editMessageCaption")).toHaveLength(0);
    expect(ctx.session.menuMsgId).not.toBe(777);
    expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(await prisma.fulfillmentMessage.findUnique({ where: { orderId: order.id } })).toMatchObject({ messageId: 777 });
    expect(anchorClears.calls).toBe(0);
  });

  it("leaves the anchor alone when the render lands on a different message", async () => {
    const order = await makePendingOrder();
    const { ctx } = tapOn(777);
    await anchorPaymentMessage(ctx, order.id, CHAT_ID, "text");

    // A tap on some OTHER bubble: the payment instructions in 777 survive
    // untouched, so the anchor still describes reality.
    const { ctx: other } = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: { message_id: 900, chat: { id: CHAT_ID, type: "private" }, date: 0 },
      session: { menuMsgId: 900, paymentAnchorMsgId: 777 },
    });
    await smartEdit(other, "🏠 Main menu", kb());

    expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
  });

  it.each([OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED])(
    "keeps a Bybit BSC %s order's anchor — its on-chain tracker still owns that bubble",
    async (status) => {
      const order = await makePendingOrder();
      const { ctx } = tapOn(777);
      await anchorPaymentMessage(ctx, order.id, CHAT_ID, "text");
      await prisma.order.update({ where: { id: order.id }, data: { status } });

      await smartEdit(ctx, "🏠 Main menu", kb());

      expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    },
  );
});

describe("a render that falls through to a fresh send", () => {
  // The old bubble is untouched in this case — it still displays the payment
  // instructions — so the anchor still describes reality and must survive.
  // Both fresh-send branches preserve the coordinator-owned message, even
  // when Telegram has already deleted it.

  it("keeps the anchor when smartEdit navigates from a deleted transaction bubble", async () => {
    const order = await makePendingOrder();
    const { ctx, sink } = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: { message_id: 777, chat: { id: CHAT_ID, type: "private" }, date: 0 },
      session: { menuMsgId: 777 },
      deletedMessageIds: [777],
    });
    await anchorPaymentMessage(ctx, order.id, CHAT_ID, "text");
    anchorClears.calls = 0;

    await smartEdit(ctx, "🏠 Main menu", kb());

    expect(calls(sink, "reply").length).toBe(1); // a NEW bubble carries the menu
    expect(anchorClears.calls).toBe(0);
    expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(ctx.session.paymentAnchorMsgId).toBe(777);
  });

  it("keeps the anchor when renderMenu sends a new photo instead of editing", async () => {
    const order = await makePendingOrder();
    const { ctx, sink } = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: {
        message_id: 777,
        chat: { id: CHAT_ID, type: "private" },
        date: 0,
        photo: [{ file_id: "qr" }],
      },
      session: { menuMsgId: 777 },
      deletedMessageIds: [777],
    });
    await anchorPaymentMessage(ctx, order.id, CHAT_ID, "text");
    anchorClears.calls = 0;

    await renderMenu(ctx, "🏠 Main menu", kb(), "banner.jpg");

    expect(calls(sink, "replyWithPhoto").length).toBe(1);
    expect(anchorClears.calls).toBe(0);
    expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(ctx.session.paymentAnchorMsgId).toBe(777);
  });
});

describe("transaction ownership across sessions", () => {
  it("protects the stored transaction after restart without a session stamp", async () => {
    const order = await makePendingOrder();
    const { ctx: payment } = tapOn(777);
    await anchorPaymentMessage(payment, order.id, CHAT_ID, "text");
    const { ctx, sink } = tapOn(777); // no session stamp — e.g. a restarted bot

    await smartEdit(ctx, "🏠 Main menu", kb());

    expect(ctx.session.paymentAnchorMsgId).toBeUndefined();
    expect(calls(sink, "reply")).toHaveLength(1);
    expect(calls(sink, "editMessageText")).toHaveLength(0);
    expect(calls(sink, "editMessageCaption")).toHaveLength(0);
    expect(ctx.session.menuMsgId).not.toBe(777);
    expect(anchorClears.calls).toBe(0);
    expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(await prisma.fulfillmentMessage.findUnique({ where: { orderId: order.id } })).toMatchObject({ messageId: 777 });
  });

  it("keeps a normal menu editable after navigating away from the transaction", async () => {
    const order = await makePendingOrder();
    const { ctx } = tapOn(777);
    await anchorPaymentMessage(ctx, order.id, CHAT_ID, "text");
    anchorClears.calls = 0;

    await smartEdit(ctx, "🏠 Main menu", kb());
    const menuMessageId = ctx.session.menuMsgId!;
    const { ctx: menu, sink } = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: { message_id: menuMessageId, chat: { id: CHAT_ID, type: "private" }, date: 0 },
      sharedSession: ctx.session,
    });
    await smartEdit(menu, "📦 Products", kb());

    expect(calls(sink, "editMessageText")).toHaveLength(1);
    expect(anchorClears.calls).toBe(0);
    expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
  });
});
