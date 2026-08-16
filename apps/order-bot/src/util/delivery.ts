/**
 * Deliver a paid order's account(s) to the buyer as a `.txt` document.
 *
 * Every fulfilment path (manual approve, Binance Internal/Bybit pollers, the
 * TokoPay reconcile poller) funnels through here so the buyer always receives an
 * identical "short caption + `<order-code>.txt`" bubble. The file body and
 * caption come from the shared `@app/core/delivery` builders. Throws on send
 * failure so callers can log + offer a resend, exactly like the prior
 * `sendMessage` path did.
 *
 * Also owns `settledPaymentBubble`, the canonical text/keyboard mapping for
 * an already-settled order's payment bubble — shared by the Refresh button's
 * on-the-spot flip (handlers/checkout.ts) and the background sweeper
 * (jobs/index.ts) so both show the buyer the identical ending.
 */
import { InputFile, type Api, type InlineKeyboard } from "grammy";
import type { Decimal } from "@app/core/money";
import { OrderKind, OrderStatus, langCode } from "@app/core/enums";
import {
  buildAccountFileContent,
  buildDeliveryCaption,
  warrantyDaysFor,
  accountFileName,
  type DeliveredItem,
} from "@app/core/delivery";
import { notificationKb, paymentSuccessKb, walletKb } from "../keyboards/customer";
import { coreT } from "./i18n";

interface DeliverableOrder {
  orderCode: string;
  items: DeliveredItem[];
}

/** A settled order as far as its payment bubble is concerned: what it was for
 * (`kind`), how far it got (`status`), what it cost (`currency`/`totalAmount`,
 * for the top-up sentence), and the buyer's language plus both wallet columns.
 * Structurally satisfied by `listSettledOrdersAwaitingBubbleEdit`'s projection
 * (packages/db/src/crud/binance_internal.ts) as-is. */
export interface SettledBubbleOrder {
  orderCode: string;
  kind: string;
  status: string;
  currency: string | null;
  totalAmount: Decimal.Value;
  user: { language: string; walletBalance: Decimal.Value; walletBalanceUsdt: Decimal.Value };
}

/**
 * The keyboard a settled order's payment bubble carries, by what the order was
 * for. A top-up gets the wallet screen's keyboard (`walletKb`): "My Orders" is
 * the wrong offer after a top-up, because a top-up leaves nothing in the order
 * history a buyer would go looking for — where they want to go next is their
 * balance, or another top-up. A product sale keeps `paymentSuccessKb` (buy
 * again / order history / menu).
 *
 * Exported so the three crypto rails' own fast paths (binanceInternal.ts,
 * bybitDeposit.ts, bybitBscDeposit.ts) pick the keyboard through the same
 * function `settledPaymentBubble` does, rather than each hard-coding
 * `paymentSuccessKb`. That mismatch used to be real: whether a top-up buyer saw
 * "My Orders" or the wallet keyboard depended on whether their own rail or the
 * background sweeper flipped the bubble first. The rails' TEXT still differs
 * deliberately (`checkout.internal_paid` / `checkout.bybit_bsc_paid` for a
 * product sale); only the keyboard is unified here.
 */
export function settledPaymentKb(kind: string, lang: string): InlineKeyboard {
  return kind === OrderKind.WALLET_TOPUP ? walletKb(lang) : paymentSuccessKb(lang);
}

/**
 * The one place an order maps to the success bubble it should now be showing.
 * Every post-payment bubble flip calls it — the buyer's own "🔄 Refresh Status"
 * tap (`refreshPaymentStatus`, handlers/checkout.ts), the background sweeper
 * that catches every settlement the bot process never saw
 * (`sweepPaidOrderBubbles`, jobs/index.ts), and the two QRIS reconcile pollers'
 * own fast paths (payments/tokopayReconcile.ts, paydisiniReconcile.ts, via
 * `settledPaymentBubbleFor` below) — so a buyer can never be shown two
 * different endings for the same order depending on which one got there first.
 * The QRIS pollers are the reason that matters most in practice: they clear the
 * order's anchor as soon as they flip it, which retires the order from the
 * sweeper's queue, so whatever they write is final.
 *
 *  - WALLET_TOPUP (any status) → a neutral "payment received" status line
 *    (`checkout.topup_payment_received`), not a success sentence — the
 *    buyer's actual "top-up successful" DM, with the credited amount, the
 *    new balance and the order code, comes from the outbox instead
 *    (WALLET_TOPUP_CREDITED_DM, enqueued once inside settleWalletTopup; see
 *    packages/db/src/crud/wallet_topup.ts and packages/outbox-dispatcher/src/
 *    templates.ts). This bubble used to duplicate that sentence itself,
 *    which is exactly what let a top-up settled here AND enqueued to the
 *    outbox produce two "top-up successful" messages for the same order.
 *    All six payment methods now word a completed top-up identically (one
 *    neutral bubble, one DM), and the wallet screen's keyboard via
 *    `settledPaymentKb` above. The crypto rails' fast path picks its
 *    keyboard through that same helper, so a top-up buyer sees the same
 *    keyboard no matter which path reached the bubble first.
 *  - PRODUCT + DELIVERED → items are on their way (the account file is
 *    already sent or enqueued).
 *  - PRODUCT + PROCESSING → manual fulfilment; the buyer waits for an admin.
 */
