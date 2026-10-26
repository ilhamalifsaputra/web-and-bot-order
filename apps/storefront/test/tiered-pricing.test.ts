// Storefront volume-tier pricing (plan hazy-doodling-ripple §7).
//
// Every per-quantity figure the storefront shows — the product page's tier
// ladder and quantity quote, each cart line, each checkout summary line, the
// grid badge — comes from the server's one engine (quoteBulkForLines /
// priceLineWithTiers), and the order-creating routes bind the click to the
// total the buyer was shown (expected_total → 409 error.quote_changed) on the
// gateway rails too, so a tier edited between preview and click is never
// charged unconfirmed.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  createCatalogProduct,
  createDenomination,
  addToCart,
  saveTieredPricing,
  type TierInput,
} from "@app/db";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let productSlug: string;
let categorySlug: string;
/** 10000; fixed 8000 from 3; fixed 6000 from 5 — the plan's worked example. */
let ladderId: number;
/** 10000 (reseller 9000); 10% from 2; fixed 8000 from 3. */
let stackId: number;

const actor = { adminId: null };

const LADDER: TierInput[] = [
  { minQuantity: 3, discountType: "FIXED_UNIT_PRICE", discountValue: "8000" },
  { minQuantity: 5, discountType: "FIXED_UNIT_PRICE", discountValue: "6000" },
];

let ipCounter = 0;
const freshIp = () => `198.51.100.${++ipCounter}`;

let userCounter = 0;
async function buyer(role: "CUSTOMER" | "RESELLER" = "CUSTOMER") {
  userCounter += 1;
  const username = `tierbuyer${userCounter}`;
  const password = `${username}-pw-1`;
  const u = await prisma.user.create({
    data: {
      loginUsername: username,
      email: `${username}@u.test`,
      passwordHash: hashPassword(password),
      referralCode: `TB${userCounter}X`,
      role,
    },
  });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier: username, password } });
  expect(login.statusCode).toBe(200);
  const c = login.headers["set-cookie"];
  const cookie = Array.isArray(c) ? c.join("; ") : String(c);
  const shell = await app.inject({ method: "GET", url: "/spa-shell-probe", headers: { cookie } });
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(shell.body)![1]!;
  return { id: u.id, cookie, csrf };
}
type Buyer = Awaited<ReturnType<typeof buyer>>;

const quote = (denominationId: number, qty: number, b?: Buyer) =>
  app.inject({ method: "GET", url: `/api/v1/pricing/quote?denomination_id=${denominationId}&qty=${qty}`, headers: b ? { cookie: b.cookie } : {} });

const post = (b: Buyer, url: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url,
    headers: { cookie: b.cookie, "x-csrf-token": b.csrf, "x-forwarded-for": freshIp(), ...headers },
    payload,
  });

const ordersOf = (userId: number) => prisma.order.count({ where: { userId } });

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  const cat = await prisma.category.create({
    data: { name: "Tier Apps", slug: "tier-apps", emoji: "📦", sortOrder: 1, group: "PREMIUM_APPS" },
  });
  categorySlug = cat.slug;
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Tier Product" });
  productSlug = product.slug;
  const ladder = await createDenomination(prisma, {
    productId: product.id, name: "Ladder plan", type: "SHARED", durationLabel: "1 Month", price: "10000", deliveryType: "manual",
  });
  ladderId = ladder.id;
  await saveTieredPricing(prisma, ladderId, { enabled: true, tiers: LADDER }, actor);
  const stack = await createDenomination(prisma, {
    productId: product.id, name: "Stack plan", type: "SHARED", durationLabel: "3 Months", price: "10000", resellerPrice: "9000", deliveryType: "manual",
  });
  stackId = stack.id;
  await saveTieredPricing(
    prisma,
    stackId,
    {
      enabled: true,
      tiers: [
        { minQuantity: 2, discountType: "PERCENTAGE", discountValue: "10" },
        { minQuantity: 3, discountType: "FIXED_UNIT_PRICE", discountValue: "8000" },
      ],
    },
    actor,
  );
  await setSetting(prisma, "bybit_uid", "123456789");
  await setSetting(prisma, "bybit_api_key", "k");
  await setSetting(prisma, "bybit_api_secret", "s");
  await setSetting(prisma, "usd_idr_rate", "16000");
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "Tier Test Shop");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

