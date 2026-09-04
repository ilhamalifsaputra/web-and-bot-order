import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory, createCatalogProduct } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

// Fase 12 task 22: thumbnailKind (default-placeholder art style) and
// currencyIconKind (denomination-card currency chip) — both optional,
// whitelist-validated string fields on Product. Hiding the UI controls for
// PREMIUM_APPS-group categories is client-only (ProductDetailPage.test.tsx);
// the server accepts/validates these two fields uniformly regardless of the
// product's category group.

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

function postJson(url: string, c: string | null, csrfToken: string, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
    payload: JSON.stringify(body),
  });
}
function patchJson(url: string, c: string | null, csrfToken: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
    payload: JSON.stringify(body),
  });
}

describe("POST /api/catalog/products — thumbnailKind/currencyIconKind", () => {
  it("persists a valid thumbnailKind and currencyIconKind", async () => {
    const category = await createCategory(prisma, "Cat");
    const res = await postJson("/api/catalog/products", cookie, csrf, {
      name: "Steam Wallet",
      categoryId: category.id,
      thumbnailKind: "steam",
      currencyIconKind: "coin",
    });
    expect(res.statusCode).toBe(201);
    const row = await prisma.product.findUnique({ where: { id: res.json().id } });
    expect(row!.thumbnailKind).toBe("steam");
    expect(row!.currencyIconKind).toBe("coin");
  });

  it("rejects an invalid thumbnailKind with 400 and creates nothing", async () => {
    const category = await createCategory(prisma, "Cat");
    const before = await prisma.product.count();
    const res = await postJson("/api/catalog/products", cookie, csrf, {
      name: "Bad Thumbnail",
      categoryId: category.id,
      thumbnailKind: "bogus",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid thumbnail kind.");
    expect(await prisma.product.count()).toBe(before);
  });

  it("rejects an invalid currencyIconKind with 400 and creates nothing", async () => {
    const category = await createCategory(prisma, "Cat");
    const before = await prisma.product.count();
    const res = await postJson("/api/catalog/products", cookie, csrf, {
      name: "Bad Currency Icon",
      categoryId: category.id,
      currencyIconKind: "bogus",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid currency icon kind.");
    expect(await prisma.product.count()).toBe(before);
  });

  it("omitting both fields leaves them null", async () => {
    const category = await createCategory(prisma, "Cat");
    const res = await postJson("/api/catalog/products", cookie, csrf, {
      name: "Plain Product",
      categoryId: category.id,
    });
    expect(res.statusCode).toBe(201);
    const row = await prisma.product.findUnique({ where: { id: res.json().id } });
    expect(row!.thumbnailKind).toBeNull();
    expect(row!.currencyIconKind).toBeNull();
  });
});

describe("PATCH /api/catalog/products/:id — thumbnailKind/currencyIconKind", () => {
  it("persists a valid thumbnailKind and currencyIconKind", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Product" });
    const res = await patchJson(`/api/catalog/products/${product.id}`, cookie, csrf, {
      name: "Product",
      thumbnailKind: "voucher",
      currencyIconKind: "diamond",
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row!.thumbnailKind).toBe("voucher");
    expect(row!.currencyIconKind).toBe("diamond");
  });

  it("rejects an invalid thumbnailKind with 400 and leaves the row unchanged", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Product", thumbnailKind: "game" });
    const res = await patchJson(`/api/catalog/products/${product.id}`, cookie, csrf, {
      name: "Product",
      thumbnailKind: "bogus",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid thumbnail kind.");
    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row!.thumbnailKind).toBe("game");
  });

  it("rejects an invalid currencyIconKind with 400 and leaves the row unchanged", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Product", currencyIconKind: "key" });
    const res = await patchJson(`/api/catalog/products/${product.id}`, cookie, csrf, {
      name: "Product",
      currencyIconKind: "bogus",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid currency icon kind.");
    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row!.currencyIconKind).toBe("key");
  });

  it("omitting both fields clears them to null (same always-set convention as description)", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Product",
      thumbnailKind: "app",
      currencyIconKind: "card",
    });
    const res = await patchJson(`/api/catalog/products/${product.id}`, cookie, csrf, { name: "Product" });
    expect(res.statusCode).toBe(200);
    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row!.thumbnailKind).toBeNull();
    expect(row!.currencyIconKind).toBeNull();
  });

  it("explicit null clears an existing value", async () => {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Product",
      thumbnailKind: "generic",
    });
    const res = await patchJson(`/api/catalog/products/${product.id}`, cookie, csrf, {
      name: "Product",
      thumbnailKind: null,
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.product.findUnique({ where: { id: product.id } });
    expect(row!.thumbnailKind).toBeNull();
  });
});
