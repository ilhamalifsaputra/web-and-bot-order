// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Counts every anchor-clearing table scan the render path triggers.
 *
 * `paymentMsgChatId`/`paymentMsgId` are unindexed, and smartEdit runs on
 * practically every button tap, so "did this render touch the anchor query at
 * all?" is a load-bearing property, not an implementation detail — the
 * hot-path test below asserts the count is 0. Wrapping the real
 * implementation (rather than stubbing it) keeps every other test in this file
 * exercising the genuine DB behaviour.
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
import { smartEdit, renderMenu } from "../src/util/chat";
import { anchorPaymentMessage } from "../src/util/paymentAnchor";
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
    const created = await createOrderDirect(tx, {
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

describe("anchorPaymentMessage (a second checkout reuses the menu bubble)", () => {
  it("moves the anchor to the new order and stamps the session", async () => {
    const orderA = await makePendingOrder();
    const orderB = await makePendingOrder();
    const { ctx } = tapOn(777);

    await anchorPaymentMessage(ctx, orderA.id, CHAT_ID);
    await anchorPaymentMessage(ctx, orderB.id, CHAT_ID);

    expect(await anchorOf(orderA.id)).toEqual({ chatId: null, messageId: null });
    expect(await anchorOf(orderB.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(ctx.session.paymentAnchorMsgId).toBe(777);
  });

  it("does nothing when the chat has no menu bubble to anchor", async () => {
    const order = await makePendingOrder();
    const { ctx } = makeCtx({ text: "hi" });

    await anchorPaymentMessage(ctx, order.id, CHAT_ID);

    expect(await anchorOf(order.id)).toEqual({ chatId: null, messageId: null });
    expect(ctx.session.paymentAnchorMsgId).toBeUndefined();
  });

  it("leaves the sweeper with nothing to flip once the overtaken order settles", async () => {
    // The whole point of scenario (a): order A is approved in web-admin while
    // its old bubble now shows order B's unpaid deposit address and amount.
    // Without the takeover clearing A's anchor, the sweeper would edit that
    // bubble to "payment received — order A" and destroy B's instructions.
    const orderA = await makePendingOrder();
    const orderB = await makePendingOrder();
    const { ctx } = tapOn(777);
    await anchorPaymentMessage(ctx, orderA.id, CHAT_ID);
    await anchorPaymentMessage(ctx, orderB.id, CHAT_ID);
    await prisma.order.update({ where: { id: orderA.id }, data: { status: OrderStatus.DELIVERED } });

    const api = fakeApi();
    await sweepPaidOrderBubbles(api);

    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.editMessageCaption).not.toHaveBeenCalled();
    expect(await anchorOf(orderB.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
  });

  it.each([OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED])(
    "clears even a Bybit BSC %s order's anchor — the bubble now shows another order's deposit address",
    async (status) => {
      // The mirror image of the navigate-away case further down: there the
      // tracker still owns the bubble, here it doesn't. Sparing the tracked
      // order would leave A and B anchored on ONE message, and
      // bybitBscConfirmationTracker re-renders A's tracking screen every cycle
      // — over B's unpaid deposit address and amount. Accepted cost: A's live
      // tracking screen goes quiet (My Orders still shows progress).
      const orderA = await makePendingOrder();
      const orderB = await makePendingOrder();
      const { ctx } = tapOn(777);
      await anchorPaymentMessage(ctx, orderA.id, CHAT_ID);
      await prisma.order.update({ where: { id: orderA.id }, data: { status } });

      await anchorPaymentMessage(ctx, orderB.id, CHAT_ID);

      expect(await anchorOf(orderA.id)).toEqual({ chatId: null, messageId: null });
      expect(await anchorOf(orderB.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    },
  );
});

describe("navigating away from an anchored payment bubble", () => {
  it("releases the anchor when smartEdit re-renders that exact message", async () => {
    const order = await makePendingOrder();
    const { ctx } = tapOn(777);
    await anchorPaymentMessage(ctx, order.id, CHAT_ID);

    await smartEdit(ctx, "🏠 Main menu", kb());

    expect(await anchorOf(order.id)).toEqual({ chatId: null, messageId: null });
    expect(ctx.session.paymentAnchorMsgId).toBeUndefined();
  });

  it("keeps the sweeper off the screen the buyer navigated to", async () => {
    const order = await makePendingOrder();
    const { ctx } = tapOn(777);
    await anchorPaymentMessage(ctx, order.id, CHAT_ID);
    await smartEdit(ctx, "🏠 Main menu", kb());
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.DELIVERED } });

    const api = fakeApi();
    await sweepPaidOrderBubbles(api);

    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.editMessageCaption).not.toHaveBeenCalled();
  });

  it("releases the anchor when renderMenu edits an anchored photo bubble's caption", async () => {
    // The QRIS/PayDisini wait screen IS a photo+caption bubble, and a caption
    // edit leaves the message alive — the "a photo bubble self-heals because
    // both edits fail" note in the old plan was simply wrong.
    const order = await makePendingOrder();
    const { ctx } = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: {
        message_id: 777,
        chat: { id: CHAT_ID, type: "private" },
        date: 0,
        photo: [{ file_id: "qr" }],
      },
      session: { menuMsgId: 777 },
    });
    await anchorPaymentMessage(ctx, order.id, CHAT_ID);

    await renderMenu(ctx, "🏠 Main menu", kb(), "banner.jpg");

    expect(await anchorOf(order.id)).toEqual({ chatId: null, messageId: null });
  });

  it("leaves the anchor alone when the render lands on a different message", async () => {
    const order = await makePendingOrder();
    const { ctx } = tapOn(777);
    await anchorPaymentMessage(ctx, order.id, CHAT_ID);

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
      await anchorPaymentMessage(ctx, order.id, CHAT_ID);
      await prisma.order.update({ where: { id: order.id }, data: { status } });

      await smartEdit(ctx, "🏠 Main menu", kb());

      expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    },
  );
});

describe("a render that falls through to a fresh send", () => {
  // The old bubble is untouched in this case — it still displays the payment
  // instructions — so the anchor still describes reality and must survive.
  // Neither fresh-send branch releases it, and that has to stay true: the
  // commonest way a buyer leaves a payment screen (tapping "Main menu" on a
  // reply keyboard) skips the edit entirely and lands here.

  it("keeps the anchor when smartEdit cannot edit the old bubble", async () => {
    const order = await makePendingOrder();
    const { ctx, sink } = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: { message_id: 777, chat: { id: CHAT_ID, type: "private" }, date: 0 },
      session: { menuMsgId: 777 },
      deletedMessageIds: [777], // the edit rejects, exactly like real Telegram
    });
    await anchorPaymentMessage(ctx, order.id, CHAT_ID);
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
    await anchorPaymentMessage(ctx, order.id, CHAT_ID);
    anchorClears.calls = 0;

    await renderMenu(ctx, "🏠 Main menu", kb(), "banner.jpg");

    expect(calls(sink, "replyWithPhoto").length).toBe(1);
    expect(anchorClears.calls).toBe(0);
    expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
    expect(ctx.session.paymentAnchorMsgId).toBe(777);
  });
});

describe("hot path", () => {
  it("renders a menu without any anchor lookup when the chat has no anchored order", async () => {
    // smartEdit runs on nearly every button tap and the anchor columns are
    // unindexed, so an ungated lookup here would be a table scan per tap.
    const order = await makePendingOrder();
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentMsgChatId: BigInt(CHAT_ID), paymentMsgId: 777 },
    });
    const { ctx, sink } = tapOn(777); // no session stamp — e.g. a restarted bot

    await smartEdit(ctx, "🏠 Main menu", kb());

    expect(calls(sink, "editMessageText").length).toBe(1); // the render still happened
    expect(anchorClears.calls).toBe(0);
    expect(await anchorOf(order.id)).toEqual({ chatId: BigInt(CHAT_ID), messageId: 777 });
  });

  it("performs exactly one anchor lookup when the reused message really is anchored", async () => {
    const order = await makePendingOrder();
    const { ctx } = tapOn(777);
    await anchorPaymentMessage(ctx, order.id, CHAT_ID);
    anchorClears.calls = 0;

    await smartEdit(ctx, "🏠 Main menu", kb());
    await smartEdit(ctx, "📦 Products", kb()); // second tap: anchor already released

    expect(anchorClears.calls).toBe(1);
  });
});
