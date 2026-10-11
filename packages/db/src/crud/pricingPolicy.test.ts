/**
 * Pricing policy persistence (Pricing & Margins, Task 2): the global rule +
 * rounding + low-margin settings, per-category markup rules, and the explicit
 * "Apply now" reprice of Digiflazz SKUs. Follows digiflazz.test.ts's
 * makeTestDb + resetDb/buildSampleData shape.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { CategoryGroup, ProductType } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { getSetting, setSetting } from "./settings";
import {
  DIGIFLAZZ_MARKUP_TYPE_KEY,
  DIGIFLAZZ_MARKUP_VALUE_KEY,
  DIGIFLAZZ_CATALOG_SYNC_LEASE_KEY,
  claimDigiflazzCatalogSyncLease,
  releaseDigiflazzCatalogSyncLease,
} from "./digiflazz";
import {
  PRICING_ROUNDING_KEY,
  PRICING_LOW_MARGIN_WARN_PCT_KEY,
  PricingValidationError,
  PricingPolicyUnreadableError,
  RepriceBusyError,
  RepriceLeaseLostError,
  getPricingPolicy,
  setGlobalPricing,
  setCategoryRule,
  clearCategoryRule,
  getCategoryRuleMap,
  computeRepriceImpact,
  applyReprice,
} from "./pricingPolicy";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let adminId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  adminId = sample.user.id;
});

const d = (v: Decimal.Value) => new Decimal(v);

async function audits(action?: string) {
  return prisma.auditLog.findMany({ where: action ? { action } : { action: { startsWith: "pricing_" } }, orderBy: { id: "asc" } });
}

async function makeCategory(name: string, group: string = CategoryGroup.GAME_TOPUP) {
  return createCategory(prisma, { name, group });
}

let skuSeq = 0;
async function makeSku(
  categoryId: number,
  opts: {
    cost: Decimal.Value | null;
    price: Decimal.Value;
    priceOverridden?: boolean;
    archived?: boolean;
    source?: string | null;
    supplierSku?: string | null;
  },
) {
  skuSeq++;
  const product = await createCatalogProduct(prisma, { categoryId, name: `Product ${skuSeq}` });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: `SKU ${skuSeq}`,
    type: ProductType.SHARED,
    durationLabel: "-",
    price: opts.price,
    costPrice: opts.cost,
    autoDeliverySource: opts.source === undefined ? "digiflazz" : opts.source,
    supplierSku: opts.supplierSku === undefined ? `DF${skuSeq}` : opts.supplierSku,
    priceOverridden: opts.priceOverridden ?? false,
  });
  if (opts.archived) await prisma.denomination.update({ where: { id: denom.id }, data: { isArchived: true } });
  return { ...denom, productName: product.name };
}

async function priceOf(id: number) {
  return (await prisma.denomination.findUniqueOrThrow({ where: { id } })).price;
}

describe("getPricingPolicy", () => {
  it("defaults to no markup, no rounding and no low-margin warning when nothing is stored", async () => {
    const p = await getPricingPolicy(prisma);
    expect(p.globalRuleReadable).toBe(true);
    expect(p.globalRule!.type).toBeNull();
    expect(p.globalRule!.value.toString()).toBe("0");
    expect(p.rounding).toBe("none");
    expect(p.roundingReadable).toBe(true);
    expect(p.lowMarginWarnPct).toBeNull();
  });

  it("reads blank stored values as the same defaults", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "");
    await setSetting(prisma, PRICING_ROUNDING_KEY, "");
    await setSetting(prisma, PRICING_LOW_MARGIN_WARN_PCT_KEY, "");
    const p = await getPricingPolicy(prisma);
    expect(p.globalRule!.type).toBeNull();
    expect(p.rounding).toBe("none");
    expect(p.lowMarginWarnPct).toBeNull();
  });

  it("surfaces an unreadable stored global markup instead of throwing", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "abc");
    const p = await getPricingPolicy(prisma);
    expect(p.globalRule).toBeNull();
    expect(p.globalRuleReadable).toBe(false);
    expect(p.globalRaw).toEqual({ type: "percent", value: "abc" });
  });

  it("surfaces an unknown stored rounding policy as unreadable", async () => {
    await setSetting(prisma, PRICING_ROUNDING_KEY, "ceil_7");
    const p = await getPricingPolicy(prisma);
    expect(p.rounding).toBe("none");
    expect(p.roundingReadable).toBe(false);
    expect(p.roundingRaw).toBe("ceil_7");
  });
});

describe("setGlobalPricing", () => {
  it("round-trips through settings and writes one natural-language audit sentence", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    const res = await setGlobalPricing(prisma, adminId, { markupType: "percent", markupValue: d("15"), rounding: "ceil_100" });
    expect(res.changed).toBe(true);
    expect(await getSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY)).toBe("percent");
    expect(await getSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY)).toBe("15");
    expect(await getSetting(prisma, PRICING_ROUNDING_KEY)).toBe("ceil_100");
    const p = await getPricingPolicy(prisma);
    expect(p.globalRule!.type).toBe("percent");
    expect(p.globalRule!.value.toString()).toBe("15");
    expect(p.rounding).toBe("ceil_100");
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adminId).toBe(adminId);
    expect(rows[0]!.details).toBe("Changed the default markup from 10% to 15% and rounding from none to round up to Rp100.");
  });

  it("describes a flat markup and the low-margin warning in plain words", async () => {
    await setGlobalPricing(prisma, adminId, { markupType: "flat", markupValue: d("1500"), lowMarginWarnPct: d("5") });
    expect(await getSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY)).toBe("1500");
    expect(await getSetting(prisma, PRICING_LOW_MARGIN_WARN_PCT_KEY)).toBe("5");
    expect((await getPricingPolicy(prisma)).lowMarginWarnPct!.toString()).toBe("5");
    const rows = await audits();
    expect(rows[0]!.details).toBe("Changed the default markup from no markup to a flat Rp1.500 and the low-margin warning from off to 5%.");
  });

  it("clears the markup and the warning back to blank", async () => {
    await setGlobalPricing(prisma, adminId, { markupType: "percent", markupValue: d("10"), lowMarginWarnPct: d("5") });
    await setGlobalPricing(prisma, adminId, { markupType: null, markupValue: d("0"), lowMarginWarnPct: null });
    expect(await getSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY)).toBe("");
    expect(await getSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY)).toBe("");
    expect(await getSetting(prisma, PRICING_LOW_MARGIN_WARN_PCT_KEY)).toBe("");
    const rows = await audits();
    expect(rows[1]!.details).toBe("Changed the default markup from 10% to no markup and the low-margin warning from 5% to off.");
  });

  it("leaves fields that are not passed untouched", async () => {
    await setGlobalPricing(prisma, adminId, { markupType: "percent", markupValue: d("12") });
    await setGlobalPricing(prisma, adminId, { rounding: "ceil_1000" });
    const p = await getPricingPolicy(prisma);
    expect(p.globalRule!.value.toString()).toBe("12");
    expect(p.rounding).toBe("ceil_1000");
    expect((await audits())[1]!.details).toBe("Changed rounding from none to round up to Rp1.000.");
  });

  it("is a no-op with no audit row when nothing changes", async () => {
    await setGlobalPricing(prisma, adminId, { markupType: "percent", markupValue: d("10"), rounding: "none" });
    const res = await setGlobalPricing(prisma, adminId, { markupType: "percent", markupValue: d("10.00"), rounding: "none", lowMarginWarnPct: null });
    expect(res.changed).toBe(false);
    expect(await audits()).toHaveLength(1);
  });

  it("names an unreadable old markup instead of guessing a number", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "abc");
    await setGlobalPricing(prisma, adminId, { markupType: "percent", markupValue: d("10") });
    expect((await audits())[0]!.details).toBe("Changed the default markup from an unreadable value to 10%.");
  });

  it("describes zero markups precisely instead of 'no markup to no markup'", async () => {
    await setGlobalPricing(prisma, adminId, { markupType: "percent", markupValue: d("0") });
    await setGlobalPricing(prisma, adminId, { markupType: "flat", markupValue: d("0") });
    expect((await audits()).map((r) => r.details)).toEqual([
      "Changed the default markup from no markup to 0%.",
      "Changed the default markup from 0% to a flat Rp0.",
    ]);
  });

  it("rejects out-of-range or fractional-rupiah markups", async () => {
    const bad = [
      { markupType: "percent" as const, markupValue: d("1000.0001") },
      { markupType: "percent" as const, markupValue: d("10.00001") },
      { markupType: "flat" as const, markupValue: d("100000001") },
      { markupType: "flat" as const, markupValue: d("1500.5") },
      { lowMarginWarnPct: d("5.00001") },
    ];
    for (const input of bad) {
      await expect(setGlobalPricing(prisma, adminId, input)).rejects.toBeInstanceOf(PricingValidationError);
    }
    await setGlobalPricing(prisma, adminId, { markupType: "percent", markupValue: d("1000") });
    await setGlobalPricing(prisma, adminId, { markupType: "flat", markupValue: d("100000000") });
    expect(await getSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY)).toBe("100000000");
  });

  it("rejects invalid input and writes nothing", async () => {
    const bad = [
      { rounding: "ceil_7" as never },
      { markupType: "percent" as const, markupValue: d("-1") },
      { markupType: "bogus" as never, markupValue: d("1") },
      { markupType: "percent" as const },
      { markupValue: d("5") },
      { lowMarginWarnPct: d("-1") },
      { lowMarginWarnPct: d("100") },
    ];
    for (const input of bad) {
      await expect(setGlobalPricing(prisma, adminId, input)).rejects.toBeInstanceOf(PricingValidationError);
    }
    expect(await getSetting(prisma, PRICING_ROUNDING_KEY)).toBeNull();
    expect(await getSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY)).toBeNull();
    expect(await audits()).toHaveLength(0);
  });
});

describe("category rules", () => {
  it("sets, reads back, no-ops and clears a rule with audit sentences", async () => {
    const cat = await makeCategory("Mobile Legends");
    await setCategoryRule(prisma, adminId, cat.id, { markupType: "percent", markupValue: d("10") });
    const row = await prisma.category.findUniqueOrThrow({ where: { id: cat.id } });
    expect(row.markupType).toBe("percent");
    expect(row.markupValue!.toString()).toBe("10");
    const map = await getCategoryRuleMap(prisma);
    expect(map.get(cat.id)!.type).toBe("percent");
    expect(map.get(cat.id)!.value.toString()).toBe("10");
    expect(map.has(sample.category.id)).toBe(false);

    const again = await setCategoryRule(prisma, adminId, cat.id, { markupType: "percent", markupValue: d("10.0") });
    expect(again.changed).toBe(false);

    await setCategoryRule(prisma, adminId, cat.id, { markupType: "flat", markupValue: d("2000") });
    await clearCategoryRule(prisma, adminId, cat.id);
    const cleared = await prisma.category.findUniqueOrThrow({ where: { id: cat.id } });
    expect(cleared.markupType).toBeNull();
    expect(cleared.markupValue).toBeNull();
    expect((await getCategoryRuleMap(prisma)).has(cat.id)).toBe(false);

    const rows = await audits();
    expect(rows.map((r) => r.details)).toEqual([
      'Set the markup for category "Mobile Legends" to 10% (it used the default markup before).',
      'Changed the markup for category "Mobile Legends" from 10% to a flat Rp2.000.',
      'Removed the markup for category "Mobile Legends" (it was a flat Rp2.000); it now uses the default markup.',
    ]);
    expect(rows.every((r) => r.targetType === "category" && r.targetId === cat.id && r.adminId === adminId)).toBe(true);
  });

  it("treats both-null as a clear and a clear of an inheriting category as a no-op", async () => {
    const cat = await makeCategory("Free Fire");
    const res = await setCategoryRule(prisma, adminId, cat.id, { markupType: null, markupValue: null });
    expect(res.changed).toBe(false);
    expect(await audits()).toHaveLength(0);
  });

  it("requires type and value together, a known type and a value of zero or more", async () => {
    const cat = await makeCategory("PUBG");
    const bad = [
      { markupType: "percent" as const, markupValue: null },
      { markupType: null, markupValue: d("5") },
      { markupType: "bogus" as never, markupValue: d("5") },
      { markupType: "flat" as const, markupValue: d("-1") },
      { markupType: "flat" as const, markupValue: d("10.5") },
      { markupType: "flat" as const, markupValue: d("100000001") },
      { markupType: "percent" as const, markupValue: d("1001") },
    ];
    for (const rule of bad) {
      await expect(setCategoryRule(prisma, adminId, cat.id, rule)).rejects.toBeInstanceOf(PricingValidationError);
    }
    await expect(setCategoryRule(prisma, adminId, 999_999, { markupType: "percent", markupValue: d("5") })).rejects.toBeInstanceOf(
      PricingValidationError,
    );
    const row = await prisma.category.findUniqueOrThrow({ where: { id: cat.id } });
    expect(row.markupType).toBeNull();
    expect(await audits()).toHaveLength(0);
  });
});

/** Global 10%; `ruled` category 20%; `plain` inherits. */
async function seedRepriceCatalog() {
  await setGlobalPricing(prisma, adminId, { markupType: "percent", markupValue: d("10") });
  const ruled = await makeCategory("Ruled Game");
  const plain = await makeCategory("Plain Game");
  const premium = await makeCategory("Premium", CategoryGroup.PREMIUM_APPS);
  await setCategoryRule(prisma, adminId, ruled.id, { markupType: "percent", markupValue: d("20") });
  const a = await makeSku(ruled.id, { cost: "100000", price: "100000" }); // → 120000
  const b = await makeSku(plain.id, { cost: "100000", price: "110000" }); // already 110000
  const g = await makeSku(plain.id, { cost: "50000", price: "50000", source: null }); // legacy null source → 55000
  const overridden = await makeSku(plain.id, { cost: "100000", price: "999", priceOverridden: true });
  const noCost = await makeSku(plain.id, { cost: null, price: "777" });
  const archived = await makeSku(plain.id, { cost: "100000", price: "1" , archived: true });
  const otherSupplier = await makeSku(plain.id, { cost: "100000", price: "2", source: "kokinpay" });
  const premiumManual = await makeSku(premium.id, { cost: "50000", price: "60000", source: null, supplierSku: null });
  await prisma.auditLog.deleteMany();
  return { ruled, plain, premium, a, b, g, overridden, noCost, archived, otherSupplier, premiumManual };
}

