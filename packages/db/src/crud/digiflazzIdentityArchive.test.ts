import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createCategory, createCatalogProduct, createDenomination, updateDenomination, archiveDenominationBatch, validateDenominationBatch, listProducts, getCatalogProductWithDenominations, bulkSetDenominationsActive, listCatalogProducts } from "./catalog";
import { importDigiflazzBrand, resyncDigiflazzCatalog, groupDigiflazzPriceListByBrand, DIGIFLAZZ_USERNAME_KEY, DIGIFLAZZ_API_KEY_KEY, DIGIFLAZZ_MARKUP_TYPE_KEY, DIGIFLAZZ_MARKUP_VALUE_KEY } from "./digiflazz";
import { setSetting } from "./settings";
import { upsertUser } from "./users";
import { auditDigiflazzDuplicates, classifyDigiflazzDuplicates, type DuplicateAuditProduct } from "./digiflazzDuplicateAudit";
import { CategoryGroup } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import type { DigiflazzPriceListItem } from "@app/core/suppliers/digiflazz";
import { readFileSync } from "node:fs";

const identityMigration = readFileSync(new URL("../../../../prisma/migrations/20261009090100_supplier_identity_unique/migration.sql", import.meta.url), "utf8");
const [identityPreflight, identityIndex] = identityMigration.split("CREATE UNIQUE INDEX");

