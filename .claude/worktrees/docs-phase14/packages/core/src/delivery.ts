/**
 * Delivered-account formatting shared by every fulfilment path.
 *
 * After payment is confirmed (manual approve, Binance Internal/Bybit pollers,
 * the TokoPay reconcile poller, or the notifier's QRIS buyer DM) the buyer is
 * sent their account(s) as a `.txt` document named after the order code, plus a
 * short HTML caption. The two builders here keep that format identical across
 * callers — `buildAccountFileContent` is the raw (NO HTML) file body, while
 * `buildDeliveryCaption` is the bubble text that rides alongside it.
 *
 * Credentials are read live from the caller's DB row at send time and never
 * pass through the notification outbox payload (CLAUDE.md: never log/store
 * credentials in the outbox).
 */
import { t } from "./i18n";

/** Minimal order-item shape both builders consume (Prisma rows satisfy it). */
export interface DeliveredItem {
  productId: number;
  product: { name: string };
  stockItem: { credentials: string } | null;
  warrantyDaysSnapshot?: number | null;
}

/** Floor for the displayed warranty; matches the existing poller/approve paths. */
const MIN_WARRANTY_DAYS = 30;

/** Warranty days to show for an order: the longest item snapshot, min 30. */
export function warrantyDaysFor(items: Array<{ warrantyDaysSnapshot?: number | null }>): number {
  return Math.max(MIN_WARRANTY_DAYS, ...items.map((i) => Number(i.warrantyDaysSnapshot ?? 0)));
}

/** Group credentials per product, preserving first-seen order. */
function groupCredentials(items: DeliveredItem[]): Array<[string, string[]]> {
  const groups: Array<[string, string[]]> = [];
  const idx = new Map<number, number>();
  for (const it of items) {
    if (!it.stockItem) continue;
    if (!idx.has(it.productId)) {
      idx.set(it.productId, groups.length);
      groups.push([it.product.name, []]);
    }
    groups[idx.get(it.productId)!]![1].push(it.stockItem.credentials);
  }
  return groups;
}

/**
 * Plain-text body for the delivered-account `.txt` attachment (filename = order
 * code). Grouped per product with raw credentials — **no HTML**, since this is a
 * downloadable text file, not a message.
 */
export function buildAccountFileContent(
  args: { orderCode: string; warrantyDays: number; items: DeliveredItem[] },
  lang: string,
): string {
  const header = t("order.file_header", lang, { code: args.orderCode, warranty: args.warrantyDays });
  const body = groupCredentials(args.items)
    .map(
      ([name, creds]) =>
        `${t("order.file_group_header", lang, { product: name, count: creds.length })}\n${creds.join("\n")}`,
    )
    .join("\n\n");
  return `${header}\n\n${body}\n`;
}

/** Short HTML caption that accompanies the `.txt` attachment in the buyer DM. */
export function buildDeliveryCaption(orderCode: string, warrantyDays: number, lang: string): string {
  return t("order.delivered_caption", lang, { code: orderCode, warranty: warrantyDays });
}

/** Suggested attachment filename for an order's account file. */
export function accountFileName(orderCode: string): string {
  return `${orderCode}.txt`;
}