export function settledPaymentBubble(order: SettledBubbleOrder): { text: string; markup: InlineKeyboard } {
  const lang = langCode(order.user.language);
  if (order.kind === OrderKind.WALLET_TOPUP) {
    return { text: coreT("checkout.topup_payment_received", lang), markup: settledPaymentKb(order.kind, lang) };
  }
  const key = order.status === OrderStatus.PROCESSING ? "checkout.payment_received_processing" : "checkout.payment_received";
  return { text: coreT(key, lang, { code: order.orderCode }), markup: settledPaymentKb(order.kind, lang) };
}

/** A settled order as an ordinary order row carries it — everything
 * `settledPaymentBubble` needs EXCEPT the buyer's two wallet columns, which no
 * order row has (`ORDER_USER_SELECT`, packages/db/src/crud/orders.ts, projects
 * only identity and language). Structurally satisfied by `getOrder`'s result
 * and by the two QRIS rails' `AnchoredOrder`. */
export interface SettledBubbleOrderRow {
  orderCode: string;
  kind: string;
  status: string;
  currency: string | null;
  totalAmount: Decimal.Value;
  user: { language: string };
}

/**
 * `settledPaymentBubble` for the callers that hold an ordinary order row and
 * have read the buyer separately.
 *
 * Because the row carries no balance, every such caller has to read the buyer
 * fresh (AFTER the credit landed, or the top-up sentence quotes a pre-credit
 * figure) and then decide what to show if that read comes back empty. Deciding
 * it once, here, is the whole point: `buyer` is null both for a product sale —
 * whose sentence quotes no balance at all, so its caller skips the read
 * entirely — and for a top-up whose buyer row could not be re-read. In that
 * second case the fallback is the order's own total: the credit that just
 * landed is at least that much, which is far nearer the truth than a zero.
 * Shared by the buyer's "🔄 Refresh Status" tap (handlers/checkout.ts) and both
 * QRIS reconcile pollers (payments/tokopayReconcile.ts, paydisiniReconcile.ts);
 * the background sweeper needs none of this, since its own query
 * (`listSettledOrdersAwaitingBubbleEdit`) already projects both wallet columns.
 */
export function settledPaymentBubbleFor(
  order: SettledBubbleOrderRow,
  buyer: { walletBalance: Decimal.Value; walletBalanceUsdt: Decimal.Value } | null,
): { text: string; markup: InlineKeyboard } {
  return settledPaymentBubble({
    orderCode: order.orderCode,
    kind: order.kind,
    status: order.status,
    currency: order.currency,
    totalAmount: order.totalAmount,
    user: {
      language: order.user.language,
      walletBalance: buyer?.walletBalance ?? order.totalAmount,
      walletBalanceUsdt: buyer?.walletBalanceUsdt ?? order.totalAmount,
    },
  });
}

/** Send the buyer their account file (caption + `.txt`). Throws on failure. */
export async function sendAccountFile(
  api: Api,
  chatId: number,
  order: DeliverableOrder,
  lang: string,
): Promise<void> {
  const warranty = warrantyDaysFor(order.items);
  const content = buildAccountFileContent(
    { orderCode: order.orderCode, warrantyDays: warranty, items: order.items },
    lang,
  );
  const file = new InputFile(Buffer.from(content, "utf8"), accountFileName(order.orderCode));
  await api.sendDocument(chatId, file, {
    caption: buildDeliveryCaption(order.orderCode, warranty, lang),
    parse_mode: "HTML",
    reply_markup: notificationKb(lang),
  });
}
