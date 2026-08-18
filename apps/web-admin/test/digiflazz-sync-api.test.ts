import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const digiflazzMock = vi.hoisted(() => ({ getPriceList: vi.fn() }));
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()),
  getPriceList: digiflazzMock.getPriceList,
}));

import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";
import { Decimal } from "@app/core/money";

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
  digiflazzMock.getPriceList.mockReset();
});

function postJson(url: string, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    cookies: { [COOKIE]: cookie },
    payload: JSON.stringify(body),
  });
}

describe("POST /api/catalog/digiflazz/sync/preview", () => {
  it("rejects when Digiflazz credentials are not configured", async () => {
    const res = await postJson("/api/catalog/digiflazz/sync/preview", {});
    expect(res.statusCode).toBe(400);
  });

  it("I9: rejects a request without a valid CSRF token, mirroring /sync/apply's protection", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/catalog/digiflazz/sync/preview",
      headers: { "content-type": "application/json", "x-csrf-token": "bad" },
      cookies: { [COOKIE]: cookie },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(403);
    expect(digiflazzMock.getPriceList).not.toHaveBeenCalled();
  });

  it("groups the Game-category price list by brand once configured", async () => {
    await setSetting(prisma, "digiflazz_username", "u");
    await setSetting(prisma, "digiflazz_api_key", "k");
    digiflazzMock.getPriceList.mockResolvedValue([
      { buyerSkuCode: "ml100", productName: "ML 100", category: "Game", brand: "Mobile Legends", type: "Umum", price: new Decimal(15000), buyerProductStatus: true, sellerProductStatus: true, stock: null },
      { buyerSkuCode: "x100", productName: "XL 100k", category: "Pulsa", brand: "XL", type: "Umum", price: new Decimal(98000), buyerProductStatus: true, sellerProductStatus: true, stock: null },
    ]);
    const res = await postJson("/api/catalog/digiflazz/sync/preview", {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1); // Pulsa filtered out — Game only, this pilot's scope
    expect(body.groups[0].brand).toBe("Mobile Legends");
  });

  // I8: Digiflazz's own docs (and this branch's core-client test fixture)
  // use the plural "Games" — the filter must not silently produce an empty
  // preview just because production returns the plural form.
  it("I8: still picks up items whose category is the plural \"Games\"", async () => {
    await setSetting(prisma, "digiflazz_username", "u");
    await setSetting(prisma, "digiflazz_api_key", "k");
    digiflazzMock.getPriceList.mockResolvedValue([
      { buyerSkuCode: "ml100", productName: "ML 100", category: "Games", brand: "Mobile Legends", type: "Umum", price: new Decimal(15000), buyerProductStatus: true, sellerProductStatus: true, stock: null },
    ]);
    const res = await postJson("/api/catalog/digiflazz/sync/preview", {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].brand).toBe("Mobile Legends");
  });

  it("I8: an empty match against a non-empty price list still returns 200 with no groups (diagnosable via logs, not a crash)", async () => {
    await setSetting(prisma, "digiflazz_username", "u");
    await setSetting(prisma, "digiflazz_api_key", "k");
    digiflazzMock.getPriceList.mockResolvedValue([
      { buyerSkuCode: "x100", productName: "XL 100k", category: "Pulsa", brand: "XL", type: "Umum", price: new Decimal(98000), buyerProductStatus: true, sellerProductStatus: true, stock: null },
    ]);
    const res = await postJson("/api/catalog/digiflazz/sync/preview", {});
    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toHaveLength(0);
  });
});

describe("POST /api/catalog/digiflazz/sync/apply", () => {
  it("imports selected brands into the given category", async () => {
    const category = await createCategory(prisma, "Top Up Game");
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [
        {
          brand: "Mobile Legends",
          rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ ok: true, brandsImported: 1, denominationsImported: 1 });
  });

  it("rejects a non-positive price", async () => {
    const category = await createCategory(prisma, "Top Up Game");
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [{ brand: "Mobile Legends", rows: [{ buyerSkuCode: "ml100", productName: "X", price: "0", costPrice: "15000" }] }],
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-numeric price with 400 instead of crashing", async () => {
    const category = await createCategory(prisma, "Top Up Game");
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [{ brand: "Mobile Legends", rows: [{ buyerSkuCode: "ml100", productName: "X", price: "abc", costPrice: "15000" }] }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid price for "X".' });
  });

  it("I11: rejects an invalid cost price with 400 instead of crashing", async () => {
    const category = await createCategory(prisma, "Top Up Game");
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [{ brand: "Mobile Legends", rows: [{ buyerSkuCode: "ml100", productName: "X", price: "16500", costPrice: "abc" }] }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid cost price for "X".' });
  });

  it("N5: rejects a request whose total row count exceeds the cap, before importing anything", async () => {
    const category = await createCategory(prisma, "Top Up Game");
    // 501 rows on one brand — over the 500-row cap — with valid prices, so
    // the ONLY reason this can fail is the row-count cap firing before any
    // importDigiflazzBrand call (asserted via zero denominations created).
    // The cap sums rows across every brand in the request regardless of
    // brand count, so a single oversized brand exercises it just as well.
    const rows = Array.from({ length: 501 }, (_, i) => ({
      buyerSkuCode: `sku${i}`,
      productName: `Item ${i}`,
      price: "10000",
      costPrice: "9000",
    }));
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [{ brand: "Mobile Legends", rows }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Too many rows in one import — narrow the filter or import in smaller batches.",
    });
    const denomCount = await prisma.denomination.count();
    expect(denomCount).toBe(0);
  });
});
