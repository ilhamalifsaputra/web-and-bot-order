/** Response shapes for the storefront JSON API (/api/v1/pages/*).
 * Server side: apps/storefront/src/routes/apiPages.ts — keep in sync. */
import type { ProductCardData } from "../components/shop/ProductCard";
import type { FlashInfo } from "../components/shop/FlashBadge";

/** Mirrors the server's ThumbnailKind union (apps/storefront/src/images.ts)
 * verbatim — kept as a local alias rather than a cross-import since this
 * file mirrors server-side shapes elsewhere too (see api/types.ts's own
 * conventions) rather than taking server code as a client dependency. */
export type ThumbnailKind = "game" | "voucher" | "steam" | "entertainment" | "app" | "generic";

/** Mirrors the server's DenomIconKind union (apps/storefront/src/denomIcon.ts)
 * verbatim — same local-alias convention as ThumbnailKind above. Drives the
 * small currency chip DenominationCard renders, resolved once per product. */
export type DenomIconKind = "diamond" | "coin" | "key" | "card" | "voucher";

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

/** Homepage category tile — the raw Category shape (apps/storefront/src/
 * pageData.ts homePageData()/categoriesPageData() no longer resolve any
 * display image for it, Fase 12; the client never reads `image` here
 * anyway — only emoji/slug/name/description). */
export type HomeCategory = Category;

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

/** GET /api/v1/pages/products and /api/v1/pages/flash — the two browse-all
 * shelves the nav drawer links to. Same shape: one is the whole catalog, the
 * other only what's on flash sale right now (server: shelfFrom() in
 * apps/storefront/src/pageData.ts). An empty `products` on /flash means no sale
 * is running, which is a normal state rather than an error. */
export interface ShelfPageData {
  products: ProductCardData[];
  low_threshold: number;
}

/** GET /api/v1/pages/categories — the category index. `image` is resolved
 * server-side exactly as the homepage tiles resolve it. */
export interface CategoriesPageData {
  categories: HomeCategory[];
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
  /** Live flash sale on this plan, or null/absent when none is running.
   * `price` above ALREADY carries the discount — `flash.base_price` is only
   * the pre-sale figure to strike through (apps/storefront/src/pageData.ts).
   * Optional so a payload predating flash sales still type-checks. */
  flash?: FlashInfo | null;
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
    /** Optional detail blocks (prisma Product.whatYouGet / terms /
     * warrantyNote) — each rendered as its own titled block on the product
     * page, and skipped entirely when the admin left it empty. */
    what_you_get: string | null;
    terms: string | null;
    warranty_note: string | null;
    category_name: string;
    category_slug: string;
    /** The admin's real photo, or null (Fase 12: no more stock-photo
     * fallback) — a null renders the DefaultThumb design-system placeholder,
     * keyed by `image_kind`. */
    image: string | null;
    /** WebP `srcset` for `image`, or null when no derivatives exist — see
     *  webpSrcset() in apps/storefront/src/images.ts. */
    image_srcset?: string | null;
    /** Which DefaultThumb icon to show when `image` is null — mirrors the
     * server-side ThumbnailKind union (apps/storefront/src/images.ts). Never
     * absent, but typed nullable to tolerate an older/mocked payload. */
    image_kind?: ThumbnailKind | null;
    /** Which currency-chip icon DenominationCard should render for every
     * plan of this product (resolved ONCE per product, not per-SKU — see
     * apps/storefront/src/denomIcon.ts's `resolveDenomIconKind`), or null
     * when no chip should render at all. Optional so an older/mocked payload
     * still type-checks (same convention as `image_kind` above). */
    icon_kind?: DenomIconKind | null;
    /** Aggregate rating across every denomination of this product — the same
     * weighted-average calculation ProductCard's `rating`/`rating_count`
     * come from (apps/storefront/src/cards.ts's `aggregateRating`), so this
     * page's summary always agrees with the catalog card that linked here.
     * `rating_count` is the TRUE total of non-hidden reviews, not capped by
     * `reviews` below (which is limited to 10). */
    rating: number | null;
    rating_count: number;
    /** Category.checkoutFlow (Task 6, Digiflazz instant-buy pilot): "instant"
     * renders InstantBuyPage.tsx instead of this page's usual plan picker +
     * Cart→Checkout hop. */
    checkout_flow: "catalog" | "instant";
  };
  denominations: ProductDenomination[];
  default_restock_denomination_id: number;
  /** STO-011 "You might also like" — same category, this product excluded,
   * capped at a small shelf server-side (apps/storefront/src/pageData.ts). */
  related_products: ProductCardData[];
  reviews: ProductReview[];
  low_threshold: number;
}

