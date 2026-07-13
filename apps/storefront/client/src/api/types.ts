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

/** One admin-defined custom field on a manual_with_info denomination — JSON
 * twin of AdditionalField (packages/core/src/deliveryFields.ts). Defined
 * locally rather than cross-imported: the client mirrors server-side shapes
 * elsewhere too (e.g. lib/format.ts mirrors packages/core/formatters), so
 * this follows that established convention instead of taking @app/core as a
 * runtime client dependency. */
export interface AdditionalField {
  key: string;
  label: { id: string; en: string };
  type: "text" | "email" | "number" | "url" | "select";
  required: boolean;
  options: string[];
  placeholder: string;
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
  /** "auto" | "manual" | "manual_with_info" (DeliveryType) — non-auto SKUs
   * never have stock rows (available is always 0/in_stock always false by
   * design), so purchasability is gated on this instead of on stock. */
  delivery_type: string;
  /** Parsed manual_with_info field spec — [] for auto/manual. */
  additional_fields: AdditionalField[];
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
  /** "auto" | "manual" | "manual_with_info" (DeliveryType) — non-auto lines
   * have no stock concept, so `available` is always 0 for them (don't use it
   * to render a stock warning on a non-auto line). */
  delivery_type: string;
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
/** One cart line's delivery info for the checkout page — JSON twin of the
 * `items` entries checkoutView() builds (apps/storefront/src/routes/checkout.ts).
 * Given the single-SKU-per-non-auto-cart guard (routes/api.ts POST /cart), a
 * non-auto cart's `items` always has exactly one entry. */
export interface CheckoutItem {
  denomination_id: number;
  delivery_type: string;
  additional_fields: AdditionalField[];
  qty: number;
}

export interface CheckoutData {
  items_empty: boolean;
  items: CheckoutItem[];
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

/** GET /api/v1/account — account.njk's overview stats + logout button
 * (server: apps/storefront/src/routes/apiAccount.ts). `name` is already the
 * fullName ?? username ?? telegramId fallback chain account.njk applied to
 * `customer.user.*`. */
export interface AccountData {
  name: string;
  order_count: number;
  referral_code: string;
  wallet_idr: string;
  wallet_usdt: string;
}

/** One row of GET /api/v1/account/orders — orders.njk's table. */
export interface AccountOrderSummary {
  code: string;
  status: string;
  total: string;
  created_at_display: string;
  items: string;
}

export interface AccountOrdersData {
  orders: AccountOrderSummary[];
}

/** One line item on order_detail.njk. */
export interface OrderDetailItem {
  name: string;
  duration: string | null;
  unit_price: string;
  warranty_days: number;
  /** Only populated when the order is DELIVERED and the owner is asking — null otherwise. */
  credentials: string | null;
}

/** GET /api/v1/account/orders/:code — order_detail.njk, extended (Task 10)
 * with the manual_with_info field spec + the buyer's current answers, and
 * `delivered_content` for a manually-fulfilled order's typed-in account.
 * `customer_data_fields`/`delivered_content` follow the same
 * single-denomination assumption the checkout info step and the admin order
 * route already make — [] / null for auto/manual orders (no manual_with_info
 * fields), so the client renders nothing extra for them. */
export interface OrderDetailData {
  order: {
    code: string;
    status: string;
    subtotal: string;
    discount: string;
    bulk_discount: string;
    total: string;
    created_at_display: string;
    /** Parsed manual_with_info field spec — [] for auto/manual orders. */
    customer_data_fields: AdditionalField[];
    /** One answer-map per unit, matching `items.length` — [] when
     * customer_data_fields is []. */
    customer_data: Array<Record<string, string>>;
    /** The admin-typed account for a manually-fulfilled order — null until
     * DELIVERED, and always null for auto orders (which use per-item
     * `credentials` instead). */
    delivered_content: string | null;
    items: OrderDetailItem[];
  };
  delivered: boolean;
  pending_payment: boolean;
  /** True while the order awaits hand fulfilment — gates the reassurance
   * card, the polling interval, and whether the info-edit form is enabled. */
  processing: boolean;
}

/** GET /api/v1/account/referral — referral.njk. `referral_link` is null when
 * no bot username is configured yet (the template renders the input's value
 * empty in that case). */
export interface ReferralData {
  referral_code: string;
  referral_link: string | null;
}

/** An order still awaiting the buyer's review — reviews.njk's pending form. */
export interface PendingReview {
  order_id: number;
  code: string;
  product_id: number | null;
  product_name: string;
}

/** An already-submitted review — reviews.njk's read-only grid. */
export interface AccountReview {
  product_name: string;
  rating: number;
  comment: string | null;
  created_at_display: string;
}

/** GET /api/v1/account/reviews — reviews.njk. */
export interface ReviewsData {
  pending: PendingReview[];
  reviews: AccountReview[];
}

/** One row of GET /api/v1/account/support — support.njk's ticket table. */
export interface SupportTicketSummary {
  id: number;
  message: string;
  status: string;
  created_at_display: string;
  admin_reply: string | null;
}

export interface SupportData {
  tickets: SupportTicketSummary[];
}

/** A single message on ticket_detail.njk's thread (either side). */
export interface TicketMessage {
  from_user: boolean;
  content: string;
  created_at_display: string;
}

/** GET /api/v1/account/support/:id — ticket_detail.njk. */
export interface TicketDetailData {
  ticket: {
    id: number;
    message: string;
    status: string;
    created_at_display: string;
    admin_reply: string | null;
    closed: boolean;
  };
  messages: TicketMessage[];
}

/** GET /api/v1/account/settings — settings.njk. */
export interface SettingsData {
  bot_username: string;
  values: { username: string; email: string };
  has_password: boolean;
  tg_linked: boolean;
  tg_name: string;
}
