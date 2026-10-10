import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory, createCatalogProduct, createDenomination } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

/**
 * Provider (auto + digiflazz) and manual SKUs never hold local stock rows, so
 * the stock list/export must not call them "Out of Stock", and GET /api/stock
 * tells the client which rows draw from local inventory.
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
  const session = makeSession(admin.id, ADMIN_TG, jti);
  cookie = session.raw;
  csrf = session.data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

async function seedMix() {
  const category = await createCategory(prisma, "Games");
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Game" });
  const base = { productId: product.id, type: "SHARED", durationLabel: "-", price: "10000" } as const;
  const provider = await createDenomination(prisma, { ...base, name: "ProviderSku", deliveryType: "auto", autoDeliverySource: "digiflazz" });
  const manual = await createDenomination(prisma, { ...base, name: "ManualSku", deliveryType: "manual_with_info" });
  const local = await createDenomination(prisma, { ...base, name: "LocalSku", deliveryType: "auto" });
  return { provider, manual, local };
}

describe("GET /api/stock/export status column", () => {
  it("labels provider and manual SKUs neutrally instead of Out of Stock", async () => {
    await seedMix();
    const res = await app.inject({ method: "GET", url: "/api/stock/export", cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.body.split("\r\n");
    const statusOf = (name: string) => rows.find((r) => r.startsWith(`${name},`))!.split(",").pop();
    expect(statusOf("ProviderSku")).toBe("Provider");
    expect(statusOf("ManualSku")).toBe("Manual");
    expect(statusOf("LocalSku")).toBe("Out of Stock");
  });

  it("fills Restock Requests only for local-inventory SKUs, even when a provider SKU has subscribers", async () => {
    const { provider, manual, local } = await seedMix();
    const buyer = await upsertUser(prisma, { telegramId: 4242, username: "buyer", fullName: "Buyer" });
    for (const d of [provider, manual, local]) {
      await prisma.restockSubscription.create({ data: { userId: buyer.id, productId: d.id } });
    }
    const res = await app.inject({ method: "GET", url: "/api/stock/export", cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.body.split("\r\n");
    // Restock Requests is the second-to-last column, Status the last.
    const restockOf = (name: string) => {
      const cells = rows.find((r) => r.startsWith(`${name},`))!.split(",");
      return cells[cells.length - 2];
    };
    expect(restockOf("ProviderSku")).toBe("");
    expect(restockOf("ManualSku")).toBe("");
    expect(restockOf("LocalSku")).toBe("1");
  });
});

describe("GET /api/stock fulfillment source", () => {
  it("gates stock uploads by fulfillment source while preserving inventory uploads", async () => {
    const { provider, manual, local } = await seedMix();
    for (const product of [provider, manual, local]) {
      const detail = await app.inject({ method: "GET", url: `/api/stock/${product.id}`, cookies: { [COOKIE]: cookie } });
      expect(detail.json().product.usesLocalInventory).toBe(product.id === local.id);
      const res = await app.inject({
        method: "POST", url: `/api/stock/${product.id}/bulk-add`, cookies: { [COOKIE]: cookie },
        payload: { csrf_token: csrf, credentials: "account@example.com:password" },
      });
      expect(res.statusCode).toBe(product.id === local.id ? 200 : 422);
      expect(await prisma.stockItem.count({ where: { productId: product.id } })).toBe(product.id === local.id ? 1 : 0);
      expect(await prisma.auditLog.count({ where: { targetId: product.id, action: "stock_upload" } })).toBe(product.id === local.id ? 1 : 0);
    }
  });

  it("adds fulfillmentSource and usesLocalInventory to every denomination row", async () => {
    const { provider, manual, local } = await seedMix();
    const res = await app.inject({ method: "GET", url: "/api/stock", cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json().denominations as Array<{ id: number; name: string; fulfillmentSource: string; usesLocalInventory: boolean }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(provider.id)).toMatchObject({ name: "ProviderSku", fulfillmentSource: "PROVIDER_API", usesLocalInventory: false });
    expect(byId.get(manual.id)).toMatchObject({ name: "ManualSku", fulfillmentSource: "MANUAL", usesLocalInventory: false });
    expect(byId.get(local.id)).toMatchObject({ name: "LocalSku", fulfillmentSource: "INTERNAL_INVENTORY", usesLocalInventory: true });
  });
});