describe("GET /api/v1/pricing/quote — the engine's price at a quantity", () => {
  it("prices qty 1..6 of the 10000 / 8000-from-3 / 6000-from-5 ladder", async () => {
    const expected = [
      { qty: 1, total: "10000", unit: "10000", savings: "0", tier: null },
      { qty: 2, total: "20000", unit: "10000", savings: "0", tier: null },
      { qty: 3, total: "24000", unit: "8000", savings: "6000", tier: 3 },
      { qty: 4, total: "32000", unit: "8000", savings: "8000", tier: 3 },
      { qty: 5, total: "30000", unit: "6000", savings: "20000", tier: 5 },
      { qty: 6, total: "36000", unit: "6000", savings: "24000", tier: 5 },
    ];
    for (const row of expected) {
      const res = await quote(ladderId, row.qty);
      expect(res.statusCode, `qty ${row.qty}`).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      const body = res.json();
      expect(body).toMatchObject({
        denomination_id: ladderId,
        quantity: row.qty,
        base_unit_price: "10000",
        final_subtotal: row.total,
        original_subtotal: String(10000 * row.qty),
        savings: row.savings,
      });
      expect(Number(body.final_unit_price)).toBe(Number(row.unit));
      expect(body.applied_tier?.min_quantity ?? null).toBe(row.tier);
    }
  });

  it("stacks tiers on the reseller's effective unit; a fixed price never raises it", async () => {
    const reseller = await buyer("RESELLER");
    // Everyone: 10000 → 10% at 2 = 18000; fixed 8000 at 3 = 24000.
    expect((await quote(stackId, 2)).json().final_subtotal).toBe("18000");
    expect((await quote(stackId, 3)).json().final_subtotal).toBe("24000");
    // Reseller: 9000 → 10% at 2 = 16200; fixed 8000 at 3 = 24000 (below 27000).
    expect((await quote(stackId, 2, reseller)).json()).toMatchObject({ base_unit_price: "9000", final_subtotal: "16200" });
    expect((await quote(stackId, 3, reseller)).json().final_subtotal).toBe("24000");
  });

  it("stacks on a live flash sale, and a fixed price above the flash unit saves nothing", async () => {
    const hour = 3_600_000;
    await prisma.denomination.update({
      where: { id: stackId },
      data: { flashDiscountPercent: "25", flashStartsAt: new Date(Date.now() - hour), flashEndsAt: new Date(Date.now() + hour) },
    });
    try {
      // Flash unit 7500: 10% at 2 = 13500; the 8000 fixed price would RAISE 7500 → no discount.
      expect((await quote(stackId, 2)).json()).toMatchObject({ base_unit_price: "7500", final_subtotal: "13500" });
      const three = (await quote(stackId, 3)).json();
      expect(three).toMatchObject({ final_subtotal: "22500", savings: "0", applied_tier: null });
    } finally {
      await prisma.denomination.update({ where: { id: stackId }, data: { flashDiscountPercent: null, flashStartsAt: null, flashEndsAt: null } });
    }
  });

  it("refuses an unknown plan or an out-of-range quantity", async () => {
    expect((await quote(999999, 1)).statusCode).toBe(400);
    for (const bad of [0, 100, -1]) expect((await quote(ladderId, bad)).statusCode).toBe(400);
    const nonInteger = await app.inject({ method: "GET", url: `/api/v1/pricing/quote?denomination_id=${ladderId}&qty=1.5` });
    expect(nonInteger.statusCode).toBe(400);
  });
});

