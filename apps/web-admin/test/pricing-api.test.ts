import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, getSetting } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti, webRoleKey } from "../src/auth";
import { buildApp } from "../src/server";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
const NEW_ADMIN_TG = 1000;
let app: FastifyInstance;
let cookie: string;
let csrf: string;

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
});

function postJson(url: string, c: string | null, csrfToken: string, body: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
    payload: JSON.stringify(body),
  });
}


describe("Pricing & Margins API", () => {
  it("requires a session and never returns provider credentials", async () => {
    expect((await app.inject({ url: "/api/pricing" })).statusCode).toBe(401);
    await setSetting(prisma, "digiflazz_api_key", "secret-test-only");
    const res = await app.inject({ url: "/api/pricing", cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().isOwner).toBe(true);
    expect(res.body).not.toContain("secret-test-only");
    expect(res.body).not.toContain("digiflazz_api_key");
  });
  it.each(["support", "readonly"])("%s can read but cannot mutate or POST preview", async role => {
    const admin = await upsertUser(prisma, { telegramId: NEW_ADMIN_TG, username: null, fullName: "Reader" });
    await setSetting(prisma, "admin_ids", String(NEW_ADMIN_TG));
    await setSetting(prisma, webRoleKey(NEW_ADMIN_TG), role);
    const jti = newJti();
    await setSetting(prisma, sessionJtiKey(NEW_ADMIN_TG), jti);
    const session = makeSession(admin.id, NEW_ADMIN_TG, jti);
    const read = await app.inject({ url: "/api/pricing", cookies: { [COOKIE]: session.raw } });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().isOwner).toBe(false);
    for (const path of ["global", "preview", "reprice/preview", "reprice/apply"]) {
      expect((await postJson(`/api/pricing/${path}`, session.raw, session.data.csrf, {})).statusCode).toBe(403);
    }
  });
  it("validates CSRF, typed flat amounts and exact prefilled percentages", async () => {
    expect((await postJson("/api/pricing/global", cookie, "bad", { markupType: "flat", markupValue: "1500" })).statusCode).toBe(403);
    const save = await postJson("/api/pricing/global", cookie, csrf, { markupType: "flat", markupValue: "1.500", rounding: "ceil_500" });
    expect(save.statusCode, save.body).toBe(200);
    expect(await getSetting(prisma, "digiflazz_markup_value")).toBe("1500");
    expect(await getSetting(prisma, "pricing_rounding")).toBe("ceil_500");
    expect(await prisma.auditLog.count({ where: { action: "pricing_global_update" } })).toBe(1);
    expect((await postJson("/api/pricing/global", cookie, csrf, { markupType: "percent", markupValue: "12.345", exact_fields: ["markupValue"] })).statusCode).toBe(200);
    expect(await getSetting(prisma, "digiflazz_markup_value")).toBe("12.345");
  });
  it.each([
    { markupType: "flat", markupValue: "-1" }, { markupType: "percent", markupValue: "NaN" },
    { markupType: "unknown", markupValue: "2" }, { rounding: "floor_100" },
    { markupType: "percent", markupValue: "1001" }, { lowMarginWarnPct: "100" },
    { markupType: "flat", markupValue: "1,5" },
  ])("rejects invalid policy %j", async body => {
    expect((await postJson("/api/pricing/global", cookie, csrf, body)).statusCode).toBe(400);
    expect(await prisma.auditLog.count({ where: { action: "pricing_global_update" } })).toBe(0);
  });
  it("previews draft pricing without persistence and CRUDs category inheritance", async () => {
    await setSetting(prisma, "digiflazz_markup_type", "percent");
    await setSetting(prisma, "digiflazz_markup_value", "15");
    const category = await prisma.category.create({ data: { name: "Game", slug: "game", group: "GAME_TOPUP" } });
    const res = await postJson("/api/pricing/preview", cookie, csrf, { markupType: "percent", markupValue: "10", costs: ["100.000"], rounding: "none" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().rows[0].effectivePrice).toBe("110000");
    expect(await getSetting(prisma, "digiflazz_markup_value")).toBe("15");
    expect(await prisma.auditLog.count()).toBe(0);
    const update = await app.inject({ method: "PUT", url: `/api/pricing/categories/${category.id}`, cookies: { [COOKIE]: cookie }, headers: { "x-csrf-token": csrf }, payload: { markupType: "percent", markupValue: "8" } });
    expect(update.statusCode, update.body).toBe(200);
    const after = await postJson("/api/pricing/preview", cookie, csrf, { categoryId: category.id, costs: ["100000"] });
    expect(after.json().rows[0]).toMatchObject({ source: "category_rule", effectivePrice: "108000" });
    expect((await app.inject({ method: "DELETE", url: `/api/pricing/categories/${category.id}`, cookies: { [COOKIE]: cookie }, headers: { "x-csrf-token": csrf } })).statusCode).toBe(200);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: category.id } })).markupType).toBeNull();
  });
  it("returns impact without writes and applies only eligible automatic SKUs", async () => {
    await setSetting(prisma, "digiflazz_markup_type", "percent");
    await setSetting(prisma, "digiflazz_markup_value", "15");
    const category = await prisma.category.create({ data: { name: "Game", slug: "game", group: "GAME_TOPUP" } });
    const product = await prisma.product.create({ data: { name: "Game", slug: "game", categoryId: category.id } });
    const d = await prisma.denomination.create({ data: { productId: product.id, name: "10 diamonds", slug: "10-diamonds", type: "PRIVATE", durationLabel: "Instant", price: "100000", costPrice: "100000", autoDeliverySource: "digiflazz", supplierSku: "price-test", deliveryType: "manual_with_info" } });
    const impact = await postJson("/api/pricing/reprice/preview", cookie, csrf, { scope: "all" });
    expect(impact.statusCode, impact.body).toBe(200);
    expect(impact.json().changedCount).toBe(1);
    expect((await prisma.denomination.findUniqueOrThrow({ where: { id: d.id } })).price.toString()).toBe("100000");
    expect((await postJson("/api/pricing/reprice/apply", cookie, csrf, { scope: "all" })).json().updatedCount).toBe(1);
    expect((await prisma.denomination.findUniqueOrThrow({ where: { id: d.id } })).price.toString()).toBe("115000");
  });
});