describe("computeRepriceImpact", () => {
  it("counts only eligible Digiflazz SKUs and prices each from its own category rule or the default", async () => {
    const s = await seedRepriceCatalog();
    const impact = await computeRepriceImpact(prisma, "all");
    expect(impact.eligibleCount).toBe(3);
    expect(impact.changedCount).toBe(2);
    const byId = new Map(impact.sample.map((r) => [r.denominationId, r]));
    expect([...byId.keys()].sort()).toEqual([s.a.id, s.g.id].sort());
    expect(byId.get(s.a.id)!.newPrice.toString()).toBe("120000");
    expect(byId.get(s.a.id)!.oldPrice.toString()).toBe("100000");
    expect(byId.get(s.a.id)!.cost.toString()).toBe("100000");
    expect(byId.get(s.a.id)!.name).toBe(s.a.name);
    expect(byId.get(s.a.id)!.productName).toBe(s.a.productName);
    expect(byId.get(s.g.id)!.newPrice.toString()).toBe("55000");
  });

  it("narrows to one category", async () => {
    const s = await seedRepriceCatalog();
    const impact = await computeRepriceImpact(prisma, s.ruled.id);
    expect(impact.eligibleCount).toBe(1);
    expect(impact.changedCount).toBe(1);
    const premium = await computeRepriceImpact(prisma, s.premium.id);
    expect(premium).toMatchObject({ eligibleCount: 0, changedCount: 0, sample: [] });
  });

  it("caps the sample at 10 rows", async () => {
    await setGlobalPricing(prisma, adminId, { markupType: "flat", markupValue: d("100") });
    const cat = await makeCategory("Bulk");
    for (let i = 0; i < 12; i++) await makeSku(cat.id, { cost: "1000", price: "1000" });
    const impact = await computeRepriceImpact(prisma, "all");
    expect(impact.changedCount).toBe(12);
    expect(impact.sample).toHaveLength(10);
  });

  it("refuses to price from an unreadable global markup or rounding", async () => {
    await seedRepriceCatalog();
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "abc");
    await expect(computeRepriceImpact(prisma, "all")).rejects.toBeInstanceOf(PricingPolicyUnreadableError);
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    await setSetting(prisma, PRICING_ROUNDING_KEY, "ceil_7");
    await expect(computeRepriceImpact(prisma, "all")).rejects.toBeInstanceOf(PricingPolicyUnreadableError);
  });
});

