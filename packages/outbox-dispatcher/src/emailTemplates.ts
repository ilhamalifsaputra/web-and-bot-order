/**
 * Render notification_outbox EMAIL-channel payloads into mail for the shop
 * owner. Sibling to templates.ts's `render()`. It only ever handles the four
 * OWNER_EMAIL_* events (the enqueueOwner*Email helpers in
 * packages/db/src/crud/notifications.ts) — everything else returns `null`,
 * which the dispatcher treats as "no template", same as templates.ts's `""`
 * sentinel for an unrendered Telegram event.
 *
 * PLAIN TEXT, WITH ONE EXCEPTION: OWNER_EMAIL_MANUAL_ORDER_QUEUED,
 * OWNER_EMAIL_NEW_TICKET, and OWNER_EMAIL_TICKET_REPLY stay plain text (no
 * HTML, no `escape()`) — out of scope for the email-design-system plan, not
 * because they can't be upgraded, but because that plan's blast radius is
 * deliberately limited to the two templates it actually redesigned.
 * OWNER_EMAIL_ORDER_PAID is the one exception: the shared HTML design system
 * (packages/core/src/email) now exists, and this event is one of the two it
 * targets, so its branch resolves brand/copy from Settings and calls
 * `renderOrderPaidEmail`, returning a real `html` alongside `text`. This
 * function is therefore `async` (Settings reads go through Prisma) even
 * though the other three branches remain pure string-building.
 *
 * SUBJECT-LINE CONSTRAINT — read before touching this file: sendMail
 * (packages/core/src/mailer.ts) logs the subject on every send. For three of
 * the four OWNER_EMAIL_* events (MANUAL_ORDER_QUEUED, NEW_TICKET,
 * TICKET_REPLY) the subject is a fixed string literal with zero
 * interpolation — no payload value may ever be substituted into those.
 * OWNER_EMAIL_ORDER_PAID is the deliberate exception: its subject (via
 * renderOrderPaidEmail/buildSubject) substitutes {shop_name} and,
 * additionally, {order_code} — an accepted, narrowly-scoped risk because this
 * email's only recipient is the trusted shop admin (see
 * packages/core/src/email/subject.ts's header for the full rationale). Do not
 * extend {order_code} substitution to any other event's subject, and do not
 * add new tokens to the three plain-text events' fixed subjects.
 */
import { NotificationEvent } from "@app/core/enums";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { formatMoney } from "@app/core/formatters";
import { prisma, getSetting } from "@app/db";
import { renderOrderPaidEmail } from "@app/core/email";
import type { BrandConfig, EmailCopy, OrderPaidInput, OrderPaidItem } from "@app/core/email";

interface Item {
  name?: unknown;
  qty?: unknown;
}

/** Format an item list as one "name x qty" line per item, name defaulting to
 * "?" and qty to 1 for a malformed entry — same defensiveness level
 * templates.ts's `fmtItems` uses for the Telegram side. */
function fmtItemLines(items: Item[]): string {
  return items
    .map((it) => {
      const name = String(it.name ?? "?");
      const qty = Number.parseInt(String(it.qty ?? 1), 10) || 1;
      return `  - ${name} x${qty}`;
    })
    .join("\n");
}

interface OrderPaidPayloadItem {
  name?: unknown;
  variant?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
}

interface OrderPaidPayload {
  order_code?: unknown;
  total?: unknown;
  currency?: unknown;
  item_count?: unknown;
  customer_label?: unknown;
  items?: OrderPaidPayloadItem[];
  subtotal?: unknown;
  discount?: unknown;
  payment_method?: unknown;
  transaction_id?: unknown;
  voucher_code?: unknown;
  paid_at?: unknown;
  order_url?: unknown;
}

interface ManualQueuedPayload {
  order_code?: unknown;
  items?: Item[];
  total?: unknown;
  currency?: unknown;
}

interface NewTicketPayload {
  ticket_id?: unknown;
  category?: unknown;
  message?: unknown;
}

interface TicketReplyPayload {
  ticket_id?: unknown;
  message?: unknown;
}

/**
 * Resolve the owner-email `BrandConfig` from Settings — the same
 * shop_name/web_logo_url rows the web-admin Branding page already edits
 * (Global Constraints scope decision 5: brand name/logo reuse those existing
 * keys, no new ones), plus the two new `email_*` brand keys. `shopName`
 * falls back to "Toko Digital" — the same default the storefront's
 * forgot-password handler (apps/storefront/src/routes/apiAuth.ts) already
 * uses for an unset shop_name, so the two owner/customer-facing email
 * surfaces agree on one default rather than inventing a second string.
 * `storeUrl` reuses `SHOP_PUBLIC_URL ?? PUBLIC_URL`, same as every other
 * buyer-facing link in this codebase — no new Settings key for it.
 */
async function resolveOwnerBrandConfig(): Promise<BrandConfig> {
  const [shopName, logoUrl, accentColor, supportEmail] = await Promise.all([
    getSetting(prisma, "shop_name"),
    getSetting(prisma, "web_logo_url"),
    getSetting(prisma, "email_brand_color"),
    getSetting(prisma, "email_support_address"),
  ]);
  return {
    shopName: shopName ?? "Toko Digital",
    logoUrl: logoUrl ?? null,
    accentColor: accentColor ?? "#4F46E5",
    supportEmail: supportEmail ?? null,
    storeUrl: config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null,
  };
}

