// The home page by product group, the group page API, flash cards and the
// bestseller/newest/cheapest sort keys — driven through app.inject() against
// an isolated schema so the catalog (and so every ordering) is exactly what
// this file seeds.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  deleteSetting,
  createCatalogProduct,
  createDenomination,
  setFlashSale,
  getBestsellerSnapshot,
} from "@app/db";
import { GROUP_ORDER_SETTING_KEY } from "@app/core";
import { buildApp } from "../src/server";

const DAY = 24 * 3600_000;
const GAME_WEB_KEY = "service_game_topup_enabled_web";

let app: FastifyInstance;
let createdOffset = 0;

/**
 * One product with one plan. `stock` undefined = a manual plan (never sold
 * out); a number = a local-inventory plan holding that many rows.
 * Products are created oldest first, so later seeds are "newer".
 */
async function seed(categoryId: number, name: string, price: string, stock?: number) {
  const product = await createCatalogProduct(prisma, { categoryId, name });
  createdOffset += 1;
  await prisma.product.update({ where: { id: product.id }, data: { createdAt: new Date(Date.now() - (100 - createdOffset) * DAY) } });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: `${name} plan`,
    type: "SHARED",
    durationLabel: "1 Month",
    price,
    deliveryType: stock === undefined ? "manual" : "auto",
  });
  if (stock) {
    await prisma.stockItem.createMany({
      data: Array.from({ length: stock }, () => ({ productId: denom.id, credentials: "a@b:c", status: "AVAILABLE" })),
    });
  }
  return { product, denom };
}

let buyerId: number;
let orderSeq = 0;
/** `n` distinct delivered orders of a denomination, delivered just now. */
async function sell(denominationId: number, n: number) {
  for (let i = 0; i < n; i++) {
    const order = await prisma.order.create({
      data: {
        orderCode: `HG-${++orderSeq}`,
        userId: buyerId,
        subtotalAmount: "1000",
        totalAmount: "1000",
        status: "DELIVERED",
        deliveredAt: new Date(),
      },
    });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: denominationId, unitPrice: "1000", warrantyDaysSnapshot: 0 } });
  }
}

type Card = { slug: string; from_price: string };
type Section = { key: string; kind: string; title: string | null; emoji: string | null; category_slugs: string[]; products: Card[]; total: number; all_sold_out: boolean };
type Group = { key: string; slug: string; label_key: string; emoji: string; layout: string; category_count: number; single_category_slug: string | null; sections: Section[] };

const S: Record<string, string> = {};
const D: Record<string, number> = {};
const C: Record<string, string> = {};

async function home() {
  const res = await app.inject({ method: "GET", url: "/api/v1/pages/home" });
  expect(res.statusCode).toBe(200);
  return res.json() as { groups: Group[]; hero_products: Card[]; flash: Array<Card & Record<string, unknown>>; ranking_version: number } & Record<string, unknown>;
}

async function groupPage(slug: string, query = "") {
  return app.inject({ method: "GET", url: `/api/v1/pages/group/${slug}${query}` });
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await setSetting(prisma, "setup_completed", "true");
  buyerId = (await prisma.user.create({ data: { telegramId: 7_000_001n, referralCode: "HGBUY1" } })).id;

  const video = await prisma.category.create({ data: { name: "Video", slug: "video", emoji: "🎬", sortOrder: 1, group: "PREMIUM_APPS" } });
  // A legacy category with no group is shown as Premium Apps.
  const music = await prisma.category.create({ data: { name: "Music", slug: "music", emoji: "🎵", sortOrder: 2, group: null } });
  const tools = await prisma.category.create({ data: { name: "Tools", slug: "tools", emoji: null, sortOrder: 3, group: "PREMIUM_APPS" } });
  const ml = await prisma.category.create({ data: { name: "Mobile Legends", slug: "ml", emoji: "⚔️", sortOrder: 1, group: "GAME_TOPUP" } });
  const ff = await prisma.category.create({ data: { name: "Free Fire", slug: "ff", emoji: "🔥", sortOrder: 2, group: "GAME_TOPUP" } });
  Object.assign(C, { video: video.slug, music: music.slug, tools: tools.slug, ml: ml.slug, ff: ff.slug });

  for (const [key, cat, name, price, stock] of [
    ["v1", video.id, "Video One", "30000", undefined],
    ["v2", video.id, "Video Two", "20000", undefined],
    ["v3", video.id, "Video Three", "25000", undefined],
    ["m1", music.id, "Music One", "15000", undefined],
    ["t1", tools.id, "Tools One", "10000", 5],
    ["g1", ml.id, "ML Cheap", "5000", undefined],
    ["g2", ml.id, "ML Pricey", "90000", undefined],
    ["g3", ml.id, "ML Sold Out", "7000", 0],
    ["g4", ff.id, "FF One", "12000", undefined],
  ] as const) {
    const { product, denom } = await seed(cat, name, price, stock);
    S[key] = product.slug;
    D[key] = denom.id;
  }
  // Bestsellers: Video Two in Premium Apps, ML Pricey in games. ML Sold Out
  // sells most of all, but a sold-out product always goes to the back.
  await sell(D.v2!, 2);
  await sell(D.g2!, 1);
  await sell(D.g3!, 3);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await cleanupTestDb();
});

