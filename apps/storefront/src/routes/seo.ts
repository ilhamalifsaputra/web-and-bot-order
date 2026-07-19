/**
 * SEO surfaces — GET /sitemap.xml and GET /robots.txt (Group A of the
 * storefront SEO quick-wins plan). Both must degrade gracefully (still a
 * valid 200 response) when no public base URL is configured — same
 * "keep serving, don't blow up on misconfiguration" philosophy as
 * apps/server/src/index.ts's missingLedgers handling. Never send Telegram
 * or touch the DB writer here — this is a pure read-only crawler surface.
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@app/core/config";
import { prisma, listActiveCategories, listCatalogProducts } from "@app/db";

/** Public origin for absolute sitemap/robots URLs — same fallback chain used
 * in checkout.ts's shopPublicUrl() / apiAuth.ts. */
function baseUrl(): string | null {
  return config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null;
}

/** Minimal XML text escape for values interpolated into <loc>. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const seoRoutes: FastifyPluginAsync = async (app) => {
  app.get("/sitemap.xml", async (_req, reply) => {
    void reply.type("application/xml; charset=utf-8");
    const origin = baseUrl();
    if (!origin) {
      // No public URL configured — still a valid, minimal sitemap rather
      // than a 500 or a sitemap full of relative/unusable URLs.
      return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';
    }

    const [categories, products] = await Promise.all([
      listActiveCategories(prisma),
      listCatalogProducts(prisma),
    ]);

    const urlTags: string[] = [];
    for (const c of categories) {
      urlTags.push(`<url><loc>${xmlEscape(`${origin}/c/${c.slug}`)}</loc></url>`);
    }
    for (const p of products) {
      // Product has createdAt but no updatedAt (prisma/schema.prisma) — use
      // createdAt for <lastmod>, date-only per the sitemap protocol.
      const lastmod = p.createdAt.toISOString().slice(0, 10);
      urlTags.push(
        `<url><loc>${xmlEscape(`${origin}/p/${p.slug}`)}</loc><lastmod>${lastmod}</lastmod></url>`,
      );
    }

    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      urlTags.join("") +
      "</urlset>"
    );
  });

  app.get("/robots.txt", async (_req, reply) => {
    void reply.type("text/plain; charset=utf-8");
    const origin = baseUrl();
    const lines = [
      "User-agent: *",
      "Allow: /",
      "Allow: /p/",
      "Allow: /c/",
      "Allow: /search",
      "Disallow: /account",
      "Disallow: /cart",
      "Disallow: /checkout",
      "Disallow: /api/",
    ];
    if (origin) {
      lines.push("", `Sitemap: ${origin}/sitemap.xml`);
    }
    return lines.join("\n") + "\n";
  });
};

export default seoRoutes;
