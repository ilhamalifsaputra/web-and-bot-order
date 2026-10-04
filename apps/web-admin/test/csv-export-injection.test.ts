import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createCategory, createCatalogProduct, createDenomination } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";
import { csvField, csvRow } from "../src/lib/csv";

/**
 * CSV formula injection: a cell starting with `=`, `+`, `-` or `@` is run as a
 * formula by Excel/Sheets. Catalog names can come from a supplier sync, so the
 * stock export must neutralise them the way the users/orders/support exports
 * already did — through the one shared helper.
 */

describe("csvField", () => {
  it.each(["=1+1", "+cmd", "-2", "@SUM(A1)"])("prefixes %j with a single quote", (v) => {
    expect(csvField(v)).toBe(`'${v}`);
  });

  it("quotes per RFC 4180 after neutralising", () => {
    expect(csvField('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField("plain")).toBe("plain");
  });

  it("builds CRLF-terminated rows", () => {
    expect(csvRow(["a", "=b"])).toBe("a,'=b\r\n");
  });
});

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

describe("GET /api/stock/export", () => {
  it("neutralises formula-looking denomination, product and category names", async () => {
    const category = await createCategory(prisma, "@cat");
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "+prod" });
    await createDenomination(prisma, { productId: product.id, name: "=HYPERLINK(1)", type: "SHARED", durationLabel: "1 Month", price: "10000" });

    const res = await app.inject({ method: "GET", url: "/api/stock/export", cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const row = res.body.split("\r\n")[1]!;
    expect(row.startsWith("'=HYPERLINK(1),'+prod,'@cat,")).toBe(true);
  });
});
