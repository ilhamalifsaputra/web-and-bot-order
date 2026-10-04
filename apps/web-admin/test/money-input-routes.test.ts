import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory, createCatalogProduct, createDenomination } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

/**
 * Typed money in admin request bodies is read BY ITS SHAPE (CLAUDE.md "Typed
 * money is read by its shape"): `10.000` is ten thousand rupiah, `10,5` is ten
 * and a half, `1.000.000` is a million, and a shape that cannot be read without
 * guessing is refused with a 400 — never `new Decimal(text)`, which reads
 * `10.000` as ten.
 */

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let customerId: number;

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
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
  customerId = (await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" })).id;
});

function send(method: "POST" | "PATCH", url: string, body: Record<string, unknown>) {
  return app.inject({
    method,
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    cookies: { [COOKIE]: cookie },
    payload: JSON.stringify(body),
  });
}

async function seedDenomination() {
  const category = await createCategory(prisma, "Cat");
  const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent" });
  const denom = await createDenomination(prisma, { productId: parent.id, name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "10000" });
  return { denomId: denom.id, productId: parent.id };
}

describe("vouchers read amounts by shape", () => {
  it("create: FIXED value 10.000 is ten thousand, min_purchase 1.000.000 a million, max_discount 10,5 ten and a half", async () => {
    const res = await send("POST", "/api/vouchers", {
      code: "FIX10K",
      type: "fixed",
      value: "10.000",
      min_purchase: "1.000.000",
      max_discount: "10,5",
    });
    expect(res.statusCode).toBe(201);
    const v = await prisma.voucher.findUniqueOrThrow({ where: { code: "FIX10K" } });
    expect(v.value.toString()).toBe("10000");
    expect(v.minPurchase.toString()).toBe("1000000");
    expect(v.maxDiscount?.toString()).toBe("10.5");
  });

  it("create: a PERCENT value is a percent — 12,5 reads 12.5 and 10.000 is refused", async () => {
    const ok = await send("POST", "/api/vouchers", { code: "PCT", type: "percent", value: "12,5" });
    expect(ok.statusCode).toBe(201);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { code: "PCT" } })).value.toString()).toBe("12.5");

    const bad = await send("POST", "/api/vouchers", { code: "PCTBAD", type: "percent", value: "10.000" });
    expect(bad.statusCode).toBe(400);
    expect(await prisma.voucher.findUnique({ where: { code: "PCTBAD" } })).toBeNull();
  });

  it("create: refuses abc with a message that names the field", async () => {
    const res = await send("POST", "/api/vouchers", { code: "ABC", type: "fixed", value: "5000", min_purchase: "abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Min purchase/);
    expect(await prisma.voucher.findUnique({ where: { code: "ABC" } })).toBeNull();
  });

  it("update: min_purchase 10.000 is ten thousand; value follows the stored type; abc is refused", async () => {
    const create = await send("POST", "/api/vouchers", { code: "UPD", type: "fixed", value: "5000" });
    const { voucher } = create.json() as { voucher: { id: number } };

    const res = await send("POST", `/api/vouchers/${voucher.id}/update`, { min_purchase: "10.000", value: "7.500" });
    expect(res.statusCode).toBe(200);
    const fresh = await prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } });
    expect(fresh.minPurchase.toString()).toBe("10000");
    expect(fresh.value.toString()).toBe("7500");

    const bad = await send("POST", `/api/vouchers/${voucher.id}/update`, { max_discount: "abc" });
    expect(bad.statusCode).toBe(400);
  });

  it("still accepts the plain numbers the admin form sends", async () => {
    const res = await send("POST", "/api/vouchers", { code: "PLAIN", type: "fixed", value: "15000", min_purchase: "0", max_discount: "" });
    expect(res.statusCode).toBe(201);
    const v = await prisma.voucher.findUniqueOrThrow({ where: { code: "PLAIN" } });
    expect(v.value.toString()).toBe("15000");
    expect(v.maxDiscount).toBeNull();
  });
});

