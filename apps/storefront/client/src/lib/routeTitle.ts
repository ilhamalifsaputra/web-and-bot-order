/**
 * Client-side twin of the per-route <title> logic in `headInfo()`
 * (apps/storefront/src/routes/spaShell.ts) — same locale keys, same
 * "<Page> — <Shop name>" format, so a client-side navigation's tab title
 * matches what a full page load of the same URL would show. Keep the regexes
 * and locale keys in step with that file's TITLE_KEYS / STATIC_PAGES / the
 * home, /search and browse-all-shelf branches.
 *
 * /p/:slug and /c/:slug are deliberately absent: their titles need the
 * fetched product/category name, which only ProductPage/CategoryPage have
 * once their data arrives — those two pages call useDocumentTitle themselves.
 * This function returns undefined for those two paths so RouteEffects leaves
 * document.title alone rather than clobbering it with something generic.
 */
import { t } from "./i18n";

/** Static path → i18n title key. Mirrors spaShell.ts's TITLE_KEYS. */
const TITLE_KEYS: Array<[RegExp, string]> = [
  [/^\/login$/, "web.login_title"],
  [/^\/register$/, "web.register_title"],
  [/^\/forgot$/, "web.forgot_title"],
  [/^\/reset\/[^/]+$/, "web.reset_title"],
  [/^\/cart$/, "web.cart_title"],
  [/^\/checkout$/, "web.checkout_title"],
  [/^\/checkout\/[^/]+\/pay$/, "web.pay_title"],
  [/^\/track$/, "web.track_title"],
  [/^\/account$/, "web.account_title"],
  [/^\/account\/orders$/, "web.account_orders"],
  // Order codes are private — same generic title the server gives them,
  // no lookup.
  [/^\/account\/orders\/[^/]+$/, "web.account_orders"],
  [/^\/account\/referral$/, "web.account_referral"],
  [/^\/account\/reviews$/, "web.account_reviews"],
  [/^\/account\/support(\/\d+)?$/, "web.account_support"],
  [/^\/account\/settings$/, "web.settings_title"],
  [/^\/about$/, "web.about_title"],
  [/^\/how-to-order$/, "web.hto_title"],
  [/^\/terms$/, "web.terms_title"],
  [/^\/privacy$/, "web.privacy_title"],
  [/^\/refund$/, "web.refund_title"],
];

/** The three browse-all shelves — same keys FOOTER_LINKS (Layout.tsx) and
 * spaShell.ts's /products|/categories|/flash branch already use. */
const SHELF_TITLE_KEYS: Record<string, string> = {
  "/products": "web.products_title",
  "/categories": "web.categories_page_title",
  "/flash": "web.flash_title",
};

/** /p/:slug and /c/:slug — titled by the page itself once its data loads. */
const DYNAMIC_ENTITY_PATH = /^\/(p|c)\/[^/]+$/;

/**
 * Title for `pathname`/`search` given the current shop name, or undefined
 * when this function has nothing useful to say — either because the route's
 * title depends on fetched data (see DYNAMIC_ENTITY_PATH above) or because
 * the path matches nothing in the SPA's route table, which mirrors
 * spaShell.ts's KNOWN_PATHS fallback to a real 404.
 */
export function routeTitle(pathname: string, search: string, shopName: string): string | undefined {
  if (DYNAMIC_ENTITY_PATH.test(pathname)) return undefined;

  if (pathname === "/") {
    // Same shop-first order as spaShell.ts's home title — every other route
    // uses "<Page> — <Shop name>", but the home page leads with the shop.
    return `${shopName} — ${t("web.hero_title")}`;
  }

  if (pathname === "/search") {
    const q = new URLSearchParams(search).get("q")?.trim();
    const heading = q ? t("web.search_results", { q }) : t("web.search_placeholder");
    return `${heading} — ${shopName}`;
  }

  const shelfKey = SHELF_TITLE_KEYS[pathname];
  if (shelfKey) return `${t(shelfKey)} — ${shopName}`;

  for (const [re, key] of TITLE_KEYS) {
    if (re.test(pathname)) return `${t(key)} — ${shopName}`;
  }

  // Unknown path — the client route table 404s the same set of paths
  // spaShell.ts's KNOWN_PATHS does, via App.tsx's catch-all <Route path="*">.
  return `404 — ${shopName}`;
}