describe("applyReprice", () => {
  it("writes only changed prices, never touches excluded rows, audits once and is idempotent", async () => {
    const s = await seedRepriceCatalog();
    const first = await applyReprice(prisma, adminId, "all");
    expect(first).toEqual({ eligibleCount: 3, updatedCount: 2, unchangedCount: 1, skippedCount: 0 });
    expect((await priceOf(s.a.id)).toString()).toBe("120000");
    expect((await priceOf(s.b.id)).toString()).toBe("110000");
    expect((await priceOf(s.g.id)).toString()).toBe("55000");
    expect((await priceOf(s.overridden.id)).toString()).toBe("999");
    expect((await priceOf(s.noCost.id)).toString()).toBe("777");
    expect((await priceOf(s.archived.id)).toString()).toBe("1");
    expect((await priceOf(s.otherSupplier.id)).toString()).toBe("2");
    expect((await priceOf(s.premiumManual.id)).toString()).toBe("60000");
    const overriddenRow = await prisma.denomination.findUniqueOrThrow({ where: { id: s.overridden.id } });
    expect(overriddenRow.priceOverridden).toBe(true);

    let rows = await audits("pricing_reprice");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adminId).toBe(adminId);
    expect(rows[0]!.details).toBe("Repriced 2 Digiflazz items from the current pricing rules; 1 was already up to date.");

    const second = await applyReprice(prisma, adminId, "all");
    expect(second).toEqual({ eligibleCount: 3, updatedCount: 0, unchangedCount: 3, skippedCount: 0 });
    rows = await audits("pricing_reprice");
    expect(rows[1]!.details).toBe("Checked 3 Digiflazz items against the current pricing rules; 3 were already up to date.");
  });

  it("applies the rounding policy and names the category in a category-scoped audit", async () => {
    await setGlobalPricing(prisma, adminId, { markupType: null, markupValue: d("0"), rounding: "ceil_1000" });
    const cat = await makeCategory("Genshin");
    const other = await makeCategory("Other");
    const sku = await makeSku(cat.id, { cost: "100001", price: "100001" });
    const untouched = await makeSku(other.id, { cost: "100001", price: "100001" });
    const res = await applyReprice(prisma, adminId, cat.id);
    expect(res.updatedCount).toBe(1);
    expect((await priceOf(sku.id)).toString()).toBe("101000");
    expect((await priceOf(untouched.id)).toString()).toBe("100001");
    expect((await audits("pricing_reprice"))[0]!.details).toBe(
      'Repriced 1 Digiflazz item in category "Genshin" from the current pricing rules; 0 were already up to date.',
    );
  });

  it("refuses with RepriceBusyError while a catalog sync holds the lease, and frees the lease afterwards", async () => {
    const s = await seedRepriceCatalog();
    const token = await claimDigiflazzCatalogSyncLease(prisma);
    expect(token).not.toBeNull();
    await expect(applyReprice(prisma, adminId, "all")).rejects.toBeInstanceOf(RepriceBusyError);
    expect((await priceOf(s.a.id)).toString()).toBe("100000");
    expect(await audits("pricing_reprice")).toHaveLength(0);
    await releaseDigiflazzCatalogSyncLease(prisma, token!);

    await applyReprice(prisma, adminId, "all");
    const again = await claimDigiflazzCatalogSyncLease(prisma);
    expect(again).not.toBeNull();
  });

  it("counts a row that turned manual between listing and locking as skipped and leaves it alone", async () => {
    const s = await seedRepriceCatalog();
    const res = await applyReprice(prisma, adminId, "all", new Date(), {
      beforeBatch: async () => {
        await prisma.denomination.update({ where: { id: s.a.id }, data: { priceOverridden: true } });
      },
    });
    expect(res).toEqual({ eligibleCount: 3, updatedCount: 1, unchangedCount: 1, skippedCount: 1 });
    expect((await priceOf(s.a.id)).toString()).toBe("100000");
    expect((await priceOf(s.g.id)).toString()).toBe("55000");
    expect((await audits("pricing_reprice"))[0]!.details).toBe(
      "Repriced 1 Digiflazz item from the current pricing rules; 1 was already up to date. 1 item was skipped because it changed while repricing.",
    );
  });

  async function seedFlatBatchCatalog(n: number) {
    await setGlobalPricing(prisma, adminId, { markupType: "flat", markupValue: d("100") });
    const cat = await makeCategory("Batches");
    const skus = [];
    for (let i = 0; i < n; i++) skus.push(await makeSku(cat.id, { cost: "1000", price: "1000" }));
    await prisma.auditLog.deleteMany();
    return skus;
  }

  it("keeps an audit row for batches already committed when a later batch fails, and releases the lease", async () => {
    const skus = await seedFlatBatchCatalog(5);
    const boom = new Error("simulated database failure");
    await expect(
      applyReprice(prisma, adminId, "all", new Date(), {
        batchSize: 2,
        beforeBatch: async (index) => {
          if (index === 1) throw boom;
        },
      }),
    ).rejects.toBe(boom);
    const prices = await Promise.all(skus.map((s) => priceOf(s.id)));
    expect(prices.map((p) => p.toString())).toEqual(["1100", "1100", "1000", "1000", "1000"]);
    const rows = await audits("pricing_reprice");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toBe("Repriced 2 Digiflazz items before the run stopped on an error; the rest were not changed.");
    expect(await claimDigiflazzCatalogSyncLease(prisma)).not.toBeNull();
  });

  it("stops with RepriceLeaseLostError when the sync lease is taken over mid-run", async () => {
    const skus = await seedFlatBatchCatalog(4);
    await expect(
      applyReprice(prisma, adminId, "all", new Date(), {
        batchSize: 2,
        beforeBatch: async (index) => {
          if (index === 1) {
            await prisma.setting.update({ where: { key: DIGIFLAZZ_CATALOG_SYNC_LEASE_KEY }, data: { value: "another-sync" } });
          }
        },
      }),
    ).rejects.toBeInstanceOf(RepriceLeaseLostError);
    const prices = await Promise.all(skus.map((s) => priceOf(s.id)));
    expect(prices.map((p) => p.toString())).toEqual(["1100", "1100", "1000", "1000"]);
    expect((await audits("pricing_reprice"))[0]!.details).toBe(
      "Repriced 2 Digiflazz items before the run stopped on an error; the rest were not changed.",
    );
    // The new holder's lease is not released by the stopped run.
    const lease = await prisma.setting.findUniqueOrThrow({ where: { key: DIGIFLAZZ_CATALOG_SYNC_LEASE_KEY } });
    expect(lease.value).toBe("another-sync");
  });

  it("renews the lease at every batch so a long run keeps it", async () => {
    await seedFlatBatchCatalog(2);
    const start = new Date(Date.now() - 60 * 60_000);
    await applyReprice(prisma, adminId, "all", start, {
      batchSize: 1,
      beforeBatch: async (index) => {
        if (index === 1) {
          const lease = await prisma.setting.findUniqueOrThrow({ where: { key: DIGIFLAZZ_CATALOG_SYNC_LEASE_KEY } });
          expect(lease.updatedAt.getTime()).toBeGreaterThan(start.getTime());
        }
      },
    });
  });

  it("refuses with PricingPolicyUnreadableError on an unreadable global markup and changes nothing", async () => {
    const s = await seedRepriceCatalog();
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "abc");
    await expect(applyReprice(prisma, adminId, "all")).rejects.toBeInstanceOf(PricingPolicyUnreadableError);
    expect((await priceOf(s.a.id)).toString()).toBe("100000");
    expect(await claimDigiflazzCatalogSyncLease(prisma)).not.toBeNull();
  });
});
