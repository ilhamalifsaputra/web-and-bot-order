import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const digiflazzMock = vi.hoisted(() => ({ getPriceList: vi.fn() }));
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()),
  getPriceList: digiflazzMock.getPriceList,
}));

import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory, importDigiflazzBrand, claimDigiflazzCatalogSyncLease } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";
import { Decimal } from "@app/core/money";
import { DigiflazzSupplierError } from "@app/core/suppliers/digiflazz";
import { clearDigiflazzPriceListCache } from "../src/lib/digiflazzPriceListCache";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let adminId: number;
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
  adminId = admin.id;
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
  digiflazzMock.getPriceList.mockReset();
  // The routes share an in-process price-list cache; every test starts cold.
  clearDigiflazzPriceListCache();
});

const RATE_LIMITED_MESSAGE = "Digiflazz sedang membatasi pengecekan price-list (rc 83). Coba lagi beberapa menit lagi.";
function rateLimitedError() {
  return new DigiflazzSupplierError(
    "Digiflazz refused the price-list request: Anda telah mencapai limitasi pengecekan pricelist (rc 83)",
    "83",
  );
}

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
    // Task 4: rawBrand/region are threaded through from groupDigiflazzPriceListByBrand
    // so the wizard UI can distinguish region-split groups.
    expect(body.groups[0].rawBrand).toBe("Mobile Legends");
    expect(body.groups[0].region).toBeNull();
  });

  // Money audit C13: an unreadable stored markup threw a DecimalError (500).
  it("answers 400 naming the markup setting when the stored markup is unreadable", async () => {
    await setSetting(prisma, "digiflazz_username", "u");
    await setSetting(prisma, "digiflazz_api_key", "k");
    await setSetting(prisma, "digiflazz_markup_type", "percent");
    await setSetting(prisma, "digiflazz_markup_value", "10%");
    digiflazzMock.getPriceList.mockResolvedValue([
      { buyerSkuCode: "ml100", productName: "ML 100", category: "Game", brand: "Mobile Legends", type: "Umum", price: new Decimal(15000), buyerProductStatus: true, sellerProductStatus: true, stock: null },
    ]);
    const res = await postJson("/api/catalog/digiflazz/sync/preview", {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/markup/i);
  });

  it("splits a region-suffixed brand into its own group with rawBrand/region set", async () => {
    await setSetting(prisma, "digiflazz_username", "u");
    await setSetting(prisma, "digiflazz_api_key", "k");
    digiflazzMock.getPriceList.mockResolvedValue([
      { buyerSkuCode: "ml100id", productName: "ML 100 Diamond (Indonesia)", category: "Game", brand: "Mobile Legends", type: "Umum", price: new Decimal(15000), buyerProductStatus: true, sellerProductStatus: true, stock: null },
      { buyerSkuCode: "ml100ph", productName: "ML 100 Diamond (Filipina)", category: "Game", brand: "Mobile Legends", type: "Umum", price: new Decimal(16000), buyerProductStatus: true, sellerProductStatus: true, stock: null },
    ]);
    const res = await postJson("/api/catalog/digiflazz/sync/preview", {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(2);
    const brands = body.groups.map((g: { brand: string; rawBrand: string; region: string | null; gameVariant: string | null }) => ({
      brand: g.brand,
      rawBrand: g.rawBrand,
      region: g.region,
      gameVariant: g.gameVariant,
    }));
    // Task 22: a region split alone (every row still type: "Umum") must not
    // fabricate a gameVariant — both groups stay null.
    expect(brands).toEqual(
      expect.arrayContaining([
        { brand: "Mobile Legends (Indonesia)", rawBrand: "Mobile Legends", region: "Indonesia", gameVariant: null },
        { brand: "Mobile Legends (Filipina)", rawBrand: "Mobile Legends", region: "Filipina", gameVariant: null },
      ]),
    );
  });

  it("Task 22: forwards gameVariant per group when a brand is type-split", async () => {
    await setSetting(prisma, "digiflazz_username", "u");
    await setSetting(prisma, "digiflazz_api_key", "k");
    digiflazzMock.getPriceList.mockResolvedValue([
      { buyerSkuCode: "ab-umum-3200", productName: "Arena Breakout 3.200 Bonds", category: "Game", brand: "Arena Breakout", type: "Umum", price: new Decimal(15000), buyerProductStatus: true, sellerProductStatus: true, stock: null },
      { buyerSkuCode: "ab-inf-1000", productName: "Arena Breakout Infinite 1.000 Bonds", category: "Game", brand: "Arena Breakout", type: "Infinite", price: new Decimal(20000), buyerProductStatus: true, sellerProductStatus: true, stock: null },
    ]);
    const res = await postJson("/api/catalog/digiflazz/sync/preview", {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(2);
    const variants = body.groups.map((g: { brand: string; gameVariant: string | null }) => ({
      brand: g.brand,
      gameVariant: g.gameVariant,
    }));
    expect(variants).toEqual(
      expect.arrayContaining([
        { brand: "Arena Breakout", gameVariant: "Umum" },
        { brand: "Arena Breakout Infinite", gameVariant: "Infinite" },
      ]),
    );
  });

  it("answers 502 with code digiflazz_rate_limited and the Indonesian message when Digiflazz refuses with rc 83", async () => {
    await setSetting(prisma, "digiflazz_username", "u");
    await setSetting(prisma, "digiflazz_api_key", "k");
    digiflazzMock.getPriceList.mockRejectedValueOnce(rateLimitedError());
    const res = await postJson("/api/catalog/digiflazz/sync/preview", {});
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: RATE_LIMITED_MESSAGE, code: "digiflazz_rate_limited" });
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
    expect(body).toMatchObject({ ok: true, brandsImported: 1, denominationsImported: 1, atomic: false });
    expect(body.reports[0]).toMatchObject({ created: 1, conflicts: 0, errors: 0 });
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

  // I-3: a price the admin retyped is read by shape (16.500 is sixteen and a
  // half thousand rupiah); an untouched suggested price arrives in the row's
  // `exact_fields` and the machine-written cost price is always read exactly.
  it("reads a retyped price by shape and an untouched suggested price exactly", async () => {
    const category = await createCategory(prisma, "Top Up Game");
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [
        {
          brand: "Mobile Legends",
          rows: [
            { buyerSkuCode: "ml100", productName: "ML 100", price: "16.500", costPrice: "15000" },
            { buyerSkuCode: "ml200", productName: "ML 200", price: "16500.125", costPrice: "15000.1", exact_fields: ["price"] },
          ],
        },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const typed = await prisma.denomination.findFirstOrThrow({ where: { supplierSku: "ml100" } });
    expect(typed.price.toString()).toBe("16500");
    const exact = await prisma.denomination.findFirstOrThrow({ where: { supplierSku: "ml200" } });
    expect(exact.price.toString()).toBe("16500.125");
    expect(exact.costPrice?.toString()).toBe("15000.1");
  });

  it.each([
    ["price", "Infinity", 'Invalid price for "X".'],
    ["price", "1.2.3,4,5", 'Invalid price for "X".'],
    ["costPrice", "Infinity", 'Invalid cost price for "X".'],
  ])("refuses %s %s with 400", async (field, text, error) => {
    const category = await createCategory(prisma, "Top Up Game");
    const row = { buyerSkuCode: "ml100", productName: "X", price: "16500", costPrice: "15000", [field]: text };
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [{ brand: "Mobile Legends", rows: [row] }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error });
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

  it("Task 22: forwards gameVariant into the newly-created Product", async () => {
    const category = await createCategory(prisma, "Top Up Game");
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [
        {
          brand: "Arena Breakout Infinite",
          gameVariant: "Infinite",
          rows: [{ buyerSkuCode: "ab-inf-1000", productName: "Arena Breakout Infinite 1.000 Bonds", price: "20000", costPrice: "18000" }],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const product = await prisma.product.findFirst({ where: { digiflazzBrand: "Arena Breakout Infinite" } });
    expect(product?.gameVariant).toBe("Infinite");
  });

  it("Task 22: omitting gameVariant creates a Product with gameVariant null", async () => {
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
    const product = await prisma.product.findFirst({ where: { digiflazzBrand: "Mobile Legends" } });
    expect(product?.gameVariant).toBeNull();
  });

  it("Task 22: rejects a non-string gameVariant with 400", async () => {
    const category = await createCategory(prisma, "Top Up Game");
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [
        {
          brand: "Mobile Legends",
          gameVariant: 123,
          rows: [{ buyerSkuCode: "ml100", productName: "X", price: "16500", costPrice: "15000" }],
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid gameVariant for "Mobile Legends".' });
  });

  it("Task 22: rejects a gameVariant longer than 32 characters with 400", async () => {
    const category = await createCategory(prisma, "Top Up Game");
    const res = await postJson("/api/catalog/digiflazz/sync/apply", {
      categoryId: category.id,
      brands: [
        {
          brand: "Mobile Legends",
          gameVariant: "x".repeat(33),
          rows: [{ buyerSkuCode: "ml100", productName: "X", price: "16500", costPrice: "15000" }],
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'gameVariant is too long for "Mobile Legends".' });
  });
});

describe("POST /api/catalog/digiflazz/sync/run", () => {
  const RUN = "/api/catalog/digiflazz/sync/run";
  const item = (buyerSkuCode: string, productName: string, price: number, buyerProductStatus = true) => ({
    buyerSkuCode, productName, category: "Game", brand: "Mobile Legends", type: "Umum",
    price: new Decimal(price), buyerProductStatus, sellerProductStatus: true, stock: null,
  });

  async function configureCreds() {
    await setSetting(prisma, "digiflazz_username", "u");
    await setSetting(prisma, "digiflazz_api_key", "k");
  }

  it("requires a session (anon -> 401) and never fetches the price list", async () => {
    await configureCreds();
    const res = await app.inject({
      method: "POST",
      url: RUN,
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(401);
    expect(digiflazzMock.getPriceList).not.toHaveBeenCalled();
  });

  it("rejects a request without a valid CSRF token (403) and never fetches the price list", async () => {
    await configureCreds();
    const res = await app.inject({
      method: "POST",
      url: RUN,
      headers: { "content-type": "application/json", "x-csrf-token": "bad" },
      cookies: { [COOKIE]: cookie },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(403);
    expect(digiflazzMock.getPriceList).not.toHaveBeenCalled();
  });

  it("answers 400 when Digiflazz credentials are not configured", async () => {
    const res = await postJson(RUN, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/credentials/i);
    expect(digiflazzMock.getPriceList).not.toHaveBeenCalled();
  });

  it("runs the full sync, returns its counts and audits it with the admin's id", async () => {
    await configureCreds();
    await setSetting(prisma, "digiflazz_markup_type", "percent");
    await setSetting(prisma, "digiflazz_markup_value", "10");
    const category = await createCategory(prisma, "Top Up Game");
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends",
      categoryId: category.id,
      rows: [
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" },
        { buyerSkuCode: "ml050", productName: "Mobile Legends 50 Diamond", price: "8800", costPrice: "8000" },
      ],
    });
    // The game is on sale, so the new SKU goes live.
    await prisma.product.update({ where: { id: productId }, data: { isActive: true } });
    await prisma.denomination.updateMany({ where: { productId }, data: { isActive: true } });
    digiflazzMock.getPriceList.mockResolvedValue([
      item("ml100", "Mobile Legends 100 Diamond", 16000, false), // price moves, SKU goes down
      item("ml050", "Mobile Legends 50 Diamond", 8000), // unchanged, stays live
      item("ml250", "Mobile Legends 250 Diamond", 38000),
    ]);

    const res = await postJson(RUN, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, updated: 1, deactivated: 1, added: 1, reactivated: 0 });
    const added = await prisma.denomination.findFirstOrThrow({ where: { supplierSku: "ml250" } });
    expect(added.isActive).toBe(true);

    const audit = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_sync_manual" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.adminId).toBe(adminId);
    expect(audit[0]!.details).toBe("Started a manual Digiflazz sync; it updated 1 price(s), added 1 new SKU(s), reactivated 0 and deactivated 1.");
  });

  it("answers 409 without running when another catalog sync is already running", async () => {
    await configureCreds();
    expect(await claimDigiflazzCatalogSyncLease(prisma)).not.toBeNull();
    digiflazzMock.getPriceList.mockResolvedValue([]);

    const res = await postJson(RUN, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already running/i);
    expect(digiflazzMock.getPriceList).not.toHaveBeenCalled();
  });

  it("answers 502 with the supplier's message when Digiflazz refuses or cannot be reached, and frees the sync for the next attempt", async () => {
    await configureCreds();
    digiflazzMock.getPriceList.mockRejectedValueOnce(
      new DigiflazzSupplierError("Digiflazz refused the price-list request: Limitasi request (rc 83)"),
    );
    const res = await postJson(RUN, {});
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("Limitasi request (rc 83)");

    digiflazzMock.getPriceList.mockResolvedValue([]);
    expect((await postJson(RUN, {})).statusCode).toBe(200);
  });

  it("answers 502 with code digiflazz_rate_limited and the Indonesian message when Digiflazz refuses with rc 83", async () => {
    await configureCreds();
    digiflazzMock.getPriceList.mockRejectedValueOnce(rateLimitedError());
    const res = await postJson(RUN, {});
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: RATE_LIMITED_MESSAGE, code: "digiflazz_rate_limited" });
  });

  it("one Sync press (run, then preview) fetches the Digiflazz price list only once", async () => {
    await configureCreds();
    digiflazzMock.getPriceList.mockResolvedValue([item("ml100", "Mobile Legends 100 Diamond", 15000)]);

    expect((await postJson(RUN, {})).statusCode).toBe(200);
    const preview = await postJson("/api/catalog/digiflazz/sync/preview", {});
    expect(preview.statusCode).toBe(200);
    expect(preview.json().groups).toHaveLength(1);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(1);
  });

  it("never prices from a cached list: a run right after a preview fetches the price list again", async () => {
    await configureCreds();
    digiflazzMock.getPriceList.mockResolvedValue([item("ml100", "Mobile Legends 100 Diamond", 15000)]);

    expect((await postJson("/api/catalog/digiflazz/sync/preview", {})).statusCode).toBe(200);
    expect((await postJson(RUN, {})).statusCode).toBe(200);
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(2);
  });

  it("refuses a run during the rc 83 cooldown with code digiflazz_rate_limited, without asking Digiflazz again", async () => {
    await configureCreds();
    digiflazzMock.getPriceList.mockRejectedValueOnce(rateLimitedError());
    expect((await postJson("/api/catalog/digiflazz/sync/preview", {})).statusCode).toBe(502);

    const res = await postJson(RUN, {});
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: RATE_LIMITED_MESSAGE, code: "digiflazz_rate_limited" });
    expect(digiflazzMock.getPriceList).toHaveBeenCalledTimes(1);
  });

  it("answers a generic 500, not 'Digiflazz could not be reached', for an error that is not the supplier's", async () => {
    await configureCreds();
    digiflazzMock.getPriceList.mockRejectedValueOnce(new Error("database connection lost"));
    const res = await postJson(RUN, {});
    expect(res.statusCode).toBe(500);
    expect(res.json().error).not.toMatch(/could not be reached/i);
    expect(res.json().error).not.toContain("database connection lost");
  });

  it("reports an aborted run (circuit breaker) instead of 'no changes', and audits it as aborted", async () => {
    await configureCreds();
    const category = await createCategory(prisma, "Top Up Game");
    await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends",
      categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "15000", costPrice: "15000" }],
    });
    digiflazzMock.getPriceList.mockResolvedValue([]); // no usable rows while a SKU is mapped

    const res = await postJson(RUN, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true, aborted: true, abortReason: "no_usable_rows", updated: 0, deactivated: 0, added: 0, reactivated: 0,
    });
    const audit = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_sync_manual" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatch(/aborted/i);
    expect(audit[0]!.details).toMatch(/nothing was changed/i);
  });
});