describe("catalog payloads carry the tiers", () => {
  it("product page: tiers, a server-priced ladder, and the legacy bulk view", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/pages/product/${productSlug}` });
    expect(res.statusCode).toBe(200);
    const denoms = res.json().denominations as Array<Record<string, unknown>>;
    const ladder = denoms.find((d) => d.id === ladderId)!;
    expect(ladder.tiers).toEqual([
      { min_quantity: 3, discount_type: "FIXED_UNIT_PRICE", discount_value: "8000" },
      { min_quantity: 5, discount_type: "FIXED_UNIT_PRICE", discount_value: "6000" },
    ]);
    expect((ladder.tier_ladder as Array<{ min_quantity: number; unit_price: string }>).map((s) => [s.min_quantity, Number(s.unit_price)])).toEqual([
      [3, 8000],
      [5, 6000],
    ]);
    // No percent tier → the legacy single-rule view has nothing to show.
    expect(ladder.bulk).toBeNull();
    const stack = denoms.find((d) => d.id === stackId)!;
    expect(stack.bulk).toEqual({ min_quantity: 2, discount_percent: "10" });
  });

  it("grid card: the best saving, a fixed tier as a whole percent rounded down and marked 'up to'", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/pages/category/${categorySlug}` });
    expect(res.statusCode).toBe(200);
    const card = (res.json().products as Array<Record<string, unknown>>).find((p) => p.slug === productSlug)!;
    // Ladder plan: 6000 fixed off a 10000 unit = 40% — beats the stack plan's 10% and 20%.
    expect(card).toMatchObject({ bulk_discount: "40", bulk_min_qty: 5, bulk_up_to: true });
  });

  it("a switched-off tier set disappears from every payload", async () => {
    await saveTieredPricing(prisma, ladderId, { enabled: false, tiers: LADDER }, actor);
    try {
      const page = await app.inject({ method: "GET", url: `/api/v1/pages/product/${productSlug}` });
      const ladder = (page.json().denominations as Array<Record<string, unknown>>).find((d) => d.id === ladderId)!;
      expect(ladder.tiers).toEqual([]);
      expect(ladder.tier_ladder).toEqual([]);
      expect((await quote(ladderId, 5)).json().final_subtotal).toBe("50000");
    } finally {
      await saveTieredPricing(prisma, ladderId, { enabled: true, tiers: LADDER }, actor);
    }
  });
});

describe("cart lines and the checkout summary agree", () => {
  it("each cart line is engine-priced, and the cart totals equal the checkout preview's", async () => {
    const b = await buyer();
    await addToCart(prisma, b.id, ladderId, 5);
    await addToCart(prisma, b.id, stackId, 2);
    const cart = await app.inject({ method: "GET", url: "/api/v1/cart", headers: { cookie: b.cookie } });
    expect(cart.statusCode).toBe(200);
    const body = cart.json();
    const ladderLine = body.items.find((l: { denomination_id: number }) => l.denomination_id === ladderId);
    expect(ladderLine.unit_price).toBe("10000"); // pre-tier, unchanged for older clients
    expect(ladderLine.line_total).toBe("50000");
    expect(ladderLine.pricing).toMatchObject({ quantity: 5, final_subtotal: "30000", savings: "20000", applied_tier: { min_quantity: 5 } });
    expect(Number(ladderLine.pricing.final_unit_price)).toBe(6000);
    expect(body).toMatchObject({ subtotal: "70000", bulk_discount: "22000", total: "48000" });

    const checkout = await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie: b.cookie } });
    const summary = checkout.json();
    expect(summary).toMatchObject({ subtotal: body.subtotal, total: body.total });
    expect(Number(summary.bulk_discount)).toBe(Number(body.bulk_discount));
    const summaryLine = summary.items.find((i: { denomination_id: number }) => i.denomination_id === ladderId);
    expect(summaryLine.pricing).toEqual(ladderLine.pricing);
  });

  it("a cart quantity update answers with the line re-priced at the new quantity", async () => {
    const b = await buyer();
    await addToCart(prisma, b.id, ladderId, 1);
    const cartItem = await prisma.cartItem.findFirstOrThrow({ where: { userId: b.id } });
    const res = await post(b, "/api/v1/cart/update", { key: cartItem.id, qty: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].pricing).toMatchObject({ quantity: 3, final_subtotal: "24000" });
    expect(res.json().total).toBe("24000");
  });
});

