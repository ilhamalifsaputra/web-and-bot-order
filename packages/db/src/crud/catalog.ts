/**
 * Catalog domain — the 3-tier catalog Category → Product → Denomination.
 *
 * - Category: top-level grouping (storefront `/c/:slug`).
 * - Product (mid-tier): the customer-facing item (e.g. "CapCut Pro"); image,
 *   description and navigation only — NO price, NO stock.
 * - Denomination (leaf / SKU): the sellable unit (e.g. "1 Month"); price, cost,
 *   stock and auto-delivery all live here. Physically the old `products` table.
 *
 * NAMING HAZARD: pre-rename, "Product" meant the SKU. To keep the apps compiling
 * phase-by-phase, the old SKU helpers survive as `@deprecated` shims (bottom of
 * file) that adapt to the Denomination functions; `createProduct` even
 * auto-creates a 1:1 wrapper Product so legacy create flows still work. The new
 * mid-tier CRUD therefore uses transitional `*CatalogProduct` names — renamed to
 * the clean `*Product` names in Phase 5 once the shims are deleted.
 */
import { config } from "@app/core/config";
import { ProductType, StockStatus } from "@app/core/enums";
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
      denominations: { some: { isActive: true } },
    },
    include: {
      category: true,
      denominations: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

/** Newest active products (by newest active denomination) for the home grid. */
export async function listNewestCatalogProducts(db: Db, limit = 12): Promise<CatalogProduct[]> {
  const products = await db.product.findMany({
    where: { isActive: true, denominations: { some: { isActive: true } } },
    include: {
      category: true,
      denominations: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
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
      denominations: { some: { isActive: true } },
      OR: [{ name: { contains: q } }, { description: { contains: q } }],
    },
    include: {
      category: true,
      denominations: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
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

// =========================================================================
// @deprecated backward-compat shims — preserve old export names + return
// shapes so the apps keep compiling until Phases 2–4 migrate them. Removed in
// Phase 5. Here "Product" = the old SKU = the new Denomination.
// =========================================================================

/** A denomination flattened with a synthetic `categoryId` (old SKU shape). */
type LegacyProduct = Denomination & { categoryId: number };

/** @deprecated old SKU rows carried a `categoryId`/`productGroupId`. */
export type CatalogEntry =
  | { kind: "group"; group: Product; members: LegacyProduct[] }
  | { kind: "product"; product: LegacyProduct };

/**
 * @deprecated old SKU create. Auto-creates a 1:1 wrapper Product (mandatory
 * parent) carrying the category/name, then the denomination under it — so
 * legacy "create a product under a category with a price" flows keep working.
 */
export async function createProduct(
  db: Db,
  args: {
    categoryId: number;
    name: string;
    description?: string | null;
    type: ProductType | string;
    durationLabel: string;
    price: Decimal.Value;
    costPrice?: Decimal.Value | null;
    resellerPrice?: Decimal.Value | null;
    warrantyDays?: number | null;
    imageFileId?: string | null;
    webImageUrl?: string | null;
  },
) {
  const parent = await createCatalogProduct(db, {
    categoryId: args.categoryId,
    name: args.name,
    description: args.description ?? null,
    webImageUrl: args.webImageUrl ?? null,
    imageFileId: args.imageFileId ?? null,
  });
  const denom = await createDenomination(db, {
    productId: parent.id,
    name: args.name,
    type: args.type,
    durationLabel: args.durationLabel,
    price: args.price,
    costPrice: args.costPrice ?? null,
    resellerPrice: args.resellerPrice ?? null,
    warrantyDays: args.warrantyDays ?? null,
    description: args.description ?? null,
    imageFileId: args.imageFileId ?? null,
    webImageUrl: args.webImageUrl ?? null,
  });
  return { ...denom, categoryId: parent.categoryId } as LegacyProduct;
}

/** @deprecated old SKU update → updateDenomination. */
export function updateProduct(db: Db, productId: number, fields: Record<string, unknown>) {
  return updateDenomination(db, productId, fields);
}

/** @deprecated old SKU read → denomination flattened with categoryId. */
export async function getProduct(db: Db, productId: number): Promise<LegacyProduct | null> {
  const d = await db.denomination.findUnique({ where: { id: productId }, include: { product: true } });
  if (!d) return null;
  const { product, ...rest } = d;
  return { ...rest, categoryId: product.categoryId };
}

/** @deprecated use createCatalogProduct (mid-tier). */
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
  return createCatalogProduct(db, args);
}

/** @deprecated use updateCatalogProduct (mid-tier). */
export function updateGroup(db: Db, groupId: number, fields: Record<string, unknown>) {
  return updateCatalogProduct(db, groupId, fields);
}

/** @deprecated use deleteCatalogProductCascade. */
export function deleteGroup(db: PrismaClient, groupId: number): Promise<void> {
  return deleteCatalogProductCascade(db, groupId);
}

/** @deprecated use assignDenominationToProduct. groupId must be non-null now. */
export async function assignProductToGroup(db: Db, productId: number, groupId: number | null): Promise<void> {
  if (groupId === null) throw new Error("a denomination must belong to a product (parent is mandatory)");
  await assignDenominationToProduct(db, productId, groupId);
}

/** @deprecated use listProducts. Old shape: groups with category + member count. */
export async function listAllGroups(db: Db) {
  const products = await db.product.findMany({
    include: { category: true, _count: { select: { denominations: true } } },
    orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
  return products.map((p) => {
    const { _count, ...rest } = p;
    return { ...rest, _count: { products: _count.denominations } };
  });
}

/** @deprecated use getCatalogProductWithDenominations. Old shape: group + members. */
export async function getGroupWithActiveProducts(db: Db, groupId: number) {
  const product = await db.product.findUnique({
    where: { id: groupId },
    include: { denominations: { where: { isActive: true }, orderBy: { price: "asc" } } },
  });
  if (!product) return null;
  const { denominations, ...group } = product;
  const members: LegacyProduct[] = denominations.map((d) => ({ ...d, categoryId: product.categoryId }));
  return { ...group, products: members };
}

/**
 * Map a product+denominations to a legacy CatalogEntry, REPLICATING the old
 * collapse rule so existing surfaces/tests behave identically during transition:
 * a product with exactly one active denomination collapses to a `product` entry;
 * ≥2 stays a `group` entry. (Phases 3–4 drop collapse and always show products.)
 */
function entryFromCatalogProduct(p: CatalogProduct): CatalogEntry {
  const { denominations, category: _c, ...group } = p;
  const members = denominations.map((d) => ({ ...d, categoryId: p.categoryId }));
  if (members.length === 1) return { kind: "product", product: members[0]! };
  return { kind: "group", group, members };
}

const byEntryName = (a: CatalogEntry, b: CatalogEntry) => {
  const an = a.kind === "group" ? a.group.name : a.product.name;
  const bn = b.kind === "group" ? b.group.name : b.product.name;
  return an.toLowerCase().localeCompare(bn.toLowerCase());
};

/** @deprecated use listCatalogProducts. Reproduces the old group/product union. */
export async function listCatalogEntries(db: Db, categoryId?: number): Promise<CatalogEntry[]> {
  const products = await listCatalogProducts(db, categoryId);
  return products.map(entryFromCatalogProduct).sort(byEntryName);
}

/** @deprecated use listNewestCatalogProducts. Keeps recency order (no re-sort). */
export async function listNewestCatalogEntries(db: Db, limit = 12): Promise<CatalogEntry[]> {
  const products = await listNewestCatalogProducts(db, limit);
  return products.map(entryFromCatalogProduct);
}

/** @deprecated use searchCatalog. */
export async function searchCatalogEntries(db: Db, query: string, limit = 24): Promise<CatalogEntry[]> {
  const products = await searchCatalog(db, query, limit);
  return products.map(entryFromCatalogProduct).sort(byEntryName);
}

/** @deprecated use getDenominationWithProduct. Old shape: SKU + category. */
export async function getProductWithCategory(db: Db, productId: number) {
  const d = await db.denomination.findUnique({
    where: { id: productId },
    include: { product: { include: { category: true } } },
  });
  if (!d) return null;
  const { product, ...rest } = d;
  return { ...rest, categoryId: product.categoryId, productGroupId: product.id, category: product.category };
}

/** @deprecated use getDenominationWithProduct. Old shape: SKU + category + group. */
export async function getProductDetail(db: Db, productId: number) {
  const d = await db.denomination.findUnique({
    where: { id: productId },
    include: { product: { include: { category: true } } },
  });
  if (!d) return null;
  const { product, ...rest } = d;
  return {
    ...rest,
    categoryId: product.categoryId,
    productGroupId: product.id,
    category: product.category,
    productGroup: product,
  };
}

/** @deprecated use getDenominationsByIds. */
export function getProductsByIds(db: Db, ids: number[]) {
  return getDenominationsByIds(db, ids);
}

/** @deprecated use listAllDenominations. Old shape: SKUs with category + group. */
export async function listAllProducts(db: Db) {
  const denoms = await db.denomination.findMany({
    include: { product: { include: { category: true } } },
    orderBy: { name: "asc" },
  });
  return denoms.map((d) => {
    const { product, ...rest } = d;
    return { ...rest, categoryId: product.categoryId, productGroupId: product.id, category: product.category, productGroup: product };
  });
}

/** @deprecated use bulkSetDenominationsActive. */
export function bulkSetProductsActive(db: Db, ids: number[], isActive: boolean): Promise<number> {
  return bulkSetDenominationsActive(db, ids, isActive);
}

/** @deprecated use searchDenominations. */
export function searchProducts(db: Db, query: string, limit = 20) {
  return searchDenominations(db, query, limit);
}

/** @deprecated use searchCatalog (products only). Old shape: SKUs + category. */
export async function searchProductsWithCategory(db: Db, query: string, limit = 24) {
  const q = query.trim();
  if (!q) return [];
  const denoms = await db.denomination.findMany({
    where: { isActive: true, OR: [{ name: { contains: q } }, { description: { contains: q } }] },
    include: { product: { include: { category: true } } },
    take: limit,
  });
  return denoms.map((d) => {
    const { product, ...rest } = d;
    return { ...rest, categoryId: product.categoryId, category: product.category };
  });
}

/** @deprecated use listCatalogProducts. Old shape: active SKUs in a category. */
export function listActiveProducts(db: Db, categoryId: number) {
  return db.denomination.findMany({
    where: { isActive: true, product: { categoryId } },
    orderBy: { name: "asc" },
  });
}

/** @deprecated. Old shape: all active SKUs. */
export function listAllActiveProducts(db: Db) {
  return db.denomination.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
}

/** @deprecated use listNewestCatalogProducts. Old shape: newest SKUs + category. */
export async function listNewestActiveProducts(db: Db, limit = 12) {
  const denoms = await db.denomination.findMany({
    where: { isActive: true },
    include: { product: { include: { category: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return denoms.map((d) => {
    const { product, ...rest } = d;
    return { ...rest, categoryId: product.categoryId, category: product.category };
  });
}

/** @deprecated use listCatalogProducts. Old shape: active SKUs in a category + cat. */
export async function listActiveProductsWithCategory(db: Db, categoryId: number) {
  const denoms = await db.denomination.findMany({
    where: { isActive: true, product: { categoryId } },
    include: { product: { include: { category: true } } },
    orderBy: { name: "asc" },
  });
  return denoms.map((d) => {
    const { product, ...rest } = d;
    return { ...rest, categoryId: product.categoryId, category: product.category };
  });
}

/** @deprecated use lowStockDenominations. Old shape: {product, available}. */
export async function lowStockProducts(
  db: Db,
  threshold: number,
): Promise<Array<{ product: Denomination; available: number }>> {
  const rows = await lowStockDenominations(db, threshold);
  return rows.map((r) => ({ product: r.denomination, available: r.available }));
}

/** @deprecated use getBulkPricingForDenomination. */
export function getBulkPricingForProduct(db: Db, productId: number) {
  return getBulkPricingForDenomination(db, productId);
}

/** @deprecated use activeBulkPricingByDenomination. */
export function activeBulkPricingByProduct(db: Db) {
  return activeBulkPricingByDenomination(db);
}