/** STO-007 — sort keys offered on the Category/Search grids, matching
 * apps/storefront/src/cards.ts's `SORT_KEYS`. */
export const SORT_KEYS = ["default", "cheapest", "newest", "rating"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

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
  /** Live flash sale on this SKU, or null/absent when none is running —
   * JSON twin of FlashLineView (apps/storefront/src/routes/cart.ts).
   * `unit_price`/`line_total` above ALREADY carry the discount. */
  flash?: FlashInfo | null;
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
  /** Live flash sale on this line, or null. The totals beside it are priced
   * against the same instant, so this only marks them as sale prices. */
  flash?: FlashInfo | null;
}

export interface CheckoutData {
  items_empty: boolean;
  items: CheckoutItem[];
  subtotal: string;
  bulk_discount: string;
  voucher_discount: string;
  total: string;
  qris_admin_fee: string;
  qris_grand_total: string;
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
  /** Whether a balance payment method may be offered AT ALL. The server says
   * no for anonymous visitors (a guest has no wallet); the page still decides
   * whether the balance is big enough. Gate the radios on these rather than on
   * `is_guest` — which of the two questions is being answered stays the
   * server's call. */
  wallet_idr_enabled: boolean;
  wallet_usdt_enabled: boolean;
  /** True for an anonymous visitor: the checkout collects a contact email and
   * the order is placed against a synthetic guest account (guest checkout). */
  is_guest: boolean;
  /** True when this shop HAS a working gateway but every one of them was
   * filtered out because the total is under its minimum. Distinguishes the one
   * cause the buyer can actually fix (buy a bit more) from the one they cannot
   * (no gateway configured, or the exchange rate is unusable), which the
   * `*_enabled` flags alone cannot tell apart — they are false for both. */
  below_all_minimums: boolean;
}

/** 201 response of POST /api/v1/checkout (order created). */
export interface PlaceOrderResponse {
  order_code: string;
  pay_url: string;
  /** Present only when this request MINTED a guest session — the page was
   * rendered anonymously, so its CSRF meta is empty until the API client
   * adopts this (see api/client.ts). Also present on the 4xx bodies of a
   * guest checkout that failed after the session was issued. */
  csrf_token?: string;
  /** Guest checkouts only, and only ever `true` when the order-code email
   * ACTUALLY went out — SMTP is optional per deployment, and a send can fail.
   * A signed-in buyer's 201 omits the field entirely (they get no such mail).
   * Absent must be read as "no mail", never as "probably sent": the UI's only
   * job with this flag is to avoid promising an email nobody received. */
  email_sent?: boolean;
}

/** 200 response of POST /api/v1/track — an order code that matched a guest
 * order, exchanged for a live session. Every failure is one indistinguishable
 * 404 `{ error: "web.track_not_found" }` by design, so there is no "reason"
 * field here to render. */
export interface TrackOrderResponse {
  redirect: string;
  csrf_token?: string;
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
    qris_admin_fee: string | null;
    qris_grand_total: string | null;
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
 * the HTMX partial used to send once the order flips to DELIVERED). Also the
 * shape of GET /api/v1/wallet/topup/:code/status (Task 5) — same payState(). */
export interface PayStatusData {
  state: PayState;
  redirect: string | null;
}

/** GET /api/v1/wallet/topup — gateway availability per currency + configured
 * amount bounds + current balances (server: routes/apiWalletTopup.ts). */
