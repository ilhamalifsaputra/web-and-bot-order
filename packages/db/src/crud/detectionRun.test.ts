import { describe, it, expect, vi, afterEach, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { logger } from "@app/core/logger";
import { normalize } from "@app/core/detection";
import { createCategory, createCatalogProduct } from "./catalog";
import { upsertDetectionOverride, __clearDetectionKnowledgeCacheForTests } from "./detectionKnowledge";
import { __clearDetectionIndexCacheForTests } from "./detectionIndex";
import { setSetting, __clearSettingsCacheForTests } from "./settings";
import {
  runDetectionForCatalog,
  getLatestDetectionRunStatus,
  fingerprintDetectionInput,
  DETECTION_RUN_STATUS_KEY,
  OVERRIDE_RATE_SENTINEL_FINGERPRINT,
} from "./detectionRun";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma); // clears the detection_* tables too
  __clearDetectionKnowledgeCacheForTests(prisma);
  __clearDetectionIndexCacheForTests(prisma);
  __clearSettingsCacheForTests(prisma);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function makeCategory() {
  return createCategory(prisma, `Games ${Math.random()}`, "🎮");
}
async function makeProduct(categoryId: number, name: string, digiflazzBrand: string | null = name.toUpperCase()) {
  return createCatalogProduct(prisma, { categoryId, name, digiflazzBrand });
}
async function makeAdmin() {
  return prisma.user.create({ data: { referralCode: `a${Math.random()}`, role: "ADMIN" } });
}

describe("runDetectionForCatalog — summary", () => {
  it("returns a fully-shaped summary and persists it for getLatestDetectionRunStatus to read back", async () => {
    const cat = await makeCategory();
    await makeProduct(cat.id, "Mobile Legends");
    await makeProduct(cat.id, "Free Fire");

    const summary = await runDetectionForCatalog(prisma);

    expect(summary.totalRecords).toBe(2);
    expect(summary.resolved).toBe(2);
    expect(summary.ambiguous).toBe(0);
    expect(summary.unknown).toBe(0);
    expect(summary.overrideHits).toBe(0);
    expect(typeof summary.detectorStamp).toBe("string");
    expect(typeof summary.finishedAt).toBe("string");
    // every confidence band key is always present
    expect(Object.keys(summary.confidenceBuckets).sort()).toEqual(
      ["0.00-0.50", "0.50-0.75", "0.75-0.90", "0.90-1.00"],
    );
    const bucketTotal = Object.values(summary.confidenceBuckets).reduce((a, b) => a + b, 0);
    expect(bucketTotal).toBe(summary.resolved);

    __clearSettingsCacheForTests(prisma);
    const readBack = await getLatestDetectionRunStatus(prisma);
    expect(readBack).toEqual(summary);
  });

  it("getLatestDetectionRunStatus returns null before any run", async () => {
    expect(await getLatestDetectionRunStatus(prisma)).toBeNull();
  });

  it("degrades a corrupt (non-JSON) status blob to null instead of throwing", async () => {
    await setSetting(prisma, DETECTION_RUN_STATUS_KEY, "{not valid json");
    await expect(getLatestDetectionRunStatus(prisma)).resolves.toBeNull();
  });

  it("treats a well-formed blob missing a required field as null", async () => {
    await setSetting(
      prisma,
      DETECTION_RUN_STATUS_KEY,
      JSON.stringify({
        detectorStamp: "1.0.0+k0",
        totalRecords: 3,
        resolved: 3,
        ambiguous: 0,
        // unknown missing
        overrideHits: 0,
        confidenceBuckets: {},
        finishedAt: "2026-09-10T00:00:00.000Z",
      }),
    );
    expect(await getLatestDetectionRunStatus(prisma)).toBeNull();
  });

  it("treats a blob whose confidenceBuckets holds a non-number as null", async () => {
    await setSetting(
      prisma,
      DETECTION_RUN_STATUS_KEY,
      JSON.stringify({
        detectorStamp: "1.0.0+k0",
        totalRecords: 1,
        resolved: 1,
        ambiguous: 0,
        unknown: 0,
        overrideHits: 0,
        confidenceBuckets: { "0.90-1.00": "one" },
        finishedAt: "2026-09-10T00:00:00.000Z",
      }),
    );
    expect(await getLatestDetectionRunStatus(prisma)).toBeNull();
  });
});

