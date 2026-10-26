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
  },
};
