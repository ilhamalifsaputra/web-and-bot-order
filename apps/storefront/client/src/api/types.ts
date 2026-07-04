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
