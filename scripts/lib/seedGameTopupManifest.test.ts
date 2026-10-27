import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { provisionPgTestSchema, type PgTestSchemaEnv } from "../../tests/helpers/pgTestSchema";
import { FIXTURE_BUYER_TELEGRAM_ID } from "../../tests/helpers/gameTopupFixtures";
import { SeedManifest, SeedConflictError, SEED_MANIFEST_KEY, BULK_LAYOUT_VERSION } from "../../tests/helpers/seedManifest";
import { expectNoVisibleMarkers } from "../../tests/helpers/seedMarkers";
import { adoptLegacyTaggedRows, applySeed, removeManifestFixtures, LEGACY_SEED_TAG } from "./seedGameTopup";

let env: PgTestSchemaEnv;
let prisma: PrismaClient;
beforeAll(async () => {
  env = await provisionPgTestSchema("seed_gtr_manifest");
  prisma = new PrismaClient({ datasourceUrl: env.url });
}, 60_000);
afterAll(async () => { await prisma?.$disconnect(); await env?.cleanup(); });

async function wipe(): Promise<void> {
  await prisma.walletTransaction.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.denomination.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
  await prisma.setting.deleteMany();
}

const total = async () => ({
  categories: await prisma.category.count(),
  products: await prisma.product.count(),
  denominations: await prisma.denomination.count(),
  users: await prisma.user.count(),
});

async function realShop() {
  const cat = await prisma.category.create({ data: { name: "Aksesoris Gaming", slug: "aksesoris-gaming", group: "GAME_TOPUP" } });
  const prod = await prisma.product.create({ data: { categoryId: cat.id, name: "Voucher Toko", slug: "voucher-toko" } });
  const den = await prisma.denomination.create({ data: { productId: prod.id, name: "Paket Toko", slug: "paket-toko", type: "SHARED", durationLabel: "1x", price: "1000", warrantyDays: 1 } });
  const user = await prisma.user.create({ data: { referralCode: "REALSHOP1", telegramId: BigInt(123456), fullName: "Pembeli Asli" } });
  return { cat, prod, den, user };
}

describe("applySeed and removeManifestFixtures", () => {
  it("applies twice idempotently, writes the manifest, and removes only manifest rows", async () => {
    await wipe();
    const shop = await realShop();

    const first = await applySeed(prisma, { bulk: true });
    const afterFirst = await total();
    // --bulk builds the bulk catalog only (32 per-game categories + Premium Apps), not the small fixture.
    expect(afterFirst.products).toBe(68 + 1);
    expect(afterFirst.denominations).toBe(758 + 1);
    expect(afterFirst.categories).toBe(33 + 1);
    expect(await prisma.category.count({ where: { name: { in: ["Game Top Up", "Mixed Games", "Regional Games", "Game Editions"] } } })).toBe(0);
    const second = await applySeed(prisma, { bulk: true });
    expect(await total()).toEqual(afterFirst);
    expect(second.userId).toBe(first.userId);
    expect(second.small).toBeUndefined();
    await expectNoVisibleMarkers(prisma);

    const manifest = await SeedManifest.load(prisma);
    expect(manifest.counts()).toEqual({ categories: 33, products: 68, denominations: 758, users: 1 });
    expect(manifest.has("categories", shop.cat.id)).toBe(false);
    expect(manifest.has("users", shop.user.id)).toBe(false);
    const stored = (await prisma.setting.findUniqueOrThrow({ where: { key: SEED_MANIFEST_KEY } })).value;
    expect(stored).not.toMatch(/key|secret|token|password/i);

    const removed = await removeManifestFixtures(prisma, manifest);
    expect(removed.skipped).toEqual([]);
    expect(removed).toMatchObject({ categories: 33, products: 68, denominations: 758, users: 1 });
    expect(await prisma.setting.findUnique({ where: { key: SEED_MANIFEST_KEY } })).toBeNull();
    expect(await total()).toEqual({ categories: 1, products: 1, denominations: 1, users: 1 });
    expect(await prisma.category.findUnique({ where: { id: shop.cat.id } })).not.toBeNull();
    expect(await prisma.denomination.findUnique({ where: { id: shop.den.id } })).not.toBeNull();
  }, 240_000);

  it("refuses to adopt a shop's own same-name row and reports the name", async () => {
    await wipe();
    const shop = await realShop();
    await prisma.category.update({ where: { id: shop.cat.id }, data: { name: "Premium Apps" } });
    await expect(applySeed(prisma, { bulk: false })).rejects.toThrow(/"Premium Apps"/);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: shop.cat.id } })).name).toBe("Premium Apps");
    const manifest = await SeedManifest.load(prisma);
    expect(manifest.has("categories", shop.cat.id)).toBe(false);
    // Rows the run did create before the refusal are still tracked, so --remove can clean them.
    const removed = await removeManifestFixtures(prisma, manifest);
    expect(removed.skipped).toEqual([]);
    expect(await prisma.category.findUnique({ where: { id: shop.cat.id } })).not.toBeNull();
    expect(await prisma.user.count({ where: { telegramId: BigInt(FIXTURE_BUYER_TELEGRAM_ID) } })).toBe(0);
  }, 120_000);

  it("skips manifest rows that orders still reference, keeps them in the manifest, and reports each skip", async () => {
    await wipe();
    const ids = (await applySeed(prisma, { bulk: false })).small!;
    const denomId = ids.denominations["ff-70"]!;
    await prisma.order.create({
      data: {
        orderCode: "GTR-REMOVE-1",
        userId: ids.userId,
        subtotalAmount: "10000",
        totalAmount: "10000",
        items: { create: { productId: denomId, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 0 } },
      },
    });
    const manifest = await SeedManifest.load(prisma);
    const result = await removeManifestFixtures(prisma, manifest);
    const skippedText = result.skipped.join(" | ");
    expect(skippedText).toMatch(/product "Free Fire/);
    expect(skippedText).toMatch(/buyer/);
    expect(await prisma.denomination.findUnique({ where: { id: denomId } })).not.toBeNull();
    expect(await prisma.category.findUnique({ where: { id: ids.categories.gameTopup } })).not.toBeNull();
    // The manifest row stays so a later --remove can finish the job.
    const left = await SeedManifest.load(prisma);
    expect(left.has("denominations", denomId)).toBe(true);
    expect(left.has("users", ids.userId)).toBe(true);
    expect(left.has("products", ids.products.mobileLegends)).toBe(false);
  }, 120_000);
});

