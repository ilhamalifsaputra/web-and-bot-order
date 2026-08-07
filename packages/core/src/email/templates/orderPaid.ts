/**
 * The "a paid order just came in" email sent to the shop owner
 * (NotificationEvent.OWNER_EMAIL_ORDER_PAID) — the one owner-email event
 * that gets the full HTML design system (Global Constraints scope
 * decision 1; the other three owner-email events stay plain text).
 */
import { renderShell } from "../layout";
import {
  title,
  subtitle,
  statusBadge,
  infoTable,
  primaryButton,
  fallbackLinkLine,
  footer,
  TEXT,
} from "../components";
import { ptSection, ptKeyValue, ptDivider } from "../plaintext";
import { escapeHtml } from "../escape";
import { buildSubject } from "../subject";
import type { BrandConfig, EmailCopy, RenderedEmail } from "../types";

export interface OrderPaidItem {
  name: string;
  variant: string | null;
  quantity: number;
  unitPrice: string;
}

export interface OrderPaidInput {
  orderCode: string;
  orderId: number;
  customerLabel: string;
  items: OrderPaidItem[];
  subtotal: string;
  discount: string;
  total: string;
  currency: string;
  paymentMethod: string;
  transactionId: string | null;
  voucherCode: string | null;
  /** ISO or already-formatted — this template renders it verbatim (already
   * display-formatted by the caller, same convention as the Telegram
   * templates' delivered_at), so callers are expected to pass a
   * human-readable string, not a raw ISO timestamp meant for re-parsing. */
  paidAt: string;
  orderUrl: string | null;
}

/** Render each item as its own compact line: "2x Netflix Premium (1 Month) — 50000". */
function formatItemLine(item: OrderPaidItem): string {
  const variantPart = item.variant ? ` (${item.variant})` : "";
  return `${item.quantity}x ${item.name}${variantPart} — ${item.unitPrice}`;
}

function buildItemsHtml(items: OrderPaidItem[]): string {
  const rows = items
    .map(
      (item) =>
        `<tr><td class="email-text" style="padding:6px 0;font-size:14px;color:${TEXT};">${escapeHtml(formatItemLine(item))}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:8px;">${rows}</table>`;
}

export function renderOrderPaidEmail(
  input: OrderPaidInput,
  brand: BrandConfig,
  copy: EmailCopy,
): RenderedEmail {
  const summaryRows = [
    { label: "Order", value: input.orderCode },
    { label: "Customer", value: input.customerLabel },
    { label: "Subtotal", value: `${input.subtotal} ${input.currency}` },
    { label: "Discount", value: input.discount !== "0" ? `${input.discount} ${input.currency}` : "" },
    { label: "Total", value: `${input.total} ${input.currency}` },
    { label: "Payment Method", value: input.paymentMethod },
    { label: "Transaction ID", value: input.transactionId ?? "" },
    { label: "Coupon", value: input.voucherCode ?? "" },
    { label: "Paid At", value: input.paidAt },
  ];

  const buttonHtml = input.orderUrl
    ? `<div style="margin-top:24px;">${primaryButton("View Order", input.orderUrl, brand.accentColor)}${fallbackLinkLine(input.orderUrl)}</div>`
    : "";

  const bodyHtml = `
    <div style="margin-bottom:16px;">${statusBadge("PAID", "success")}</div>
    ${title(copy.title)}
    ${subtitle(copy.subtitle)}
    <div class="email-text" style="font-size:15px;color:${TEXT};line-height:1.6;margin-bottom:24px;">${escapeHtml(copy.message)}</div>
    ${buildItemsHtml(input.items)}
    ${infoTable(summaryRows)}
    ${buttonHtml}
    ${footer(brand, { generatedByLine: "This is an automated notification — no reply needed." })}
  `;

  const html = renderShell({
    brand,
    bodyHtml,
    preheader: `New Paid Order! - ${input.orderCode}`,
  });

  const itemLines = input.items.map((item) => ptKeyValue("Item", formatItemLine(item))).join("\n");
  const text = [
    ptSection(copy.title),
    copy.subtitle,
    "",
    copy.message,
    "",
    ptDivider(),
    ptSection("Order Summary"),
    ptKeyValue("Order", input.orderCode),
    ptKeyValue("Customer", input.customerLabel),
    itemLines,
    ptKeyValue("Subtotal", `${input.subtotal} ${input.currency}`),
    ...(input.discount !== "0" ? [ptKeyValue("Discount", `${input.discount} ${input.currency}`)] : []),
    ptKeyValue("Total", `${input.total} ${input.currency}`),
    ptKeyValue("Payment Method", input.paymentMethod),
    ...(input.transactionId ? [ptKeyValue("Transaction ID", input.transactionId)] : []),
    ...(input.voucherCode ? [ptKeyValue("Coupon", input.voucherCode)] : []),
    ptKeyValue("Paid At", input.paidAt),
    ...(input.orderUrl ? ["", ptKeyValue("View Order", input.orderUrl)] : []),
    "",
    ptDivider(),
    "This is an automated notification — no reply needed.",
  ].join("\n");

  return { subject: buildSubject(copy, brand), html, text };
}
