import { describe, it, expect, vi, afterEach, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import {
  loadKnowledgeBase,
  upsertDetectionToken,
  upsertDetectionAlias,
  upsertDetectionOverride,
  __clearDetectionKnowledgeCacheForTests,
} from "./detectionKnowledge";
import { listAuditLogs } from "./audit";
import { DEFAULT_KNOWLEDGE_BASE } from "@app/core/detection/knowledge";

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
  await resetDb(prisma);
  // Not covered by the shared resetDb (added after it was written).
  await prisma.detectionOverride.deleteMany();
  await prisma.detectionAlias.deleteMany();
  await prisma.detectionToken.deleteMany();
  __clearDetectionKnowledgeCacheForTests(prisma);
});
afterEach(() => {
  vi.useRealTimers();
});

async function makeAdmin() {
  return prisma.user.create({ data: { referralCode: `a${Math.random()}`, role: "ADMIN" } });
}

describe("loadKnowledgeBase", () => {
  it("returns DEFAULT_KNOWLEDGE_BASE when all three tables are empty", async () => {
    const kb = await loadKnowledgeBase(prisma);
    expect(kb).toEqual(DEFAULT_KNOWLEDGE_BASE);
  });

  it("returns DB rows (fully replacing defaults) once any table is populated, unioned with default noise tokens", async () => {
    const admin = await makeAdmin();
    await upsertDetectionToken(
      prisma,
      { category: "platform", token: "playstation", canonical: "playstation", isProductDefining: true },
      admin.id,
    );

    const kb = await loadKnowledgeBase(prisma);

    const defaultNoiseTokens = DEFAULT_KNOWLEDGE_BASE.tokens.filter((t) => t.category === "noise");
    expect(kb.tokens).toHaveLength(1 + defaultNoiseTokens.length);
    expect(kb.tokens).toContainEqual({
      category: "platform",
      token: "playstation",
      canonical: "playstation",
      isProductDefining: true,
      enabled: true,
    });
    for (const noiseToken of defaultNoiseTokens) {
      expect(kb.tokens).toContainEqual(noiseToken);
    }
    // Non-noise defaults (e.g. "mobile") are NOT silently blended in — DB
    // rows are the whole picture for populated categories.
    expect(kb.tokens.find((t) => t.token === "mobile")).toBeUndefined();
  });

  it("a DB noise token overrides the default noise token of the same [category, token] instead of duplicating it", async () => {
    const admin = await makeAdmin();
    await upsertDetectionToken(
      prisma,
      { category: "noise", token: "instant", canonical: "instant (edited)", isProductDefining: false },
      admin.id,
    );

    const kb = await loadKnowledgeBase(prisma);
    const instantTokens = kb.tokens.filter((t) => t.category === "noise" && t.token === "instant");
    expect(instantTokens).toHaveLength(1);
    expect(instantTokens[0]?.canonical).toBe("instant (edited)");
  });

  it("reflects a populated aliases/overrides table even with no tokens", async () => {
    const admin = await makeAdmin();
    await upsertDetectionAlias(prisma, { alias: "ml", expandsTo: "mobile legends" }, admin.id);
    await upsertDetectionOverride(
      prisma,
      {
        matchKind: "normalized_name",
        matchValue: "weird product name",
        productKey: "game_a::mobile",
        baseProductKey: "game_a",
        reason: "Ambiguous automatic match, confirmed manually.",
      },
      admin.id,
    );

    const kb = await loadKnowledgeBase(prisma);
    expect(kb.aliases).toEqual([{ alias: "ml", expandsTo: "mobile legends", reason: null }]);
    expect(kb.overrides).toEqual([
      {
        matchKind: "normalized_name",
        matchValue: "weird product name",
        baseProductKey: "game_a",
        productKey: "game_a::mobile",
        reason: "Ambiguous automatic match, confirmed manually.",
      },
    ]);
  });

  it("throws a specific error when a DB row fails schema validation, instead of silently dropping it", async () => {
    await prisma.detectionToken.create({
      data: {
        category: "not_a_real_category",
        token: "bogus",
        canonical: "bogus",
        isProductDefining: false,
        enabled: true,
      },
    });

    await expect(loadKnowledgeBase(prisma)).rejects.toThrow(/failed validation/);
    await expect(loadKnowledgeBase(prisma)).rejects.toThrow(/tokens/);
  });

  it("serves a cached value without hitting the DB again within the TTL, even after a row changes underneath it", async () => {
    const admin = await makeAdmin();
    await upsertDetectionToken(
      prisma,
      { category: "platform", token: "playstation", canonical: "playstation", isProductDefining: true },
      admin.id,
    );
    const first = await loadKnowledgeBase(prisma);
    expect(first.tokens.some((t) => t.token === "playstation")).toBe(true);

    // Bypass the upsert helper (so the revision counter is NOT bumped) to
    // simulate a change the cache wouldn't know about.
    await prisma.detectionToken.updateMany({ where: { token: "playstation" }, data: { canonical: "ps" } });

    const second = await loadKnowledgeBase(prisma);
    expect(second.tokens.find((t) => t.token === "playstation")?.canonical).toBe("playstation"); // still cached
  });

  it("re-reads from the DB once the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const admin = await makeAdmin();
    await upsertDetectionToken(
      prisma,
      { category: "platform", token: "playstation", canonical: "playstation", isProductDefining: true },
      admin.id,
    );
    await loadKnowledgeBase(prisma);

    await prisma.detectionToken.updateMany({ where: { token: "playstation" }, data: { canonical: "ps" } });
    vi.setSystemTime(31_000); // past the 30s TTL

    const afterTtl = await loadKnowledgeBase(prisma);
    expect(afterTtl.tokens.find((t) => t.token === "playstation")?.canonical).toBe("ps");
  });

  it("__clearDetectionKnowledgeCacheForTests invalidates the cache immediately, without waiting for the TTL", async () => {
    const admin = await makeAdmin();
    await upsertDetectionToken(
      prisma,
      { category: "platform", token: "playstation", canonical: "playstation", isProductDefining: true },
      admin.id,
    );
    await loadKnowledgeBase(prisma);

    await prisma.detectionToken.updateMany({ where: { token: "playstation" }, data: { canonical: "ps" } });
    __clearDetectionKnowledgeCacheForTests(prisma);

    const afterClear = await loadKnowledgeBase(prisma);
    expect(afterClear.tokens.find((t) => t.token === "playstation")?.canonical).toBe("ps");
  });

  it("a mutation through the SAME db handle is visible immediately, even within the TTL window (revision bump)", async () => {
    const admin = await makeAdmin();
    await upsertDetectionToken(
      prisma,
      { category: "platform", token: "playstation", canonical: "playstation", isProductDefining: true },
      admin.id,
    );
    await loadKnowledgeBase(prisma); // primes the cache

    await upsertDetectionToken(
      prisma,
      { category: "platform", token: "xbox", canonical: "xbox", isProductDefining: true },
      admin.id,
    );

    const afterSecondUpsert = await loadKnowledgeBase(prisma);
    expect(afterSecondUpsert.tokens.some((t) => t.token === "xbox")).toBe(true);
  });
});

