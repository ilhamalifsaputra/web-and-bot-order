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
import { InputFile, type Api } from "grammy";
import type { Decimal } from "@app/core/money";
import {
  buildAccountFileContent,
  buildDeliveryCaption,
  warrantyDaysFor,
  accountFileName,
  type DeliveredItem,
} from "@app/core/delivery";
import { notificationKb } from "../keyboards/customer";
import { orderAmount, formatIdr, formatUsdtAmount } from "./format";
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
 * order row itself doesn't carry it).
 */
export function walletTopupSuccessText(order: WalletTopupOrder, newBalance: Decimal.Value, lang: string): string {
  const isIdr = (order.currency ?? "USDT") === "IDR";
  return coreT("wallet.topup_success", lang, {
    code: order.orderCode,
    amount: orderAmount(order),
    balance: isIdr ? formatIdr(newBalance) : formatUsdtAmount(newBalance),
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
