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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { t } from "@app/core/i18n";
import { prisma, getSetting, getCategoryBySlug, getCatalogProductBySlugWithDenominations } from "@app/db";
import { optionalCustomer } from "../plugins/auth";
import { requestLang } from "../shop";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.STOREFRONT_STATIC_DIR ?? join(HERE, "..", "..", "static");
const SPA_INDEX_PATH = join(STATIC_DIR, "shop-app", "index.html");

/** Minimal HTML-attribute escape for strings interpolated into meta tags. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  "^(/|/search|/cart|/checkout|/login|/register|/forgot" +
    "|/reset/[^/]+|/checkout/[^/]+/pay" +
    "|/account|/account/orders|/account/orders/[^/]+|/account/referral" +
    "|/account/reviews|/account/support|/account/support/\\d+|/account/settings)$",
);

interface HeadInfo {
  title: string;
  meta: string;
  status: number;
}

/** Per-path <title>/OG-meta/status — one DB lookup max. */
async function headInfo(path: string, lang: string, shopName: string): Promise<HeadInfo> {
  if (path === "/") {
    return {
      title: shopName,
      meta: `<meta name="description" content="${esc(t("web.hero_sub", lang))}">`,
      status: 200,
    };
  }
  const productSlug = /^\/p\/([^/]+)$/.exec(path)?.[1];
  if (productSlug) {
    const product = await getCatalogProductBySlugWithDenominations(prisma, decodeURIComponent(productSlug));
    if (!product || !product.isActive || product.denominations.length === 0) {
      return { title: `404 — ${shopName}`, meta: "", status: 404 };
    }
    const desc = (product.description ?? "").trim().slice(0, 160);
    return {
      title: `${product.name} — ${shopName}`,
      meta:
        `<meta name="description" content="${esc(desc)}">` +
        `<meta property="og:title" content="${esc(product.name)}">` +
        `<meta property="og:type" content="product">` +
        (product.webImageUrl ? `<meta property="og:image" content="${esc(product.webImageUrl)}">` : ""),
      status: 200,
    };
  }
  const categorySlug = /^\/c\/([^/]+)$/.exec(path)?.[1];
  if (categorySlug) {
    const category = await getCategoryBySlug(prisma, decodeURIComponent(categorySlug));
    if (!category || !category.isActive) {
      return { title: `404 — ${shopName}`, meta: "", status: 404 };
    }
    return {
      title: `${category.name} — ${shopName}`,
      meta: `<meta property="og:title" content="${esc(category.name)}">`,
      status: 200,
    };
  }
  if (path === "/search") {
    return { title: `${t("web.search_placeholder", lang)} — ${shopName}`, meta: "", status: 200 };
  }
  for (const [re, key] of TITLE_KEYS) {
    if (re.test(path)) return { title: `${t(key, lang)} — ${shopName}`, meta: "", status: 200 };
  }
  // /account/orders/:code — order codes are private; generic title, no lookup.
  if (/^\/account\/orders\/[^/]+$/.test(path)) {
    return { title: `${t("web.account_orders", lang)} — ${shopName}`, status: 200, meta: "" };
  }
  if (!KNOWN_PATHS.test(path)) {
    return { title: `404 — ${shopName}`, meta: "", status: 404 };
  }
  return { title: shopName, meta: "", status: 200 };
}

export default async function spaShellRoutes(app: FastifyInstance): Promise<void> {
  app.get("/*", async (req, reply) => {
    const path = req.url.split("?", 1)[0]!;
    // Unmatched API paths land here too (the wildcard out-specifies the
    // not-found handler for GETs) — those must stay JSON, never an HTML shell.
    if (path.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const lang = requestLang(req);
    const [customer, shopName, favicon] = await Promise.all([
      optionalCustomer(req),
      getSetting(prisma, "shop_name").then((v) => v ?? "Toko Digital"),
      getSetting(prisma, "web_favicon_url").then((v) => v || "/static/favicon.svg"),
    ]);
    const head = await headInfo(path, lang, shopName);

    if (path.startsWith("/reset/")) {
      void reply.header("Referrer-Policy", "no-referrer");
    }

    const faviconLink = `<link rel="icon" href="${esc(favicon)}">`;
    const html = readFileSync(SPA_INDEX_PATH, "utf-8")
      .replace("__CSRF_TOKEN__", customer?.csrf ?? "")
      .replace("__LANG__", lang)
      .replace("__TITLE__", esc(head.title))
      .replace("<!--__HEAD_META__-->", faviconLink + head.meta);
    return reply.code(head.status).type("text/html").send(html);
  });
}
