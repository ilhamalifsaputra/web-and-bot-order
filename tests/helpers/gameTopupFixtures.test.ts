import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIN_ORDER_AMOUNT_IDR_KEY } from "@app/db";
import { CUSTOMER_SERVICES, serviceForCategoryGroup } from "@app/core/services";
import { CategoryGroup } from "@app/core/enums";
import { makeTestDb, type TestDb } from "./testdb";
import { buildGameTopupFixtures } from "./gameTopupFixtures";
import { SeedManifest, SeedConflictError, SEED_MANIFEST_KEY } from "./seedManifest";
import { expectNoVisibleMarkers } from "./seedMarkers";

let db: TestDb;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db.cleanup(); });

const counts = async () => ({
  categories: await db.prisma.category.count(),
  products: await db.prisma.product.count(),
  denominations: await db.prisma.denomination.count(),
  users: await db.prisma.user.count(),
});

describe("buildGameTopupFixtures", () => {
  it("creates the expected shapes and is idempotent without any visible marker", async () => {
    const first = await buildGameTopupFixtures(db.prisma);
    const afterFirst = await counts();
    const second = await buildGameTopupFixtures(db.prisma);
    expect(await counts()).toEqual(afterFirst);
    expect(second).toEqual(first);

    // Families come from the group resolver, never from names.
    const game = await db.prisma.category.findUniqueOrThrow({ where: { id: first.categories.gameTopup } });
    const mixed = await db.prisma.category.findUniqueOrThrow({ where: { id: first.categories.mixed } });
    const premium = await db.prisma.category.findUniqueOrThrow({ where: { id: first.categories.premiumApps } });
    expect(serviceForCategoryGroup(game.group as never).id).toBe("game_topup");
    expect(serviceForCategoryGroup(mixed.group as never).id).toBe("game_topup");
    expect(serviceForCategoryGroup(premium.group as never).id).toBe("premium_apps");
    expect(game.group).toBe(CategoryGroup.GAME_TOPUP);
    expect(premium.group).toBe(CategoryGroup.PREMIUM_APPS);

    // Realistic names, no visible marker anywhere.
    expect([game.name, mixed.name, premium.name]).toEqual(["Game Top Up", "Mixed Games", "Premium Apps"]);
    const products = await db.prisma.product.findMany({ include: { denominations: true } });
    expect(products).toHaveLength(7);
    await expectNoVisibleMarkers(db.prisma);
    const buyer = await db.prisma.user.findUniqueOrThrow({ where: { id: first.userId } });
    expect(buyer.fullName).toBe("Budi Santoso");
    expect(buyer.username).toBe("budisantoso");

    // Mobile Legends style.
    const ml = products.find((p) => p.id === first.products.mobileLegends)!;
    expect(ml.gameRegion).toBe("Indonesia");
    expect(ml.denominations.length).toBeGreaterThanOrEqual(2);
    const manual = ml.denominations.filter((d) => d.deliveryType === "manual_with_info");
    expect(manual.length).toBeGreaterThanOrEqual(1);
    const fields = JSON.parse(manual[0]!.additionalFields!) as Array<{ key: string; type: string; label: { id: string; en: string } }>;
    expect(fields.map((f) => f.key)).toEqual(["user_id", "zone_id"]);
    expect(fields[0]).toMatchObject({ type: "number", label: { id: "ID Pengguna", en: "User ID" } });
    expect(fields[1]).toMatchObject({ type: "number", label: { id: "ID Zona", en: "Zone ID" } });
    expect(manual[0]!.nicknameCheckGameCode).toBe("mobile-legends");
    expect(JSON.parse(manual[0]!.providerInputMapping!)).toEqual({ digiflazz: { keys: ["user_id", "zone_id"], separator: "" } });
    expect(manual[0]!.qtyUnit).toBe("Diamonds");
    expect(manual[0]!.qtyValue).not.toBeNull();
    const auto = ml.denominations.filter((d) => d.autoDeliverySource === "digiflazz");
    expect(auto).toHaveLength(1);
    expect(auto[0]!.supplierSku).toBeTruthy();

    // Free Fire: one field + region. Delta Force: one field, no region.
    const ff = products.find((p) => p.id === first.products.freeFire)!;
    const dfp = products.find((p) => p.id === first.products.deltaForce)!;
    expect(ff.gameRegion).toBeTruthy();
    expect(dfp.gameRegion).toBeNull();
    for (const p of [ff, dfp]) {
      const f = JSON.parse(p.denominations[0]!.additionalFields!) as unknown[];
      expect(f).toHaveLength(1);
    }

    // Mixed category: some regions, some not, all in the Game Top-up group.
    const inMixed = products.filter((p) => p.categoryId === mixed.id);
    expect(inMixed.some((p) => p.gameRegion)).toBe(true);
    expect(inMixed.some((p) => !p.gameRegion)).toBe(true);

    // Premium control: plan denomination, no game metadata.
    const prem = products.find((p) => p.categoryId === premium.id)!;
    expect(prem.gameRegion).toBeNull();
    expect(prem.denominations).toHaveLength(1);
    expect(prem.denominations[0]!.additionalFields ?? null).toBeNull();

    // Buyer: a customer, not an admin.
    const user = await db.prisma.user.findUniqueOrThrow({ where: { id: first.userId } });
    expect(user.role).toBe("CUSTOMER");

    // Settings: Game Top-up enabled for both channels, no minimum order.
    const svc = CUSTOMER_SERVICES.find((s) => s.id === "game_topup")!;
    for (const key of Object.values(svc.settingKeys)) {
      expect((await db.prisma.setting.findUniqueOrThrow({ where: { key } })).value).toBe("1");
    }
    expect((await db.prisma.setting.findUniqueOrThrow({ where: { key: MIN_ORDER_AMOUNT_IDR_KEY } })).value).toBe("0");

    // No provider credentials were written.
    expect(await db.prisma.setting.count({ where: { key: { contains: "api_key" } } })).toBe(0);
  }, 60_000);

  it("records every created row in the manifest, adopts them on a second run and refuses an unmanifested same-name row", async () => {
    await db.prisma.denomination.deleteMany();
    await db.prisma.product.deleteMany();
    await db.prisma.category.deleteMany();
    await db.prisma.user.deleteMany();
    await db.prisma.setting.deleteMany({ where: { key: SEED_MANIFEST_KEY } });

    // A shop's own category that happens to share a name with a seed category.
    const real = await db.prisma.category.create({ data: { name: "Game Top Up", slug: "game-top-up", group: "GAME_TOPUP" } });
    const manifest = new SeedManifest();
    await expect(buildGameTopupFixtures(db.prisma, { manifest })).rejects.toThrow(SeedConflictError);
    await expect(buildGameTopupFixtures(db.prisma, { manifest })).rejects.toThrow(/"Game Top Up"/);
    expect(await db.prisma.product.count()).toBe(0);
    expect(manifest.has("categories", real.id)).toBe(false);

    await db.prisma.category.delete({ where: { id: real.id } });
    const ids = await buildGameTopupFixtures(db.prisma, { manifest });
    await manifest.save(db.prisma);
    const loaded = await SeedManifest.load(db.prisma);
    expect(loaded.counts()).toEqual({
      categories: await db.prisma.category.count(),
      products: await db.prisma.product.count(),
      denominations: await db.prisma.denomination.count(),
      users: 1,
    });
    expect(loaded.has("users", ids.userId)).toBe(true);

    // Second run with the stored manifest: same ids, nothing new.
    const again = await buildGameTopupFixtures(db.prisma, { manifest: loaded });
    expect(again).toEqual(ids);
    expect(await db.prisma.product.count()).toBe(7);

    // An unmanifested buyer who owns the fake Telegram id is refused too.
    await expect(buildGameTopupFixtures(db.prisma, { manifest: new SeedManifest() })).rejects.toThrow(SeedConflictError);
  }, 60_000);
});
