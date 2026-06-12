import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { productRating, listReviews, setReviewHidden } from "./reviews";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

/** Seed a product plus N reviews with the given ratings/hidden flags. */
async function seed(ratings: Array<{ rating: number; hidden?: boolean }>) {
  const cat = await prisma.category.create({ data: { name: `c${Math.random()}` } });
  const product = await prisma.product.create({
    data: { categoryId: cat.id, name: "P", type: "SHARED", durationLabel: "1 Month", price: "5" },
  });
  for (const [i, r] of ratings.entries()) {
    const user = await prisma.user.create({
      data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
    });
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-${Math.random()}`,
        userId: user.id,
        subtotalAmount: "5",
        totalAmount: "5",
        status: "DELIVERED",
      },
    });
    await prisma.review.create({
      data: { userId: user.id, orderId: order.id, productId: product.id, rating: r.rating, hidden: r.hidden ?? false },
    });
  }
  return product.id;
}

describe("productRating (hidden reviews excluded)", () => {
  it("averages only visible reviews", async () => {
    // visible: 5, 3 → avg 4.0 (count 2); hidden 1-star must NOT drag it down.
    const productId = await seed([{ rating: 5 }, { rating: 3 }, { rating: 1, hidden: true }]);
    const r = await productRating(prisma, productId);
    expect(r.count).toBe(2);
    expect(r.avg).toBeCloseTo(4.0);
  });

  it("returns null avg / zero count when every review is hidden", async () => {
    const productId = await seed([{ rating: 5, hidden: true }]);
    const r = await productRating(prisma, productId);
    expect(r.count).toBe(0);
    expect(r.avg).toBeNull();
  });

  it("hiding a review changes the average it reports", async () => {
    const productId = await seed([{ rating: 5 }, { rating: 1 }]);
    expect((await productRating(prisma, productId)).avg).toBeCloseTo(3.0);
    const reviews = await listReviews(prisma, { productId });
    const oneStar = reviews.find((r) => r.rating === 1)!;
    await setReviewHidden(prisma, oneStar.id, true);
    const after = await productRating(prisma, productId);
    expect(after.count).toBe(1);
    expect(after.avg).toBeCloseTo(5.0);
  });
});
