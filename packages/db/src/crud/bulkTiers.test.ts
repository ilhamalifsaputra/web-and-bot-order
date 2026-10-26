/**
 * Volume pricing tiers — the crud layer (crud/bulkTiers.ts): validation,
 * ordering, the on/off toggle, the audit trail, and the legacy single-rule
 * adapters (upsertBulkPricing / deleteBulkPricing / getBulkPricingForDenomination)
 * that now write the tiers AND keep the old bulk_pricing row as a mirror.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import { TieredPricingError } from "@app/core/bulk";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  listTiers,
  replaceTiers,
  setTieredPricingEnabled,
  saveTieredPricing,
  getEffectiveTiers,
  activeTiersByDenomination,
  priceLineWithTiers,
  upsertBulkPricing,
  deleteBulkPricing,
  getBulkPricingForDenomination,
  activeBulkPricingByDenomination,
  LegacyBulkRuleConflictError,
  resetInvalidTierWarningsForTests,
} from "@app/db";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
// audit_logs.admin_id references users, so the acting admin is a real row.
let actor: { adminId: number };

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
  actor = { adminId: sample.user.id };
});

const THREE_TIERS = [
  { minQuantity: 5, discountType: "FIXED_UNIT_PRICE", discountValue: "6000" },
  { minQuantity: 2, discountType: "PERCENTAGE", discountValue: "10" },
  { minQuantity: 3, discountType: "FIXED_UNIT_PRICE", discountValue: "8000" },
];

describe("replaceTiers", () => {
  it("stores the set sorted by minQuantity with sortOrder 0..n-1, and writes one plain-language audit entry", async () => {
    const id = sample.product.id;
    const saved = await replaceTiers(prisma, id, THREE_TIERS, actor);

    expect(saved.map((t) => t.minQuantity)).toEqual([2, 3, 5]);
    expect(saved.map((t) => t.sortOrder)).toEqual([0, 1, 2]);
    expect(saved.map((t) => t.discountType)).toEqual(["PERCENTAGE", "FIXED_UNIT_PRICE", "FIXED_UNIT_PRICE"]);
    expect(saved.every((t) => typeof t.id === "string" && t.isEnabled)).toBe(true);
    expect((await listTiers(prisma, id)).map((t) => new Decimal(t.discountValue).toString())).toEqual(["10", "8000", "6000"]);

    const audit = await prisma.auditLog.findMany({ where: { action: "pricing_tiers_replace" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.adminId).toBe(actor.adminId);
    expect(audit[0]!.targetType).toBe("denomination");
    expect(audit[0]!.targetId).toBe(id);
    expect(audit[0]!.details).toBe(
      'Saved 3 volume pricing tiers for "Netflix Premium 1M": 2+ units: 10% off; 3+ units: Rp8.000 per unit; 5+ units: Rp6.000 per unit.',
    );
    expect(audit[0]!.details).not.toMatch(/=/);
  });

  it("keeps the id of a tier whose threshold is unchanged, and removes thresholds no longer listed", async () => {
    const id = sample.product.id;
    const first = await replaceTiers(prisma, id, THREE_TIERS, actor);
    const second = await replaceTiers(
      prisma,
      id,
      [
        { minQuantity: 3, discountType: "FIXED_AMOUNT_OFF_PER_UNIT", discountValue: "500" },
        { minQuantity: 10, discountType: "PERCENTAGE", discountValue: "20", isEnabled: false },
      ],
      actor,
    );
    expect(second.map((t) => t.minQuantity)).toEqual([3, 10]);
    expect(second[0]!.id).toBe(first.find((t) => t.minQuantity === 3)!.id);
    expect(second[0]!.discountType).toBe("FIXED_AMOUNT_OFF_PER_UNIT");
    expect(second[1]!.isEnabled).toBe(false);
    expect(await prisma.bulkPricingTier.count({ where: { denominationId: id } })).toBe(2);
  });

  it("an empty list removes every tier and says so in the audit log", async () => {
    const id = sample.product.id;
    await replaceTiers(prisma, id, THREE_TIERS, actor);
    expect(await replaceTiers(prisma, id, [], actor)).toEqual([]);
    const last = await prisma.auditLog.findFirst({ where: { action: "pricing_tiers_replace" }, orderBy: { id: "desc" } });
    expect(last!.details).toBe('Removed every volume pricing tier from "Netflix Premium 1M".');
  });

  it.each([
    ["a duplicate threshold", [{ minQuantity: 2, discountType: "PERCENTAGE", discountValue: "5" }, { minQuantity: 2, discountType: "PERCENTAGE", discountValue: "6" }], "DUPLICATE_MIN_QUANTITY"],
    ["a threshold of 0", [{ minQuantity: 0, discountType: "PERCENTAGE", discountValue: "5" }], "INVALID_MIN_QUANTITY"],
    ["a fractional threshold", [{ minQuantity: 2.5, discountType: "PERCENTAGE", discountValue: "5" }], "INVALID_MIN_QUANTITY"],
    ["a percent above 100", [{ minQuantity: 2, discountType: "PERCENTAGE", discountValue: "101" }], "INVALID_PERCENTAGE"],
    ["a zero value", [{ minQuantity: 2, discountType: "FIXED_UNIT_PRICE", discountValue: "0" }], "INVALID_VALUE"],
    ["a negative value", [{ minQuantity: 2, discountType: "FIXED_AMOUNT_OFF_PER_UNIT", discountValue: "-1" }], "INVALID_VALUE"],
    ["an unparseable value", [{ minQuantity: 2, discountType: "PERCENTAGE", discountValue: "abc" }], "INVALID_VALUE"],
    ["a percent that rounds to 0", [{ minQuantity: 2, discountType: "PERCENTAGE", discountValue: "0.001" }], "INVALID_VALUE"],
    ["an unknown type", [{ minQuantity: 2, discountType: "BOGO", discountValue: "1" }], "UNKNOWN_TYPE"],
    // Refused, not rounded: the stored tier must be the one the admin typed.
    ["a fractional rupiah unit price", [{ minQuantity: 2, discountType: "FIXED_UNIT_PRICE", discountValue: "8000.5" }], "INVALID_VALUE"],
    ["a fractional rupiah amount off", [{ minQuantity: 2, discountType: "FIXED_AMOUNT_OFF_PER_UNIT", discountValue: "999.5" }], "INVALID_VALUE"],
    ["a percent with 3 decimals", [{ minQuantity: 2, discountType: "PERCENTAGE", discountValue: "12.345" }], "INVALID_VALUE"],
  ])("refuses %s and writes nothing", async (_label, tiers, code) => {
    const id = sample.product.id;
    const err = await replaceTiers(prisma, id, tiers, actor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TieredPricingError);
    expect((err as TieredPricingError).errors.map((e) => e.code)).toContain(code);
    expect(await prisma.bulkPricingTier.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "pricing_tiers_replace" } })).toBe(0);
  });

  it("accepts the precision it stores: whole rupiah amounts and a 2-decimal percent", async () => {
    const saved = await replaceTiers(
      prisma,
      sample.product.id,
      [
        { minQuantity: 2, discountType: "PERCENTAGE", discountValue: "12.25" },
        { minQuantity: 3, discountType: "FIXED_AMOUNT_OFF_PER_UNIT", discountValue: "1000.00" },
        { minQuantity: 5, discountType: "FIXED_UNIT_PRICE", discountValue: 6000 },
      ],
      actor,
    );
    expect(saved.map((t) => new Decimal(t.discountValue).toString())).toEqual(["12.25", "1000", "6000"]);
  });

  it("refuses an unknown denomination", async () => {
    await expect(replaceTiers(prisma, 999999, THREE_TIERS, actor)).rejects.toMatchObject({ key: "error.product_unavailable" });
  });
});

describe("saveTieredPricing (the admin editor's one save)", () => {
  const auditActions = async () =>
    (await prisma.auditLog.findMany({ orderBy: { id: "asc" } })).map((a) => a.action);

  it("writes the tiers and the toggle together, auditing each change once", async () => {
    const id = sample.product.id;
    const result = await saveTieredPricing(prisma, id, { enabled: true, tiers: THREE_TIERS }, actor);

    expect(result.enabled).toBe(true);
    expect(result.tiers.map((t) => t.minQuantity)).toEqual([2, 3, 5]);
    expect((await getEffectiveTiers(prisma, id)).map((t) => t.minQuantity)).toEqual([2, 3, 5]);
    expect(await auditActions()).toEqual(["pricing_tiers_replace", "tiered_pricing_toggle"]);
  });

  it("a toggle-only save leaves the unchanged tiers alone (no tier audit line)", async () => {
    const id = sample.product.id;
    await saveTieredPricing(prisma, id, { enabled: true, tiers: THREE_TIERS }, actor);
    const before = await listTiers(prisma, id);

    await saveTieredPricing(prisma, id, { enabled: false, tiers: THREE_TIERS }, actor);
    expect(await listTiers(prisma, id)).toEqual(before);
    expect(await getEffectiveTiers(prisma, id)).toEqual([]);
    expect(await auditActions()).toEqual(["pricing_tiers_replace", "tiered_pricing_toggle", "tiered_pricing_toggle"]);
  });

  it("an unchanged save writes nothing and audits nothing", async () => {
    const id = sample.product.id;
    await saveTieredPricing(prisma, id, { enabled: true, tiers: THREE_TIERS }, actor);
    await saveTieredPricing(prisma, id, { enabled: true, tiers: [...THREE_TIERS].reverse() }, actor);
    expect(await auditActions()).toEqual(["pricing_tiers_replace", "tiered_pricing_toggle"]);
  });

  it("an invalid tier set changes neither the tiers nor the toggle", async () => {
    const id = sample.product.id;
    await expect(
      saveTieredPricing(
        prisma,
        id,
        { enabled: true, tiers: [...THREE_TIERS, { minQuantity: 3, discountType: "PERCENTAGE", discountValue: "5" }] },
        actor,
      ),
    ).rejects.toBeInstanceOf(TieredPricingError);
    expect(await listTiers(prisma, id)).toEqual([]);
    expect((await prisma.denomination.findUniqueOrThrow({ where: { id } })).tieredPricingEnabled).toBe(false);
    expect(await auditActions()).toEqual([]);
  });
});

describe("concurrent saves of one denomination", () => {
  const SET_A = [
    { minQuantity: 2, discountType: "PERCENTAGE", discountValue: "5" },
    { minQuantity: 10, discountType: "PERCENTAGE", discountValue: "20" },
  ];
  const SET_B = [
    { minQuantity: 2, discountType: "PERCENTAGE", discountValue: "5" },
    { minQuantity: 5, discountType: "PERCENTAGE", discountValue: "10" },
  ];
  const thresholds = async (id: number) => (await listTiers(prisma, id)).map((t) => t.minQuantity);

  it.each([
    ["saveTieredPricing", (id: number, tiers: typeof SET_A) => saveTieredPricing(prisma, id, { enabled: true, tiers }, actor)],
    ["replaceTiers", (id: number, tiers: typeof SET_A) => replaceTiers(prisma, id, tiers, actor)],
  ])("%s: the final set is exactly one of the two, never a merge, and neither call fails", async (_label, save) => {
    const id = sample.product.id;
    for (let round = 0; round < 5; round++) {
      // Start from a set both saves must diff against (3 is dropped by both).
      await replaceTiers(prisma, id, [
        { minQuantity: 2, discountType: "PERCENTAGE", discountValue: "5" },
        { minQuantity: 3, discountType: "PERCENTAGE", discountValue: "8" },
      ], actor);
      const results = await Promise.allSettled([save(id, SET_A), save(id, SET_B)]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      expect([[2, 10], [2, 5]]).toContainEqual(await thresholds(id));
    }
  });

  it("two first-ever saves of the same threshold do not surface a unique-index error", async () => {
    const id = sample.product.id;
    const results = await Promise.allSettled([replaceTiers(prisma, id, SET_A, actor), replaceTiers(prisma, id, SET_B, actor)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect([[2, 10], [2, 5]]).toContainEqual(await thresholds(id));
  });
});

describe("tiered pricing toggle", () => {
  it("tiers price nothing until the toggle is on; switching it off keeps the tiers but ignores them", async () => {
    const id = sample.product.id;
    await replaceTiers(prisma, id, THREE_TIERS, actor);
    expect(await getEffectiveTiers(prisma, id)).toEqual([]);

    await setTieredPricingEnabled(prisma, id, true, actor);
    expect((await getEffectiveTiers(prisma, id)).map((t) => t.minQuantity)).toEqual([2, 3, 5]);
    expect(Object.keys(await activeTiersByDenomination(prisma, [id]))).toEqual([String(id)]);

    await setTieredPricingEnabled(prisma, id, false, actor);
    expect(await getEffectiveTiers(prisma, id)).toEqual([]);
    expect(await activeTiersByDenomination(prisma, [id])).toEqual({});
    expect(await listTiers(prisma, id)).toHaveLength(3);

    const audit = await prisma.auditLog.findMany({ where: { action: "tiered_pricing_toggle" }, orderBy: { id: "asc" } });
    expect(audit.map((a) => a.details)).toEqual([
      'Turned on volume pricing for "Netflix Premium 1M".',
      'Turned off volume pricing for "Netflix Premium 1M"; its tiers are kept but no longer discount orders.',
    ]);
    expect(audit.every((a) => a.adminId === actor.adminId && a.targetId === id)).toBe(true);
  });

  it("disabled tiers are left out of the effective set", async () => {
    const id = sample.product.id;
    await replaceTiers(
      prisma,
      id,
      [
        { minQuantity: 2, discountType: "PERCENTAGE", discountValue: "10" },
        { minQuantity: 3, discountType: "PERCENTAGE", discountValue: "30", isEnabled: false },
      ],
      actor,
    );
    await setTieredPricingEnabled(prisma, id, true, actor);
    expect((await getEffectiveTiers(prisma, id)).map((t) => t.minQuantity)).toEqual([2]);
  });

  it("a stored tier the engine would refuse (hand-written row) is ignored on read instead of failing checkout", async () => {
    const id = sample.product.id;
    await prisma.denomination.update({ where: { id }, data: { tieredPricingEnabled: true } });
    await prisma.bulkPricingTier.createMany({
      data: [
        { denominationId: id, minQuantity: 2, discountType: "PERCENTAGE", discountValue: "150" },
        { denominationId: id, minQuantity: 3, discountType: "PERCENTAGE", discountValue: "10" },
      ],
    });
    expect((await getEffectiveTiers(prisma, id)).map((t) => t.minQuantity)).toEqual([3]);
  });

  it("an invalid stored tier is reported once per denomination, not on every read", async () => {
    resetInvalidTierWarningsForTests();
    const id = sample.product.id;
    await prisma.denomination.update({ where: { id }, data: { tieredPricingEnabled: true } });
    await prisma.bulkPricingTier.create({ data: { denominationId: id, minQuantity: 2, discountType: "PERCENTAGE", discountValue: "150" } });
    const warn = vi.spyOn(logger, "warn");
    try {
      for (let i = 0; i < 3; i++) expect(await getEffectiveTiers(prisma, id)).toEqual([]);
      const reports = warn.mock.calls.filter((args) => String(args[1] ?? args[0]).includes("stored volume pricing tiers"));
      expect(reports).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("priceLineWithTiers", () => {
  it("prices 1..6 units under 10000 / 10% at 2 / 8000 at 3 / 6000 at 5", async () => {
    const denomination = { ...sample.product, price: new Decimal("10000"), resellerPrice: null };
    const tiers = await replaceTiers(prisma, sample.product.id, THREE_TIERS, actor);
    const totals = [1, 2, 3, 4, 5, 6].map((quantity) =>
      priceLineWithTiers({ denomination, quantity, isReseller: false, now: new Date(), tiers }).finalSubtotal.toString(),
    );
    expect(totals).toEqual(["10000", "18000", "24000", "32000", "30000", "36000"]);
  });
});

describe("legacy single-rule adapters", () => {
  it.each([
    ["several tiers", THREE_TIERS],
    ["one fixed-amount tier", [{ minQuantity: 3, discountType: "FIXED_UNIT_PRICE", discountValue: "8000" }]],
  ])("refuses to replace or delete %s (not one legacy percentage rule) and changes nothing", async (_label, tiers) => {
    const id = sample.product.id;
    await replaceTiers(prisma, id, tiers, actor);
    await setTieredPricingEnabled(prisma, id, true, actor);
    const before = await listTiers(prisma, id);

    await expect(upsertBulkPricing(prisma, { denominationId: id, minQuantity: 4, discountPercent: "12.5" })).rejects.toBeInstanceOf(
      LegacyBulkRuleConflictError,
    );
    await expect(deleteBulkPricing(prisma, id)).rejects.toBeInstanceOf(LegacyBulkRuleConflictError);
    expect(await listTiers(prisma, id)).toEqual(before);
    expect((await prisma.denomination.findUniqueOrThrow({ where: { id } })).tieredPricingEnabled).toBe(true);
  });

  it("upsertBulkPricing writes one PERCENTAGE tier, turns tiered pricing on, and still writes the bulk_pricing row", async () => {
    const id = sample.product.id;
    await replaceTiers(prisma, id, [{ minQuantity: 2, discountType: "PERCENTAGE", discountValue: "10" }], actor);
    const row = await upsertBulkPricing(prisma, { denominationId: id, minQuantity: 4, discountPercent: "12.5" });

    expect(row.productId).toBe(id);
    expect(row.minQuantity).toBe(4);
    expect(row.discountPercent.toString()).toBe("12.5");
    expect(row.isActive).toBe(true);

    const tiers = await listTiers(prisma, id);
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toMatchObject({ minQuantity: 4, discountType: "PERCENTAGE", isEnabled: true });
    expect(new Decimal(tiers[0]!.discountValue).toString()).toBe("12.5");
    expect((await prisma.denomination.findUniqueOrThrow({ where: { id } })).tieredPricingEnabled).toBe(true);

    const legacy = await prisma.bulkPricing.findUniqueOrThrow({ where: { productId: id } });
    expect(legacy.minQuantity).toBe(4);
    expect(legacy.discountPercent.toString()).toBe("12.5");

    const view = await getBulkPricingForDenomination(prisma, id);
    expect(view).toMatchObject({ productId: id, minQuantity: 4, isActive: true });
    expect(view!.discountPercent.toString()).toBe("12.5");
  });

  it("deleteBulkPricing clears the row and every tier, turns tiered pricing off, and reports whether anything was removed", async () => {
    const id = sample.product.id;
    await upsertBulkPricing(prisma, { denominationId: id, minQuantity: 2, discountPercent: 10 });
    expect(await deleteBulkPricing(prisma, id)).toBe(true);
    expect(await prisma.bulkPricing.count({ where: { productId: id } })).toBe(0);
    expect(await prisma.bulkPricingTier.count({ where: { denominationId: id } })).toBe(0);
    expect((await prisma.denomination.findUniqueOrThrow({ where: { id } })).tieredPricingEnabled).toBe(false);
    expect(await getBulkPricingForDenomination(prisma, id)).toBeNull();
    expect(await deleteBulkPricing(prisma, id)).toBe(false);
  });

  it("the tiers are authoritative: the legacy view and the bulk_pricing mirror follow the lowest enabled PERCENTAGE tier", async () => {
    const id = sample.product.id;
    await upsertBulkPricing(prisma, { denominationId: id, minQuantity: 2, discountPercent: 10 });
    await replaceTiers(
      prisma,
      id,
      [
        { minQuantity: 2, discountType: "FIXED_UNIT_PRICE", discountValue: "4" },
        { minQuantity: 3, discountType: "PERCENTAGE", discountValue: "15" },
        { minQuantity: 6, discountType: "PERCENTAGE", discountValue: "25" },
      ],
      actor,
    );
    const view = await getBulkPricingForDenomination(prisma, id);
    expect(view!.minQuantity).toBe(3);
    expect(view!.discountPercent.toString()).toBe("15");
    const mirror = await prisma.bulkPricing.findUniqueOrThrow({ where: { productId: id } });
    expect(mirror).toMatchObject({ minQuantity: 3, isActive: true });
    expect(mirror.discountPercent.toString()).toBe("15");
    expect((await activeBulkPricingByDenomination(prisma))[id]?.minQuantity).toBe(3);

    // Only fixed-amount tiers left: no percent to show, mirror deactivated.
    await replaceTiers(prisma, id, [{ minQuantity: 2, discountType: "FIXED_UNIT_PRICE", discountValue: "4" }], actor);
    expect(await getBulkPricingForDenomination(prisma, id)).toBeNull();
    expect((await prisma.bulkPricing.findUniqueOrThrow({ where: { productId: id } })).isActive).toBe(false);
    expect((await activeBulkPricingByDenomination(prisma))[id]).toBeUndefined();
  });

  it("switching tiered pricing off hides the legacy view and deactivates the mirror; switching it on restores both", async () => {
    const id = sample.product.id;
    await upsertBulkPricing(prisma, { denominationId: id, minQuantity: 2, discountPercent: 10 });
    await setTieredPricingEnabled(prisma, id, false, actor);
    expect(await getBulkPricingForDenomination(prisma, id)).toBeNull();
    expect((await prisma.bulkPricing.findUniqueOrThrow({ where: { productId: id } })).isActive).toBe(false);

    await setTieredPricingEnabled(prisma, id, true, actor);
    expect((await getBulkPricingForDenomination(prisma, id))!.minQuantity).toBe(2);
    expect((await prisma.bulkPricing.findUniqueOrThrow({ where: { productId: id } })).isActive).toBe(true);
  });

  it("adapters join the caller's transaction (the bot admin passes a tx)", async () => {
    const id = sample.product.id;
    await expect(
      prisma.$transaction(async (tx) => {
        await upsertBulkPricing(tx, { denominationId: id, minQuantity: 2, discountPercent: 10 });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await prisma.bulkPricing.count()).toBe(0);
    expect(await prisma.bulkPricingTier.count()).toBe(0);
  });
});