describe("GET /api/v1/pages/home — grouped by product group", () => {
  it("replaces the flat categories/products with one entry per group, in default order", async () => {
    const body = await home();
    expect(body).not.toHaveProperty("categories");
    expect(body).not.toHaveProperty("products");
    expect(typeof body.ranking_version).toBe("number");
    expect(body.flash).toEqual([]);
    for (const key of ["hero_image", "testimonials", "low_threshold", "bot_username", "support_telegram_url", "wa_number"]) {
      expect(body).toHaveProperty(key);
    }
    expect(body.groups.map((g) => g.key)).toEqual(["PREMIUM_APPS", "GAME_TOPUP"]);
    expect(body.groups[0]).toMatchObject({
      slug: "premium-apps",
      label_key: "web.group_premium_apps",
      emoji: "💎",
      layout: "byCategory",
      category_count: 3,
      single_category_slug: null,
    });
    expect(body.groups[1]).toMatchObject({ slug: "top-up-games", layout: "single", category_count: 2, single_category_slug: null });
  });

  it("splits Premium Apps into category sub-sections and an Others section", async () => {
    const [premium] = (await home()).groups;
    expect(premium!.sections.map((s) => s.key)).toEqual([`c-${C.video}`, "others"]);
    expect(premium!.sections[0]).toMatchObject({ kind: "category", title: "Video", emoji: "🎬", category_slugs: [C.video], total: 3, all_sold_out: false });
    // Bestseller first, then newest.
    expect(premium!.sections[0]!.products.map((p) => p.slug)).toEqual([S.v2, S.v3, S.v1]);
    expect(premium!.sections[1]).toMatchObject({ kind: "others", title: null, category_slugs: [C.music, C.tools], total: 2 });
  });

  it("shows Top Up Games as one grid with sold-out products last", async () => {
    const games = (await home()).groups[1]!;
    expect(games.sections).toHaveLength(1);
    expect(games.sections[0]).toMatchObject({ key: "all", kind: "group", category_slugs: [C.ml, C.ff], total: 4 });
    expect(games.sections[0]!.products.map((p) => p.slug)).toEqual([S.g2, S.g4, S.g1, S.g3]);
  });

  it("puts each group's first available bestseller in the hero, in group order, then fills to 3", async () => {
    // One per group first (v2, g2); the third slot goes to the next available
    // product across groups in group order — Premium's second, t1.
    expect((await home()).hero_products.map((p) => p.slug)).toEqual([S.v2, S.g2, S.t1]);
  });

  it("follows the admin group order setting", async () => {
    await setSetting(prisma, GROUP_ORDER_SETTING_KEY, JSON.stringify(["GAME_TOPUP", "PREMIUM_APPS"]));
    try {
      const body = await home();
      expect(body.groups.map((g) => g.key)).toEqual(["GAME_TOPUP", "PREMIUM_APPS"]);
      expect(body.hero_products.map((p) => p.slug)).toEqual([S.g2, S.v2, S.g4]);
    } finally {
      await deleteSetting(prisma, GROUP_ORDER_SETTING_KEY);
    }
  });

  it("drops a group whose web service is switched off", async () => {
    await setSetting(prisma, GAME_WEB_KEY, "false");
    try {
      const body = await home();
      expect(body.groups.map((g) => g.key)).toEqual(["PREMIUM_APPS"]);
      // One group left: still three cards, in that group's bestseller order.
      expect(body.hero_products.map((p) => p.slug)).toEqual([S.v2, S.t1, S.m1]);
    } finally {
      await deleteSetting(prisma, GAME_WEB_KEY);
    }
  });

  it("names the only category of a single-category group", async () => {
    await prisma.category.update({ where: { slug: C.ff }, data: { isActive: false } });
    try {
      const games = (await home()).groups.find((g) => g.key === "GAME_TOPUP")!;
      expect(games).toMatchObject({ category_count: 1, single_category_slug: C.ml });
    } finally {
      await prisma.category.update({ where: { slug: C.ff }, data: { isActive: true } });
    }
  });
});

