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

function strings(lang: string | null | undefined): Strings {
  if (!lang) return STRINGS[DEFAULT_LANG]!;
  return STRINGS[lang.toLowerCase()] ?? STRINGS[DEFAULT_LANG]!;
}

/** Mirror Python html.escape(quote=True). */
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

interface Item {
  name?: unknown;
  qty?: unknown;
  duration?: unknown;
}

function fmtItems(items: Item[]): string {
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
  return lines.join("\n");
}

interface DeliveredPayload {
  buyer_language?: string;
  items?: Item[];
  masked_buyer_id?: unknown;
  total?: unknown;
  currency?: unknown;
  delivered_at?: unknown;
}

interface AdminResetPayload {
  code?: unknown;
  ttl_minutes?: unknown;
}

interface DeliveredDmPayload {
  order_code?: unknown;
  order_url?: unknown;
}

/** Return the message body for an outbox event, or "" to skip. */
export function render(
  event: string,
  payload: DeliveredPayload & AdminResetPayload & DeliveredDmPayload,
): string {
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
  if (event === NotificationEvent.ORDER_DELIVERED_DM) {
    // Buyer DM after a web order auto-delivers (TokoPay path). Bilingual; links
    // to the storefront order page — credentials are NEVER carried in the
    // outbox payload (the /outbox admin panel would show them).
    const code = escape(String(payload.order_code ?? ""));
    const rawUrl = typeof payload.order_url === "string" ? payload.order_url : "";
    const url = /^https?:\/\//.test(rawUrl) ? rawUrl : "";
    const linkEn = url ? `\nView it here: ${escape(url)}` : "";
    const linkId = url ? `\nLihat di sini: ${escape(url)}` : "";
    return (
      `✅ <b>Order <code>${code}</code> delivered!</b>\n` +
      `Your payment is confirmed and your credentials are ready on the website (My orders).${linkEn}\n\n` +
      `✅ <b>Pesanan <code>${code}</code> terkirim!</b>\n` +
      `Pembayaran dikonfirmasi — akunmu sudah siap di website (Pesananku).${linkId}`
    );
  }
  if (event === NotificationEvent.ORDER_DELIVERED) {
    const s = strings(payload.buyer_language);
    const itemsText = fmtItems(payload.items ?? []);
    const buyer = escape(String(payload.masked_buyer_id ?? "????"));
    const total = escape(String(payload.total ?? "0"));
    const currency = escape(String(payload.currency ?? "USDT"));
    const deliveredAt = escape(String(payload.delivered_at ?? ""));
    return (
      `📢 <b>${s.title}</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👤 ${s.buyer}: <code>${buyer}</code>\n` +
      `🛍️ ${s.products}:\n${itemsText}\n` +
      `💳 ${s.total}: <b>${total} ${currency}</b>\n` +
      `📅 ${s.date}: ${deliveredAt}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${s.thanks}\n` +
      `━━━━━━━━━━━━━━━━━━`
    );
  }
  return "";
}