export interface WalletTopupData {
  idr_enabled: boolean;
  paydisini_enabled: boolean;
  binance_enabled: boolean;
  bybit_enabled: boolean;
  bybit_bsc_enabled: boolean;
  nowpayments_enabled: boolean;
  min_idr: string | null;
  max_idr: string | null;
  min_usdt: string | null;
  max_usdt: string | null;
  /**
   * The smallest amount each gateway rail will accept, keyed by the same method
   * token the POST body uses, **already denominated in the currency the buyer
   * types** (whole-branch review F3). null = that rail has no floor to clear, so
   * any amount clears it.
   *
   * Separate from `min_idr`/`min_usdt`, which are the shop's own top-up bounds:
   * these are the RAILS' floors, and the two are independently configured. The
   * form must respect both — it advertises whichever binds and stops offering a
   * rail the amount cannot be paid through.
   */
  rail_min: Record<string, string | null>;
  /**
   * The minimum the form ADVERTISES and validates against (whole-branch review
   * F4b): `max(min_*, the lowest rail floor among the rails on offer)`, null when
   * neither bound exists.
   *
   * Use this, not `min_idr`/`min_usdt`, for the hint and the client-side check.
   * Reading the raw bound is what let the page say "Minimum Rp1.000" and then
   * have the create call refuse Rp5.000 over a rail floor it never mentioned.
   */
  effective_min_idr: string | null;
  effective_min_usdt: string | null;
  wallet_idr: string;
  wallet_usdt: string;
}

/** 201 response of POST /api/v1/wallet/topup (top-up order created). */
export interface WalletTopupCreateResponse {
  orderCode: string;
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
  /** WhatsApp number for the footer's contact link (`support_whatsapp`
   * Setting), or null/empty when the shop hasn't set one — the footer hides
   * the WhatsApp link entirely rather than show a dead one, same as
   * HomePage's own contact section treats an absent number. */
  wa_number: string | null;
  tzname: string;
  /** True only when `web_analytics_id` is set, i.e. this shop actually loads
   * Google Analytics. The privacy page reads it so it never claims tracking a
   * given shop doesn't do; optional so an older/mocked payload reads as
   * "no analytics", which is the safe direction to be wrong in. */
  analytics_enabled?: boolean;
  /** True when any denomination is on flash sale right now — the nav drawer
   * hides its "Flash sale" entry otherwise, rather than link to an empty
   * shelf. Optional so an older/mocked payload reads as "no sale running",
   * which is the safe direction to be wrong in. */
  flash_active?: boolean;
  /** True when `customer` is a synthetic guest account (bought without
   * registering). Guests have no password, referral code, reviews or tickets,
   * so the account area shows them only their orders. Optional so an
   * older/mocked payload reads as "a normal registered customer", which keeps
   * the full menu — the safe direction to be wrong in for a signed-in user. */
  is_guest?: boolean;
  /** Display-currency preference (Task 4): account preference > the
   * `shop_currency` cookie > null when neither is set. `null` means "no
   * preference chosen yet" — renders exactly like today (Rp primary + "≈ $"
   * hint), NOT the same as `"IDR"` (which shows Rp with no hint — see
   * Price.tsx). Never affects which currency an order is actually charged
   * in; display only. */
  currency: "USD" | "IDR" | null;
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
    /** Balance spent on this order, in Rupiah. Its own row in the summary: while
     * it went unprinted, a wallet-paid order's stacked figures were short by the
     * whole credit. "0" on a non-IDR order, whose stored figure is USDT and
     * would be printed as Rupiah here (see
     * apps/storefront/src/routes/buyerOrderSummary.ts). */
    wallet_credit: string;
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
    /** Buyer-safe Digiflazz dispatch sub-status. Final whole-branch review
     * I-2 fix: the base GET now returns this directly (mapped, buyer-safe,
     * from apiAccount.ts's own copy of the toBuyerStatus mapping), so it's
     * populated from the very first fetch, not just once the digiflazz/
     * stream SSE endpoint (Task 11) delivers its first push. The SSE push
     * is a pure latency optimization layered on top of an already-complete
     * value — same pattern the plan intended everywhere else — not the only
     * source for it. "pending" = still being processed with the supplier;
     * "reviewing" = the automated attempt didn't resolve and our team is
     * following up (the calm, never-alarming buyer-facing framing for
     * what's internally a terminal dispatch failure — see
     * web.digiflazz_failed_* in packages/core/locales). Never the raw
     * internal digiflazzStatus value or any diagnostic text — both
     * apiAccount.ts and apiOrderDigiflazzStream.ts already enforce that
     * mapping server-side, this field's type is just documenting that
     * guarantee on the client side too. Still optional in the type
     * (harmless) so an older/mocked payload without it still type-checks. */
    digiflazz_status?: "pending" | "reviewing" | null;
  };
  delivered: boolean;
  pending_payment: boolean;
  /** True while the order awaits hand fulfilment — gates the reassurance
   * card, the polling interval, and whether the info-edit form is enabled. */
  processing: boolean;
}

