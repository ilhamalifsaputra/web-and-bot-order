/**
 * CRUD tests for ProductProviderMapping — the transaction-provider fallback
 * catalog layer (Task 4). Follows games.test.ts's makeTestDb + resetDb +
 * buildSampleData shape; product_provider_mappings cascades off
 * denominations (onDelete: Cascade), so resetDb's existing
 * `denomination.deleteMany()` already clears it — no extra cleanup line
 * needed, unlike games.test.ts's Game/ProviderGameMapping (which predate
 * resetDb and have no FK into its chain).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  listProviderMappingsForDenomination,
  getEnabledProviderMappingsForDenomination,
  resolveDenominationProvider,
  upsertProductProviderMapping,
  deleteProductProviderMapping,
} from "./productProviderMappings";
import { resolveSingleDigiflazzItem } from "./digiflazz";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

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
});

describe("upsertProductProviderMapping", () => {
  it("creates a new row on first call, then updates the same row in place", async () => {
    const first = await upsertProductProviderMapping(prisma, {
      productId: sample.product.id,
      provider: "digiflazz",
      providerSku: "ML86",
      priority: 1,
    });
    const second = await upsertProductProviderMapping(prisma, {
      productId: sample.product.id,
      provider: "digiflazz",
      providerSku: "ML88",
      priority: 5,
      enabled: false,
    });

    const rows = await prisma.productProviderMapping.findMany({
      where: { productId: sample.product.id, provider: "digiflazz" },
    });
    expect(rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.providerSku).toBe("ML88");
    expect(second.priority).toBe(5);
    expect(second.enabled).toBe(false);
  });

  it("quantizes providerCost to 4 decimals like other Decimal money fields", async () => {
    const mapping = await upsertProductProviderMapping(prisma, {
      productId: sample.product.id,
      provider: "digiflazz",
      providerSku: "ML86",
      providerCost: "12345.678999",
    });

    expect(mapping.providerCost?.toString()).toBe("12345.679");
  });

  it("resolves the Denomination's autoDeliverySource/supplierSku from the new mapping immediately", async () => {
    await upsertProductProviderMapping(prisma, {
      productId: sample.product.id,
      provider: "digiflazz",
      providerSku: "ML86",
    });

    const denom = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(denom?.autoDeliverySource).toBe("digiflazz");
    expect(denom?.supplierSku).toBe("ML86");
  });
});

describe("listProviderMappingsForDenomination / getEnabledProviderMappingsForDenomination", () => {
  it("listProviderMappingsForDenomination returns all rows ordered by priority ascending", async () => {
    await upsertProductProviderMapping(prisma, { productId: sample.product.id, provider: "providerC", providerSku: "C-SKU", priority: 3 });
    await upsertProductProviderMapping(prisma, { productId: sample.product.id, provider: "digiflazz", providerSku: "A-SKU", priority: 1 });
    await upsertProductProviderMapping(prisma, { productId: sample.product.id, provider: "providerB", providerSku: "B-SKU", priority: 2 });

    const rows = await listProviderMappingsForDenomination(prisma, sample.product.id);

    expect(rows.map((r) => r.provider)).toEqual(["digiflazz", "providerB", "providerC"]);
  });

  it("excludes disabled rows and orders enabled ones by priority ascending", async () => {
    await upsertProductProviderMapping(prisma, { productId: sample.product.id, provider: "digiflazz", providerSku: "A-SKU", priority: 2, enabled: true });
    await upsertProductProviderMapping(prisma, { productId: sample.product.id, provider: "providerB", providerSku: "B-SKU", priority: 0, enabled: true });
    await upsertProductProviderMapping(prisma, { productId: sample.product.id, provider: "providerC", providerSku: "C-SKU", priority: 1, enabled: false });

    const rows = await getEnabledProviderMappingsForDenomination(prisma, sample.product.id);

    expect(rows.map((r) => r.provider)).toEqual(["providerB", "digiflazz"]);
    expect(rows.every((r) => r.enabled)).toBe(true);
  });
});

describe("resolveDenominationProvider", () => {
  it("writes the top-priority enabled mapping onto the Denomination and returns it", async () => {
    await prisma.productProviderMapping.create({
      data: { productId: sample.product.id, provider: "providerB", providerSku: "LOW-PRIORITY", priority: 5 },
    });
    await prisma.productProviderMapping.create({
      data: { productId: sample.product.id, provider: "digiflazz", providerSku: "TOP-PRIORITY", priority: 0 },
    });

    const resolved = await resolveDenominationProvider(prisma, sample.product.id);

    expect(resolved?.provider).toBe("digiflazz");
    const denom = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(denom?.autoDeliverySource).toBe("digiflazz");
    expect(denom?.supplierSku).toBe("TOP-PRIORITY");
  });

  it("falls over to the next-priority enabled mapping when the top one is disabled", async () => {
    await upsertProductProviderMapping(prisma, { productId: sample.product.id, provider: "digiflazz", providerSku: "PRIMARY-SKU", priority: 0, enabled: true });
    await upsertProductProviderMapping(prisma, { productId: sample.product.id, provider: "providerB", providerSku: "BACKUP-SKU", priority: 1, enabled: true });

    // Disabling the top-priority row (e.g. an admin turning it off because
    // the SKU disappeared from Digiflazz's catalog) re-resolves to the next
    // enabled provider — this is the concrete "fallback works" proof this
    // task's resolver exists to demonstrate, without any live
    // failure-triggered routing.
    await upsertProductProviderMapping(prisma, { productId: sample.product.id, provider: "digiflazz", providerSku: "PRIMARY-SKU", priority: 0, enabled: false });

    const denom = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(denom?.autoDeliverySource).toBe("providerB");
    expect(denom?.supplierSku).toBe("BACKUP-SKU");
  });

  it("returns null and leaves the Denomination's fields untouched when no enabled mapping exists", async () => {
    const before = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(before?.autoDeliverySource).toBeNull();
    expect(before?.supplierSku).toBeNull();

    const resolved = await resolveDenominationProvider(prisma, sample.product.id);

    expect(resolved).toBeNull();
    const after = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(after?.autoDeliverySource).toBeNull();
    expect(after?.supplierSku).toBeNull();
  });

  it("does not clear a previously-resolved value when the last mapping is deleted (additive-safe, not destructive)", async () => {
    const mapping = await upsertProductProviderMapping(prisma, {
      productId: sample.product.id,
      provider: "digiflazz",
      providerSku: "ONLY-SKU",
    });

    await deleteProductProviderMapping(prisma, mapping.id);

    const denom = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(denom?.autoDeliverySource).toBe("digiflazz");
    expect(denom?.supplierSku).toBe("ONLY-SKU");
  });
});

describe("[productId, provider] unique constraint", () => {
  it("rejects a raw duplicate-pair create", async () => {
    await prisma.productProviderMapping.create({
      data: { productId: sample.product.id, provider: "digiflazz", providerSku: "ML86" },
    });

    await expect(
      prisma.productProviderMapping.create({
        data: { productId: sample.product.id, provider: "digiflazz", providerSku: "ML99" },
      }),
    ).rejects.toThrow();
  });
});

describe("non-regression: legacy Digiflazz-routed Denominations without any mapping row", () => {
  it("keeps working completely unchanged — the migration is additive, not a backfill", async () => {
    // Simulates a Denomination imported by the existing Digiflazz Import
    // Wizard (importDigiflazzBrand) before this task ever ran — hardcoded
    // autoDeliverySource/supplierSku, zero ProductProviderMapping rows.
    await prisma.denomination.update({
      where: { id: sample.product.id },
      data: { autoDeliverySource: "digiflazz", supplierSku: "LEGACY-SKU-001" },
    });

    expect(await listProviderMappingsForDenomination(prisma, sample.product.id)).toEqual([]);

    const denom = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(denom?.autoDeliverySource).toBe("digiflazz");
    expect(denom?.supplierSku).toBe("LEGACY-SKU-001");
  });
});

describe("wiring proof: the mapping-resolved cache is what the Digiflazz dispatch path actually reads", () => {
  it("resolveSingleDigiflazzItem accepts an order item whose supplierSku came from a mapping, not a hardcoded field", async () => {
    await upsertProductProviderMapping(prisma, {
      productId: sample.product.id,
      provider: "digiflazz",
      providerSku: "MAPPED-SKU-001",
    });
    const denom = await prisma.denomination.findUnique({ where: { id: sample.product.id } });

    const result = resolveSingleDigiflazzItem({
      items: [
        {
          quantity: 1,
          product: {
            supplierSku: denom!.supplierSku,
            autoDeliverySource: denom!.autoDeliverySource,
            additionalFields: null,
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.supplierSku).toBe("MAPPED-SKU-001");
  });
});
