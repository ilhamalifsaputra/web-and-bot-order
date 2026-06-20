/**
 * Catalog domain — the 3-tier catalog Category → Product → Denomination.
 *
 * - Category: top-level grouping (storefront `/c/:slug`).
 * - Product (mid-tier): the customer-facing item (e.g. "CapCut Pro"); image,
 *   description and navigation only — NO price, NO stock.
 * - Denomination (leaf / SKU): the sellable unit (e.g. "1 Month"); price, cost,
 *   stock and auto-delivery all live here. Physically the old `products` table.
 *
 * Pre-rename, "Product" meant the SKU; that shape is now Denomination. The
 * mid-tier CRUD below still uses transitional `*CatalogProduct` names (e.g.
 * `createCatalogProduct`) — the old SKU-named `@deprecated` shims that used to
 * adapt these to legacy callers were removed in Phase 5 once every consumer
 * migrated to the Category/Product/Denomination names directly.
 */
import { config } from "@app/core/config";
import { OrderStatus, ProductType, StockStatus } from "@app/core/enums";
import { quantizeMoney } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import type { Category, Denomination, Product } from "@prisma/client";
import type { PrismaClient } from "../client";
import type { Db } from "./_types";
import { slugify } from "../migrate/slug";

// ---- Slugs ----

export { slugify };

type SlugKind = "category" | "product" | "denomination";

async function slugExists(db: Db, kind: SlugKind, slug: string): Promise<boolean> {
  if (kind === "category") return (await db.category.findUnique({ where: { slug }, select: { id: true } })) != null;
  if (kind === "product") return (await db.product.findUnique({ where: { slug }, select: { id: true } })) != null;
  return (await db.denomination.findUnique({ where: { slug }, select: { id: true } })) != null;
}

/** A unique slug for `name`, deduped with a numeric suffix on collision. */
export async function ensureUniqueSlug(db: Db, kind: SlugKind, name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  for (let n = 2; await slugExists(db, kind, candidate); n++) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}

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

export async function createCategory(
  db: Db,
  args:
    | string
    | {
        name: string;
        emoji?: string | null;
        description?: string | null;
        image?: string | null;
        sortOrder?: number;
      },
  emojiLegacy: string | null = null,
  sortOrderLegacy = 0,
) {
  // Back-compat: createCategory(db, name, emoji?, sortOrder?) still works.
  const a = typeof args === "string"
    ? { name: args, emoji: emojiLegacy, sortOrder: sortOrderLegacy }
    : args;
  const slug = await ensureUniqueSlug(db, "category", a.name);
  return db.category.create({
    data: {
      name: a.name,
      slug,
      emoji: a.emoji ?? null,
      description: ("description" in a ? a.description : null) ?? null,
      image: ("image" in a ? a.image : null) ?? null,
      sortOrder: a.sortOrder ?? 0,
    },
  });
}

export async function updateCategory(db: Db, categoryId: number, fields: Record<string, unknown>) {
  if (Object.keys(fields).length === 0) return;
  await db.category.update({ where: { id: categoryId }, data: fields });
}

export function getCategory(db: Db, categoryId: number) {
  return db.category.findUnique({ where: { id: categoryId } });
}

export function getCategoryBySlug(db: Db, slug: string) {
  return db.category.findUnique({ where: { slug } });
}

/** Number of Products (mid-tier) in a category. */
export async function countProductsInCategory(db: Db, categoryId: number) {
  return db.product.count({ where: { categoryId } });
}

// ---- Products (mid-tier) ----
// Transitional `*CatalogProduct` names; renamed to `*Product` in Phase 5.

/** Thrown when assigning a denomination to a product in a different category. */
export class CategoryMismatchError extends Error {
  constructor() {
    super("denomination and product must share the same category");
    this.name = "CategoryMismatchError";
  }
}

export async function createCatalogProduct(
  db: Db,
  args: {
    categoryId: number;
    name: string;
    emoji?: string | null;
    description?: string | null;
    webImageUrl?: string | null;
    imageFileId?: string | null;
    sortOrder?: number;
    isActive?: boolean;
  },
) {
  const slug = await ensureUniqueSlug(db, "product", args.name);
  return db.product.create({
    data: {
      categoryId: args.categoryId,
      name: args.name,
      slug,
      emoji: args.emoji ?? null,
      description: args.description ?? null,
      webImageUrl: args.webImageUrl ?? null,
      imageFileId: args.imageFileId ?? null,
      sortOrder: args.sortOrder ?? 0,
      isActive: args.isActive ?? true,
    },
  });
}