/** The shape the first seed produced: a visible " [SEED-GTR]" suffix on every name, plus the old fixture strings. */
async function seedLegacyShape() {
  const T = LEGACY_SEED_TAG;
  const cat = await prisma.category.create({ data: { name: `Game Top Up${T}`, slug: "game-top-up-seed-gtr", group: "GAME_TOPUP" } });
  const prem = await prisma.category.create({ data: { name: `Premium Apps${T}`, slug: "premium-apps-seed-gtr", group: "PREMIUM_APPS" } });
  const delta = await prisma.product.create({ data: { categoryId: cat.id, name: `Delta Force${T}`, slug: "delta-force-seed-gtr" } });
  const app = await prisma.product.create({
    data: { categoryId: prem.id, name: `Streaming App${T}`, slug: "streaming-app-seed-gtr", description: "Control product for the Premium Apps flow." },
  });
  const coins = await prisma.denomination.create({
    data: { productId: delta.id, name: `300 Delta Coins${T}`, slug: "300-delta-coins-seed-gtr", type: "SHARED", durationLabel: `300 Delta Coins${T}`, price: "45000", warrantyDays: 0, supplierSku: "fixture-ml257" },
  });
  const plan = await prisma.denomination.create({
    data: { productId: app.id, name: `1 Month Plan${T}`, slug: "1-month-plan-seed-gtr", type: "SHARED", durationLabel: "1 Month", price: "55000", warrantyDays: 30 },
  });
  const user = await prisma.user.create({
    data: { referralCode: "LEGACYBUY", telegramId: BigInt(FIXTURE_BUYER_TELEGRAM_ID), username: "fixture_buyer", fullName: `Fixture Buyer${T}` },
  });
  return { cat, prem, delta, app, coins, plan, user };
}

