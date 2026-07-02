/**
 * Catalog — Category / Product (mid-tier) / Denomination (leaf SKU)
 * management. Port of routers/catalog.py, reworked for the 3-tier catalog
 * (plan: docs/superpowers/plans/2026-06-19-catalog-3tier-rename.md Phase 2).
 */
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { UPLOADS_DIR } from "../paths";
import { handleUpload } from "../lib/upload";
import { ProductType } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import type { Db } from "@app/db";
import {
  prisma,
  listAllCategories,
  createCategory,
  updateCategory,
  createCatalogProduct,
  updateCatalogProduct,
  getCatalogProduct,
  deleteCatalogProduct,
  bulkSetCatalogProductsActive,
  assignDenominationToProduct,
  createDenomination,
  updateDenomination,
  getDenomination,
  getDenominationWithProduct,
  deleteDenomination,
  deleteBulkPricing,
  upsertBulkPricing,
  logAdminAction,
  CategoryMismatchError,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../plugins/auth";
import { redirectWithFlash, safeReturnTo } from "../flash";

const PRODUCT_PHOTO_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const PRODUCTS_DIR = join(UPLOADS_DIR, "products");
const PRODUCTS_URL_PREFIX = "/uploads/products";

function dec(value: string | undefined): Decimal | null {
  if (value === undefined || String(value).trim() === "") return null;
  try {
    return new Decimal(String(value).trim());
  } catch {
    return null;
  }
}

const truthy = (v: string | undefined) => ["1", "true", "on", "yes"].includes((v ?? "").toLowerCase());

/** Parse a comma-separated id list (from the bulk-select hidden field). */
const parseIds = (raw: string | undefined): number[] =>
  (raw ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

const PRODUCT_TYPES = Object.values(ProductType) as string[];

interface ImportRow {
  line: number;
  ok: boolean;
  error?: string;
  category?: string;
  product?: string;
  denomination?: string;
  price?: string;
  data?: {
    categoryId: number;
    productName: string;
    denominationName: string;
    type: ProductType;
    durationLabel: string;
    price: string;
    costPrice: string | null;
    resellerPrice: string | null;
    warrantyDays: number | null;
    description: string | null;
  };
}

const isNum = (s: string) => /^\d+(\.\d+)?$/.test(s);

/**
 * Parse pipe-delimited denomination rows (one per line):
 *   category | product | denomination | type | duration | price [| cost | reseller | warranty_days | description]
 * Validates each row against known category names; returns per-row status so
 * the operator sees a dry-run before any write. Re-run on apply (never trust
 * a precomputed payload). The mid-tier Product is resolved-or-created by name
 * within the category at apply time (not here — this is a pure parse/validate).
 */
function parseDenominationCsv(text: string, catByName: Map<string, number>): ImportRow[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((raw, idx) => {
      const line = idx + 1;
      const cols = raw.split("|").map((c) => c.trim());
      const [category, product, denomination, type, durationLabel, price, costPrice, resellerPrice, warrantyDays, ...descParts] =
        cols;
      const typeLower = (type ?? "").toLowerCase();
      const base: ImportRow = { line, ok: false, category, product, denomination, price };
      const fail = (error: string): ImportRow => ({ ...base, error });

      if (cols.length < 6) return fail("need: category|product|denomination|type|duration|price");
      const categoryId = category ? catByName.get(category.toLowerCase()) : undefined;
      if (!categoryId) return fail(`unknown category "${category ?? ""}"`);
      if (!product) return fail("product name is required");
      if (!denomination) return fail("denomination name is required");
      const typeUpper = (type ?? "").toUpperCase();
      if (typeUpper !== "SHARED" && typeUpper !== "PRIVATE") return fail("type must be shared or private");
      if (!durationLabel) return fail("duration label is required");
      if (!price || !isNum(price) || Number(price) <= 0) return fail("price must be a positive number");
      let cost: string | null = null;
      if (costPrice) {
        if (!isNum(costPrice)) return fail("cost price must be a number");
        cost = costPrice;
      }
      let reseller: string | null = null;
      if (resellerPrice) {
        if (!isNum(resellerPrice)) return fail("reseller price must be a number");
        reseller = resellerPrice;
      }
      let warranty: number | null = null;
      if (warrantyDays) {
        if (!/^\d+$/.test(warrantyDays)) return fail("warranty days must be a whole number");
        warranty = Number(warrantyDays);
      }
      return {
        ...base,
        ok: true,
        data: {
          categoryId,
          productName: product,
          denominationName: denomination,
          type: typeUpper as ProductType,
          durationLabel,
          price,
          costPrice: cost,
          resellerPrice: reseller,
          warrantyDays: warranty,
          description: descParts.join("|").trim() || null,
        },
      };
    });
}

async function categoryNameMap(): Promise<Map<string, number>> {
  const cats = await listAllCategories(prisma);
  return new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
}

/**
 * Find-or-create the mid-tier Product by name within a category (CSV import).
 * Takes the active `db` handle explicitly so callers running inside a
 * `prisma.$transaction(...)` pass the `tx` — SQLite is single-writer, so a
 * call against the outer `prisma` client here would block on its own open
 * transaction until it expires.
 */
async function resolveOrCreateProduct(db: Db, categoryId: number, name: string) {
  const existing = await db.product.findFirst({ where: { categoryId, name } });
  if (existing) return existing;
  return createCatalogProduct(db, { categoryId, name });
}

export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // ---- Catalog home + product detail: migrated to React SPA (api/catalog.ts) ----
  // GET /catalog  →  served by SPA shell (CatalogPage)
  // GET /catalog/product/:productId  →  served by SPA shell (ProductDetailPage)

  // ---- Categories ----
  app.post("/catalog/category", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const name = (body.name ?? "").trim();
    if (!name) return redirectWithFlash(reply, "/catalog", "Category name is required.", "error");
    const cat = await createCategory(prisma, {
      name,
      emoji: (body.emoji ?? "").trim() || null,
      description: (body.description ?? "").trim() || null,
      image: (body.image ?? "").trim() || null,
      sortOrder: Number(body.sort_order) || 0,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "category_create",
      targetType: "category",
      targetId: cat.id,
      details: `Created category "${name}".`,
    });
    return redirectWithFlash(reply, "/catalog", `Category '${name}' created.`, "success");
  });

  app.post("/catalog/category/:categoryId/update", { preHandler: csrfProtect }, async (req, reply) => {
    const categoryId = Number((req.params as { categoryId: string }).categoryId);
    const body = (req.body ?? {}) as Record<string, string>;
    const name = (body.name ?? "").trim();
    if (!name) return redirectWithFlash(reply, "/catalog", "Category name is required.", "error");
    await updateCategory(prisma, categoryId, {
      name,
      emoji: (body.emoji ?? "").trim() || null,
      description: (body.description ?? "").trim() || null,
      image: (body.image ?? "").trim() || null,
      sortOrder: Number(body.sort_order) || 0,
      isActive: truthy(body.is_active),
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "category_update",
      targetType: "category",
      targetId: categoryId,
      details: `Updated category "${name}".`,
    });
    return redirectWithFlash(reply, "/catalog", "Category updated.", "success");
  });

  app.post("/catalog/category/:categoryId/toggle", { preHandler: csrfProtect }, async (req, reply) => {
    const categoryId = Number((req.params as { categoryId: string }).categoryId);
    const active = truthy((req.body as Record<string, string>).is_active);
    await updateCategory(prisma, categoryId, { isActive: active });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "category_toggle",
      targetType: "category",
      targetId: categoryId,
      details: `${active ? "Activated" : "Deactivated"} category ${categoryId}.`,
    });
    return redirectWithFlash(reply, "/catalog", "Category updated.", "success");
  });

  // ---- Products (mid-tier; no price/type/duration) ----
  // Bulk activate/deactivate selected PRODUCTS (one writer, audited once).
  app.post("/catalog/products/bulk", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const action = body.action;
    const ids = parseIds(body.ids);
    if (!ids.length || (action !== "activate" && action !== "deactivate")) {
      return redirectWithFlash(reply, "/catalog", "Select at least one product and an action.", "error");
    }
    const isActive = action === "activate";
    const count = await bulkSetCatalogProductsActive(prisma, ids, isActive);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_bulk_active",
      targetType: "product",
      targetId: null,
      details: `${isActive ? "Activated" : "Deactivated"} ${count} products.`,
    });
    return redirectWithFlash(reply, "/catalog", `${count} product(s) ${isActive ? "activated" : "deactivated"}.`, "success");
  });

  // Product CSV import — STEP 2: commit the valid rows in one transaction.
  // Resolves-or-creates the mid-tier Product by name within its category
  // before creating the Denomination row under it.
  app.post("/catalog/products/import/apply", { preHandler: csrfProtect }, async (req, reply) => {
    const csv = ((req.body as Record<string, string>).csv ?? "").trim();
    const valid = parseDenominationCsv(csv, await categoryNameMap()).filter((r) => r.ok && r.data);
    if (!valid.length) {
      return redirectWithFlash(reply, "/catalog", "No valid rows to import.", "error");
    }
    await prisma.$transaction(async (tx) => {
      for (const r of valid) {
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
      action: "product_csv_import",
      targetType: "product",
      targetId: null,
      details: `Imported ${valid.length} products from CSV.`,
    });
    return redirectWithFlash(reply, "/catalog", `Imported ${valid.length} row(s).`, "success");
  });

  app.post("/catalog/product", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const name = (body.name ?? "").trim();
    const categoryId = Number(body.category_id);
    if (!name || !Number.isInteger(categoryId) || categoryId <= 0) {
      return redirectWithFlash(reply, "/catalog", "Name and a category are required.", "error");
    }
    const product = await createCatalogProduct(prisma, {
      categoryId,
      name,
      emoji: (body.emoji ?? "").trim() || null,
      description: (body.description ?? "").trim() || null,
      imageFileId: (body.image_file_id ?? "").trim() || null,
      webImageUrl: (body.web_image_url ?? "").trim() || null,
      sortOrder: Number(body.sort_order) || 0,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_create",
      targetType: "product",
      targetId: product.id,
      details: `Created product "${name}".`,
    });
    return redirectWithFlash(reply, "/catalog", `Product '${name}' created.`, "success");
  });

  app.post("/catalog/product/:productId/update", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const body = (req.body ?? {}) as Record<string, string>;
    // Where to land after saving — the product detail page sends its own tab,
    // the catalog list sends nothing → "/catalog" (unchanged behaviour).
    const back = safeReturnTo(body.return_to, "/catalog");
    const name = (body.name ?? "").trim();
    if (!name) {
      return redirectWithFlash(reply, back, "Name is required.", "error");
    }
    const fields: Record<string, unknown> = {
      name,
      emoji: (body.emoji ?? "").trim() || null,
      description: (body.description ?? "").trim() || null,
      imageFileId: (body.image_file_id ?? "").trim() || null,
      webImageUrl: (body.web_image_url ?? "").trim() || null,
      sortOrder: Number(body.sort_order) || 0,
      isActive: truthy(body.is_active),
    };
    await updateCatalogProduct(prisma, productId, fields);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_update",
      targetType: "product",
      targetId: productId,
      details: `Updated product "${name}".`,
    });
    return redirectWithFlash(reply, back, "Product updated.", "success");
  });

  app.post("/catalog/product/:productId/delete", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    try {
      await deleteCatalogProduct(prisma, productId);
    } catch (err) {
      // Only the crud's specific "not empty" guard gets the friendly flash —
      // mirror how the re-parent path discriminates CategoryMismatchError
      // rather than catching every Error. Anything else (e.g. a missing
      // product, which Prisma reports as a PrismaClientKnownRequestError
      // whose pretty-printed message embeds a source-code snippet — and that
      // snippet can itself contain the substring "product not empty" from
      // the line above the failing call — so match the EXACT message our own
      // throw uses, not a substring) is a genuine unexpected failure and
      // must not be mislabeled.
      if (err instanceof Error && err.message === "product not empty: move or delete its denominations first") {
        return redirectWithFlash(reply, "/catalog", "Cannot delete: move or delete its denominations first.", "error");
      }
      throw err;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_delete",
      targetType: "product",
      targetId: productId,
    });
    return redirectWithFlash(reply, "/catalog", "Product deleted.", "success");
  });

  // ---- Product photo upload ----
  // Multipart route (CSRF checked inside handleUpload since formbody doesn't
  // parse multipart) mirroring apps/web-admin/src/routes/branding.ts's pattern.
  app.post<{ Params: { productId: string } }>(
    "/catalog/product/:productId/photo",
    { preHandler: currentAdmin },
    async (req, reply) => {
      const productId = Number(req.params.productId);
      if (!Number.isInteger(productId) || productId <= 0) {
        return redirectWithFlash(reply, "/catalog", "Invalid product.", "error");
      }
      const product = await getCatalogProduct(prisma, productId);
      if (!product) {
        return redirectWithFlash(reply, "/catalog", "Product not found.", "error");
      }
      return handleUpload(req, reply, {
        kind: "product",
        field: "photo",
        allowed: PRODUCT_PHOTO_MIME,
        maxBytes: 5 * 1024 * 1024,
        destDir: PRODUCTS_DIR,
        urlPrefix: PRODUCTS_URL_PREFIX,
        getOldUrl: async () => product.webImageUrl,
        auditAction: "product_photo_upload",
        auditTarget: { type: "product", id: productId },
        redirectPath: `/catalog/${productId}`,
        details: (filename) => `Uploaded a new photo for product "${product.name}" (${filename}).`,
        afterSave: (url) => updateCatalogProduct(prisma, productId, { webImageUrl: url }),
      });
    },
  );

  // ---- Denominations (leaf / SKU) — inside Product detail ----
  app.post("/catalog/product/:productId/denomination", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const body = (req.body ?? {}) as Record<string, string>;
    const back = safeReturnTo(body.return_to, `/catalog/product/${productId}`);

    const name = (body.name ?? "").trim();
    const priceDec = dec(body.price);
    if (!name || priceDec === null) {
      return redirectWithFlash(reply, back, "Name and a valid price are required.", "error");
    }
    const typeUpper = (body.type ?? "").toUpperCase();
    if (!PRODUCT_TYPES.includes(typeUpper)) {
      return redirectWithFlash(reply, back, "Invalid type.", "error");
    }
    const durationLabel = (body.duration_label ?? "").trim();
    if (!durationLabel) {
      return redirectWithFlash(reply, back, "Duration is required.", "error");
    }
    let warranty: number | null = null;
    if ((body.warranty_days ?? "").trim()) {
      const n = Number(body.warranty_days);
      if (!Number.isInteger(n)) {
        return redirectWithFlash(reply, back, "Warranty days must be a number.", "error");
      }
      warranty = n;
    }
    const denom = await createDenomination(prisma, {
      productId,
      name,
      type: typeUpper as ProductType,
      durationLabel,
      price: priceDec,
      costPrice: dec(body.cost_price),
      resellerPrice: dec(body.reseller_price),
      autoDeliverySource: (body.auto_delivery_source ?? "").trim() || null,
      warrantyDays: warranty,
      description: (body.description ?? "").trim() || null,
      imageFileId: (body.image_file_id ?? "").trim() || null,
      webImageUrl: (body.web_image_url ?? "").trim() || null,
      sortOrder: Number(body.sort_order) || 0,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "denomination_create",
      targetType: "denomination",
      targetId: denom.id,
      details: `Created denomination "${name}" for product ${productId}.`,
    });
    return redirectWithFlash(reply, back, `Denomination '${name}' created.`, "success");
  });

  app.post("/catalog/denomination/:denominationId/update", { preHandler: csrfProtect }, async (req, reply) => {
    const denominationId = Number((req.params as { denominationId: string }).denominationId);
    const body = (req.body ?? {}) as Record<string, string>;
    const existing = await getDenomination(prisma, denominationId);
    const back = safeReturnTo(body.return_to, existing ? `/catalog/product/${existing.productId}` : "/catalog");
    if (!existing) {
      return redirectWithFlash(reply, "/catalog", "Denomination not found.", "error");
    }

    const name = (body.name ?? "").trim();
    const priceDec = dec(body.price);
    if (!name || priceDec === null) {
      return redirectWithFlash(reply, back, "Name and a valid price are required.", "error");
    }
    const durationLabel = (body.duration_label ?? "").trim();
    if (!durationLabel) {
      return redirectWithFlash(reply, back, "Duration is required.", "error");
    }
    // Only the quick Hide/Show toggle (product_detail.njk) posts a body with
    // just name/duration_label/price/is_active; the full edit dropdown posts
    // every optional field every time (clearing one to empty means "set
    // null"). So patch optional fields by PRESENCE in the body, not
    // truthiness — an absent key must leave the existing column untouched,
    // while a present-but-empty key must null it out.
    const fields: Record<string, unknown> = {
      name,
      durationLabel,
      price: priceDec,
      isActive: truthy(body.is_active),
    };
    if ("cost_price" in body) fields.costPrice = dec(body.cost_price);
    if ("reseller_price" in body) fields.resellerPrice = dec(body.reseller_price);
    if ("auto_delivery_source" in body) fields.autoDeliverySource = (body.auto_delivery_source ?? "").trim() || null;
    if ("description" in body) fields.description = (body.description ?? "").trim() || null;
    if ("image_file_id" in body) fields.imageFileId = (body.image_file_id ?? "").trim() || null;
    if ("web_image_url" in body) fields.webImageUrl = (body.web_image_url ?? "").trim() || null;
    if ("sort_order" in body) fields.sortOrder = Number(body.sort_order) || 0;
    if ((body.warranty_days ?? "").trim()) {
      const n = Number(body.warranty_days);
      if (!Number.isInteger(n)) {
        return redirectWithFlash(reply, back, "Warranty days must be a number.", "error");
      }
      fields.warrantyDays = n;
    }
    if ((body.type ?? "").trim()) {
      const typeUpper = (body.type ?? "").toUpperCase();
      if (!PRODUCT_TYPES.includes(typeUpper)) {
        return redirectWithFlash(reply, back, "Invalid type.", "error");
      }
      fields.type = typeUpper;
    }

    // Re-parent to a different product — must stay in the same category.
    if ((body.product_id ?? "").trim()) {
      const newProductId = Number(body.product_id);
      if (!Number.isInteger(newProductId) || newProductId <= 0) {
        return redirectWithFlash(reply, back, "Invalid product.", "error");
      }
      if (newProductId !== existing.productId) {
        try {
          await assignDenominationToProduct(prisma, denominationId, newProductId);
        } catch (err) {
          if (err instanceof CategoryMismatchError) {
            return redirectWithFlash(reply, back, "Denomination and product must share the same category.", "error");
          }
          throw err;
        }
      }
    }

    await updateDenomination(prisma, denominationId, fields);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "denomination_update",
      targetType: "denomination",
      targetId: denominationId,
      details: `Updated denomination "${name}".`,
    });
    return redirectWithFlash(reply, back, "Denomination updated.", "success");
  });

  app.post("/catalog/denomination/:denominationId/delete", { preHandler: csrfProtect }, async (req, reply) => {
    const denominationId = Number((req.params as { denominationId: string }).denominationId);
    const body = (req.body ?? {}) as Record<string, string>;
    const existing = await getDenomination(prisma, denominationId);
    const back = safeReturnTo(body.return_to, existing ? `/catalog/product/${existing.productId}` : "/catalog");
    if (!existing) {
      return redirectWithFlash(reply, "/catalog", "Denomination not found.", "error");
    }
    try {
      await deleteDenomination(prisma, denominationId);
    } catch (err) {
      // Only the crud's specific "has order history" guard gets the friendly
      // flash — mirror how the product-delete route discriminates its own
      // guard error rather than catching every Error (exact message match,
      // not substring, for the same reason documented there).
      if (err instanceof Error && err.message === "cannot delete a denomination with order history") {
        return redirectWithFlash(reply, back, "Cannot delete a denomination with order history.", "error");
      }
      throw err;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "denomination_delete",
      targetType: "denomination",
      targetId: denominationId,
    });
    return redirectWithFlash(reply, back, "Denomination deleted.", "success");
  });

  // ---- Bulk pricing (keyed by denomination) ----
  app.post("/catalog/denomination/:denominationId/bulk-pricing", { preHandler: csrfProtect }, async (req, reply) => {
    const denominationId = Number((req.params as { denominationId: string }).denominationId);
    const body = (req.body ?? {}) as Record<string, string>;
    const existing = await getDenominationWithProduct(prisma, denominationId);
    const back = safeReturnTo(body.return_to, existing ? `/catalog/product/${existing.product.id}` : "/catalog");

    if (!(body.min_quantity ?? "").trim()) {
      const removed = await deleteBulkPricing(prisma, denominationId);
      if (removed) {
        await logAdminAction(prisma, {
          adminId: req.admin!.userId,
          action: "bulk_pricing_delete",
          targetType: "denomination",
          targetId: denominationId,
        });
      }
      return redirectWithFlash(reply, back, "Bulk pricing removed.", "success");
    }

    const minq = Number(body.min_quantity);
    if (!Number.isInteger(minq)) {
      return redirectWithFlash(reply, back, "Min quantity must be a number.", "error");
    }
    const pct = dec(body.discount_percent);
    if (minq < 1 || pct === null || pct.lessThanOrEqualTo(0)) {
      return redirectWithFlash(reply, back, "Provide a valid min qty and discount %.", "error");
    }
    // verify denomination exists for a clean FK error message
    if (!existing) {
      return redirectWithFlash(reply, back, "Denomination not found.", "error");
    }
    await upsertBulkPricing(prisma, { denominationId, minQuantity: minq, discountPercent: pct });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "bulk_pricing_set",
      targetType: "denomination",
      targetId: denominationId,
      details: `Set bulk pricing for denomination ${denominationId}: ${pct.toString()}% off at ${minq}+ quantity.`,
    });
    return redirectWithFlash(reply, back, "Bulk pricing saved.", "success");
  });
}
