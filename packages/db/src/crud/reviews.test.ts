import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  productRating,
  listReviews,
  countReviews,
  setReviewHidden,
  featuredReviews,
  overallRating,
  listRestockSubscribers,
  deleteRestockSubscription,
  subscribeToRestock,
  createReview,
  replyToReview,
  deleteReviewReply,
  setReviewStatus,
  deleteReview,
  reviewsKpis,
} from "./reviews";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";

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
async function seed(ratings: Array<{ rating: number; hidden?: boolean; comment?: string | null }>) {
  const cat = await createCategory(prisma, `c${Math.random()}`);
  const parent = await createCatalogProduct(prisma, { categoryId: cat.id, name: "P" });
  // Reviews are keyed by denomination (the SKU); column is `product_id`.
  const product = await createDenomination(prisma, {
    productId: parent.id,
    name: "P",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "5",
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
      data: {
        userId: user.id,
        orderId: order.id,
        productId: product.id,
        rating: r.rating,
        hidden: r.hidden ?? false,
        comment: r.comment === undefined ? null : r.comment,
      },
    });
  }
  return product.id;
}

/** Richer seed helper for the new filter/mutator/KPI tests below — same
 * product-plus-denomination setup as `seed`, but returns the created rows
 * (not just the product id) and accepts the new Review columns plus a few
 * user display-name fields (for `search` filter tests). Kept separate from
 * `seed` so the pre-existing tests above stay byte-for-byte untouched. */
