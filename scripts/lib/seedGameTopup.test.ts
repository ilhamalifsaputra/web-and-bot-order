import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { provisionPgTestSchema, type PgTestSchemaEnv } from "../../tests/helpers/pgTestSchema";
import { buildGameTopupFixtures, FIXTURE_BUYER_TELEGRAM_ID } from "../../tests/helpers/gameTopupFixtures";
import { buildBulkGameTopupCatalog } from "../../tests/helpers/gameTopupBulkCatalog";
import { assertSeedTarget, parseSeedArgs, removeTaggedFixtures, SEED_DB_NAME, SEED_TAG } from "./seedGameTopup";

const OK = `postgresql://u:p@localhost:5433/${SEED_DB_NAME}`;
const flags = { confirmWorktreeDb: true };

describe("assertSeedTarget", () => {
  it("accepts a local host with the worktree database and the confirm flag", () => {
    expect(() => assertSeedTarget(OK, flags)).not.toThrow();
    expect(() => assertSeedTarget(`postgresql://u:p@127.0.0.1:5433/${SEED_DB_NAME}?schema=public`, flags)).not.toThrow();
    expect(() => assertSeedTarget(`postgresql://u:p@[::1]:5433/${SEED_DB_NAME}`, flags)).not.toThrow();
  });
  it("refuses a non-local host, a wrong database name, a missing flag and an unusable URL", () => {
    expect(() => assertSeedTarget(`postgresql://u:p@db.example.com:5432/${SEED_DB_NAME}`, flags)).toThrow(/host/);
    expect(() => assertSeedTarget("postgresql://u:p@localhost:5433/bot_order", flags)).toThrow(/bot_order_gtr/);
    expect(() => assertSeedTarget("postgresql://u:p@localhost:5433/bot_order_gtr_x", flags)).toThrow(/bot_order_gtr/);
    expect(() => assertSeedTarget(OK, { confirmWorktreeDb: false })).toThrow(/--confirm-worktree-db/);
    expect(() => assertSeedTarget(undefined, flags)).toThrow(/DATABASE_URL_PRISMA/);
    expect(() => assertSeedTarget("not a url", flags)).toThrow();
  });
  it("never echoes the URL or its credentials in the error", () => {
    try {
      assertSeedTarget("postgresql://admin:s3cret@db.example.com:5432/other", flags);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as Error).message).not.toContain("s3cret");
      expect((e as Error).message).not.toContain("postgresql://");
    }
  });
});

describe("parseSeedArgs", () => {
  it("reads --bulk alone, with --apply and with --remove", () => {
    expect(parseSeedArgs(["--confirm-worktree-db", "--bulk"])).toMatchObject({ bulk: true, apply: false, remove: false, unknown: undefined });
    expect(parseSeedArgs(["--confirm-worktree-db", "--apply", "--bulk"])).toMatchObject({ bulk: true, apply: true, remove: false });
    expect(parseSeedArgs(["--confirm-worktree-db", "--apply", "--remove", "--bulk"])).toMatchObject({ bulk: true, apply: true, remove: true });
    expect(parseSeedArgs(["--confirm-worktree-db", "--apply"]).bulk).toBe(false);
  });
  it("still flags unknown options and recognises help", () => {
    expect(parseSeedArgs(["--bulks"]).unknown).toBe("--bulks");
    expect(parseSeedArgs(["--help"])).toMatchObject({ help: true, unknown: undefined });
    expect(parseSeedArgs(["-h"]).help).toBe(true);
  });
});

describe("assertSeedTarget query-string host overrides", () => {
  it.each([
    "?host=db.prod.example.com",
    "?hostaddr=203.0.113.9",
    "?host=/var/run/postgresql",
    "?schema=public&host=db.prod.example.com",
    "?HOST=db.prod.example.com",
  ])("refuses %s without echoing the URL", (query) => {
    const url = `postgresql://u:s3cret@localhost:5433/${SEED_DB_NAME}${query}`;
    try {
      assertSeedTarget(url, flags);
      throw new Error("should have refused");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/host/);
      expect(msg).not.toContain("s3cret");
      expect(msg).not.toContain("example.com");
      expect(msg).not.toContain("postgresql://");
    }
  });
  it("still accepts a plain schema parameter", () => {
    expect(() => assertSeedTarget(`${OK}?schema=public`, flags)).not.toThrow();
  });
});

