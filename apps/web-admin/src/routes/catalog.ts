/**
 * Catalog — categories, products, per-product bulk pricing. Port of
 * routers/catalog.py.
 */
import type { FastifyInstance } from "fastify";
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
  getProduct,
  deleteBulkPricing,
  upsertBulkPricing,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../plugins/auth";
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

const PRODUCT_TYPES = Object.values(ProductType) as string[];

export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get("/catalog", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const categories = await listAllCategories(prisma);
    const products = await listAllProducts(prisma);
    const rules = await listBulkPricingRules(prisma);

    const rulesByProduct: Record<number, (typeof rules)[number]> = {};
    for (const r of rules) rulesByProduct[r.productId] = r;

    return reply.view("catalog.njk", {
      admin: req.admin,
      active_nav: "/catalog",
      categories,
      products,
      rules_by_product: rulesByProduct,
      product_types: PRODUCT_TYPES,
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
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "product_update",
      targetType: "product",
      targetId: productId,
      details: `name=${name}`,
    });
    return redirectWithFlash(reply, "/catalog", "Product updated.", "success");
  });

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
}
