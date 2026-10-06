/**
 * Render notification_outbox EMAIL-channel payloads into mail. Sibling to
 * templates.ts's `render()`. It handles the five OWNER_EMAIL_* events (the
 * enqueueOwner*Email helpers in packages/db/src/crud/notifications.ts) plus
 * the one BUYER_EMAIL_* event — everything else returns `null`, which the
 * dispatcher treats as "no template", same as templates.ts's `""` sentinel
 * for an unrendered Telegram event.
 *
 * NOT ALL OF THESE GO TO THE SHOP OWNER. BUYER_EMAIL_ORDER_READY lands in a
 * customer's inbox, which is why it resolves its brand through
 * `resolveBuyerBrandConfig` (storefront origin) rather than
 * `resolveOwnerBrandConfig` (admin origin), and why its subject rule below is
 * the strictest in this file. Keep the two brand resolvers separate.
 *
 * PLAIN TEXT, WITH ONE EXCEPTION: OWNER_EMAIL_MANUAL_ORDER_QUEUED,
 * OWNER_EMAIL_NEW_TICKET, and OWNER_EMAIL_TICKET_REPLY stay plain text (no
 * HTML, no `escape()`) — out of scope for the email-design-system plan, not
 * because they can't be upgraded, but because that plan's blast radius is
 * deliberately limited to the two templates it actually redesigned.
 * OWNER_EMAIL_ORDER_PAID is the one exception among those original four: the
 * shared HTML design system (packages/core/src/email) now exists, and this
 * event is one of the two it targets, so its branch resolves brand/copy from
 * Settings and calls `renderOrderPaidEmail`, returning a real `html`
 * alongside `text`. OWNER_EMAIL_WALLET_TOPUP (added later) also renders full
 * HTML via `renderWalletTopupEmail`, but — unlike ORDER_PAID — with a fixed
 * title/subtitle/message and NO Settings-driven copy override; see that
 * branch's own note and templates/walletTopup.ts's header for why. This
 * function is therefore `async` (Settings reads go through Prisma) even
 * though the plain-text branches remain pure string-building.
 *
 * SUBJECT-LINE CONSTRAINT — read before touching this file: sendMail
 * (packages/core/src/mailer.ts) logs the subject on every send. For four of
 * the five OWNER_EMAIL_* events (MANUAL_ORDER_QUEUED, NEW_TICKET,
 * TICKET_REPLY, WALLET_TOPUP) the subject is a fixed string literal with zero
 * interpolation — no payload value may ever be substituted into those.
 * OWNER_EMAIL_ORDER_PAID is the deliberate exception: its subject (via
 * renderOrderPaidEmail/buildSubject) substitutes {shop_name} and,
 * additionally, {order_code} — an accepted, narrowly-scoped risk because this
 * email's only recipient is the trusted shop admin (see
 * packages/core/src/email/subject.ts's header for the full rationale). Do not
 * extend {order_code} substitution to any other event's subject, and do not
 * add new tokens to the four fixed-subject events (including WALLET_TOPUP).
 *
 * BUYER_EMAIL_ORDER_READY is the hardest line of all here: its subject is a
 * fixed literal and its order code must stay out of BOTH the subject and the
 * renderShell preheader. That accepted risk taken for ORDER_PAID does not
 * transfer — ORDER_PAID's reader is the trusted shop admin, whereas for a
 * guest order the order code IS the entire credential (POST /api/v1/track
 * swaps it for a session), and subject + preheader are exactly what a
 * lock-screen notification preview renders.
 */
import { NotificationEvent } from "@app/core/enums";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { formatMoney, formatUsdt } from "@app/core/formatters";
import { prisma, getSetting } from "@app/db";
import {
  renderOrderPaidEmail,
  renderOrderReadyEmail,
  renderWalletTopupEmail,
  toAbsoluteAssetUrl,
} from "@app/core/email";
import type {
  BrandConfig,
  EmailCopy,
  OrderPaidInput,
  OrderPaidItem,
  OrderReadyInput,
  OrderReadyItem,
  WalletTopupInput,
} from "@app/core/email";

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
  bulk_discount?: unknown;
  discount?: unknown;
  wallet_credit?: unknown;
  unique_cents?: unknown;
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

