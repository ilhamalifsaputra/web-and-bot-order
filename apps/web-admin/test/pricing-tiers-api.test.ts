import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory, createCatalogProduct, createDenomination, listTiers } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

/**
 * The tier editor's API: GET/PUT /api/catalog/denominations/:id/pricing-tiers.
 * Typed amounts are read BY SHAPE (AGENTS.md): a percent tier's `12,5` is 12.5,
 * a nominal tier's `10.000` is ten thousand rupiah, an ambiguous shape is
 * refused, and an untouched pre-filled value named in the tier's
 * `exact_fields` is read as the plain dot-decimal the server sent.
 */

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let adminId: number;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb(prisma);
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  adminId = admin.id;
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

async function seedDenomination(opts: { costPrice?: string } = {}) {
  const category = await createCategory(prisma, "Cat");
  const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent" });
  const denom = await createDenomination(prisma, {
    productId: parent.id,
    name: "1 Month",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "10000",
    ...(opts.costPrice ? { costPrice: opts.costPrice } : {}),
  });
  return { denomId: denom.id, productId: parent.id };
}

const url = (id: number) => `/api/catalog/denominations/${id}/pricing-tiers`;

function put(id: number, body: unknown, opts: { cookie?: string | null; csrf?: string } = {}) {
  const c = opts.cookie === undefined ? cookie : opts.cookie;
  return app.inject({
    method: "PUT",
    url: url(id),
    headers: { "content-type": "application/json", "x-csrf-token": opts.csrf ?? csrf },
    cookies: c ? { [COOKIE]: c } : {},
    payload: JSON.stringify(body),
  });
}

function get(id: number, c: string | null = cookie) {
  return app.inject({ method: "GET", url: url(id), cookies: c ? { [COOKIE]: c } : {} });
}

const EXAMPLE = [
  { min_quantity: 3, discount_type: "FIXED_UNIT_PRICE", discount_value: "8.000", is_enabled: true },
  { min_quantity: 5, discount_type: "FIXED_UNIT_PRICE", discount_value: "6.000", is_enabled: true },
];

