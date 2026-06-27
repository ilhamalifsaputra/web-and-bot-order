/**
 * Unit tests for the chat render helpers — the single-active-keyboard
 * invariant (retire the previous menu's buttons whenever a new screen is
 * rendered elsewhere), the wizard anchor editors, and consumeInput.
 * Pure ctx doubles; no DB.
 */
import { describe, expect, it } from "vitest";
import { InlineKeyboard } from "grammy";
import { makeCtx, calls } from "./helpers/ctx";
import {
  smartEdit,
  renderMenu,
  adminEdit,
  adminAnchor,
  menuAnchor,
  consumeInput,
  retireKeyboard,
} from "../src/util/chat";

const kb = () => new InlineKeyboard().text("X", "v1:noop");

describe("single-active-keyboard invariant", () => {
  it("smartEdit on typed input retires the previous menu's keyboard", async () => {
    const { ctx, sink } = makeCtx({ text: "hello", session: { menuMsgId: 77 } });
    await smartEdit(ctx, "next screen", kb());

    expect(calls(sink, "reply").length).toBe(1);
    const retire = calls(sink, "editMessageReplyMarkup");
    expect(retire.length).toBe(1);
    expect(retire[0]!.args[1]).toBe(77);
    expect(ctx.session.menuMsgId).not.toBe(77);
  });

  it("smartEdit editing a tapped bubble retires a *different* previously active menu", async () => {
    const { ctx, sink } = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: { message_id: 10, chat: { id: 42, type: "private" }, date: 0 },
      session: { menuMsgId: 5 },
    });
    await smartEdit(ctx, "screen", kb());

    expect(calls(sink, "editMessageText").length).toBe(1); // edited in place
    const retire = calls(sink, "editMessageReplyMarkup");
    expect(retire.length).toBe(1);
    expect(retire[0]!.args[1]).toBe(5);
    expect(ctx.session.menuMsgId).toBe(10);
  });

  it("smartEdit does not retire anything when the tapped bubble IS the active menu", async () => {
    const { ctx, sink } = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: { message_id: 10, chat: { id: 42, type: "private" }, date: 0 },
      session: { menuMsgId: 10 },
    });
    await smartEdit(ctx, "screen", kb());
    expect(calls(sink, "editMessageReplyMarkup").length).toBe(0);
  });

  it("smartEdit on a no-op edit (\"message is not modified\") still anchors the tapped bubble as the active menu", async () => {
    // Telegram throws this when the rendered text+markup are byte-identical
    // to what the bubble already shows — a successful render outcome, not a
    // failure. Regression test: this used to leave ctx.session.menuMsgId
    // stale/unset, which permanently broke any later poller's "edit this
    // order's anchored bubble" lookup for that chat (e.g. Bybit BSC delivery
    // never flipping the payment-instructions bubble to a success state).
    const { ctx, sink } = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: { message_id: 10, chat: { id: 42, type: "private" }, date: 0 },
      session: { menuMsgId: 5 },
      editThrowsNotModified: true,
    });
    await smartEdit(ctx, "screen", kb());

    expect(calls(sink, "reply").length).toBe(0); // no fallback fresh send needed
    expect(ctx.session.menuMsgId).toBe(10);
    const retire = calls(sink, "editMessageReplyMarkup");
    expect(retire.length).toBe(1);
    expect(retire[0]!.args[1]).toBe(5); // the stale previous menu still gets retired
  });

  it("adminEdit on typed input retires the previous admin screen", async () => {
    const { ctx, sink } = makeCtx({ text: "typed", session: { adminMsgId: 31 } });
    await adminEdit(ctx, "result", kb());
    const retire = calls(sink, "editMessageReplyMarkup");
    expect(retire.length).toBe(1);
    expect(retire[0]!.args[1]).toBe(31);
  });
});

describe("wizard anchors", () => {
  it("adminAnchor on typed input edits the anchor message instead of replying", async () => {
    const { ctx, sink } = makeCtx({ text: "bad input", session: { adminMsgId: 50 } });
    await adminAnchor(ctx, "⚠️ error", kb());

    const edits = calls(sink, "editMessageText");
    expect(edits.length).toBe(1);
    expect(edits[0]!.args[1]).toBe(50); // (chatId, messageId, text, ...)
    expect(calls(sink, "reply").length).toBe(0);
    expect(ctx.session.adminMsgId).toBe(50);
  });

  it("adminAnchor falls back to a fresh send when no anchor is known", async () => {
    const { ctx, sink } = makeCtx({ text: "bad input" });
    await adminAnchor(ctx, "⚠️ error", kb());
    expect(calls(sink, "reply").length).toBe(1);
    expect(ctx.session.adminMsgId).toBeDefined();
  });

  it("menuAnchor on typed input edits the menu anchor and clears qty mode", async () => {
    const { ctx, sink } = makeCtx({
      text: "BADCODE",
      session: { menuMsgId: 60, awaitingQtyDenomId: 3 },
    });
    await menuAnchor(ctx, "⚠️ voucher not found", kb());

    const edits = calls(sink, "editMessageText");
    expect(edits.length).toBe(1);
    expect(edits[0]!.args[1]).toBe(60);
    expect(ctx.session.awaitingQtyDenomId).toBeUndefined();
  });

  it("menuAnchor delegates to smartEdit on a tap", async () => {
    const { ctx, sink } = makeCtx({
      callbackData: "v1:noop",
      cbMessage: { message_id: 12, chat: { id: 42, type: "private" }, date: 0 },
    });
    await menuAnchor(ctx, "screen", kb());
    expect(calls(sink, "editMessageText").length).toBe(1);
    expect(ctx.session.menuMsgId).toBe(12);
  });
});

describe("renderMenu (photo+caption bubble)", () => {
  it("on a no-op caption edit (\"message is not modified\") still anchors the tapped photo bubble as the active menu", async () => {
    // Same regression as smartEdit's analogous test above, for the
    // photo+caption edit path (e.g. a banner menu screen).
    const { ctx, sink } = makeCtx({
      callbackData: "v1:menu:main",
      cbMessage: { message_id: 10, chat: { id: 42, type: "private" }, date: 0, photo: [{ file_id: "f1" }] },
      session: { menuMsgId: 5 },
      editThrowsNotModified: true,
    });
    await renderMenu(ctx, "screen", kb(), "banner.jpg");

    expect(calls(sink, "replyWithPhoto").length).toBe(0); // no fallback fresh send needed
    expect(ctx.session.menuMsgId).toBe(10);
    const retire = calls(sink, "editMessageReplyMarkup");
    expect(retire.length).toBe(1);
    expect(retire[0]!.args[1]).toBe(5);
  });
});

describe("consumeInput / retireKeyboard", () => {
  it("consumeInput deletes the incoming typed message", async () => {
    const { ctx, sink } = makeCtx({ text: "secret:credential" });
    await consumeInput(ctx);
    const del = calls(sink, "deleteMessage");
    expect(del.length).toBe(1);
    expect(del[0]!.args[0]).toBe(42); // chat id
  });

  it("consumeInput is a no-op without an incoming message", async () => {
    const { ctx, sink } = makeCtx({ callbackData: "v1:noop" });
    await consumeInput(ctx);
    expect(calls(sink, "deleteMessage").length).toBe(0);
  });

  it("retireKeyboard strips the keyboard off the given message", async () => {
    const { ctx, sink } = makeCtx({ text: "x" });
    await retireKeyboard(ctx, 99);
    const c = calls(sink, "editMessageReplyMarkup");
    expect(c.length).toBe(1);
    expect(c[0]!.args[1]).toBe(99);
  });
});