/** Resolve the "New Paid Order" `EmailCopy` from its four `email_order_paid_*`
 * Settings keys, each falling back to its documented default (Global
 * Constraints table) when unset. */
async function resolveOrderPaidCopy(): Promise<EmailCopy> {
  const [subject, title, subtitle, message] = await Promise.all([
    getSetting(prisma, "email_order_paid_subject"),
    getSetting(prisma, "email_order_paid_title"),
    getSetting(prisma, "email_order_paid_subtitle"),
    getSetting(prisma, "email_order_paid_message"),
  ]);
  return {
    // A blank Subject header is a spam-filter red flag in a way a blank
    // title/subtitle/message is not (those are harmless empty body text),
    // so subject alone also falls back on a whitespace-only stored value,
    // not just on a genuinely unset (null) Setting.
    subject: subject?.trim() || "New Paid Order - {order_code}",
    title: title ?? "You've got a new order",
    subtitle: subtitle ?? "A customer just completed payment.",
    message: message ?? "Here are the details.",
  };
}

/** Payload item -> `OrderPaidItem`, defensively parsed the same way
 * `fmtItemLines` handles a malformed item entry elsewhere in this file.
 * `unitPrice` is formatted here (via `formatMoney`) since `orderPaid.ts`
 * itself only renders pre-formatted strings verbatim. */
function toOrderPaidItem(it: OrderPaidPayloadItem, currency: string): OrderPaidItem {
  return {
    name: String(it?.name ?? "?"),
    variant: it?.variant == null ? null : String(it.variant),
    quantity: Number.parseInt(String(it?.quantity ?? 1), 10) || 1,
    unitPrice: formatMoney(new Decimal(String(it?.unitPrice ?? "0")), currency),
  };
}

/** Render an EMAIL-channel outbox row into a subject + body, or `null` for
 * anything that isn't one of the four OWNER_EMAIL_* events. `async` because
 * the OWNER_EMAIL_ORDER_PAID branch resolves brand/copy from Settings via
 * Prisma — see the file header for why only that one branch needs it. */
export async function renderEmail(
  event: string,
  payload: OrderPaidPayload & ManualQueuedPayload & NewTicketPayload & TicketReplyPayload,
): Promise<{ subject: string; text: string; html?: string } | null> {
  if (event === NotificationEvent.OWNER_EMAIL_ORDER_PAID) {
    const currency = String(payload.currency ?? "");
    const subtotalDecimal = new Decimal(String(payload.subtotal ?? "0"));
    const discountDecimal = new Decimal(String(payload.discount ?? "0"));
    const totalDecimal = new Decimal(String(payload.total ?? "0"));
    const input: OrderPaidInput = {
      orderCode: String(payload.order_code ?? "unknown"),
      // Not carried in the payload (only order_code identifies the order,
      // and the subject-safety rule already keeps that out of the subject
      // regardless) and not actually read anywhere inside
      // renderOrderPaidEmail's own output — a placeholder is harmless.
      orderId: 0,
      customerLabel: String(payload.customer_label ?? ""),
      items: (payload.items ?? []).map((it) => toOrderPaidItem(it, currency)),
      subtotal: formatMoney(subtotalDecimal, currency),
      // "" (not formatMoney's zero output, e.g. "Rp0") hides the Discount
      // row/line entirely — same convention as transactionId/voucherCode
      // being null.
      discount: discountDecimal.isZero() ? "" : formatMoney(discountDecimal, currency),
      total: formatMoney(totalDecimal, currency),
      paymentMethod: String(payload.payment_method ?? ""),
      transactionId: payload.transaction_id == null ? null : String(payload.transaction_id),
      voucherCode: payload.voucher_code == null ? null : String(payload.voucher_code),
      paidAt: String(payload.paid_at ?? ""),
      orderUrl: payload.order_url == null ? null : String(payload.order_url),
    };
    const [brand, copy] = await Promise.all([resolveOwnerBrandConfig(), resolveOrderPaidCopy()]);
    return renderOrderPaidEmail(input, brand, copy);
  }
  if (event === NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED) {
    const code = String(payload.order_code ?? "unknown");
    const itemsText = fmtItemLines(payload.items ?? []);
    const total = String(payload.total ?? "0");
    const currency = String(payload.currency ?? "");
    return {
      subject: "Order queued for manual fulfilment",
      text:
        `Order ${code} was paid and needs manual fulfilment.\n\n` +
        `${itemsText}\n\n` +
        `Total: ${total} ${currency}\n\n` +
        `This order needs to be fulfilled by hand. Check the Orders page in the admin panel for details.`,
    };
  }
  if (event === NotificationEvent.OWNER_EMAIL_NEW_TICKET) {
    const ticketId = String(payload.ticket_id ?? "unknown");
    const category = payload.category;
    const categoryLine = typeof category === "string" && category ? `Category: ${category}\n` : "";
    const message = String(payload.message ?? "");
    return {
      subject: "New support ticket",
      text:
        `A new support ticket was opened (#${ticketId}).\n\n` +
        categoryLine +
        `${message}\n\n` +
        `Check the Support page in the admin panel to reply.`,
    };
  }
  if (event === NotificationEvent.OWNER_EMAIL_TICKET_REPLY) {
    const ticketId = String(payload.ticket_id ?? "unknown");
    const message = String(payload.message ?? "");
    return {
      subject: "New reply on a support ticket",
      text:
        `A customer replied to support ticket #${ticketId}.\n\n` +
        `${message}\n\n` +
        `Check the Support page in the admin panel to reply.`,
    };
  }
  return null;
}