describe("quote binding on the gateway rails", () => {
  it("cart checkout: a tier edited after the preview → 409 with the new total and no order; the confirmed retry creates exactly one", async () => {
    const b = await buyer();
    await addToCart(prisma, b.id, ladderId, 5);
    const preview = await app.inject({ method: "GET", url: "/api/v1/checkout", headers: { cookie: b.cookie } });
    const shown = preview.json().total as string;
    expect(shown).toBe("30000");

    await saveTieredPricing(
      prisma,
      ladderId,
      { enabled: true, tiers: [LADDER[0]!, { minQuantity: 5, discountType: "FIXED_UNIT_PRICE", discountValue: "7000" }] },
      actor,
    );
    try {
      const stale = await post(b, "/api/v1/checkout", { method: "bybit", expected_total: shown }, { "idempotency-key": "tier-cart-1" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({ error: "error.quote_changed", currency: "IDR", expected_total: "30000", current_total: "35000" });
      expect(await ordersOf(b.id)).toBe(0);
      expect(await prisma.cartItem.count({ where: { userId: b.id } })).toBe(1);

      const confirmed = await post(b, "/api/v1/checkout", { method: "bybit", expected_total: "35000" }, { "idempotency-key": "tier-cart-2" });
      expect(confirmed.statusCode).toBe(201);
      // The same confirmed request retried (lost response) replays, never re-runs.
      const replay = await post(b, "/api/v1/checkout", { method: "bybit", expected_total: "35000" }, { "idempotency-key": "tier-cart-2" });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(confirmed.json());
      expect(await ordersOf(b.id)).toBe(1);
      const order = await prisma.order.findFirstOrThrow({ where: { userId: b.id } });
      expect(order.bulkDiscountAmount.toString()).toBe("15000");
    } finally {
      await saveTieredPricing(prisma, ladderId, { enabled: true, tiers: LADDER }, actor);
    }
  });

  it("instant buy: the same binding on POST /topup/order", async () => {
    const b = await buyer();
    await saveTieredPricing(prisma, stackId, { enabled: true, tiers: [{ minQuantity: 1, discountType: "PERCENTAGE", discountValue: "20" }] }, actor);
    try {
      const preview = await post(b, "/api/v1/topup/preview", { denomination_id: stackId, qty: 1 });
      expect(preview.json().total).toBe("8000");
      expect(preview.json().items[0].pricing).toMatchObject({ final_subtotal: "8000", applied_tier: { min_quantity: 1 } });
      await saveTieredPricing(prisma, stackId, { enabled: true, tiers: [{ minQuantity: 1, discountType: "PERCENTAGE", discountValue: "10" }] }, actor);
      const stale = await post(b, "/api/v1/topup/order", { denomination_id: stackId, qty: 1, method: "bybit", expected_total: "8000" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: "error.quote_changed", current_total: "9000" });
      expect(await ordersOf(b.id)).toBe(0);
      const ok = await post(b, "/api/v1/topup/order", { denomination_id: stackId, qty: 1, method: "bybit", expected_total: "9000" });
      expect(ok.statusCode).toBe(201);
      expect(await ordersOf(b.id)).toBe(1);
    } finally {
      await saveTieredPricing(
        prisma,
        stackId,
        {
          enabled: true,
          tiers: [
            { minQuantity: 2, discountType: "PERCENTAGE", discountValue: "10" },
            { minQuantity: 3, discountType: "FIXED_UNIT_PRICE", discountValue: "8000" },
          ],
        },
        actor,
      );
    }
  });

  it("a concurrent double submit with the same Idempotency-Key creates one order", async () => {
    const b = await buyer();
    await addToCart(prisma, b.id, ladderId, 3);
    const payload = { method: "bybit", expected_total: "24000" };
    const [first, second] = await Promise.all([
      post(b, "/api/v1/checkout", payload, { "idempotency-key": "tier-double-1" }),
      post(b, "/api/v1/checkout", payload, { "idempotency-key": "tier-double-1" }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    // The second either waited for and replayed the first, or was told it is still in progress.
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);
    if (statuses[1] === 409) {
      const loser = first.statusCode === 409 ? first : second;
      expect(loser.json().error).toBe("error.idempotency_request_in_progress");
    }
    expect(await ordersOf(b.id)).toBe(1);
  });

  it("without expected_total a gateway checkout behaves exactly as before", async () => {
    const b = await buyer();
    await addToCart(prisma, b.id, ladderId, 3);
    const res = await post(b, "/api/v1/checkout", { method: "bybit" });
    expect(res.statusCode).toBe(201);
    expect(await ordersOf(b.id)).toBe(1);
  });

  it("a malformed expected_total on a gateway method is a 400 and creates nothing", async () => {
    const b = await buyer();
    await addToCart(prisma, b.id, ladderId, 3);
    const res = await post(b, "/api/v1/checkout", { method: "bybit", expected_total: "24.000" });
    expect(res.statusCode).toBe(400);
    expect(await ordersOf(b.id)).toBe(0);
  });
});
