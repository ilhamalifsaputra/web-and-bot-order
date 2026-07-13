/**
 * Render notification_outbox payloads into Telegram HTML messages.
 * Direct port of notif_bot/templates.py. The testimoni post is rendered in the
 * buyer's app language (payload.buyer_language), falling back to English.
 *
 * NOTE: the Python code matched on the event *value* ("order.delivered"); the
 * DB actually stores the enum *name* ("ORDER_DELIVERED"), which is what Prisma
 * returns here. We match on the stored name (NotificationEvent.ORDER_DELIVERED).
 */
import { NotificationEvent } from "@app/core/enums";

interface Strings {
  title: string;
  buyer: string;
  products: string;
  total: string;
  date: string;
  thanks: string;
}

const STRINGS: Record<string, Strings> = {
  en: {
    title: "TESTIMONIAL",
    buyer: "Buyer",
    products: "Products",
    total: "Total",
    date: "Date",
    thanks: "🎉 Thank you for shopping with us! 🛍️",
  },
  id: {
    title: "TESTIMONI",
    buyer: "Pembeli",
    products: "Produk",
    total: "Total",
    date: "Tanggal",
    thanks: "🎉 Terima kasih sudah berbelanja! 🛍️",
  },
};
const DEFAULT_LANG = "en";

/** Cap for ORDER_DELIVERED interpolated fields — mirrors
 * enqueueOrderPipelineFailed's 300-char `reason` truncation precedent. */
const MAX_INTERPOLATION_LEN = 300;

function strings(lang: string | null | undefined): Strings {
  if (!lang) return STRINGS[DEFAULT_LANG]!;
  return STRINGS[lang.toLowerCase()] ?? STRINGS[DEFAULT_LANG]!;
}

/** Mirror Python html.escape(quote=True). Exported so dispatcher.ts can reuse
 * the same escaping for admin free-text (deliveredContent) it renders itself
 * (ORDER_MANUAL_DELIVERED_DM), rather than duplicating this logic. */
export function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Slice an already-escaped string to at most `maxLen` chars without landing
 * mid-entity (e.g. cutting "&amp;" down to "&am"), which would render as
 * inert text instead of the intended character but is otherwise harmless
 * (unlike splitting an HTML tag, this can't break `parse_mode: "HTML"`
 * parsing). If the cut lands inside a trailing unclosed "&...", drop that
 * partial entity entirely rather than emit it verbatim. */
function truncateEscaped(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastAmp = cut.lastIndexOf("&");
  if (lastAmp !== -1 && !cut.slice(lastAmp).includes(";")) {
    return cut.slice(0, lastAmp);
  }
  return cut;
}

interface Item {
  name?: unknown;
  qty?: unknown;
  duration?: unknown;
}

/** Join formatted item lines, capping the result to roughly `maxLen` chars
 * *without* ever cutting inside a line — each item's `<i>...</i>` duration
 * tag is opened and closed within the same line, so keeping whole lines
 * intact guarantees we never emit unbalanced HTML (unlike a raw
 * `.slice(0, maxLen)` on the joined string, which can land mid-tag and make
 * Telegram's `parse_mode: "HTML"` reject the whole message). If even the
 * first line alone exceeds maxLen, keep it whole anyway (valid HTML over an
 * exact 300-char cap). */
function fmtItems(items: Item[], maxLen: number): string {
  const lines: string[] = [];
  for (const it of items) {
    const name = escape(String(it.name ?? "?"));
    const qty = Number.parseInt(String(it.qty ?? 1), 10) || 1;
    const duration = it.duration;
    if (duration) {
      lines.push(`   • ${name} <i>(${escape(String(duration))})</i> x${qty}`);
    } else {
      lines.push(`   • ${name} x${qty}`);
    }
  }
  let result = "";
  for (const line of lines) {
    const candidate = result ? `${result}\n${line}` : line;
    if (candidate.length > maxLen) break;
    result = candidate;
  }
  if (!result && lines.length > 0) {
    // First item alone already exceeds maxLen — keep it whole rather than
    // truncate mid-tag.
    result = lines[0]!;
  }
  return result;
}

interface DeliveredPayload {
  buyer_language?: string;
  items?: Item[];
  masked_buyer_id?: unknown;
  total?: unknown;
  currency?: unknown;
  delivered_at?: unknown;
  via_website?: unknown;
}

interface AdminResetPayload {
  code?: unknown;
  ttl_minutes?: unknown;
}

interface AdminOverpaidPayload {
  order_code?: unknown;
  paid?: unknown;
  expected?: unknown;
  excess?: unknown;
  currency?: unknown;
}

interface OrderPipelineFailedPayload {
  order_code?: unknown;
  reason?: unknown;
}

interface OrderProcessingPayload {
  order_code?: unknown;
  order_url?: unknown;
}

