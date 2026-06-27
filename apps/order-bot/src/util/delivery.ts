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
import {
  buildAccountFileContent,
  buildDeliveryCaption,
  warrantyDaysFor,
  accountFileName,
  type DeliveredItem,
} from "@app/core/delivery";
import { notificationKb } from "../keyboards/customer";

interface DeliverableOrder {
  orderCode: string;
  items: DeliveredItem[];
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
