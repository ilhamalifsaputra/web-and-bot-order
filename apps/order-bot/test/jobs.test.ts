// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createOrderDirect,
  finalizeOrderPayment,
  setOrderPaymentMessage,
  clearOrderPaymentMessage,
  createBroadcast,
  createTicket,
  getSetting,
  setSetting,
  BINANCE_UID_KEY,
  BINANCE_API_KEY_KEY,
  BINANCE_API_SECRET_KEY,
  BINANCE_POLL_HEALTH_KEY,
  POLL_HEALTH_KEYS,
} from "@app/db";
import { TOKOPAY_MERCHANT_KEY, TOKOPAY_SECRET_KEY } from "@app/core/payments/tokopay";
import { PAYDISINI_USERKEY_KEY, PAYDISINI_APIKEY_KEY } from "@app/core/payments/paydisini";
import { NOWPAYMENTS_API_KEY_KEY, NOWPAYMENTS_IPN_SECRET_KEY } from "@app/core/payments/nowpayments";
import {
  pollOnce as tokopayPollOnce,
  RECONCILE_CYCLE_TIMEOUT_MS as TOKOPAY_CYCLE_TIMEOUT_MS,
} from "../src/payments/tokopayReconcile";
import { RECONCILE_CYCLE_TIMEOUT_MS as NOWPAYMENTS_CYCLE_TIMEOUT_MS } from "../src/payments/nowpaymentsReconcile";
/**
 * Lets a single test make the drainer's mid-flight progress flush fail — the
 * SQLITE_BUSY-past-busy_timeout case — without disturbing any other DB write.
 * Everything else in `@app/db` is the real implementation; `vi.hoisted` is
 * needed because `vi.mock` factories run before ordinary module-level `let`s
 * are initialised.
 */
const dbMockState = vi.hoisted(() => ({
  progressFlushError: null as Error | null,
  // Task 10: per-test overrides for the two calls runDigiflazzCatalogSyncTick
  // makes. null => use the real implementation.
  resyncDigiflazzCatalog: null as null | (() => Promise<{ updated: number; deactivated: number }>),
  runDetectionForCatalog: null as null | (() => Promise<unknown>),
}));
vi.mock("@app/db", async () => {
  const actual = await vi.importActual<typeof import("@app/db")>("@app/db");
  return {
    ...actual,
    updateBroadcastProgress: async (...args: Parameters<typeof actual.updateBroadcastProgress>) => {
      if (dbMockState.progressFlushError) throw dbMockState.progressFlushError;
      return actual.updateBroadcastProgress(...args);
    },
    resyncDigiflazzCatalog: (...args: Parameters<typeof actual.resyncDigiflazzCatalog>) =>
      dbMockState.resyncDigiflazzCatalog
        ? dbMockState.resyncDigiflazzCatalog()
        : actual.resyncDigiflazzCatalog(...args),
    runDetectionForCatalog: (...args: Parameters<typeof actual.runDetectionForCatalog>) =>
      dbMockState.runDetectionForCatalog
        ? dbMockState.runDetectionForCatalog()
        : actual.runDetectionForCatalog(...args),
  };
});

import { GrammyError, InlineKeyboard, type Api } from "grammy";
import { OrderStatus, OrderCurrency, OrderKind, PaymentMethod, TicketStatus } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { telegramError } from "./helpers/ctx";
import {
  makeSettledAnchoredOrder as makeSettledAnchoredOrderShared,
  onlyBubbleEdit,
  type BubbleEdit,
} from "./helpers/settledBubble";
import {
  autoCancelExpiredOrders,
  autoCloseStaleTickets,
  editPaymentBubble,
  sweepPaidOrderBubbles,
  flushSettledOrderBubble,
  scheduleJobs,
  drainBroadcasts,
  announceStartedFlashSales,
  binancePollWatchdog,
  tokopayPollWatchdog,
  paydisiniPollWatchdog,
  nowpaymentsPollWatchdog,
  outboxDispatcherPollWatchdog,
  scheduleOutboxDispatcherWatchdog,
  runDigiflazzCatalogSyncTick,
  TOKOPAY_POLL_STALE_MS,
  NOWPAYMENTS_POLL_STALE_MS,
} from "../src/jobs";
import { NotificationEvent } from "@app/core/enums";

let sample: SampleData;

beforeEach(async () => {
  dbMockState.progressFlushError = null;
  dbMockState.resyncDigiflazzCatalog = null;
  dbMockState.runDetectionForCatalog = null;
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** The message id the fake `sendMessage` hands back, so a test can assert the
 *  replaced-bubble result really carries the NEW message's id (that id is what
 *  an anchor-owning caller re-anchors on). */
const REPLACEMENT_MSG_ID = 90210;

const fakeApi = (
  overrides: Partial<{
    editMessageCaption: unknown;
    editMessageText: unknown;
    deleteMessage: unknown;
    sendMessage: unknown;
    sendPhoto: unknown;
  }> = {},
) =>
  ({
    sendMessage: overrides.sendMessage ?? vi.fn().mockResolvedValue({ message_id: REPLACEMENT_MSG_ID }),
    sendPhoto: overrides.sendPhoto ?? vi.fn().mockResolvedValue({ photo: [{ file_id: "small_fid" }, { file_id: "large_fid" }] }),
    editMessageCaption: overrides.editMessageCaption ?? vi.fn().mockResolvedValue(undefined),
    editMessageText: overrides.editMessageText ?? vi.fn().mockResolvedValue(undefined),
    deleteMessage: overrides.deleteMessage ?? vi.fn().mockResolvedValue(true),
  }) as unknown as Api;

/** Telegram's answer to `editMessageText` on a PHOTO message — the one signal
 *  that says "this bubble carries a QR image, not text". Deliberately absent
 *  from `isPermanentBubbleEditFailure`'s permanent list, which is what routes
 *  it onto the delete-and-resend path. */
const noTextToEdit = () => telegramError(400, "Bad Request: there is no text in the message to edit");

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
    const api = fakeApi();

    await autoCancelExpiredOrders(api);

    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, msgId, , payload] = (api.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chatId).toBe(555);
    expect(msgId).toBe(777);
    const flat = (payload.reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>)
      .flat()
      .map((b) => b.callback_data);
    expect(flat).toContain("v1:order:list");
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();

    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.status).toBe(OrderStatus.CANCELLED);
  });

  // Telegram cannot turn a photo message into a text one, so the caption edit
  // this used to do left the now-irrelevant QR image sitting above the
  // "cancelled" wording. The bubble is deleted and replaced instead.
  it("replaces the anchored photo (QR) bubble with a fresh message instead of leaving the QR image behind", async () => {
    const order = await makeExpiredOrder();
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(noTextToEdit()) });

    await autoCancelExpiredOrders(api);

    expect(api.deleteMessage).toHaveBeenCalledWith(555, 777);
    // Sent into the bubble's own chat, not as a fallback DM — the replacement
    // takes the deleted bubble's place.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [target, text] = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(target).toBe(555);
    expect(String(text)).toContain(order.orderCode);

    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.status).toBe(OrderStatus.CANCELLED);
  });

  it("falls back to a fresh DM when the order has no anchored bubble", async () => {
    await makeExpiredOrder();
    const api = fakeApi();

    await autoCancelExpiredOrders(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  // A GrammyError, not a bare Error: only Telegram's own answer proves the
  // bubble is dead, and only a dead bubble skips the delete-and-replace path
  // to land on the fallback DM.
  it("falls back to a fresh DM when the anchored bubble can no longer be edited", async () => {
    const order = await makeExpiredOrder();
    await setOrderPaymentMessage(prisma, order.id, 555, 777);
    const api = fakeApi({
      editMessageText: vi.fn().mockRejectedValue(telegramError(400, "Bad Request: message to edit not found")),
    });

    await autoCancelExpiredOrders(api);

    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    // The DM goes to the buyer's telegram id, not to the dead bubble's chat.
    expect((api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(Number(sample.user.telegramId));
    expect((await prisma.order.findUnique({ where: { id: order.id } }))?.status).toBe(OrderStatus.CANCELLED);
  });
});

// T2-C: the shared bubble-edit helper notifyAutoCancelled above was refactored
// to use — exported so the next task's generic bubble-flip sweeper can call it
// too, in a mode that must NEVER send a fallback DM (the buyer already got the
// news through another channel there).
describe("editPaymentBubble", () => {
  const markup = new InlineKeyboard().text("OK", "noop");
  const bubble = { chatId: 555, messageId: 777, text: "hello", markup };

  it("edits a text bubble in place, and neither deletes nor re-sends anything", async () => {
    const api = fakeApi();

    const result = await editPaymentBubble(api, { ...bubble, onPhoto: "replace", fallbackDm: null });

    expect(result).toEqual({ status: "edited", via: "text" });
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  // The bug this whole change exists for: a photo bubble's caption CAN be
  // edited, so the old caption-first order "succeeded" while leaving the
  // now-meaningless QR image in the buyer's chat. Telegram offers no way to
  // turn a photo message into a text one, so the only way to get rid of the
  // image is to delete the bubble and send a fresh message.
  it("deletes a photo (QR) bubble and sends the message afresh, reporting the new message's id", async () => {
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(noTextToEdit()) });

    const result = await editPaymentBubble(api, { ...bubble, onPhoto: "replace", fallbackDm: null });

    expect(api.deleteMessage).toHaveBeenCalledWith(555, 777);
    expect(api.sendMessage).toHaveBeenCalledWith(555, "hello", { parse_mode: "HTML", reply_markup: markup });
    // The new id is what an anchor-owning caller re-anchors on, so it has to
    // be the id `sendMessage` came back with — not the deleted bubble's.
    expect(result).toEqual({ status: "replaced", messageId: REPLACEMENT_MSG_ID });
  });

  // Task E2: a caller that already told the buyer through another channel (a
  // settled WALLET_TOPUP's outbox DM) asks for the QR to simply disappear —
  // no replacement message at all.
  it("deletes a photo (QR) bubble and sends nothing when onPhoto is 'delete'", async () => {
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(noTextToEdit()) });

    const result = await editPaymentBubble(api, { ...bubble, onPhoto: "delete" });

    expect(api.deleteMessage).toHaveBeenCalledWith(555, 777);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "deleted" });
  });

  // Anything that is not a Telegram answer at all (a network fault, an abort)
  // may equally well be a photo bubble whose edit request never landed, so it
  // takes the same replace path rather than being written off.
  it("takes the same delete-and-replace path when the edit fails with something that is not a Telegram error", async () => {
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(new Error("socket hang up")) });

    const result = await editPaymentBubble(api, { ...bubble, onPhoto: "replace", fallbackDm: null });

    expect(api.deleteMessage).toHaveBeenCalledWith(555, 777);
    expect(result).toEqual({ status: "replaced", messageId: REPLACEMENT_MSG_ID });
  });

  // Same non-Telegram-error case, but in "delete" mode: still nothing sent.
  it("takes the same delete-and-send-nothing path when the edit fails with something that is not a Telegram error and onPhoto is 'delete'", async () => {
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(new Error("socket hang up")) });

    const result = await editPaymentBubble(api, { ...bubble, onPhoto: "delete" });

    expect(api.deleteMessage).toHaveBeenCalledWith(555, 777);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "deleted" });
  });

  // A bubble Telegram has declared dead (or that already shows this exact
  // text) must NOT be deleted: there is nothing there to replace, and deleting
  // on "message is not modified" would destroy a bubble that is already
  // correct.
  it.each([
    ["Bad Request: message is not modified"],
    ["Bad Request: message to edit not found"],
    ["Bad Request: message can't be edited"],
  ])("never deletes the bubble when Telegram answers %s, and reports a permanent failure", async (description) => {
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(telegramError(400, description)) });

    const result = await editPaymentBubble(api, { ...bubble, onPhoto: "replace", fallbackDm: null });

    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "not_edited", permanent: true });
  });

  // Same permanent-failure case in "delete" mode, which carries no fallbackDm
  // option at all — still never deletes, still just reports.
  it("never deletes the bubble when Telegram answers permanently and onPhoto is 'delete'", async () => {
    const api = fakeApi({
      editMessageText: vi.fn().mockRejectedValue(telegramError(400, "Bad Request: message to edit not found")),
    });

    const result = await editPaymentBubble(api, { ...bubble, onPhoto: "delete" });

    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "not_edited", permanent: true });
  });

  it("with fallback DM on, DMs the buyer instead when the bubble is permanently uneditable", async () => {
    const api = fakeApi({
      editMessageText: vi.fn().mockRejectedValue(telegramError(400, "Bad Request: message to edit not found")),
    });

    const result = await editPaymentBubble(api, { ...bubble, onPhoto: "replace", fallbackDm: { telegramId: 42 } });

    expect(result).toEqual({ status: "dm_sent" });
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(42, "hello", { parse_mode: "HTML", reply_markup: markup });
  });

  // The anchor is the only thing that will ever bring this bubble back to the
  // sweeper, so a delete that merely failed THIS minute must keep it.
  it.each([
    ["Telegram flood control", () => telegramError(429, "Too Many Requests: retry after 30")],
    ["a Telegram server error", () => telegramError(502, "Bad Gateway")],
    ["a network fault that never reached Telegram", () => new Error("socket hang up")],
  ])("sends nothing and reports a NON-permanent failure when the delete fails with %s", async (_label, makeError) => {
    const api = fakeApi({
      editMessageText: vi.fn().mockRejectedValue(noTextToEdit()),
      deleteMessage: vi.fn().mockRejectedValue(makeError()),
    });

    const result = await editPaymentBubble(api, { ...bubble, onPhoto: "replace", fallbackDm: null });

    // Nothing was sent: a replacement next to a bubble that is still there
    // would show the buyer the same news twice.
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "not_edited", permanent: false });
  });

  it("reports a permanent failure when the delete says the bubble is already gone", async () => {
    const api = fakeApi({
      editMessageText: vi.fn().mockRejectedValue(noTextToEdit()),
      deleteMessage: vi.fn().mockRejectedValue(telegramError(400, "Bad Request: message to edit not found")),
    });

    const result = await editPaymentBubble(api, { ...bubble, onPhoto: "replace", fallbackDm: null });

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "not_edited", permanent: true });
  });

  // Delete landed, send didn't: the bubble is gone for good, so no later
  // attempt at that message id can ever succeed and the anchor must be
  // released rather than retried every minute forever.
  it("reports a permanent failure when the bubble was deleted but the replacement could not be sent", async () => {
    const api = fakeApi({
      editMessageText: vi.fn().mockRejectedValue(noTextToEdit()),
      sendMessage: vi.fn().mockRejectedValue(telegramError(429, "Too Many Requests: retry after 30")),
    });

    const result = await editPaymentBubble(api, { ...bubble, onPhoto: "replace", fallbackDm: null });

    expect(api.deleteMessage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "not_edited", permanent: true });
  });

  it("never throws, whatever every single Telegram call does", async () => {
    const boom = () => Promise.reject(new Error("everything is on fire"));
    const api = fakeApi({
      editMessageText: vi.fn(boom),
      deleteMessage: vi.fn(boom),
      sendMessage: vi.fn(boom),
    });

    // Three modes: the fallback DM's own failure is reported, never thrown,
    // and "delete" mode (no fallbackDm to even attempt) still just reports.
    await expect(editPaymentBubble(api, { ...bubble, onPhoto: "replace", fallbackDm: null })).resolves.toMatchObject({ status: "not_edited" });
    await expect(editPaymentBubble(api, { ...bubble, onPhoto: "delete" })).resolves.toMatchObject({ status: "not_edited" });
    const dmMode = await editPaymentBubble(api, { ...bubble, onPhoto: "replace", fallbackDm: { telegramId: 42 } });
    expect(dmMode.status).toBe("not_edited");
    expect(dmMode).toHaveProperty("error");
  });
});