describe("upsertDetectionToken", () => {
  it("creates a new row, then updates the same row in place on a second call", async () => {
    const admin = await makeAdmin();
    await upsertDetectionToken(
      prisma,
      { category: "edition", token: "ultra", canonical: "ultra", isProductDefining: true },
      admin.id,
    );
    await upsertDetectionToken(
      prisma,
      { category: "edition", token: "ultra", canonical: "ULTRA", isProductDefining: false, enabled: false },
      admin.id,
    );

    const rows = await prisma.detectionToken.findMany({ where: { category: "edition", token: "ultra" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.canonical).toBe("ULTRA");
    expect(rows[0]?.isProductDefining).toBe(false);
    expect(rows[0]?.enabled).toBe(false);
  });

  it("logs an admin action for the upsert", async () => {
    const admin = await makeAdmin();
    await upsertDetectionToken(
      prisma,
      { category: "edition", token: "ultra", canonical: "ultra", isProductDefining: true },
      admin.id,
    );

    const logs = await listAuditLogs(prisma, { action: "detection_token_upsert" });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.adminId).toBe(admin.id);
    expect(logs[0]?.targetType).toBe("detection_token");
    expect(logs[0]?.details).toContain("ultra");
  });

  it("bumps the detection_knowledge_revision setting", async () => {
    const admin = await makeAdmin();
    await upsertDetectionToken(
      prisma,
      { category: "edition", token: "ultra", canonical: "ultra", isProductDefining: true },
      admin.id,
    );
    const row = await prisma.setting.findUnique({ where: { key: "detection_knowledge_revision" } });
    expect(row?.value).toBe("1");
  });
});

describe("upsertDetectionAlias", () => {
  it("creates a new row, then updates the same row in place on a second call", async () => {
    const admin = await makeAdmin();
    await upsertDetectionAlias(prisma, { alias: "ml", expandsTo: "mobile legends" }, admin.id);
    await upsertDetectionAlias(prisma, { alias: "ml", expandsTo: "mobile legends bang bang", reason: "renamed" }, admin.id);

    const rows = await prisma.detectionAlias.findMany({ where: { alias: "ml" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expandsTo).toBe("mobile legends bang bang");
    expect(rows[0]?.reason).toBe("renamed");
  });

  it("logs an admin action for the upsert", async () => {
    const admin = await makeAdmin();
    await upsertDetectionAlias(prisma, { alias: "ml", expandsTo: "mobile legends" }, admin.id);

    const logs = await listAuditLogs(prisma, { action: "detection_alias_upsert" });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.adminId).toBe(admin.id);
    expect(logs[0]?.targetType).toBe("detection_alias");
  });
});

describe("upsertDetectionOverride", () => {
  it("creates a new row, then updates the same row in place on a second call", async () => {
    const admin = await makeAdmin();
    await upsertDetectionOverride(
      prisma,
      {
        matchKind: "external_id",
        matchValue: "ML86",
        productKey: "game_a::mobile",
        baseProductKey: "game_a",
        reason: "Supplier SKU always maps to this product.",
      },
      admin.id,
    );
    await upsertDetectionOverride(
      prisma,
      {
        matchKind: "external_id",
        matchValue: "ML86",
        productKey: "game_a::pc",
        baseProductKey: "game_a",
        reason: "Corrected: this SKU is actually the PC edition.",
      },
      admin.id,
    );

    const rows = await prisma.detectionOverride.findMany({ where: { matchKind: "external_id", matchValue: "ML86" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.productKey).toBe("game_a::pc");
    expect(rows[0]?.reason).toBe("Corrected: this SKU is actually the PC edition.");
  });

  it("logs an admin action for the upsert", async () => {
    const admin = await makeAdmin();
    await upsertDetectionOverride(
      prisma,
      {
        matchKind: "external_id",
        matchValue: "ML86",
        productKey: "game_a::mobile",
        baseProductKey: "game_a",
        reason: "Supplier SKU always maps to this product.",
      },
      admin.id,
    );

    const logs = await listAuditLogs(prisma, { action: "detection_override_upsert" });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.adminId).toBe(admin.id);
    expect(logs[0]?.targetType).toBe("detection_override");
  });
});
