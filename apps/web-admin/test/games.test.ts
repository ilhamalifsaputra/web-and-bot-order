/**
 * Route tests for the Games admin API (Task 10) — Game / ProviderGameMapping
 * CRUD plus the product-update route's gameId wiring. Follows
 * admins-api.test.ts's postJson + cookie/csrf setup convention.
 */
import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import {
  prisma,
  initDb,
  upsertUser,
  setSetting,
  createCategory,
  createCatalogProduct,
} from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

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
  await prisma.providerGameMapping.deleteMany();
  await prisma.game.deleteMany();
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

function patchJson(url: string, c: string | null, csrfToken: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    cookies: c ? { [COOKIE]: c } : {},
    payload: JSON.stringify(body),
  });
}

function get(url: string, c: string | null) {
  return app.inject({ method: "GET", url, cookies: c ? { [COOKIE]: c } : {} });
}

async function createGameRow(overrides: Record<string, unknown> = {}) {
  const res = await postJson("/api/games", cookie, csrf, {
    slug: "mobile-legends",
    name: "Mobile Legends",
    ...overrides,
  });
  expect(res.statusCode).toBe(201);
  return res.json().game as { id: number; slug: string; name: string };
}

describe("POST /api/games + GET /api/games", () => {
  it("creates a game and lists it", async () => {
    const res = await postJson("/api/games", cookie, csrf, { slug: "mobile-legends", name: "Mobile Legends" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.game).toMatchObject({ slug: "mobile-legends", name: "Mobile Legends" });

    const list = await get("/api/games", cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json().games.map((g: { slug: string }) => g.slug)).toContain("mobile-legends");

    const audit = await prisma.auditLog.findFirst({ where: { action: "game_create" } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("Mobile Legends");
  });

  it("rejects a duplicate slug with 400", async () => {
    await createGameRow();
    const res = await postJson("/api/games", cookie, csrf, { slug: "mobile-legends", name: "Mobile Legends 2" });
    expect(res.statusCode).toBe(400);
    const count = await prisma.game.count({ where: { slug: "mobile-legends" } });
    expect(count).toBe(1);
  });

  it("rejects an empty name with 400", async () => {
    const res = await postJson("/api/games", cookie, csrf, { slug: "free-fire", name: "  " });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-url-safe slug with 400", async () => {
    const res = await postJson("/api/games", cookie, csrf, { slug: "Mobile Legends!", name: "Mobile Legends" });
    expect(res.statusCode).toBe(400);
  });

  it("requires auth (anon -> 303 /login) and writes nothing", async () => {
    const res = await postJson("/api/games", null, csrf, { slug: "mobile-legends", name: "Mobile Legends" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(await prisma.game.count()).toBe(0);
  });

  it("rejects bad CSRF (403) and writes nothing", async () => {
    const res = await postJson("/api/games", cookie, "bad", { slug: "mobile-legends", name: "Mobile Legends" });
    expect(res.statusCode).toBe(403);
    expect(await prisma.game.count()).toBe(0);
  });
});

describe("GET /api/games/:id", () => {
  it("returns the game with its mappings", async () => {
    const game = await createGameRow();
    const res = await get(`/api/games/${game.id}`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().game).toMatchObject({ id: game.id, providerMappings: [] });
  });

  it("404s for a non-existent game", async () => {
    const res = await get("/api/games/999999", cookie);
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/games/:id/edit", () => {
  it("updates fields and audits", async () => {
    const game = await createGameRow();
    const res = await postJson(`/api/games/${game.id}/edit`, cookie, csrf, {
      name: "Mobile Legends: Bang Bang",
      requiresZone: true,
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.game.findUnique({ where: { id: game.id } });
    expect(row!.name).toBe("Mobile Legends: Bang Bang");
    expect(row!.requiresZone).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { action: "game_update" } });
    expect(audit).toBeTruthy();
  });

  it("requires auth (anon -> 303 /login)", async () => {
    const game = await createGameRow();
    const res = await postJson(`/api/games/${game.id}/edit`, null, csrf, { name: "Hacked" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const game = await createGameRow();
    const res = await postJson(`/api/games/${game.id}/edit`, cookie, "bad", { name: "Hacked" });
    expect(res.statusCode).toBe(403);
    expect((await prisma.game.findUnique({ where: { id: game.id } }))!.name).toBe("Mobile Legends");
  });
});

describe("POST /api/games/:id/delete", () => {
  it("succeeds when unreferenced", async () => {
    const game = await createGameRow();
    const res = await postJson(`/api/games/${game.id}/delete`, cookie, csrf, {});
    expect(res.statusCode).toBe(200);
    expect(await prisma.game.findUnique({ where: { id: game.id } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "game_delete" } });
    expect(audit).toBeTruthy();
  });

  it("returns 400 with a clear message when a Product still references it", async () => {
    const game = await createGameRow();
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent" });
    await prisma.product.update({ where: { id: product.id }, data: { gameId: game.id } });

    const res = await postJson(`/api/games/${game.id}/delete`, cookie, csrf, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual(expect.any(String));
    expect(res.json().error.length).toBeGreaterThan(0);
    expect(await prisma.game.findUnique({ where: { id: game.id } })).not.toBeNull();
  });

  it("requires auth (anon -> 303 /login)", async () => {
    const game = await createGameRow();
    const res = await postJson(`/api/games/${game.id}/delete`, null, csrf, {});
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const game = await createGameRow();
    const res = await postJson(`/api/games/${game.id}/delete`, cookie, "bad", {});
    expect(res.statusCode).toBe(403);
    expect(await prisma.game.findUnique({ where: { id: game.id } })).not.toBeNull();
  });
});

describe("POST /api/games/:id/mappings", () => {
  it("rejects an invalid provider with 400", async () => {
    const game = await createGameRow();
    const res = await postJson(`/api/games/${game.id}/mappings`, cookie, csrf, {
      provider: "not-a-real-provider",
      providerGameCode: "ML001",
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.providerGameMapping.count()).toBe(0);
  });

  it("upserts in place — a second call for the same provider updates the one row", async () => {
    const game = await createGameRow();
    const first = await postJson(`/api/games/${game.id}/mappings`, cookie, csrf, {
      provider: "kokinpay",
      providerGameCode: "ML001",
      priority: 1,
    });
    expect(first.statusCode).toBe(200);

    const second = await postJson(`/api/games/${game.id}/mappings`, cookie, csrf, {
      provider: "kokinpay",
      providerGameCode: "ML002",
      priority: 5,
      enabled: false,
    });
    expect(second.statusCode).toBe(200);

    const rows = await prisma.providerGameMapping.findMany({ where: { gameId: game.id, provider: "kokinpay" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerGameCode).toBe("ML002");
    expect(rows[0]!.priority).toBe(5);
    expect(rows[0]!.enabled).toBe(false);

    const audit = await prisma.auditLog.findFirst({ where: { action: "game_mapping_upsert" } });
    expect(audit).toBeTruthy();
  });

  it("accepts each of the three valid providers", async () => {
    const game = await createGameRow();
    for (const provider of ["kokinpay", "vipreseller", "melostore"]) {
      const res = await postJson(`/api/games/${game.id}/mappings`, cookie, csrf, {
        provider,
        providerGameCode: `code-${provider}`,
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("requires auth (anon -> 303 /login)", async () => {
    const game = await createGameRow();
    const res = await postJson(`/api/games/${game.id}/mappings`, null, csrf, {
      provider: "kokinpay",
      providerGameCode: "ML001",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const game = await createGameRow();
    const res = await postJson(`/api/games/${game.id}/mappings`, cookie, "bad", {
      provider: "kokinpay",
      providerGameCode: "ML001",
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.providerGameMapping.count()).toBe(0);
  });
});

describe("POST /api/games/:id/mappings/:mappingId/delete", () => {
  async function seedMapping(gameId: number) {
    const res = await postJson(`/api/games/${gameId}/mappings`, cookie, csrf, {
      provider: "kokinpay",
      providerGameCode: "ML001",
    });
    return res.json().mapping.id as number;
  }

  it("deletes the mapping and audits", async () => {
    const game = await createGameRow();
    const mappingId = await seedMapping(game.id);

    const res = await postJson(`/api/games/${game.id}/mappings/${mappingId}/delete`, cookie, csrf, {});
    expect(res.statusCode).toBe(200);
    expect(await prisma.providerGameMapping.findUnique({ where: { id: mappingId } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { action: "game_mapping_delete" } });
    expect(audit).toBeTruthy();
  });

  it("requires auth (anon -> 303 /login)", async () => {
    const game = await createGameRow();
    const mappingId = await seedMapping(game.id);
    const res = await postJson(`/api/games/${game.id}/mappings/${mappingId}/delete`, null, csrf, {});
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const game = await createGameRow();
    const mappingId = await seedMapping(game.id);
    const res = await postJson(`/api/games/${game.id}/mappings/${mappingId}/delete`, cookie, "bad", {});
    expect(res.statusCode).toBe(403);
    expect(await prisma.providerGameMapping.findUnique({ where: { id: mappingId } })).not.toBeNull();
  });
});

describe("PATCH /api/catalog/products/:id — gameId (Task 10)", () => {
  async function seedProduct() {
    const category = await createCategory(prisma, "Cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent" });
    return product.id;
  }

  it("sets gameId to a valid, active game", async () => {
    const game = await createGameRow();
    const productId = await seedProduct();
    const res = await patchJson(`/api/catalog/products/${productId}`, cookie, csrf, {
      name: "Parent",
      gameId: game.id,
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.product.findUnique({ where: { id: productId } });
    expect(row!.gameId).toBe(game.id);
  });

  it("rejects a non-existent gameId with 400 'Game not found.' and leaves the row unchanged", async () => {
    const productId = await seedProduct();
    const res = await patchJson(`/api/catalog/products/${productId}`, cookie, csrf, {
      name: "Parent",
      gameId: 999999,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Game not found." });
    const row = await prisma.product.findUnique({ where: { id: productId } });
    expect(row!.gameId).toBeNull();
  });

  // Final-review fix, Finding 4: an existing-but-inactive game must get a
  // DIFFERENT message than a genuinely non-existent one, so the admin isn't
  // told a game "doesn't exist" when it's just been deactivated.
  it("rejects an existing but inactive gameId with 400 'That game is inactive.' and leaves the row unchanged", async () => {
    const game = await createGameRow();
    await prisma.game.update({ where: { id: game.id }, data: { isActive: false } });
    const productId = await seedProduct();
    const res = await patchJson(`/api/catalog/products/${productId}`, cookie, csrf, {
      name: "Parent",
      gameId: game.id,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "That game is inactive." });
    const row = await prisma.product.findUnique({ where: { id: productId } });
    expect(row!.gameId).toBeNull();
  });

  it("clears gameId to null", async () => {
    const game = await createGameRow();
    const productId = await seedProduct();
    await prisma.product.update({ where: { id: productId }, data: { gameId: game.id } });

    const res = await patchJson(`/api/catalog/products/${productId}`, cookie, csrf, {
      name: "Parent",
      gameId: null,
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.product.findUnique({ where: { id: productId } });
    expect(row!.gameId).toBeNull();
  });

  it("omitting gameId entirely leaves an existing link untouched", async () => {
    const game = await createGameRow();
    const productId = await seedProduct();
    await prisma.product.update({ where: { id: productId }, data: { gameId: game.id } });

    const res = await patchJson(`/api/catalog/products/${productId}`, cookie, csrf, { name: "Parent" });
    expect(res.statusCode).toBe(200);
    const row = await prisma.product.findUnique({ where: { id: productId } });
    expect(row!.gameId).toBe(game.id);
  });
});
