import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createCategory, createCatalogProduct } from "./catalog";
import { fillGameRegions } from "./gameRegionBackfill";
import { getSetting } from "./settings";
import { CategoryGroup } from "@app/core/enums";

const GLOBAL = "\u{1F310} Global";
const MALAYSIA = "\u{1F1F2}\u{1F1FE} Malaysia";

let db: TestDb;
let categoryId: number;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => {
  categoryId = (await createCategory(db.prisma, { name: `Region backfill ${Date.now()}-${Math.random()}`, group: CategoryGroup.GAME_TOPUP })).id;
});

const mk = (name: string, extra: { gameVariant?: string | null; gameRegion?: string | null; categoryId?: number; digiflazzBrand?: string | null } = {}) =>
  createCatalogProduct(db.prisma, { categoryId: extra.categoryId ?? categoryId, name, digiflazzBrand: "digiflazzBrand" in extra ? extra.digiflazzBrand : name, gameVariant: extra.gameVariant ?? null, gameRegion: extra.gameRegion ?? null });
const regionOf = async (id: number) => (await db.prisma.product.findUniqueOrThrow({ where: { id } })).gameRegion;
const auditCount = () => db.prisma.auditLog.count({ where: { action: "game_region_backfill" } });

describe("fillGameRegions", () => {
  it("fills every member of a fully recognised scope and audits each product once", async () => {
    const a = await mk("Game X (Global)");
    const b = await mk("Game X (Malaysia)");
    const before = await auditCount();
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(await regionOf(a.id)).toBe(GLOBAL);
    expect(await regionOf(b.id)).toBe(MALAYSIA);
    expect(report).toMatchObject({ applied: true, updated: 2, skipped: 0 });
    expect(report.scopes[0]).toMatchObject({ status: "written", categoryId, gameVariant: null });
    const rows = await db.prisma.auditLog.findMany({ where: { action: "game_region_backfill", targetType: "product" } });
    expect(rows.length - before).toBe(2);
    const forA = rows.find((r) => r.targetId === a.id)!;
    expect(forA.details).toBe(`Set the region of "Game X (Global)" to ${GLOBAL} from its Digiflazz name.`);
  });

  it("bumps the catalog revision once when something was written", async () => {
    await mk("Game R (Global)"); await mk("Game R (Malaysia)");
    const before = Number((await getSetting(db.prisma, "detection_catalog_revision")) ?? 0);
    await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(Number(await getSetting(db.prisma, "detection_catalog_revision"))).toBe(before + 1);
  });

  it("dry run reports the plan but writes no region, no audit row and no revision bump", async () => {
    const a = await mk("Game D (Global)");
    const b = await mk("Game D (Malaysia)");
    const auditBefore = await auditCount();
    const revBefore = await getSetting(db.prisma, "detection_catalog_revision");
    const report = await fillGameRegions(db.prisma, { categoryIds: [categoryId], apply: false });
    expect(report.applied).toBe(false);
    expect(report.updated).toBe(0);
    expect(report.scopes[0]).toMatchObject({ status: "would_write" });
    expect(report.scopes[0]!.members.map((m) => m.label).sort()).toEqual([GLOBAL, MALAYSIA].sort());
    expect(await regionOf(a.id)).toBeNull();
    expect(await regionOf(b.id)).toBeNull();
    expect(await auditCount()).toBe(auditBefore);
    expect(await getSetting(db.prisma, "detection_catalog_revision")).toBe(revBefore);
  });

  it("skips the whole scope when an admin already set a region on one member", async () => {
    const a = await mk("Game A (Global)", { gameRegion: "\u{1F1EE}\u{1F1E9} Indonesia" });
    const b = await mk("Game A (Malaysia)");
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(report.scopes[0]).toMatchObject({ status: "skipped", reason: "admin_set_region_present" });
    expect(await regionOf(a.id)).toBe("\u{1F1EE}\u{1F1E9} Indonesia");
    expect(await regionOf(b.id)).toBeNull();
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(2);
  });

  it("skips a mixed scope where one member has no suffix", async () => {
    const a = await mk("Game M (Global)");
    const b = await mk("Game M Plain");
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(report.scopes[0]).toMatchObject({ status: "skipped", reason: "mixed" });
    expect(await regionOf(a.id)).toBeNull();
    expect(await regionOf(b.id)).toBeNull();
  });

  it("treats a member without digiflazzBrand as no suffix (scope skipped)", async () => {
    const a = await mk("Game N (Global)");
    const b = await mk("Game N manual", { digiflazzBrand: null });
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(report.scopes[0]).toMatchObject({ status: "skipped", reason: "mixed" });
    expect(await regionOf(a.id)).toBeNull();
    expect(await regionOf(b.id)).toBeNull();
  });

  it("reports no_suffix when no member has a suffix", async () => {
    await mk("Plain One"); await mk("Plain Two");
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(report.scopes[0]).toMatchObject({ status: "skipped", reason: "no_suffix" });
  });

  it("never labels publisher-suffixed games and keeps both products", async () => {
    const a = await mk("Game Y (Publisher X)");
    const b = await mk("Game Y (Publisher Y)");
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(report.scopes[0]).toMatchObject({ status: "skipped", reason: "unknown_suffix" });
    expect(report.scopes[0]!.unknownSuffixes).toEqual(["Publisher X", "Publisher Y"]);
    expect(await regionOf(a.id)).toBeNull();
    expect(await regionOf(b.id)).toBeNull();
    expect(await db.prisma.product.count({ where: { categoryId } })).toBe(2);
  });

  it("flags a possibly doubled suffix and writes nothing", async () => {
    const a = await mk("Game Z Malaysia (Malaysia)");
    const b = await mk("Game Z (Global)");
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(report.scopes[0]).toMatchObject({ status: "skipped", reason: "possible_doubled_suffix" });
    expect(await regionOf(a.id)).toBeNull();
    expect(await regionOf(b.id)).toBeNull();
  });

  it("skips a single-region scope (nothing to pick between)", async () => {
    const a = await mk("Game S (Global)");
    const b = await mk("Game S 2 (Global)");
    const solo = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(solo.scopes[0]).toMatchObject({ status: "skipped", reason: "single_region_scope" });
    expect(await regionOf(a.id)).toBeNull();
    expect(await regionOf(b.id)).toBeNull();
  });

  it("treats each gameVariant (including null) as its own scope", async () => {
    const a1 = await mk("Game V (Global)", { gameVariant: "Alpha" });
    const a2 = await mk("Game V (Malaysia)", { gameVariant: "Alpha" });
    const b1 = await mk("Game V Beta (Global)", { gameVariant: "Beta" });
    const n1 = await mk("Game V Null (Global)");
    const n2 = await mk("Game V Null (Malaysia)");
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(report.scopes).toHaveLength(3);
    expect(await regionOf(a1.id)).toBe(GLOBAL);
    expect(await regionOf(a2.id)).toBe(MALAYSIA);
    expect(await regionOf(n1.id)).toBe(GLOBAL);
    expect(await regionOf(n2.id)).toBe(MALAYSIA);
    expect(await regionOf(b1.id)).toBeNull();
    expect(report.scopes.find((s) => s.gameVariant === "Beta")).toMatchObject({ status: "skipped", reason: "single_region_scope" });
  });

  it("is idempotent: a second apply writes nothing", async () => {
    await mk("Game I (Global)"); await mk("Game I (Malaysia)");
    await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    const audit = await auditCount();
    const again = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(again.updated).toBe(0);
    expect(again.scopes[0]).toMatchObject({ status: "skipped", reason: "already_filled" });
    expect(await auditCount()).toBe(audit);
  });

  it("keeps admin_set_region_present when the stored labels differ from what would be written", async () => {
    await mk("Game K (Global)", { gameRegion: GLOBAL });
    await mk("Game K (Malaysia)", { gameRegion: GLOBAL });
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(report.scopes[0]).toMatchObject({ status: "skipped", reason: "admin_set_region_present" });
  });

  it.each([["whitespace-only", "  "], ["empty string", ""]])("skips a scope whose member has a %s gameRegion and writes nothing", async (_n, value) => {
    const a = await mk("Game W (Global)");
    const b = await mk("Game W (Malaysia)", { gameRegion: value });
    const audit = await auditCount();
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(report.scopes[0]).toMatchObject({ status: "skipped", reason: "admin_set_region_present" });
    expect(await regionOf(a.id)).toBeNull();
    expect(await regionOf(b.id)).toBe(value);
    expect(await auditCount()).toBe(audit);
  });

  describe("scope membership changing between read and write", () => {
    const expectUntouched = async (report: Awaited<ReturnType<typeof fillGameRegions>>, ids: number[], audit: number) => {
      expect(report.scopes[0]).toMatchObject({ status: "skipped", reason: "changed_concurrently" });
      for (const id of ids) expect(await regionOf(id)).toBeNull();
      expect(await auditCount()).toBe(audit);
      expect(report.updated).toBe(0);
    };

    it("a new sibling appearing in the scope aborts it and writes nothing", async () => {
      const a = await mk("Game N1 (Global)");
      const b = await mk("Game N1 (Malaysia)");
      const audit = await auditCount();
      let extra = 0;
      const report = await fillGameRegions(db.prisma, {
        apply: true, categoryIds: [categoryId],
        beforeScopeWrite: async () => { extra = (await mk("Game N1 (Philippines)")).id; },
      });
      await expectUntouched(report, [a.id, b.id, extra], audit);
    });

    it("a member archived mid-run aborts the scope and writes nothing", async () => {
      const a = await mk("Game N2 (Global)");
      const b = await mk("Game N2 (Malaysia)");
      const audit = await auditCount();
      const report = await fillGameRegions(db.prisma, {
        apply: true, categoryIds: [categoryId],
        beforeScopeWrite: async () => { await db.prisma.product.update({ where: { id: b.id }, data: { isArchived: true, isActive: false } }); },
      });
      await expectUntouched(report, [a.id, b.id], audit);
    });

    it("a member moved to another gameVariant mid-run aborts the scope and writes nothing", async () => {
      const a = await mk("Game N3 (Global)");
      const b = await mk("Game N3 (Malaysia)");
      const audit = await auditCount();
      const report = await fillGameRegions(db.prisma, {
        apply: true, categoryIds: [categoryId],
        beforeScopeWrite: async () => { await db.prisma.product.update({ where: { id: b.id }, data: { gameVariant: "Moved" } }); },
      });
      expect(report.scopes[0]).toMatchObject({ status: "skipped", reason: "changed_concurrently" });
      await expectUntouched({ ...report, updated: 0 }, [a.id, b.id], audit);
    });
  });

  it("still returns the report with revisionBumpFailed when the catalog revision bump throws", async () => {
    const a = await mk("Game B (Global)");
    await mk("Game B (Malaysia)");
    const report = await fillGameRegions(db.prisma, {
      apply: true, categoryIds: [categoryId],
      bumpRevision: async () => { throw new Error("boom"); },
    });
    expect(report).toMatchObject({ updated: 2, revisionBumpFailed: true });
    expect(await regionOf(a.id)).toBe(GLOBAL);
  });

  it("an unexpected error in one scope stops the run but keeps the reports of scopes already written", async () => {
    const first = await mk("Game E1 (Global)", { gameVariant: "A" });
    await mk("Game E1 (Malaysia)", { gameVariant: "A" });
    await mk("Game E2 (Global)", { gameVariant: "B" });
    await mk("Game E2 (Malaysia)", { gameVariant: "B" });
    let calls = 0;
    const report = await fillGameRegions(db.prisma, {
      apply: true, categoryIds: [categoryId],
      beforeScopeWrite: async () => { if (++calls === 2) throw new Error("unexpected"); },
    });
    expect(report.scopes.map((s) => s.status)).toEqual(["written", "failed"]);
    expect(report.scopes[1]!.error).toBe("unexpected");
    expect(report.updated).toBe(2);
    expect(await regionOf(first.id)).toBe(GLOBAL);
  });

  it("compare-and-set: a region set by an admin between read and write wins and the scope is rolled back", async () => {
    const a = await mk("Game C (Global)");
    const b = await mk("Game C (Malaysia)");
    const report = await fillGameRegions(db.prisma, {
      apply: true, categoryIds: [categoryId],
      beforeScopeWrite: async () => { await db.prisma.product.update({ where: { id: b.id }, data: { gameRegion: "Admin value" } }); },
    });
    expect(report.scopes[0]).toMatchObject({ status: "skipped", reason: "changed_concurrently" });
    expect(await regionOf(b.id)).toBe("Admin value");
    expect(await regionOf(a.id)).toBeNull(); // transaction rolled back
    expect(report.updated).toBe(0);
    expect(await db.prisma.auditLog.count({ where: { action: "game_region_backfill", targetId: a.id } })).toBe(0);
  });

  it("never touches Premium Apps or null-group categories", async () => {
    const premium = (await createCategory(db.prisma, { name: `Premium ${Date.now()}`, group: CategoryGroup.PREMIUM_APPS })).id;
    const legacy = (await createCategory(db.prisma, { name: `Legacy ${Date.now()}` })).id;
    const ids: number[] = [];
    for (const cid of [premium, legacy]) {
      ids.push((await mk("App Q (Global)", { categoryId: cid })).id, (await mk("App Q (Malaysia)", { categoryId: cid })).id);
    }
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [premium, legacy] });
    expect(report.scopes).toHaveLength(0);
    for (const id of ids) expect(await regionOf(id)).toBeNull();
  });

  it("ignores archived products and honours the categoryIds filter", async () => {
    const other = (await createCategory(db.prisma, { name: `Other ${Date.now()}`, group: CategoryGroup.GAME_TOPUP })).id;
    const o1 = await mk("Game O (Global)", { categoryId: other });
    const o2 = await mk("Game O (Malaysia)", { categoryId: other });
    const a = await mk("Game F (Global)");
    const b = await mk("Game F (Malaysia)");
    const archived = await mk("Game F (Publisher Z)");
    await db.prisma.product.update({ where: { id: archived.id }, data: { isArchived: true, isActive: false } });
    const report = await fillGameRegions(db.prisma, { apply: true, categoryIds: [categoryId] });
    expect(report.scopes.map((s) => s.categoryId)).toEqual([categoryId]);
    expect(await regionOf(a.id)).toBe(GLOBAL);
    expect(await regionOf(b.id)).toBe(MALAYSIA);
    expect(await regionOf(o1.id)).toBeNull();
    expect(await regionOf(o2.id)).toBeNull();
    expect(await regionOf(archived.id)).toBeNull();
  });
});
