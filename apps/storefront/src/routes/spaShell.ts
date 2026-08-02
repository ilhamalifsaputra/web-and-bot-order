/**
 * Serves the React SPA shell for every GET that doesn't match a more specific
 * route — the storefront twin of apps/web-admin/src/routes/spaShell.ts,
 * promoted for the same page-by-page migration: once a Nunjucks route is
 * deleted, its path falls through here and React Router renders the page.
 *
 * MUST be registered LAST in server.ts so every specific route (Nunjucks
 * pages, /api/v1, webhooks, /lang, /auth/telegram, /healthz, static) wins.
 *
 * Differences from web-admin's shell — this is a PUBLIC shop:
 *   - `optionalCustomer` instead of a login-redirecting guard; anonymous
 *     visitors get the shell with an empty CSRF meta.
 *   - SEO substitutions: `__LANG__` (shop_lang cookie), `__TITLE__` and
 *     `<!--__HEAD_META__-->` per path — /p/:slug and /c/:slug do one DB
 *     lookup for the name/OG tags and return a REAL 404 status for unknown
 *     slugs (monitoring/SEO must never see 200 for a dead product URL).
 *     Unknown paths outside the route table also 404 (React renders the
 *     error-page visuals; the status code comes from here).
 *   - /reset/:token pages get Referrer-Policy: no-referrer (the single-use
 *     token rides in the URL — same Storefront-1 guard as the HTML route).
 */
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { t } from "@app/core/i18n";
import { formatIdr } from "@app/core/formatters";
import {
  prisma,
  getSetting,
  getCategoryBySlug,
  getCatalogProductBySlugWithDenominations,
  listActiveCategories,
  listNewestCatalogProducts,
  listCatalogProducts,
  listFlashSaleProducts,
  stockStatusCounts,
  productRatingSummaries,
} from "@app/db";
import { optionalCustomer } from "../plugins/auth";
import { requestLang } from "../shop";
import { SPA_INDEX_PATH, esc } from "../lib/spaFallback";

/** Public origin for absolute canonical URLs — same fallback chain used in
 * checkout.ts's shopPublicUrl() / seo.ts's baseUrl(). */
function baseUrl(): string | null {
  return config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null;
}

/** Absolute canonical <link> for `path` (query stripped, though callers
 * already pass a query-free path) — omitted entirely when no public base
 * URL is configured, rather than emitting a broken/relative href. */
function canonicalLink(path: string): string {
  const origin = baseUrl();
  if (!origin) return "";
  return `<link rel="canonical" href="${esc(origin + path.split("?")[0])}">`;
}

/** Absolute URL for `path`, or null when no public origin is configured. */
function absoluteUrl(path: string): string | null {
  const origin = baseUrl();
  return origin ? origin + path.split("?")[0] : null;
}

/**
 * Serialise a JSON-LD block. The payload can carry admin-entered free text
 * (product name/description) that includes the literal string `</script>` —
 * escaping any `</` sequence stops it closing this tag early and injecting
 * arbitrary HTML/JS (a real stored-XSS risk, not hypothetical).
 */