// ===========================================================================
// T2-E — generic paid-order bubble sweeper (every payment method, both order
// kinds, both settled statuses)
// ===========================================================================

/** The currency each rail settles a wallet top-up in — TokoPay/PayDisini are
 * the two IDR rails, the other four are USDT (crud/wallet_topup.ts's
 * IDR_TOPUP_METHODS / USDT_TOPUP_METHODS). Also the currency each rail's
 * product orders are charged in, so one map drives both kinds. */
const RAIL_CURRENCY: Record<string, "IDR" | "USDT"> = {
  [PaymentMethod.TOKOPAY]: "IDR",
  [PaymentMethod.PAYDISINI]: "IDR",
  [PaymentMethod.BINANCE_INTERNAL]: "USDT",
  [PaymentMethod.BYBIT]: "USDT",
  [PaymentMethod.BYBIT_BSC]: "USDT",
  [PaymentMethod.NOWPAYMENTS]: "USDT",
};

const SWEEP_METHODS = [
  PaymentMethod.BINANCE_INTERNAL,
  PaymentMethod.BYBIT,
  PaymentMethod.BYBIT_BSC,
  PaymentMethod.TOKOPAY,
  PaymentMethod.PAYDISINI,
  PaymentMethod.NOWPAYMENTS,
] as const;

/** Wallet balances the sweeper must render into a top-up's success bubble —
 * distinct per currency so a test can tell which of the two columns was read. */
const IDR_BALANCE = "123456";
const USDT_BALANCE = "77.5";

/**
 * The shared harness's settled-anchored-order builder, with this suite's own
 * fixtures filled in: the sweeper covers all six rails, so the currency comes
 * from RAIL_CURRENCY rather than being passed per call, and `kind`/`status`
 * are required because the 24-case matrix below varies both.
 */
const makeSettledAnchoredOrder = (opts: { method: string; kind: string; status: string }) =>
  makeSettledAnchoredOrderShared(prisma, {
    ...opts,
    currency: RAIL_CURRENCY[opts.method]!,
    buyer: { id: sample.user.id, role: sample.user.role },
    productId: sample.product.id,
  });

/** The single edit the sweeper made, whichever grammY call carried it. The
 *  sweeper takes a bare `Api`, so the two call lists come off its `vi.fn()`
 *  mocks — that is the only thing this suite has to supply that
 *  handlers.test.ts's sink-based reader doesn't. */
function onlyEdit(api: Api): BubbleEdit {
  return onlyBubbleEdit(
    (api.editMessageCaption as ReturnType<typeof vi.fn>).mock.calls,
    (api.editMessageText as ReturnType<typeof vi.fn>).mock.calls,
  );
}

