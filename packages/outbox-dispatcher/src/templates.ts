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
import { formatIdr, formatUsdt } from "@app/core/formatters";

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

interface RestockBroadcastPayload {
  product_name?: unknown;
  stock_count?: unknown;
}

interface FlashSaleBroadcastPayload {
  product_name?: unknown;
  denomination_name?: unknown;
  discount_percent?: unknown;
  old_price?: unknown;
  new_price?: unknown;
  ends_at?: unknown;
}

interface ManualOrderQueuedPayload {
  order_code?: unknown;
  items?: Item[];
  total?: unknown;
  currency?: unknown;
}

interface BulkPurchaseBroadcastPayload {
  product_name?: unknown;
  denomination_name?: unknown;
  qty?: unknown;
  template?: unknown;
}

interface AdminStalePaymentPayload {
  order_code?: unknown;
  gateway?: unknown;
  trx_id?: unknown;
}

interface WalletTopupCreditedPayload {
  order_code?: unknown;
  amount?: unknown;
  currency?: unknown;
  new_balance?: unknown;
}

interface AdminDigiflazzResyncAbortedPayload {
  sharp_changes?: unknown;
  considered_rows?: unknown;
}

/** Return the message body for an outbox event, or "" to skip. */
export function render(
  event: string,
  payload: DeliveredPayload &
    AdminResetPayload &
    AdminOverpaidPayload &
    OrderPipelineFailedPayload &
    OrderProcessingPayload &
    RestockBroadcastPayload &
    FlashSaleBroadcastPayload &
    ManualOrderQueuedPayload &
    BulkPurchaseBroadcastPayload &
    AdminStalePaymentPayload &
    WalletTopupCreditedPayload &
    AdminDigiflazzResyncAbortedPayload,
): string {
  if (event === NotificationEvent.WALLET_TOPUP_CREDITED_DM) {
    // Buyer DM: the single producer for a wallet top-up's success message
    // across ALL SIX top-up rails — enqueued exactly once, from inside
    // settleWalletTopup (packages/db/src/crud/wallet_topup.ts), right after
    // its atomic claim succeeds. No rail-specific caller may enqueue this
    // event itself, or the buyer would be notified twice for the same
    // top-up — this used to be split across two different producers (three
    // webhook rails enqueuing here, three poller rails DMing the buyer
    // directly from the bot process) that each assumed they were the only
    // one, which is exactly what let a QRIS top-up double-notify. No
    // buyer_language in the payload (unlike ORDER_PROCESSING_DM) — bilingual
    // EN+ID in one message, same fallback every other per-order DM template
    // here uses.
    // `order_code` is absent on a row enqueued before this event carried one
    // and still PENDING at deploy (a pre-existing legacy row) — render the
    // amount/balance sentence without a dangling `Order <code></code> —`
    // prefix rather than an empty tag pair.
    const rawCode = payload.order_code;
    const code = typeof rawCode === "string" && rawCode ? escape(rawCode) : "";
    const currency = String(payload.currency ?? "");
    const formatMoney = currency === "IDR" ? formatIdr : formatUsdt;
    const amount = escape(formatMoney(String(payload.amount ?? "0")));
    const newBalance = escape(formatMoney(String(payload.new_balance ?? "0")));
    const creditedEn = code ? `Order <code>${code}</code> — ${amount} has been added to your wallet.` : `${amount} has been added to your wallet.`;
    const creditedId = code ? `Order <code>${code}</code> — ${amount} telah ditambahkan ke saldo kamu.` : `${amount} telah ditambahkan ke saldo kamu.`;
    return (
      `✅ <b>Top-up successful!</b>\n\n` +
      `${creditedEn}\n` +
      `New balance: <b>${newBalance}</b>\n\n` +
      `✅ <b>Top up berhasil!</b>\n\n` +
      `${creditedId}\n` +
      `Saldo baru: <b>${newBalance}</b>`
    );
  }
  if (event === NotificationEvent.BULK_PURCHASE_BROADCAST) {
    // Channel post: qty/product_name/denomination_name are derived from the
    // order and escaped like every other interpolated value, but `template`
    // itself is the admin's own copy (authored in Settings), so it's used as
    // literal text — the same trust level the hardcoded FLASH_SALE_BROADCAST/
    // PRODUCT_RESTOCKED_BROADCAST copy gets below, just sourced from the DB
    // instead of this file.
    const product = escape(String(payload.product_name ?? ""));
    const denomination = escape(String(payload.denomination_name ?? ""));
    const qty = escape(String(payload.qty ?? "0"));
    // Payload always carries `template` (orders.ts falls back to its own
    // default before enqueueing) — this is just a defensive last resort.
    const template = String(payload.template ?? "Someone just purchased x{qty} of {product} - {denomination}!");
    return template
      .replaceAll("{qty}", qty)
      .replaceAll("{product}", product)
      .replaceAll("{denomination}", denomination);
  }
  if (event === NotificationEvent.FLASH_SALE_BROADCAST) {
    // Buyer DM broadcast to all customers when a scheduled flash sale goes
    // live. English only — same choice as PRODUCT_RESTOCKED_BROADCAST above
    // (the other broadcast event), rather than the bilingual EN+ID block the
    // per-order DM templates use. product_name/denomination_name are
    // admin-entered, so both are escaped; the prices and end time are already
    // display-formatted at enqueue time (shop currency + shop timezone) and
    // escaped here on the same "payload values are untrusted" principle every
    // other template follows.
    const product = escape(String(payload.product_name ?? ""));
    const plan = escape(String(payload.denomination_name ?? ""));
    const percent = escape(String(payload.discount_percent ?? "0"));
    const oldPrice = escape(String(payload.old_price ?? ""));
    const newPrice = escape(String(payload.new_price ?? ""));
    const endsAt = escape(String(payload.ends_at ?? ""));
    return (
      `⚡ <b>FLASH SALE — ${percent}% OFF</b>\n\n` +
      `<b>${product} — ${plan}</b> is on sale right now! 🎉\n\n` +
      `💸 <b>Now ${newPrice}</b> (was <s>${oldPrice}</s>)\n` +
      `⏳ <b>Ends:</b> ${endsAt}\n\n` +
      `Grab it before the timer runs out!`
    );
  }
  if (event === NotificationEvent.PRODUCT_RESTOCKED_BROADCAST) {
    // Buyer DM broadcast to all customers, sent as-given (English only, not
    // the bilingual EN+ID pattern the other DM templates use) — the shop
    // owner supplied this exact copy. product_name is escaped since it's
    // admin-entered text.
    const name = escape(String(payload.product_name ?? ""));
    const count = Number.parseInt(String(payload.stock_count ?? "0"), 10) || 0;
    return (
      `👋 Hello!\n\n` +
      `We're happy to let you know that <b>${name}</b> is back in stock! 🎉\n\n` +
      `📦 <b>Available Stock:</b> <b>${count}</b> accounts\n\n` +
      `Order now while supplies last. Thank you for choosing us!`
    );
  }
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
  if (event === NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED) {
    // Admin DM (not a channel post): a paid order routed to the hand-fulfilment
    // queue (settlePaidOrder's MANUAL branch) and needs an admin to fulfil it
    // by hand. items/total mirror the ORDER_DELIVERED testimonial shape.
    const code = escape(String(payload.order_code ?? ""));
    const itemsText = fmtItems(payload.items ?? [], MAX_INTERPOLATION_LEN);
    const total = truncateEscaped(escape(String(payload.total ?? "0")), MAX_INTERPOLATION_LEN);
    const currency = escape(String(payload.currency ?? ""));
    return (
      `📦 <b>Order <code>${code}</code> needs manual fulfilment</b>\n` +
      `${itemsText}\n` +
      `💳 Total: <b>${total} ${currency}</b>\n` +
      `Payment confirmed — please fulfil this order by hand in the admin panel.\n\n` +
      `📦 <b>Pesanan <code>${code}</code> perlu difulfil manual</b>\n` +
      `${itemsText}\n` +
      `💳 Total: <b>${total} ${currency}</b>\n` +
      `Pembayaran sudah dikonfirmasi — tolong fulfil pesanan ini secara manual di panel admin.`
    );
  }
  if (event === NotificationEvent.ADMIN_STALE_PAYMENT) {
    // Admin DM: a payment-gateway webhook confirmed payment for an order that
    // had already left PENDING_PAYMENT (typically auto-cancelled) by the time
    // the delivery transaction ran — nothing else recovers this
    // automatically, so a human needs to check and reconcile manually.
    const code = escape(String(payload.order_code ?? ""));
    const gateway = escape(String(payload.gateway ?? ""));
    const trxId = escape(String(payload.trx_id ?? ""));
    return (
      `⚠️ <b>${gateway} confirmed payment for order <code>${code}</code>, but it was no longer pending</b>\n` +
      `Transaction: <code>${trxId}</code>\n` +
      `The order likely auto-cancelled before this payment could be matched — please verify the buyer paid and deliver manually if so.\n\n` +
      `⚠️ <b>${gateway} mengonfirmasi pembayaran untuk pesanan <code>${code}</code>, tapi pesanan ini sudah tidak lagi menunggu pembayaran</b>\n` +
      `Transaksi: <code>${trxId}</code>\n` +
      `Pesanan kemungkinan sudah dibatalkan otomatis sebelum pembayaran ini bisa dicocokkan — mohon periksa apakah pelanggan sudah membayar dan kirim manual jika perlu.`
    );
  }
  if (event === NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED) {
    // Admin DM: resyncDigiflazzCatalog's own blast-radius circuit breaker
    // tripped and wrote nothing — too many denominations would have
    // repriced sharply in one run, which usually means the supplier's
    // response is malformed rather than a genuine price change. Payload
    // carries only plain counts, no SKU/price detail.
    const sharpChanges = escape(String(payload.sharp_changes ?? "0"));
    const consideredRows = escape(String(payload.considered_rows ?? "0"));
    return (
      `⚠️ <b>Digiflazz catalog sync aborted — nothing was updated</b>\n` +
      `${sharpChanges} of ${consideredRows} prices would have moved by more than 50% in this run.\n` +
      `This usually means the supplier's response is malformed, not a real price change — please check the Digiflazz connection before the next hourly sync.\n\n` +
      `⚠️ <b>Sinkronisasi katalog Digiflazz dibatalkan — tidak ada yang diperbarui</b>\n` +
      `${sharpChanges} dari ${consideredRows} harga akan berubah lebih dari 50% pada proses ini.\n` +
      `Ini biasanya berarti respons dari supplier tidak valid, bukan perubahan harga asli — mohon periksa koneksi Digiflazz sebelum sinkronisasi berikutnya.`
    );
  }
  if (event === NotificationEvent.ADMIN_UNCONFIRMABLE_PAYMENT) {
    // Admin DM: the gateway says this order is paid, but returned no
    // transaction id — and that id is the rail's idempotency-ledger key, so
    // the poller refuses to deliver rather than claim the delivery under a key
    // the webhook could never match (Task E4). Nothing recovers this on its
    // own: if the webhook never arrives either, the order runs out its payment
    // window and auto-cancels with the buyer already charged. The message has
    // to tell the admin the deadline, not just the fault — this arrives once
    // per order and there is no second reminder.
    const code = escape(String(payload.order_code ?? ""));
    const gateway = escape(String(payload.gateway ?? ""));
    return (
      `⚠️ <b>${gateway} reports order <code>${code}</code> as paid, but sent no transaction id</b>\n` +
      `Without that id the payment cannot be confirmed automatically, so nothing has been delivered. ` +
      `Check this order in the ${gateway} dashboard and either approve or cancel it by hand — ` +
      `if it is left alone, the payment window will close and the order will auto-cancel even though the buyer paid.\n\n` +
      `⚠️ <b>${gateway} melaporkan pesanan <code>${code}</code> sudah dibayar, tapi tidak mengirim id transaksi</b>\n` +
      `Tanpa id itu pembayaran tidak bisa dikonfirmasi otomatis, jadi belum ada yang dikirim. ` +
      `Periksa pesanan ini di dashboard ${gateway} lalu setujui atau batalkan secara manual — ` +
      `kalau dibiarkan, jendela pembayaran akan tutup dan pesanan otomatis dibatalkan padahal pelanggan sudah membayar.`
    );
  }
  if (event === NotificationEvent.ADMIN_OVERPAID) {
    // Admin DM (not a channel post): one of the six payment rails delivered
    // an order whose paid amount exceeded the total. All values are escaped even
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
