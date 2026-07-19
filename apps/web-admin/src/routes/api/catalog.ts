import type { FastifyInstance } from "fastify";
import {
  prisma,
  listAllCategories,
  listProducts,
  getCategory,
  updateCategory,
  getCatalogProduct,
  getCatalogProductWithDenominations,
  updateCatalogProduct,
  deleteCatalogProduct,
  getDenomination,
  getDenominationWithProduct,
  assignDenominationToProduct,
  CategoryMismatchError,
  countAvailableStock,
  countRestockSubscribers,
  getBulkPricingForDenomination,
  upsertBulkPricing,
  deleteBulkPricing,
  setFlashSale,
  clearFlashSale,
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
import { localize, parseShopLocal } from "@app/core/datetime";
import { isFlashActive } from "@app/core/flash";
import { ProductType, DeliveryType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { zAdditionalFields } from "@app/core/deliveryFields";
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

    const category = await getCategory(prisma, categoryId);
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

    const deliveryType = typeof body.deliveryType === "string" ? body.deliveryType : DeliveryType.AUTO;
    if (!Object.values(DeliveryType).includes(deliveryType as DeliveryType)) {
      return reply.code(400).send({ error: "A valid delivery type is required." });
    }

    let additionalFields: string | null = null;
    if (deliveryType === DeliveryType.MANUAL_WITH_INFO) {
      const parsed = zAdditionalFields.safeParse(body.additionalFields);
      if (!parsed.success || parsed.data.length === 0) {
        return reply.code(400).send({ error: "At least one custom field is required for Manual + Info delivery." });
      }
      additionalFields = JSON.stringify(parsed.data);
    }
    // deliveryType !== MANUAL_WITH_INFO: additionalFields stays null even if the
    // client sent something (e.g. leftover state from switching away from
    // Manual + Info in the form) — the delivery type is the source of truth.

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
      deliveryType,
      additionalFields,
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

  app.patch("/api/catalog/products/:id", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid product id." });
    const existing = await getCatalogProduct(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Product not found." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (typeof body.name === "string" ? body.name : "").trim();
    if (!name) return reply.code(400).send({ error: "Name is required." });

    await updateCatalogProduct(prisma, id, {
      name,
      description: typeof body.description === "string" ? body.description.trim() || null : null,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_update",
      targetType: "product",
      targetId: id,
      details: `Updated product "${name}".`,
    });
    return reply.send({ id, name });
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

    let sortOrder: number | undefined;
    if (body.sortOrder != null && body.sortOrder !== "") {
      const n = Number(body.sortOrder);
      if (!Number.isInteger(n)) return reply.code(400).send({ error: "Sort order must be a whole number." });
      sortOrder = n;
    }

    // deliveryType/additionalFields are only touched when the request actually
    // provided a deliveryType, otherwise leave the existing values in place
    // (matching updateDenomination's partial-update semantics, same as
    // warrantyDays/sortOrder above).
    let deliveryType: DeliveryType | undefined;
    let additionalFields: string | null | undefined;
    if (body.deliveryType != null && body.deliveryType !== "") {
      const dt = typeof body.deliveryType === "string" ? body.deliveryType : "";
      if (!Object.values(DeliveryType).includes(dt as DeliveryType)) {
        return reply.code(400).send({ error: "A valid delivery type is required." });
      }
      deliveryType = dt as DeliveryType;

      if (deliveryType === DeliveryType.MANUAL_WITH_INFO) {
        const parsed = zAdditionalFields.safeParse(body.additionalFields);
        if (!parsed.success || parsed.data.length === 0) {
          return reply.code(400).send({ error: "At least one custom field is required for Manual + Info delivery." });
        }
        additionalFields = JSON.stringify(parsed.data);
      } else {
        // deliveryType !== MANUAL_WITH_INFO: additionalFields is cleared even if
        // the client sent something (e.g. leftover state from switching away
        // from Manual + Info in the form) — the delivery type is the source of
        // truth.
        additionalFields = null;
      }
    }

    // Re-parenting (moving this denomination to a different mid-tier Product)
    // is validated and applied FIRST, before any other field, so a rejected
    // cross-category move leaves every other field untouched too.
    if (body.productId != null && body.productId !== "") {
      const newProductId = Number(body.productId);
      if (!Number.isInteger(newProductId)) return reply.code(400).send({ error: "Invalid product id." });
      if (newProductId !== existing.productId) {
        try {
          await assignDenominationToProduct(prisma, id, newProductId);
        } catch (e) {
          if (e instanceof CategoryMismatchError) {
            return reply.code(422).send({ error: "Denomination and product must be in the same category." });
          }
          throw e;
        }
      }
    }

    await updateDenomination(prisma, id, {
      name,
      type: type as ProductType,
      durationLabel,
      price,
      costPrice,
      resellerPrice,
      ...(warrantyDays !== undefined ? { warrantyDays } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      description: typeof body.description === "string" ? body.description.trim() || null : null,
      ...(deliveryType !== undefined ? { deliveryType } : {}),
      ...(additionalFields !== undefined ? { additionalFields } : {}),
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

  // ---- Flash sale (percent off the base price for a bounded window) ----
  //
  // Mirrors the bulk-pricing pair above: same id/404 guards, 400 for anything
  // this route can parse itself, 422 for the write-time rules setFlashSale
  // owns (percent outside (0,100], a window that ends before it starts or is
  // already over).

  app.post("/api/catalog/denominations/:id/flash-sale", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid denomination id." });
    const existing = await getDenominationWithProduct(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Denomination not found." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const discountPercent = parseDecimal(body.discountPercent);
    if (discountPercent === null) return reply.code(400).send({ error: "A valid discount percent is required." });

    // The form submits bare wall-clock strings (<input type="datetime-local">),
    // which parseShopLocal reads in the shop's timezone — the admin types the
    // local time they see everywhere else in the panel.
    const startsAt = typeof body.startsAt === "string" ? parseShopLocal(body.startsAt) : null;
    if (startsAt === null) return reply.code(400).send({ error: "A valid start time is required." });
    const endsAt = typeof body.endsAt === "string" ? parseShopLocal(body.endsAt) : null;
    if (endsAt === null) return reply.code(400).send({ error: "A valid end time is required." });

    try {
      await setFlashSale(prisma, { denominationId: id, discountPercent, startsAt, endsAt });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
      throw e;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "flash_sale_set",
      targetType: "denomination",
      targetId: id,
      details:
        `Started a ${discountPercent.toString()}% flash sale on "${existing.name}" running from ` +
        `${localize(startsAt, "dd LLL yyyy HH:mm")} to ${localize(endsAt, "dd LLL yyyy HH:mm")}.`,
    });
    return reply.send({ ok: true });
  });

  app.delete("/api/catalog/denominations/:id/flash-sale", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid denomination id." });
    const existing = await getDenominationWithProduct(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Denomination not found." });

    const removed = await clearFlashSale(prisma, id);
    if (removed) {
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "flash_sale_delete",
        targetType: "denomination",
        targetId: id,
        details: `Cancelled the flash sale on "${existing.name}".`,
      });
    }
    return reply.send({ ok: true, removed });
  });

  app.get("/api/catalog/:productId", { preHandler: currentAdmin }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    if (!Number.isInteger(productId)) return reply.code(404).send({ error: "Product not found." });
    const product = await getCatalogProductWithDenominations(prisma, productId);
    if (!product) return reply.code(404).send({ error: "Product not found." });

    const now = new Date();
    const denomStats = await Promise.all(
      product.denominations.map(async (d) => ({
        id: d.id,
        available: await countAvailableStock(prisma, d.id),
        waiting: await countRestockSubscribers(prisma, d.id),
        rule: await getBulkPricingForDenomination(prisma, d.id),
        // The flash schedule as the edit form needs it back: percent as a
        // string (same as every other money/percent field on the wire),
        // timestamps as ISO UTC, plus whether the window is live right now so
        // the product list can badge the row without re-deriving the rule.
        // The *Local pair is the same instant pre-rendered as a shop-local
        // wall clock, because that is literally what an
        // `<input type="datetime-local">` holds and what the POST above reads
        // back through parseShopLocal — the browser's own timezone must never
        // enter the round trip, or an admin abroad would reschedule the sale
        // just by opening the form.
        flash:
          d.flashDiscountPercent != null && d.flashStartsAt != null && d.flashEndsAt != null
            ? {
                discountPercent: d.flashDiscountPercent.toString(),
                startsAt: d.flashStartsAt.toISOString(),
                endsAt: d.flashEndsAt.toISOString(),
                startsAtLocal: localize(d.flashStartsAt, "yyyy-LL-dd'T'HH:mm"),
                endsAtLocal: localize(d.flashEndsAt, "yyyy-LL-dd'T'HH:mm"),
                active: isFlashActive(d, now),
              }
            : null,
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