describe("sweepPaidOrderBubbles", () => {
  beforeEach(async () => {
    // Give the buyer a distinct balance per currency so a top-up bubble's
    // rendered "New balance" proves which column the sweeper read.
    await prisma.user.update({
      where: { id: sample.user.id },
      data: { walletBalance: IDR_BALANCE, walletBalanceUsdt: USDT_BALANCE },
    });
  });

  const matrix = SWEEP_METHODS.flatMap((method) =>
    [OrderKind.PRODUCT, OrderKind.WALLET_TOPUP].flatMap((kind) =>
      [OrderStatus.DELIVERED, OrderStatus.PROCESSING].map((status) => ({ method, kind, status })),
    ),
  );

  it.each(matrix)(
    "flips a $method $kind order at $status exactly once, clears the anchor, and is a no-op on the next tick",
    async ({ method, kind, status }) => {
      const order = await makeSettledAnchoredOrder({ method, kind, status });
      const api = fakeApi();

      await sweepPaidOrderBubbles(api);

      const edit = onlyEdit(api);
      expect(edit.chatId).toBe(order.chatId);
      expect(edit.msgId).toBe(order.msgId);
      if (kind === OrderKind.WALLET_TOPUP) {
        // A neutral "payment received" status, not a balance-quoting success
        // sentence — the buyer's actual "top-up successful" DM (with order
        // code, amount and new balance) now comes exclusively from the
        // outbox (WALLET_TOPUP_CREDITED_DM, enqueued inside
        // settleWalletTopup), so this bubble interpolates neither the order
        // code nor the balance. Still gets the wallet keyboard rather than
        // paymentSuccessKb's "My Orders".
        expect(edit.text).toContain("Payment received");
        expect(edit.text).toContain("top-up has been credited");
        expect(edit.text).not.toContain(order.orderCode);
        expect(edit.text).not.toContain(RAIL_CURRENCY[method] === "IDR" ? "Rp123.456" : "77.5 USDT");
        expect(edit.buttons).toContain("v1:topup:open");
      } else if (status === OrderStatus.DELIVERED) {
        expect(edit.text).toContain(order.orderCode);
        expect(edit.text).toContain("being delivered now");
        expect(edit.buttons).toContain("v1:browse:prods");
      } else {
        expect(edit.text).toContain(order.orderCode);
        expect(edit.text).toContain("being prepared for delivery manually");
        expect(edit.buttons).toContain("v1:browse:prods");
      }

      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.paymentMsgChatId).toBeNull();
      expect(after?.paymentMsgId).toBeNull();

      // Second tick: the anchor is gone, so this order is not even listed —
      // still exactly the one edit from the first tick, no second one.
      await sweepPaidOrderBubbles(api);
      onlyEdit(api);
    },
  );

  it("never sends a fallback DM — the buyer already heard about it through their delivery/top-up path", async () => {
    const order = await makeSettledAnchoredOrder({
      method: PaymentMethod.TOKOPAY,
      kind: OrderKind.PRODUCT,
      status: OrderStatus.DELIVERED,
    });
    const gone = telegramError(400, "Bad Request: message to edit not found");
    const api = fakeApi({ editMessageText: vi.fn().mockRejectedValue(gone) });

    await sweepPaidOrderBubbles(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
    // A permanently-uneditable bubble is a completed attempt, so the anchor is
    // cleared anyway instead of being retried forever.
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.paymentMsgChatId).toBeNull();
  });

  // The bubble-flip contract used to read every completed edit attempt as
  // "done", which cannot tell a bubble that will never accept an edit again
  // from one Telegram merely refused THIS minute. Clearing the anchor on the
  // second kind strands the buyer on a stale QR forever, because the anchor is
  // the only thing that puts the order back in this sweep's work queue.
  describe("permanent vs. transient edit failures decide whether the anchor survives", () => {
    /** Both halves of the flip refused with the same answer — which is what a
     *  real outage looks like: flood control, a 5xx or a dead socket rejects
     *  the delete just as readily as the edit, so a transient failure must
     *  leave the bubble untouched AND its anchor in place. */
    const failEveryEditWith = (err: unknown) =>
      fakeApi({
        editMessageText: vi.fn().mockRejectedValue(err),
        deleteMessage: vi.fn().mockRejectedValue(err),
      });

    const anchoredOrder = () =>
      makeSettledAnchoredOrder({
        method: PaymentMethod.TOKOPAY,
        kind: OrderKind.PRODUCT,
        status: OrderStatus.DELIVERED,
      });

    it.each([
      ["Bad Request: message to edit not found"],
      ["Bad Request: message can't be edited"],
      ["Bad Request: MESSAGE_ID_INVALID"],
    ])("clears the anchor when Telegram answers %s — that bubble can never accept this edit", async (description) => {
      const order = await anchoredOrder();
      const api = failEveryEditWith(telegramError(400, description));

      await sweepPaidOrderBubbles(api);

      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.paymentMsgChatId).toBeNull();
      expect(after?.paymentMsgId).toBeNull();
    });

    it("clears the anchor on 'message is not modified' — the bubble already shows the text this sweep wanted to put there", async () => {
      const order = await anchoredOrder();
      const api = failEveryEditWith(telegramError(400, "Bad Request: message is not modified"));

      await sweepPaidOrderBubbles(api);

      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.paymentMsgChatId).toBeNull();
    });

    // The photo/QR bubble, which is what the QRIS rails actually anchor on:
    // the sweep's edit bounces off it, so the bubble is deleted and the
    // success message sent afresh. A replacement is a completed flip, so the
    // anchor goes — it points at a message that no longer exists, and the new
    // message carries no Refresh/Cancel pair that would ever need flipping.
    it("replaces a photo (QR) bubble rather than editing it, and clears the anchor afterwards", async () => {
      const order = await anchoredOrder();
      const api = fakeApi({
        editMessageText: vi.fn().mockRejectedValue(telegramError(400, "Bad Request: there is no text in the message to edit")),
      });

      await sweepPaidOrderBubbles(api);

      expect(api.deleteMessage).toHaveBeenCalledWith(order.chatId, order.msgId);
      const [chatId, text, payload] = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(chatId).toBe(order.chatId);
      expect(String(text)).toContain(order.orderCode);
      expect(String(text)).toContain("being delivered now");
      expect(payload.reply_markup.inline_keyboard.flat().map((b: { callback_data?: string }) => b.callback_data)).toContain("v1:browse:prods");

      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.paymentMsgChatId).toBeNull();
      expect(after?.paymentMsgId).toBeNull();
    });

    // Task E2: a settled WALLET_TOPUP's photo bubble is deleted with NO
    // replacement — the buyer's outbox WALLET_TOPUP_CREDITED_DM already told
    // them, so a replacement bubble here would be the very duplicate this task
    // exists to remove. The anchor still clears: nothing is left to retry.
    it("deletes a settled wallet top-up's photo (QR) bubble and sends nothing in its place, then clears the anchor", async () => {
      const order = await makeSettledAnchoredOrder({
        method: PaymentMethod.TOKOPAY,
        kind: OrderKind.WALLET_TOPUP,
        status: OrderStatus.DELIVERED,
      });
      const api = fakeApi({
        editMessageText: vi.fn().mockRejectedValue(telegramError(400, "Bad Request: there is no text in the message to edit")),
      });

      await sweepPaidOrderBubbles(api);

      expect(api.deleteMessage).toHaveBeenCalledWith(order.chatId, order.msgId);
      expect(api.sendMessage).not.toHaveBeenCalled();

      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.paymentMsgChatId).toBeNull();
      expect(after?.paymentMsgId).toBeNull();
    });

    // Half-replaced is the one outcome that cannot be retried: the QR bubble
    // is already destroyed, so no future edit at that message id can land.
    it("clears the anchor when the photo bubble was deleted but its replacement could not be sent", async () => {
      const order = await anchoredOrder();
      const api = fakeApi({
        editMessageText: vi.fn().mockRejectedValue(telegramError(400, "Bad Request: there is no text in the message to edit")),
        sendMessage: vi.fn().mockRejectedValue(telegramError(429, "Too Many Requests: retry after 30")),
      });

      await sweepPaidOrderBubbles(api);

      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.paymentMsgChatId).toBeNull();
      expect(after?.paymentMsgId).toBeNull();
    });

    it("keeps the anchor when Telegram flood-controls the edit, so the next cycle retries instead of abandoning a live bubble", async () => {
      const order = await anchoredOrder();
      const api = failEveryEditWith(telegramError(429, "Too Many Requests: retry after 30"));

      await sweepPaidOrderBubbles(api);

      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.paymentMsgChatId).not.toBeNull();
      expect(after?.paymentMsgId).not.toBeNull();
    });

    it("keeps the anchor when Telegram answers a server error", async () => {
      const order = await anchoredOrder();
      const api = failEveryEditWith(telegramError(502, "Bad Gateway"));

      await sweepPaidOrderBubbles(api);

      expect((await prisma.order.findUnique({ where: { id: order.id } }))?.paymentMsgChatId).not.toBeNull();
    });

    it("keeps the anchor when the edit fails with something that is not a Telegram API error at all, such as a network fault", async () => {
      const order = await anchoredOrder();
      const api = failEveryEditWith(new Error("socket hang up"));

      await sweepPaidOrderBubbles(api);

      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.paymentMsgChatId).not.toBeNull();
      expect(after?.paymentMsgId).not.toBeNull();
    });

    // A broad flood-control episode fails EVERY edit in the batch at once, so
    // a warning per order was up to MAX_ORDERS_PER_CYCLE near-identical lines
    // a minute for as long as Telegram kept throttling. CLAUDE.md's logging
    // convention says to summarize by count instead.
    it("logs one aggregate warning for the whole sweep rather than one per order when Telegram throttles every edit", async () => {
      for (let i = 0; i < 3; i++) await anchoredOrder();
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
      const api = failEveryEditWith(telegramError(429, "Too Many Requests: retry after 30"));

      await sweepPaidOrderBubbles(api);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("3");
      warn.mockRestore();
    });

    it("retries the same order on the next cycle after a transient failure, and clears it once the edit lands", async () => {
      const order = await anchoredOrder();
      const flooded = failEveryEditWith(telegramError(429, "Too Many Requests: retry after 30"));

      await sweepPaidOrderBubbles(flooded);
      expect((await prisma.order.findUnique({ where: { id: order.id } }))?.paymentMsgId).not.toBeNull();

      const recovered = fakeApi();
      await sweepPaidOrderBubbles(recovered);

      expect(onlyEdit(recovered).msgId).toBe(order.msgId);
      expect((await prisma.order.findUnique({ where: { id: order.id } }))?.paymentMsgId).toBeNull();
    });
  });

  it("ignores an order whose own rail already cleared the anchor on its fast path", async () => {
    const order = await makeSettledAnchoredOrder({
      method: PaymentMethod.BINANCE_INTERNAL,
      kind: OrderKind.PRODUCT,
      status: OrderStatus.DELIVERED,
    });
    await clearOrderPaymentMessage(prisma, order.id);
    const api = fakeApi();

    await sweepPaidOrderBubbles(api);

    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  // Same shape as the black-holed-bubble tests tokopay-reconcile.test.ts used
  // to carry for its own per-rail sweep, before Task T2-F deleted that
  // per-rail sweep in favor of the generic sweepPaidOrderBubbles exercised
  // here: real timers and real Prisma, with millisecond-scale bounds passed
  // in instead of the real 10s/30s ones so the identical give-up/budget-break
  // logic is proven in well under a second.
  describe("safety bounds against a black-holed bubble edit", () => {
    const editTimeoutMs = 200;
    // Deliberately NOT 3 × editTimeoutMs. The loop breaks when the elapsed
    // time is strictly greater than the budget, so an exact 600 would put the
    // third row's break on the wrong side of the comparison and leave the test
    // passing only on scheduling overhead. At 500 the same three rows are
    // wanted with 100ms of slack either way: two hung edits (400ms) stay under
    // the budget and a third (600ms) is comfortably over it.
    const totalBudgetMs = 500;
    const hangingApi = () =>
      ({
        editMessageText: vi.fn(() => new Promise(() => {})),
        deleteMessage: vi.fn(() => new Promise(() => {})),
        sendMessage: vi.fn(),
      }) as unknown as Api;

    it("leaves the anchor in place when a single edit hangs past its per-edit timeout", async () => {
      const order = await makeSettledAnchoredOrder({
        method: PaymentMethod.PAYDISINI,
        kind: OrderKind.PRODUCT,
        status: OrderStatus.DELIVERED,
      });
      const api = hangingApi();

      await sweepPaidOrderBubbles(api, { editTimeoutMs, totalBudgetMs });

      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.paymentMsgChatId).not.toBeNull();
      expect(after?.paymentMsgId).not.toBeNull();
    });

    it("cuts the rest of the batch off once the whole-sweep budget is spent, leaving those anchors in place", async () => {
      const orders = [];
      for (let i = 0; i < 4; i++) {
        orders.push(
          await makeSettledAnchoredOrder({
            method: PaymentMethod.TOKOPAY,
            kind: OrderKind.PRODUCT,
            status: OrderStatus.DELIVERED,
          }),
        );
      }
      const api = hangingApi();

      await sweepPaidOrderBubbles(api, { editTimeoutMs, totalBudgetMs });

      // Three rows each burned ~editTimeoutMs (600ms), which crosses the
      // 500ms totalBudgetMs — so the between-rows budget check breaks the loop
      // before the fourth is ever attempted. Two rows (400ms) are still inside
      // the budget, which is why the count is three and not two.
      expect(api.editMessageText).toHaveBeenCalledTimes(3);
      const fourth = await prisma.order.findUnique({ where: { id: orders[3]!.id } });
      expect(fourth?.paymentMsgChatId).not.toBeNull();
    });
  });
});

/**
 * The order-bot side of the Task E3 payment-bubble flush hook: what
 * `apps/server`'s boot registers via `registerPaymentBubbleFlush`
 * (packages/core/src/nudge.ts) so `packages/outbox-dispatcher` can ask this
 * process to finish flipping an order's payment bubble before it sends that
 * order's settlement DM. `packages/outbox-dispatcher/src/dispatcher.test.ts`
 * covers the generic hook mechanism (a fake registered implementation,
 * proving call order and the defence-in-depth timeout/swallow at that
 * boundary); these tests cover THIS implementation's own behavior — reading
 * the order fresh and flipping it through the same `flipSettledOrderBubble`
 * every other caller uses.
 */
describe("flushSettledOrderBubble (Task E3 payment-bubble flush hook)", () => {
  it("flips a settled order's anchored bubble to its success message and clears the anchor", async () => {
    const order = await makeSettledAnchoredOrder({
      method: PaymentMethod.TOKOPAY,
      kind: OrderKind.PRODUCT,
      status: OrderStatus.DELIVERED,
    });
    const api = fakeApi();

    await flushSettledOrderBubble(api, order.id);

    const edit = onlyEdit(api);
    expect(edit.chatId).toBe(order.chatId);
    expect(edit.msgId).toBe(order.msgId);
    expect(edit.text).toContain(order.orderCode);
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.paymentMsgChatId).toBeNull();
    expect(after?.paymentMsgId).toBeNull();
  });

  it("is a no-op — no Telegram call at all — when the order's own rail already cleared the anchor", async () => {
    const order = await makeSettledAnchoredOrder({
      method: PaymentMethod.BINANCE_INTERNAL,
      kind: OrderKind.PRODUCT,
      status: OrderStatus.DELIVERED,
    });
    await clearOrderPaymentMessage(prisma, order.id);
    const api = fakeApi();

    await flushSettledOrderBubble(api, order.id);

    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("never throws when the order id doesn't exist", async () => {
    const api = fakeApi();
    await expect(flushSettledOrderBubble(api, 999_999_999)).resolves.toBeUndefined();
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("never throws when the edit fails, and leaves the anchor for the background sweep to retry", async () => {
    const order = await makeSettledAnchoredOrder({
      method: PaymentMethod.PAYDISINI,
      kind: OrderKind.PRODUCT,
      status: OrderStatus.DELIVERED,
    });
    const api = fakeApi({
      editMessageText: vi.fn().mockRejectedValue(telegramError(429, "Too Many Requests: retry after 30")),
      deleteMessage: vi.fn().mockRejectedValue(telegramError(429, "Too Many Requests: retry after 30")),
    });

    await expect(flushSettledOrderBubble(api, order.id)).resolves.toBeUndefined();

    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.paymentMsgChatId).not.toBeNull();
  });
});

describe("autoCloseStaleTickets", () => {
  const HOUR = 3_600_000;

  /** A REPLIED ticket whose repliedAt is already past the 48h cutoff. */
  async function makeStaleTicket(userId: number) {
    const ticket = await createTicket(prisma, userId, "help please");
    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: TicketStatus.REPLIED, repliedAt: new Date(Date.now() - 49 * HOUR) },
    });
    return ticket;
  }

  // M-27 fix (backend audit 2026-07-31): closing one stale ticket used to run
  // bare inside the loop (no per-iteration try/catch, only the DM was
  // guarded), so a single row's failure threw out of the whole `for` loop and
  // every other stale ticket in that tick stayed open. This mirrors
  // autoCancelExpiredOrders's per-row try/catch: one failing row is logged
  // and skipped, the rest of the batch still drains.
  it("keeps closing the rest of the batch when one ticket's closure throws", async () => {
    const secondUser = await prisma.user.create({
      data: { telegramId: BigInt(9001), referralCode: "stale-ticket-2", role: "CUSTOMER" },
    });
    const failing = await makeStaleTicket(sample.user.id);
    const healthy = await makeStaleTicket(secondUser.id);
    const api = fakeApi();

    const originalUpdateMany = prisma.supportTicket.updateMany.bind(prisma.supportTicket);
    const spy = vi
      .spyOn(prisma.supportTicket, "updateMany")
      .mockImplementation(((args: { where?: { id?: number } }) => {
        if (args.where?.id === failing.id) {
          return Promise.reject(new Error("simulated write-lock timeout"));
        }
        return originalUpdateMany(args as Parameters<typeof originalUpdateMany>[0]);
      }) as typeof prisma.supportTicket.updateMany);

    await autoCloseStaleTickets(api);
    spy.mockRestore();

    const failingRow = await prisma.supportTicket.findUnique({ where: { id: failing.id } });
    expect(failingRow!.status).toBe(TicketStatus.REPLIED); // untouched — closeTicket threw

    const healthyRow = await prisma.supportTicket.findUnique({ where: { id: healthy.id } });
    expect(healthyRow!.status).toBe(TicketStatus.CLOSED); // still processed despite the earlier failure

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(9001, expect.any(String), expect.anything());
  });
});