describe("GET pricing-tiers", () => {
  it("anon gets a 401; an unknown or malformed id a 404/400", async () => {
    const { denomId } = await seedDenomination();
    expect((await get(denomId, null)).statusCode).toBe(401);
    expect((await get(999999)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/catalog/denominations/abc/pricing-tiers", cookies: { [COOKIE]: cookie } })).statusCode).toBe(400);
  });

  it("returns the toggle, the tiers, the price context and an empty analysis for a fresh SKU", async () => {
    const { denomId } = await seedDenomination({ costPrice: "7000" });
    const res = await get(denomId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      enabled: false,
      tiers: [],
      base_unit_price: "10000",
      cost_price: "7000",
      analysis: { non_monotonic: [], below_cost: [] },
    });
  });
});

describe("PUT pricing-tiers", () => {
  it("needs a session and a valid CSRF token", async () => {
    const { denomId } = await seedDenomination();
    expect((await put(denomId, { enabled: true, tiers: EXAMPLE }, { cookie: null })).statusCode).toBe(401);
    expect((await put(denomId, { enabled: true, tiers: EXAMPLE }, { csrf: "bad" })).statusCode).toBe(403);
    expect(await listTiers(prisma, denomId)).toEqual([]);
  });

  it("saves the 10000 / 8000 / 6000 example (nominal 8.000 read as eight thousand), audited with the admin id", async () => {
    const { denomId } = await seedDenomination({ costPrice: "7000" });
    const res = await put(denomId, { enabled: true, tiers: EXAMPLE });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.tiers.map((t: { min_quantity: number; discount_value: string }) => [t.min_quantity, t.discount_value])).toEqual([
      [3, "8000"],
      [5, "6000"],
    ]);
    expect(typeof body.tiers[0].id).toBe("string");
    // 4 units cost 32.000, 5 units only 30.000; 6.000 per unit is below the 7.000 cost.
    expect(body.analysis.non_monotonic).toEqual([{ from_quantity: 4, to_quantity: 5, from_total: "32000", to_total: "30000" }]);
    expect(body.analysis.below_cost).toEqual([{ tier_id: body.tiers[1].id, min_quantity: 5, final_unit_price: "6000" }]);

    const audit = await prisma.auditLog.findMany({ where: { targetId: denomId }, orderBy: { id: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["pricing_tiers_replace", "tiered_pricing_toggle"]);
    expect(audit.every((a) => a.adminId === adminId)).toBe(true);

    const reread = (await get(denomId)).json();
    expect(reread).toEqual(body);
  });

  it("a percent tier reads 12,5 as 12.5 and refuses 10.000 (not a percent shape)", async () => {
    const { denomId } = await seedDenomination();
    const ok = await put(denomId, { enabled: true, tiers: [{ min_quantity: 2, discount_type: "PERCENTAGE", discount_value: "12,5", is_enabled: true }] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().tiers[0].discount_value).toBe("12.5");

    const bad = await put(denomId, { enabled: true, tiers: [{ min_quantity: 2, discount_type: "PERCENTAGE", discount_value: "10.000", is_enabled: true }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().tier_errors).toEqual([{ index: 0, field: "discount_value", message: expect.stringMatching(/persen/i) }]);
    expect((await listTiers(prisma, denomId)).map((t) => String(t.discountValue))).toEqual(["12.5"]);
  });

  it("a nominal tier refuses an ambiguous shape like 1.2.3", async () => {
    const { denomId } = await seedDenomination();
    const bad = await put(denomId, { enabled: true, tiers: [{ min_quantity: 2, discount_type: "FIXED_AMOUNT_OFF_PER_UNIT", discount_value: "1.2.3", is_enabled: true }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().tier_errors[0]).toMatchObject({ index: 0, field: "discount_value" });
    expect(bad.json().error).toMatch(/tier/i);
    expect(await listTiers(prisma, denomId)).toEqual([]);
  });

  it("re-saving an untouched pre-filled value named in exact_fields keeps it exactly (100.123 stays 100.123)", async () => {
    const { denomId } = await seedDenomination();
    const first = await put(denomId, { enabled: true, tiers: [{ min_quantity: 2, discount_type: "FIXED_AMOUNT_OFF_PER_UNIT", discount_value: 100.123, is_enabled: true }] });
    expect(first.statusCode, first.body).toBe(200);
    const prefilled = first.json().tiers[0].discount_value;
    expect(prefilled).toBe("100.123");

    const resave = await put(denomId, {
      enabled: true,
      tiers: [{ min_quantity: 2, discount_type: "FIXED_AMOUNT_OFF_PER_UNIT", discount_value: prefilled, is_enabled: true, exact_fields: ["discount_value"] }],
    });
    expect(resave.statusCode, resave.body).toBe(200);
    expect(resave.json().tiers[0].discount_value).toBe("100.123");

    // The same text retyped (not in exact_fields) is read by shape: 100.123 is one hundred thousand one hundred twenty-three.
    const retyped = await put(denomId, { enabled: true, tiers: [{ min_quantity: 2, discount_type: "FIXED_AMOUNT_OFF_PER_UNIT", discount_value: "100.123", is_enabled: true }] });
    expect(retyped.json().tiers[0].discount_value).toBe("100123");
  });

  it("refuses duplicate thresholds, a percent over 100, a zero value and a bad quantity, naming each row", async () => {
    const { denomId } = await seedDenomination();
    const res = await put(denomId, {
      enabled: true,
      tiers: [
        { min_quantity: 3, discount_type: "PERCENTAGE", discount_value: "10", is_enabled: true },
        { min_quantity: 3, discount_type: "PERCENTAGE", discount_value: "120", is_enabled: true },
        { min_quantity: 4, discount_type: "FIXED_UNIT_PRICE", discount_value: "0", is_enabled: true },
        { min_quantity: 0, discount_type: "PERCENTAGE", discount_value: "5", is_enabled: true },
        { min_quantity: 6, discount_type: "BOGUS", discount_value: "5", is_enabled: true },
      ],
    });
    expect(res.statusCode).toBe(400);
    const errors = res.json().tier_errors as { index: number; field: string }[];
    expect(errors.map((e) => [e.index, e.field])).toEqual([
      [1, "min_quantity"],
      [1, "discount_value"],
      [2, "discount_value"],
      [3, "min_quantity"],
      [4, "discount_type"],
    ]);
    expect(await listTiers(prisma, denomId)).toEqual([]);
    expect((await prisma.denomination.findUniqueOrThrow({ where: { id: denomId } })).tieredPricingEnabled).toBe(false);
  });

  it("refuses a body without a boolean enabled or a tiers list", async () => {
    const { denomId } = await seedDenomination();
    expect((await put(denomId, { enabled: "yes", tiers: [] })).statusCode).toBe(400);
    expect((await put(denomId, { enabled: true })).statusCode).toBe(400);
    expect((await put(999999, { enabled: true, tiers: [] })).statusCode).toBe(404);
  });

  it("a toggle-off save keeps the tiers and writes only a toggle audit entry", async () => {
    const { denomId } = await seedDenomination();
    await put(denomId, { enabled: true, tiers: EXAMPLE });
    const saved = (await get(denomId)).json();
    const off = await put(denomId, {
      enabled: false,
      tiers: saved.tiers.map((t: Record<string, unknown>) => ({ ...t, exact_fields: ["discount_value"] })),
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().enabled).toBe(false);
    expect(off.json().tiers).toEqual(saved.tiers);
    const actions = (await prisma.auditLog.findMany({ where: { targetId: denomId }, orderBy: { id: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["pricing_tiers_replace", "tiered_pricing_toggle", "tiered_pricing_toggle"]);
  });

  it("the legacy bulk-pricing endpoint still works and shows up as one percent tier", async () => {
    const { denomId, productId } = await seedDenomination();
    const legacy = await app.inject({
      method: "POST",
      url: `/api/catalog/denominations/${denomId}/bulk-pricing`,
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      cookies: { [COOKIE]: cookie },
      payload: JSON.stringify({ minQuantity: 5, discountPercent: "10" }),
    });
    expect(legacy.statusCode).toBe(200);
    const body = (await get(denomId)).json();
    expect(body.enabled).toBe(true);
    expect(body.tiers).toEqual([{ id: expect.any(String), min_quantity: 5, discount_type: "PERCENTAGE", discount_value: "10", is_enabled: true }]);

    const detail = (await app.inject({ method: "GET", url: `/api/catalog/${productId}`, cookies: { [COOKIE]: cookie } })).json();
    expect(detail.statsByDenom[denomId].rule).toMatchObject({ minQuantity: 5 });
    expect(detail.statsByDenom[denomId].pricingTiers).toEqual({ enabled: true, count: 1 });
  });

  it("the legacy POST and DELETE bulk-pricing endpoints refuse with 409 a tier set one percent rule cannot express, changing and auditing nothing", async () => {
    const { denomId } = await seedDenomination();
    expect((await put(denomId, { enabled: true, tiers: EXAMPLE })).statusCode).toBe(200);
    const before = await listTiers(prisma, denomId);
    const auditBefore = await prisma.auditLog.count();
    const legacy = (method: "POST" | "DELETE") =>
      app.inject({
        method,
        url: `/api/catalog/denominations/${denomId}/bulk-pricing`,
        headers: method === "POST" ? { "content-type": "application/json", "x-csrf-token": csrf } : { "x-csrf-token": csrf },
        cookies: { [COOKIE]: cookie },
        ...(method === "POST" ? { payload: JSON.stringify({ minQuantity: 5, discountPercent: "10" }) } : {}),
      });

    for (const method of ["POST", "DELETE"] as const) {
      const res = await legacy(method);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatch(/harga bertingkat/i);
    }
    expect(await listTiers(prisma, denomId)).toEqual(before);
    expect((await prisma.denomination.findUniqueOrThrow({ where: { id: denomId } })).tieredPricingEnabled).toBe(true);
    expect(await prisma.auditLog.count()).toBe(auditBefore);
  });
});