describe("GET /api/v1/pages/group/:slug", () => {
  it("404s an unknown group slug", async () => {
    const res = await groupPage("no-such-group");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("returns the group, its categories and its ranked products", async () => {
    const res = await groupPage("premium-apps");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.group).toEqual({ key: "PREMIUM_APPS", slug: "premium-apps", label_key: "web.group_premium_apps", emoji: "💎", allow_cheapest: true });
    expect(body.unavailable).toBe(false);
    expect(body.categories).toEqual([
      { slug: C.video, name: "Video", emoji: "🎬" },
      { slug: C.music, name: "Music", emoji: "🎵" },
      { slug: C.tools, name: "Tools", emoji: null },
    ]);
    expect(body.sort).toBe("bestseller");
    expect(body.total).toBe(5);
    expect(body.next_offset).toBeNull();
    expect(body.products.map((p: Card) => p.slug)).toEqual([S.v2, S.t1, S.m1, S.v3, S.v1]);
    expect(typeof body.ranking_version).toBe("number");
    expect(typeof body.low_threshold).toBe("number");
  });

  it("reports a switched-off group as unavailable with no products", async () => {
    await setSetting(prisma, GAME_WEB_KEY, "false");
    try {
      const res = await groupPage("top-up-games");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ unavailable: true, categories: [], products: [], total: 0, next_offset: null });
    } finally {
      await deleteSetting(prisma, GAME_WEB_KEY);
    }
  });

  it("filters by category slugs, ignoring unknown slugs and other groups' categories", async () => {
    const res = await groupPage("premium-apps", `?category=${C.music},nope,${C.ml},${C.tools}`);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.products.map((p: Card) => p.slug)).toEqual([S.t1, S.m1]);

    const unknownOnly = (await groupPage("premium-apps", "?category=nope")).json();
    expect(unknownOnly.total).toBe(5);
  });

  it("treats a repeated category parameter like a comma-separated list", async () => {
    const body = (await groupPage("premium-apps", `?category=${C.music}&category=${C.tools},nope`)).json();
    expect(body.total).toBe(2);
    expect(body.products.map((p: Card) => p.slug)).toEqual([S.t1, S.m1]);
  });

  it("pages with offset and limit without repeating or skipping a product", async () => {
    const all = (await groupPage("premium-apps")).json().products.map((p: Card) => p.slug);
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const body: { products: Card[]; next_offset: number | null } = (
        await groupPage("premium-apps", `?offset=${offset}&limit=2`)
      ).json();
      expect(body.products.length).toBeLessThanOrEqual(2);
      seen.push(...body.products.map((p: Card) => p.slug));
      offset = body.next_offset;
      pages++;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(all);
  });

  it("falls back to sane paging for out-of-range or malformed offset/limit", async () => {
    const big = (await groupPage("premium-apps", "?limit=500")).json();
    expect(big.products).toHaveLength(5);
    const zero = (await groupPage("premium-apps", "?limit=0&offset=-3")).json();
    expect(zero.products).toHaveLength(1);
    const junk = (await groupPage("premium-apps", "?limit=abc&offset=xyz")).json();
    expect(junk.products).toHaveLength(5);
  });

  it("rejects cheapest on Top Up Games and accepts it on Premium Apps", async () => {
    const games = (await groupPage("top-up-games", "?sort=cheapest")).json();
    expect(games.group.allow_cheapest).toBe(false);
    expect(games.sort).toBe("bestseller");
    expect(games.products.map((p: Card) => p.slug)).toEqual([S.g2, S.g4, S.g1, S.g3]);

    const premium = (await groupPage("premium-apps", "?sort=cheapest")).json();
    expect(premium.sort).toBe("cheapest");
    expect(premium.products.map((p: Card) => p.slug)).toEqual([S.t1, S.m1, S.v2, S.v3, S.v1]);

    expect((await groupPage("premium-apps", "?sort=newest")).json().products.map((p: Card) => p.slug)).toEqual([S.t1, S.m1, S.v3, S.v2, S.v1]);
    expect((await groupPage("premium-apps", "?sort=rating")).json().sort).toBe("bestseller");
  });

  it("keeps ranking with the requested snapshot version while it is still held", async () => {
    const first = (await groupPage("premium-apps", "?limit=1")).json();
    const version = first.ranking_version;
    expect(first.products[0].slug).toBe(S.v2);

    // Video One overtakes, and a newer ranking snapshot is computed.
    await sell(D.v1!, 5);
    const fresh = await getBestsellerSnapshot(prisma, { now: new Date(Date.now() + 10 * 60_000) });
    expect(fresh.version).toBe(version + 1);

    const stable = (await groupPage("premium-apps", `?v=${version}`)).json();
    expect(stable.ranking_version).toBe(version);
    expect(stable.products[0].slug).toBe(S.v2);

    const current = (await groupPage("premium-apps")).json();
    expect(current.ranking_version).toBe(version + 1);
    expect(current.products[0].slug).toBe(S.v1);

    const unknown = (await groupPage("premium-apps", "?v=987654")).json();
    expect(unknown.ranking_version).toBe(version + 1);
  });
});

