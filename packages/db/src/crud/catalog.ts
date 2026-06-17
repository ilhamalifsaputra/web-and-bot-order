/**
 * Catalog domain — categories, products, bulk pricing. Port of the "Catalog"
 * and "Bulk pricing" sections of Python crud.py.
 */
import { config } from "@app/core/config";
import { ProductType, StockStatus } from "@app/core/enums";
import { quantizeMoney } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import type { Category, Product, ProductGroup } from "@prisma/client";
import type { PrismaClient } from "../client";
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

/** Newest active products with category — storefront home "Terbaru" grid. */
export function listNewestActiveProducts(db: Db, limit = 12) {
  return db.product.findMany({
    where: { isActive: true },
    include: { category: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Active products in a category with the category joined (storefront list). */
export function listActiveProductsWithCategory(db: Db, categoryId: number) {
  return db.product.findMany({
    where: { categoryId, isActive: true },
    include: { category: true },
    orderBy: { name: "asc" },
  });
}

/** Active-product search with category joined (storefront /search). */
export function searchProductsWithCategory(db: Db, query: string, limit = 24) {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  return db.product.findMany({
    where: {
      isActive: true,
      OR: [{ name: { contains: q } }, { description: { contains: q } }],
    },
    include: { category: true },
    take: limit,
  });
}

export function getCategory(db: Db, categoryId: number) {
  return db.category.findUnique({ where: { id: categoryId } });
}

export function getProductWithCategory(db: Db, productId: number) {
  return db.product.findUnique({
    where: { id: productId },
    include: { category: true },
  });
}

/** Every product (active + inactive) with its category — admin views. */
export function listAllProducts(db: Db) {
  return db.product.findMany({
    include: { category: true },
    orderBy: { name: "asc" },
  });
}

/** Products for a set of ids (order not guaranteed). Used by bulk-edit previews. */
export function getProductsByIds(db: Db, ids: number[]) {
  if (!ids.length) return Promise.resolve([]);
  return db.product.findMany({ where: { id: { in: ids } } });
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
    webImageUrl?: string | null;
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
      webImageUrl: args.webImageUrl ?? null,
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

/** Bulk activate/deactivate products in one writer. Returns the count updated. */
export async function bulkSetProductsActive(
  db: Db,
  ids: number[],
  isActive: boolean,
): Promise<number> {
  if (!ids.length) return 0;
  const res = await db.product.updateMany({
    where: { id: { in: ids } },
    data: { isActive },
  });
  return res.count;
}

/**
 * Apply pre-computed new prices to products. Each item is {id, price} already
 * validated by the caller. No commit here (per crud convention) — wrap in the
 * caller's `prisma.$transaction(tx => bulkSetPrices(tx, items))` for atomicity.
 * Returns the count updated. (Prices are money — the web flow previews first.)
 */
export async function bulkSetPrices(
  db: Db,
  items: Array<{ id: number; price: string }>,
): Promise<number> {
  for (const it of items) {
    await db.product.update({ where: { id: it.id }, data: { price: it.price } });
  }
  return items.length;
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

/**
 * All active quantity-discount rules keyed by product id, so catalog grids can
 * show a "buy N+, save X%" badge without an N+1 query per card. Products with
 * no rule are simply absent from the map.
 */
export async function activeBulkPricingByProduct(
  db: Db,
): Promise<Record<number, { minQuantity: number; discountPercent: string }>> {
  const rules = await db.bulkPricing.findMany({ where: { isActive: true } });
  const out: Record<number, { minQuantity: number; discountPercent: string }> = {};
  for (const r of rules) {
    out[r.productId] = { minQuantity: r.minQuantity, discountPercent: r.discountPercent.toString() };
  }
  return out;
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

// ---- Product groups (denominations) ----

/** Discriminated catalog row used by every customer surface. */
export type CatalogEntry =
  | { kind: "group"; group: ProductGroup; members: Product[] }
  | { kind: "product"; product: Product };

/** Thrown when assigning a product to a group in a different category. */
export class CategoryMismatchError extends Error {
  constructor() {
    super("product and group must share the same category");
    this.name = "CategoryMismatchError";
  }
}

export function createGroup(
  db: Db,
  args: {
    categoryId: number;
    name: string;
    emoji?: string | null;
    description?: string | null;
    webImageUrl?: string | null;
    imageFileId?: string | null;
    sortOrder?: number;
  },
) {
  return db.productGroup.create({
    data: {
      categoryId: args.categoryId,
      name: args.name,
      emoji: args.emoji ?? null,
      description: args.description ?? null,
      webImageUrl: args.webImageUrl ?? null,
      imageFileId: args.imageFileId ?? null,
      sortOrder: args.sortOrder ?? 0,
    },
  });
}

export async function updateGroup(db: Db, groupId: number, fields: Record<string, unknown>) {
  if (Object.keys(fields).length === 0) return;
  await db.productGroup.update({ where: { id: groupId }, data: fields });
}

/** Delete a group, unlinking its members first (products survive). */
export async function deleteGroup(db: PrismaClient, groupId: number): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.product.updateMany({ where: { productGroupId: groupId }, data: { productGroupId: null } });
    await tx.productGroup.delete({ where: { id: groupId } });
  });
}

/**
 * Link a product to a group (or unlink when groupId is null). Enforces the
 * invariant that a grouped product shares the group's category.
 */
export async function assignProductToGroup(
  db: Db,
  productId: number,
  groupId: number | null,
): Promise<void> {
  if (groupId !== null) {
    const [product, group] = await Promise.all([
      db.product.findUnique({ where: { id: productId } }),
      db.productGroup.findUnique({ where: { id: groupId } }),
    ]);
    if (!product || !group) throw new Error("product or group not found");
    if (product.categoryId !== group.categoryId) throw new CategoryMismatchError();
  }
  await db.product.update({ where: { id: productId }, data: { productGroupId: groupId } });
}

/** All groups (active + inactive) with category + member count — admin list. */
export function listAllGroups(db: Db) {
  return db.productGroup.findMany({
    include: { category: true, _count: { select: { products: true } } },
    orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
}

/** A group with its active members ordered by price asc (denomination picker). */
export function getGroupWithActiveProducts(db: Db, groupId: number) {
  return db.productGroup.findUnique({
    where: { id: groupId },
    include: { products: { where: { isActive: true }, orderBy: { price: "asc" } } },
  });
}

/**
 * Mixed, ordered catalog rows for a category (or the whole catalog when
 * categoryId is omitted). Rules:
 *  - active groups with >=1 active member; empty/inactive groups dropped
 *  - a group with exactly one active member is emitted as that product (collapse)
 *  - active products with no group (or in an inactive group) are emitted as products
 * Final order: by display name, case-insensitive ascending (group.name / product.name).
 */
export async function listCatalogEntries(db: Db, categoryId?: number): Promise<CatalogEntry[]> {
  const groups = await db.productGroup.findMany({
    where: { isActive: true, ...(categoryId != null ? { categoryId } : {}) },
    include: { products: { where: { isActive: true }, orderBy: { price: "asc" } } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  const groupedIds = new Set<number>();
  const entries: CatalogEntry[] = [];
  for (const g of groups) {
    const { products: members, ...group } = g;
    for (const m of members) groupedIds.add(m.id);
    if (members.length === 0) continue; // hide empty group
    if (members.length === 1) entries.push({ kind: "product", product: members[0]! }); // collapse
    else entries.push({ kind: "group", group, members });
  }

  const ungrouped = await db.product.findMany({
    where: {
      isActive: true,
      ...(categoryId != null ? { categoryId } : {}),
      id: { notIn: [...groupedIds] },
    },
    orderBy: { name: "asc" },
  });
  for (const p of ungrouped) entries.push({ kind: "product", product: p });

  const nameOf = (e: CatalogEntry) => (e.kind === "group" ? e.group.name : e.product.name).toLowerCase();
  entries.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return entries;
}
