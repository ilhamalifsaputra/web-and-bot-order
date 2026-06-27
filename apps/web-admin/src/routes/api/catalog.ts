import type { FastifyInstance } from "fastify";
import {
  prisma,
  listAllCategories,
  listProducts,
  getCatalogProductWithDenominations,
  countAvailableStock,
  countRestockSubscribers,
  getBulkPricingForDenomination,
  createDenomination,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { parseDenominationCsv, categoryNameMap, resolveOrCreateProduct } from "../../lib/catalogImport";

export default async function catalogApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/catalog", { preHandler: currentAdmin }, async (req, reply) => {
    const [categories, products] = await Promise.all([
      listAllCategories(prisma),
      listProducts(prisma),
    ]);
    return reply.send({ categories, products });
  });

  app.get("/api/catalog/:productId", { preHandler: currentAdmin }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const product = await getCatalogProductWithDenominations(prisma, productId);
    if (!product) return reply.code(404).send({ error: "Product not found." });

    const denomStats = await Promise.all(
      product.denominations.map(async (d) => ({
        id: d.id,
        available: await countAvailableStock(prisma, d.id),
        waiting: await countRestockSubscribers(prisma, d.id),
        rule: await getBulkPricingForDenomination(prisma, d.id),
      })),
    );
    const statsByDenom: Record<number, (typeof denomStats)[number]> = {};
    for (const s of denomStats) statsByDenom[s.id] = s;

    return reply.send({ product, statsByDenom });
  });

  // ---- Catalog CSV import (JSON API, used by the React SPA) ----

  // Step 1: parse + validate (dry-run, no write). Returns per-row status so the
  // operator sees a preview before committing. Re-run on apply (never trust the
  // precomputed payload).
  app.post("/api/catalog/products/import", { preHandler: csrfProtect }, async (req, reply) => {
    const csv = ((req.body as { csv?: string }).csv ?? "").trim();
    if (!csv) return reply.code(400).send({ error: "Paste at least one row." });
    const catByName = await categoryNameMap(prisma);
    const rows = parseDenominationCsv(csv, catByName);
    const validCount = rows.filter((r) => r.ok).length;
    return reply.send({ rows, validCount, invalidCount: rows.length - validCount, csv });
  });

  // Step 2: commit the valid rows in one transaction. Resolves-or-creates the
  // mid-tier Product by name within its category before creating each Denomination.
  app.post("/api/catalog/products/import/apply", { preHandler: csrfProtect }, async (req, reply) => {
    const csv = ((req.body as { csv?: string }).csv ?? "").trim();
    if (!csv) return reply.code(400).send({ error: "No CSV provided." });
    const catByName = await categoryNameMap(prisma);
    const rows = parseDenominationCsv(csv, catByName);
    const validRows = rows.filter((r) => r.ok && r.data);
    if (validRows.length === 0) return reply.code(400).send({ error: "No valid rows to import." });
    await prisma.$transaction(async (tx) => {
      for (const r of validRows) {
        const d = r.data!;
        const product = await resolveOrCreateProduct(tx, d.categoryId, d.productName);
        await createDenomination(tx, {
          productId: product.id,
          name: d.denominationName,
          type: d.type,
          durationLabel: d.durationLabel,
          price: d.price,
          costPrice: d.costPrice,
          resellerPrice: d.resellerPrice,
          description: d.description,
          warrantyDays: d.warrantyDays,
        });
      }
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "catalog_import",
      targetType: "denomination",
      targetId: null,
      details: `Imported ${validRows.length} denomination(s) from CSV.`,
    });
    return reply.send({ ok: true, count: validRows.length });
  });
}
