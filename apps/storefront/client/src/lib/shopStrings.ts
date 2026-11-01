/**
 * Storefront-only copy, merged into `t()` beside the shared locale JSONs
 * (packages/core/locales). Used for strings only the web shop shows, so they
 * can ship with the storefront client without touching the shared files the
 * bot also reads. Keys live under the `shop.` namespace and must never collide
 * with a shared key, and both languages carry the same keys with the same
 * {placeholders} — lib/shopStrings.test.ts enforces all three.
 *
 * Wording is product-family neutral (AGENTS.md): no game, top-up, app or
 * account terms, because the same rows render for Premium Apps and Game Top Up.
 */
export const SHOP_STRINGS: Record<"en" | "id", Record<string, string>> = {
  en: {
    "shop.tier_ladder_title": "Buy more, pay less per item",
    "shop.tier_ladder_row": "{qty}+ items",
    "shop.tier_ladder_price": "{price} each",
    "shop.tier_unit_each": "{price} each",
    "shop.tier_qty_total": "Total for {qty}",
    "shop.tier_savings": "Quantity deal: you save {amount}",
    "shop.tier_line_unit": "{qty} × {price}",
    "shop.tier_price_updating": "Updating the price…",
    "shop.tier_price_unavailable": "The price for this quantity could not be loaded. Try again.",
    "shop.bulk_hint_up_to": "Buy {qty}+ and save up to {percent}%",
    "shop.bulk_badge_up_to": "up to −{percent}%",
    "shop.quote_changed_title": "The price changed",
    "shop.quote_changed_body": "The total changed since this summary was shown, and nothing was charged. Check the new total below, then tap the button again to confirm.",
    "shop.checkout_unknown_title": "We couldn't confirm your order",
    "shop.checkout_unknown_body": "It may have been placed. Check your orders before buying again. Try again below repeats the same request, so the shop returns the order it already made instead of making a new one.",
    "shop.checkout_unknown_body_wallet": "It may have been placed, and if it was, the amount has already been taken from your wallet balance. Check your orders before buying again. Try again below repeats the same request, so the shop returns the order it already made instead of making a new one.",
    "shop.checkout_unknown_orders": "View my orders",
    "shop.checkout_unknown_retry": "Try again",
    "shop.session_ended_checkout": "Your session ended. Log in again to finish checkout.",
    "shop.session_ended_cart": "Your session ended. Log in again to see your cart.",
    "shop.session_ended_login": "Log in",
  },
  id: {
    "shop.tier_ladder_title": "Beli lebih banyak, harga per item lebih murah",
    "shop.tier_ladder_row": "{qty}+ item",
    "shop.tier_ladder_price": "{price} per item",
    "shop.tier_unit_each": "{price} per item",
    "shop.tier_qty_total": "Total untuk {qty}",
    "shop.tier_savings": "Harga grosir: hemat {amount}",
    "shop.tier_line_unit": "{qty} × {price}",
    "shop.tier_price_updating": "Memperbarui harga…",
    "shop.tier_price_unavailable": "Harga untuk jumlah ini belum bisa dimuat. Coba lagi.",
    "shop.bulk_hint_up_to": "Beli {qty}+ hemat hingga {percent}%",
    "shop.bulk_badge_up_to": "hingga −{percent}%",
    "shop.quote_changed_title": "Harga berubah",
    "shop.quote_changed_body": "Total berubah sejak ringkasan ini ditampilkan, dan belum ada yang ditagih. Cek total baru di bawah, lalu ketuk tombolnya lagi untuk konfirmasi.",
    "shop.checkout_unknown_title": "Kami belum bisa memastikan pesananmu",
    "shop.checkout_unknown_body": "Pesanan mungkin sudah dibuat. Cek pesananmu sebelum membeli lagi. Tombol Coba lagi di bawah mengirim permintaan yang sama, jadi toko mengembalikan pesanan yang sudah dibuat, bukan membuat pesanan baru.",
    "shop.checkout_unknown_body_wallet": "Pesanan mungkin sudah dibuat, dan jika ya, jumlahnya sudah dipotong dari saldo dompetmu. Cek pesananmu sebelum membeli lagi. Tombol Coba lagi di bawah mengirim permintaan yang sama, jadi toko mengembalikan pesanan yang sudah dibuat, bukan membuat pesanan baru.",
    "shop.checkout_unknown_orders": "Lihat pesananku",
    "shop.checkout_unknown_retry": "Coba lagi",
    "shop.session_ended_checkout": "Sesimu sudah berakhir. Masuk lagi untuk menyelesaikan pembayaran.",
    "shop.session_ended_cart": "Sesimu sudah berakhir. Masuk lagi untuk melihat keranjangmu.",
    "shop.session_ended_login": "Masuk",
  },
};