describe("wallet adjustment reads the amount by shape", () => {
  it("credits 10.000 as ten thousand and debits -2.500 as two and a half thousand", async () => {
    const credit = await send("POST", `/api/users/${customerId}/wallet`, { delta: "10.000", note: "goodwill", currency: "IDR" });
    expect(credit.statusCode).toBe(200);
    expect(credit.json().newBalance).toBe("10000");

    const debit = await send("POST", `/api/users/${customerId}/wallet`, { delta: "-2.500", note: "correction", currency: "IDR" });
    expect(debit.statusCode).toBe(200);
    expect(debit.json().newBalance).toBe("7500");
  });

  it("reads 1.000.000 as a million", async () => {
    const res = await send("POST", `/api/users/${customerId}/wallet`, { delta: "1.000.000", note: "x", currency: "IDR" });
    expect(res.statusCode).toBe(200);
    expect(res.json().newBalance).toBe("1000000");
  });

  it.each([
    ["abc", "IDR"],
    ["1.2.3", "IDR"],
    ["1.000", "USDT"],
  ])("refuses %j (%s) with 400 and leaves the balance alone", async (delta, currency) => {
    const res = await send("POST", `/api/users/${customerId}/wallet`, { delta, note: "x", currency });
    expect(res.statusCode).toBe(400);
    expect(await prisma.walletTransaction.count({ where: { userId: customerId } })).toBe(0);
  });

  it("reads a USDT decimal comma", async () => {
    const res = await send("POST", `/api/users/${customerId}/wallet`, { delta: "5,07", note: "x", currency: "USDT" });
    expect(res.statusCode).toBe(200);
    expect(res.json().newBalance).toBe("5.07");
  });
});

describe("catalog prices read by shape", () => {
  it("create denomination: price 10.000 is ten thousand, cost 10,5, reseller 1.000.000", async () => {
    const { productId } = await seedDenomination();
    const res = await send("POST", `/api/catalog/products/${productId}/denominations`, {
      name: "3 Months",
      type: "SHARED",
      durationLabel: "3 Months",
      price: "10.000",
      costPrice: "10,5",
      resellerPrice: "1.000.000",
    });
    expect(res.statusCode).toBeLessThan(300);
    const row = await prisma.denomination.findFirstOrThrow({ where: { name: "3 Months" } });
    expect(row.price.toString()).toBe("10000");
    expect(row.costPrice?.toString()).toBe("10.5");
    expect(row.resellerPrice?.toString()).toBe("1000000");
  });

  it("update denomination: price 25.000 is twenty-five thousand; abc is refused", async () => {
    const { denomId } = await seedDenomination();
    const ok = await send("PATCH", `/api/catalog/denominations/${denomId}`, { name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "25.000" });
    expect(ok.statusCode).toBe(200);
    expect((await prisma.denomination.findUniqueOrThrow({ where: { id: denomId } })).price.toString()).toBe("25000");

    const bad = await send("PATCH", `/api/catalog/denominations/${denomId}`, { name: "1 Month", type: "SHARED", durationLabel: "1 Month", price: "abc" });
    expect(bad.statusCode).toBe(400);
    expect((await prisma.denomination.findUniqueOrThrow({ where: { id: denomId } })).price.toString()).toBe("25000");
  });

  it("bulk pricing: discount percent 12,5 is 12.5; 10.000 is refused", async () => {
    const { denomId } = await seedDenomination();
    const ok = await send("POST", `/api/catalog/denominations/${denomId}/bulk-pricing`, { minQuantity: 3, discountPercent: "12,5" });
    expect(ok.statusCode).toBe(200);
    const tier = await prisma.bulkPricing.findFirstOrThrow({ where: { productId: denomId } });
    expect(tier.discountPercent.toString()).toBe("12.5");

    const bad = await send("POST", `/api/catalog/denominations/${denomId}/bulk-pricing`, { minQuantity: 5, discountPercent: "10.000" });
    expect(bad.statusCode).toBe(400);
  });
});

/**
 * The edit forms pre-fill money fields with the server's own Decimal strings
 * (`100.123`, `1.234`). Re-saving such a field unchanged must store the same
 * value — not re-read it by shape as thousands grouping (100123). The client
 * names the untouched pre-filled fields in `exact_fields`, which the server
 * reads as plain dot-decimals; everything else is still read as typed text.
 */