export async function updateCatalogProduct(db: Db, productId: number, fields: Record<string, unknown>) {
  if (Object.keys(fields).length === 0) return;
  await db.product.update({ where: { id: productId }, data: fields });
}

export function getCatalogProduct(db: Db, productId: number) {
  return db.product.findUnique({ where: { id: productId } });
}

export function getCatalogProductBySlug(db: Db, slug: string) {
  return db.product.findUnique({ where: { slug } });
}

/** A product with its denominations (price asc) + category — admin detail page. */
export function getCatalogProductWithDenominations(db: Db, productId: number) {
  return db.product.findUnique({
    where: { id: productId },
    include: {
      category: true,
      denominations: { orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
    },
  });
}

/** A product by slug with its ACTIVE denominations (price asc) — storefront. */
export function getCatalogProductBySlugWithDenominations(db: Db, slug: string) {
  return db.product.findUnique({
    where: { slug },
    include: {
      category: true,
      denominations: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
    },
  });
}

/** Every product (active + inactive) with category + denomination count — admin. */
export function listProducts(db: Db, categoryId?: number) {
  return db.product.findMany({
    where: categoryId != null ? { categoryId } : {},
    include: { category: true, _count: { select: { denominations: true } } },
    orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
}

/** Bulk activate/deactivate products (mid-tier) in one writer. Returns count updated. */
export async function bulkSetCatalogProductsActive(db: Db, ids: number[], isActive: boolean): Promise<number> {
  if (!ids.length) return 0;
  const res = await db.product.updateMany({ where: { id: { in: ids } }, data: { isActive } });
  return res.count;
}

/** Refuse to delete a product that still has denominations (use the cascade path). */
export async function deleteCatalogProduct(db: Db, productId: number): Promise<void> {
  const count = await db.denomination.count({ where: { productId } });
  if (count > 0) {
    throw new Error("product not empty: move or delete its denominations first");
  }
  await db.product.delete({ where: { id: productId } });
}

/** Explicit cascade: delete a product and all its denominations. */
export async function deleteCatalogProductCascade(db: PrismaClient, productId: number): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.denomination.deleteMany({ where: { productId } });
    await tx.product.delete({ where: { id: productId } });
  });
}

/** Move a denomination under another product in the same category. */
export async function assignDenominationToProduct(
  db: Db,
  denominationId: number,
  productId: number,
): Promise<void> {
  const [denom, product] = await Promise.all([
    db.denomination.findUnique({ where: { id: denominationId }, include: { product: true } }),
    db.product.findUnique({ where: { id: productId } }),
  ]);
  if (!denom || !product) throw new Error("denomination or product not found");
  if (denom.product.categoryId !== product.categoryId) throw new CategoryMismatchError();
  await db.denomination.update({ where: { id: denominationId }, data: { productId } });
}

// ---- Denominations (leaf / SKU) ----

export async function createDenomination(
  db: Db,
  args: {
    productId: number;
    name: string;
    type: ProductType | string;
    durationLabel: string;
    price: Decimal.Value;
    costPrice?: Decimal.Value | null;
    resellerPrice?: Decimal.Value | null;
    autoDeliverySource?: string | null;
    warrantyDays?: number | null;
    description?: string | null;
    imageFileId?: string | null;
    webImageUrl?: string | null;
    sortOrder?: number;
    isActive?: boolean;
  },
) {
  const slug = await ensureUniqueSlug(db, "denomination", args.name);
  return db.denomination.create({
    data: {
      productId: args.productId,
      name: args.name,
      slug,
      type: args.type,
      durationLabel: args.durationLabel,
      price: quantizeMoney(args.price, 4),
      costPrice: args.costPrice != null ? quantizeMoney(args.costPrice, 4) : null,
      resellerPrice: args.resellerPrice != null ? quantizeMoney(args.resellerPrice, 4) : null,
      autoDeliverySource: args.autoDeliverySource ?? null,
      warrantyDays: args.warrantyDays || config.DEFAULT_WARRANTY_DAYS,
      description: args.description ?? null,
      imageFileId: args.imageFileId ?? null,
      webImageUrl: args.webImageUrl ?? null,
      sortOrder: args.sortOrder ?? 0,
      isActive: args.isActive ?? true,
    },
  });
}

export async function updateDenomination(db: Db, denominationId: number, fields: Record<string, unknown>) {
  if (Object.keys(fields).length === 0) return;
  await db.denomination.update({ where: { id: denominationId }, data: fields });
}