function jsonLd(payload: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(payload).replace(/<\//g, "<\\/")}</script>`;
}

/**
 * Open Graph + Twitter Card tags, shared by every public page. Without these a
 * link pasted into WhatsApp/Telegram/X renders as a bare URL — the audit's
 * "social media meta tags" finding. `og:url` doubles as a second canonical
 * signal, so it's omitted (like canonicalLink) when no public origin is set
 * rather than emitting a relative URL a scraper can't resolve.
 */
function socialMeta(opts: {
  title: string;
  description: string;
  path: string;
  lang: string;
  shopName: string;
  type?: string;
  image?: string | null;
}): string {
  const url = absoluteUrl(opts.path);
  // Telegram/WhatsApp only fetch absolute image URLs; a site-relative upload
  // path has to be resolved against the public origin first.
  const image = opts.image
    ? opts.image.startsWith("http")
      ? opts.image
      : (baseUrl() ?? "") + opts.image
    : null;
  return (
    `<meta property="og:title" content="${esc(opts.title)}">` +
    `<meta property="og:type" content="${esc(opts.type ?? "website")}">` +
    `<meta property="og:site_name" content="${esc(opts.shopName)}">` +
    `<meta property="og:locale" content="${opts.lang === "id" ? "id_ID" : "en_US"}">` +
    (opts.description ? `<meta property="og:description" content="${esc(opts.description)}">` : "") +
    (url ? `<meta property="og:url" content="${esc(url)}">` : "") +
    (image ? `<meta property="og:image" content="${esc(image)}">` : "") +
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">` +
    `<meta name="twitter:title" content="${esc(opts.title)}">` +
    (opts.description ? `<meta name="twitter:description" content="${esc(opts.description)}">` : "") +
    (image ? `<meta name="twitter:image" content="${esc(image)}">` : "")
  );
}

/** A Google Analytics 4 measurement ID and nothing else. */
const ANALYTICS_ID_RE = /^G-[A-Z0-9]{4,20}$/i;

/**
 * The GA4 loader, or "" when no measurement ID is configured — an unset
 * `web_analytics_id` means the shop ships no analytics and no third-party
 * request at all, which is both the privacy-safe and the fast default.
 *
 * The ID is re-validated here even though web-admin validates it on save: this
 * value goes straight into a <script> tag, and a setting written before that
 * validation existed (or by any future path) must not be able to inject script.
 * Anything that isn't a well-formed ID is dropped rather than escaped.
 */
function analyticsSnippet(id: string): string {
  if (!ANALYTICS_ID_RE.test(id)) return "";
  return (
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
    `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
    `gtag('js',new Date());gtag('config','${id}');</script>`
  );
}

/** Static path → i18n title key. Everything else falls to shop_name / lookups. */
const TITLE_KEYS: Array<[RegExp, string]> = [
  [/^\/login$/, "web.login_title"],
  [/^\/register$/, "web.register_title"],
  [/^\/forgot$/, "web.forgot_title"],
  [/^\/reset\/[^/]+$/, "web.reset_title"],
  [/^\/cart$/, "web.cart_title"],
  [/^\/checkout$/, "web.checkout_title"],
  [/^\/checkout\/[^/]+\/pay$/, "web.pay_title"],
  [/^\/account$/, "web.account_title"],
  [/^\/account\/orders$/, "web.account_orders"],
  [/^\/account\/referral$/, "web.account_referral"],
  [/^\/account\/reviews$/, "web.account_reviews"],
  [/^\/account\/support(\/\d+)?$/, "web.account_support"],
  [/^\/account\/settings$/, "web.settings_title"],
];

/** Paths the SPA route table knows — anything else is a 404 shell. Keep in
 * sync with apps/storefront/client/src/App.tsx. */
const KNOWN_PATHS = new RegExp(
  "^(/|/search|/products|/categories|/flash|/cart|/checkout|/login|/register|/forgot" +
    "|/reset/[^/]+|/checkout/[^/]+/pay" +
    "|/account|/account/orders|/account/orders/[^/]+|/account/referral" +
    "|/account/reviews|/account/support|/account/support/\\d+|/account/settings" +
    "|/about|/how-to-order|/terms|/privacy|/refund)$",
);

/**
 * The informational pages (apps/storefront/client/src/pages/*Page.tsx via
 * StaticPage.tsx): path → locale-key prefix + how many `_hN`/`_pN` blocks it
 * renders. Unlike every other entry in TITLE_KEYS these MUST be indexable —
 * a shop with no visible terms, privacy or refund policy reads as low-trust
 * to both a payment gateway and a search engine, which is the whole reason
 * they exist. Keep the block counts in step with the React pages.
 */
const STATIC_PAGES: Record<string, { prefix: string; blocks: number }> = {
  "/about": { prefix: "about", blocks: 4 },
  "/how-to-order": { prefix: "hto", blocks: 5 },
  "/terms": { prefix: "terms", blocks: 5 },
  "/privacy": { prefix: "privacy", blocks: 5 },
  "/refund": { prefix: "refund", blocks: 5 },
};

interface HeadInfo {
  title: string;
  meta: string;
  /** Crawler-visible markup injected into <body> — see seoShell(). */
  body: string;
  status: number;
}

/** `<ul>` of internal links, or "" when there's nothing to link to. */
function linkList(items: Array<{ href: string; label: string }>): string {
  if (items.length === 0) return "";
  return `<ul>${items.map((i) => `<li><a href="${esc(i.href)}">${esc(i.label)}</a></li>`).join("")}</ul>`;
}

/**
 * Wraps the crawler-visible markup for a page.
 *
 * The storefront is a client-rendered SPA, so the HTML this server sends has
 * historically been an empty `<div id="root">` — a crawler that doesn't run
 * JavaScript saw a page with no H1, no headings, no paragraphs and no internal
 * links, which is exactly what an SEO audit reported. This block gives those
 * crawlers (and no-JS visitors) the real thing; main.tsx removes the element
 * as soon as React has mounted, so a normal visitor never sees it twice.
 *
 * Everything rendered here comes from the SAME database fields the React pages
 * display. Never write copy here that the rendered page doesn't contain —
 * serving crawlers different text than humans is cloaking, and search engines
 * penalise it.
 */
function seoShell(inner: string): string {
  return inner ? `<div id="seo-shell">${inner}</div>` : "";
}

/** Per-path <title>/OG-meta/body/status. */
async function headInfo(
  path: string,
  lang: string,
  shopName: string,
  query: string,
  logoUrl: string,
  analyticsOn: boolean,
): Promise<HeadInfo> {
  if (path === "/") {
    const [categories, newest] = await Promise.all([
      listActiveCategories(prisma),
      listNewestCatalogProducts(prisma, 12),
    ]);
    const tagline = t("web.hero_title", lang);
    // The hero subtitle is page copy and free to grow past what a search
    // snippet shows (~160 chars); the meta description is its own key so
    // rewriting one never silently truncates the other.
    const metaDesc = t("web.home_meta_description", lang);
    const origin = baseUrl();
    // Organization identifies the shop itself; WebSite + SearchAction is what
    // lets Google offer a search box for the site in results. Both are only
    // meaningful with an absolute origin, so they're skipped without one.
    const siteJsonLd = origin
      ? jsonLd({
          "@context": "https://schema.org",
          "@type": "Organization",
          name: shopName,
          url: origin,
          ...(logoUrl ? { logo: logoUrl.startsWith("http") ? logoUrl : origin + logoUrl } : {}),
        }) +
        jsonLd({
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: shopName,
          url: origin,
          potentialAction: {
            "@type": "SearchAction",
            target: { "@type": "EntryPoint", urlTemplate: `${origin}/search?q={search_term_string}` },
            "query-input": "required name=search_term_string",
          },
        })
      : "";
    return {
      // "Trustance" alone is one word and ~89px wide — far under the ~580px a
      // result snippet allows, and it says nothing about what the shop sells.
      title: `${shopName} — ${tagline}`,
      meta:
        `<meta name="description" content="${esc(metaDesc)}">` +
        canonicalLink(path) +
        socialMeta({ title: `${shopName} — ${tagline}`, description: metaDesc, path, lang, shopName }) +
        siteJsonLd,
      body: seoShell(
        `<h1>${esc(t("web.hero_title", lang))}</h1>` +
          `<p>${esc(t("web.hero_sub", lang))}</p>` +
          // The "how it works" steps and the trust checklist are the only
          // substantial prose on the home page; a crawler that skipped them
          // saw a page that was almost entirely product links.
          `<h2>${esc(t("web.how_title", lang))}</h2>` +
          `<ol>${[1, 2, 3, 4]
            .map((n) => `<li>${esc(t(`web.how_s${n}`, lang))}: ${esc(t(`web.how_s${n}_d`, lang))}</li>`)
            .join("")}</ol>` +
          `<h2>${esc(t("web.trust_title", lang))}</h2>` +
          `<ul>${[1, 2, 3, 4]
            .map((n) => `<li>${esc(t(`web.trust_${n}`, lang))}: ${esc(t(`web.trust_${n}_d`, lang))}</li>`)
            .join("")}</ul>` +
          `<h2>${esc(t("web.categories_page_title", lang))}</h2>` +
          linkList(categories.map((c) => ({ href: `/c/${c.slug}`, label: c.name }))) +
          `<h2>${esc(t("web.new_arrivals", lang))}</h2>` +
          linkList(newest.map((p) => ({ href: `/p/${p.slug}`, label: p.name }))),
      ),
      status: 200,
    };
  }
  const productSlug = /^\/p\/([^/]+)$/.exec(path)?.[1];
  if (productSlug) {
    const product = await getCatalogProductBySlugWithDenominations(prisma, decodeURIComponent(productSlug));
    if (!product || !product.isActive || product.isArchived || product.denominations.length === 0) {
      return { title: `404 — ${shopName}`, meta: "", body: "", status: 404 };
    }
    // An empty meta description is itself an SEO finding, and plenty of
    // products are created without one — fall back to a sentence built from
    // the facts we do have rather than emitting nothing.
    const desc = (product.description ?? "").trim()
      ? product.description!.trim().slice(0, 160)
      : t("web.product_meta_description", lang, {
          product: product.name,
          category: product.category.name,
          shop: shopName,
        });
    // "You might also like" — the same category shelf ProductPage renders,
    // which is also what gives a deep product URL its internal links.
    const [stock, ratings, related] = await Promise.all([
      stockStatusCounts(prisma),
      productRatingSummaries(prisma),
      listCatalogProducts(prisma, product.categoryId).then((all) =>
        all.filter((p) => p.id !== product.id).slice(0, 4),
      ),
    ]);

    // Availability mirrors ProductPage.tsx's `purchasable()`: a non-auto
    // denomination (manual / manual_with_info) never has stock rows by design,
    // so it counts as available. Claiming InStock unconditionally — as this
    // did before — risks a Google Merchant penalty once a product sells out.
    const anyPurchasable = product.denominations.some(
      (d) => d.deliveryType !== "auto" || (stock[d.id]?.available ?? 0) > 0,
    );

    // Star rating for the rich snippet. Reviews attach to the denomination
    // bought, so a product's rating is the aggregate across its own
    // denominations — the same roll-up pageData.ts does for the card grid.
    const denomIds = new Set(product.denominations.map((d) => d.id));
    const own = ratings.filter((r) => denomIds.has(r.productId) && r.count > 0 && r.avg != null);
    const reviewCount = own.reduce((n, r) => n + r.count, 0);
    const ratingValue =
      reviewCount > 0 ? own.reduce((sum, r) => sum + r.avg! * r.count, 0) / reviewCount : null;

    const origin = baseUrl();
    // Structured data (schema.org Product) for rich snippets — cheapest
    // active denomination (already price-ascending, see catalog.ts's
    // getCatalogProductBySlugWithDenominations orderBy) drives `offers`.
    const productLd: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: product.name,
      category: product.category.name,
    };
    // "What you get" is often the only place a product says what's actually in
    // the box, so it belongs in the snippet description alongside the blurb.
    const ldDescription = [product.description, product.whatYouGet]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
    if (ldDescription) productLd.description = ldDescription;
    if (product.webImageUrl) productLd.image = product.webImageUrl;
    productLd.offers = {
      "@type": "Offer",
      price: product.denominations[0]!.price.toString(),
      priceCurrency: "IDR",
      availability: anyPurchasable ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      ...(origin ? { url: `${origin}/p/${product.slug}` } : {}),
    };
    if (ratingValue !== null) {
      productLd.aggregateRating = {
        "@type": "AggregateRating",
        ratingValue: ratingValue.toFixed(1),
        reviewCount,
        bestRating: 5,
        worstRating: 1,
      };
    }
    return {
      title: `${product.name} — ${shopName}`,
      meta:
        `<meta name="description" content="${esc(desc)}">` +
        canonicalLink(path) +
        socialMeta({
          title: product.name,
          description: desc,
          path,
          lang,
          shopName,
          type: "product",
          image: product.webImageUrl,
        }) +
        jsonLd(productLd) +
        (origin
          ? jsonLd({
              "@context": "https://schema.org",
              "@type": "BreadcrumbList",
              itemListElement: [
                { "@type": "ListItem", position: 1, name: shopName, item: origin + "/" },
                {
                  "@type": "ListItem",
                  position: 2,
                  name: product.category.name,
                  item: `${origin}/c/${product.category.slug}`,
                },
                { "@type": "ListItem", position: 3, name: product.name, item: `${origin}/p/${product.slug}` },
              ],
            })
          : ""),
      body: seoShell(
        `<nav><a href="/">${esc(shopName)}</a> <a href="/c/${esc(product.category.slug)}">${esc(product.category.name)}</a></nav>` +
          `<h1>${esc(product.name)}</h1>` +
          (product.description ? `<p>${esc(product.description)}</p>` : "") +
          // Same three detail blocks ProductPage.tsx renders under the buy
          // area, in the same order — a crawler that doesn't run JS was
          // seeing a product page with no substance beyond a price list.
          (
            [
              ["web.what_you_get", product.whatYouGet],
              ["web.product_terms", product.terms],
              ["web.warranty", product.warrantyNote],
            ] as const
          )
            .map(([key, value]) =>
              value ? `<h2>${esc(t(key, lang))}</h2><p>${esc(value)}</p>` : "",
            )
            .join("") +
          `<h2>${esc(t("web.choose_plan", lang))}</h2>` +
          `<ul>${product.denominations
            .map((d) => {
              // durationLabel often repeats the name verbatim ("1 Month") —
              // only append it when it actually adds something.
              const label =
                d.durationLabel && d.durationLabel !== d.name ? `${d.name} — ${d.durationLabel}` : d.name;
              return `<li>${esc(label)}: ${esc(formatIdr(d.price))}</li>`;
            })
            .join("")}</ul>` +
          (related.length
            ? `<h2>${esc(t("web.related_products", lang))}</h2>` +
              linkList(related.map((p) => ({ href: `/p/${p.slug}`, label: p.name })))
            : ""),
      ),
      status: 200,
    };
  }
  const categorySlug = /^\/c\/([^/]+)$/.exec(path)?.[1];
  if (categorySlug) {
    const category = await getCategoryBySlug(prisma, decodeURIComponent(categorySlug));
    if (!category || !category.isActive) {
      return { title: `404 — ${shopName}`, meta: "", body: "", status: 404 };
    }
    const inCategory = await listCatalogProducts(prisma, category.id);
    // Prefer the admin's own category blurb; otherwise say something true and
    // specific rather than leaving the description empty.
    const catDesc = (category.description ?? "").trim()
      ? category.description!.trim().slice(0, 160)
      : t("web.category_meta_description", lang, { category: category.name, shop: shopName });
    const catOrigin = baseUrl();
    return {
      title: `${category.name} — ${shopName}`,
      meta:
        `<meta name="description" content="${esc(catDesc)}">` +
        canonicalLink(path) +
        socialMeta({ title: category.name, description: catDesc, path, lang, shopName, image: category.image }) +
        (catOrigin
          ? jsonLd({
              "@context": "https://schema.org",
              "@type": "BreadcrumbList",
              itemListElement: [
                { "@type": "ListItem", position: 1, name: shopName, item: catOrigin + "/" },
                { "@type": "ListItem", position: 2, name: category.name, item: `${catOrigin}/c/${category.slug}` },
              ],
            })
          : ""),
      body: seoShell(
        `<nav><a href="/">${esc(shopName)}</a></nav>` +
          `<h1>${esc(category.name)}</h1>` +
          (category.description ? `<p>${esc(category.description)}</p>` : "") +
          linkList(inCategory.map((p) => ({ href: `/p/${p.slug}`, label: p.name }))),
      ),
      status: 200,
    };
  }
  if (path === "/search") {
    // STO-017: echo the query in the <title> once one's present, matching the
    // in-page <h1> (SearchPage.tsx's `web.search_results`) instead of always
    // showing the generic placeholder copy.
    const q = new URLSearchParams(query).get("q")?.trim();
    const heading = q ? t("web.search_results", lang, { q }) : t("web.search_placeholder", lang);
    // Canonicalizes to the bare /search path (no ?q=) — the query-stripped
    // canonicalLink() dedupes every search-term variant to one URL.
    return {
      title: `${heading} — ${shopName}`,
      meta: `<meta name="description" content="${esc(heading)} — ${esc(shopName)}">` + canonicalLink(path),
      body: seoShell(`<h1>${esc(heading)}</h1>`),
      status: 200,
    };
  }
  // The three browse-all shelves the nav drawer links to. Like /c/:slug these
  // are public catalog surfaces that must be indexable, so each ships a real
  // <h1> and a link list a crawler can follow into the catalog.
  if (path === "/products" || path === "/categories" || path === "/flash") {
    const key = path === "/products" ? "web.products_title" : path === "/categories" ? "web.categories_page_title" : "web.flash_title";
    const heading = t(key, lang);
    const description = t(
      path === "/products"
        ? "web.products_meta_description"
        : path === "/categories"
          ? "web.categories_meta_description"
          : "web.flash_meta_description",
      lang,
      { shop: shopName },
    );
    const links =
      path === "/categories"
        ? (await listActiveCategories(prisma)).map((c) => ({ href: `/c/${c.slug}`, label: c.name }))
        : (await (path === "/flash" ? listFlashSaleProducts(prisma) : listCatalogProducts(prisma))).map((p) => ({
            href: `/p/${p.slug}`,
            label: p.name,
          }));
    return {
      title: `${heading} — ${shopName}`,
      meta:
        `<meta name="description" content="${esc(description)}">` +
        canonicalLink(path) +
        socialMeta({ title: heading, description, path, lang, shopName }),
      body: seoShell(
        `<nav><a href="/">${esc(shopName)}</a></nav>` +
          `<h1>${esc(heading)}</h1>` +
          `<p>${esc(description)}</p>` +
          linkList(links),
      ),
      status: 200,
    };
  }
  const staticPage = STATIC_PAGES[path];
  if (staticPage) {
    const { prefix, blocks } = staticPage;
    const args = { shop: shopName };
    const heading = t(`web.${prefix}_title`, lang);
    const intro = t(`web.${prefix}_intro`, lang, args);
    // The analytics section only exists on shops that load analytics — same
    // condition PrivacyPage.tsx renders it under, so crawler and visitor see
    // the same page.
    const extra =
      prefix === "privacy" && analyticsOn
        ? `<h2>${esc(t("web.privacy_analytics_h", lang))}</h2>` +
          `<p>${esc(t("web.privacy_analytics_p", lang))}</p>`
        : "";
    return {
      title: `${heading} — ${shopName}`,
      meta:
        `<meta name="description" content="${esc(intro.slice(0, 160))}">` +
        canonicalLink(path) +
        socialMeta({ title: heading, description: intro, path, lang, shopName }),
      body: seoShell(
        `<nav><a href="/">${esc(shopName)}</a></nav>` +
          `<h1>${esc(heading)}</h1>` +
          `<p>${esc(intro)}</p>` +
          Array.from({ length: blocks }, (_, i) => i + 1)
            .map(
              (n) =>
                `<h2>${esc(t(`web.${prefix}_h${n}`, lang))}</h2>` +
                `<p>${esc(t(`web.${prefix}_p${n}`, lang, args))}</p>`,
            )
            .join("") +
          extra,
      ),
      status: 200,
    };
  }
  // Everything below is a private / non-indexable screen (robots.txt disallows
  // /account, /cart and /checkout), so none of them get an SEO body — the
  // React page is the only reader that matters. `noindex` is the belt to
  // robots.txt's braces: a crawler that reaches one of these by a pasted link
  // has already skipped robots.txt, and these pages must never be indexed.
  const noIndex = `<meta name="robots" content="noindex, nofollow">`;
  for (const [re, key] of TITLE_KEYS) {
    if (re.test(path)) {
      return { title: `${t(key, lang)} — ${shopName}`, meta: noIndex + canonicalLink(path), body: "", status: 200 };
    }
  }
  // /account/orders/:code — order codes are private; generic title, no lookup.
  if (/^\/account\/orders\/[^/]+$/.test(path)) {
    return {
      title: `${t("web.account_orders", lang)} — ${shopName}`,
      status: 200,
      meta: noIndex + canonicalLink(path),
      body: "",
    };
  }
  if (!KNOWN_PATHS.test(path)) {
    return { title: `404 — ${shopName}`, meta: "", body: "", status: 404 };
  }
  return { title: shopName, meta: "", body: "", status: 200 };
}

export default async function spaShellRoutes(app: FastifyInstance): Promise<void> {
  app.get("/*", async (req, reply) => {
    const [path, query = ""] = req.url.split("?", 2) as [string, string?];
    // Unmatched API paths land here too (the wildcard out-specifies the
    // not-found handler for GETs) — those must stay JSON, never an HTML shell.
    if (path.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const lang = requestLang(req);
    const [customer, shopName, favicon, logo, analyticsId] = await Promise.all([
      optionalCustomer(req),
      getSetting(prisma, "shop_name").then((v) => v ?? "Toko Digital"),
      getSetting(prisma, "web_favicon_url").then((v) => v || "/static/favicon.svg"),
      getSetting(prisma, "web_logo_url").then((v) => v || ""),
      getSetting(prisma, "web_analytics_id").then((v) => (v ?? "").trim()),
    ]);
    const head = await headInfo(path, lang, shopName, query, logo, ANALYTICS_ID_RE.test(analyticsId));

    if (path.startsWith("/reset/")) {
      void reply.header("Referrer-Policy", "no-referrer");
    }

    // The live CSRF token (for signed-in visitors) is baked into this HTML
    // per-session — a caching reverse proxy sitting in front of the
    // storefront (explicitly expected per this repo's deployment model)
    // could serve one customer's token to a later visitor, which combined
    // with SameSite=Lax cookies is enough to forge state-changing requests
    // (audit finding M-20).
    void reply.header("Cache-Control", "no-store");

    // apple-touch-icon is what iOS uses for a "Add to Home Screen" shortcut;
    // without it Safari screenshots the page instead. Falls back to the
    // favicon, which is the only icon this shop is guaranteed to have.
    const faviconLink =
      `<link rel="icon" href="${esc(favicon)}">` +
      `<link rel="apple-touch-icon" href="${esc(logo || favicon)}">` +
      analyticsSnippet(analyticsId);
    // Function-form replacements: a literal second-arg string is interpreted
    // by String.replace as a $-pattern (`$&`, `$'`, `` $` ``, `$1`, ...) — any
    // of shop_name/product/category name containing one would corrupt the
    // HTML. The function form treats the return value as a literal string.
    const html = readFileSync(SPA_INDEX_PATH, "utf-8")
      .replace("__CSRF_TOKEN__", () => customer?.csrf ?? "")
      .replace("__LANG__", () => lang)
      .replace("__TITLE__", () => esc(head.title))
      .replace("<!--__HEAD_META__-->", () => faviconLink + head.meta)
      .replace("<!--__SEO_BODY__-->", () => head.body);
    // Spell the charset out in the Content-Type header, not just the <meta>:
    // a crawler that trusts the header over the document was reading this as
    // an unlabelled response.
    return reply.code(head.status).type("text/html; charset=utf-8").send(html);
  });
}
