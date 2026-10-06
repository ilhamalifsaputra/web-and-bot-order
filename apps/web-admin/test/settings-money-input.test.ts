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

  // The hand-typed USDT rate (money audit A1) is read by shape like the
  // minimums; an untouched pre-fill must re-save exactly, or a stored
  // 16123.456 would be read as 16,123,456.
  it("an untouched USD/IDR rate 16123.456 is kept as 16123.456", async () => {
    await setSetting(prisma, "usd_idr_rate", "16123.456");
    const res = await edit("usd_idr_rate", "16123.456", true);
    expect(res.statusCode, res.body).toBe(200);
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16123.456");
  });

  it("the exact path refuses a USD/IDR rate that is not a plain dot-decimal", async () => {
    await setSetting(prisma, "usd_idr_rate", "16200");
    expect((await edit("usd_idr_rate", "16.123,4", true)).statusCode).toBe(400);
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16200");
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

// Integration review fix round: the USDT rate sanity band (fx_rate_min /
// fx_rate_max) is "IDR per 1 USDT", so it is read by shape like the rate it
// judges. Saved as raw text, a ceiling typed 20.000 was read as Rp20 and
// refused every rate; 20,000 made the reader throw and silently turned the
// check off.
describe("the USDT rate sanity band is read by shape", () => {
  it.each([
    ["fx_rate_min", "50000", "fx_rate_max", false],
    ["fx_rate_min", "50000", "fx_rate_max", true],
    ["fx_rate_max", "7000", "fx_rate_min", false],
    ["fx_rate_max", "7000", "fx_rate_min", true],
  ])("final review: invalid partner cannot cross persisted %s=%s with invalid %s (reverse=%s)", async (key, value, partner, reverse) => {
    await setSetting(prisma, "fx_rate_min", "8000");
    await setSetting(prisma, "fx_rate_max", "40000");
    const pair = [[key as string, value], [partner as string, "abc"]];
    const fields = Object.fromEntries(reverse ? pair.reverse() : pair);
    const res = await post("/api/settings/import", { fields: { ...fields, shop_name: "Valid imported name" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: 1, skipped: 2 });
    expect(await getSetting(prisma, "fx_rate_min")).toBe("8000");
    expect(await getSetting(prisma, "fx_rate_max")).toBe("40000");
    expect(await getSetting(prisma, "shop_name")).toBe("Valid imported name");
  });

  it.each([
    ["fx_rate_max", "20.000", "20000"],
    ["fx_rate_max", "20,000", "20000"],
    ["fx_rate_max", "20000", "20000"],
    ["fx_rate_min", "8.000", "8000"],
    ["fx_rate_min", "8.500,50", "8500.5"],
  ])("%s: %s is stored as %s", async (key, typed, stored) => {
    const res = await edit(key, typed);
    expect(res.statusCode, res.body).toBe(200);
    expect(await getSetting(prisma, key)).toBe(stored);
  });

  it.each(["fx_rate_min", "fx_rate_max"])("%s: unreadable or non-positive text is refused and the old value stands", async (key) => {
    const before = key === "fx_rate_min" ? "9000" : "30000";
    await setSetting(prisma, key, before);
    for (const text of ["abc", "1.2.3", "-5", "0", "Rp20000", "20 000"]) {
      const res = await edit(key, text);
      expect(res.statusCode, text).toBe(400);
      expect((res.json() as { error: string }).error, text).toMatch(/rupiah/i);
    }
    expect(await getSetting(prisma, key)).toBe(before);
  });

  it("an untouched pre-filled ceiling 30000.5 re-saves unchanged", async () => {
    await setSetting(prisma, "fx_rate_max", "30000.5");
    expect((await edit("fx_rate_max", "30000.5", true)).statusCode).toBe(200);
    expect(await getSetting(prisma, "fx_rate_max")).toBe("30000.5");
  });

  it("blank still turns a bound off", async () => {
    await setSetting(prisma, "fx_rate_max", "30000");
    expect((await edit("fx_rate_max", "")).statusCode).toBe(200);
    expect(await getSetting(prisma, "fx_rate_max")).toBe("");
  });

  it("a ceiling typed 20.000 judges the typed rate in rupiah: 16.000 accepted, 25.000 refused", async () => {
    expect((await edit("fx_rate_max", "20.000")).statusCode).toBe(200);
    const ok = await edit("usd_idr_rate", "16.000");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16000");
    const tooHigh = await edit("usd_idr_rate", "25.000");
    expect(tooHigh.statusCode).toBe(400);
    expect((tooHigh.json() as { error: string }).error).toContain("20000");
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16000");
  });

  it("a floor above the ceiling is refused, and so is a ceiling below the floor", async () => {
    await setSetting(prisma, "fx_rate_min", "9000");
    await setSetting(prisma, "fx_rate_max", "20000");
    const highFloor = await edit("fx_rate_min", "25.000");
    expect(highFloor.statusCode).toBe(400);
    expect((highFloor.json() as { error: string }).error).toContain("20000");
    expect(await getSetting(prisma, "fx_rate_min")).toBe("9000");
    const lowCeiling = await edit("fx_rate_max", "8.000");
    expect(lowCeiling.statusCode).toBe(400);
    expect((lowCeiling.json() as { error: string }).error).toContain("9000");
    expect(await getSetting(prisma, "fx_rate_max")).toBe("20000");
  });

  it("a ceiling below the default floor (8000, never set) is refused", async () => {
    expect((await edit("fx_rate_max", "7.000")).statusCode).toBe(400);
    expect(await getSetting(prisma, "fx_rate_max")).toBeNull();
  });

  it("an import of an export with both bounds and the rate is read exactly", async () => {
    const res = await post("/api/settings/import", {
      fields: { usd_idr_rate: "16123.456", fx_rate_min: "9000.5", fx_rate_max: "20000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: 3, skipped: 0 });
    expect(await getSetting(prisma, "fx_rate_min")).toBe("9000.5");
    expect(await getSetting(prisma, "fx_rate_max")).toBe("20000");
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16123.456");
  });

  it("an import whose band lies wholly above this shop's ceiling applies, judged against the file's own pair", async () => {
    await setSetting(prisma, "fx_rate_max", "20000");
    const res = await post("/api/settings/import", {
      fields: { fx_rate_min: "25000", fx_rate_max: "50000", usd_idr_rate: "30000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: 3, skipped: 0 });
    expect(await getSetting(prisma, "fx_rate_min")).toBe("25000");
    expect(await getSetting(prisma, "fx_rate_max")).toBe("50000");
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("30000");
  });

  it("an import refuses a band that is crossed in the file itself", async () => {
    const res = await post("/api/settings/import", { fields: { fx_rate_min: "30000", fx_rate_max: "20000" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: number; skippedKeys: { key: string }[] };
    expect(body.applied).toBe(0);
    expect(body.skippedKeys.map((s) => s.key).sort()).toEqual(["fx_rate_max", "fx_rate_min"]);
  });
});