describe("GET /api/v1/pages/category/:slug — sort keys", () => {
  it("reports the category's group and whether cheapest is offered", async () => {
    const premium = (await app.inject({ method: "GET", url: `/api/v1/pages/category/${C.music}` })).json();
    expect(premium).toMatchObject({ group: "PREMIUM_APPS", allow_cheapest: true });
    const games = (await app.inject({ method: "GET", url: `/api/v1/pages/category/${C.ml}` })).json();
    expect(games).toMatchObject({ group: "GAME_TOPUP", allow_cheapest: false });
  });

  it("treats legacy and unknown sort keys as bestseller, and refuses cheapest on a game category", async () => {
    for (const sort of ["rating", "default", "bogus", "cheapest"]) {
      const body = (await app.inject({ method: "GET", url: `/api/v1/pages/category/${C.ml}?sort=${sort}` })).json();
      expect(body.products.map((p: Card) => p.slug)).toEqual([S.g2, S.g1, S.g3]);
    }
    const newest = (await app.inject({ method: "GET", url: `/api/v1/pages/category/${C.video}?sort=newest` })).json();
    expect(newest.products.map((p: Card) => p.slug)).toEqual([S.v3, S.v2, S.v1]);
  });

  it("sorts a Premium Apps category by cheapest when asked", async () => {
    const body = (await app.inject({ method: "GET", url: `/api/v1/pages/category/${C.video}?sort=cheapest` })).json();
    expect(body.products.map((p: Card) => p.slug)).toEqual([S.v2, S.v3, S.v1]);
  });
});

describe("GET /api/v1/pages/search — sort", () => {
  const search = async (query: string) => (await app.inject({ method: "GET", url: `/api/v1/pages/search?q=ML${query}` })).json();

  it("keeps the search relevance order by default, with sold-out products last", async () => {
    for (const query of ["", "&sort=default", "&sort=rating", "&sort=bogus"]) {
      const body = await search(query);
      expect(body.sort).toBe("relevance");
      expect(body.products.map((p: Card) => p.slug)).toEqual([S.g1, S.g2, S.g3]);
    }
  });

  it("applies an explicit sort key", async () => {
    const bestseller = await search("&sort=bestseller");
    expect(bestseller.sort).toBe("bestseller");
    expect(bestseller.products.map((p: Card) => p.slug)).toEqual([S.g2, S.g1, S.g3]);
    const cheapest = await search("&sort=cheapest");
    expect(cheapest.sort).toBe("cheapest");
    expect(cheapest.products.map((p: Card) => p.slug)).toEqual([S.g1, S.g2, S.g3]);
  });
});

describe("flash cards", () => {
  it("advertises the flashed plan, not the cheapest one, on the home Flash Sale and on /flash", async () => {
    const { product } = await seed((await prisma.category.findUniqueOrThrow({ where: { slug: C.video } })).id, "Video Flash", "20000");
    const year = await createDenomination(prisma, {
      productId: product.id,
      name: "1 Year",
      type: "SHARED",
      durationLabel: "1 Year",
      price: "150000",
      deliveryType: "manual",
    });
    await setFlashSale(prisma, {
      denominationId: year.id,
      discountPercent: "30",
      startsAt: new Date(Date.now() - 3600_000),
      endsAt: new Date(Date.now() + 3600_000),
    });

    const flash = (await home()).flash;
    expect(flash).toHaveLength(1);
    expect(flash[0]).toMatchObject({
      slug: product.slug,
      from_price: "105000",
      from_base_price: "150000",
      flash_discount: "30",
      promo_denomination_id: year.id,
      promo_denomination_name: "1 Year",
      other_promo_count: 0,
    });

    const page = (await app.inject({ method: "GET", url: "/api/v1/pages/flash" })).json();
    expect(page.products).toEqual(flash);
  });
});
