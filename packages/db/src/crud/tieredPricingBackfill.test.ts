/**
 * The `20261013090100_tiered_pricing_backfill` migration: every ACTIVE
 * bulk_pricing row becomes one PERCENTAGE tier and flips the SKU's
 * tiered_pricing_enabled; inactive rows are ignored; re-running is a no-op.
 * The SQL is read from the migration file itself so the test proves what ships.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createCategory, createCatalogProduct, createDenomination } from "../index";
import { ProductType } from "../../../core/src/enums";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

const sqlPath = join(
  __dirname,
  "../../../../prisma/migrations/20261013090100_tiered_pricing_backfill/migration.sql",
);

async function runBackfill() {
  const statements = readFileSync(sqlPath, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  expect(statements).toHaveLength(2);
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
}

describe("tiered pricing backfill migration", () => {
  it("migrates only active bulk_pricing rows, and is idempotent", async () => {
    const category = await createCategory(prisma, "Streaming", "🎬");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Netflix", description: "x" });
    const make = (name: string) =>
      createDenomination(prisma, {
        productId: parent.id,
        name,
        type: ProductType.SHARED,
        durationLabel: "1 Month",
        price: "5.00",
        warrantyDays: 30,
        description: "x",
      });
    const active = await make("Active SKU");
    const inactive = await make("Inactive SKU");
    await prisma.bulkPricing.create({
      data: { productId: active.id, minQuantity: 5, discountPercent: "12.5", isActive: true },
    });
    await prisma.bulkPricing.create({
      data: { productId: inactive.id, minQuantity: 3, discountPercent: "7", isActive: false },
    });

    await runBackfill();

    const tiers = await prisma.bulkPricingTier.findMany();
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toMatchObject({
      denominationId: active.id,
      minQuantity: 5,
      discountType: "PERCENTAGE",
      isEnabled: true,
    });
    expect(tiers[0]!.discountValue.toString()).toBe("12.5");
    const activeRow = await prisma.denomination.findUniqueOrThrow({ where: { id: active.id } });
    const inactiveRow = await prisma.denomination.findUniqueOrThrow({ where: { id: inactive.id } });
    expect(activeRow.tieredPricingEnabled).toBe(true);
    expect(inactiveRow.tieredPricingEnabled).toBe(false);

    await runBackfill();
    expect(await prisma.bulkPricingTier.count()).toBe(1);
  });

  it("skips active rows activeBulkPercent would refuse (percent <= 0 or > 100, threshold < 1) and leaves their toggle off", async () => {
    const category = await createCategory(prisma, "Games", "🎮");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Game", description: "x" });
    const make = (name: string) =>
      createDenomination(prisma, {
        productId: parent.id,
        name,
        type: ProductType.SHARED,
        durationLabel: "1 Month",
        price: "5.00",
        warrantyDays: 30,
        description: "x",
      });
    const invalid = [
      { minQuantity: 2, discountPercent: "0" },
      { minQuantity: 2, discountPercent: "-5" },
      { minQuantity: 2, discountPercent: "150" },
      { minQuantity: 0, discountPercent: "10" },
      { minQuantity: -1, discountPercent: "10" },
    ];
    const ids: number[] = [];
    for (const [index, rule] of invalid.entries()) {
      const d = await make(`Invalid ${index}`);
      ids.push(d.id);
      await prisma.bulkPricing.create({ data: { productId: d.id, ...rule, isActive: true } });
    }
    const edge = await make("Edge 100%");
    await prisma.bulkPricing.create({ data: { productId: edge.id, minQuantity: 1, discountPercent: "100", isActive: true } });

    await runBackfill();

    expect(await prisma.bulkPricingTier.count({ where: { denominationId: { in: ids } } })).toBe(0);
    const toggles = await prisma.denomination.findMany({ where: { id: { in: ids } }, select: { tieredPricingEnabled: true } });
    expect(toggles.every((d) => !d.tieredPricingEnabled)).toBe(true);
    // The boundary activeBulkPercent accepts (threshold 1, exactly 100%) is carried over.
    expect(await prisma.bulkPricingTier.count({ where: { denominationId: edge.id } })).toBe(1);
    expect((await prisma.denomination.findUniqueOrThrow({ where: { id: edge.id } })).tieredPricingEnabled).toBe(true);
  });
});