async function seedReviews(
  items: Array<{
    rating: number;
    hidden?: boolean;
    comment?: string | null;
    status?: string;
    sentiment?: string;
    source?: string;
    fullName?: string | null;
    username?: string | null;
    loginUsername?: string | null;
    createdAt?: Date;
  }>,
) {
  const cat = await createCategory(prisma, `c${Math.random()}`);
  const parent = await createCatalogProduct(prisma, { categoryId: cat.id, name: "P" });
  const product = await createDenomination(prisma, {
    productId: parent.id,
    name: "P",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "5",
  });
  const reviews = [];
  for (const item of items) {
    const user = await prisma.user.create({
      data: {
        telegramId: BigInt(Math.floor(Math.random() * 1e15)),
        referralCode: `r${Math.random()}`,
        fullName: item.fullName ?? null,
        username: item.username ?? null,
        loginUsername: item.loginUsername ?? null,
      },
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
    const review = await prisma.review.create({
      data: {
        userId: user.id,
        orderId: order.id,
        productId: product.id,
        rating: item.rating,
        hidden: item.hidden ?? false,
        comment: item.comment === undefined ? null : item.comment,
        ...(item.status !== undefined ? { status: item.status } : {}),
        ...(item.sentiment !== undefined ? { sentiment: item.sentiment } : {}),
        ...(item.source !== undefined ? { source: item.source } : {}),
        ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
      },
    });
    reviews.push({ review, user, order });
  }
  return { productId: product.id, reviews };
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

describe("home-page social proof (featuredReviews + overallRating)", () => {
  it("featuredReviews keeps only visible, commented, ≥4★ reviews with joins", async () => {
    // Global query — start from a clean reviews table (earlier tests already ran).
    await prisma.review.deleteMany({});
    await seed([
      { rating: 5, comment: "great-keep" }, // ✓
      { rating: 4, comment: "good-keep" }, // ✓
      { rating: 3, comment: "meh-drop" }, // ✗ rating < 4
      { rating: 5, comment: null }, // ✗ no comment
      { rating: 5, comment: "hidden-drop", hidden: true }, // ✗ hidden
    ]);
    const feat = await featuredReviews(prisma, 10);
    const comments = feat.map((r) => r.comment);
    expect(comments).toContain("great-keep");
    expect(comments).toContain("good-keep");
    expect(comments).not.toContain("meh-drop");
    expect(comments).not.toContain("hidden-drop");
    expect(feat.every((r) => r.rating >= 4 && !r.hidden && r.comment)).toBe(true);
    // buyer + product joined so the testimonial card can render a name & product
    expect(feat[0]!.user).toBeTruthy();
    expect(feat[0]!.product).toBeTruthy();
  });

  it("overallRating averages visible reviews only", async () => {
    await prisma.review.deleteMany({});
    await seed([
      { rating: 5, comment: "a" },
      { rating: 3, comment: "b" },
      { rating: 1, comment: "c", hidden: true }, // hidden must not drag the average
    ]);
    const r = await overallRating(prisma);
    expect(r.count).toBe(2);
    expect(r.avg).toBeCloseTo(4.0);
  });
});

describe("listRestockSubscribers (web-only users excluded, user+product joined)", () => {
  it("excludes a subscriber whose user has no telegramId, and joins user + product", async () => {
    const productId = await seed([]);
    const linked = await prisma.user.create({
      data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}`, language: "EN" },
    });
    const webOnly = await prisma.user.create({
      data: { telegramId: null, referralCode: `r${Math.random()}`, language: "EN" },
    });
    await subscribeToRestock(prisma, linked.id, productId);
    await subscribeToRestock(prisma, webOnly.id, productId);

    const subs = await listRestockSubscribers(prisma, productId);

    expect(subs).toHaveLength(1);
    expect(subs[0]!.userId).toBe(linked.id);
    expect(subs[0]!.user.telegramId).toBe(linked.telegramId);
    expect(subs[0]!.product.name).toBeTruthy();
  });
});

describe("deleteRestockSubscription", () => {
  it("removes exactly the given subscription, leaving others for the same product untouched", async () => {
    const productId = await seed([]);
    const a = await prisma.user.create({
      data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
    });
    const b = await prisma.user.create({
      data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
    });
    await subscribeToRestock(prisma, a.id, productId);
    await subscribeToRestock(prisma, b.id, productId);
    const [subA, subB] = await listRestockSubscribers(prisma, productId);

    await deleteRestockSubscription(prisma, subA!.id);

    const remaining = await prisma.restockSubscription.findMany({ where: { productId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(subB!.id);
  });
});

describe("ReviewFilter — new fields (status, sentiment, source, rating, search, since/until)", () => {
  it("filters by status", async () => {
    await prisma.review.deleteMany({});
    await seedReviews([
      { rating: 5, status: "PENDING_REPLY" },
      { rating: 4, status: "REPLIED" },
      { rating: 3, status: "CLOSED" },
    ]);
    const pending = await listReviews(prisma, { status: "PENDING_REPLY" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.rating).toBe(5);
    expect(await countReviews(prisma, { status: "REPLIED" })).toBe(1);
    expect(await countReviews(prisma, { status: "CLOSED" })).toBe(1);
  });

  it("filters by sentiment", async () => {
    await prisma.review.deleteMany({});
    await seedReviews([
      { rating: 5, sentiment: "POSITIVE" },
      { rating: 3, sentiment: "NEUTRAL" },
      { rating: 1, sentiment: "NEGATIVE" },
    ]);
    expect(await countReviews(prisma, { sentiment: "NEGATIVE" })).toBe(1);
    expect(await countReviews(prisma, { sentiment: "POSITIVE" })).toBe(1);
  });

  it("filters by source", async () => {
    await prisma.review.deleteMany({});
    await seedReviews([
      { rating: 5, source: "CUSTOMER" },
      { rating: 4, source: "SYSTEM_AUTO" },
    ]);
    expect(await countReviews(prisma, { source: "SYSTEM_AUTO" })).toBe(1);
    expect(await countReviews(prisma, { source: "CUSTOMER" })).toBe(1);
  });

  it("filters by exact rating (not a >= threshold)", async () => {
    await prisma.review.deleteMany({});
    await seedReviews([{ rating: 3 }, { rating: 4 }, { rating: 5 }]);
    const threes = await listReviews(prisma, { rating: 3 });
    expect(threes).toHaveLength(1);
    expect(threes[0]!.rating).toBe(3);
  });

  it("search matches comment OR the joined user's fullName/username/loginUsername", async () => {
    await prisma.review.deleteMany({});
    await seedReviews([
      { rating: 5, comment: "excellent service" },
      { rating: 4, comment: "meh", fullName: "Jane Doe" },
      { rating: 3, comment: "nothing special", username: "bobby" },
      { rating: 2, comment: "unrelated", loginUsername: "carlito" },
      { rating: 1, comment: "no match here" },
    ]);

    const byComment = await listReviews(prisma, { search: "excellent" });
    expect(byComment).toHaveLength(1);
    expect(byComment[0]!.comment).toBe("excellent service");

    expect(await countReviews(prisma, { search: "Jane" })).toBe(1);
    expect(await countReviews(prisma, { search: "bobby" })).toBe(1);
    expect(await countReviews(prisma, { search: "carlito" })).toBe(1);
    expect(await countReviews(prisma, { search: "zzz-no-match" })).toBe(0);
  });

  it("filters by since/until createdAt range", async () => {
    await prisma.review.deleteMany({});
    const old = new Date("2020-01-01T00:00:00Z");
    const mid = new Date("2023-06-01T00:00:00Z");
    const recent = new Date("2026-01-01T00:00:00Z");
    await seedReviews([
      { rating: 5, createdAt: old },
      { rating: 4, createdAt: mid },
      { rating: 3, createdAt: recent },
    ]);
    const inRange = await listReviews(prisma, {
      since: new Date("2022-01-01T00:00:00Z"),
      until: new Date("2024-01-01T00:00:00Z"),
    });
    expect(inRange).toHaveLength(1);
    expect(inRange[0]!.rating).toBe(4);
  });
});

describe("replyToReview / deleteReviewReply (round-trip, status flips)", () => {
  it("replyToReview sets the reply fields and flips status to REPLIED; deleteReviewReply clears them and reverts to PENDING_REPLY", async () => {
    await prisma.review.deleteMany({});
    const { reviews } = await seedReviews([{ rating: 5, status: "PENDING_REPLY" }]);
    const reviewId = reviews[0]!.review.id;
    const admin = await prisma.user.create({
      data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}`, role: "ADMIN" },
    });

    const replied = await replyToReview(prisma, reviewId, { reply: "Thanks for the feedback!", adminId: admin.id });
    expect(replied.adminReply).toBe("Thanks for the feedback!");
    expect(replied.repliedByAdminId).toBe(admin.id);
    expect(replied.repliedAt).toBeTruthy();
    expect(replied.status).toBe("REPLIED");

    // Doubles as create-and-edit — a single-message reply, not a thread.
    const edited = await replyToReview(prisma, reviewId, { reply: "Updated reply", adminId: admin.id });
    expect(edited.adminReply).toBe("Updated reply");
    expect(edited.status).toBe("REPLIED");

    const cleared = await deleteReviewReply(prisma, reviewId);
    expect(cleared.adminReply).toBeNull();
    expect(cleared.repliedAt).toBeNull();
    expect(cleared.repliedByAdminId).toBeNull();
    expect(cleared.status).toBe("PENDING_REPLY");
  });
});

describe("setReviewStatus", () => {
  it("transitions between CLOSED and PENDING_REPLY", async () => {
    await prisma.review.deleteMany({});
    const { reviews } = await seedReviews([{ rating: 5, status: "PENDING_REPLY" }]);
    const reviewId = reviews[0]!.review.id;

    const closed = await setReviewStatus(prisma, reviewId, "CLOSED");
    expect(closed.status).toBe("CLOSED");

    const reopened = await setReviewStatus(prisma, reviewId, "PENDING_REPLY");
    expect(reopened.status).toBe("PENDING_REPLY");
  });
});

describe("deleteReview", () => {
  it("hard-deletes exactly the given review, leaving other reviews' productRating undisturbed", async () => {
    await prisma.review.deleteMany({});
    const { productId, reviews } = await seedReviews([{ rating: 5 }, { rating: 1 }]);
    const [keep, toDelete] = reviews;

    await deleteReview(prisma, toDelete!.review.id);

    const remaining = await prisma.review.findMany({ where: { productId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(keep!.review.id);

    const rating = await productRating(prisma, productId);
    expect(rating.count).toBe(1);
    expect(rating.avg).toBeCloseTo(5.0);
  });
});

describe("reviewsKpis", () => {
  it("aggregates visible reviews only, except hiddenCount", async () => {
    await prisma.review.deleteMany({});
    await seedReviews([
      { rating: 5, status: "REPLIED", sentiment: "POSITIVE" },
      { rating: 5, status: "PENDING_REPLY", sentiment: "POSITIVE" },
      { rating: 3, status: "PENDING_REPLY", sentiment: "NEUTRAL" },
      { rating: 1, status: "PENDING_REPLY", sentiment: "NEGATIVE" },
      { rating: 2, status: "CLOSED", sentiment: "NEGATIVE" },
      // Hidden — excluded from every figure except hiddenCount itself.
      { rating: 5, hidden: true, status: "PENDING_REPLY", sentiment: "POSITIVE" },
    ]);

    const kpis = await reviewsKpis(prisma);

    expect(kpis.totalReviews).toBe(5);
    expect(kpis.avgRating).toBeCloseTo((5 + 5 + 3 + 1 + 2) / 5);
    expect(kpis.pendingReplyCount).toBe(3);
    expect(kpis.negativeCount).toBe(2);
    expect(kpis.hiddenCount).toBe(1);
    expect(kpis.ratingDistribution).toEqual({ 1: 1, 2: 1, 3: 1, 4: 0, 5: 2 });
  });
});

describe("createReview — sentiment assignment", () => {
  it("classifies sentiment per rating bucket at insert time, leaving status/source on their schema defaults", async () => {
    const cat = await createCategory(prisma, `c${Math.random()}`);
    const parent = await createCatalogProduct(prisma, { categoryId: cat.id, name: "P" });
    const product = await createDenomination(prisma, {
      productId: parent.id,
      name: "P",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "5",
    });

    async function makeDeliveredOrder() {
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
      return { userId: user.id, orderId: order.id };
    }

    const cases: Array<{ rating: number; expected: string }> = [
      { rating: 5, expected: "POSITIVE" },
      { rating: 4, expected: "POSITIVE" },
      { rating: 3, expected: "NEUTRAL" },
      { rating: 2, expected: "NEGATIVE" },
      { rating: 1, expected: "NEGATIVE" },
    ];
    for (const c of cases) {
      const { userId, orderId } = await makeDeliveredOrder();
      const review = await createReview(prisma, {
        userId,
        orderId,
        productId: product.id,
        rating: c.rating,
        comment: null,
      });
      expect(review.sentiment).toBe(c.expected);
      expect(review.status).toBe("PENDING_REPLY");
      expect(review.source).toBe("CUSTOMER");
    }
  });
});
