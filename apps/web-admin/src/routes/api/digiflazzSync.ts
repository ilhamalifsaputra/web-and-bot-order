import type { FastifyInstance } from "fastify";
import {
  prisma,
  getDigiflazzCreds,
  groupDigiflazzPriceListByBrand,
  computeDigiflazzMarkupPrice,
  importDigiflazzBrand,
  listAllCategories,
  logAdminAction,
} from "@app/db";
import { getPriceList } from "@app/core/suppliers/digiflazz";
import { Decimal } from "@app/core/money";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

export default async function digiflazzSyncApiRoutes(app: FastifyInstance): Promise<void> {
  // Step 1: fetch + group (dry run, no write) — same "preview then apply"
  // shape as /api/catalog/products/import, just sourced from Digiflazz's
  // live price list instead of a pasted CSV.
  app.post("/api/catalog/digiflazz/sync/preview", { preHandler: currentAdmin }, async (_req, reply) => {
    const creds = await getDigiflazzCreds(prisma);
    if (!creds) {
      return reply.code(400).send({ error: "Digiflazz credentials are not configured. Set them in Settings first." });
    }
    let items;
    try {
      items = await getPriceList(creds);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "Failed to reach Digiflazz." });
    }
    const gameItems = items.filter((i) => i.category === "Game");
    const groups = await groupDigiflazzPriceListByBrand(prisma, gameItems);
    const withPrices = await Promise.all(
      groups.map(async (g) => ({
        brand: g.brand,
        existingProductId: g.existingProductId,
        skus: await Promise.all(
          g.items.map(async (item) => ({
            buyerSkuCode: item.buyerSkuCode,
            productName: item.productName,
            costPrice: item.price.toString(),
            suggestedPrice: (await computeDigiflazzMarkupPrice(prisma, item.price)).toString(),
          })),
        ),
      })),
    );
    return reply.send({ groups: withPrices });
  });

  // Step 2: commit selected brands/rows in one transaction per brand.
  app.post(
    "/api/catalog/digiflazz/sync/apply",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        categoryId?: number;
        brands?: Array<{ brand: string; rows: Array<{ buyerSkuCode: string; productName: string; price: string }> }>;
      };
      const categoryId = Number(body.categoryId);
      if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return reply.code(400).send({ error: "A target category is required." });
      }
      const brands = Array.isArray(body.brands) ? body.brands : [];
      if (brands.length === 0) {
        return reply.code(400).send({ error: "Select at least one brand to import." });
      }
      for (const b of brands) {
        for (const row of b.rows) {
          if (!row.buyerSkuCode || !row.productName || !row.price || new Decimal(row.price).lessThanOrEqualTo(0)) {
            return reply.code(400).send({ error: `Invalid price for "${row.productName || row.buyerSkuCode}".` });
          }
        }
      }

      let brandsImported = 0;
      let denominationsImported = 0;
      for (const b of brands) {
        const result = await importDigiflazzBrand(prisma, { brand: b.brand, categoryId, rows: b.rows });
        brandsImported++;
        denominationsImported += result.denominationCount;
      }

      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "digiflazz_catalog_import",
        targetType: "product",
        targetId: null,
        details: `Imported ${brandsImported} game(s) / ${denominationsImported} denomination(s) from Digiflazz.`,
      });
      return reply.send({ ok: true, brandsImported, denominationsImported });
    },
  );

  // Categories for the target-category picker (existing categories only —
  // this wizard never auto-creates one).
  app.get("/api/catalog/digiflazz/categories", { preHandler: currentAdmin }, async (_req, reply) => {
    return reply.send({ categories: await listAllCategories(prisma) });
  });
}
