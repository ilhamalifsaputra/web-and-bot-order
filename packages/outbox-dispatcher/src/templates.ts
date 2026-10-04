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
import { formatUsdt } from "@app/core/formatters";
import { formatIdrFor } from "@app/core/moneyFormat";

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
  kind?: unknown;
  sharp_changes?: unknown;
  considered_rows?: unknown;
}

interface RestockSubscriberPayload {
  product_name?: unknown;
  buyer_language?: unknown;
}

interface TicketClosedPayload {
  buyer_language?: unknown;
}

/** M13 / audit P0-3 — the hourly market-rate refresh refused what it fetched.
 * `reason` mirrors `FxRateRejection`'s discriminant; the figures below it are
 * present only for the reason that uses them. */
interface AdminFxRateRejectedPayload {
  reason?: unknown;
  market?: unknown;
  rate?: unknown;
  saved?: unknown;
  consecutive_failures?: unknown;
  min?: unknown;
  max?: unknown;
  last_known?: unknown;
  delta_pct?: unknown;
  max_delta_pct?: unknown;
}

/**
 * M13 / audit P0-3 — the saved rate stopped being confirmed. `stage` says which
 * threshold it crossed (whole-branch review D7): `"quote_ttl"` = no USDT rail is
 * offered any more but prices still show USDT, `"max_age"` = USDT is gone
 * shop-wide. Absent means `"max_age"`, which is all this event used to mean, so
 * a row enqueued before the field existed still renders correctly.
 */
