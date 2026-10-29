import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import {
  prisma,
  initDb,
  upsertUser,
  setSetting,
  getSetting,
  createCategory,
  createCatalogProduct,
  createDenomination,
} from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

/**
 * Homepage group shelves, admin side: a category's group is required on
 * create and can't be cleared once set (legacy null-group categories keep
 * working), GET /api/catalog carries each category's catalog-eligible product
 * count, and the website group order is stored and audited from Services.
 */

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
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

const send = (method: "POST" | "PATCH", url: string, payload: unknown) =>
  app.inject({
    method,
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    cookies: { [COOKIE]: cookie },
    payload: JSON.stringify(payload),
  });

describe("POST /api/catalog/categories", () => {
  it("rejects a missing or null group", async () => {
    for (const payload of [{ name: "Apps" }, { name: "Apps", group: null }]) {
      const res = await send("POST", "/api/catalog/categories", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "Choose a group for this category." });
    }
    expect(await prisma.category.count()).toBe(0);
  });

  it("still rejects an unknown group", async () => {
    const res = await send("POST", "/api/catalog/categories", { name: "Apps", group: "NOPE" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid group.");
  });

  it("creates a category with a valid group", async () => {
    const res = await send("POST", "/api/catalog/categories", { name: "Apps", group: "PREMIUM_APPS" });
    expect(res.statusCode).toBe(201);
    expect(res.json().category.group).toBe("PREMIUM_APPS");
  });

  it("accepts the Create Product page's inline form body: only a name and a group", async () => {
    // ProductCreatePage's "+ New category" sends exactly { name, group } and
    // nothing else (no emoji, description or checkout flow).
    const res = await send("POST", "/api/catalog/categories", { name: "Streaming", group: "GAME_TOPUP" });
    expect(res.statusCode).toBe(201);
    const { category } = res.json();
    expect(category).toMatchObject({ name: "Streaming", group: "GAME_TOPUP" });
    const row = await prisma.category.findUnique({ where: { id: category.id } });
    expect(row!.group).toBe("GAME_TOPUP");
  });
});

describe("PATCH /api/catalog/categories/:id", () => {
  it("refuses to clear a group that is set", async () => {
    const cat = await createCategory(prisma, { name: "Games", group: "GAME_TOPUP" });
    const res = await send("PATCH", `/api/catalog/categories/${cat.id}`, { group: null });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "A category's group can't be cleared once it is set." });
    expect((await prisma.category.findUnique({ where: { id: cat.id } }))!.group).toBe("GAME_TOPUP");
  });

  it("lets a legacy null-group category be saved with a null group", async () => {
    const cat = await createCategory(prisma, "Legacy");
    const res = await send("PATCH", `/api/catalog/categories/${cat.id}`, { name: "Legacy 2", group: null });
    expect(res.statusCode).toBe(200);
    const row = await prisma.category.findUnique({ where: { id: cat.id } });
    expect(row!.group).toBeNull();
    expect(row!.name).toBe("Legacy 2");
  });

  it("allows changing a set group to another valid group, and setting a legacy group", async () => {
    const games = await createCategory(prisma, { name: "Games", group: "GAME_TOPUP" });
    const legacy = await createCategory(prisma, "Legacy");
    expect((await send("PATCH", `/api/catalog/categories/${games.id}`, { group: "PREMIUM_APPS" })).statusCode).toBe(200);
    expect((await send("PATCH", `/api/catalog/categories/${legacy.id}`, { group: "GAME_TOPUP" })).statusCode).toBe(200);
    expect((await prisma.category.findUnique({ where: { id: games.id } }))!.group).toBe("PREMIUM_APPS");
    expect((await prisma.category.findUnique({ where: { id: legacy.id } }))!.group).toBe("GAME_TOPUP");
  });
});

describe("GET /api/catalog activeProductCount", () => {
  it("counts only catalog-eligible products per category", async () => {
    const cat = await createCategory(prisma, { name: "Apps", group: "PREMIUM_APPS" });
    const empty = await createCategory(prisma, { name: "Empty", group: "PREMIUM_APPS" });
    const live = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Live" });
    await createDenomination(prisma, { productId: live.id, name: "1M", type: "SHARED", durationLabel: "1 Month", price: "10" });
    await createCatalogProduct(prisma, { categoryId: cat.id, name: "No denominations" });

    const res = await app.inject({ method: "GET", url: "/api/catalog", cookies: { [COOKIE]: cookie } });
    const cats = res.json().categories as { id: number; activeProductCount: number }[];
    expect(cats.find((c) => c.id === cat.id)!.activeProductCount).toBe(1);
    expect(cats.find((c) => c.id === empty.id)!.activeProductCount).toBe(0);
  });
});

describe("website group order", () => {
  const getSettings = () => app.inject({ method: "GET", url: "/api/settings", cookies: { [COOKIE]: cookie } });

  it("GET /api/settings returns the default order, then the stored one", async () => {
    expect((await getSettings()).json().groupOrder).toEqual([
      { key: "PREMIUM_APPS", label: "Premium Apps" },
      { key: "GAME_TOPUP", label: "Top Up Game" },
    ]);
    await setSetting(prisma, "storefront_group_order", JSON.stringify(["GAME_TOPUP", "PREMIUM_APPS"]));
    expect((await getSettings()).json().groupOrder.map((g: { key: string }) => g.key)).toEqual([
      "GAME_TOPUP",
      "PREMIUM_APPS",
    ]);
  });

  it("stores a valid permutation and audits it in one sentence", async () => {
    const res = await send("POST", "/api/settings/services/order", { groups: ["PREMIUM_APPS", "GAME_TOPUP"] });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse((await getSetting(prisma, "storefront_group_order"))!)).toEqual(["PREMIUM_APPS", "GAME_TOPUP"]);
    const audit = await prisma.auditLog.findFirst({ where: { action: "setting_set" } });
    expect(audit!.details).toBe("Changed the website product group order to Premium Apps, then Top Up Game.");

    await send("POST", "/api/settings/services/order", { groups: ["GAME_TOPUP", "PREMIUM_APPS"] });
    expect(JSON.parse((await getSetting(prisma, "storefront_group_order"))!)).toEqual(["GAME_TOPUP", "PREMIUM_APPS"]);
  });

  it.each([
    ["a missing group", ["PREMIUM_APPS"]],
    ["an unknown key", ["PREMIUM_APPS", "NOPE"]],
    ["a duplicate", ["PREMIUM_APPS", "PREMIUM_APPS"]],
    ["a non-array", "PREMIUM_APPS"],
  ])("rejects %s with a sentence and stores nothing", async (_label, groups) => {
    const res = await send("POST", "/api/settings/services/order", { groups });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/\.$/);
    expect(await getSetting(prisma, "storefront_group_order")).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "setting_set" } })).toBe(0);
  });

  it("rejects a request without a CSRF token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/services/order",
      headers: { "content-type": "application/json" },
      cookies: { [COOKIE]: cookie },
      payload: JSON.stringify({ groups: ["PREMIUM_APPS", "GAME_TOPUP"] }),
    });
    expect(res.statusCode).toBe(403);
  });
});