describe("edit + re-save round-trips stored values exactly", () => {
  it("voucher: a stored 100.123 min purchase / 1.234 max discount survives re-save; the same text typed is read by shape", async () => {
    const create = await send("POST", "/api/vouchers", { code: "ODD", type: "fixed", value: "5000" });
    const { voucher } = create.json() as { voucher: { id: number } };
    await prisma.voucher.update({ where: { id: voucher.id }, data: { minPurchase: "100.123", maxDiscount: "1.234", value: "2500.125" } });

    // What the edit form pre-fills: the list endpoint's strings.
    const list = await app.inject({ method: "GET", url: "/api/vouchers", cookies: { [COOKIE]: cookie } });
    const row = (list.json().vouchers as { id: number; value: string; minPurchase: string; maxDiscount: string | null }[]).find((v) => v.id === voucher.id)!;
    expect([row.value, row.minPurchase, row.maxDiscount]).toEqual(["2500.125", "100.123", "1.234"]);

    const resave = await send("POST", `/api/vouchers/${voucher.id}/update`, {
      code: "ODD",
      type: "FIXED",
      value: row.value,
      min_purchase: row.minPurchase,
      max_discount: row.maxDiscount,
      exact_fields: ["value", "min_purchase", "max_discount"],
    });
    expect(resave.statusCode).toBe(200);
    const after = await prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } });
    expect([after.value.toString(), after.minPurchase.toString(), after.maxDiscount?.toString()]).toEqual(["2500.125", "100.123", "1.234"]);

    // A person who TYPES 100.123 into the field means one hundred thousand one hundred twenty-three.
    const typed = await send("POST", `/api/vouchers/${voucher.id}/update`, { min_purchase: "100.123" });
    expect(typed.statusCode).toBe(200);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).minPurchase.toString()).toBe("100123");

    // An exact field still refuses anything that is not a plain dot-decimal.
    const bad = await send("POST", `/api/vouchers/${voucher.id}/update`, { min_purchase: "10.000,5", exact_fields: ["min_purchase"] });
    expect(bad.statusCode).toBe(400);
  });

  it("voucher: a PERCENT value pre-filled as 12.345 survives re-save", async () => {
    const create = await send("POST", "/api/vouchers", { code: "PCT3", type: "percent", value: "10" });
    const { voucher } = create.json() as { voucher: { id: number } };
    await prisma.voucher.update({ where: { id: voucher.id }, data: { value: "12.345" } });
    const res = await send("POST", `/api/vouchers/${voucher.id}/update`, { value: "12.345", exact_fields: ["value"] });
    expect(res.statusCode).toBe(200);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).value.toString()).toBe("12.345");
  });

  it("denomination: stored 100.123 price, cost and reseller survive an unrelated edit (name change)", async () => {
    const { denomId, productId } = await seedDenomination();
    await prisma.denomination.update({ where: { id: denomId }, data: { price: "100.123", costPrice: "90.5", resellerPrice: "95.125" } });
    const detail = await app.inject({ method: "GET", url: `/api/catalog/${productId}`, cookies: { [COOKIE]: cookie } });
    const d = (detail.json().product.denominations as { id: number; price: string; costPrice: string; resellerPrice: string }[]).find((x) => x.id === denomId)!;

    const res = await send("PATCH", `/api/catalog/denominations/${denomId}`, {
      name: "Renamed",
      type: "SHARED",
      durationLabel: "1 Month",
      price: d.price,
      costPrice: d.costPrice,
      resellerPrice: d.resellerPrice,
      exact_fields: ["price", "costPrice", "resellerPrice"],
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.denomination.findUniqueOrThrow({ where: { id: denomId } });
    expect([row.name, row.price.toString(), row.costPrice?.toString(), row.resellerPrice?.toString()]).toEqual(["Renamed", "100.123", "90.5", "95.125"]);
  });

  it("bulk pricing: the pre-filled percent survives re-save (the crud stores percents at 2 decimals)", async () => {
    const { denomId, productId } = await seedDenomination();
    const first = await send("POST", `/api/catalog/denominations/${denomId}/bulk-pricing`, { minQuantity: 3, discountPercent: "12,35" });
    expect(first.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/api/catalog/${productId}`, cookies: { [COOKIE]: cookie } });
    const prefill = (detail.json().statsByDenom as Record<string, { rule: { discountPercent: string } | null }>)[String(denomId)]!.rule!.discountPercent;
    expect(prefill).toBe("12.35");
    for (const exact_fields of [["discountPercent"], []]) {
      const res = await send("POST", `/api/catalog/denominations/${denomId}/bulk-pricing`, { minQuantity: 3, discountPercent: prefill, exact_fields });
      expect(res.statusCode).toBe(200);
      expect((await prisma.bulkPricing.findFirstOrThrow({ where: { productId: denomId } })).discountPercent.toString()).toBe("12.35");
    }
  });
});

describe("flash sale bulk-apply reads the percent by shape", () => {
  it("12,5 is 12.5 percent; 10.000 and abc are refused", async () => {
    const { denomId } = await seedDenomination();
    const window = { startsAt: "2030-01-01T10:00", endsAt: "2030-01-02T10:00" };
    const ok = await send("POST", "/api/flash-sales/bulk-apply", { denominationIds: [denomId], discountPercent: "12,5", ...window });
    expect(ok.statusCode).toBe(200);
    const row = await prisma.denomination.findUniqueOrThrow({ where: { id: denomId } });
    expect(row.flashDiscountPercent?.toString()).toBe("12.5");

    for (const bad of ["10.000", "abc"]) {
      const res = await send("POST", "/api/flash-sales/bulk-apply", { denominationIds: [denomId], discountPercent: bad, ...window });
      expect(res.statusCode).toBe(400);
    }
  });
});
