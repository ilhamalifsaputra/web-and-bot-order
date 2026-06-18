/**
 * Catalog — categories, products, per-product bulk pricing. Port of
 * routers/catalog.py.
 */
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { UPLOADS_DIR } from "../paths";
import { ProductType } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import {
  prisma,
  listAllCategories,
  listAllProducts,
  listBulkPricingRules,
  createCategory,
  updateCategory,
  createProduct,
  updateProduct,
  bulkSetProductsActive,
  bulkSetPrices,
  getProductsByIds,
  getProduct,
  deleteBulkPricing,
  upsertBulkPricing,
  logAdminAction,
  getUsdIdrRate,
  listAllGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  assignProductToGroup,
  CategoryMismatchError,
} from "@app/db";
import { currentAdmin, csrfProtect, canMutate } from "../plugins/auth";
import { redirectWithFlash } from "../flash";

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
  name?: string;
  type?: string;
  durationLabel?: string;
  price?: string;
  data?: {
    categoryId: number;
    name: string;
    description: string | null;
    type: ProductType;
    durationLabel: string;
    price: string;
    resellerPrice: string | null;
    warrantyDays: number | null;
  };
}

const isNum = (s: string) => /^\d+(\.\d+)?$/.test(s);

/**
 * Parse pipe-delimited product rows (one per line):
 *   category | name | type | duration | price [| reseller | warranty_days | description]
 * Validates each row against the known category names; returns per-row status
 * so the operator sees a dry-run before any write. Re-run on apply (never trust
 * a precomputed payload).
 */
function parseProductCsv(text: string, catByName: Map<string, number>): ImportRow[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((raw, idx) => {
      const line = idx + 1;
      const cols = raw.split("|").map((c) => c.trim());
      const [category, name, type, durationLabel, price, resellerPrice, warrantyDays, ...descParts] = cols;
      const description = descParts.join("|").trim() || null;
      const typeLower = (type ?? "").toLowerCase();
      const base: ImportRow = { line, ok: false, category, name, type: typeLower, durationLabel, price };
      const fail = (error: string): ImportRow => ({ ...base, error });

      if (cols.length < 5) return fail("need: category|name|type|duration|price");
      const categoryId = category ? catByName.get(category.toLowerCase()) : undefined;
      if (!categoryId) return fail(`unknown category "${category ?? ""}"`);
      if (!name) return fail("name is required");
      const typeUpper = (type ?? "").toUpperCase();
      if (typeUpper !== "SHARED" && typeUpper !== "PRIVATE") return fail("type must be shared or private");
      if (!durationLabel) return fail("duration label is required");
      if (!price || !isNum(price) || Number(price) <= 0) return fail("price must be a positive number");
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
          name,
          description,
          type: typeUpper as ProductType,
          durationLabel,
          price,
          resellerPrice: reseller,
          warrantyDays: warranty,
        },
      };
    });
}

async function categoryNameMap(): Promise<Map<string, number>> {
  const cats = await listAllCategories(prisma);
  return new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
}

