import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, getSetting } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";
import { buildApp } from "../src/server";

/**
 * Money settings are typed by an admin and read BY THEIR SHAPE (CLAUDE.md
 * "Typed money is read by its shape"): a minimum typed `10.000` is ten
 * thousand rupiah, a flat Digiflazz markup typed `1.500` is Rp1.500 — never
 * `new Decimal(text)`, which stored them as Rp10 and Rp1,5. The stored value is
 * the canonical plain decimal, so every reader's `new Decimal(stored)` sees the
 * amount the admin meant. The settings form pre-fills the stored value, so an
 * untouched pre-fill comes back in `exact_fields` and is read exactly.
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

function post(url: string, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    cookies: { [COOKIE]: cookie },
    payload: JSON.stringify(body),
  });
}

const edit = (key: string, value: string, exact = false) =>
  post("/api/settings/edit", { key, value, ...(exact ? { exact_fields: ["value"] } : {}) });

describe("money settings read typed amounts by shape", () => {
  it.each([
    ["tokopay_min_amount", "10.000", "10000"],
    ["paydisini_min_amount", "1.500,50", "1500.5"],
    ["min_order_amount_idr", "10.000", "10000"],
    ["wallet_topup_min_amount_idr", "10.000", "10000"],
    ["wallet_topup_max_amount_idr", "1.000.000", "1000000"],
    ["bybit_min_amount", "1,5", "1.5"],
    ["wallet_topup_min_amount_usdt", "2.25", "2.25"],
  ])("%s: %s is stored as %s", async (key, typed, stored) => {
    const res = await edit(key, typed);
    expect(res.statusCode, res.body).toBe(200);
    expect(await getSetting(prisma, key)).toBe(stored);
  });

  it("a flat Digiflazz markup typed 1.500 is Rp1.500, not Rp1,5", async () => {
    await setSetting(prisma, "digiflazz_markup_type", "flat");
    const res = await edit("digiflazz_markup_value", "1.500");
    expect(res.statusCode, res.body).toBe(200);
    expect(await getSetting(prisma, "digiflazz_markup_value")).toBe("1500");
  });

  it("a percent Digiflazz markup reads 1,5 as one and a half percent and refuses 1.500", async () => {
    await setSetting(prisma, "digiflazz_markup_type", "percent");
    expect((await edit("digiflazz_markup_value", "1,5")).statusCode).toBe(200);
    expect(await getSetting(prisma, "digiflazz_markup_value")).toBe("1.5");
    const res = await edit("digiflazz_markup_value", "1.500");
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "digiflazz_markup_value")).toBe("1.5");
  });

  it("a zero markup is still allowed", async () => {
    await setSetting(prisma, "digiflazz_markup_type", "flat");
    expect((await edit("digiflazz_markup_value", "0")).statusCode).toBe(200);
    expect(await getSetting(prisma, "digiflazz_markup_value")).toBe("0");
  });

  it.each([
    ["tokopay_min_amount", "abc"],
    ["tokopay_min_amount", "Infinity"],
    ["tokopay_min_amount", "0"],
    ["wallet_topup_min_amount_idr", "Infinity"],
    ["wallet_topup_max_amount_idr", "1.2.3,4,5"],
    ["min_order_amount_idr", "abc"],
    // USDT 1.000 is ambiguous (a thousand, or one?) — refused, never guessed.
    ["bybit_min_amount", "1.000"],
    ["wallet_topup_min_amount_usdt", "1.000"],
    ["digiflazz_markup_value", "abc"],
    ["digiflazz_markup_value", "Infinity"],
    ["digiflazz_markup_value", "-5"],
  ])("%s: %s is refused with 400 and nothing is stored", async (key, typed) => {
    await setSetting(prisma, key, "7");
    const res = await edit(key, typed);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
    expect(await getSetting(prisma, key)).toBe("7");
  });

  it("blank still disables a minimum", async () => {
    await setSetting(prisma, "tokopay_min_amount", "5000");
    expect((await edit("tokopay_min_amount", "")).statusCode).toBe(200);
    expect(await getSetting(prisma, "tokopay_min_amount")).toBe("");
  });
});

describe("a pre-filled stored value survives a re-save (exact_fields)", () => {
  it("an untouched USDT minimum 1.234 is kept as 1.234, not refused or read as 1234", async () => {
    await setSetting(prisma, "wallet_topup_min_amount_usdt", "1.234");
    const res = await edit("wallet_topup_min_amount_usdt", "1.234", true);
    expect(res.statusCode, res.body).toBe(200);
    expect(await getSetting(prisma, "wallet_topup_min_amount_usdt")).toBe("1.234");
  });

  it("an untouched IDR minimum 5000.5 is kept as 5000.5, not read as 50005", async () => {
    await setSetting(prisma, "tokopay_min_amount", "5000.5");
    const res = await edit("tokopay_min_amount", "5000.5", true);
    expect(res.statusCode, res.body).toBe(200);
    expect(await getSetting(prisma, "tokopay_min_amount")).toBe("5000.5");
  });

  it("an untouched flat markup 1500 stays 1500", async () => {
    await setSetting(prisma, "digiflazz_markup_type", "flat");
    await setSetting(prisma, "digiflazz_markup_value", "1500");
    expect((await edit("digiflazz_markup_value", "1500", true)).statusCode).toBe(200);
    expect(await getSetting(prisma, "digiflazz_markup_value")).toBe("1500");
  });

  it("the exact path still refuses text that is not a plain dot-decimal", async () => {
    await setSetting(prisma, "tokopay_min_amount", "7");
    for (const text of ["10.000,5", "abc", "Infinity"]) {
      expect((await edit("tokopay_min_amount", text, true)).statusCode, text).toBe(400);
    }
    expect(await getSetting(prisma, "tokopay_min_amount")).toBe("7");
  });

  it("a settings import (machine-written export values) is read exactly", async () => {
    const res = await post("/api/settings/import", {
      fields: { wallet_topup_min_amount_usdt: "1.234", tokopay_min_amount: "5000.5", paydisini_min_amount: "abc" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: 2, skipped: 1 });
    expect(await getSetting(prisma, "wallet_topup_min_amount_usdt")).toBe("1.234");
    expect(await getSetting(prisma, "tokopay_min_amount")).toBe("5000.5");
    expect(await getSetting(prisma, "paydisini_min_amount")).toBeNull();
  });
});
