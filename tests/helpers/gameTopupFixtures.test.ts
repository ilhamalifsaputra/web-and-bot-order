import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIN_ORDER_AMOUNT_IDR_KEY } from "@app/db";
import { CUSTOMER_SERVICES, serviceForCategoryGroup } from "@app/core/services";
import { CategoryGroup } from "@app/core/enums";
import { makeTestDb, type TestDb } from "./testdb";
import { buildGameTopupFixtures } from "./gameTopupFixtures";

let db: TestDb;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db.cleanup(); });

const TAG = " [SEED-GTR]";
const counts = async () => ({
  categories: await db.prisma.category.count(),
  products: await db.prisma.product.count(),
  denominations: await db.prisma.denomination.count(),
  users: await db.prisma.user.count(),
});

describe("buildGameTopupFixtures", () => {
  it("creates the expected shapes and is idempotent when tagged", async () => {
    const first = await buildGameTopupFixtures(db.prisma, { tag: TAG });
    const afterFirst = await counts();
    const second = await buildGameTopupFixtures(db.prisma, { tag: TAG });
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

    // Every created name carries the tag.
    for (const row of [game, mixed, premium]) expect(row.name.endsWith(TAG)).toBe(true);
    const products = await db.prisma.product.findMany({ include: { denominations: true } });
    expect(products).toHaveLength(7);
    for (const p of products) {
      expect(p.name.endsWith(TAG)).toBe(true);
      for (const d of p.denominations) expect(d.name.endsWith(TAG)).toBe(true);
    }

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
});