export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get("/catalog", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const categories = await listAllCategories(prisma);
    const products = await listAllProducts(prisma);
    const rules = await listBulkPricingRules(prisma);
    // Prices are central Rupiah; the rate powers the read-only USDT preview
    // next to the price inputs (same figure buyers see — plan.md §15.6).
    const fxRate = await getUsdIdrRate(prisma);
    const groups = await listAllGroups(prisma);

    const rulesByProduct: Record<number, (typeof rules)[number]> = {};
    for (const r of rules) rulesByProduct[r.productId] = r;

    return reply.view("catalog.njk", {
      admin: req.admin,
      active_nav: "/catalog",
      categories,
      products,
      rules_by_product: rulesByProduct,
      groups,
      product_types: PRODUCT_TYPES,
      usd_idr_rate: fxRate ? fxRate.toString() : null,
      msg: q.msg ?? null,
      kind: q.kind ?? "info",
    });
  });

  // ---- Categories ----
  app.post("/catalog/category", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const name = (body.name ?? "").trim();
    if (!name) return redirectWithFlash(reply, "/catalog", "Category name is required.", "error");
    const cat = await createCategory(prisma, name, (body.emoji ?? "").trim() || null, Number(body.sort_order) || 0);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "category_create",
      targetType: "category",
      targetId: cat.id,
      details: `name=${name}`,
    });
    return redirectWithFlash(reply, "/catalog", `Category '${name}' created.`, "success");
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
      details: `is_active=${active}`,
    });
    return redirectWithFlash(reply, "/catalog", "Category updated.", "success");
  });

  // ---- Products ----
  // Bulk activate/deactivate selected products (one writer, audited once).
  app.post("/catalog/products/bulk", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const action = body.action;
    const ids = parseIds(body.ids);
    if (!ids.length || (action !== "activate" && action !== "deactivate")) {
      return redirectWithFlash(reply, "/catalog", "Select at least one product and an action.", "error");
    }
    const isActive = action === "activate";
    const count = await bulkSetProductsActive(prisma, ids, isActive);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_bulk_active",
      targetType: "product",
      targetId: null,
      details: `is_active=${isActive} count=${count} ids=${ids.join("|").slice(0, 180)}`,
    });
    return redirectWithFlash(reply, "/catalog", `${count} product(s) ${isActive ? "activated" : "deactivated"}.`, "success");
  });

  // Bulk price change — STEP 1: preview old→new (no write). mode=set|percent.
  app.post("/catalog/products/bulk-price", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const ids = parseIds(body.ids);
    const mode = body.mode === "percent" ? "percent" : "set";
    const value = dec(body.value);
    if (!ids.length || value === null) {
      return redirectWithFlash(reply, "/catalog", "Select products and enter a value.", "error");
    }
    const products = await getProductsByIds(prisma, ids);
    const rows = products.map((p) => {
      const current = new Decimal(p.price);
      let next = mode === "percent" ? current.plus(current.times(value).div(100)) : value;
      next = new Decimal(next.toFixed(4));
      return { id: p.id, name: p.name, current: current.toString(), next: next.toString(), invalid: next.lessThanOrEqualTo(0) };
    });
    return reply.view("catalog_price_preview.njk", {
      admin: req.admin,
      active_nav: "/catalog",
      mode,
      value: value.toString(),
      rows,
      any_invalid: rows.some((r) => r.invalid),
      pairs: rows.filter((r) => !r.invalid).map((r) => `${r.id}:${r.next}`).join(","),
    });
  });

  // Bulk price change — STEP 2: apply the previewed prices.
  app.post("/catalog/products/bulk-price/apply", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const items = (body.pairs ?? "")
      .split(",")
      .map((pair) => {
        const [id, price] = pair.split(":");
        return { id: Number(id), price: (price ?? "").trim() };
      })
      .filter((it) => Number.isInteger(it.id) && it.id > 0 && /^\d+(\.\d+)?$/.test(it.price) && Number(it.price) > 0);
    if (!items.length) {
      return redirectWithFlash(reply, "/catalog", "Nothing to apply.", "error");
    }
    const count = await prisma.$transaction((tx) => bulkSetPrices(tx, items));
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_bulk_price",
      targetType: "product",
      targetId: null,
      details: `count=${count} pairs=${items.map((i) => `${i.id}=${i.price}`).join("|").slice(0, 200)}`,
    });
    return redirectWithFlash(reply, "/catalog", `Updated the price of ${count} product(s).`, "success");
  });

  // Product CSV import — STEP 1: dry-run preview (parse + validate, no write).
  app.post("/catalog/products/import", { preHandler: csrfProtect }, async (req, reply) => {
    const csv = ((req.body as Record<string, string>).csv ?? "").trim();
    if (!csv) {
      return redirectWithFlash(reply, "/catalog", "Paste at least one product row.", "error");
    }
    const rows = parseProductCsv(csv, await categoryNameMap());
    const validCount = rows.filter((r) => r.ok).length;
    return reply.view("catalog_import_preview.njk", {
      admin: req.admin,
      active_nav: "/catalog",
      rows,
      valid_count: validCount,
      invalid_count: rows.length - validCount,
      csv,
    });
  });

  // Product CSV import — STEP 2: commit the valid rows in one transaction.
  app.post("/catalog/products/import/apply", { preHandler: csrfProtect }, async (req, reply) => {
    const csv = ((req.body as Record<string, string>).csv ?? "").trim();
    const valid = parseProductCsv(csv, await categoryNameMap()).filter((r) => r.ok && r.data);
    if (!valid.length) {
      return redirectWithFlash(reply, "/catalog", "No valid rows to import.", "error");
    }
    await prisma.$transaction(async (tx) => {
      for (const r of valid) await createProduct(tx, r.data!);
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_csv_import",
      targetType: "product",
      targetId: null,
      details: `count=${valid.length} names=${valid.map((r) => r.data!.name).join(",").slice(0, 200)}`,
    });
    return redirectWithFlash(reply, "/catalog", `Imported ${valid.length} product(s).`, "success");
  });

  app.post("/catalog/product", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const name = (body.name ?? "").trim();
    const priceDec = dec(body.price);
    if (!name || priceDec === null) {
      return redirectWithFlash(reply, "/catalog", "Name and a valid price are required.", "error");
    }
    const typeUpper = (body.type ?? "").toUpperCase();
    if (!PRODUCT_TYPES.includes(typeUpper)) {
      return redirectWithFlash(reply, "/catalog", "Invalid product type.", "error");
    }
    let warranty: number | null = null;
    if ((body.warranty_days ?? "").trim()) {
      const n = Number(body.warranty_days);
      if (!Number.isInteger(n)) {
        return redirectWithFlash(reply, "/catalog", "Warranty days must be a number.", "error");
      }
      warranty = n;
    }
    const product = await createProduct(prisma, {
      categoryId: Number(body.category_id),
      name,
      description: (body.description ?? "").trim() || null,
      type: typeUpper as ProductType,
      durationLabel: (body.duration_label ?? "").trim(),
      price: priceDec,
      resellerPrice: dec(body.reseller_price),
      warrantyDays: warranty,
      imageFileId: (body.image_file_id ?? "").trim() || null,
      webImageUrl: (body.web_image_url ?? "").trim() || null,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_create",
      targetType: "product",
      targetId: product.id,
      details: `name=${name}`,
    });
    return redirectWithFlash(reply, "/catalog", `Product '${name}' created.`, "success");
  });

  app.post("/catalog/product/:productId/update", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const body = (req.body ?? {}) as Record<string, string>;
    const name = (body.name ?? "").trim();
    const priceDec = dec(body.price);
    if (!name || priceDec === null) {
      return redirectWithFlash(reply, "/catalog", "Name and a valid price are required.", "error");
    }
    const fields: Record<string, unknown> = {
      name,
      description: (body.description ?? "").trim() || null,
      durationLabel: (body.duration_label ?? "").trim(),
      price: priceDec,
      resellerPrice: dec(body.reseller_price),
      imageFileId: (body.image_file_id ?? "").trim() || null,
      webImageUrl: (body.web_image_url ?? "").trim() || null,
      isActive: truthy(body.is_active),
    };
    if ((body.warranty_days ?? "").trim()) {
      const n = Number(body.warranty_days);
      if (!Number.isInteger(n)) {
        return redirectWithFlash(reply, "/catalog", "Warranty days must be a number.", "error");
      }
      fields.warrantyDays = n;
    }
    await updateProduct(prisma, productId, fields);

    // Group membership is edited inline on the product. Only act when the field
    // is present, so an old form (no group select) never clears membership.
    if (body.product_group_id !== undefined) {
      const raw = body.product_group_id.trim();
      const groupId = raw === "" ? null : Number(raw);
      if (groupId !== null && !Number.isInteger(groupId)) {
        return redirectWithFlash(reply, "/catalog", "Invalid group.", "error");
      }
      try {
        await assignProductToGroup(prisma, productId, groupId);
      } catch (err) {
        if (err instanceof CategoryMismatchError) {
          return redirectWithFlash(reply, "/catalog", "Produk harus satu kategori dengan grup.", "error");
        }
        throw err;
      }
    }

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_update",
      targetType: "product",
      targetId: productId,
      details: `name=${name}`,
    });
    return redirectWithFlash(reply, "/catalog", "Product updated.", "success");
  });

  // ---- Product photo upload ----
  // Accepts multipart/form-data so CSRF is checked manually (formbody doesn't
  // parse multipart); the role gate (catalog = super-only) is done inline.
  app.post<{ Params: { productId: string } }>(
    "/catalog/product/:productId/photo",
    { preHandler: currentAdmin },
    async (req, reply) => {
      if (!canMutate(req.admin!.role, req.url)) {
        return reply.code(403).type("text/plain").send("Insufficient permissions for this action.");
      }

      const productId = Number(req.params.productId);
      if (!Number.isInteger(productId) || productId <= 0) {
        return redirectWithFlash(reply, "/catalog", "Invalid product.", "error");
      }

      const ALLOWED_MIME: Record<string, string> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
      };

      let csrfField: string | null = null;
      let fileBuffer: Buffer | null = null;
      let mimetype = "";

      for await (const part of req.parts({ limits: { fileSize: 5 * 1024 * 1024 } })) {
        if (part.type === "field" && part.fieldname === "csrf_token") {
          csrfField = part.value as string;
        } else if (part.type === "file" && part.fieldname === "photo") {
          mimetype = part.mimetype;
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(chunk);
          if (chunks.length > 0) fileBuffer = Buffer.concat(chunks);
        }
      }

      if (!csrfField || csrfField !== req.admin!.csrf) {
        return reply.code(403).type("text/plain").send("CSRF check failed");
      }
      if (!fileBuffer || fileBuffer.length === 0) {
        return redirectWithFlash(reply, "/catalog", "No file selected.", "error");
      }
      const ext = ALLOWED_MIME[mimetype];
      if (!ext) {
        return redirectWithFlash(reply, "/catalog", "Only JPG, PNG, or WebP images are allowed.", "error");
      }

      const product = await getProduct(prisma, productId);
      if (!product) {
        return redirectWithFlash(reply, "/catalog", "Product not found.", "error");
      }

      const filename = `${productId}-${randomBytes(8).toString("hex")}.${ext}`;
      const uploadsDir = join(UPLOADS_DIR, "products");
      await mkdir(uploadsDir, { recursive: true });
      await writeFile(join(uploadsDir, filename), fileBuffer);

      // Remove the old local upload when replacing it. webImageUrl is "/uploads/…"
      // so strip the prefix and re-anchor under UPLOADS_DIR.
      if (product.webImageUrl?.startsWith("/uploads/")) {
        await unlink(join(UPLOADS_DIR, product.webImageUrl.replace(/^\/uploads\//, ""))).catch(() => undefined);
      }

      await updateProduct(prisma, productId, { webImageUrl: `/uploads/products/${filename}` });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "product_photo_upload",
        targetType: "product",
        targetId: productId,
        details: `filename=${filename}`,
      });
      return redirectWithFlash(reply, "/catalog", "Photo uploaded.", "success");
    },
  );

  // ---- Bulk pricing ----
  app.post("/catalog/product/:productId/bulk-pricing", { preHandler: csrfProtect }, async (req, reply) => {
    const productId = Number((req.params as { productId: string }).productId);
    const body = (req.body ?? {}) as Record<string, string>;

    if (!(body.min_quantity ?? "").trim()) {
      const removed = await deleteBulkPricing(prisma, productId);
      if (removed) {
        await logAdminAction(prisma, {
          adminId: req.admin!.userId,
          action: "bulk_pricing_delete",
          targetType: "product",
          targetId: productId,
        });
      }
      return redirectWithFlash(reply, "/catalog", "Bulk pricing removed.", "success");
    }

    const minq = Number(body.min_quantity);
    if (!Number.isInteger(minq)) {
      return redirectWithFlash(reply, "/catalog", "Min quantity must be a number.", "error");
    }
    const pct = dec(body.discount_percent);
    if (minq < 1 || pct === null || pct.lessThanOrEqualTo(0)) {
      return redirectWithFlash(reply, "/catalog", "Provide a valid min qty and discount %.", "error");
    }
    // verify product exists for a clean FK error message
    if (!(await getProduct(prisma, productId))) {
      return redirectWithFlash(reply, "/catalog", "Product not found.", "error");
    }
    await upsertBulkPricing(prisma, { productId, minQuantity: minq, discountPercent: pct });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "bulk_pricing_set",
      targetType: "product",
      targetId: productId,
      details: `min_qty=${minq} pct=${pct.toString()}`,
    });
    return redirectWithFlash(reply, "/catalog", "Bulk pricing saved.", "success");
  });

  // ---- Product groups (denominations) ----
  app.post("/catalog/group", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const name = (body.name ?? "").trim();
    const categoryId = Number(body.category_id);
    if (!name || !Number.isInteger(categoryId) || categoryId <= 0) {
      return redirectWithFlash(reply, "/catalog", "Group name and category are required.", "error");
    }
    const group = await createGroup(prisma, {
      categoryId,
      name,
      emoji: (body.emoji ?? "").trim() || null,
      description: (body.description ?? "").trim() || null,
      webImageUrl: (body.web_image_url ?? "").trim() || null,
      sortOrder: Number(body.sort_order) || 0,
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "group_create",
      targetType: "product_group",
      targetId: group.id,
      details: `name=${name}`,
    });
    return redirectWithFlash(reply, "/catalog", `Group '${name}' created.`, "success");
  });

  app.post("/catalog/group/:groupId/update", { preHandler: csrfProtect }, async (req, reply) => {
    const groupId = Number((req.params as { groupId: string }).groupId);
    const body = (req.body ?? {}) as Record<string, string>;
    const name = (body.name ?? "").trim();
    if (!name) return redirectWithFlash(reply, "/catalog", "Group name is required.", "error");
    await updateGroup(prisma, groupId, {
      name,
      emoji: (body.emoji ?? "").trim() || null,
      description: (body.description ?? "").trim() || null,
      webImageUrl: (body.web_image_url ?? "").trim() || null,
      sortOrder: Number(body.sort_order) || 0,
      isActive: truthy(body.is_active),
    });
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "group_update",
      targetType: "product_group",
      targetId: groupId,
      details: `name=${name}`,
    });
    return redirectWithFlash(reply, "/catalog", "Group updated.", "success");
  });

  app.post("/catalog/group/:groupId/delete", { preHandler: csrfProtect }, async (req, reply) => {
    const groupId = Number((req.params as { groupId: string }).groupId);
    await deleteGroup(prisma, groupId);
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "group_delete",
      targetType: "product_group",
      targetId: groupId,
    });
    return redirectWithFlash(reply, "/catalog", "Group deleted (products kept).", "success");
  });
}