interface AdminFxRateStalePayload {
  stage?: unknown;
  confirmed_at?: unknown;
  age_hours?: unknown;
  max_age_hours?: unknown;
  ttl_minutes?: unknown;
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
    AdminDigiflazzResyncAbortedPayload &
    AdminFxRateRejectedPayload &
    AdminFxRateStalePayload &
    TicketClosedPayload &
    RestockSubscriberPayload,
): string {
  if (event === NotificationEvent.TICKET_CLOSED_DM) {
    // Buyer DM (Task 2, Phase C): rendered in the buyer's OWN stored
    // language — a single-locale pick, not the bilingual EN+ID pattern most
    // of this file's other DM templates use — mirroring exactly what
    // handlers/admin.ts's closeTicketAdmin sent directly before this event
    // existed (coreT("support.ticket_closed", buyerLang)). ADMIN_NEW_TICKET
    // and TICKET_REPLY_DM (the other two ticket events from the same task)
    // are NOT rendered here — they need a reply_markup keyboard (and, for
    // ADMIN_NEW_TICKET, a photo media-group send) that this plain-text
    // render() has no way to carry, so dispatcher.ts builds and sends their
    // text itself, the same way it already does for
    // ORDER_DELIVERED_DM/ORDER_MANUAL_DELIVERED_DM.
    const lang = typeof payload.buyer_language === "string" ? payload.buyer_language.toLowerCase() : "en";
    return lang === "id"
      ? "Tiket ditutup. Buka tiket baru jika masih butuh bantuan."
      : "Your ticket has been closed. Open a new one if you need further help.";
  }
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
    // Each language block shows Rupiah with its own language's separators
    // (EN "Rp50,000", ID "Rp50.000"); a USDT amount is a crypto figure and
    // reads the same in both.
    const currency = String(payload.currency ?? "");
    const money = (raw: unknown, lang: "en" | "id") =>
      escape(currency === "IDR" ? formatIdrFor(String(raw ?? "0"), lang) : formatUsdt(String(raw ?? "0")));
    const [amountEn, amountId] = [money(payload.amount, "en"), money(payload.amount, "id")];
    const [newBalanceEn, newBalanceId] = [money(payload.new_balance, "en"), money(payload.new_balance, "id")];
    const creditedEn = code ? `Order <code>${code}</code> — ${amountEn} has been added to your wallet.` : `${amountEn} has been added to your wallet.`;
    const creditedId = code ? `Order <code>${code}</code> — ${amountId} telah ditambahkan ke saldo kamu.` : `${amountId} telah ditambahkan ke saldo kamu.`;
    return (
      `✅ <b>Top-up successful!</b>\n\n` +
      `${creditedEn}\n` +
      `New balance: <b>${newBalanceEn}</b>\n\n` +
      `✅ <b>Top up berhasil!</b>\n\n` +
      `${creditedId}\n` +
      `Saldo baru: <b>${newBalanceId}</b>`
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
  if (event === NotificationEvent.RESTOCK_SUBSCRIBER_NOTIFIED) {
    // Same copy as locale key browse.subscribed_restock_notify (the old direct
    // send), in the buyer's own stored language.
    const name = escape(String(payload.product_name ?? ""));
    const lang = typeof payload.buyer_language === "string" ? payload.buyer_language.toLowerCase() : "en";
    return lang === "id" ? `<b>${name}</b> tersedia kembali.` : `<b>${name}</b> is back in stock.`;
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
    // tripped and wrote nothing. Two distinct trip reasons (digiflazz.ts's
    // local AbortReason union, mirrored in the enqueue payload's `kind`
    // field), each with its own sentence — an admin skimming the DM needs to
    // know which one actually happened, not always read the sharp-change
    // wording:
    //   - "sharp_change" (default/legacy payloads without `kind`): too many
    //     denominations would have repriced by more than 50% in one run.
    //     Payload carries plain counts, no SKU/price detail.
    //   - "no_usable_rows": the supplier's fetch returned no usable price
    //     data at all, even though this shop has Digiflazz-routed
    //     denominations to check against it. No counts to report.
    const header = `⚠️ <b>Digiflazz catalog sync aborted — nothing was updated</b>\n`;
    const headerId = `⚠️ <b>Sinkronisasi katalog Digiflazz dibatalkan — tidak ada yang diperbarui</b>\n`;
    let bodyEn: string;
    let bodyId: string;
    if (payload.kind === "no_usable_rows") {
      bodyEn =
        `The supplier returned no usable price data at all, even though this shop has Digiflazz-routed ` +
        `denominations to check. This usually means a field rename, a partial outage, or the wrong endpoint — ` +
        `please check the Digiflazz connection before the next hourly sync.`;
      bodyId =
        `Supplier tidak mengembalikan data harga yang bisa dipakai sama sekali, padahal toko ini punya denominasi ` +
        `yang terhubung ke Digiflazz untuk dicek. Ini biasanya berarti ada penggantian nama field, gangguan ` +
        `sebagian, atau endpoint yang salah — mohon periksa koneksi Digiflazz sebelum sinkronisasi berikutnya.`;
    } else {
      const sharpChanges = escape(String(payload.sharp_changes ?? "0"));
      const consideredRows = escape(String(payload.considered_rows ?? "0"));
      bodyEn =
        `${sharpChanges} of ${consideredRows} prices would have moved by more than 50% in this run.\n` +
        `This usually means the supplier's response is malformed, not a real price change — please check the Digiflazz connection before the next hourly sync.`;
      bodyId =
        `${sharpChanges} dari ${consideredRows} harga akan berubah lebih dari 50% pada proses ini.\n` +
        `Ini biasanya berarti respons dari supplier tidak valid, bukan perubahan harga asli — mohon periksa koneksi Digiflazz sebelum sinkronisasi berikutnya.`;
    }
    return `${header}${bodyEn}\n\n${headerId}${bodyId}`;
  }
  if (event === NotificationEvent.ADMIN_FX_RATE_REJECTED) {
    // Admin DM: the hourly market-rate refresh fetched a rate that failed
    // validateUsdIdrRate's sanity band, so nothing was saved (M13). The admin
    // needs three things from this message, in this order: that pricing is
    // still safe (the old rate stands — otherwise the first reaction is panic
    // about mispriced orders), WHICH check failed and by how much, and what
    // goes wrong if they ignore it (the saved rate keeps ageing towards the
    // staleness cut-off that hides the USDT rail entirely).
    const market = escape(String(payload.market ?? ""));
    const rate = escape(String(payload.rate ?? ""));
    const saved = payload.saved == null ? null : escape(String(payload.saved));
    const failures = escape(String(payload.consecutive_failures ?? "1"));
    const reason = String(payload.reason ?? "");
    let whyEn: string;
    let whyId: string;
    if (reason === "below_min" || reason === "above_max") {
      const bound = escape(String(payload.min ?? payload.max ?? ""));
      const word = reason === "below_min" ? "below the minimum" : "above the maximum";
      const wordId = reason === "below_min" ? "di bawah batas minimum" : "di atas batas maksimum";
      whyEn = `Rp${rate} per USDT is ${word} plausible rate of Rp${bound}.`;
      whyId = `Rp${rate} per USDT berada ${wordId} yang masuk akal, Rp${bound}.`;
    } else if (reason === "delta_too_large") {
      const lastKnown = escape(String(payload.last_known ?? ""));
      const deltaPct = escape(String(payload.delta_pct ?? ""));
      const maxDeltaPct = escape(String(payload.max_delta_pct ?? ""));
      // Both figures are MARKET rates, not the saved rate: the cap measures the
      // market against the last market figure this shop accepted (whole-branch
      // review D10). Saying "the saved rate" here would send an admin to compare
      // two numbers whose difference is not the percentage quoted.
      whyEn =
        `The market rate Rp${market} per USDT is ${deltaPct}% away from the last market rate accepted, Rp${lastKnown}, ` +
        `more than the ${maxDeltaPct}% move allowed in one refresh.`;
      whyId =
        `Kurs pasar Rp${market} per USDT berjarak ${deltaPct}% dari kurs pasar terakhir yang diterima, Rp${lastKnown}, ` +
        `melebihi batas perubahan ${maxDeltaPct}% dalam satu pembaruan.`;
    } else {
      // not_a_number / not_positive — no configured figure to cite.
      whyEn = `The rate source returned ${rate}, which is not a usable price.`;
      whyId = `Sumber kurs mengembalikan ${rate}, yang tidak bisa dipakai sebagai harga.`;
    }
    return (
      `⚠️ <b>Rejected a USD/IDR rate from the market — the saved rate is still in effect</b>\n` +
      `${whyEn}\n` +
      `Market figure: <b>Rp${market}</b>. Still pricing with: <b>${saved ? `Rp${saved}` : "no saved rate"}</b>.\n` +
      `Consecutive failed refreshes: <b>${failures}</b>.\n` +
      `Nothing was mispriced, but the saved rate keeps ageing — please check the rate source or widen the sanity band in Settings, ` +
      `or USDT payments will be switched off once it passes its maximum age.\n\n` +
      `⚠️ <b>Kurs USD/IDR dari pasar ditolak — kurs tersimpan masih dipakai</b>\n` +
      `${whyId}\n` +
      `Angka pasar: <b>Rp${market}</b>. Masih memakai: <b>${saved ? `Rp${saved}` : "belum ada kurs tersimpan"}</b>.\n` +
      `Kegagalan pembaruan berturut-turut: <b>${failures}</b>.\n` +
      `Tidak ada harga yang salah, tapi kurs tersimpan makin tua — mohon periksa sumber kurs atau lebarkan batas wajar di Pengaturan, ` +
      `kalau tidak pembayaran USDT akan dimatikan begitu kurs melewati umur maksimalnya.`
    );
  }
  if (event === NotificationEvent.ADMIN_FX_RATE_STALE) {
    // Admin DM: the saved rate went unconfirmed long enough to cost the shop
    // USDT sales (M13). Unlike the rejection DM above this is not a warning
    // about something that MIGHT go wrong — it has already happened and the
    // shop is losing USDT sales right now, so the message leads with the
    // consequence, not the cause.
    const confirmedAt = escape(String(payload.confirmed_at ?? ""));
    const ageHours = escape(String(payload.age_hours ?? ""));
    const maxAgeHours = escape(String(payload.max_age_hours ?? ""));
    // Two thresholds, two different consequences (whole-branch review D7). The
    // earlier one takes USDT off the checkout screens while prices still show a
    // USDT figure, so its message must not claim USDT is gone: an admin who
    // looks at the shop and still sees USDT prices would read the alert as a
    // false alarm and stop trusting the category. A payload with no `stage` is
    // the max-age wording, which is the only thing this event used to mean.
    if (payload.stage === "quote_ttl") {
      const ttlMinutes = escape(String(payload.ttl_minutes ?? ""));
      return (
        `⚠️ <b>USDT checkout is not being offered — the saved USD/IDR rate has stopped being refreshed</b>\n` +
        `Last confirmed: <code>${confirmedAt}</code> (about ${ageHours}h ago), past the ${ttlMinutes}-minute quote lifetime.\n` +
        `Customers still see USDT prices, but no USDT payment option is offered and any USDT order is refused; Rupiah payments are unaffected. ` +
        `The hourly automatic update has missed at least three tries, so this will not fix itself.\n` +
        `Fix it in Settings: press "Update now" on the USDT rate, or type a rate by hand. ` +
        `If it is left alone, USDT prices disappear from the shop too once the rate passes its maximum age.\n\n` +
        `⚠️ <b>Checkout USDT tidak ditawarkan — kurs USD/IDR tersimpan berhenti diperbarui</b>\n` +
        `Terakhir dikonfirmasi: <code>${confirmedAt}</code> (sekitar ${ageHours} jam lalu), melewati masa berlaku kuotasi ${ttlMinutes} menit.\n` +
        `Pelanggan masih melihat harga USDT, tapi tidak ada pilihan pembayaran USDT dan setiap pesanan USDT ditolak; pembayaran Rupiah tidak terpengaruh. ` +
        `Pembaruan otomatis tiap jam sudah gagal minimal tiga kali, jadi ini tidak akan beres sendiri.\n` +
        `Perbaiki di Pengaturan: tekan "Update now" pada kurs USDT, atau isi kursnya manual. ` +
        `Kalau dibiarkan, harga USDT juga akan hilang dari toko begitu kurs melewati umur maksimalnya.`
      );
    }
    return (
      `⛔ <b>USDT payments are switched off — the saved USD/IDR rate is too old</b>\n` +
      `Last confirmed: <code>${confirmedAt}</code> (about ${ageHours}h ago), past the ${maxAgeHours}h limit.\n` +
      `Until the rate is refreshed, customers are not shown USDT prices and cannot pay in USDT; Rupiah payments are unaffected.\n` +
      `Fix it in Settings: press "Update now" on the USDT rate, or type a rate by hand. ` +
      `If the automatic update has been failing, turning it back on is not enough on its own — check the rate source too.\n\n` +
      `⛔ <b>Pembayaran USDT dimatikan — kurs USD/IDR tersimpan sudah terlalu lama</b>\n` +
      `Terakhir dikonfirmasi: <code>${confirmedAt}</code> (sekitar ${ageHours} jam lalu), melewati batas ${maxAgeHours} jam.\n` +
      `Selama kurs belum diperbarui, pelanggan tidak melihat harga USDT dan tidak bisa membayar dengan USDT; pembayaran Rupiah tidak terpengaruh.\n` +
      `Perbaiki di Pengaturan: tekan "Update now" pada kurs USDT, atau isi kursnya manual. ` +
      `Kalau pembaruan otomatis memang sedang gagal, menyalakannya kembali saja tidak cukup — periksa juga sumber kursnya.`
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
    if (payload.reason === "unverified_amount") {
      // Task B fix round: the gateway says PAID but its status carries no
      // usable amount (TokoPay/PayDisini) or no usd price to value it by
      // (NOWPayments), so the payment cannot be verified and nothing is
      // delivered on it.
      return (
        `⚠️ <b>${gateway} reports order <code>${code}</code> as paid, but the amount could not be verified</b>\n` +
        `The gateway's status carried no usable amount, so nothing has been delivered automatically. ` +
        `Check this order in the ${gateway} dashboard and either approve or cancel it by hand — ` +
        `if it is left alone, the payment window will close and the order will auto-cancel even though the buyer may have paid.\n\n` +
        `⚠️ <b>${gateway} melaporkan pesanan <code>${code}</code> sudah dibayar, tapi nominalnya tidak bisa diverifikasi</b>\n` +
        `Status dari gateway tidak memuat nominal yang bisa dipakai, jadi belum ada yang dikirim otomatis. ` +
        `Periksa pesanan ini di dashboard ${gateway} lalu setujui atau batalkan secara manual — ` +
        `kalau dibiarkan, jendela pembayaran akan tutup dan pesanan otomatis dibatalkan padahal pelanggan mungkin sudah membayar.`
      );
    }
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