/** Return the message body for an outbox event, or "" to skip. */
export function render(
  event: string,
  payload: DeliveredPayload &
    AdminResetPayload &
    AdminOverpaidPayload &
    OrderPipelineFailedPayload &
    OrderProcessingPayload,
): string {
  if (event === NotificationEvent.ORDER_PROCESSING_DM) {
    // Buyer DM: a manual-delivery order's payment was confirmed and it's now
    // queued for hand-fulfilment. Deliberately no ETA/SLA promise here — the
    // richer order-detail screen (later task) owns that copy; this terse DM
    // just reassures the buyer payment went through.
    const code = escape(String(payload.order_code ?? ""));
    const url = typeof payload.order_url === "string" && payload.order_url ? escape(payload.order_url) : "";
    const linkLine = url ? `\n🔗 ${url}` : "";
    return (
      `✅ <b>Payment received for order <code>${code}</code></b>\n` +
      `📦 Your order is being prepared by hand — we'll notify you as soon as possible.${linkLine}\n\n` +
      `✅ <b>Pembayaran diterima untuk pesanan <code>${code}</code></b>\n` +
      `📦 Pesananmu sedang disiapkan secara manual — kami akan segera memberi tahu kamu.${linkLine}`
    );
  }
  if (event === NotificationEvent.ORDER_PIPELINE_FAILED) {
    // Admin DM: a Bybit BSC order's automated tracking pipeline failed
    // post-detection and needs manual action. `reason` is a short
    // diagnostic string, already truncated/escaped at enqueue time, but
    // escaped again here too since every other template treats payload
    // values as untrusted on principle.
    const code = escape(String(payload.order_code ?? ""));
    const reason = escape(String(payload.reason ?? ""));
    return (
      `⚠️ <b>Order <code>${code}</code> tracking failed</b>\n` +
      `${reason}\n` +
      `Manual action needed — check the order in the admin panel.\n\n` +
      `⚠️ <b>Pelacakan pesanan <code>${code}</code> gagal</b>\n` +
      `${reason}\n` +
      `Perlu tindakan manual — cek pesanan ini di panel admin.`
    );
  }
  if (event === NotificationEvent.ADMIN_OVERPAID) {
    // Admin DM (not a channel post): a gateway webhook delivered an order
    // whose paid amount exceeded the total. All values are escaped even
    // though they originate from our own Decimal math, not gateway input.
    const code = escape(String(payload.order_code ?? ""));
    const paid = escape(String(payload.paid ?? "0"));
    const expected = escape(String(payload.expected ?? "0"));
    const excess = escape(String(payload.excess ?? "0"));
    const currency = escape(String(payload.currency ?? ""));
    return (
      `⚠️ <b>Overpayment on order <code>${code}</code></b>\n` +
      `Paid: <b>${paid} ${currency}</b>\n` +
      `Expected: <b>${expected} ${currency}</b>\n` +
      `Excess: <b>${excess} ${currency}</b>\n` +
      `The order was delivered as usual — please review the excess for a refund/credit.\n\n` +
      `⚠️ <b>Kelebihan bayar pada pesanan <code>${code}</code></b>\n` +
      `Dibayar: <b>${paid} ${currency}</b>\n` +
      `Seharusnya: <b>${expected} ${currency}</b>\n` +
      `Kelebihan: <b>${excess} ${currency}</b>\n` +
      `Pesanan tetap terkirim seperti biasa — tolong tinjau kelebihan bayar ini untuk refund/kredit.`
    );
  }
  if (event === NotificationEvent.ADMIN_PW_RESET) {
    // Admin DM (not a channel post). Bilingual + the code is escaped just in case.
    const code = escape(String(payload.code ?? ""));
    const ttl = Number.parseInt(String(payload.ttl_minutes ?? 10), 10) || 10;
    return (
      `🔐 <b>Web admin password reset</b>\n` +
      `Your one-time code is <code>${code}</code> ` +
      `(valid ${ttl} min). Enter it on the reset page.\n` +
      `If you didn't request this, ignore this message — your password is unchanged.\n\n` +
      `🔐 <b>Reset password admin web</b>\n` +
      `Kode sekali pakai: <code>${code}</code> ` +
      `(berlaku ${ttl} menit). Masukkan di halaman reset.\n` +
      `Abaikan pesan ini jika kamu tidak memintanya.`
    );
  }
  if (event === NotificationEvent.ORDER_DELIVERED) {
    const s = strings(payload.buyer_language);
    // Cap interpolated fields to 300 chars, same precedent as
    // enqueueOrderPipelineFailed's `reason.slice(0, 300)` — an unusually long
    // product-name list (or a pathological masked_buyer_id/total) shouldn't be
    // able to push this message past Telegram's message-length limit
    // (Outbox-5 fix, backend audit).
    const itemsText = fmtItems(payload.items ?? [], MAX_INTERPOLATION_LEN);
    const buyer = truncateEscaped(escape(String(payload.masked_buyer_id ?? "????")), MAX_INTERPOLATION_LEN);
    const total = truncateEscaped(escape(String(payload.total ?? "0")), MAX_INTERPOLATION_LEN);
    const currency = escape(String(payload.currency ?? "USDT"));
    const deliveredAt = escape(String(payload.delivered_at ?? ""));
    const viaWeb = payload.via_website ? `\n🌐 via Website` : "";
    return (
      `📢 <b>${s.title}</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👤 ${s.buyer}: <code>${buyer}</code>\n` +
      `🛍️ ${s.products}:\n${itemsText}\n` +
      `💳 ${s.total}: <b>${total} ${currency}</b>\n` +
      `📅 ${s.date}: ${deliveredAt}${viaWeb}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${s.thanks}\n` +
      `━━━━━━━━━━━━━━━━━━`
    );
  }
  return "";
}
