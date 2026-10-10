import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory, createCatalogProduct, createDenomination } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

/**
 * The admin catalog tabs (Game Top-Up / Digital Apps) key off
 * `product.category.group`, and the product detail Stock column keys off the
 * per-denomination fulfillment fields — so both must be in the payloads.
 */

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;

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
  cookie = makeSession(admin.id, ADMIN_TG, jti).raw;
  await setSetting(prisma, "setup_completed", "true");
});

describe("GET /api/catalog", () => {
  it("includes category.group on every product row (null for a legacy category)", async () => {
    const game = await createCategory(prisma, { name: "Games", group: "GAME_TOPUP" });
    const apps = await createCategory(prisma, { name: "Apps", group: "PREMIUM_APPS" });
    const legacy = await createCategory(prisma, "Legacy");
    await createCatalogProduct(prisma, { categoryId: game.id, name: "G" });
    await createCatalogProduct(prisma, { categoryId: apps.id, name: "A" });
    await createCatalogProduct(prisma, { categoryId: legacy.id, name: "L" });

    const res = await app.inject({ method: "GET", url: "/api/catalog", cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const groupOf = (name: string) =>
      (res.json().products as { name: string; category: { group: string | null } }[]).find((p) => p.name === name)!
        .category.group;
    expect(groupOf("G")).toBe("GAME_TOPUP");
    expect(groupOf("A")).toBe("PREMIUM_APPS");
    expect(groupOf("L")).toBeNull();
  });
});

describe("GET /api/catalog/:productId statsByDenom", () => {
  it("reports where each denomination is fulfilled from", async () => {
    const category = await createCategory(prisma, "Games");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Game" });
    const base = { productId: product.id, type: "SHARED", durationLabel: "-", price: "10000" } as const;
    const provider = await createDenomination(prisma, { ...base, name: "P", deliveryType: "auto", autoDeliverySource: "digiflazz" });
    const manual = await createDenomination(prisma, { ...base, name: "M", deliveryType: "manual_with_info" });
    const local = await createDenomination(prisma, { ...base, name: "L", deliveryType: "auto" });

    const res = await app.inject({ method: "GET", url: `/api/catalog/${product.id}`, cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const stats = res.json().statsByDenom;
    expect(stats[provider.id]).toMatchObject({ fulfillmentSource: "PROVIDER_API", usesLocalInventory: false });
    expect(stats[manual.id]).toMatchObject({ fulfillmentSource: "MANUAL", usesLocalInventory: false });
    expect(stats[local.id]).toMatchObject({ fulfillmentSource: "INTERNAL_INVENTORY", usesLocalInventory: true });
  });
});