export function getDenomination(db: Db, denominationId: number) {
  return db.denomination.findUnique({ where: { id: denominationId } });
}

export function getDenominationBySlug(db: Db, slug: string) {
  return db.denomination.findUnique({ where: { slug } });
}

/** A denomination with its parent product + category joined. */
export function getDenominationWithProduct(db: Db, denominationId: number) {
  return db.denomination.findUnique({
    where: { id: denominationId },
    include: { product: { include: { category: true } } },
  });
}

export function getDenominationsByIds(db: Db, ids: number[]) {
  if (!ids.length) return Promise.resolve([]);
  return db.denomination.findMany({ where: { id: { in: ids } } });
}

/** Every denomination (active + inactive) with parent product + category. */
export function listAllDenominations(db: Db) {
  return db.denomination.findMany({
    include: { product: { include: { category: true } } },
    orderBy: { name: "asc" },
  });
}

/** Search active denominations by name/description (case-insensitive LIKE). */
export function searchDenominations(db: Db, query: string, limit = 20) {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  return db.denomination.findMany({
    where: { isActive: true, OR: [{ name: { contains: q } }, { description: { contains: q } }] },
    take: limit,
  });
}

/** Bulk activate/deactivate denominations in one writer. Returns count updated. */
export async function bulkSetDenominationsActive(db: Db, ids: number[], isActive: boolean): Promise<number> {
  if (!ids.length) return 0;
  const res = await db.denomination.updateMany({ where: { id: { in: ids } }, data: { isActive } });
  return res.count;
}

/**
 * Apply pre-computed new prices to denominations. Each item is {id, price}
 * already validated by the caller. No commit here — wrap in the caller's
 * `prisma.$transaction`. Returns the count updated.
 */
export async function bulkSetPrices(db: Db, items: Array<{ id: number; price: string }>): Promise<number> {
  for (const it of items) {
    await db.denomination.update({ where: { id: it.id }, data: { price: it.price } });
  }
  return items.length;
}

/**
 * Delete a denomination (and its stock/cart/review/bulk-pricing rows, which
 * cascade at the DB level). Refuses when it has order history — those rows
 * (`order_items`) do NOT cascade, so the financial record stays intact.
 */
export async function deleteDenomination(db: Db, denominationId: number): Promise<void> {
  const orderCount = await db.orderItem.count({ where: { productId: denominationId } });
  if (orderCount > 0) {
    throw new Error("cannot delete a denomination with order history");
  }
  await db.denomination.delete({ where: { id: denominationId } });
}

/** (denomination, availableCount) for active denominations at/below threshold. */
export async function lowStockDenominations(
  db: Db,
  threshold: number,
): Promise<Array<{ denomination: Denomination; available: number }>> {
  const denoms = await db.denomination.findMany({ where: { isActive: true } });
  const counts = await db.stockItem.groupBy({
    by: ["productId"],
    where: { status: StockStatus.AVAILABLE },
    _count: { id: true },
  });
  const map = new Map<number, number>();
  for (const c of counts) map.set(c.productId, c._count.id);
  return denoms
    .map((d) => ({ denomination: d, available: map.get(d.id) ?? 0 }))
    .filter((r) => r.available <= threshold)
    .sort((a, b) => a.available - b.available);
}

// ---- Catalog browse (Product-centric, the new customer surface) ----

/** A product with its active denominations (price asc) — one storefront card. */
export type CatalogProduct = Product & {
  category: Category;
  denominations: Denomination[];
};

/**
 * Active products (with ≥1 active denomination) in a category — or the whole
 * catalog when categoryId is omitted. Each carries its active denominations
 * price-asc so a card can show the starting price. Ordered by sortOrder, name.
 */