interface WalletTopupPayload {
  order_code?: unknown;
  customer_label?: unknown;
  amount?: unknown;
  currency?: unknown;
  new_balance?: unknown;
  payment_method?: unknown;
  transaction_id?: unknown;
  topped_up_at?: unknown;
}

interface OrderReadyPayloadItem {
  name?: unknown;
  variant?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  /** The line's own money, converted once from central IDR by the enqueue
   * side (crud/orders.ts). Optional only because rows enqueued before this
   * field existed can still be PENDING at deploy time — see
   * `toOrderReadyItem`'s fallback. */
  lineTotal?: unknown;
}

interface OrderReadyPayload {
  order_code?: unknown;
  items?: OrderReadyPayloadItem[];
  subtotal?: unknown;
  discount?: unknown;
  /** The order's unique-cents surcharge — part of what the buyer paid, and
   * the missing term that used to make this receipt not add up. Optional only
   * because rows enqueued before this field existed can still be PENDING at
   * deploy time; those default to zero and render exactly as they did. */
  unique_cents?: unknown;
  total?: unknown;
  currency?: unknown;
  warranty_days?: unknown;
  order_url?: unknown;
  track_url?: unknown;
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
 *
 * `logoUrl` is joined against `ADMIN_PUBLIC_URL` via the shared
 * `toAbsoluteAssetUrl` helper (packages/core/src/email/assetUrl.ts) — the
 * same base this email's "View Order" button already links to
 * (packages/db/src/crud/orders.ts's orderUrl construction) — since this
 * email's only recipient is the shop admin. See that helper's own doc
 * comment for why the raw `web_logo_url` Setting (a path relative to the
 * app's own origin) can't be used as-is inside an email.
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
    logoUrl: toAbsoluteAssetUrl(logoUrl, config.ADMIN_PUBLIC_URL),
    accentColor: accentColor ?? "#4F46E5",
    supportEmail: supportEmail ?? null,
    storeUrl: config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null,
  };
}

/**
 * Resolve the BUYER-facing `BrandConfig` — the same Settings rows as
 * `resolveOwnerBrandConfig`, with ONE deliberate difference: `logoUrl` is
 * joined against the STOREFRONT origin (`SHOP_PUBLIC_URL ?? PUBLIC_URL`),
 * not `ADMIN_PUBLIC_URL`.
 *
 * That difference is the whole reason this is a separate function rather
 * than a parameter on the owner one, and it must not be collapsed back:
 * the reader here is a customer, and the admin origin is frequently private,
 * firewalled, or on a hostname the shop has no interest in publishing. An
 * admin-joined logo URL would render as a broken image for most recipients
 * and leak the admin panel's hostname to everyone else.
 */
async function resolveBuyerBrandConfig(): Promise<BrandConfig> {
  const storeUrl = config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null;
  const [shopName, logoUrl, accentColor, supportEmail] = await Promise.all([
    getSetting(prisma, "shop_name"),
    getSetting(prisma, "web_logo_url"),
    getSetting(prisma, "email_brand_color"),
    getSetting(prisma, "email_support_address"),
  ]);
  return {
    shopName: shopName ?? "Toko Digital",
    logoUrl: toAbsoluteAssetUrl(logoUrl, storeUrl ?? undefined),
    accentColor: accentColor ?? "#4F46E5",
    supportEmail: supportEmail ?? null,
    storeUrl,
  };
}

/** Payload item -> `OrderReadyItem`, defensively parsed the same way
 * `toOrderPaidItem` handles a malformed entry. `unitPrice` and `lineTotal`
 * are only FORMATTED here (via `Decimal` + `formatMoney`), since
 * `orderReady.ts` renders pre-formatted strings verbatim.
 *
 * `lineTotal` is deliberately taken from the payload rather than derived as
 * `unitPrice * quantity`: on a currency-converted order the payload's
 * `unitPrice` has already been rounded UP to the next 0.01 USDT, so scaling it
 * here would scale that rounding error and print a line total contradicting
 * the subtotal a few lines below. The enqueue side multiplies in central IDR
 * and converts once (crud/orders.ts's enqueueBuyerOrderReadyEmailIfGuest).
 *
 * The fallback exists for one case only: outbox rows enqueued BEFORE
 * `lineTotal` joined the payload, which are already PENDING when this code
 * deploys. Those are all single-quantity IDR-or-converted lines where the
 * product is the best available answer, and it is still computed with
 * `Decimal.times`, never float multiplication. */
function toOrderReadyItem(it: OrderReadyPayloadItem, currency: string): OrderReadyItem {
  const unitPriceDecimal = new Decimal(String(it?.unitPrice ?? "0"));
  const quantity = Number.parseInt(String(it?.quantity ?? 1), 10) || 1;
  const lineTotalDecimal =
    it?.lineTotal == null ? unitPriceDecimal.times(quantity) : new Decimal(String(it.lineTotal));
  return {
    name: String(it?.name ?? "?"),
    variant: it?.variant == null ? null : String(it.variant),
    quantity,
    unitPrice: formatMoney(unitPriceDecimal, currency),
    lineTotal: formatMoney(lineTotalDecimal, currency),
  };
}

/** Warranty days -> the display string the template renders verbatim, or
 * null (which hides the line) for an absent, unparseable, or zero-day
 * warranty — "0 days" reads as a bug to a buyer, not as "no warranty".
 * Bilingual ("30 days / 30 hari"), matching the rest of this buyer-facing
 * email's data-dense parts (labels, banner, button — see orderReady.ts). */
function formatWarranty(warrantyDays: unknown): string | null {
  if (warrantyDays == null) return null;
  const days = Number.parseInt(String(warrantyDays), 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  return `${days} days / ${days} hari`;
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

/** Owner summary rows retain native USDT precision so the visible marker and
 * total reconcile. Keep other email events' existing display contract. */
function ownerPaidMoney(amount: Decimal, currency: string): string {
  return currency === "USDT" ? formatUsdt(amount) : formatMoney(amount, currency);
}

/** Parse a payload item defensively; the template renders its formatted unit
 * price verbatim, separate from the reconciled subtotal. */
function toOrderPaidItem(it: OrderPaidPayloadItem, currency: string): OrderPaidItem {
  return {
    name: String(it?.name ?? "?"),
    variant: it?.variant == null ? null : String(it.variant),
    quantity: Number.parseInt(String(it?.quantity ?? 1), 10) || 1,
    unitPrice: ownerPaidMoney(new Decimal(String(it?.unitPrice ?? "0")), currency),
  };
}

/** Render an EMAIL-channel outbox row into a subject + body, or `null` for
 * anything that isn't one of the five OWNER_EMAIL_* events. `async` because
 * the OWNER_EMAIL_ORDER_PAID and OWNER_EMAIL_WALLET_TOPUP branches resolve
 * brand (and, for ORDER_PAID only, copy) from Settings via Prisma — see the
 * file header for why the plain-text branches don't need it. */
export async function renderEmail(
  event: string,
  payload: OrderPaidPayload &
    ManualQueuedPayload &
    NewTicketPayload &
    TicketReplyPayload &
    WalletTopupPayload &
    OrderReadyPayload,
): Promise<{ subject: string; text: string; html?: string } | null> {
  // The one BUYER-facing branch — first, so it is impossible to miss when
  // reading this if-chain. Everything below it is addressed to the shop
  // owner. It resolves brand from Settings (like the two HTML owner
  // branches) but via `resolveBuyerBrandConfig`, and takes no `EmailCopy`:
  // its subject and copy are fixed literals inside the template. See
  // packages/core/src/email/templates/orderReady.ts's header.
  if (event === NotificationEvent.BUYER_EMAIL_ORDER_READY) {
    const currency = String(payload.currency ?? "");
    const subtotalDecimal = new Decimal(String(payload.subtotal ?? "0"));
    const discountDecimal = new Decimal(String(payload.discount ?? "0"));
    const totalDecimal = new Decimal(String(payload.total ?? "0"));
    const uniqueCentsDecimal = new Decimal(String(payload.unique_cents ?? "0"));
    // The unique-cents row hides when it is worth nothing AT THE PRECISION
    // THIS RECEIPT PRINTS, not merely when the stored value is exactly zero:
    // computeUniqueCents' two smallest buckets (0.002 and 0.004 USDT) both
    // render as "0.00 USDT", which reads as a bug to a buyer. Hiding such a
    // row keeps the summary reconciling — it contributes exactly zero to the
    // printed total — whereas printing it would show a term that visibly adds
    // nothing. Compared through formatMoney rather than a hardcoded 2dp so
    // this stays correct whatever precision the currency renders at.
    const uniqueCodeFormatted = formatMoney(uniqueCentsDecimal, currency);
    const input: OrderReadyInput = {
      orderCode: String(payload.order_code ?? "unknown"),
      items: (payload.items ?? []).map((it) => toOrderReadyItem(it as OrderReadyPayloadItem, currency)),
      subtotal: formatMoney(subtotalDecimal, currency),
      // "" (not formatMoney's zero output) hides the Discount row/line
      // entirely — same convention as the OWNER_EMAIL_ORDER_PAID branch.
      discount: discountDecimal.isZero() ? "" : formatMoney(discountDecimal, currency),
      uniqueCode:
        uniqueCodeFormatted === formatMoney(new Decimal(0), currency) ? "" : uniqueCodeFormatted,
      total: formatMoney(totalDecimal, currency),
      warranty: formatWarranty(payload.warranty_days),
      orderUrl: payload.order_url == null ? null : String(payload.order_url),
      trackUrl: payload.track_url == null ? null : String(payload.track_url),
    };
    const brand = await resolveBuyerBrandConfig();
    return renderOrderReadyEmail(input, brand);
  }
  if (event === NotificationEvent.OWNER_EMAIL_ORDER_PAID) {
    const currency = String(payload.currency ?? "");
    const subtotalDecimal = new Decimal(String(payload.subtotal ?? "0"));
    const discountDecimal = new Decimal(String(payload.discount ?? "0"));
    const totalDecimal = new Decimal(String(payload.total ?? "0"));
    const adjustment = (value: unknown, sign: "-" | "+"): string => {
      const amount = new Decimal(String(value ?? "0"));
      return amount.isZero() ? "" : `${sign}${ownerPaidMoney(amount, currency)}`;
    };
    const input: OrderPaidInput = {
      orderCode: String(payload.order_code ?? "unknown"),
      // Not carried in the payload (only order_code identifies the order)
      // and not actually read anywhere inside renderOrderPaidEmail's own
      // output — a placeholder is harmless.
      orderId: 0,
      customerLabel: String(payload.customer_label ?? ""),
      items: (payload.items ?? []).map((it) => toOrderPaidItem(it, currency)),
      subtotal: ownerPaidMoney(subtotalDecimal, currency),
      // "" (not formatMoney's zero output, e.g. "Rp0") hides the Discount
      // row/line entirely — same convention as transactionId/voucherCode
      // being null.
      discount: discountDecimal.isZero() ? "" : `-${ownerPaidMoney(discountDecimal, currency)}`,
      bulkDiscount: adjustment(payload.bulk_discount, "-"),
      walletCredit: adjustment(payload.wallet_credit, "-"),
      uniqueCents: adjustment(payload.unique_cents, "+"),
      total: ownerPaidMoney(totalDecimal, currency),
      paymentMethod: String(payload.payment_method ?? ""),
      transactionId: payload.transaction_id == null ? null : String(payload.transaction_id),
      voucherCode: payload.voucher_code == null ? null : String(payload.voucher_code),
      paidAt: String(payload.paid_at ?? ""),
      orderUrl: payload.order_url == null ? null : String(payload.order_url),
    };
    const [brand, copy] = await Promise.all([resolveOwnerBrandConfig(), resolveOrderPaidCopy()]);
    return renderOrderPaidEmail(input, brand, copy);
  }
  if (event === NotificationEvent.OWNER_EMAIL_WALLET_TOPUP) {
    const currency = String(payload.currency ?? "");
    const amountDecimal = new Decimal(String(payload.amount ?? "0"));
    const newBalanceDecimal = new Decimal(String(payload.new_balance ?? "0"));
    const input: WalletTopupInput = {
      orderCode: String(payload.order_code ?? "unknown"),
      customerLabel: String(payload.customer_label ?? ""),
      amount: formatMoney(amountDecimal, currency),
      currency,
      newBalance: formatMoney(newBalanceDecimal, currency),
      paymentMethod: String(payload.payment_method ?? ""),
      transactionId: payload.transaction_id == null ? null : String(payload.transaction_id),
      toppedUpAt: String(payload.topped_up_at ?? ""),
    };
    const brand = await resolveOwnerBrandConfig();
    return renderWalletTopupEmail(input, brand);
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