describe("drainBroadcasts", () => {
  // Exclude buildSampleData's own telegramId:42 user so each test's recipient
  // count is exactly the users it creates itself.
  beforeEach(async () => {
    await prisma.user.update({ where: { id: sample.user.id }, data: { banned: true } });
  });

  async function addRecipient(telegramId: number) {
    await prisma.user.create({
      data: { telegramId: BigInt(telegramId), referralCode: `r${telegramId}`, role: "CUSTOMER" },
    });
  }

  it("sends plain text via sendMessage when the broadcast has no image", async () => {
    await addRecipient(1001);
    await addRecipient(1002);
    const bc = await createBroadcast(prisma, { message: "hi all", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
    const api = fakeApi();

    await drainBroadcasts(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendPhoto).not.toHaveBeenCalled();
    const done = await prisma.broadcast.findUnique({ where: { id: bc.id } });
    expect(done!.status).toBe("SENT");
    expect(done!.sentCount).toBe(2);
  });

  it("sends a photo via sendPhoto and caches the resolved file_id after the first send", async () => {
    await addRecipient(2001);
    await addRecipient(2002);
    const bc = await createBroadcast(prisma, {
      message: "look at this",
      segment: "ALL",
      scheduledAt: null,
      createdById: null,
      total: 0,
      webImageUrl: "/uploads/broadcasts/broadcast-test.jpg",
    });
    const api = fakeApi();

    await drainBroadcasts(api);

    expect(api.sendPhoto).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).not.toHaveBeenCalled();
    const calls = (api.sendPhoto as ReturnType<typeof vi.fn>).mock.calls;
    // First send resolves a fresh InputFile off disk (not a plain string)...
    expect(typeof calls[0]![1]).not.toBe("string");
    // ...subsequent recipients reuse the cached file_id string.
    expect(calls[1]![1]).toBe("large_fid");
    const done = await prisma.broadcast.findUnique({ where: { id: bc.id } });
    expect(done!.imageFileId).toBe("large_fid");
    expect(done!.status).toBe("SENT");
  });

  it("reuses an already-cached file_id from the very first recipient (resumed run)", async () => {
    await addRecipient(3001);
    const bc = await createBroadcast(prisma, {
      message: "resumed",
      segment: "ALL",
      scheduledAt: null,
      createdById: null,
      total: 0,
      webImageUrl: "/uploads/broadcasts/broadcast-test.jpg",
    });
    await prisma.broadcast.update({ where: { id: bc.id }, data: { imageFileId: "already_cached_fid" } });
    const api = fakeApi();

    await drainBroadcasts(api);

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).toHaveBeenCalledWith(3001, "already_cached_fid", { caption: "resumed" });
  });

  it("counts a sendPhoto failure as failed without aborting remaining recipients", async () => {
    await addRecipient(4001);
    await addRecipient(4002);
    const bc = await createBroadcast(prisma, {
      message: "flaky",
      segment: "ALL",
      scheduledAt: null,
      createdById: null,
      total: 0,
      webImageUrl: "/uploads/broadcasts/broadcast-test.jpg",
    });
    // A real blocked user, i.e. a GrammyError — not a bare Error, which the
    // loop now (correctly) treats as an unexpected non-Telegram failure and
    // logs loudly.
    const sendPhoto = vi.fn()
      .mockRejectedValueOnce(
        new GrammyError(
          "Call to 'sendPhoto' failed!",
          { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
          "sendPhoto",
          {},
        ),
      )
      .mockResolvedValueOnce({ photo: [{ file_id: "fid" }] });
    const api = fakeApi({ sendPhoto });

    await drainBroadcasts(api);

    expect(sendPhoto).toHaveBeenCalledTimes(2);
    const done = await prisma.broadcast.findUnique({ where: { id: bc.id } });
    expect(done!.sentCount).toBe(1);
    expect(done!.failedCount).toBe(1);
  });

  // Sub-item (c): sentCount used to be written exactly once, by
  // finishBroadcast, after the whole loop — so Broadcast History showed a
  // frozen 0 that jumped straight to the final number. The drainer now flushes
  // its running counters every BROADCAST_PROGRESS_FLUSH_EVERY (25) recipients.
  it("flushes running counters to the row every 25 recipients while still SENDING", async () => {
    for (let i = 0; i < 26; i++) await addRecipient(5100 + i);
    const bc = await createBroadcast(prisma, { message: "long one", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });

    // Snapshot the persisted row from INSIDE the send loop: once just before
    // the 25th recipient (no flush yet) and once just before the 26th (the
    // first flush has landed).
    const snapshots: Record<number, { status: string; sentCount: number; failedCount: number }> = {};
    let call = 0;
    const sendMessage = vi.fn(async () => {
      call++;
      if (call === 25 || call === 26) {
        const row = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
        snapshots[call] = { status: row.status, sentCount: row.sentCount, failedCount: row.failedCount };
      }
    });

    await drainBroadcasts(fakeApi({ sendMessage }));

    expect(sendMessage).toHaveBeenCalledTimes(26);
    // Nothing flushed yet at recipient 25 — the counter is still the initial 0.
    expect(snapshots[25]).toEqual({ status: "SENDING", sentCount: 0, failedCount: 0 });
    // ...and the flush after recipient 25 is visible to the admin BEFORE the
    // broadcast finishes, which is the whole point of the change.
    expect(snapshots[26]).toEqual({ status: "SENDING", sentCount: 25, failedCount: 0 });

    // finishBroadcast still writes the authoritative final numbers over it.
    const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
    expect(done.status).toBe("SENT");
    expect(done.sentCount).toBe(26);
    expect(done.totalCount).toBe(26);
  });

  // The flush is cosmetic, but its `await` sits outside every try/catch in the
  // send loop. A SQLITE_BUSY past the client's busy_timeout used to escape
  // drainBroadcasts entirely: the row stayed SENDING, finishBroadcast never
  // ran, and 15 minutes later the reaper marked it FAILED with "the sender
  // process restarted" — a reason that is simply untrue, on a broadcast that
  // silently stopped part-way through its segment.
  it("keeps sending when a mid-flight progress flush fails, rather than aborting the whole broadcast", async () => {
    for (let i = 0; i < 30; i++) await addRecipient(5300 + i);
    const bc = await createBroadcast(prisma, { message: "busy db", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
    dbMockState.progressFlushError = new Error("SQLITE_BUSY: database is locked");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(logger, "warn");

    let flushWarnings: unknown[] = [];
    try {
      await drainBroadcasts(fakeApi({ sendMessage }));
    } finally {
      flushWarnings = warn.mock.calls.filter((c) => String(c[1]).includes("mid-flight progress counters"));
      warn.mockRestore();
    }

    // Every recipient after the failed flush at #25 still got their message.
    expect(sendMessage).toHaveBeenCalledTimes(30);
    // ...and the failure was reported rather than swallowed silently.
    expect(flushWarnings).toHaveLength(1);

    // The broadcast completed normally: SENT with the authoritative final
    // numbers, no stuck SENDING row for the reaper to mislabel.
    const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
    expect(done.status).toBe("SENT");
    expect(done.sentCount).toBe(30);
    expect(done.failedCount).toBe(0);
    expect(done.totalCount).toBe(30);
  });

  // M4: totalCount is stamped at enqueue from a segment count taken then, but
  // the recipient list is only resolved when the drain starts. If the segment
  // grew in between, History showed e.g. 25/2 mid-flight until finishBroadcast
  // corrected it, so the flush writes the live recipient count too.
  it("flushes the live recipient count, so a segment that grew since enqueue can't render a nonsense fraction", async () => {
    for (let i = 0; i < 26; i++) await addRecipient(5400 + i);
    // Enqueued when the segment held only 2 users.
    const bc = await createBroadcast(prisma, { message: "grew", segment: "ALL", scheduledAt: null, createdById: null, total: 2 });

    let midFlight: { sentCount: number; totalCount: number } | null = null;
    let call = 0;
    const sendMessage = vi.fn(async () => {
      call++;
      if (call === 26) {
        const row = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
        midFlight = { sentCount: row.sentCount, totalCount: row.totalCount };
      }
    });

    await drainBroadcasts(fakeApi({ sendMessage }));

    expect(midFlight).toEqual({ sentCount: 25, totalCount: 26 });
  });

  // Sub-item (b): the loop used to `await sleep(40)` flat AFTER the send, so
  // the real rate was 1/(latency + 40ms) rather than the ~25 msg/s the 40ms
  // throttle was sized for. The wait is now the REMAINDER of that budget.
  describe("latency-aware throttle", () => {
    /** Record every sleep the drainer asks for while letting the real timer
     *  run, and drive a virtual clock so a "slow" Telegram call can consume
     *  the send budget without the test actually waiting for it. */
    function instrumentClock() {
      const requested: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      let now = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        requested.push(ms ?? 0);
        // Advance the virtual clock by what was asked for, but fire straight
        // away so the suite doesn't spend real seconds sleeping.
        now += ms ?? 0;
        return realSetTimeout(fn, 0);
      }) as typeof globalThis.setTimeout);
      return {
        requested,
        advance: (ms: number) => { now += ms; },
        restore: () => { timerSpy.mockRestore(); nowSpy.mockRestore(); },
      };
    }

    it("sleeps only the remainder of the 40ms budget after a fast send", async () => {
      await addRecipient(6001);
      await createBroadcast(prisma, { message: "fast", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const clock = instrumentClock();
      // 10ms of latency leaves 30ms of the 40ms budget still to wait out.
      const sendMessage = vi.fn(async () => { clock.advance(10); });

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        clock.restore();
      }

      expect(clock.requested).toEqual([30]);
    });

    it("does not sleep at all when the send already took longer than the budget", async () => {
      await addRecipient(6002);
      await addRecipient(6003);
      await createBroadcast(prisma, { message: "slow", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const clock = instrumentClock();
      // 100ms latency > the 40ms budget: the old flat sleep(40) would have
      // added 40ms on top of each of these, dropping the rate to ~7 msg/s.
      const sendMessage = vi.fn(async () => { clock.advance(100); });

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        clock.restore();
      }

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(clock.requested).toEqual([]);
    });
  });

  // Telegram flood control (429 + retry_after) used to fall into the bare
  // `catch { failed++ }` alongside "user blocked the bot", permanently writing
  // those recipients off with no retry.
  describe("Telegram flood control (retry_after)", () => {
    const floodError = (retryAfter: number) =>
      new GrammyError(
        "Call to 'sendMessage' failed!",
        { ok: false, error_code: 429, description: "Too Many Requests: retry after " + retryAfter, parameters: { retry_after: retryAfter } },
        "sendMessage",
        {},
      );

    /** Fire every sleep immediately but remember how long was asked for. */
    function captureSleeps() {
      const requested: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        requested.push(ms ?? 0);
        return realSetTimeout(fn, 0);
      }) as typeof globalThis.setTimeout);
      return { requested, restore: () => spy.mockRestore() };
    }

    it("waits out retry_after and re-sends to the SAME recipient instead of failing them", async () => {
      await addRecipient(7001);
      const bc = await createBroadcast(prisma, { message: "throttled", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const sendMessage = vi.fn()
        .mockRejectedValueOnce(floodError(2))
        .mockResolvedValueOnce(undefined);
      const sleeps = captureSleeps();

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        sleeps.restore();
      }

      // Same chat id, twice — the retry is a retry, not a skip.
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.calls[0]![0]).toBe(7001);
      expect(sendMessage.mock.calls[1]![0]).toBe(7001);
      // retry_after 2s honoured with the dispatcher's +1s of headroom.
      expect(sleeps.requested).toContain(3000);

      const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
      expect(done.sentCount).toBe(1);
      expect(done.failedCount).toBe(0);
    });

    // `retry_after: 0` ("you may retry immediately") is a real 429. A
    // truthiness check on it read 0 as "not flood control at all" and wrote the
    // recipient off as permanently failed, with no retry.
    it("treats retry_after: 0 as flood control to retry, not as a permanent failure", async () => {
      await addRecipient(7006);
      const bc = await createBroadcast(prisma, { message: "zero wait", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const sendMessage = vi.fn()
        .mockRejectedValueOnce(floodError(0))
        .mockResolvedValueOnce(undefined);
      const sleeps = captureSleeps();

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        sleeps.restore();
      }

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sleeps.requested).toContain(1_000); // 0s + the dispatcher's 1s of headroom
      const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
      expect(done.sentCount).toBe(1);
      expect(done.failedCount).toBe(0);
    });

    it("clamps an absurd retry_after instead of parking the drainer for hours", async () => {
      await addRecipient(7002);
      await createBroadcast(prisma, { message: "hostile", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const sendMessage = vi.fn()
        .mockRejectedValueOnce(floodError(86_400)) // a full day
        .mockResolvedValueOnce(undefined);
      const sleeps = captureSleeps();

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        sleeps.restore();
      }

      // Capped at BROADCAST_MAX_RETRY_AFTER_S (60s) + 1s of headroom.
      expect(Math.max(...sleeps.requested)).toBe(61_000);
    });

    it("gives up on a recipient that is flood-controlled forever, and keeps draining the rest", async () => {
      await addRecipient(7003);
      await addRecipient(7004);
      const bc = await createBroadcast(prisma, { message: "endless", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const sendMessage = vi.fn(async (chatId: number) => {
        if (chatId === 7003) throw floodError(1); // never recovers
      });
      const sleeps = captureSleeps();

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        sleeps.restore();
      }

      // 1 initial attempt + BROADCAST_MAX_FLOOD_RETRIES (3) for 7003, then the
      // loop moves on and delivers to 7004 — it must terminate, not spin.
      expect(sendMessage.mock.calls.filter((c) => c[0] === 7003)).toHaveLength(4);
      expect(sendMessage.mock.calls.filter((c) => c[0] === 7004)).toHaveLength(1);

      const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
      expect(done.status).toBe("SENT");
      expect(done.sentCount).toBe(1);
      expect(done.failedCount).toBe(1);
    });

    // The per-recipient bounds (3 retries, 60s clamp) bound ONE recipient at
    // ~3x61s but do NOT bound the tick: N recipients each paying that is
    // N x 183s, roughly 50 hours for a 1,000-recipient segment, all of it with
    // protect:true holding off every other drain tick and the last 49 of those
    // hours past BROADCAST_STALE_CLAIM_MS, where the row can be reaped as
    // FAILED underneath a send that is still delivering.
    it("stops retrying once the whole broadcast has spent its flood-back-off budget", async () => {
      // 61s clamped back-off each, so the 5-minute budget allows 4 pauses
      // (4x61s = 244s; a 5th would exceed 300s).
      for (let i = 0; i < 8; i++) await addRecipient(7100 + i);
      const bc = await createBroadcast(prisma, { message: "throttled hard", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const sendMessage = vi.fn().mockRejectedValue(floodError(600)); // clamped to 60s
      const sleeps = captureSleeps();

      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        sleeps.restore();
      }

      // Recipient 1 burns 3 retries (3x61s = 183s) and is abandoned; recipient
      // 2 gets one more pause (244s) and then the budget refuses the next one,
      // which cuts the whole broadcast short.
      const floodPauses = sleeps.requested.filter((ms) => ms === 61_000);
      expect(floodPauses).toHaveLength(4);
      expect(floodPauses.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5 * 60_000);
      // Only two recipients were ever contacted; the other six were dropped.
      expect(new Set(sendMessage.mock.calls.map((c) => c[0])).size).toBe(2);

      // Every recipient is still accounted for — the six never attempted are
      // counted as failed, so sent + failed == total and the admin's numbers
      // do not silently lose people.
      //
      // And the row is FAILED, not SENT: a broadcast that never reached part of
      // its segment used to show a green "Sent" badge over 0/8 with the reason
      // living only in a Pino line no shop admin reads. Broadcast History
      // renders failureReason under the badge for FAILED rows, which is what
      // actually tells the admin to re-send.
      const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
      expect(done.status).toBe("FAILED");
      expect(done.failureReason).toContain("6 recipient(s) were never contacted");
      expect(done.failureReason).toMatch(/rate limiting/i);
      expect(done.sentCount).toBe(0);
      expect(done.failedCount).toBe(8);
      expect(done.totalCount).toBe(8);
    }, 20_000);

    // The counters-only write that precedes failBroadcast is as cosmetic as the
    // in-loop flush, and must fail as softly: if it threw, failBroadcast would
    // be skipped and the row would sit SENDING until the reaper relabelled it
    // with the wrong reason — costing the admin exactly the explanation this
    // branch exists to give them.
    it("still records the cut-short reason when the final counter flush fails on a contended write", async () => {
      for (let i = 0; i < 8; i++) await addRecipient(7500 + i);
      const bc = await createBroadcast(prisma, { message: "throttled, busy db", segment: "ALL", scheduledAt: null, createdById: null, total: 8 });
      // Cut short at recipient 2, well before the 25-recipient in-loop flush,
      // so the only flush this test can trip is the cut-short one.
      dbMockState.progressFlushError = new Error("SQLITE_BUSY: database is locked");
      const sendMessage = vi.fn().mockRejectedValue(floodError(600));
      const sleeps = captureSleeps();
      const warn = vi.spyOn(logger, "warn");

      let flushWarnings: unknown[] = [];
      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        sleeps.restore();
        flushWarnings = warn.mock.calls.filter((c) => String(c[1]).includes("final counters before marking itself cut short"));
        warn.mockRestore();
      }

      const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
      expect(done.status).toBe("FAILED");
      expect(done.failureReason).toContain("6 recipient(s) were never contacted");
      expect(flushWarnings).toHaveLength(1);
      // The numbers are what lags behind, not the status or the reason.
      expect(done.sentCount).toBe(0);
    }, 20_000);

    it("logs the flood pause once per broadcast rather than once per back-off", async () => {
      await addRecipient(7200);
      await addRecipient(7201);
      await createBroadcast(prisma, { message: "noisy", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      // Both recipients flood-control twice before succeeding: 4 back-offs.
      const sendMessage = vi.fn()
        .mockRejectedValueOnce(floodError(1)).mockRejectedValueOnce(floodError(1)).mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(floodError(1)).mockRejectedValueOnce(floodError(1)).mockResolvedValueOnce(undefined);
      const warn = vi.spyOn(logger, "warn");
      const sleeps = captureSleeps();

      let floodWarnings: unknown[] = [];
      try {
        await drainBroadcasts(fakeApi({ sendMessage }));
      } finally {
        sleeps.restore();
        // Read the recorded calls BEFORE restoring — mockRestore() clears them.
        floodWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("flood-controlled"));
        warn.mockRestore();
      }

      // Four back-offs actually happened...
      expect(sleeps.requested.filter((ms) => ms === 2_000)).toHaveLength(4);
      // ...and produced exactly one log line between them.
      expect(floodWarnings).toHaveLength(1);
    });

    it("still fails a non-flood error immediately, with no retry", async () => {
      await addRecipient(7005);
      const bc = await createBroadcast(prisma, { message: "blocked", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const sendMessage = vi.fn().mockRejectedValue(
        new GrammyError(
          "Call to 'sendMessage' failed!",
          { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
          "sendMessage",
          {},
        ),
      );

      await drainBroadcasts(fakeApi({ sendMessage }));

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
      expect(done.failedCount).toBe(1);
    });

    // A failure that is NOT a Telegram API error is the signature of the one
    // way this loop can miscount a DELIVERED message as failed: the file_id
    // cache write inside `deliver` throwing after a successful sendPhoto. The
    // miscount is left as-is, but it must not be invisible in production.
    it("logs a non-Telegram failure with its error object, unlike an ordinary blocked user", async () => {
      await addRecipient(7300);
      await createBroadcast(prisma, { message: "db trouble", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const cause = new Error("SQLITE_BUSY: database is locked");
      const warn = vi.spyOn(logger, "warn");

      await drainBroadcasts(fakeApi({ sendMessage: vi.fn().mockRejectedValue(cause) }));

      const lines = warn.mock.calls.filter((c) => String(c[1]).includes("not a Telegram API error"));
      expect(lines).toHaveLength(1);
      expect((lines[0]![0] as { err: unknown }).err).toBe(cause);
      warn.mockRestore();
    });

    it("does not log a line per recipient for ordinary blocked users", async () => {
      for (let i = 0; i < 3; i++) await addRecipient(7400 + i);
      await createBroadcast(prisma, { message: "all blocked", segment: "ALL", scheduledAt: null, createdById: null, total: 0 });
      const blocked = new GrammyError(
        "Call to 'sendMessage' failed!",
        { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
        "sendMessage",
        {},
      );
      const warn = vi.spyOn(logger, "warn");

      await drainBroadcasts(fakeApi({ sendMessage: vi.fn().mockRejectedValue(blocked) }));

      expect(warn.mock.calls.filter((c) => String(c[1]).includes("could not deliver"))).toHaveLength(0);
      warn.mockRestore();
    });
  });
});

describe("announceStartedFlashSales", () => {
  const HOUR = 3_600_000;

  /** A second SKU under the sample product, so a test can hold several sales. */
  async function makeDenomination(name: string, isActive = true) {
    return prisma.denomination.create({
      data: {
        productId: sample.parentProduct.id,
        name,
        slug: `slug-${name}-${Math.random()}`,
        type: "SHARED",
        durationLabel: "1 Month",
        price: "50000",
        isActive,
      },
    });
  }

  function scheduleFlash(id: number, startsAt: Date, endsAt: Date) {
    return prisma.denomination.update({
      where: { id },
      data: {
        // Central IDR (the fixture's default 5.00 is a USDT-era leftover) so
        // the announced price is a realistic Rupiah figure.
        price: "50000",
        flashDiscountPercent: "25",
        flashStartsAt: startsAt,
        flashEndsAt: endsAt,
        flashAnnouncedAt: null,
      },
    });
  }

  const flashRows = () =>
    prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.FLASH_SALE_BROADCAST } });

  it("announces a started sale once, and the flashAnnouncedAt guard stops the next tick re-sending it", async () => {
    const now = Date.now();
    await scheduleFlash(sample.product.id, new Date(now - HOUR), new Date(now + HOUR));

    await announceStartedFlashSales();
    const afterFirst = await flashRows();
    expect(afterFirst.length).toBe(1); // one recipient: the sample user
    const payload = JSON.parse(afterFirst[0]!.payloadJson) as {
      chat_id: number;
      product_name: string;
      denomination_name: string;
      discount_percent: string;
      new_price: string;
    };
    expect(payload.chat_id).toBe(42);
    expect(payload.product_name).toBe(sample.parentProduct.name);
    expect(payload.denomination_name).toBe(sample.product.name);
    expect(payload.discount_percent).toBe("25");
    expect(payload.new_price).toBe("Rp37.500");

    const stamped = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(stamped!.flashAnnouncedAt).not.toBeNull();

    await announceStartedFlashSales();
    expect((await flashRows()).length).toBe(1); // still exactly one batch
    expect(await prisma.broadcast.count()).toBe(1);
  });

  // H-7 fix (backend audit 2026-07-31): the `flashAnnouncedAt` claim and the
  // customer fan-out used to share one `$transaction`, holding SQLite's
  // single writer lock for however long the whole-customer-base enqueue
  // took. They're now two phases — a short claim transaction, then a
  // chunked enqueue outside any transaction — and this test's job is to
  // prove that split still delivers to a customer base large enough to need
  // multiple chunks (500 rows/chunk internally), and that the claim alone
  // still correctly stops a second run from double-sending to any of them.
  it("announces a started sale to a large customer base across the two-phase claim-then-chunked-enqueue, still stamping flashAnnouncedAt so a re-run doesn't double-send", async () => {
    const now = Date.now();
    await scheduleFlash(sample.product.id, new Date(now - HOUR), new Date(now + HOUR));
    const EXTRA_RECIPIENTS = 1100; // comfortably more than one 500-row chunk
    await prisma.user.createMany({
      data: Array.from({ length: EXTRA_RECIPIENTS }, (_, i) => ({
        telegramId: BigInt(8_000_000 + i),
        referralCode: `flash-job-${i}`,
        banned: false,
      })),
    });
    const expectedRecipients = EXTRA_RECIPIENTS + 1; // + the sample user (telegramId 42)

    await announceStartedFlashSales();

    const afterFirst = await flashRows();
    expect(afterFirst.length).toBe(expectedRecipients);
    const broadcastRow = await prisma.broadcast.findFirst({ orderBy: { id: "desc" } });
    expect(broadcastRow!.totalCount).toBe(expectedRecipients);

    const stamped = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(stamped!.flashAnnouncedAt).not.toBeNull();

    // Re-run: the claim (not the enqueue) is what prevents a double-send, so
    // this must still hold even though the fan-out is no longer in the same
    // transaction as the claim.
    await announceStartedFlashSales();
    expect((await flashRows()).length).toBe(expectedRecipients);
    expect(await prisma.broadcast.count()).toBe(1);
  });

  it("skips sales that have not started yet, have already ended, or sit on an inactive SKU", async () => {
    const now = Date.now();
    const future = await makeDenomination("not-yet");
    await scheduleFlash(future.id, new Date(now + HOUR), new Date(now + 2 * HOUR));
    const ended = await makeDenomination("already-over");
    await scheduleFlash(ended.id, new Date(now - 2 * HOUR), new Date(now - HOUR));
    const inactive = await makeDenomination("inactive", false);
    await scheduleFlash(inactive.id, new Date(now - HOUR), new Date(now + HOUR));

    await announceStartedFlashSales();

    expect(await flashRows()).toEqual([]);
    expect(await prisma.broadcast.count()).toBe(0);
    for (const id of [future.id, ended.id, inactive.id]) {
      const row = await prisma.denomination.findUnique({ where: { id } });
      expect(row!.flashAnnouncedAt).toBeNull();
    }
  });
});

// Bot-5 (security audit, 2026-06-23): a slow tick (or a restart racing the
// next scheduled fire) must not overlap with itself and re-process the same
// expired-orders/stale-tickets set, sending duplicate DMs.
describe("scheduleJobs cron registration (Bot-5 fix)", () => {
  it("registers autoCancelExpiredOrders and autoCloseStaleTickets with protect:true", () => {
    // Indices match scheduleJobs' literal array order in src/jobs/index.ts:
    // [autoCancelExpiredOrders, autoCloseStaleTickets, reconcileFinancesJob,
    //  binancePollWatchdog, bybitPollWatchdog, bybitBscPollWatchdog,
    //  tokopayPollWatchdog, paydisiniPollWatchdog, nowpaymentsPollWatchdog,
    //  drainBroadcasts, announceStartedFlashSales, storageCleanupJob,
    //  cleanupProcessedTelegramUpdatesJob, cleanupExpiredBotSessionsJob].
    const crons = scheduleJobs(fakeApi());
    try {
      expect(crons[0]!.getPattern()).toBe("*/1 * * * *"); // autoCancelExpiredOrders
      expect(crons[0]!.options.protect).toBe(true);
      expect(crons[1]!.getPattern()).toBe("0 * * * *"); // autoCloseStaleTickets
      expect(crons[1]!.options.protect).toBe(true);
      // reconcileFinancesJob + the six poller watchdogs (M-26 fix, backend
      // audit 2026-07-31): these were the one group in this list missing
      // protect:true, letting a slow Telegram call overlap the next tick and
      // double-page admins on the same incident.
      expect(crons[2]!.getPattern()).toBe("0 */6 * * *"); // reconcileFinancesJob
      expect(crons[2]!.options.protect).toBe(true);
      expect(crons[3]!.getPattern()).toBe("*/2 * * * *"); // binancePollWatchdog
      expect(crons[3]!.options.protect).toBe(true);
      expect(crons[4]!.getPattern()).toBe("*/2 * * * *"); // bybitPollWatchdog
      expect(crons[4]!.options.protect).toBe(true);
      expect(crons[5]!.getPattern()).toBe("*/2 * * * *"); // bybitBscPollWatchdog
      expect(crons[5]!.options.protect).toBe(true);
      // The three QRIS/IDR watchdogs (Task 12) — each on its own second
      // (:15/:17/:19) of every even minute, so none of them shares a
      // SQLite write-lock instant with the crypto three above (implicitly
      // second 0) or with each other.
      expect(crons[6]!.getPattern()).toBe("15 */2 * * * *"); // tokopayPollWatchdog
      expect(crons[6]!.options.protect).toBe(true);
      expect(crons[7]!.getPattern()).toBe("17 */2 * * * *"); // paydisiniPollWatchdog
      expect(crons[7]!.options.protect).toBe(true);
      expect(crons[8]!.getPattern()).toBe("19 */2 * * * *"); // nowpaymentsPollWatchdog
      expect(crons[8]!.options.protect).toBe(true);
      // drainBroadcasts — four ticks a minute so a queued broadcast starts
      // within ~15s instead of up to a full minute, on seconds that dodge both
      // second 0 (autoCancelExpiredOrders and the hourly/6-hourly jobs) and
      // second 40 (announceStartedFlashSales) so they never contend for
      // SQLite's single write-lock in the same instant; still protected.
      // "*/15" is deliberately NOT used — it would put a tick back on second 0.
      expect(crons[9]!.getPattern()).toBe("5,20,35,50 * * * * *");
      expect(crons[9]!.options.protect).toBe(true);
      // announceStartedFlashSales — offset to :40 past the minute for the same
      // reason, protected so an overlapping tick can't race the
      // flashAnnouncedAt stamp.
      expect(crons[10]!.getPattern()).toBe("40 * * * * *");
      expect(crons[10]!.options.protect).toBe(true);
      // storageCleanupJob — once daily, off-peak (03:15), well clear of every
      // other job's minutely/hourly ticks.
      expect(crons[11]!.getPattern()).toBe("30 15 3 * * *");
      expect(crons[11]!.options.protect).toBe(true);
      // cleanupProcessedTelegramUpdatesJob (Task 1, Phase D) — same daily
      // off-peak slot as storageCleanupJob just above, one minute later and
      // on a distinct second (10) so it never shares a firing second with
      // any other registered job.
      expect(crons[12]!.getPattern()).toBe("10 16 3 * * *");
      expect(crons[12]!.options.protect).toBe(true);
      // cleanupExpiredBotSessionsJob (Task 2, Phase D) — same daily off-peak
      // slot, on second 45 (NOT 20 — drainBroadcasts already fires every
      // minute at :20, so that second would be a genuine collision at
      // 03:16:20, not just a test-flagged one) so it never shares a firing
      // second with any other registered job.
      expect(crons[13]!.getPattern()).toBe("45 16 3 * * *");
      expect(crons[13]!.options.protect).toBe(true);
      // sweepPaidOrderBubbles (T2-E) — every minute, but on second 25: it
      // writes up to MAX_ORDERS_PER_CYCLE anchor-clearing rows back to back,
      // exactly the profile behind the P1008/P2028 write-lock pile-up on
      // second 0 (2026-07-20). :25 is ≥5s clear of every other second in this
      // list (0, 5/20/35/50, 40, 15/17/19, 30, 10, 45).
      expect(crons[14]!.getPattern()).toBe("25 * * * * *");
      expect(crons[14]!.options.protect).toBe(true);

      // The write-lock collision guard itself, rather than just the literal
      // patterns above: no second-resolution job may share a firing second
      // with another, and none may land on second 0 where every
      // minute/hour-resolution job in this list fires (P1008/P2028 in
      // production, 2026-07-20). Derived from the whole registered list rather
      // than a hand-picked pair, so a newly added (or re-timed) second-
      // resolution job — storageCleanupJob's "30 15 3 * * *" is already a third
      // one — is covered the moment it appears.
      const secondsOf = (pattern: string) => {
        const fields = pattern.split(" ");
        // 5 fields = minute resolution, i.e. it always fires on second 0 and is
        // covered by the "must not contain 0" rule applied to the others.
        return fields.length >= 6 ? fields[0]!.split(",").map(Number) : null;
      };
      const secondResolution = crons
        .map((c) => ({ pattern: c.getPattern()!, seconds: secondsOf(c.getPattern()!) }))
        .filter((c): c is { pattern: string; seconds: number[] } => c.seconds !== null);
      expect(secondResolution.length).toBeGreaterThanOrEqual(3);
      for (const job of secondResolution) {
        // A wildcard ("*", "*/15") parses to NaN here and is rejected: both
        // would put a tick back on second 0.
        expect(job.seconds.every(Number.isInteger)).toBe(true);
        expect(job.seconds).not.toContain(0);
      }
      for (let a = 0; a < secondResolution.length; a++) {
        for (let b = a + 1; b < secondResolution.length; b++) {
          const shared = secondResolution[a]!.seconds.filter((s) => secondResolution[b]!.seconds.includes(s));
          expect(shared).toEqual([]);
        }
      }
    } finally {
      for (const c of crons) c.stop();
    }
  });
});

// M-26 fix (backend audit 2026-07-31): binancePollWatchdog (and its Bybit /
// Bybit-BSC twins, which share the exact same shape) used to write its
// "already alerted" flag only AFTER the admin DM loop finished. That left a
// window — a slow Telegram call, or an overlapping tick before `protect:
// true` was added to the Cron registration above — where a second run still
// read the flag as unset and paged every admin again for the same incident.
// croner's `protect: true` (asserted above) is the scheduler-level guard;
// these tests exercise the OTHER half of the fix directly — the flag write
// itself now happens before the loop starts, not just before it finishes —
// since croner's internal overlap lock isn't something a unit test can
// trigger without a real timer-based race.
describe("binancePollWatchdog alert-flag ordering (M-26 fix)", () => {
  const STALE_MS = 10 * 60_000; // > POLL_STALE_MINUTES (5), well into "alert"

  /** Enable the Binance Internal method and stamp a stale (unhealthy) heartbeat. */
  async function makeUnhealthy() {
    await setSetting(prisma, BINANCE_UID_KEY, "12345");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "test-key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "test-secret");
    await setSetting(
      prisma,
      BINANCE_POLL_HEALTH_KEY,
      JSON.stringify({ lastRun: new Date(Date.now() - STALE_MS).toISOString(), backoffUntil: null, consecutiveFailures: 0 }),
    );
  }

  it("writes the alert flag before the admin DM loop, so an invocation that overlaps mid-loop already sees it and sends nothing", async () => {
    await makeUnhealthy();
    // ADMIN_IDS is "999,1000" (test/setup-db.ts) — two admins to page.
    const flagSeenDuringEachDm: (string | null)[] = [];
    const nestedApi = fakeApi();
    let nestedTriggered = false;
    const api = fakeApi({
      sendMessage: vi.fn(async () => {
        flagSeenDuringEachDm.push(await getSetting(prisma, "binance_poll_alert_sent"));
        if (!nestedTriggered) {
          nestedTriggered = true;
          // Simulate a second tick firing while this run is still mid-loop —
          // exactly what `protect: true` on the Cron registration now stops
          // in production. Calling the job function directly here proves the
          // flag write ALONE (independent of the scheduler lock) also stops
          // it from re-alerting.
          await binancePollWatchdog(nestedApi);
        }
        return undefined;
      }),
    });

    await binancePollWatchdog(api);

    expect(flagSeenDuringEachDm).toEqual(["1", "1"]); // already "1" for every DM, including the very first
    expect(api.sendMessage).toHaveBeenCalledTimes(2); // both admins paged once by the original run
    expect(nestedApi.sendMessage).not.toHaveBeenCalled(); // the overlapping run saw alerted=true and paged no one
  });

  it("does not re-alert on the next tick after a run whose DM loop had a failure partway through", async () => {
    await makeUnhealthy();
    const firstRunApi = fakeApi({
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce(undefined) // admin 999: delivered
        .mockRejectedValueOnce(new Error("bot was blocked by this admin")), // admin 1000: failed, caught per-admin
    });

    await binancePollWatchdog(firstRunApi);
    expect(firstRunApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(await getSetting(prisma, "binance_poll_alert_sent")).toBe("1");

    // Next tick, still unhealthy (heartbeat untouched) — must see the flag
    // already set and skip alerting entirely, not just skip the admin who
    // already got the DM.
    const secondRunApi = fakeApi();
    await binancePollWatchdog(secondRunApi);
    expect(secondRunApi.sendMessage).not.toHaveBeenCalled();
  });
});

// Task 5 (payment-health-hardening): pollWatchdogDecision is now derived from
// evaluatePollHealth (packages/core/src/payments/pollHealth.ts), whose
// "yellow" status treats a single failed cycle as a warning the ops UI
// surfaces, not an outage — the poller is still running on schedule. This
// pins that the watchdog (the consumer that actually pages admins) still
// stays silent for that same case after the rebase.
describe("binancePollWatchdog does not page for a single failed cycle (Task 5)", () => {
  it("the watchdog does not page for a single failed cycle, which the ops UI shows as a warning", async () => {
    await setSetting(prisma, BINANCE_UID_KEY, "12345");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "test-key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "test-secret");
    await setSetting(
      prisma,
      BINANCE_POLL_HEALTH_KEY,
      JSON.stringify({ lastRun: new Date().toISOString(), backoffUntil: null, consecutiveFailures: 1 }),
    );
    const api = fakeApi();

    await binancePollWatchdog(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await getSetting(prisma, "binance_poll_alert_sent")).not.toBe("1");
  });
});

// Important #1 (Task 12 review follow-up): Binance's poller IS its only
// auto-confirm path, so its DM correctly keeps the original "Auto-confirm is
// paused" tail — pinned here as a regression guard alongside the TokoPay test
// above (Task 12), which proves the QRIS rails now say something different
// and true instead.
describe("binancePollWatchdog admin DM wording (Important #1 regression guard)", () => {
  it("still tells admins auto-confirm is paused — Binance's poller is its only auto-confirm path", async () => {
    await setSetting(prisma, BINANCE_UID_KEY, "12345");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "test-key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "test-secret");
    await setSetting(
      prisma,
      BINANCE_POLL_HEALTH_KEY,
      JSON.stringify({ lastRun: new Date(Date.now() - 20 * 60_000).toISOString(), backoffUntil: null, consecutiveFailures: 0 }),
    );
    const api = fakeApi();

    await binancePollWatchdog(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const dm = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(dm).toContain("Auto-confirm is paused — check the order-bot process.");
  });
});

// Task 12 (payment-health-hardening): TokoPay/PayDisini/NOWPayments are the
// three QRIS/IDR "safety net" reconcile pollers Task 11 gave heartbeats to —
// until now nothing read them, so a rail whose webhook callback was never
// reachable AND whose reconcile poller had also died left orders piling up
// PENDING_PAYMENT with no one paged (docs/TROUBLESHOOTING.md's "webhook
// gateway tidak pernah sampai" scenario). These pollers make up to 50
// sequential gateway calls per cycle, so their own cycleTimeoutMs (~780s for
// all three, TokoPay/PayDisini/NOWPayments alike) is already well past the
// crypto rails' 5-minute staleness default — a legitimately slow (not
// hung) cycle must not trip a watchdog sized for the crypto rails' much
// lighter cadence.
describe("tokopayPollWatchdog (Task 12)", () => {
  async function setTokopayCreds() {
    await setSetting(prisma, TOKOPAY_MERCHANT_KEY, "merchant-1");
    await setSetting(prisma, TOKOPAY_SECRET_KEY, "secret-1");
  }

  async function stampTokopayHealth(ageMs: number, overrides: Partial<{ consecutiveFailures: number; backoffUntil: string | null }> = {}) {
    const at = new Date(Date.now() - ageMs).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.tokopay,
      JSON.stringify({
        lastRun: at,
        lastSuccessAt: at,
        lastTxCount: 0,
        backoffUntil: overrides.backoffUntil ?? null,
        consecutiveRateLimitHits: 0,
        lastRateLimitAt: null,
        consecutiveFailures: overrides.consecutiveFailures ?? 0,
        lastError: null,
      }),
    );
  }

  it("pages admins once when the TokoPay reconcile poller has not completed a cycle in over five minutes", async () => {
    await setTokopayCreds();
    // 20 minutes — comfortably stale under any reasonable threshold,
    // including TokoPay's own widened one (see the next test).
    await stampTokopayHealth(20 * 60_000);
    const api = fakeApi();

    await tokopayPollWatchdog(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2); // both admins paged once
    expect(await getSetting(prisma, "tokopay_poll_alert_sent")).toBe("1");
    // Important #1 (Task 12 review follow-up): the DM used to end with the
    // crypto rails' "Auto-confirm is paused" line, which is FALSE for TokoPay
    // — the storefront webhook is its primary delivery path and keeps
    // delivering independently of this poller. The DM must say so, and must
    // NOT claim auto-confirm is paused.
    const dm = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(dm).toContain("Auto-confirm is NOT paused");
    expect(dm).toContain("gateway's webhook");
    expect(dm).not.toContain("Auto-confirm is paused —");
  });

  it("does not page for a cycle older than 5 minutes but still within TokoPay's own wider staleness window", async () => {
    // TokoPay's cycleTimeoutMs is ~780s (~13m) because one cycle can make
    // up to 50 sequential gateway calls — a cycle that finishes at, say, 10
    // minutes is unremarkable, not a hang. Using the crypto rails' flat
    // 5-minute threshold here would page admins on ordinary slowness.
    await setTokopayCreds();
    await stampTokopayHealth(10 * 60_000);
    const api = fakeApi();

    await tokopayPollWatchdog(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await getSetting(prisma, "tokopay_poll_alert_sent")).not.toBe("1");
  });

  // Minor #4 (Task 12 review follow-up): the two staleness tests above sit
  // 3m40s below and 6m20s above TokoPay's actual widened boundary
  // (TOKOPAY_POLL_STALE_MS) — comfortably wide of it, so a wrong-signed
  // margin, an omitted margin, or a copy-pasted NOWPayments threshold would
  // all still pass both unchanged. These two pin the boundary itself: the
  // "just inside" age sits strictly between the raw cycleTimeoutMs
  // (TOKOPAY_CYCLE_TIMEOUT_MS) and the real widened threshold
  // (TOKOPAY_POLL_STALE_MS) — any of those three bugs collapses the
  // effective threshold back down to at or below cycleTimeoutMs, which would
  // flip this from "no page" to "page".
  it("does not page for a cycle just inside TokoPay's widened staleness margin (boundary pin)", async () => {
    await setTokopayCreds();
    const margin = TOKOPAY_POLL_STALE_MS - TOKOPAY_CYCLE_TIMEOUT_MS;
    await stampTokopayHealth(TOKOPAY_POLL_STALE_MS - Math.floor(margin / 2));
    const api = fakeApi();

    await tokopayPollWatchdog(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await getSetting(prisma, "tokopay_poll_alert_sent")).not.toBe("1");
  });

  it("pages once a cycle is older than TokoPay's own widened staleness threshold (boundary pin)", async () => {
    await setTokopayCreds();
    await stampTokopayHealth(TOKOPAY_POLL_STALE_MS + 5_000);
    const api = fakeApi();

    await tokopayPollWatchdog(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(await getSetting(prisma, "tokopay_poll_alert_sent")).toBe("1");
  });

  it("clears the TokoPay alert state on recovery", async () => {
    await setTokopayCreds();
    await setSetting(prisma, "tokopay_poll_alert_sent", "1");
    await stampTokopayHealth(0); // fresh/healthy
    const api = fakeApi();

    await tokopayPollWatchdog(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await getSetting(prisma, "tokopay_poll_alert_sent")).toBe("0");
  });

  it("stays silent while TokoPay has no credentials configured", async () => {
    // No TOKOPAY_MERCHANT_KEY/TOKOPAY_SECRET_KEY set at all — even a
    // fabricated, badly-stale heartbeat must not page.
    await stampTokopayHealth(60 * 60_000);
    const api = fakeApi();

    await tokopayPollWatchdog(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await getSetting(prisma, "tokopay_poll_alert_sent")).not.toBe("1");
  });

  // Minor #5 (Task 12 review follow-up): this used to hand-write a fresh
  // heartbeat via stampTokopayHealth(0) and never call pollOnce at all — so it
  // proved only that the watchdog reads a healthy heartbeat as healthy
  // (already covered elsewhere), not that the no-pending-orders path in
  // tokopayReconcile.ts's pollOnce actually WRITES that heartbeat. Driving it
  // through the real pollOnce (empty pending list — no orders exist in this
  // test's DB at all) closes that gap.
  it("stays silent for a quiet, healthy shop — credentials configured, no pending orders", async () => {
    await setTokopayCreds();
    await tokopayPollOnce(fakeApi());
    const api = fakeApi();

    await tokopayPollWatchdog(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await getSetting(prisma, "tokopay_poll_alert_sent")).not.toBe("1");
  });
});

// PayDisini/NOWPayments wiring — same generic pollWatchdog as TokoPay above
// (Task 12), so these prove the credential gate and alert-key are wired to
// the right rail rather than re-testing the shared decision logic.
describe("paydisiniPollWatchdog / nowpaymentsPollWatchdog wiring (Task 12)", () => {
  it("pages admins once when the PayDisini reconcile poller has not completed a cycle in over its staleness window", async () => {
    await setSetting(prisma, PAYDISINI_USERKEY_KEY, "userkey-1");
    await setSetting(prisma, PAYDISINI_APIKEY_KEY, "apikey-1");
    const at = new Date(Date.now() - 20 * 60_000).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.paydisini,
      JSON.stringify({
        lastRun: at,
        lastSuccessAt: at,
        lastTxCount: 0,
        backoffUntil: null,
        consecutiveRateLimitHits: 0,
        lastRateLimitAt: null,
        consecutiveFailures: 0,
        lastError: null,
      }),
    );
    const api = fakeApi();

    await paydisiniPollWatchdog(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(await getSetting(prisma, "paydisini_poll_alert_sent")).toBe("1");
  });

  it("stays silent while PayDisini has no credentials configured", async () => {
    const api = fakeApi();

    await paydisiniPollWatchdog(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("pages admins once when the NOWPayments reconcile poller has not completed a cycle in over its staleness window", async () => {
    await setSetting(prisma, NOWPAYMENTS_API_KEY_KEY, "apikey-1");
    await setSetting(prisma, NOWPAYMENTS_IPN_SECRET_KEY, "ipnsecret-1");
    const at = new Date(Date.now() - 20 * 60_000).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.nowpayments,
      JSON.stringify({
        lastRun: at,
        lastSuccessAt: at,
        lastTxCount: 0,
        backoffUntil: null,
        consecutiveRateLimitHits: 0,
        lastRateLimitAt: null,
        consecutiveFailures: 0,
        lastError: null,
      }),
    );
    const api = fakeApi();

    await nowpaymentsPollWatchdog(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(await getSetting(prisma, "nowpayments_poll_alert_sent")).toBe("1");
  });

  it("stays silent while NOWPayments has no credentials configured", async () => {
    const api = fakeApi();

    await nowpaymentsPollWatchdog(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  // Minor #4 (Task 12 review follow-up), rewritten (payment-confirmation-
  // refresh review, Finding 1): this used to page at
  // "NOWPAYMENTS_POLL_STALE_MS + half the gap to TOKOPAY_POLL_STALE_MS", on
  // the premise that NOWPayments' threshold was narrower than TokoPay's. That
  // premise held only while TokoPay/PayDisini's cycle-timeout carried an
  // extra per-rail sweep term NOWPayments never had; Task T2-F deleted that
  // per-rail sweep (`sweepDeliveredAwaitingEdit`), so
  // TOKOPAY_RECONCILE_CYCLE_TIMEOUT_MS and NOWPAYMENTS_RECONCILE_CYCLE_TIMEOUT_MS
  // (and therefore TOKOPAY_POLL_STALE_MS and NOWPAYMENTS_POLL_STALE_MS) are
  // now numerically identical. "Half the gap" is now zero, so the old test
  // asked for an age exactly ON the boundary and only passed because a few
  // milliseconds of real wall-clock time elapse between the `setSetting`
  // calls above and `evaluatePollHealth`'s `>` comparison — a timing
  // accident, not a proof, and one that can no longer distinguish "reads its
  // own constant" from "reads TokoPay's" since both constants are the same
  // number today.
  //
  // No runtime comparison between the two rails' ages can prove that
  // discrimination while their thresholds happen to coincide — instead, pin
  // NOWPayments' own boundary directly against ITS OWN derivation
  // (NOWPAYMENTS_POLL_STALE_MS = NOWPAYMENTS_CYCLE_TIMEOUT_MS + margin), the
  // same way the TokoPay boundary-pin pair above pins TokoPay's. This proves
  // nowpaymentsPollWatchdog's staleMs really is NOWPAYMENTS_POLL_STALE_MS
  // (not some other value), and stays meaningful even if the two rails'
  // numbers diverge again in the future.
  it("does not page for a cycle just inside NOWPayments' own widened staleness margin (boundary pin)", async () => {
    await setSetting(prisma, NOWPAYMENTS_API_KEY_KEY, "apikey-1");
    await setSetting(prisma, NOWPAYMENTS_IPN_SECRET_KEY, "ipnsecret-1");
    const margin = NOWPAYMENTS_POLL_STALE_MS - NOWPAYMENTS_CYCLE_TIMEOUT_MS;
    const at = new Date(Date.now() - (NOWPAYMENTS_POLL_STALE_MS - Math.floor(margin / 2))).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.nowpayments,
      JSON.stringify({
        lastRun: at,
        lastSuccessAt: at,
        lastTxCount: 0,
        backoffUntil: null,
        consecutiveRateLimitHits: 0,
        lastRateLimitAt: null,
        consecutiveFailures: 0,
        lastError: null,
      }),
    );
    const api = fakeApi();

    await nowpaymentsPollWatchdog(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await getSetting(prisma, "nowpayments_poll_alert_sent")).not.toBe("1");
  });

  it("pages once a cycle is older than NOWPayments' own widened staleness threshold (boundary pin)", async () => {
    await setSetting(prisma, NOWPAYMENTS_API_KEY_KEY, "apikey-1");
    await setSetting(prisma, NOWPAYMENTS_IPN_SECRET_KEY, "ipnsecret-1");
    const at = new Date(Date.now() - (NOWPAYMENTS_POLL_STALE_MS + 5_000)).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.nowpayments,
      JSON.stringify({
        lastRun: at,
        lastSuccessAt: at,
        lastTxCount: 0,
        backoffUntil: null,
        consecutiveRateLimitHits: 0,
        lastRateLimitAt: null,
        consecutiveFailures: 0,
        lastError: null,
      }),
    );
    const api = fakeApi();

    await nowpaymentsPollWatchdog(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(await getSetting(prisma, "nowpayments_poll_alert_sent")).toBe("1");
  });
});

/**
 * Task 15 (I-3, fresh backend audit 2026-08-21): the outbox dispatcher is the
 * sole delivery path for every buyer credential DM and every admin alert this
 * codebase enqueues, but unlike the six payment reconcile pollers above it had
 * no watchdog at all — a bad notifier token or an unhandled exception class
 * silently stopped all Telegram delivery with nothing but one log line, no
 * admin ever told. `outboxDispatcherPollWatchdog` is the seventh rail wrapper
 * around the same shared `pollWatchdog`, but `isEnabled` is hardcoded to
 * `async () => true` — always armed, unlike the six credential-gated rails
 * above — since whether a notifier token is configured at all is a decision
 * apps/server makes, not this module (see scheduleOutboxDispatcherWatchdog's
 * own doc-comment for the full reasoning and why its Cron registration lives
 * in apps/server/src/index.ts instead of scheduleJobs here).
 */
describe("outboxDispatcherPollWatchdog (Task 15 / I-3)", () => {
  it("pages admins once when the outbox dispatcher has never recorded a heartbeat (never run)", async () => {
    // No POLL_HEALTH_KEYS.outbox setting written at all — getPollHealth
    // returns the all-null "never run" shape, which evaluatePollHealth's own
    // Rule 3 always pages on (see packages/core/src/payments/pollHealth.ts).
    const api = fakeApi();

    await outboxDispatcherPollWatchdog(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2); // both admins paged once
    expect(await getSetting(prisma, "outbox_watchdog_alerted")).toBe("1");
    const dm = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(dm).toContain("Outbox dispatcher");
    // The impact sentence must be more severe than any single payment rail's
    // — this is the sole delivery path for every buyer credential DM AND
    // every admin alert, not just one gateway's auto-confirm.
    expect(dm).toContain("credential");
    expect(dm).toContain("admin alert");
  });

  it("pages admins once when the outbox dispatcher heartbeat is stale (over five minutes since the last completed cycle)", async () => {
    const at = new Date(Date.now() - 20 * 60_000).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.outbox,
      JSON.stringify({
        lastRun: at,
        lastSuccessAt: at,
        lastTxCount: 0,
        backoffUntil: null,
        consecutiveRateLimitHits: 0,
        lastRateLimitAt: null,
        consecutiveFailures: 0,
        lastError: null,
      }),
    );
    const api = fakeApi();

    await outboxDispatcherPollWatchdog(api);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(await getSetting(prisma, "outbox_watchdog_alerted")).toBe("1");
  });

  it("clears the outbox dispatcher alert state on recovery", async () => {
    await setSetting(prisma, "outbox_watchdog_alerted", "1");
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.outbox,
      JSON.stringify({
        lastRun: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        lastTxCount: 3,
        backoffUntil: null,
        consecutiveRateLimitHits: 0,
        lastRateLimitAt: null,
        consecutiveFailures: 0,
        lastError: null,
      }),
    );
    const api = fakeApi();

    await outboxDispatcherPollWatchdog(api);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await getSetting(prisma, "outbox_watchdog_alerted")).toBe("0");
  });
});

/**
 * Task 15 (I-3) Part C: `scheduleOutboxDispatcherWatchdog`'s Cron shape and
 * offset-second — pinned directly (unlike the six watchdogs above, this one
 * is deliberately NOT part of `scheduleJobs`' returned array, so it can't be
 * asserted via the index-based "scheduleJobs cron registration" test above;
 * see that function's own doc-comment for why).
 */
describe("scheduleOutboxDispatcherWatchdog (Task 15 / I-3, Part C)", () => {
  it("registers a protected Cron on its own offset-second, clear of the six existing watchdogs' seconds (0, 15, 17, 19)", () => {
    const cron = scheduleOutboxDispatcherWatchdog(fakeApi());
    try {
      expect(cron.options.protect).toBe(true);
      const pattern = cron.getPattern()!;
      const fields = pattern.split(" ");
      expect(fields.length).toBeGreaterThanOrEqual(6); // seconds-resolution expression
      const seconds = fields[0]!.split(",").map(Number);
      expect(seconds.every(Number.isInteger)).toBe(true);
      expect(seconds).not.toContain(0); // crypto three's implicit second
      expect(seconds).not.toContain(15); // tokopayPollWatchdog
      expect(seconds).not.toContain(17); // paydisiniPollWatchdog
      expect(seconds).not.toContain(19); // nowpaymentsPollWatchdog
    } finally {
      cron.stop();
    }
  });
});

/**
 * Task 10: runDigiflazzCatalogSyncTick chains a shadow-mode detection pass
 * (bumpCatalogRevision + runDetectionForCatalog) after the hourly Digiflazz
 * catalog resync. The detection pass must be fully isolated — a failure in it
 * must neither reject the tick nor undo/suppress the successful resync — and
 * it must be skipped entirely when the resync itself failed.
 */
describe("runDigiflazzCatalogSyncTick (Task 10 shadow-mode detection pass)", () => {
  it("runs runDetectionForCatalog after a successful resync; a detection-pass error neither rejects the tick nor suppresses the resync log", async () => {
    const calls: string[] = [];
    dbMockState.resyncDigiflazzCatalog = async () => {
      calls.push("resync");
      return { updated: 1, deactivated: 0 };
    };
    dbMockState.runDetectionForCatalog = async () => {
      calls.push("detect");
      throw new Error("detection engine blew up");
    };
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    try {
      // Does not reject even though runDetectionForCatalog throws.
      await expect(runDigiflazzCatalogSyncTick()).resolves.toBeUndefined();

      // Detection ran, and it ran AFTER the resync.
      expect(calls).toEqual(["resync", "detect"]);
      // The resync's own success log still fired — not suppressed by the later failure.
      expect(info.mock.calls.some((c) => String(c[0]).includes("Digiflazz catalog re-sync"))).toBe(true);
      // The detection failure surfaced as a warning, not a throw.
      expect(warn.mock.calls.some((c) => String(c[1]).includes("shadow-mode detection pass"))).toBe(true);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("skips the detection pass entirely when the resync itself throws", async () => {
    const calls: string[] = [];
    dbMockState.resyncDigiflazzCatalog = async () => {
      calls.push("resync");
      throw new Error("resync failed");
    };
    dbMockState.runDetectionForCatalog = async () => {
      calls.push("detect");
      return {};
    };
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    try {
      await expect(runDigiflazzCatalogSyncTick()).resolves.toBeUndefined();

      expect(calls).toEqual(["resync"]); // detection never ran
      expect(error.mock.calls.some((c) => String(c[1]).includes("Digiflazz catalog re-sync failed"))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});
