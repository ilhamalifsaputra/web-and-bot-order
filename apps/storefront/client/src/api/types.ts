/** Response shapes for the storefront JSON API (/api/v1/pages/*).
 * Server side: apps/storefront/src/routes/apiPages.ts — keep in sync. */

/** Signed-in customer as exposed to the client (display fields only — the
 * CSRF token travels via the shell's meta tag, never in JSON). */
export interface CustomerInfo {
  username: string | null;
  email: string | null;
  telegram_linked: boolean;
}

/** Base context for the shop chrome — JSON twin of shopContext()
 * (apps/storefront/src/shop.ts) minus csrf/active_nav/path, which the SPA
 * derives client-side. */
export interface ShopContext {
  lang: string;
  /** USDT rate (Rupiah per 1 USDT) as a string, or null = hide USDT hints. */
  fx: string | null;
  shop_name: string;
  shop_tagline: string;
  cart_count: number;
  customer: CustomerInfo | null;
  favicon_url: string;
  logo_url: string;
  bot_username: string;
  tzname: string;
}
