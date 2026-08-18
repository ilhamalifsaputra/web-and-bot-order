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

/**
 * Parse a price string into a Decimal, or null if it isn't a valid number
 * (mirrors routes/api/catalog.ts's parseDecimal — new Decimal(...) throws
 * synchronously on a non-numeric string, so this must be try/catch'd rather
 * than trusted like the rest of this row's fields).
 */
function parsePrice(value: string): Decimal | null {
  try {
    return new Decimal(value);
  } catch {
    return null;
  }
}

// N5: cap the total row count across every brand in a single /sync/apply
// request. This is a manual, human-reviewed wizard action (not a bulk data
// pipeline) — each brand's import runs its own $transaction, and this
// repo's shared SQLite is single-writer (see CLAUDE.md), so a very large
// request would hold a long sequence of writes against it. 500 rows
// comfortably covers a real bulk-import session while keeping that
// sequence bounded.
const MAX_APPLY_ROWS = 500;

export default async function digiflazzSyncApiRoutes(app: FastifyInstance): Promise<void> {
  // Step 1: fetch + group (dry run, no write) — same "preview then apply"
  // shape as /api/catalog/products/import, just sourced from Digiflazz's
  // live price list instead of a pasted CSV. Uses csrfProtect (not just
  // currentAdmin) because it makes a real paid outbound call to Digiflazz —
  // it must never be more permissive than /sync/apply right below it, which
  // it directly feeds into.
  app.post("/api/catalog/digiflazz/sync/preview", { preHandler: csrfProtect }, async (_req, reply) => {
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
      const totalRows = brands.reduce((sum, b) => sum + (Array.isArray(b.rows) ? b.rows.length : 0), 0);
      if (totalRows > MAX_APPLY_ROWS) {
        return reply.code(400).send({ error: "Too many rows in one import — narrow the filter or import in smaller batches." });
      }
      for (const b of brands) {
        for (const row of b.rows) {
          const price = row.price ? parsePrice(row.price) : null;
          if (!row.buyerSkuCode || !row.productName || !price || price.lessThanOrEqualTo(0)) {
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
