import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { provisionPgTestSchema, type PgTestSchemaEnv } from "../../tests/helpers/pgTestSchema";
import { buildGameTopupFixtures } from "../../tests/helpers/gameTopupFixtures";
import { assertSeedTarget, removeTaggedFixtures, SEED_DB_NAME, SEED_TAG } from "./seedGameTopup";

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
});