describe("apply, apply again, remove round trip", () => {
  let env: PgTestSchemaEnv;
  let prisma: PrismaClient;
  beforeAll(async () => {
    env = await provisionPgTestSchema("seed_gtr");
    prisma = new PrismaClient({ datasourceUrl: env.url });
  }, 60_000);
  afterAll(async () => { await prisma?.$disconnect(); await env?.cleanup(); });

  it("leaves a pre-existing untagged catalog intact", async () => {
    const cat = await prisma.category.create({ data: { name: "Manual shop category", slug: "manual-shop-category", group: "PREMIUM_APPS" } });
    const prod = await prisma.product.create({ data: { categoryId: cat.id, name: "Manual product", slug: "manual-product" } });
    await prisma.denomination.create({ data: { productId: prod.id, name: "Manual plan", slug: "manual-plan", type: "SHARED", durationLabel: "1x", price: "1000", warrantyDays: 1 } });
    const user = await prisma.user.create({ data: { referralCode: "MANUALUSR", telegramId: BigInt(123456) } });
    const untagged = async () => ({
      c: await prisma.category.count({ where: { name: { not: { endsWith: SEED_TAG } } } }),
      p: await prisma.product.count({ where: { name: { not: { endsWith: SEED_TAG } } } }),
      d: await prisma.denomination.count({ where: { name: { not: { endsWith: SEED_TAG } } } }),
      u: await prisma.user.count({ where: { id: user.id } }),
    });
    const before = await untagged();

    const a = await buildGameTopupFixtures(prisma, { tag: SEED_TAG });
    const total = async () => (await prisma.category.count()) + (await prisma.product.count()) + (await prisma.denomination.count());
    const afterApply = await total();
    const b = await buildGameTopupFixtures(prisma, { tag: SEED_TAG });
    expect(await total()).toBe(afterApply);
    expect(b).toEqual(a);
    expect(await untagged()).toEqual(before);

    const removed = await removeTaggedFixtures(prisma, SEED_TAG);
    expect(removed.categories).toBe(3);
    expect(removed.products).toBe(7);
    expect(removed.denominations).toBeGreaterThan(0);
    expect(removed.users).toBe(1);
    expect(await prisma.category.count({ where: { name: { endsWith: SEED_TAG } } })).toBe(0);
    expect(await prisma.product.count({ where: { name: { endsWith: SEED_TAG } } })).toBe(0);
    expect(await untagged()).toEqual(before);
    expect(await prisma.category.count()).toBe(1);

    // Removing again is a no-op.
    expect(await removeTaggedFixtures(prisma, SEED_TAG)).toMatchObject({ categories: 0, products: 0, denominations: 0, users: 0 });
  }, 60_000);
  it("skips tagged rows that real orders or wallet history still reference, and reports each skip", async () => {
    const ids = await buildGameTopupFixtures(prisma, { tag: SEED_TAG });
    const denomId = ids.denominations["ff-70"]!;
    const order = await prisma.order.create({
      data: {
        orderCode: "GTR-REMOVE-1",
        userId: ids.userId,
        subtotalAmount: "10000",
        totalAmount: "10000",
        items: { create: { productId: denomId, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 0 } },
      },
    });
    await prisma.walletTransaction.create({ data: { userId: ids.userId, delta: "5000", balanceAfter: "5000", reason: "admin_adjust" } });
    const manual = await prisma.category.create({ data: { name: "Untagged keeper", slug: "untagged-keeper", group: "GAME_TOPUP" } });

    const result = await removeTaggedFixtures(prisma, SEED_TAG);

    const skippedText = result.skipped.join(" | ");
    expect(result.skipped.length).toBeGreaterThanOrEqual(2);
    expect(skippedText).toMatch(/product "Free Fire/);
    expect(skippedText).toMatch(/buyer/);
    expect(await prisma.order.findUnique({ where: { id: order.id } })).not.toBeNull();
    expect(await prisma.denomination.findUnique({ where: { id: denomId } })).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: ids.userId } })).not.toBeNull();
    // The unreferenced fixtures went, and an untagged category is untouched.
    expect(result.products).toBeGreaterThan(0);
    expect(await prisma.category.findUnique({ where: { id: manual.id } })).not.toBeNull();
    // The Game Top Up category still holds the skipped product, so it stays too.
    expect(await prisma.category.findUnique({ where: { id: ids.categories.gameTopup } })).not.toBeNull();
  }, 60_000);

  it("matches the seeded buyer by Telegram id as well as the tag", async () => {
    const decoy = await prisma.user.create({
      data: { referralCode: "DECOYUSR", telegramId: BigInt(555000111), fullName: `Someone Else${SEED_TAG}` },
    });
    const seeded = await buildGameTopupFixtures(prisma, { tag: SEED_TAG });
    // Only reached when the order test above left the buyer behind; free it first.
    await prisma.walletTransaction.deleteMany({ where: { userId: seeded.userId } });
    await prisma.orderItem.deleteMany({ where: { order: { userId: seeded.userId } } });
    await prisma.order.deleteMany({ where: { userId: seeded.userId } });
    await removeTaggedFixtures(prisma, SEED_TAG);
    expect(await prisma.user.findUnique({ where: { id: decoy.id } })).not.toBeNull();
    expect(await prisma.user.count({ where: { telegramId: BigInt(FIXTURE_BUYER_TELEGRAM_ID) } })).toBe(0);
  }, 60_000);

  it("removes the whole bulk catalog too and leaves untagged rows alone", async () => {
    await removeTaggedFixtures(prisma, SEED_TAG);
    const keeper = await prisma.category.create({ data: { name: "Bulk keeper", slug: "bulk-keeper", group: "PREMIUM_APPS" } });
    const keeperProduct = await prisma.product.create({ data: { categoryId: keeper.id, name: "Bulk keeper product", slug: "bulk-keeper-product" } });
    await buildGameTopupFixtures(prisma, { tag: SEED_TAG });
    const bulk = await buildBulkGameTopupCatalog(prisma, { tag: SEED_TAG });
    const taggedProducts = await prisma.product.count({ where: { name: { endsWith: SEED_TAG } } });
    const taggedDenominations = await prisma.denomination.count({ where: { name: { endsWith: SEED_TAG } } });
    expect(taggedProducts).toBeGreaterThan(bulk.products);
    expect(taggedDenominations).toBeGreaterThan(bulk.denominations);

    const removed = await removeTaggedFixtures(prisma, SEED_TAG);
    expect(removed.skipped).toEqual([]);
    expect(removed.products).toBe(taggedProducts);
    expect(removed.denominations).toBe(taggedDenominations);
    expect(removed.categories).toBe(5);
    expect(removed.users).toBe(1);
    expect(await prisma.product.count({ where: { name: { endsWith: SEED_TAG } } })).toBe(0);
    expect(await prisma.denomination.count({ where: { name: { endsWith: SEED_TAG } } })).toBe(0);
    expect(await prisma.category.findUnique({ where: { id: keeper.id } })).not.toBeNull();
    expect(await prisma.product.findUnique({ where: { id: keeperProduct.id } })).not.toBeNull();
  }, 180_000);
});