export function listCatalogProducts(db: Db, categoryId?: number): Promise<CatalogProduct[]> {
  return db.product.findMany({
    where: {
      isActive: true,
      ...(categoryId != null ? { categoryId } : {}),
      denominations: { some: { isActive: true, price: { gt: 0 } } },
    },
    include: {
      category: true,
      denominations: { where: { isActive: true, price: { gt: 0 } }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

/** Newest active products (by newest active denomination) for the home grid. */
export async function listNewestCatalogProducts(db: Db, limit = 12): Promise<CatalogProduct[]> {
  const products = await db.product.findMany({
    where: { isActive: true, denominations: { some: { isActive: true, price: { gt: 0 } } } },
    include: {
      category: true,
      denominations: { where: { isActive: true, price: { gt: 0 } }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
    },
  });
  const recency = (p: CatalogProduct) =>
    Math.max(p.createdAt.getTime(), ...p.denominations.map((d) => d.createdAt.getTime()));
  return products.sort((a, b) => recency(b) - recency(a)).slice(0, limit);
}

/**
 * Search products by name/description (products only — variants are chosen in
 * product detail). Returns active products with ≥1 active denomination, each
 * with its active denominations price-asc. Sorted by name, capped at `limit`.
 */
export function searchCatalog(db: Db, query: string, limit = 24): Promise<CatalogProduct[]> {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  return db.product.findMany({
    where: {
      isActive: true,
      denominations: { some: { isActive: true, price: { gt: 0 } } },
      OR: [{ name: { contains: q } }, { description: { contains: q } }],
    },
    include: {
      category: true,
      denominations: { where: { isActive: true, price: { gt: 0 } }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
    },
    orderBy: { name: "asc" },
    take: limit,
  });
}

// ---- Bulk pricing (keyed by denomination) ----

export async function upsertBulkPricing(
  db: Db,
  args: { denominationId?: number; productId?: number; minQuantity: number; discountPercent: Decimal.Value },
) {
  const denominationId = args.denominationId ?? args.productId!;
  const discountPercent = quantizeMoney(args.discountPercent, 2);
  const existing = await db.bulkPricing.findUnique({ where: { productId: denominationId } });
  if (existing) {
    return db.bulkPricing.update({
      where: { productId: denominationId },
      data: { minQuantity: args.minQuantity, discountPercent, isActive: true },
    });
  }
  return db.bulkPricing.create({
    data: { productId: denominationId, minQuantity: args.minQuantity, discountPercent },
  });
}

export function getBulkPricingForDenomination(db: Db, denominationId: number) {
  return db.bulkPricing.findFirst({ where: { productId: denominationId, isActive: true } });
}

export async function deleteBulkPricing(db: Db, denominationId: number): Promise<boolean> {
  const existing = await db.bulkPricing.findUnique({ where: { productId: denominationId } });
  if (!existing) return false;
  await db.bulkPricing.delete({ where: { productId: denominationId } });
  return true;
}

export function listBulkPricingRules(db: Db) {
  // `product` resolves to a Denomination (the SKU the rule applies to).
  return db.bulkPricing.findMany({ include: { product: true }, orderBy: { productId: "asc" } });
}

/**
 * Active quantity-discount rules keyed by denomination id, so catalog grids can
 * show a "buy N+, save X%" badge without an N+1 query per card.
 */
export async function activeBulkPricingByDenomination(
  db: Db,
): Promise<Record<number, { minQuantity: number; discountPercent: string }>> {
  const rules = await db.bulkPricing.findMany({ where: { isActive: true } });
  const out: Record<number, { minQuantity: number; discountPercent: string }> = {};
  for (const r of rules) {
    out[r.productId] = { minQuantity: r.minQuantity, discountPercent: r.discountPercent.toString() };
  }
  return out;
}

// ---- Sold-count aggregates (§4.2) — Produk Populer screen ----

/**
 * Top-selling Products (mid-tier) by units delivered, summed across each
 * product's active denominations. Drops zero-sale products (a "Populer" list
 * has nothing to say about something nobody bought) and caps to `limit`.
 *
 * Queries `orderItem.groupBy` directly (mirrors `soldCountsByDenomination` in
 * `./orders`) instead of importing it — `orders.ts` already imports from
 * `./catalog` (`getBulkPricingForDenomination`), so catalog → orders would be
 * circular.
 */
export async function soldCountsByProduct(
  db: Db,
  limit = 10,
): Promise<Array<{ product: Product; sold: number }>> {
  const products = await listCatalogProducts(db);
  if (!products.length) return [];

  const denominationIds = products.flatMap((p) => p.denominations.map((d) => d.id));
  if (!denominationIds.length) return [];

  const rows = await db.orderItem.groupBy({
    by: ["productId"],
    where: { productId: { in: denominationIds }, order: { status: OrderStatus.DELIVERED } },
    _sum: { quantity: true },
  });
  const soldByDenomination = new Map<number, number>();
  for (const r of rows) {
    const sum = r._sum.quantity ?? 0;
    if (sum > 0) soldByDenomination.set(r.productId, sum);
  }

  return products
    .map((p) => ({
      product: p as Product,
      sold: p.denominations.reduce((acc, d) => acc + (soldByDenomination.get(d.id) ?? 0), 0),
    }))
    .filter((r) => r.sold > 0)
    .sort((a, b) => b.sold - a.sold)
    .slice(0, limit);
}
