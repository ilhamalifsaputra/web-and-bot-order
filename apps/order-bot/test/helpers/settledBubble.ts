/**
 * Shared harness for the two suites that exercise a settled order's payment
 * bubble: the background sweeper (`sweepPaidOrderBubbles`, jobs.test.ts) and
 * the buyer's own "🔄 Refresh Status" tap (`refreshPaymentStatus`,
 * handlers.test.ts).
 *
 * Both need the same two things — a settled, still-anchored order to find, and
 * a way to read back the single bubble edit that was made — and they used to
 * carry near-identical private copies of both. The only real difference is the
 * Telegram double each drives: the sweeper takes a bare `Api` of `vi.fn()`
 * mocks, while the Refresh path runs through `makeCtx`'s recording `sink`. That
 * difference is the parameter here (each suite hands `onlyBubbleEdit` its own
 * call lists), not a reason to keep two copies.
 */
import { expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  createOrderDirect,
  createWalletTopupOrder,
  finalizeOrderPayment,
  setOrderPaymentMessage,
} from "@app/db";
import { OrderCurrency, OrderKind, OrderStatus, PaymentMethod } from "@app/core/enums";

/** Distinct anchor message ids across a whole file. Two orders anchored on the
 *  same (chatId, messageId) pair is a real state the code clears on purpose
 *  (`clearPaymentMessageAnchorsAt`), so reusing one id would silently unanchor
 *  the previous order instead of setting up the intended fixture. */
let anchorSeq = 0;

export interface SettledAnchoredOrder {
  id: number;
  orderCode: string;
  /** Where the anchor was placed — assert the edit landed on exactly this
   *  bubble rather than hard-coding the numbers at the call site. */
  chatId: number;
  msgId: number;
}

export interface SettledAnchoredOrderOptions {
  /** `PaymentMethod.*` — the rail this order was checked out on. */
  method: string;
  /** `OrderKind.*`; defaults to PRODUCT. */
  kind?: string;
  /** `OrderStatus.*`; defaults to DELIVERED. */
  status?: string;
  /** The order's charge currency; defaults to IDR. */
  currency?: "IDR" | "USDT";
  /** The buyer, normally `sample.user`. */
  buyer: { id: number; role: string };
  /** The product a PRODUCT order is for, normally `sample.product.id`.
   *  Unused for a WALLET_TOPUP order, which sells nothing. */
  productId: number;
  chatId?: number;
  msgId?: number;
}

/**
 * A settled (DELIVERED/PROCESSING) order of any rail/kind that still carries
 * its payment-bubble anchor — exactly what the sweeper is meant to find, and
 * exactly what a buyer is staring at when they press Refresh after paying.
 *
 * The status is stamped directly rather than driven through a real settlement
 * path: both call sites read nothing but `kind`/`status`/`currency` and the
 * anchor, and stamping is the only way one helper covers all six rails
 * identically.
 */
export async function makeSettledAnchoredOrder(
  db: PrismaClient,
  opts: SettledAnchoredOrderOptions,
): Promise<SettledAnchoredOrder> {
  const currency = opts.currency ?? "IDR";
  const order =
    opts.kind === OrderKind.WALLET_TOPUP
      ? await db.$transaction((tx) =>
          createWalletTopupOrder(tx, {
            userId: opts.buyer.id,
            amount: currency === "IDR" ? "50000" : "5",
            currency,
            method: opts.method as Parameters<typeof createWalletTopupOrder>[1]["method"],
            rate: "16000",
          }),
        )
      : await db.$transaction(async (tx) => {
          const created = await createOrderDirect(tx, {
            user: opts.buyer,
            productId: opts.productId,
            quantity: 1,
          });
          return currency === "IDR"
            ? finalizeOrderPayment(tx, created!.id, {
                currency: OrderCurrency.IDR,
                method: opts.method as typeof PaymentMethod.TOKOPAY,
              })
            : finalizeOrderPayment(tx, created!.id, {
                currency: OrderCurrency.USDT,
                rate: "16000",
                method: opts.method as typeof PaymentMethod.BINANCE_INTERNAL,
              });
        });
  await db.order.update({
    where: { id: order!.id },
    data: { status: opts.status ?? OrderStatus.DELIVERED },
  });
  const chatId = opts.chatId ?? 555;
  const msgId = opts.msgId ?? 1000 + ++anchorSeq;
  await setOrderPaymentMessage(db, order!.id, chatId, msgId);
  return { id: order!.id, orderCode: order!.orderCode, chatId, msgId };
}

export interface BubbleEdit {
  chatId: number;
  msgId: number;
  text: string;
  buttons: string[];
}

/**
 * The single bubble edit that was made, whichever grammY call carried it.
 *
 * A payment bubble is a photo (QR) or a plain text message depending on the
 * rail, so the flip lands on `editMessageCaption` or `editMessageText` and the
 * caller must not care which — that is the whole point of reading it back
 * through here. Takes the two calls' ARGUMENT LISTS so it works the same for a
 * `vi.fn()` mock (`mock.calls`) and for `makeCtx`'s sink (`calls(sink, …)`
 * mapped to `.args`); asserting exactly one edit happened is part of the
 * contract, since "flipped once" is what both suites are really pinning.
 */
export function onlyBubbleEdit(captionCalls: unknown[][], textCalls: unknown[][]): BubbleEdit {
  expect(captionCalls.length + textCalls.length).toBe(1);
  const isCaption = captionCalls.length === 1;
  const [chatId, msgId, third, fourth] = (captionCalls[0] ?? textCalls[0])!;
  // editMessageCaption(chatId, msgId, opts) carries its text inside `opts`;
  // editMessageText(chatId, msgId, text, opts) carries it as the third arg.
  const payload = (isCaption ? third : fourth) as {
    caption?: string;
    reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> };
  };
  return {
    chatId: chatId as number,
    msgId: msgId as number,
    text: (isCaption ? payload.caption : third) as string,
    buttons: payload.reply_markup.inline_keyboard.flat().map((b) => b.callback_data ?? ""),
  };
}
