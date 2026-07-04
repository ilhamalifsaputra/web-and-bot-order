/** Response shapes for the storefront JSON API (/api/v1/pages/*).
 * Server side: apps/storefront/src/routes/apiPages.ts — keep in sync. */
import type { ProductCardData } from "../components/shop/ProductCard";

/** Signed-in customer as exposed to the client (display fields only — the
 * CSRF token travels via the shell's meta tag, never in JSON). */
export interface CustomerInfo {
  username: string | null;
  email: string | null;
  telegram_linked: boolean;
}

/** JSON twin of the Prisma `Category` row (packages/db categories table) —
 * shape returned verbatim by listActiveCategories()/getCategoryBySlug(). */
export interface Category {
  id: number;
  name: string;
  slug: string;
  emoji: string | null;
  description: string | null;
  image: string | null;
  sortOrder: number;
  isActive: boolean;
}

/** Homepage category tile — a Category with `image` replaced by the resolved
 * display image (apps/storefront/src/pageData.ts homePageData()); home.njk
 * itself only reads emoji/slug/name, image is unused there. */
export interface HomeCategory extends Omit<Category, "image"> {
  image: string;
}

/** Honest home-page figures (apps/storefront/src/pageData.ts) — currently
 * unused by home.njk's markup (the stats band was replaced by the static
 * "Our Promise" section, design.md §4.8), kept here only to mirror the API
 * payload 1:1. */
export interface HomeStats {
  has_data: boolean;
  customers: number;
  orders: number;
  satisfaction: number | null;
}

/** A real delivered-order review shown in the homepage testimonials grid. */
export interface Testimonial {
  name: string;
  initial: string;
  product: string;
  rating: number;
  comment: string;
}

/** GET /api/v1/pages/home — everything home.njk spread on top of shopContext(). */
export interface HomePageData {
  hero_image: string | null;
  categories: HomeCategory[];
  products: ProductCardData[];
  stats: HomeStats;
  testimonials: Testimonial[];
  low_threshold: number;
  bot_username: string;
  wa_number: string;
}

/** GET /api/v1/pages/category/:slug — everything catalog.njk spread on top
 * of shopContext(); 404 (null server-side) surfaces as an apiGet error with
 * `.status === 404` instead. */
export interface CategoryPageData {
  category: Category;
  categories: Category[];
  products: ProductCardData[];
  low_threshold: number;
}

/** GET /api/v1/pages/search — everything search.njk spread on top of shopContext(). */
export interface SearchPageData {
  q: string;
  products: ProductCardData[];
  low_threshold: number;
}

/** A single denomination (plan/variant) on the product detail page — JSON twin
 * of the `denominations` entries productPageData() builds (apps/storefront/src/pageData.ts). */
export interface ProductDenomination {
  id: number;
  name: string;
  duration_label: string | null;
  price: string;
  warranty_days: number;
  available: number;
  in_stock: boolean;
  bulk: { min_quantity: number; discount_percent: string } | null;
}

/** A masked-author review on the product detail page — `created_at_display`
 * arrives pre-formatted in the shop timezone (apps/storefront/src/routes/apiPages.ts). */
export interface ProductReview {
  rating: number;
  comment: string | null;
  author: string;
  created_at_display: string;
}

/** GET /api/v1/pages/product/:slug — everything product.njk spread on top of
 * shopContext(); 404 (null server-side) surfaces as an apiGet error with
 * `.status === 404` instead. */
export interface ProductPageData {
  product: {
    slug: string;
    name: string;
    description: string | null;
    category_name: string;
    category_slug: string;
    image: string;
  };
  denominations: ProductDenomination[];
  default_restock_denomination_id: number;
  reviews: ProductReview[];
  low_threshold: number;
}

/** One cart line — JSON twin of CartLineView (apps/storefront/src/routes/cart.ts). */
export interface CartLineView {
  key: number;
  denomination_id: number;
  product_slug: string;
  name: string;
  image: string;
  unit_price: string;
  qty: number;
  line_total: string;
  available: number;
}

/** GET /api/v1/cart, and the fresh payload every cart mutation (add/update/remove)
 * responds with — the SPA re-renders from this instead of a full page reload. */
export interface CartPageData {
  items: CartLineView[];
  subtotal: string;
}

/** GET /api/v1/checkout, and the twin shape POST /checkout/voucher/preview
 * responds with (server: checkoutView() in apps/storefront/src/routes/checkout.ts).
 * The voucher-preview response only ever drives the totals card + method-enabled
 * flags — CheckoutPage keeps it in state separate from the payment-method radios,
 * mirroring the HTMX swap that only ever replaced #checkout-summary. */
export interface CheckoutData {
  items_empty: boolean;
  subtotal: string;
  bulk_discount: string;
  voucher_discount: string;
  total: string;
  total_usdt: string | null;
  voucher_code: string;
  error_key: string | null;
  binance_enabled: boolean;
  bybit_enabled: boolean;
  bybit_bsc_enabled: boolean;
  idr_enabled: boolean;
  paydisini_enabled: boolean;
  nowpayments_enabled: boolean;
  wallet_idr: string;
  wallet_usdt: string;
}

/** 201 response of POST /api/v1/checkout (order created). */
export interface PlaceOrderResponse {
  order_code: string;
  pay_url: string;
}

/** Cached TokoPay gateway payload (server: TokopayOrderInfo). */
export interface TokopayGateway {
  trxId: string;
  payUrl: string | null;
  qrLink: string | null;
  qrString: string | null;
  totalBayar: string | null;
}

/** Cached PayDisini gateway payload (server: PaydisiniOrderInfo). */
export interface PaydisiniGateway {
  trxId: string;
  qrString: string | null;
  qrUrl: string | null;
  checkoutUrl: string | null;
  totalBayar: string | null;
}

/** Cached NOWPayments hosted-invoice payload (server: NowpaymentsInvoice). */
export interface NowpaymentsGateway {
  invoiceId: string;
  invoiceUrl: string;
}

/** payState() result — drives which pay.njk branch renders. */
export type PayState = "waiting" | "confirming" | "delivered" | "expired" | "closed";

/** GET /api/v1/orders/:code/pay — the payView() JSON (server: apps/storefront/src/routes/checkout.ts). */
export interface PayData {
  order: {
    code: string;
    status: string;
    currency: string;
    total: string;
    payment_ref: string | null;
    expires_at_iso: string | null;
  };
  state: PayState;
  is_binance: boolean;
  is_bybit: boolean;
  is_bybit_bsc: boolean;
  is_qris: boolean;
  is_paydisini: boolean;
  is_nowpayments: boolean;
  bybit_uid: string;
  bybit_bsc_address: string;
  binance_uid: string;
  gateway: TokopayGateway | null;
  gateway_error: boolean;
  paydisini_gateway: PaydisiniGateway | null;
  paydisini_gateway_error: boolean;
  nowpayments_gateway: NowpaymentsGateway | null;
  nowpayments_gateway_error: boolean;
  min_amount: string | null;
  wa_number: string;
  bot_username: string;
}

/** GET /api/v1/orders/:code/status — the ~5s poll (JSON twin of the HX-Redirect
 * the HTMX partial used to send once the order flips to DELIVERED). */
export interface PayStatusData {
  state: PayState;
  redirect: string | null;
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