describe("runDetectionForCatalog — issue upsert", () => {
  it("accumulates a repeat unresolved input into one row (occurrences++), not a duplicate", async () => {
    const cat = await makeCategory();
    // "..." normalizes to "" -> the engine returns `unknown` ("no usable
    // product name") -> a DetectionIssue is raised for it.
    await makeProduct(cat.id, "...", "PLACEHOLDER BRAND");

    await runDetectionForCatalog(prisma);
    await runDetectionForCatalog(prisma);

    const fp = fingerprintDetectionInput({ productName: "..." });
    const rows = await prisma.detectionIssue.findMany({ where: { inputFingerprint: fp } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(2);
    expect(rows[0]!.status).toBe("unknown");
    expect(rows[0]!.reviewStatus).toBe("OPEN");
  });
});

describe("runDetectionForCatalog — override-rate guard", () => {
  it("warns and raises the sentinel issue when overrides resolve more than 5% of the catalog", async () => {
    const admin = await makeAdmin();
    const cat = await makeCategory();
    for (let i = 0; i < 10; i += 1) {
      await makeProduct(cat.id, `Override Rate Game ${i}`, `ORG BRAND ${i}`);
    }
    // One override matching one product's normalized name -> 1/10 = 10% > 5%.
    await upsertDetectionOverride(
      prisma,
      {
        matchKind: "normalized_name",
        matchValue: normalize("Override Rate Game 3"),
        productKey: "override~rate~game~3",
        baseProductKey: "override~rate~game~3",
        reason: "pin this SKU for the test",
      },
      admin.id,
    );
    __clearDetectionKnowledgeCacheForTests(prisma);
    __clearDetectionIndexCacheForTests(prisma);

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);

    const summary = await runDetectionForCatalog(prisma);

    expect(summary.totalRecords).toBe(10);
    expect(summary.overrideHits).toBe(1);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ overrideHits: 1, totalRecords: 10 }),
      expect.stringContaining("override rate exceeded 5% of the catalog"),
    );

    const sentinel = await prisma.detectionIssue.findUnique({
      where: { inputFingerprint: OVERRIDE_RATE_SENTINEL_FINGERPRINT },
    });
    expect(sentinel).not.toBeNull();
    expect(sentinel!.reviewStatus).toBe("OPEN");
    expect(sentinel!.reason).toContain("above the 5% ceiling");
  });

  it("does not warn or raise the sentinel when the override rate is at or below 5%", async () => {
    const admin = await makeAdmin();
    const cat = await makeCategory();
    for (let i = 0; i < 20; i += 1) {
      await makeProduct(cat.id, `Fine Rate Game ${i}`, `FRG BRAND ${i}`);
    }
    await upsertDetectionOverride(
      prisma,
      {
        matchKind: "normalized_name",
        matchValue: normalize("Fine Rate Game 5"),
        productKey: "fine~rate~game~5",
        baseProductKey: "fine~rate~game~5",
        reason: "one override out of twenty is fine",
      },
      admin.id,
    );
    __clearDetectionKnowledgeCacheForTests(prisma);
    __clearDetectionIndexCacheForTests(prisma);

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const summary = await runDetectionForCatalog(prisma);

    expect(summary.overrideHits).toBe(1);
    expect(summary.totalRecords).toBe(20); // 1/20 = 5%, not > 5%
    expect(warnSpy).not.toHaveBeenCalled();
    const sentinel = await prisma.detectionIssue.findUnique({
      where: { inputFingerprint: OVERRIDE_RATE_SENTINEL_FINGERPRINT },
    });
    expect(sentinel).toBeNull();
  });
});

describe("runDetectionForCatalog — DetectionOverride.hitCount", () => {
  it("increments hitCount on every real override hit, as a running counter (not a boolean flag)", async () => {
    const admin = await makeAdmin();
    const cat = await makeCategory();
    await makeProduct(cat.id, "Hit Count Game");

    const matchValue = normalize("Hit Count Game");
    await upsertDetectionOverride(
      prisma,
      {
        matchKind: "normalized_name",
        matchValue,
        productKey: "hit~count~game",
        baseProductKey: "hit~count~game",
        reason: "pin this SKU for the hitCount test",
      },
      admin.id,
    );
    __clearDetectionKnowledgeCacheForTests(prisma);
    __clearDetectionIndexCacheForTests(prisma);

    const overrideKey = { matchKind_matchValue: { matchKind: "normalized_name", matchValue } } as const;

    const before = await prisma.detectionOverride.findUnique({ where: overrideKey });
    expect(before!.hitCount).toBe(0);

    await runDetectionForCatalog(prisma);

    const afterFirstRun = await prisma.detectionOverride.findUnique({ where: overrideKey });
    expect(afterFirstRun!.hitCount).toBe(1);

    // A second full-catalog run against the same (still-matching) product
    // hits the same override row again — hitCount must keep counting, not
    // clamp at 1.
    await runDetectionForCatalog(prisma);

    const afterSecondRun = await prisma.detectionOverride.findUnique({ where: overrideKey });
    expect(afterSecondRun!.hitCount).toBe(2);
  });
});