/** GET /api/v1/account/referral — referral.njk. `referral_link` is null when
 * no bot username is configured yet (the template renders the input's value
 * empty in that case). `earned_usdt` is a Decimal string (packages/db's
 * getReferralSummary, same source of truth the bot's viewReferral handler
 * reads) — format client-side with formatNativeUsdt, never pre-formatted
 * server-side. */
export interface ReferralData {
  referral_code: string;
  referral_link: string | null;
  referred_count: number;
  earned_usdt: string;
  commission_percent: number;
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
  /** Evidence uploaded with the ticket — `/uploads/tickets/...` URLs. */
  attachments: string[];
  /** New (Task 11): the ticket's subject/title — null for legacy rows created
   * before this field existed. */
  subject: string | null;
  /** New (Task 11): the linked order's code, when this row came from the paged
   * /account/support?… query (listUserTicketsPaged). Always null on rows from
   * the plain (no-query-param) GET /account/support call. */
  order_code: string | null;
  /** New (Task 11): same paged-only availability as order_code. */
  product_name: string | null;
  /** New (Task 11): ISO timestamp of the ticket's most recent activity. */
  updated_at_iso: string;
}

export interface SupportTicketStats {
  all: number;
  waiting_for_you: number;
  waiting_for_support: number;
  in_progress: number;
  resolved: number;
  closed: number;
}

export interface SupportData {
  tickets: SupportTicketSummary[];
  /** Present only when GET /account/support was called with any list-control
   * query param. */
  total?: number;
  page?: number;
  page_size?: number;
  stats?: SupportTicketStats;
}

/** GET /api/v1/account/support/new — form-bootstrap for the /help create
 * form's Product dropdown. The create POST (/account/support/new) answers
 * `{ ok: boolean; ticket_id: number | null; duplicate?: boolean }`. */
export interface SupportFormOptions {
  products: { id: number; name: string }[];
}

/** A single message on the ticket thread (either side). */
export interface TicketMessage {
  from_user: boolean;
  content: string;
  created_at_display: string;
  attachments: string[];
}

/** One line item on a ticket's linked order — JSON twin of the shape
 * apiAccount.ts's GET /account/support/:id builds from getTicketWithOrder(). */
export interface TicketOrderItem {
  name: string;
  duration: string | null;
  warranty_days: number;
  warranty_expires_at_display: string | null;
  warranty_active: boolean;
}

/** The linked order's summary shown in the ticket page's sidebar — null when
 * the ticket isn't linked to an order. */
export interface TicketOrderSummary {
  code: string;
  status: string;
  created_at_display: string;
  paid_at_display: string | null;
  payment_method: string;
  /** This order's OWN settlement currency ("IDR" | "USDT", same values as
   * PayData.order.currency) — `total` below is denominated in THIS, not
   * necessarily IDR. Format with `formatOrderAmount(total, currency)`, never
   * a bare `formatIdr`, which mis-renders a USDT order's total as if it were
   * a Rupiah figure (Task 5 bug fix). */
  currency: string;
  total: string;
  voucher_code: string | null;
  delivered: boolean;
  items: TicketOrderItem[];
}

/** GET /api/v1/account/support/:id. */
export interface TicketDetailData {
  ticket: {
    id: number;
    message: string;
    status: string;
    created_at_display: string;
    admin_reply: string | null;
    /** Timestamp of the legacy single admin_reply field, if set — null when
     * admin_reply is null. Used to place that bubble correctly in the merged
     * timeline (see ticketTimeline.ts). */
    replied_at_display: string | null;
    closed: boolean;
    closed_at_display: string | null;
    /** True while a closed ticket is still within the self-reopen window. */
    reopenable: boolean;
    attachments: string[];
  };
  messages: TicketMessage[];
  order: TicketOrderSummary | null;
}

/** GET /api/v1/account/settings — settings.njk. */
export interface SettingsData {
  bot_username: string;
  bot_id: string;
  values: { username: string; email: string };
  has_password: boolean;
  tg_linked: boolean;
  tg_name: string;
}