let db: TestDb;
let categoryId: number;
beforeAll(async () => {
  db = await makeTestDb();
  // db push cannot express these SQL-only invariants; test real PostgreSQL enforcement.
  await db.prisma.$executeRawUnsafe(identityPreflight!);
  await db.prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX${identityIndex!}`);
  await db.prisma.$executeRawUnsafe("ALTER TABLE denominations ADD CONSTRAINT denominations_archive_inactive CHECK (NOT is_archived OR NOT is_active)");
});
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => {
  // Unique names isolate each case without touching shared/live schemas.
  categoryId = (await createCategory(db.prisma, { name: `Identity ${Date.now()}`, group: CategoryGroup.GAME_TOPUP })).id;
});
const row = (sku: string, name = "MOBILE LEGENDS 86 Indonesia") => ({ buyerSkuCode: sku, productName: name, price: "16500", costPrice: "15000" });
let serial = 0;
const sku = () => `identity-${++serial}`;
describe("Digiflazz identity and deletion", () => {
  it("preserves missing-row errors for editable denomination writes", async () => {
    await expect(updateDenomination(db.prisma, 2147483647, { supplierSku: "missing" })).rejects.toMatchObject({ code: "P2025" });
  });

  it("auto-adds to the live same-brand survivor while retaining the archived duplicate", async () => {
    const brand = `Repair survivor ${categoryId}`;
    const existingSku = sku();
    const newSku = sku();
    const imported = await importDigiflazzBrand(db.prisma, { categoryId, brand, rows: [row(existingSku, `${brand} 86`)] });
    const source = await createCatalogProduct(db.prisma, { categoryId, name: `${brand} duplicate`, digiflazzBrand: brand });
    await db.prisma.product.update({ where: { id: source.id }, data: { isArchived: true, isActive: false } });
    const tombstone = await db.prisma.denomination.create({ data: { productId: source.id, name: "Historic pack", slug: `historic-${source.id}`, type: "SHARED", durationLabel: "86", price: "20000", supplierSku: existingSku, autoDeliverySource: "digiflazz", isArchived: true, isActive: false } });
    const buyer = await upsertUser(db.prisma, { telegramId: 500000 + categoryId, username: "history-buyer", fullName: "History buyer" });
    const historicalOrder = await db.prisma.order.create({ data: { orderCode: `repair-history-${source.id}`, userId: buyer.id, subtotalAmount: "20000", totalAmount: "20000", status: "DELIVERED",
      items: { create: { productId: tombstone.id, quantity: 1, unitPrice: "20000", warrantyDaysSnapshot: 0 } } }, include: { items: true } });
    const providerRows: DigiflazzPriceListItem[] = [existingSku, newSku].map(buyerSkuCode => ({ buyerSkuCode, productName: `${brand} 86`, category: "Games", brand, type: "Umum", price: new Decimal("15000"), buyerProductStatus: true, sellerProductStatus: true, stock: null }));
    const grouped = await groupDigiflazzPriceListByBrand(db.prisma, providerRows, { withDetection: false });
    expect(grouped[0]!.existingProductId).toBe(imported.productId);
    await setSetting(db.prisma, DIGIFLAZZ_USERNAME_KEY, "test-shop");
    await setSetting(db.prisma, DIGIFLAZZ_API_KEY_KEY, "test-key");
    await setSetting(db.prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "flat");
    await setSetting(db.prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "1000");
    priceListMock.mockResolvedValue(providerRows);
    expect((await resyncDigiflazzCatalog(db.prisma)).added).toBe(1);
    expect(await db.prisma.denomination.findFirst({ where: { supplierSku: newSku } })).toMatchObject({ productId: imported.productId, isArchived: false });
    expect(await db.prisma.denomination.findUnique({ where: { id: tombstone.id } })).toEqual(tombstone);
    expect(await db.prisma.orderItem.findMany({ where: { orderId: historicalOrder.id } })).toEqual(historicalOrder.items);
    expect(await db.prisma.product.findUnique({ where: { id: source.id } })).toMatchObject({ digiflazzBrand: brand, isArchived: true });
  });

  it("rechecks an auto-add parent archived after the grouping snapshot", async () => {
    const brand = `Stale parent ${categoryId}`;
    const existingSku = sku();
    const newSku = sku();
    const imported = await importDigiflazzBrand(db.prisma, { categoryId, brand, rows: [row(existingSku, `${brand} 86`)] });
    const providerRows: DigiflazzPriceListItem[] = [existingSku, newSku].map(buyerSkuCode => ({ buyerSkuCode, productName: `${brand} 86`, category: "Games", brand, type: "Umum", price: new Decimal("15000"), buyerProductStatus: true, sellerProductStatus: true, stock: null }));
    await setSetting(db.prisma, DIGIFLAZZ_USERNAME_KEY, "test-shop");
    await setSetting(db.prisma, DIGIFLAZZ_API_KEY_KEY, "test-key");
    await setSetting(db.prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "flat");
    await setSetting(db.prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "1000");
    priceListMock.mockResolvedValue(providerRows);
    const findMany = db.prisma.product.findMany.bind(db.prisma.product);
    const spy = vi.spyOn(db.prisma.product, "findMany").mockImplementationOnce((async args => {
      const snapshot = await findMany(args);
      await db.prisma.product.update({ where: { id: imported.productId }, data: { isArchived: true, isActive: false } });
      return snapshot;
    }) as typeof db.prisma.product.findMany);
    try {
      expect((await resyncDigiflazzCatalog(db.prisma)).added).toBe(0);
      expect(await db.prisma.denomination.count({ where: { supplierSku: newSku } })).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it("reuses identical external identity across display punctuation and preserves admin customization", async () => {
    const code = sku();
    const first = await importDigiflazzBrand(db.prisma, { categoryId, brand: "MOBILE LEGENDS (Indonesia)", rows: [row(code)] });
    const denomination = await db.prisma.denomination.findFirstOrThrow({ where: { productId: first.productId } });
    await db.prisma.product.update({ where: { id: first.productId }, data: { name: "My custom title", webImageUrl: "/custom.webp" } });
    await db.prisma.denomination.update({ where: { id: denomination.id }, data: { name: "My custom pack", price: "20000", priceOverridden: true } });
    const second = await importDigiflazzBrand(db.prisma, { categoryId, brand: "MOBILE LEGENDS Indonesia", rows: [row(code)] });
    expect(second.productId).toBe(first.productId);
    expect(await db.prisma.denomination.count({ where: { supplierSku: code } })).toBe(1);
    expect(await db.prisma.product.findUnique({ where: { id: first.productId } })).toMatchObject({ name: "My custom title", webImageUrl: "/custom.webp" });
    expect(await db.prisma.denomination.findUnique({ where: { id: denomination.id } })).toMatchObject({ name: "My custom pack", priceOverridden: true });
    expect((await db.prisma.denomination.findUniqueOrThrow({ where: { id: denomination.id } })).price.toString()).toBe("20000");
    expect(second.report.unchanged).toBe(1);
  });
  it("keeps similar names with different regional SKUs separate", async () => {
    const a = await importDigiflazzBrand(db.prisma, { categoryId, brand: "ML (Indonesia)", rows: [row(sku())] });
    const b = await importDigiflazzBrand(db.prisma, { categoryId, brand: "ML (Malaysia)", rows: [row(sku())] });
    expect(a.productId).not.toBe(b.productId);
  });
  it("does not claim the same SKU string belonging to another provider", async () => {
    const code = sku();
    const other = await createCatalogProduct(db.prisma, { categoryId, name: `Other provider ${categoryId}` });
    await createDenomination(db.prisma, { productId: other.id, name: "86", durationLabel: "86", type: "SHARED", price: "100", supplierSku: code, autoDeliverySource: "providerB" });
    const result = await importDigiflazzBrand(db.prisma, { categoryId, brand: `Digiflazz ${categoryId}`, rows: [row(code)] });
    expect(result.productId).not.toBe(other.id);
    expect(await db.prisma.denomination.count({ where: { supplierSku: code } })).toBe(2);
  });
  it("serializes simultaneous first imports and is idempotent", async () => {
    const args = { categoryId, brand: `Concurrent ${categoryId}`, rows: [row(sku())] };
    const results = await Promise.all([importDigiflazzBrand(db.prisma, args), importDigiflazzBrand(db.prisma, args)]);
    expect(results[0]!.productId).toBe(results[1]!.productId);
    expect(await db.prisma.product.count({ where: { categoryId } })).toBe(1);
    expect(await db.prisma.denomination.count({ where: { productId: results[0]!.productId } })).toBe(1);
  });
  it("refuses partial overlap after a brand change without creating a product", async () => {
    const code = sku();
    await importDigiflazzBrand(db.prisma, { categoryId, brand: "ML legacy", rows: [row(code)] });
    await expect(importDigiflazzBrand(db.prisma, { categoryId, brand: "ML new", rows: [row(code), row(sku())] })).rejects.toThrow("Brand identity changed");
    expect(await db.prisma.product.count({ where: { categoryId } })).toBe(1);
  });
  it("archives supplier rows, hides matching list/detail counts, blocks activation and respects tombstones", async () => {
    const code = sku();
    const imported = await importDigiflazzBrand(db.prisma, { categoryId, brand: `Delete ${categoryId}`, rows: [row(code)] });
    const denom = await db.prisma.denomination.findFirstOrThrow({ where: { productId: imported.productId } });
    expect(await archiveDenominationBatch(db.prisma, imported.productId, [denom.id, denom.id], true, null)).toMatchObject({ count: 1 });
    expect(await db.prisma.auditLog.findFirst({ where: { action: "denomination_bulk_delete", targetId: imported.productId } })).toMatchObject({
      details: `Archived 1 denomination for product ${imported.productId}. Requested denomination IDs: ${denom.id}.`,
    });
    expect(await bulkSetDenominationsActive(db.prisma, [denom.id], true)).toBe(0);
    expect((await getCatalogProductWithDenominations(db.prisma, imported.productId))!.denominations).toHaveLength(0);
    expect((await listProducts(db.prisma, categoryId))[0]!._count.denominations).toBe(0);
    expect((await importDigiflazzBrand(db.prisma, { categoryId, brand: `Delete ${categoryId}`, rows: [row(code)] })).report.skipped).toBe(1);
    await archiveDenominationBatch(db.prisma, imported.productId, [denom.id], false, null);
    expect(await db.prisma.denomination.findUnique({ where: { id: denom.id } })).toMatchObject({ isArchived: false, isActive: false });
    expect(await db.prisma.auditLog.findFirst({ where: { action: "denomination_bulk_restore", targetId: imported.productId } })).toMatchObject({
      details: `Restored 1 denomination to inactive status for product ${imported.productId}. Requested denomination IDs: ${denom.id}.`,
    });
  });
  it("rejects foreign/missing IDs atomically, rolls back on audit errors", async () => {
    const product = await createCatalogProduct(db.prisma, { categoryId, name: `Manual ${categoryId}` });
    const denom = await createDenomination(db.prisma, { productId: product.id, name: "Manual", type: "SHARED", durationLabel: "86", price: "100" });
    await expect(archiveDenominationBatch(db.prisma, product.id + 100000, [denom.id], true, null)).rejects.toThrow("another product");
    await expect(archiveDenominationBatch(db.prisma, product.id, [denom.id, 2147483647], true, null)).rejects.toThrow("another product");
    // Enforce a real audit FK failure to verify the archive rolls back too.
    await expect(archiveDenominationBatch(db.prisma, product.id, [denom.id], true, 2147483647)).rejects.toThrow();
    expect(await db.prisma.denomination.findUnique({ where: { id: denom.id } })).toMatchObject({ isArchived: false, isActive: true });
  });
  it("audit is read-only and separates name signals from exact overlap", async () => {
    const before = await db.prisma.auditLog.count();
    await auditDigiflazzDuplicates(db.prisma);
    expect(await db.prisma.auditLog.count()).toBe(before);
    const product = (id: number, codes: string[]): DuplicateAuditProduct => ({ id, name: id === 1 ? "MOBILE LEGENDS (Indonesia)" : "MOBILE LEGENDS Indonesia", slug: String(id), categoryId: 1, source: null, region: null, variant: null, active: true, archived: false, image: null,
      denominations: codes.map((code, i) => ({ id: i, sku: code, archived: false, active: true, price: "10", cost: null, priceOverridden: false, inventory: 0, orders: 0, mappings: [], metadata: {} })) });
    expect(classifyDigiflazzDuplicates([product(1, ["a"]), product(2, ["a"])]).candidates[0]!.classification).toBe("exact_overlap");
    expect(classifyDigiflazzDuplicates([product(1, ["a"]), product(2, ["b"])]).candidates[0]!.classification).toBe("name_only_similarity");
    expect(classifyDigiflazzDuplicates([product(1, ["a", "b"]), product(2, ["b", "c"])]).candidates[0]!.classification).toBe("partial_overlap");
  });
  it("database uniqueness protects manual create and restore rejects an occupied supplier identity", async () => {
    const product = await createCatalogProduct(db.prisma, { categoryId, name: `Constraint ${categoryId}` });
    const code = sku();
    const args = { productId: product.id, name: "Unique pack", type: "SHARED", durationLabel: "86", price: "100", supplierSku: code, autoDeliverySource: "digiflazz" };
    const first = await createDenomination(db.prisma, args);
    await expect(createDenomination(db.prisma, args)).rejects.toMatchObject({ code: "P2002" });
    await archiveDenominationBatch(db.prisma, product.id, [first.id], true, null);
    await createDenomination(db.prisma, args);
    await expect(archiveDenominationBatch(db.prisma, product.id, [first.id], false, null)).rejects.toThrow("identity conflict");
    expect(await db.prisma.denomination.findUnique({ where: { id: first.id } })).toMatchObject({ isArchived: true, isActive: false });
  });
  it("migration preflight refuses legacy collisions without silently repairing records", async () => {
    const product = await createCatalogProduct(db.prisma, { categoryId, name: `Preflight ${categoryId}` });
    const code = sku();
    const args = { productId: product.id, name: "Legacy pack", type: "SHARED", durationLabel: "86", price: "100", supplierSku: code };
    const original = await createDenomination(db.prisma, args);
    await expect(db.prisma.$transaction(async tx => {
      // DDL and fixture writes roll back with the failed migration preflight.
      await tx.$executeRawUnsafe("DROP INDEX ix_denominations_supplier_identity");
      await createDenomination(tx, args);
      await tx.$executeRawUnsafe(identityPreflight!);
    })).rejects.toThrow("Duplicate supplier SKU ownership");
    expect(await db.prisma.denomination.count({ where: { supplierSku: code } })).toBe(1);
    expect(await db.prisma.denomination.findUnique({ where: { id: original.id } })).toMatchObject({ isArchived: false });
    await expect(createDenomination(db.prisma, args)).rejects.toMatchObject({ code: "P2002" });
  });
  it("43 rows become 41 consistently after deleting two, with no active/zero-stock count assumptions", async () => {
    const product = await createCatalogProduct(db.prisma, { categoryId, name: `Count ${categoryId}` });
    await db.prisma.denomination.createMany({ data: Array.from({ length: 43 }, (_, i) => ({ productId: product.id, name: `Count ${i}`, slug: `count-${product.id}-${i}`, type: "SHARED", durationLabel: String(i), price: "100", isActive: i % 2 === 0 })) });
    expect((await listProducts(db.prisma, categoryId))[0]!._count.denominations).toBe(43);
    const before = await getCatalogProductWithDenominations(db.prisma, product.id);
    expect(before!.denominations).toHaveLength(43);
    await archiveDenominationBatch(db.prisma, product.id, before!.denominations.slice(0, 2).map(d => d.id), true, null);
    expect((await listProducts(db.prisma, categoryId))[0]!._count.denominations).toBe(41);
    expect((await getCatalogProductWithDenominations(db.prisma, product.id))!.denominations).toHaveLength(41);
  });
  it("partial provider data and request errors preserve old rows and deleted SKUs stay excluded on resync", async () => {
    const code = sku();
    const deletedCode = sku();
    const brand = `Partial ${categoryId}`;
    const imported = await importDigiflazzBrand(db.prisma, { categoryId, brand, rows: [row(code), row(deletedCode)] });
    await db.prisma.product.update({ where: { id: imported.productId }, data: { isActive: true } });
    const rows = await db.prisma.denomination.findMany({ where: { productId: imported.productId }, orderBy: { id: "asc" } });
    await bulkSetDenominationsActive(db.prisma, rows.map(d => d.id), true);
    await archiveDenominationBatch(db.prisma, imported.productId, [rows[1]!.id], true, null);
    await setSetting(db.prisma, DIGIFLAZZ_USERNAME_KEY, "test-shop");
    await setSetting(db.prisma, DIGIFLAZZ_API_KEY_KEY, "test-key");
    const providerItem: DigiflazzPriceListItem = { buyerSkuCode: deletedCode, productName: "MOBILE LEGENDS 86 Indonesia", category: "Games", brand, type: "Umum", price: new Decimal("15000"), buyerProductStatus: true, sellerProductStatus: true, stock: null };
    // Use the production public entry with its mocked supplier function below.
    priceListMock.mockResolvedValue([providerItem]);
    await resyncDigiflazzCatalog(db.prisma);
    expect(await db.prisma.denomination.findUnique({ where: { id: rows[0]!.id } })).toMatchObject({ isActive: true, isArchived: false });
    expect(await db.prisma.denomination.findUnique({ where: { id: rows[1]!.id } })).toMatchObject({ isActive: false, isArchived: true });
    priceListMock.mockRejectedValue(new Error("provider timeout"));
    await expect(resyncDigiflazzCatalog(db.prisma)).rejects.toThrow("provider timeout");
    expect(await db.prisma.denomination.count({ where: { productId: imported.productId } })).toBe(2);
    for (const channel of ["web", "bot"] as const) {
      const visible = await listCatalogProducts(db.prisma, channel);
      expect(visible.flatMap(p => p.denominations).some(d => d.id === rows[1]!.id)).toBe(false);
    }
  });
  it.each([[], null, "1", [0], [-1], [1.2], ["1"], Array(501).fill(1)])("rejects malformed or empty batch %j", input => {
    expect(() => validateDenominationBatch(input)).toThrow();
  });
});

const { priceListMock } = vi.hoisted(() => ({ priceListMock: vi.fn() }));
vi.mock("@app/core/suppliers/digiflazz", async importOriginal => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()), getPriceList: priceListMock,
}));
