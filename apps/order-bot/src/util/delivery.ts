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
 * an already-settled order's payment bubble, and `bubbleOnPhotoFor`, the
 * canonical mapping for what `editPaymentBubble` should do when that bubble
 * turns out to be a photo. Both are read by exactly one caller,
 * `flipSettledOrderBubble` (jobs/index.ts) — the one shared edit/classify/
 * clear-anchor body behind the Refresh button's on-the-spot flip
 * (handlers/checkout.ts), the background sweeper (jobs/index.ts), all three
 * reconcile pollers (payments/tokopayReconcile.ts,
 * payments/paydisiniReconcile.ts, payments/nowpaymentsReconcile.ts) and the
 * payment-bubble flush hook (Task E3) alike, so none of them can show the
 * buyer a different ending for the same order.
 */
import { InputFile, type Api, type InlineKeyboard } from "grammy";
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
 * (`kind`), how far it got (`status`), the order code (quoted for a product
 * sale's bubble), and the buyer's language. A WALLET_TOPUP bubble renders a
 * neutral status line that interpolates nothing money-related — the balance-
 * quoting sentence lives exclusively in the outbox's WALLET_TOPUP_CREDITED_DM
 * (see `settledPaymentBubble` below) — so this type deliberately carries no
 * `currency`/`totalAmount`/wallet-balance fields; nothing here has read them
 * since Task E1. Structurally satisfied by an ordinary order row (`getOrder`,
 * a poller's own anchored-order projection, or
 * `listSettledOrdersAwaitingBubbleEdit`'s projection in
 * packages/db/src/crud/binance_internal.ts) as-is — every caller can pass its
 * order straight through with no extra read or merge. */
export interface SettledBubbleOrder {
  orderCode: string;
  kind: string;
  status: string;
  user: { language: string };
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
 * Every post-payment bubble flip calls it, directly or through the shared
 * `flipSettledOrderBubble` body (jobs/index.ts): the buyer's own
 * "🔄 Refresh Status" tap (`refreshPaymentStatus`, handlers/checkout.ts), the
 * background sweeper that catches every settlement the bot process never saw
 * (`sweepPaidOrderBubbles`, jobs/index.ts), the three reconcile
 * pollers' own fast paths (payments/tokopayReconcile.ts,
 * paydisiniReconcile.ts, payments/nowpaymentsReconcile.ts), the payment-
 * bubble flush hook (Task E3), and the three crypto rails' own fast paths
 * (binanceInternal.ts, bybitDeposit.ts, bybitBscDeposit.ts) — so a buyer can
 * never be shown two different endings for the same order depending on which
 * one got there first. Those pollers are the reason that matters most
 * in practice: they clear the order's anchor as soon as they flip it, which
 * retires the order from the sweeper's queue, so whatever they write is
 * final.
 *
 * Every caller can pass its order straight through with no extra database
 * read: this function interpolates no buyer balance into either branch below
 * (see `SettledBubbleOrder`'s own doc-comment), so there is nothing left to
 * merge in. This used to not be true — a WALLET_TOPUP bubble quoted the
 * buyer's balance, which no order row carries, so most callers read the
 * buyer fresh and funnelled through a `settledPaymentBubbleFor` wrapper that
 * merged the read in (or fell back to `order.totalAmount` when the read came
 * back empty). That sentence moved out to the outbox DM below, which
 * removed the last reason for any caller to read the buyer at all, so the
 * wrapper and its buyer-merging fallback were deleted instead of kept around
 * unused.
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

/**
 * The `onPhoto` mode every settled-bubble flip passes to `editPaymentBubble`
 * (jobs/index.ts), by what the order was for — the same `kind` switch
 * `settledPaymentBubble` and `settledPaymentKb` above already make, kept in
 * one place for the same reason: `flipSettledOrderBubble` (jobs/index.ts) —
 * the one shared body behind `flipSettledBubble` (handlers/checkout.ts),
 * `sweepPaidOrderBubbles` (jobs/index.ts), the three reconcile
 * pollers' `editBubbleAndClear` (payments/tokopayReconcile.ts,
 * payments/paydisiniReconcile.ts, payments/nowpaymentsReconcile.ts) and the
 * payment-bubble flush hook (Task E3) — all flip the same bubbles and must
 * not be able to drift apart on which one gets its QR silently deleted.
 *
 * A WALLET_TOPUP whose bubble turns out to be a QR photo gets `"delete"`: the
 * buyer's outbox WALLET_TOPUP_CREDITED_DM (enqueued once inside
 * `settleWalletTopup`, packages/db/src/crud/wallet_topup.ts) is already the
 * authoritative "top-up successful" message, so a replacement bubble here
 * would be a second, unwanted message next to it — the exact duplicate this
 * task (E2) removes. Every other order kind keeps `"replace"`: "Payment
 * received" is the only UI confirmation a product buyer gets before their
 * account file arrives, so that bubble must still reappear as a fresh
 * message when the QR it replaces can't be edited into it.
 *
 * `fallbackDm: null` on the `"replace"` branch, not omitted, because none of
 * `flipSettledOrderBubble`'s callers want a fallback DM either way — the
 * buyer already got the news through the normal delivery/top-up path (see
 * each call site's own comment for why), so a DM here would only repeat it.
 * `"delete"` carries no
 * `fallbackDm` at all: `editPaymentBubble`'s type makes that combination
 * unrepresentable on purpose (see its own doc comment), because a caller
 * asking for total silence on success cannot also ask for a DM on failure
 * without contradicting itself.
 */
export function bubbleOnPhotoFor(kind: string): { onPhoto: "delete" } | { onPhoto: "replace"; fallbackDm: null } {
  return kind === OrderKind.WALLET_TOPUP ? { onPhoto: "delete" } : { onPhoto: "replace", fallbackDm: null };
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
