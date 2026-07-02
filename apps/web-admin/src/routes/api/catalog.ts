import type { FastifyInstance } from "fastify";
import {
  prisma,
  listAllCategories,
  listProducts,
  getCategory,
  updateCategory,
  getCatalogProduct,
  getCatalogProductWithDenominations,
  deleteCatalogProduct,
  getDenomination,
  getDenominationWithProduct,
  countAvailableStock,
  countRestockSubscribers,
  getBulkPricingForDenomination,
  upsertBulkPricing,
  deleteBulkPricing,
  createCatalogProduct,
  createCategory,
  createDenomination,
  updateDenomination,
  deleteDenomination,
  bulkSetCatalogProductsActive,
  bulkSetDenominationsActive,
  logAdminAction,
} from "@app/db";
import { Decimal } from "@app/core/money";
import { ProductType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { parseDenominationCsv, categoryNameMap, resolveOrCreateProduct } from "../../lib/catalogImport";

/** Parse a possibly-blank string into a Decimal, or null if blank/invalid. */
function parseDecimal(value: unknown): Decimal | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new Decimal(value.trim());
  } catch {
    return null;
  }
}

export default async function catalogApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/catalog", { preHandler: currentAdmin }, async (req, reply) => {
    const [categories, products] = await Promise.all([
      listAllCategories(prisma),
      listProducts(prisma),
    ]);
    return reply.send({ categories, products });
  });

  app.post("/api/catalog/products", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (typeof body.name === "string" ? body.name : "").trim();
    const categoryId = Number(body.categoryId);
    if (!name) return reply.code(400).send({ error: "Name is required." });
    if (!Number.isInteger(categoryId) || categoryId <= 0)
      return reply.code(400).send({ error: "A valid category is required." });

    const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (!category) return reply.code(400).send({ error: "Category not found." });

    const product = await createCatalogProduct(prisma, {
      categoryId,
      name,
      emoji: typeof body.emoji === "string" ? body.emoji.trim() || null : null,
      description: typeof body.description === "string" ? body.description.trim() || null : null,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "catalog_product_create",
      targetType: "product",
      targetId: product.id,
      details: `Created product "${name}".`,
    });
    return reply.code(201).send({ id: product.id, name: product.name, slug: product.slug });
  });

  app.post("/api/catalog/categories", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (typeof body.name === "string" ? body.name : "").trim();
    if (!name) return reply.code(400).send({ error: "Name is required." });

    const cat = await createCategory(prisma, { name });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "category_create",
      targetType: "category",
      targetId: cat.id,
      details: `Created category "${name}".`,
    });
    return reply.code(201).send({ category: cat });
  });

  app.patch("/api/catalog/categories/:id", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid category id." });
    const existing = await getCategory(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Category not found." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (typeof body.name === "string" ? body.name : "").trim();
    if (!name) return reply.code(400).send({ error: "Name is required." });

    await updateCategory(prisma, id, {
      name,
      emoji: typeof body.emoji === "string" ? body.emoji.trim() || null : null,
      description: typeof body.description === "string" ? body.description.trim() || null : null,
      sortOrder: Number(body.sortOrder) || 0,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "category_update",
      targetType: "category",
      targetId: id,
      details: `Updated category "${name}".`,
    });
    return reply.send({ id, name });
  });

  app.post("/api/catalog/categories/:id/active", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid category id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.active !== "boolean") return reply.code(400).send({ error: "active must be a boolean." });
    const active = body.active;

    const existing = await getCategory(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Category not found." });

    await updateCategory(prisma, id, { isActive: active });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "category_toggle",
      targetType: "category",
      targetId: id,
      details: `${active ? "Activated" : "Deactivated"} category "${existing.name}".`,
    });
    return reply.send({ id, isActive: active });
  });

  app.post("/api/catalog/products/:productId/denominations", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    if (!Number.isInteger(productId)) return reply.code(404).send({ error: "Product not found." });
    const product = await getCatalogProduct(prisma, productId);
    if (!product) return reply.code(404).send({ error: "Product not found." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (typeof body.name === "string" ? body.name : "").trim();
    if (!name) return reply.code(400).send({ error: "Name is required." });

    const type = typeof body.type === "string" ? body.type.toUpperCase() : "";
    if (!Object.values(ProductType).includes(type as ProductType)) {
      return reply.code(400).send({ error: "A valid type is required." });
    }

    const durationLabel = (typeof body.durationLabel === "string" ? body.durationLabel : "").trim();
    if (!durationLabel) return reply.code(400).send({ error: "Duration is required." });

    const price = parseDecimal(body.price);
    if (price === null) return reply.code(400).send({ error: "A valid price is required." });

    const costPrice = body.costPrice != null ? parseDecimal(body.costPrice) : null;
    if (body.costPrice != null && costPrice === null) {
      return reply.code(400).send({ error: "Cost price must be a valid number." });
    }
    const resellerPrice = body.resellerPrice != null ? parseDecimal(body.resellerPrice) : null;
    if (body.resellerPrice != null && resellerPrice === null) {
      return reply.code(400).send({ error: "Reseller price must be a valid number." });
    }

    let warrantyDays: number | null = null;
    if (body.warrantyDays != null && body.warrantyDays !== "") {
      const n = Number(body.warrantyDays);
      if (!Number.isInteger(n)) return reply.code(400).send({ error: "Warranty days must be a whole number." });
      warrantyDays = n;
    }

    const denom = await createDenomination(prisma, {
      productId,
      name,
      type: type as ProductType,
      durationLabel,
      price,
      costPrice,
      resellerPrice,
      warrantyDays,
      description: typeof body.description === "string" ? body.description.trim() || null : null,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "denomination_create",
      targetType: "denomination",
      targetId: denom.id,
      details: `Created denomination "${name}" for product ${productId}.`,
    });
    return reply.code(201).send({ id: denom.id, name: denom.name, slug: denom.slug });
  });

  app.post("/api/catalog/products/:id/active", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid product id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.active !== "boolean") return reply.code(400).send({ error: "active must be a boolean." });
    const active = body.active;

    const product = await getCatalogProduct(prisma, id);
    if (!product) return reply.code(404).send({ error: "Product not found." });

    await bulkSetCatalogProductsActive(prisma, [id], active);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_active_toggle",
      targetType: "product",
      targetId: id,
      details: `${active ? "Activated" : "Deactivated"} product "${product.name}".`,
    });
    return reply.send({ id, isActive: active });
  });

  app.post("/api/catalog/products/bulk-active", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n)) : [];
    if (ids.length === 0) return reply.code(400).send({ error: "At least one product id is required." });
    if (typeof body.active !== "boolean") return reply.code(400).send({ error: "active must be a boolean." });
    const active = body.active;

    const count = await bulkSetCatalogProductsActive(prisma, ids, active);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_bulk_active",
      targetType: "product",
      details: `${active ? "Activated" : "Deactivated"} ${count} product${count === 1 ? "" : "s"}.`,
    });
    return reply.send({ ok: true, count });
  });

  app.delete("/api/catalog/products/:id", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid product id." });
    const existing = await getCatalogProduct(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Product not found." });
    try {
      await deleteCatalogProduct(prisma, id);
    } catch (err) {
      if (err instanceof Error && err.message === "product not empty: move or delete its denominations first") {
        return reply.code(409).send({ error: "Cannot delete: move or delete its denominations first." });
      }
      throw err;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_delete",
      targetType: "product",
      targetId: id,
      details: `Deleted product "${existing.name}".`,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/catalog/denominations/:id/active", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid denomination id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.active !== "boolean") return reply.code(400).send({ error: "active must be a boolean." });
    const active = body.active;

    const denomination = await getDenomination(prisma, id);
    if (!denomination) return reply.code(404).send({ error: "Denomination not found." });

    await bulkSetDenominationsActive(prisma, [id], active);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "denomination_active_toggle",
      targetType: "denomination",
      targetId: id,
      details: `${active ? "Activated" : "Deactivated"} denomination "${denomination.name}".`,
    });
    return reply.send({ id, isActive: active });
  });

  app.patch("/api/catalog/denominations/:id", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid denomination id." });
    const existing = await getDenomination(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Denomination not found." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (typeof body.name === "string" ? body.name : "").trim();
    if (!name) return reply.code(400).send({ error: "Name is required." });

    const type = typeof body.type === "string" ? body.type.toUpperCase() : "";
    if (!Object.values(ProductType).includes(type as ProductType)) {
      return reply.code(400).send({ error: "A valid type is required." });
    }

    const durationLabel = (typeof body.durationLabel === "string" ? body.durationLabel : "").trim();
    if (!durationLabel) return reply.code(400).send({ error: "Duration is required." });

    const price = parseDecimal(body.price);
    if (price === null) return reply.code(400).send({ error: "A valid price is required." });

    const costPrice = body.costPrice != null ? parseDecimal(body.costPrice) : null;
    if (body.costPrice != null && costPrice === null) {
      return reply.code(400).send({ error: "Cost price must be a valid number." });
    }
    const resellerPrice = body.resellerPrice != null ? parseDecimal(body.resellerPrice) : null;
    if (body.resellerPrice != null && resellerPrice === null) {
      return reply.code(400).send({ error: "Reseller price must be a valid number." });
    }

    // warrantyDays is a required (non-nullable) column — only touch it when
    // the request actually provided a value, otherwise leave the existing
    // value in place (matching updateDenomination's partial-update semantics).
    let warrantyDays: number | undefined;
    if (body.warrantyDays != null && body.warrantyDays !== "") {
      const n = Number(body.warrantyDays);
      if (!Number.isInteger(n)) return reply.code(400).send({ error: "Warranty days must be a whole number." });
      warrantyDays = n;
    }

    await updateDenomination(prisma, id, {
      name,
      type: type as ProductType,
      durationLabel,
      price,
      costPrice,
      resellerPrice,
      ...(warrantyDays !== undefined ? { warrantyDays } : {}),
      description: typeof body.description === "string" ? body.description.trim() || null : null,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "denomination_update",
      targetType: "denomination",
      targetId: id,
      details: `Updated denomination "${name}".`,
    });
    return reply.send({ id, name });
  });

  app.delete("/api/catalog/denominations/:id", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid denomination id." });
    const existing = await getDenomination(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Denomination not found." });
    try {
      await deleteDenomination(prisma, id);
    } catch (err) {
      if (err instanceof Error && err.message === "cannot delete a denomination with order history") {
        return reply.code(409).send({ error: "Cannot delete a denomination with order history." });
      }
      throw err;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "denomination_delete",
      targetType: "denomination",
      targetId: id,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/catalog/denominations/:id/bulk-pricing", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid denomination id." });
    const existing = await getDenominationWithProduct(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Denomination not found." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const minQuantity = Number(body.minQuantity);
    if (!Number.isInteger(minQuantity) || minQuantity < 1) {
      return reply.code(400).send({ error: "Min quantity must be a whole number of at least 1." });
    }
    const discountPercent = parseDecimal(body.discountPercent);
    if (discountPercent === null) return reply.code(400).send({ error: "A valid discount percent is required." });

    try {
      await upsertBulkPricing(prisma, { denominationId: id, minQuantity, discountPercent });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
      throw e;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "bulk_pricing_set",
      targetType: "denomination",
      targetId: id,
      details: `Set bulk pricing for "${existing.name}": ${discountPercent.toString()}% off at ${minQuantity}+ quantity.`,
    });
    return reply.send({ ok: true });
  });

  app.delete("/api/catalog/denominations/:id/bulk-pricing", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid denomination id." });
    const existing = await getDenominationWithProduct(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Denomination not found." });

    const removed = await deleteBulkPricing(prisma, id);
    if (removed) {
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "bulk_pricing_delete",
        targetType: "denomination",
        targetId: id,
        details: `Removed bulk pricing for "${existing.name}".`,
      });
    }
    return reply.send({ ok: true, removed });
  });

  app.get("/api/catalog/:productId", { preHandler: currentAdmin }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    if (!Number.isInteger(productId)) return reply.code(404).send({ error: "Product not found." });
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
