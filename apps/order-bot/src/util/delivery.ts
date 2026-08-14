/**
 * Deliver a paid order's account(s) to the buyer as a `.txt` document.
 *
 * Every fulfilment path (manual approve, Binance Internal/Bybit pollers, the
 * TokoPay reconcile poller) funnels through here so the buyer always receives an
 * identical "short caption + `<order-code>.txt`" bubble. The file body and
 * caption come from the shared `@app/core/delivery` builders. Throws on send
 * failure so callers can log + offer a resend, exactly like the prior
 * `sendMessage` path did.
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
import { orderAmount, formatIdr, formatUsdt } from "./format";
import { coreT } from "./i18n";

interface DeliverableOrder {
  orderCode: string;
  items: DeliveredItem[];
}

interface WalletTopupOrder {
  orderCode: string;
  currency: string | null;
  totalAmount: Decimal.Value;
}

/**
 * Shared "top-up successful" text — both the buyer DM and the anchored
 * payment-instructions bubble edit use this (binanceInternal.ts /
 * bybitDeposit.ts / bybitBscDeposit.ts onDelivered; the TokoPay/PayDisini/
 * NOWPayments rails settle via the outbox instead, see wallet_topup.ts's
 * TODO(Task 7)). `order`'s own currency/totalAmount are what
 * createWalletTopupOrder validated and finalized; `newBalance` is the
 * caller's post-credit balance for that same currency (read fresh — the
 * order row itself doesn't carry it). Uses `formatUsdt` (not the bare
 * `formatUsdtAmount`) for the USDT branch so the balance always carries an
 * explicit unit, matching `formatIdr`'s "Rp" prefix on the IDR branch — a
 * bare "New balance: 10" with no currency word would be ambiguous.
 */
export function walletTopupSuccessText(order: WalletTopupOrder, newBalance: Decimal.Value, lang: string): string {
  const isIdr = (order.currency ?? "USDT") === "IDR";
  return coreT("wallet.topup_success", lang, {
    code: order.orderCode,
    amount: orderAmount(order),
    balance: isIdr ? formatIdr(newBalance) : formatUsdt(newBalance),
  });
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
 * The one place an order maps to the success bubble it should now be showing.
 * Both post-payment bubble flips call it — the buyer's own "🔄 Refresh Status"
 * tap (`refreshPaymentStatus`, handlers/checkout.ts) and the background
 * sweeper that catches every settlement the bot process never saw
 * (`sweepPaidOrderBubbles`, jobs/index.ts) — so a buyer can never be shown two
 * different endings for the same order depending on which one got there first.
 *
 *  - WALLET_TOPUP (any status) → the same `walletTopupSuccessText` sentence the
 *    three crypto rails already send, so all six payment methods word a
 *    completed top-up identically. Its keyboard is the wallet screen's, not
 *    `paymentSuccessKb`'s "My Orders" — a top-up never produces an order the
 *    buyer would look for in their order history.
 *  - PRODUCT + DELIVERED → items are on their way (the account file is
 *    already sent or enqueued).
 *  - PRODUCT + PROCESSING → manual fulfilment; the buyer waits for an admin.
 *
 * The top-up balance is the buyer's CURRENT balance, not their balance at the
 * instant the credit landed: if they spent some of it between the credit and
 * this flip, the number shown here is lower than what was credited. That is
 * accepted as-is (the crypto rails' own fast path shows exactly the same
 * figure), not a bug to chase.
 */
export function settledPaymentBubble(order: SettledBubbleOrder): { text: string; markup: InlineKeyboard } {
  const lang = langCode(order.user.language);
  if (order.kind === OrderKind.WALLET_TOPUP) {
    const newBalance = (order.currency ?? "USDT") === "IDR" ? order.user.walletBalance : order.user.walletBalanceUsdt;
    return { text: walletTopupSuccessText(order, newBalance, lang), markup: walletKb(lang) };
  }
  const key = order.status === OrderStatus.PROCESSING ? "checkout.payment_received_processing" : "checkout.payment_received";
  return { text: coreT(key, lang, { code: order.orderCode }), markup: paymentSuccessKb(lang) };
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