describe("migration of rows that carry the old visible tag", () => {
  it("renames them in place (same ids, orders intact), adds them to the manifest and leaves real rows alone", async () => {
    await wipe();
    const shop = await realShop();
    const legacy = await seedLegacyShape();
    const order = await prisma.order.create({
      data: {
        orderCode: "GTR-LEGACY-1",
        userId: legacy.user.id,
        subtotalAmount: "45000",
        totalAmount: "45000",
        items: { create: { productId: legacy.coins.id, quantity: 1, unitPrice: "45000", warrantyDaysSnapshot: 0 } },
      },
    });

    const result = await applySeed(prisma, { bulk: false });

    expect(result.adopted).toMatchObject({ categories: 2, products: 2, denominations: 2, users: 1 });
    // Same ids, no tag, realistic strings.
    expect((await prisma.category.findUniqueOrThrow({ where: { id: legacy.cat.id } })).name).toBe("Game Top Up");
    expect((await prisma.category.findUniqueOrThrow({ where: { id: legacy.cat.id } })).slug).toBe("game-top-up");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: legacy.delta.id } })).name).toBe("Delta Force");
    const app = await prisma.product.findUniqueOrThrow({ where: { id: legacy.app.id } });
    expect(app.name).toBe("Vidio Platinum");
    expect(app.description).not.toMatch(/control/i);
    const coins = await prisma.denomination.findUniqueOrThrow({ where: { id: legacy.coins.id } });
    expect(coins).toMatchObject({ name: "300 Delta Coins", durationLabel: "300 Delta Coins", supplierSku: "ml257", slug: "300-delta-coins" });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: legacy.user.id } });
    expect(user).toMatchObject({ fullName: "Budi Santoso", username: "budisantoso" });
    // The order still points at the renamed denomination.
    expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })).productId).toBe(legacy.coins.id);
    // The builder adopted the migrated rows instead of duplicating them.
    expect(result.small!.categories.gameTopup).toBe(legacy.cat.id);
    expect(result.small!.products.deltaForce).toBe(legacy.delta.id);
    expect(result.small!.products.premiumApp).toBe(legacy.app.id);
    expect(result.small!.userId).toBe(legacy.user.id);
    expect(await prisma.product.count({ where: { categoryId: legacy.prem.id } })).toBe(1);
    expect(await prisma.denomination.count({ where: { productId: legacy.app.id } })).toBe(1);

    const manifest = await SeedManifest.load(prisma);
    for (const id of [legacy.cat.id, legacy.prem.id]) expect(manifest.has("categories", id)).toBe(true);
    for (const id of [legacy.delta.id, legacy.app.id]) expect(manifest.has("products", id)).toBe(true);
    for (const id of [legacy.coins.id, legacy.plan.id]) expect(manifest.has("denominations", id)).toBe(true);
    expect(manifest.has("users", legacy.user.id)).toBe(true);
    // The shop's own rows are untouched and not in the manifest.
    expect(manifest.has("categories", shop.cat.id)).toBe(false);
    expect(manifest.has("products", shop.prod.id)).toBe(false);
    expect(manifest.has("denominations", shop.den.id)).toBe(false);
    expect(manifest.has("users", shop.user.id)).toBe(false);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: shop.cat.id } })).name).toBe("Aksesoris Gaming");

    await expectNoVisibleMarkers(prisma);
    expect(await prisma.category.count({ where: { name: { endsWith: LEGACY_SEED_TAG } } })).toBe(0);

    // Running again has nothing left to adopt.
    const again = await applySeed(prisma, { bulk: false });
    expect(again.adopted).toMatchObject({ categories: 0, products: 0, denominations: 0, users: 0 });
  }, 120_000);

  it("stops with a clear message, changing nothing, when the stripped name collides with a real row", async () => {
    await wipe();
    const legacy = await seedLegacyShape();
    const realDelta = await prisma.product.create({ data: { categoryId: legacy.cat.id, name: "Delta Force", slug: "delta-force-real" } });

    const manifest = new SeedManifest();
    await expect(adoptLegacyTaggedRows(prisma, manifest)).rejects.toThrow(SeedConflictError);
    await expect(adoptLegacyTaggedRows(prisma, manifest)).rejects.toThrow(/"Delta Force"/);
    // All or nothing: not even the other tagged rows were renamed.
    expect((await prisma.category.findUniqueOrThrow({ where: { id: legacy.cat.id } })).name).toBe(`Game Top Up${LEGACY_SEED_TAG}`);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: legacy.delta.id } })).name).toBe(`Delta Force${LEGACY_SEED_TAG}`);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: realDelta.id } })).name).toBe("Delta Force");
    expect(manifest.isEmpty()).toBe(true);
    expect(await prisma.setting.findUnique({ where: { key: SEED_MANIFEST_KEY } })).toBeNull();
  }, 60_000);

  it("a bulk apply after a legacy-tag migration ends in the per-game layout and stays idempotent", async () => {
    await wipe();
    await seedLegacyShape();
    await applySeed(prisma, { bulk: true });
    const before = await total();
    expect(before.categories).toBe(33);
    await applySeed(prisma, { bulk: true });
    expect(await total()).toEqual(before);
  }, 240_000);
});

/** The layout the previous --bulk produced: the small fixture plus Regional Games, all in the manifest, no layout version. */
async function seedOldLayout() {
  const first = await applySeed(prisma, { bulk: false });
  const manifest = await SeedManifest.load(prisma);
  const regional = await prisma.category.create({ data: { name: "Regional Games", slug: "regional-games", group: "GAME_TOPUP", sortOrder: 4 } });
  const rp = await prisma.product.create({ data: { categoryId: regional.id, name: "Valorant", slug: "valorant-old", gameRegion: "Indonesia" } });
  const rd = await prisma.denomination.create({
    data: { productId: rp.id, name: "125 VP", slug: "125-vp-old", type: "SHARED", durationLabel: "125 VP", price: "20000", warrantyDays: 0 },
  });
  manifest.add("categories", regional.id);
  manifest.add("products", rp.id);
  manifest.add("denominations", rd.id);
  await manifest.save(prisma);
  return { small: first.small!, regional, rp, rd };
}

