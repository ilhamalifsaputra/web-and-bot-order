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
import { CategoryGroup, DeliveryType, OrderStatus, ProductType, StockStatus } from "@app/core/enums";
import { quantizeMoney } from "@app/core/formatters";
import { isFlashActive } from "@app/core/flash";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import type { Category, Denomination, Prisma, Product } from "@prisma/client";
import type { PrismaClient } from "../client";
import type { Db } from "./_types";
import { slugify } from "../migrate/slug";
import { activeServiceGroups, isServiceActive } from "./serviceAvailability";

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

export async function listActiveCategories(db: Db) {
  const [categories, groups] = await Promise.all([db.category.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  }), activeServiceGroups(db)]);
  return categories.filter((category) => groups.has(category.group ?? CategoryGroup.PREMIUM_APPS));
}

/**
 * Active categories in `group` — with one deliberate carve-out: `Category.group`
 * shipped nullable with no backfill, so every pre-existing category (all of
 * them, at first) reads `group: null` and would otherwise be invisible from
 * the group→category picker. Rather than a data migration, a `null` group is
 * treated as PREMIUM_APPS at display time (the shop's only category type
 * before this feature) — a request for GAME_TOPUP (the new, opt-in bucket)
 * stays an exact match; a null-group category never appears there.
 */
