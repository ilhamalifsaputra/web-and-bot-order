import type { FastifyInstance } from "fastify";
import {
  prisma,
  listAllCategories,
  listProducts,
  getCategory,
  updateCategory,
  deleteCategory,
  countProductsInCategory,
  reorderCategories,
  allCategoriesExist,
  getCatalogProduct,
  getCatalogProductWithDenominations,
  updateCatalogProduct,
  getGame,
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
  createCatalogProduct,
  createCategory,
  createDenomination,
  updateDenomination,
  deleteDenomination,
  bulkSetCatalogProductsActive,
  bulkSetCatalogProductsCategory,
  bulkSetDenominationsActive,
  setCatalogProductArchived,
  bulkSetCatalogProductsArchived,
  logAdminAction,
  isDigiflazzPriceOverridden,
} from "@app/db";
import { Decimal } from "@app/core/money";
import { isFlashActive } from "@app/core/flash";
import { ProductType, DeliveryType, CategoryGroup } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { zAdditionalFields } from "@app/core/deliveryFields";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { parseDenominationCsv, categoryNameMap, resolveOrCreateProduct } from "../../lib/catalogImport";

/**
 * The three storefront-only detail blocks on a product (prisma Product:
 * whatYouGet / terms / warrantyNote), read off a request body with the same
 * "trim, blank means null" rule the other free-text product fields use.
 * Shared by product create and update so the two can't drift apart.
 */
function storefrontDetailFields(body: Record<string, unknown>) {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() || null : null);
  return {
    whatYouGet: text(body.whatYouGet),
    terms: text(body.terms),
    warrantyNote: text(body.warrantyNote),
  };
}

/** Parse a possibly-blank string into a Decimal, or null if blank/invalid. */
function parseDecimal(value: unknown): Decimal | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new Decimal(value.trim());
  } catch {
    return null;
  }
}

/**
 * A product's optional game-navigation classification (Task 8/14):
 * gameVariant / gameVariantEmoji / gameRegion — read off a request body with
 * the same "trim, blank means null" rule storefrontDetailFields uses above.
 * Shared by product create and update so the two can't drift apart.
 */
function gameNavigationFields(body: Record<string, unknown>) {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() || null : null);
  return {
    gameVariant: text(body.gameVariant),
    gameVariantEmoji: text(body.gameVariantEmoji),
    gameRegion: text(body.gameRegion),
  };
}

const THUMBNAIL_KINDS = ["game", "voucher", "steam", "entertainment", "app", "generic"] as const;
const CURRENCY_ICON_KINDS = ["diamond", "coin", "key", "card", "voucher"] as const;

/**
 * A product's optional catalog-presentation classification (Fase 12 task
 * 22): thumbnailKind (the default placeholder art style shown when no photo
 * is uploaded) and currencyIconKind (the currency-icon chip shown on that
 * product's denomination cards on the storefront). Unlike
 * storefrontDetailFields/gameNavigationFields above, these two are NOT free
 * text — an explicitly-sent, unrecognized value is rejected with a 400
 * rather than silently nulled out, the same treatment CategoryGroup gets on
 * the category routes above. Returns a Fastify reply to send on validation
 * failure, or null on success (with the validated fields merged into `out`).
 * Shared by product create and update so the two can't drift apart.
 */
function catalogKindFields(
  body: Record<string, unknown>,
  out: { thumbnailKind: string | null; currencyIconKind: string | null },
): { error: string } | null {
  if (body.thumbnailKind !== undefined && body.thumbnailKind !== null) {
    if (
      typeof body.thumbnailKind !== "string" ||
      !THUMBNAIL_KINDS.includes(body.thumbnailKind as (typeof THUMBNAIL_KINDS)[number])
    ) {
      return { error: "Invalid thumbnail kind." };
    }
    out.thumbnailKind = body.thumbnailKind;
  } else {
    out.thumbnailKind = null;
  }

  if (body.currencyIconKind !== undefined && body.currencyIconKind !== null) {
    if (
      typeof body.currencyIconKind !== "string" ||
      !CURRENCY_ICON_KINDS.includes(body.currencyIconKind as (typeof CURRENCY_ICON_KINDS)[number])
    ) {
      return { error: "Invalid currency icon kind." };
    }
    out.currencyIconKind = body.currencyIconKind;
  } else {
    out.currencyIconKind = null;
  }

  return null;
}

