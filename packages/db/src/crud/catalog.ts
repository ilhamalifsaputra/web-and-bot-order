/**
 * Catalog domain — categories, products, bulk pricing. Port of the "Catalog"
 * and "Bulk pricing" sections of Python crud.py.
 */
import { config } from "@app/core/config";
import { ProductType, StockStatus } from "@app/core/enums";
import { quantizeMoney } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import type { Db } from "./_types";

// ---- Categories ----

export function listActiveCategories(db: Db) {
  return db.category.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export function listAllCategories(db: Db) {
  return db.category.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export function createCategory(
  db: Db,
  name: string,
  emoji: string | null = null,
  sortOrder = 0,
) {
  return db.category.create({ data: { name, emoji, sortOrder } });
}

export async function updateCategory(
  db: Db,
  categoryId: number,
  fields: Record<string, unknown>,
) {
  if (Object.keys(fields).length === 0) return;
  await db.category.update({ where: { id: categoryId }, data: fields });
}

export async function countProductsInCategory(db: Db, categoryId: number) {
  return db.product.count({ where: { categoryId } });
}

// ---- Products ----

export function listActiveProducts(db: Db, categoryId: number) {
  return db.product.findMany({
    where: { categoryId, isActive: true },
    orderBy: { name: "asc" },
  });
}

export function listAllActiveProducts(db: Db) {
  return db.product.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
}

/** Every product (active + inactive) with its category — admin views. */
export function listAllProducts(db: Db) {
  return db.product.findMany({
    include: { category: true },
    orderBy: { name: "asc" },
  });
}

export function getProduct(db: Db, productId: number) {
  return db.product.findUnique({ where: { id: productId } });
}

export function createProduct(
  db: Db,
  args: {
    categoryId: number;
    name: string;
    description: string | null;
    type: ProductType;
    durationLabel: string;
    price: Decimal.Value;
    resellerPrice?: Decimal.Value | null;
    warrantyDays?: number | null;
    imageFileId?: string | null;
  },
) {
  return db.product.create({
    data: {
      categoryId: args.categoryId,
      name: args.name,
      description: args.description,
      type: args.type,
      durationLabel: args.durationLabel,
      price: quantizeMoney(args.price, 4),
      resellerPrice:
        args.resellerPrice != null ? quantizeMoney(args.resellerPrice, 4) : null,
      warrantyDays: args.warrantyDays || config.DEFAULT_WARRANTY_DAYS,
      imageFileId: args.imageFileId ?? null,
    },
  });
}

export async function updateProduct(
  db: Db,
  productId: number,
  fields: Record<string, unknown>,
) {
  if (Object.keys(fields).length === 0) return;
  await db.product.update({ where: { id: productId }, data: fields });
}

/** Search active products by name/description (case-insensitive LIKE). */
export function searchProducts(db: Db, query: string, limit = 20) {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  return db.product.findMany({
    where: {
      isActive: true,
      OR: [{ name: { contains: q } }, { description: { contains: q } }],
    },
    take: limit,
  });
}

// ---- Bulk pricing ----

export async function upsertBulkPricing(
  db: Db,
  args: { productId: number; minQuantity: number; discountPercent: Decimal.Value },
) {
  const discountPercent = quantizeMoney(args.discountPercent, 2);
  const existing = await db.bulkPricing.findUnique({
    where: { productId: args.productId },
  });
  if (existing) {
    return db.bulkPricing.update({
      where: { productId: args.productId },
      data: { minQuantity: args.minQuantity, discountPercent, isActive: true },
    });
  }
  return db.bulkPricing.create({
    data: {
      productId: args.productId,
      minQuantity: args.minQuantity,
      discountPercent,
    },
  });
}

export function getBulkPricingForProduct(db: Db, productId: number) {
  return db.bulkPricing.findFirst({ where: { productId, isActive: true } });
}

export async function deleteBulkPricing(db: Db, productId: number): Promise<boolean> {
  const existing = await db.bulkPricing.findUnique({ where: { productId } });
  if (!existing) return false;
  await db.bulkPricing.delete({ where: { productId } });
  return true;
}

export function listBulkPricingRules(db: Db) {
  return db.bulkPricing.findMany({
    include: { product: true },
    orderBy: { productId: "asc" },
  });
}

// ---- low stock report (kept here since it's product-centric) ----

/** (product, availableCount) for active products at/below threshold. */
export async function lowStockProducts(
  db: Db,
  threshold: number,
): Promise<Array<{ product: Awaited<ReturnType<typeof getProduct>>; available: number }>> {
  const products = await db.product.findMany({ where: { isActive: true } });
  const counts = await db.stockItem.groupBy({
    by: ["productId"],
    where: { status: StockStatus.AVAILABLE },
    _count: { id: true },
  });
  const map = new Map<number, number>();
  for (const c of counts) map.set(c.productId, c._count.id);
  const result = products
    .map((p) => ({ product: p, available: map.get(p.id) ?? 0 }))
    .filter((r) => r.available <= threshold)
    .sort((a, b) => a.available - b.available);
  return result;
}