describe("migration from the old bulk layout to one category per game", () => {
  it("replaces the manifest's old game categories, keeps Premium Apps and the buyer, leaves real rows alone and records the layout version", async () => {
    await wipe();
    const shop = await realShop();
    const old = await seedOldLayout();

    const result = await applySeed(prisma, { bulk: true });

    expect(result.migrated).toMatchObject({ categories: 3, products: 7, denominations: 10 });
    for (const name of ["Game Top Up", "Mixed Games", "Regional Games"]) expect(await prisma.category.findUnique({ where: { name } })).toBeNull();
    expect(await prisma.product.findUnique({ where: { id: old.small.products.mobileLegends } })).toBeNull();
    expect(await prisma.category.findUnique({ where: { id: old.small.categories.premiumApps } })).not.toBeNull();
    expect(await prisma.product.findUnique({ where: { id: old.small.products.premiumApp } })).not.toBeNull();
    expect(result.userId).toBe(old.small.userId);
    expect(await prisma.user.findUnique({ where: { id: old.small.userId } })).not.toBeNull();
    // New layout: 32 game categories (+ the shop's own GAME_TOPUP category).
    expect(await prisma.category.count({ where: { group: "GAME_TOPUP" } })).toBe(32 + 1);
    const ml = await prisma.category.findUniqueOrThrow({ where: { name: "Mobile Legends" } });
    expect(await prisma.product.count({ where: { categoryId: ml.id } })).toBe(4);
    // Premium Apps now holds the old plan product plus the 8 bulk ones.
    expect(await prisma.product.count({ where: { categoryId: old.small.categories.premiumApps } })).toBe(9);

    const manifest = await SeedManifest.load(prisma);
    expect(manifest.layout).toBe(BULK_LAYOUT_VERSION);
    expect(manifest.has("categories", old.regional.id)).toBe(false);
    expect(manifest.has("categories", shop.cat.id)).toBe(false);
    expect(await prisma.category.findUnique({ where: { id: shop.cat.id } })).not.toBeNull();
    expect(await prisma.denomination.findUnique({ where: { id: shop.den.id } })).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: shop.user.id } })).not.toBeNull();
    await expectNoVisibleMarkers(prisma);

    // Second run: nothing to migrate, nothing new.
    const before = await total();
    const again = await applySeed(prisma, { bulk: true });
    expect(again.migrated).toMatchObject({ categories: 0, products: 0, denominations: 0 });
    expect(await total()).toEqual(before);

    // The base fixture would collide with the per-game categories, so it is refused until --remove.
    await expect(applySeed(prisma, { bulk: false })).rejects.toThrow(SeedConflictError);
    await expect(applySeed(prisma, { bulk: false })).rejects.toThrow(/--bulk/);
    expect(await total()).toEqual(before);

    // --remove still takes everything in the manifest.
    const removed = await removeManifestFixtures(prisma, await SeedManifest.load(prisma));
    expect(removed.skipped).toEqual([]);
    expect(await prisma.setting.findUnique({ where: { key: SEED_MANIFEST_KEY } })).toBeNull();
    expect(await prisma.category.findUnique({ where: { id: shop.cat.id } })).not.toBeNull();
  }, 240_000);

  it("stops cleanly, changing nothing, when an old row is referenced by an order", async () => {
    await wipe();
    const old = await seedOldLayout();
    await prisma.order.create({
      data: {
        orderCode: "GTR-MIGRATE-1",
        userId: old.small.userId,
        subtotalAmount: "10000",
        totalAmount: "10000",
        items: { create: { productId: old.small.denominations["ff-70"]!, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 0 } },
      },
    });
    const before = await total();
    const manifestBefore = (await prisma.setting.findUniqueOrThrow({ where: { key: SEED_MANIFEST_KEY } })).value;

    await expect(applySeed(prisma, { bulk: true })).rejects.toThrow(SeedConflictError);
    await expect(applySeed(prisma, { bulk: true })).rejects.toThrow(/Free Fire/);

    // Not half-migrated: every old row is still there, no new category, manifest untouched.
    expect(await total()).toEqual(before);
    expect(await prisma.category.findUnique({ where: { name: "Regional Games" } })).not.toBeNull();
    expect(await prisma.category.findUnique({ where: { name: "Mobile Legends" } })).toBeNull();
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: SEED_MANIFEST_KEY } })).value).toBe(manifestBefore);
    expect((await SeedManifest.load(prisma)).layout).toBeUndefined();
  }, 120_000);
});