export default async function catalogApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/catalog", { preHandler: currentAdmin }, async (req, reply) => {
    const [categories, products] = await Promise.all([
      listAllCategories(prisma),
      listProducts(prisma, undefined, "all"),
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

    const kindFields = { thumbnailKind: null as string | null, currencyIconKind: null as string | null };
    const kindError = catalogKindFields(body, kindFields);
    if (kindError) return reply.code(400).send(kindError);

    const product = await createCatalogProduct(prisma, {
      categoryId,
      name,
      emoji: typeof body.emoji === "string" ? body.emoji.trim() || null : null,
      description: typeof body.description === "string" ? body.description.trim() || null : null,
      ...storefrontDetailFields(body),
      ...gameNavigationFields(body),
      ...kindFields,
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

    // Unlike checkoutFlow below, group has no safe schema default to fall
    // back to — it's null until an admin classifies it — so an explicitly
    // sent, unrecognized value is rejected rather than silently dropped.
    let group: string | null = null;
    if (body.group !== undefined && body.group !== null) {
      if (typeof body.group !== "string" || !Object.values(CategoryGroup).includes(body.group as CategoryGroup)) {
        return reply.code(400).send({ error: "Invalid group." });
      }
      group = body.group;
    }

    const cat = await createCategory(prisma, {
      name,
      emoji: typeof body.emoji === "string" ? body.emoji.trim() || null : null,
      description: typeof body.description === "string" ? body.description.trim() || null : null,
      group,
      sortOrder: Number(body.sortOrder) || 0,
      // Has a safe schema default ("catalog"), so an absent or invalid value
      // silently falls back instead of 400ing — unlike PATCH below, where an
      // admin explicitly sending a bad value is a mistake worth surfacing.
      checkoutFlow: body.checkoutFlow === "instant" ? "instant" : "catalog",
    });
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

    // True partial patch: only the keys the request actually included are
    // written, so omitting e.g. `emoji` leaves the stored value alone instead
    // of nulling it out. `slug` is never in this set — it is frozen at
    // creation (storefront URLs and the sitemap depend on it).
    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = (typeof body.name === "string" ? body.name : "").trim();
      if (!name) return reply.code(400).send({ error: "Name is required." });
      fields.name = name;
    }
    if (body.emoji !== undefined) {
      fields.emoji = typeof body.emoji === "string" ? body.emoji.trim() || null : null;
    }
    if (body.description !== undefined) {
      fields.description = typeof body.description === "string" ? body.description.trim() || null : null;
    }
    if (body.sortOrder !== undefined) {
      fields.sortOrder = Number(body.sortOrder) || 0;
    }
    if (body.checkoutFlow !== undefined) {
      if (body.checkoutFlow !== "catalog" && body.checkoutFlow !== "instant") {
        return reply.code(400).send({ error: "Checkout flow must be \"catalog\" or \"instant\"." });
      }
      fields.checkoutFlow = body.checkoutFlow;
    }
    if (body.group !== undefined) {
      if (body.group !== null && !Object.values(CategoryGroup).includes(body.group as CategoryGroup)) {
        return reply.code(400).send({ error: "Invalid group." });
      }
      fields.group = body.group;
    }

    await updateCategory(prisma, id, fields);
    const name = typeof fields.name === "string" ? fields.name : existing.name;
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "category_update",
      targetType: "category",
      targetId: id,
      details: `Updated category "${name}".`,
    });
    return reply.send({ id, name });
  });

  app.delete("/api/catalog/categories/:id", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid category id." });
    const existing = await getCategory(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Category not found." });

    const productCount = await countProductsInCategory(prisma, id);
    if (productCount > 0) {
      return reply.code(409).send({
        error: `Cannot delete: move or delete its ${productCount} product(s) first.`,
        productCount,
      });
    }

    await deleteCategory(prisma, id);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "category_delete",
      targetType: "category",
      targetId: id,
      details: `Deleted category "${existing.name}".`,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/catalog/categories/reorder", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.some((n) => !Number.isInteger(n))) {
      return reply.code(400).send({ error: "ids must be an array of integers." });
    }
    const idList = ids as number[];
    if (!(await allCategoriesExist(prisma, idList))) {
      return reply.code(400).send({ error: "One or more categories were not found." });
    }

    await reorderCategories(prisma, idList);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "category_reorder",
      targetType: "category",
      targetId: null,
      details: "Reordered categories.",
    });
    return reply.send({ ok: true });
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

    // autoDeliverySource is the manual/override path for linking a single
    // denomination to a supplier (the Import Wizard is the bulk path) — "none"
    // (client sends nothing) clears it; "digiflazz" requires a non-empty
    // supplierSku, mirroring the client-side canSubmit rule.
    let autoDeliverySource: string | null = null;
    let supplierSku: string | null = null;
    if (deliveryType === DeliveryType.MANUAL_WITH_INFO) {
      autoDeliverySource =
        typeof body.autoDeliverySource === "string" && body.autoDeliverySource.trim() !== ""
          ? body.autoDeliverySource.trim()
          : null;
      if (autoDeliverySource === "digiflazz") {
        supplierSku = typeof body.supplierSku === "string" ? body.supplierSku.trim() : "";
        if (!supplierSku) {
          return reply.code(400).send({ error: "Supplier SKU is required when auto delivery source is Digiflazz." });
        }
      }
    }
    // deliveryType !== MANUAL_WITH_INFO: autoDeliverySource/supplierSku stay
    // null even if the client sent something (e.g. leftover state from
    // switching away from Manual + Info in the form) — same rule as
    // additionalFields above, the delivery type is the source of truth.

    // nicknameCheckGameCode (Task 7): a plain optional string, independent of
    // deliveryType/autoDeliverySource — unlike supplierSku, it needs no
    // coupling validation, it's just KokinPay's game_code for this SKU's
    // title, copied by hand from KokinPay's own docs.
    const nicknameCheckGameCode =
      typeof body.nicknameCheckGameCode === "string" ? body.nicknameCheckGameCode.trim() || null : null;

    // regionWarning/expectedRegionCode (Region-check Task B): plain optional
    // strings, independent of deliveryType/autoDeliverySource and of each
    // other — same "no cross-field validation rule" treatment as
    // nicknameCheckGameCode above.
    const regionWarning = typeof body.regionWarning === "string" ? body.regionWarning.trim() || null : null;
    const expectedRegionCode =
      typeof body.expectedRegionCode === "string" ? body.expectedRegionCode.trim() || null : null;

    // qtyValue/qtyUnit (Task 8/14): the compact-button quantity shown on the
    // bot, e.g. "86 Diamonds" — independent of every other field above.
    // qtyValue is optional but must be a non-negative integer when present;
    // qtyUnit is a plain optional string with no coupling to qtyValue.
    let qtyValue: number | null = null;
    if (body.qtyValue != null && body.qtyValue !== "") {
      const n = Number(body.qtyValue);
      if (!Number.isInteger(n) || n < 0) {
        return reply.code(400).send({ error: "Quantity value must be a non-negative whole number." });
      }
      qtyValue = n;
    }
    const qtyUnit = typeof body.qtyUnit === "string" ? body.qtyUnit.trim() || null : null;

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
      autoDeliverySource,
      supplierSku,
      nicknameCheckGameCode,
      regionWarning,
      expectedRegionCode,
      qtyValue,
      qtyUnit,
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

    // Optional re-categorization, mirroring the categoryId validation in the
    // product create route above (lines ~79-83).
    let newCategory: Awaited<ReturnType<typeof getCategory>> = null;
    if (body.categoryId !== undefined) {
      const categoryId = Number(body.categoryId);
      if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return reply.code(400).send({ error: "A valid category is required." });
      }
      newCategory = await getCategory(prisma, categoryId);
      if (!newCategory) return reply.code(400).send({ error: "Category not found." });
    }
    const isMove = newCategory != null && newCategory.id !== existing.categoryId;

    // gameId (Task 10): links this Product to the canonical Game record that
    // drives the multi-provider nickname-check. Unlike gameVariant/gameRegion
    // above (free text, "blank means null"), this is a numeric FK — omitted
    // entirely means "leave the existing link untouched"; explicit null
    // clears it; a number must resolve to an existing, active Game.
    let gameId: number | null | undefined;
    if (body.gameId !== undefined) {
      if (body.gameId === null) {
        gameId = null;
      } else {
        const parsedGameId = Number(body.gameId);
        if (!Number.isInteger(parsedGameId)) return reply.code(400).send({ error: "Invalid game id." });
        const game = await getGame(prisma, parsedGameId);
        // Final-review fix, Finding 4: distinguish "doesn't exist" from
        // "exists but inactive" — the admin's Linked Game picker can still
        // submit an id for a game that's since been deactivated (it keeps
        // the currently-linked game visible even when inactive), and a
        // generic "Game not found." there is misleading.
        if (!game) return reply.code(400).send({ error: "Game not found." });
        if (!game.isActive) return reply.code(400).send({ error: "That game is inactive." });
        gameId = parsedGameId;
      }
    }

    // thumbnailKind/currencyIconKind (Fase 12 task 22): validated up front,
    // same as categoryId/gameId above, so a rejected value leaves every
    // other field on this request untouched too.
    const kindFields = { thumbnailKind: null as string | null, currencyIconKind: null as string | null };
    const kindError = catalogKindFields(body, kindFields);
    if (kindError) return reply.code(400).send(kindError);

    await updateCatalogProduct(prisma, id, {
      name,
      description: typeof body.description === "string" ? body.description.trim() || null : null,
      ...storefrontDetailFields(body),
      ...gameNavigationFields(body),
      ...kindFields,
      ...(gameId !== undefined ? { gameId } : {}),
      ...(newCategory ? { categoryId: newCategory.id } : {}),
    });

    let details = `Updated product "${name}".`;
    if (isMove) {
      const oldCategory = await getCategory(prisma, existing.categoryId);
      details = `Moved product "${name}" from "${oldCategory?.name ?? "Unknown"}" to "${newCategory!.name}".`;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_update",
      targetType: "product",
      targetId: id,
      details,
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

  app.post("/api/catalog/products/bulk-category", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n)) : [];
    if (ids.length === 0) return reply.code(400).send({ error: "At least one product id is required." });

    const categoryId = Number(body.categoryId);
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return reply.code(400).send({ error: "A valid category is required." });
    }
    const category = await getCategory(prisma, categoryId);
    if (!category) return reply.code(400).send({ error: "Category not found." });

    const count = await bulkSetCatalogProductsCategory(prisma, ids, categoryId);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_bulk_category",
      targetType: "product",
      details: `Moved ${count} product${count === 1 ? "" : "s"} to category "${category.name}".`,
    });
    return reply.send({ ok: true, count });
  });

  app.post("/api/catalog/products/:id/archive", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid product id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.archived !== "boolean") return reply.code(400).send({ error: "archived must be a boolean." });
    const archived = body.archived;

    const product = await getCatalogProduct(prisma, id);
    if (!product) return reply.code(404).send({ error: "Product not found." });

    await setCatalogProductArchived(prisma, id, archived);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_archive_toggle",
      targetType: "product",
      targetId: id,
      details: `${archived ? "Archived" : "Unarchived"} product "${product.name}".`,
    });
    return reply.send({ id, isArchived: archived });
  });

  app.post("/api/catalog/products/bulk-archive", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n)) : [];
    if (ids.length === 0) return reply.code(400).send({ error: "At least one product id is required." });
    if (typeof body.archived !== "boolean") return reply.code(400).send({ error: "archived must be a boolean." });
    const archived = body.archived;

    const count = await bulkSetCatalogProductsArchived(prisma, ids, archived);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_bulk_archive",
      targetType: "product",
      details: `${archived ? "Archived" : "Unarchived"} ${count} product${count === 1 ? "" : "s"}.`,
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

  // Bulk twin of the single-row toggle above — same "active must be a
  // boolean" validation, same bulkSetDenominationsActive helper (already
  // accepted an id array; only the single-id route existed before this).
  // Mirrors POST /api/catalog/products/bulk-active's shape exactly, one
  // summary audit entry rather than one per denomination (matching that
  // route's own "no targetId on a multi-row action" convention).
  app.post("/api/catalog/denominations/bulk-active", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n)) : [];
    if (ids.length === 0) return reply.code(400).send({ error: "At least one denomination id is required." });
    if (typeof body.active !== "boolean") return reply.code(400).send({ error: "active must be a boolean." });
    const active = body.active;

    const count = await bulkSetDenominationsActive(prisma, ids, active);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "denomination_bulk_active",
      targetType: "denomination",
      details: `${active ? "Activated" : "Deactivated"} ${count} denomination${count === 1 ? "" : "s"}.`,
    });
    return reply.send({ ok: true, count });
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

    // autoDeliverySource/supplierSku, like costPrice/resellerPrice above, are
    // plain optional fields (not "touch-only-if-provided" like deliveryType):
    // an admin picking "None" in the form omits both from the request body,
    // which clears them here too. "digiflazz" requires a non-empty
    // supplierSku, mirroring the client-side canSubmit rule. Unlike
    // costPrice/resellerPrice, they're gated on the delivery type the same
    // way additionalFields is above — the *effective* delivery type is
    // whatever this request sets it to, or the row's existing value when
    // this request doesn't touch deliveryType at all, so a request that
    // sends autoDeliverySource alongside (or on top of) a non-manual_with_info
    // delivery type can't silently persist a supplier link with no
    // buyer-submitted fields for it to fulfill against.
    let autoDeliverySource: string | null = null;
    let supplierSku: string | null = null;
    const effectiveDeliveryType = deliveryType ?? existing.deliveryType;
    if (effectiveDeliveryType === DeliveryType.MANUAL_WITH_INFO) {
      autoDeliverySource =
        typeof body.autoDeliverySource === "string" && body.autoDeliverySource.trim() !== ""
          ? body.autoDeliverySource.trim()
          : null;
      if (autoDeliverySource === "digiflazz") {
        supplierSku = typeof body.supplierSku === "string" ? body.supplierSku.trim() : "";
        if (!supplierSku) {
          return reply.code(400).send({ error: "Supplier SKU is required when auto delivery source is Digiflazz." });
        }
      }
    }

    // priceOverridden is always computed server-side, never trusted from the
    // client — it's what protects a hand-edited price from being silently
    // recomputed by the next resyncDigiflazzCatalog tick. isDigiflazzPriceOverridden
    // is the single shared rule for this (see its doc comment in
    // crud/digiflazz.ts for why this used to be hand-rolled per call site,
    // and why that drifted out of sync across review rounds) — pass it
    // `costPrice`, the SAME local variable this same request is about to
    // persist a few lines below, never `existing.costPrice`: costPrice is an
    // "always overwrite, null if omitted" field on this route (same category
    // as autoDeliverySource/supplierSku, see the comment on those above),
    // NOT touch-only-if-provided like deliveryType/warrantyDays — the admin
    // client (DenominationEditPage.tsx) omits `costPrice` from the request
    // body whenever that form field is blank, which nulls the row's
    // costPrice right here in this same request, so the row's pre-request
    // value is never the right thing to compare against.
    let priceOverridden = false;
    if (autoDeliverySource === "digiflazz") {
      priceOverridden = await isDigiflazzPriceOverridden(prisma, price, costPrice);
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

    // nicknameCheckGameCode (Task 7): a plain optional string, same
    // always-set-from-this-request convention as description above — unlike
    // autoDeliverySource/supplierSku it needs no deliveryType coupling.
    const nicknameCheckGameCode =
      typeof body.nicknameCheckGameCode === "string" ? body.nicknameCheckGameCode.trim() || null : null;

    // regionWarning/expectedRegionCode (Region-check Task B): plain optional
    // strings, same always-set-from-this-request convention as
    // nicknameCheckGameCode above — no deliveryType coupling, independent
    // of each other.
    const regionWarning = typeof body.regionWarning === "string" ? body.regionWarning.trim() || null : null;
    const expectedRegionCode =
      typeof body.expectedRegionCode === "string" ? body.expectedRegionCode.trim() || null : null;

    // qtyValue/qtyUnit (Task 8/14): same always-set-from-this-request
    // convention as nicknameCheckGameCode/regionWarning/expectedRegionCode
    // above — qtyValue must be a non-negative integer when present, qtyUnit
    // is a plain optional string independent of qtyValue.
    let qtyValue: number | null = null;
    if (body.qtyValue != null && body.qtyValue !== "") {
      const n = Number(body.qtyValue);
      if (!Number.isInteger(n) || n < 0) {
        return reply.code(400).send({ error: "Quantity value must be a non-negative whole number." });
      }
      qtyValue = n;
    }
    const qtyUnit = typeof body.qtyUnit === "string" ? body.qtyUnit.trim() || null : null;

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
      autoDeliverySource,
      supplierSku,
      nicknameCheckGameCode,
      regionWarning,
      expectedRegionCode,
      priceOverridden,
      qtyValue,
      qtyUnit,
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
    const existing = await getDenominationWithProduct(prisma, id);
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
      details: `Deleted denomination "${existing.name}" from product "${existing.product.name}".`,
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

    const now = new Date();
    const denomStats = await Promise.all(
      product.denominations.map(async (d) => ({
        id: d.id,
        available: await countAvailableStock(prisma, d.id),
        waiting: await countRestockSubscribers(prisma, d.id),
        rule: await getBulkPricingForDenomination(prisma, d.id),
        // Percent + whether the window is live right now, so the product
        // list can badge the row (editing a flash sale itself happens on the
        // bulk Flash Sales page, not here).
        flash:
          d.flashDiscountPercent != null && d.flashStartsAt != null && d.flashEndsAt != null
            ? { discountPercent: d.flashDiscountPercent.toString(), active: isFlashActive(d, now) }
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