export async function listActiveCategoriesByGroup(db: Db, group: string) {
  if (!(await isServiceActive(db, group as CategoryGroup))) return [];
  // Prisma/SQLite rejects `null` inside a String field's `in` filter, so the
  // PREMIUM_APPS fallback is expressed as an OR of two exact matches instead.
  return db.category.findMany({
    where:
      group === CategoryGroup.PREMIUM_APPS
        ? { isActive: true, OR: [{ group: CategoryGroup.PREMIUM_APPS }, { group: null }] }
        : { isActive: true, group },
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
        group?: string | null;
        sortOrder?: number;
        checkoutFlow?: string;
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
      group: ("group" in a ? a.group : null) ?? null,
      sortOrder: a.sortOrder ?? 0,
      checkoutFlow: ("checkoutFlow" in a ? a.checkoutFlow : null) ?? "catalog",
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

export async function getCategoryBySlug(db: Db, slug: string) {
  const category = await db.category.findUnique({ where: { slug } });
  if (!category || !(await isServiceActive(db, category.group as CategoryGroup | null))) return null;
  return category;
}

/** Number of Products (mid-tier) in a category. */
export async function countProductsInCategory(db: Db, categoryId: number) {
  return db.product.count({ where: { categoryId } });
}

/** Refuse to delete a category that still has products (move or delete them first). */
export async function deleteCategory(db: Db, categoryId: number): Promise<void> {
  const count = await countProductsInCategory(db, categoryId);
  if (count > 0) {
    throw new Error("category not empty: move or delete its products first");
  }
  await db.category.delete({ where: { id: categoryId } });
}

/**
 * True when every id in `ids` names an existing category (vacuously true for
 * an empty list). Lets a route validate a reorder/move payload before writing,
 * instead of letting an unknown id surface as a raw Prisma P2025 from inside
 * `reorderCategories`'s transaction.
 */
export async function allCategoriesExist(db: Db, ids: number[]): Promise<boolean> {
  if (!ids.length) return true;
  const found = await db.category.findMany({ where: { id: { in: ids } }, select: { id: true } });
  return new Set(found.map((c) => c.id)).size === new Set(ids).size;
}

/** Persist a new display order for categories: `sortOrder` becomes the given index. */
export async function reorderCategories(db: PrismaClient, ids: number[]): Promise<void> {
  if (!ids.length) return;
  await db.$transaction(async (tx) => {
    for (const [index, id] of ids.entries()) {
      await tx.category.update({ where: { id }, data: { sortOrder: index } });
    }
  });
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
    /** Storefront detail blocks — see prisma/schema.prisma Product. */
    whatYouGet?: string | null;
    terms?: string | null;
    warrantyNote?: string | null;
    webImageUrl?: string | null;
    imageFileId?: string | null;
    sortOrder?: number;
    isActive?: boolean;
    /** Set when this Product was created by the Digiflazz import wizard —
     * the exact `brand` string Digiflazz reports, used to match a re-import
     * of the same brand back to this Product instead of duplicating it. */
    digiflazzBrand?: string | null;
    /** Admin-authored game-navigation classification (Task 8/14) — the bot's
     * catalog navigation and denomination labeling (Tasks 11-13) key off
     * these three, e.g. grouping "Mobile Legends" skins by variant/region.
     * All independent of each other and of every other field above. */
    gameVariant?: string | null;
    gameVariantEmoji?: string | null;
    gameRegion?: string | null;
    /** Admin-set default placeholder art style (Fase 12) shown when no
     * `webImageUrl` is set — null = auto-resolve from category. See
     * prisma/schema.prisma Product.thumbnailKind for the allowed values. */
    thumbnailKind?: string | null;
    /** Admin-set currency-icon style (Fase 12) shown on this product's
     * DenominationCard chips — null = auto-resolve. See
     * prisma/schema.prisma Product.currencyIconKind for the allowed values. */
    currencyIconKind?: string | null;
  },
) {
  const slug = await ensureUniqueSlug(db, "product", args.name);
  // Task 10: deliberately does NOT call bumpCatalogRevision — this function
  // is called in loops (CSV bulk-import's resolveOrCreateProduct per row;
  // splitMixedDigiflazzProducts), both inside their own $transactions. A
  // per-call bump would serialize a setting.upsert on one row across a long
  // batch transaction and risks two concurrent upsert(create)s P2002-aborting
  // each other. The catalog-index revision is bumped only at batch-operation
  // boundaries instead — importDigiflazzBrand post-commit, and the hourly job
  // before runDetectionForCatalog — so single admin creates rely on
  // getCatalogIndex's 30s TTL for eventual invalidation, acceptable while
  // detection is shadow-mode-only (no production consumer of the index yet).
  // Revisit at the Task 12/13 cutover, when immediate invalidation on every
  // catalog edit matters.
  return db.product.create({
    data: {
      categoryId: args.categoryId,
      name: args.name,
      slug,
      emoji: args.emoji ?? null,
      description: args.description ?? null,
      whatYouGet: args.whatYouGet ?? null,
      terms: args.terms ?? null,
      warrantyNote: args.warrantyNote ?? null,
      webImageUrl: args.webImageUrl ?? null,
      imageFileId: args.imageFileId ?? null,
      sortOrder: args.sortOrder ?? 0,
      isActive: args.isActive ?? true,
      digiflazzBrand: args.digiflazzBrand ?? null,
      gameVariant: args.gameVariant ?? null,
      gameVariantEmoji: args.gameVariantEmoji ?? null,
      gameRegion: args.gameRegion ?? null,
      thumbnailKind: args.thumbnailKind ?? null,
      currencyIconKind: args.currencyIconKind ?? null,
    },
  });
}

export async function updateCatalogProduct(db: Db, productId: number, fields: Record<string, unknown>) {
  if (Object.keys(fields).length === 0) return;
  await db.product.update({ where: { id: productId }, data: fields });
  // Task 10: deliberately does NOT call bumpCatalogRevision — see the
  // rationale on createCatalogProduct above (called in loops such as
  // splitMixedDigiflazzProducts, each inside its own $transaction; a
  // per-call bump risks serializing/aborting concurrent batch writes for no
  // benefit while detection is shadow-mode-only). The catalog-index revision
  // is bumped only at batch-operation boundaries instead — importDigiflazzBrand
  // post-commit, and the hourly job before runDetectionForCatalog.
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
export async function getCatalogProductBySlugWithDenominations(db: Db, slug: string) {
  const product = await db.product.findUnique({
    where: { slug },
    include: {
      category: true,
      denominations: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
    },
  });
  if (!product || !(await isServiceActive(db, product.category.group as CategoryGroup | null))) return null;
  return product;
}

/**
 * Every product (active + inactive) with category + denomination count —
 * admin. `archived` defaults to "exclude" (the admin's default catalog view
 * hides archived products); "only" / "all" let a caller surface them.
 */
export function listProducts(db: Db, categoryId?: number, archived: "exclude" | "only" | "all" = "exclude") {
  return db.product.findMany({
    where: {
      ...(categoryId != null ? { categoryId } : {}),
      ...(archived === "exclude" ? { isArchived: false } : archived === "only" ? { isArchived: true } : {}),
    },
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

/** Bulk move products (mid-tier) to another category in one writer. Returns count updated. */
export async function bulkSetCatalogProductsCategory(db: Db, ids: number[], categoryId: number): Promise<number> {
  if (!ids.length) return 0;
  const res = await db.product.updateMany({ where: { id: { in: ids } }, data: { categoryId } });
  return res.count;
}

/** Archive/unarchive one product (soft-hide from the default admin list and all customer surfaces). */
export async function setCatalogProductArchived(db: Db, productId: number, isArchived: boolean): Promise<void> {
  await db.product.update({ where: { id: productId }, data: { isArchived } });
}

/** Bulk archive/unarchive products (mid-tier) in one writer. Returns count updated. */
export async function bulkSetCatalogProductsArchived(db: Db, ids: number[], isArchived: boolean): Promise<number> {
  if (!ids.length) return 0;
  const res = await db.product.updateMany({ where: { id: { in: ids } }, data: { isArchived } });
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
    const denoms = await tx.denomination.findMany({ where: { productId }, select: { id: true } });
    // Same check as assertNoStockHistory, batched across every denomination
    // at once (2 counts total) instead of calling it once per denomination
    // (2N counts) — the error message doesn't identify which denomination
    // triggered it either way, so batching loses no information.
    const denomIds = denoms.map((d) => d.id);
    if (denomIds.length) {
      const [stock, events] = await Promise.all([
        tx.stockItem.count({ where: { productId: { in: denomIds } } }),
        tx.stockItemEvent.count({ where: { stockItem: { productId: { in: denomIds } } } }),
      ]);
      if (stock > 0 || events > 0) throw new ValidationError("error.denomination_has_stock_history");
    }
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
    deliveryType?: string;
    additionalFields?: string | null;
    /** The supplier's `buyerSkuCode` for a Digiflazz-imported denomination —
     * lets dispatchPendingDigiflazzOrders / resyncDigiflazzCatalog match this
     * row back to a Digiflazz price-list entry. */
    supplierSku?: string | null;
    /** Exact supplier name; no guessed backfill for hand-created or legacy rows. */
    supplierRawName?: string | null;
    /** KokinPay's game_code for this denomination's title (Task 7) — offers
     * the storefront's live nickname-check UX. Independent of supplierSku/
     * autoDeliverySource above. */
    nicknameCheckGameCode?: string | null;
    /** True when `price` was set by a human rather than the Digiflazz markup
     * suggestion (C2 fix) — protects it from being silently overwritten by
     * the next resyncDigiflazzCatalog tick. Defaults to false (computed by
     * the caller server-side; never trust a client-submitted boolean here). */
    priceOverridden?: boolean;
    /** The compact-button quantity (Task 8/14), e.g. `86` for an 86-diamond
     * top-up — paired with qtyUnit and formatted by formatDenominationLabel.
     * Set together by the admin; independent of every other field above. */
    qtyValue?: number | null;
    /** The short unit word paired with qtyValue on the compact button, e.g.
     * "Diamonds", "UC", "Bonds" (Task 8/14). */
    qtyUnit?: string | null;
  },
) {
  const slug = await ensureUniqueSlug(db, "denomination", args.name);
  // Task 10: deliberately does NOT call bumpCatalogRevision — see the note on
  // updateDenomination below. The Detection Engine's catalog index
  // (crud/detectionIndex.ts) is built from Product.name only, so no
  // denomination mutation can stale it.
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
      ...(args.deliveryType !== undefined ? { deliveryType: args.deliveryType } : {}),
      ...(args.additionalFields !== undefined ? { additionalFields: args.additionalFields } : {}),
      supplierSku: args.supplierSku ?? null,
      supplierRawName: args.supplierRawName ?? null,
      nicknameCheckGameCode: args.nicknameCheckGameCode ?? null,
      priceOverridden: args.priceOverridden ?? false,
      qtyValue: args.qtyValue ?? null,
      qtyUnit: args.qtyUnit ?? null,
    },
  });
}

export async function updateDenomination(db: Db, denominationId: number, fields: Record<string, unknown>) {
  if (Object.keys(fields).length === 0) return;
  await db.denomination.update({ where: { id: denominationId }, data: fields });
  // Task 10: deliberately does NOT call bumpCatalogRevision. The Detection
  // Engine's catalog index (crud/detectionIndex.ts) is built from Product.name
  // only — no denomination field feeds it — so a denomination mutation cannot
  // stale it. Revisit if the index ever indexes denomination-level data.
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
    // Product's `digiflazzBrand`/`name` (pulled in as bare scalars by this
    // nested `include`) are what `resolveNicknameGate` auto-detects the
    // nickname-check game from (packages/db/src/crud/nickname.ts).
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
    where: {
      isActive: true,
      OR: [{ name: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }],
    },
    include: { product: true },
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
 * Stock rows (even soft-deleted ones) and their event ledger are the audit
 * trail for delivered credentials, so a denomination that ever held stock
 * can only be deactivated, never deleted.
 */
async function assertNoStockHistory(db: Db, denominationId: number): Promise<void> {
  const [stock, events] = await Promise.all([
    db.stockItem.count({ where: { productId: denominationId } }),
    db.stockItemEvent.count({ where: { stockItem: { productId: denominationId } } }),
  ]);
  if (stock > 0 || events > 0) throw new ValidationError("error.denomination_has_stock_history");
}

/**
 * Delete a denomination (and its cart/review/bulk-pricing rows, which
 * cascade at the DB level). Refuses when it has order history — those rows
 * (`order_items`) do NOT cascade, so the financial record stays intact — or
 * stock history (see `assertNoStockHistory`).
 */
export async function deleteDenomination(db: Db, denominationId: number): Promise<void> {
  const orderCount = await db.orderItem.count({ where: { productId: denominationId } });
  if (orderCount > 0) {
    throw new Error("cannot delete a denomination with order history");
  }
  await assertNoStockHistory(db, denominationId);
  await db.denomination.delete({ where: { id: denominationId } });
}

/** (denomination, availableCount) for active denominations at/below threshold. */
export async function lowStockDenominations(
  db: Db,
  threshold: number,
): Promise<Array<{ denomination: Denomination; available: number }>> {
  const denoms = await db.denomination.findMany({
    where: { isActive: true, deliveryType: DeliveryType.AUTO },
  });
  const counts = await db.stockItem.groupBy({
    by: ["productId"],
    where: { deletedAt: null, status: StockStatus.AVAILABLE },
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
 *
 * `filter` is optional and additive: an EXISTING caller passing only
 * `(db, categoryId)` sees no behavior change. When passed, key PRESENCE (not
 * truthiness) decides whether that dimension is filtered — `"gameVariant" in
 * filter` lets a caller filter on an explicit `null` (products with no
 * variant set) as distinct from omitting the key entirely (don't filter on
 * that dimension at all). This backs the bot's Game Top Up variant/region
 * navigation layer once a variant+region has been resolved.
 */
export async function listCatalogProducts(
  db: Db,
  categoryId?: number,
  filter?: { gameVariant?: string | null; gameRegion?: string | null },
): Promise<CatalogProduct[]> {
  const [products, groups] = await Promise.all([db.product.findMany({
    where: {
      isActive: true,
      isArchived: false,
      category: { isActive: true },
      ...(categoryId != null ? { categoryId } : {}),
      ...(filter && "gameVariant" in filter ? { gameVariant: filter.gameVariant } : {}),
      ...(filter && "gameRegion" in filter ? { gameRegion: filter.gameRegion } : {}),
      denominations: { some: { isActive: true, price: { gt: 0 } } },
    },
    include: {
      category: true,
      denominations: { where: { isActive: true, price: { gt: 0 } }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  }), activeServiceGroups(db)]);
  return products.filter((product) => groups.has(product.category.group ?? CategoryGroup.PREMIUM_APPS));
}

/**
 * Active catalog products belonging to one customer-facing service group.
 * Categories with no explicit group retain the catalog's historical Premium
 * Apps fallback, matching listActiveCategoriesByGroup and service availability.
 */
export async function listCatalogProductsByGroup(db: Db, group: string): Promise<CatalogProduct[]> {
  const products = await listCatalogProducts(db);
  return products.filter((product) => (product.category.group ?? CategoryGroup.PREMIUM_APPS) === group);
}

export interface GameVariantOption {
  label: string;
  emoji: string | null;
}

/**
 * Distinct (gameVariant, gameVariantEmoji) pairs among a category's
 * catalog-eligible products (active, not archived, ≥1 active denomination).
 * 0 or 1 result means "no variant picker needed for this category" — callers
 * use `.length` to decide whether to show the Game Top Up variant step.
 */
export async function listCategoryGameVariants(db: Db, categoryId: number): Promise<GameVariantOption[]> {
  const products = await db.product.findMany({
    where: {
      categoryId,
      isActive: true,
      isArchived: false,
      gameVariant: { not: null },
      denominations: { some: { isActive: true, price: { gt: 0 } } },
    },
    select: { gameVariant: true, gameVariantEmoji: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const seen = new Map<string, GameVariantOption>();
  for (const p of products) {
    if (!seen.has(p.gameVariant!)) seen.set(p.gameVariant!, { label: p.gameVariant!, emoji: p.gameVariantEmoji });
  }
  return [...seen.values()];
}

/**
 * Count of a category's catalog-eligible products (active, not archived, ≥1
 * active denomination priced > 0) that have NO gameVariant set. The bot uses
 * this together with listCategoryGameVariants to decide whether a GAME_TOPUP
 * category is "pure" (every product labelled → variant picker is safe) or
 * "mixed" (a picked variant would hide the unlabelled products → show a flat
 * list instead).
 */
export async function countCategoryProductsWithoutGameVariant(db: Db, categoryId: number): Promise<number> {
  return db.product.count({
    where: {
      categoryId,
      isActive: true,
      isArchived: false,
      gameVariant: null,
      denominations: { some: { isActive: true, price: { gt: 0 } } },
    },
  });
}

/**
 * Distinct gameRegion values among a category's catalog-eligible products,
 * scoped to one gameVariant (pass `null` for "no variant dimension" — e.g. a
 * category with no variant picker but still a region picker). Same
 * 0-or-1-means-skip contract as `listCategoryGameVariants`.
 */
export async function listCategoryGameRegions(
  db: Db,
  categoryId: number,
  gameVariant: string | null,
): Promise<string[]> {
  const products = await db.product.findMany({
    where: {
      categoryId,
      gameVariant,
      isActive: true,
      isArchived: false,
      gameRegion: { not: null },
      denominations: { some: { isActive: true, price: { gt: 0 } } },
    },
    select: { gameRegion: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of products) {
    if (!seen.has(p.gameRegion!)) {
      seen.add(p.gameRegion!);
      out.push(p.gameRegion!);
    }
  }
  return out;
}

/** Newest active products (by newest active denomination) for the home grid. */
export async function listNewestCatalogProducts(db: Db, limit = 12): Promise<CatalogProduct[]> {
  const products = await listCatalogProducts(db);
  const recency = (p: CatalogProduct) =>
    Math.max(p.createdAt.getTime(), ...p.denominations.map((d) => d.createdAt.getTime()));
  return products.sort((a, b) => recency(b) - recency(a)).slice(0, limit);
}

/**
 * Search products by name/description (products only — variants are chosen in
 * product detail). Returns active products with ≥1 active denomination, each
 * with its active denominations price-asc. Sorted by name, capped at `limit`.
 */
export async function searchCatalog(db: Db, query: string, limit = 24): Promise<CatalogProduct[]> {
  const q = query.trim();
  if (!q) return [];
  const groups = await activeServiceGroups(db);
  if (groups.size === 0) return [];
  const categoryWhere: Prisma.CategoryWhereInput = {
    OR: [
      { group: { in: [...groups] } },
      ...(groups.has(CategoryGroup.PREMIUM_APPS) ? [{ group: null }] : []),
    ],
  };
  return db.product.findMany({
    where: {
      isActive: true,
      isArchived: false,
      category: { is: categoryWhere },
      denominations: { some: { isActive: true, price: { gt: 0 } } },
      OR: [{ name: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }],
    },
    include: {
      category: true,
      denominations: { where: { isActive: true, price: { gt: 0 } }, orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
    },
    orderBy: { name: "asc" },
    take: limit,
  });
}

/**
 * Active products with at least one denomination whose flash sale is running
 * right now — the storefront's /flash shelf.
 *
 * Deliberately filtered in memory on top of `listCatalogProducts` rather than
 * with a date-range `where`: whether a sale counts as live is decided by
 * `activeFlashPercent` (@app/core/flash), which also rejects a percent outside
 * (0,100] that a hand-edited row could carry. A SQL predicate would be a second
 * copy of that rule, free to drift from the one the checkout charges against.
 */
export async function listFlashSaleProducts(db: Db, now: Date = new Date()): Promise<CatalogProduct[]> {
  const products = await listCatalogProducts(db);
  return products.filter((p) => p.denominations.some((d) => isFlashActive(d, now)));
}

/**
 * True when any denomination in the catalog is on flash sale at `now` — lets a
 * navigation surface hide its "Flash Sale" entry instead of linking to an empty
 * shelf. Same liveness rule as `listFlashSaleProducts`, applied to the narrow
 * set of rows whose window could possibly contain `now`.
 */
export async function hasActiveFlashSale(db: Db, now: Date = new Date()): Promise<boolean> {
  const [candidates, groups] = await Promise.all([
    db.denomination.findMany({
      where: {
        isActive: true,
        price: { gt: 0 },
        flashDiscountPercent: { gt: 0 },
        flashStartsAt: { lte: now },
        flashEndsAt: { gt: now },
      },
      include: { product: { include: { category: true } } },
    }),
    activeServiceGroups(db),
  ]);
  return candidates.some((denomination) =>
    groups.has(denomination.product.category.group ?? CategoryGroup.PREMIUM_APPS)
    && isFlashActive(denomination, now),
  );
}

// ---- Bulk pricing (keyed by denomination) ----

export async function upsertBulkPricing(
  db: Db,
  args: { denominationId?: number; productId?: number; minQuantity: number; discountPercent: Decimal.Value },
) {
  const denominationId = args.denominationId ?? args.productId!;
  const discountPercent = quantizeMoney(args.discountPercent, 2);
  // The only thing standing between a misconfigured rule and a free (Rp0)
  // order — reject anything outside (0,100] (Pricing-4 fix, security audit
  // 2026-06-23).
  if (discountPercent.lte(0) || discountPercent.gt(100)) {
    throw new ValidationError("error.invalid_discount_percent");
  }
  // A threshold below 1 makes a "buy N+, save X%" rule fire on every
  // single-unit order — a permanent price cut nobody meant to configure.
  // activeBulkPercent refuses such a rule at read time too; this is where the
  // admin finds out about it.
  if (!Number.isInteger(args.minQuantity) || args.minQuantity < 1) {
    throw new ValidationError("error.invalid_min_quantity");
  }
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

// ---- Flash sale (keyed by denomination) ----

/**
 * Schedule (or reschedule) a flash sale on one denomination: `discountPercent`
 * off the base price for the half-open window [startsAt, endsAt).
 *
 * Rewriting the schedule clears `flashAnnouncedAt`, which is what lets the same
 * SKU be flashed again — the announce job treats a null stamp as "not yet
 * broadcast" and will fan out a fresh announcement once this window opens.
 */
export async function setFlashSale(
  db: Db,
  args: { denominationId: number; discountPercent: Decimal.Value; startsAt: Date; endsAt: Date },
) {
  const discountPercent = quantizeMoney(args.discountPercent, 2);
  // Same guard as upsertBulkPricing (Pricing-4): a percent outside (0,100] is
  // the difference between a promotion and giving stock away for free.
  if (!discountPercent.isFinite() || discountPercent.lte(0) || discountPercent.gt(100)) {
    throw new ValidationError("error.invalid_discount_percent");
  }
  if (Number.isNaN(args.startsAt.getTime()) || Number.isNaN(args.endsAt.getTime())) {
    throw new ValidationError("error.invalid_flash_window");
  }
  // A window that ends before it starts, or one that is already over, would
  // silently never discount anything — reject it at write time so the admin
  // finds out now rather than wondering why the badge never appeared.
  if (args.endsAt <= args.startsAt || args.endsAt <= new Date()) {
    throw new ValidationError("error.invalid_flash_window");
  }
  return db.denomination.update({
    where: { id: args.denominationId },
    data: {
      flashDiscountPercent: discountPercent,
      flashStartsAt: args.startsAt,
      flashEndsAt: args.endsAt,
      flashAnnouncedAt: null,
    },
  });
}

/** Cancel a flash sale. Returns false when the SKU had none scheduled. */
export async function clearFlashSale(db: Db, denominationId: number): Promise<boolean> {
  const existing = await db.denomination.findUnique({
    where: { id: denominationId },
    select: { flashDiscountPercent: true },
  });
  if (!existing || existing.flashDiscountPercent == null) return false;
  await db.denomination.update({
    where: { id: denominationId },
    data: {
      flashDiscountPercent: null,
      flashStartsAt: null,
      flashEndsAt: null,
      flashAnnouncedAt: null,
    },
  });
  return true;
}

/**
 * Denominations whose flash sale has STARTED but has not been announced yet,
 * newest schedule last. Drives the announce job; inactive SKUs are skipped
 * because broadcasting a sale nobody can buy would just be noise.
 */
export function listUnannouncedStartedFlashSales(db: Db, now: Date = new Date()) {
  return db.denomination.findMany({
    where: {
      isActive: true,
      flashAnnouncedAt: null,
      flashDiscountPercent: { not: null },
      flashStartsAt: { lte: now },
      flashEndsAt: { gt: now },
    },
    include: { product: true },
    orderBy: { flashStartsAt: "asc" },
  });
}

/**
 * Every denomination across the whole catalog with its flash-sale fields, for
 * the bulk Flash Sales admin page (one query backs both its "pick SKUs to
 * flash" and "currently active/scheduled" views). Includes inactive SKUs —
 * an admin may want to pre-schedule a sale before reactivating a product.
 */
export function listDenominationsWithFlashInfo(db: Db) {
  return db.denomination.findMany({
    select: {
      id: true,
      name: true,
      price: true,
      isActive: true,
      productId: true,
      deliveryType: true,
      flashDiscountPercent: true,
      flashStartsAt: true,
      flashEndsAt: true,
      product: { select: { name: true, category: { select: { name: true } } } },
    },
    orderBy: [{ product: { name: "asc" } }, { name: "asc" }],
  });
}

/**
 * Per-denomination sales aggregates (units sold, revenue, distinct orders)
 * scoped to each entry's own half-open flash-sale window `[startsAt, endsAt)`
 * — same convention as `isFlashActive` (@app/core/flash): an order placed at
 * the exact instant a window ends is already past the sale. Backs the Flash
 * Sales admin page's "performance" column. One `orderItem.findMany` bounded
 * to the union of every entry's range fetches all candidate rows in one
 * query — cheaper than a per-entry query — then the rows are bucketed by
 * denomination id in a single pass so each entry only re-filters its own
 * bucket's date window (an order inside the union range can still fall
 * outside any single entry's narrower window), never the whole fetched
 * result set.
 */
export async function flashSalePerformance(
  db: Db,
  entries: { denominationId: number; startsAt: Date; endsAt: Date }[],
): Promise<Map<number, { sold: number; revenue: Decimal; orders: number }>> {
  const map = new Map<number, { sold: number; revenue: Decimal; orders: number }>();
  if (!entries.length) return map;

  const minStartsAt = new Date(Math.min(...entries.map((e) => e.startsAt.getTime())));
  const maxEndsAt = new Date(Math.max(...entries.map((e) => e.endsAt.getTime())));

  const rows = await db.orderItem.findMany({
    where: {
      productId: { in: entries.map((e) => e.denominationId) },
      order: { status: OrderStatus.DELIVERED, createdAt: { gte: minStartsAt, lt: maxEndsAt } },
    },
    select: { productId: true, quantity: true, unitPrice: true, orderId: true, order: { select: { createdAt: true } } },
  });

  const byDenomination = new Map<number, typeof rows>();
  for (const r of rows) {
    const bucket = byDenomination.get(r.productId);
    if (bucket) bucket.push(r);
    else byDenomination.set(r.productId, [r]);
  }

  for (const entry of entries) {
    const candidates = byDenomination.get(entry.denominationId) ?? [];
    const matching = candidates.filter(
      (r) => r.order.createdAt >= entry.startsAt && r.order.createdAt < entry.endsAt,
    );
    const sold = matching.reduce((acc, r) => acc + r.quantity, 0);
    const revenue = matching.reduce(
      (acc, r) => acc.plus(new Decimal(r.unitPrice).times(r.quantity)),
      new Decimal(0),
    );
    const orders = new Set(matching.map((r) => r.orderId)).size;
    map.set(entry.denominationId, { sold, revenue, orders });
  }

  return map;
}

/**
 * Apply the same flash-sale schedule to many denominations at once (the
 * "set flash sale for N selected SKUs" bulk action). Loops individual
 * `setFlashSale` calls rather than one big `$transaction` — each call is
 * already a single atomic UPDATE, and a bad id (e.g. a denomination deleted
 * between page-load and submit) should only fail that one row, not roll back
 * every other admin's-worth of discount in the same batch.
 */
export async function bulkSetFlashSale(
  db: Db,
  args: { denominationIds: number[]; discountPercent: Decimal.Value; startsAt: Date; endsAt: Date },
): Promise<{ applied: number; overwritten: number; failed: number }> {
  let applied = 0;
  let overwritten = 0;
  let failed = 0;
  for (const denominationId of args.denominationIds) {
    try {
      const existing = await db.denomination.findUnique({
        where: { id: denominationId },
        select: { flashDiscountPercent: true },
      });
      if (!existing) {
        failed++;
        continue;
      }
      await setFlashSale(db, {
        denominationId,
        discountPercent: args.discountPercent,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
      });
      applied++;
      if (existing.flashDiscountPercent != null) overwritten++;
    } catch {
      failed++;
    }
  }
  return { applied, overwritten, failed };
}

/** Cancel the flash sale on many denominations at once ("end now", bulk). */
export async function bulkClearFlashSale(
  db: Db,
  denominationIds: number[],
): Promise<{ cleared: number; skipped: number }> {
  let cleared = 0;
  let skipped = 0;
  for (const denominationId of denominationIds) {
    const removed = await clearFlashSale(db, denominationId);
    if (removed) cleared++; else skipped++;
  }
  return { cleared, skipped };
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
