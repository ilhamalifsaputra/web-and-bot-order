/**
 * Tests for resolveNicknameGate and buildNicknameProviderEntries after the
 * KokinPay-only, catalog-auto-detecting rewrite: KokinPay is the only
 * nickname-check provider, and which game (if any) to check is resolved
 * from either an admin-set `Denomination.nicknameCheckGameCode` override or
 * auto-detection of `Product.digiflazzBrand`/`name` against the static
 * catalog (`@app/core/nickname/gameCatalog`) — no more DB-backed
 * `Game`/`ProviderGameMapping` tables.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import {
  buildNicknameProviderEntries,
  resolveNicknameGate,
  setSetting,
  deleteSetting,
  KOKINPAY_API_KEY_KEY,
} from "@app/db";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
});

describe("buildNicknameProviderEntries", () => {
  it("returns a single kokinpay entry carrying the given gameCode when kokinpay credentials exist", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");

    const entries = await buildNicknameProviderEntries(prisma, "mobile-legends");

    expect(entries.map((e) => [e.provider.id, e.gameCode])).toEqual([["kokinpay", "mobile-legends"]]);
  });

  it("returns [] when gameCode is set but no kokinpay credentials are configured", async () => {
    await deleteSetting(prisma, KOKINPAY_API_KEY_KEY);

    expect(await buildNicknameProviderEntries(prisma, "mobile-legends")).toEqual([]);
  });

  it("returns [] when gameCode is null, without even checking credentials", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");

    expect(await buildNicknameProviderEntries(prisma, null)).toEqual([]);
  });
});

// ===========================================================================
// resolveNicknameGate — the single opt-in rule shared by all 3 call sites
// (apps/storefront/src/routes/apiTopup.ts, apps/order-bot/src/handlers/
// checkout.ts, apps/order-bot/src/conversations/nicknameCheck.ts). Each call
// site just destructures this function's return, so pinning the function
// itself pins all 3 call sites to the same rule structurally.
// ===========================================================================

describe("resolveNicknameGate", () => {
  type Fixture = Parameters<typeof resolveNicknameGate>[0];

  it("override present: uses nicknameCheckGameCode verbatim, with requiresZone/requiresServer from a matching catalog entry", () => {
    const denomination = {
      nicknameCheckGameCode: "mobile-legends",
      product: { digiflazzBrand: null, name: "Unrelated Product Name" },
    } as unknown as Fixture;

    // mobile-legends is a known catalog code with requiresServer: true.
    expect(resolveNicknameGate(denomination)).toEqual({
      gameCode: "mobile-legends",
      requiresZone: false,
      requiresServer: true,
    });
  });

  it("override present but not a recognized catalog code: still used verbatim, requiresZone/requiresServer default to false", () => {
    const denomination = {
      nicknameCheckGameCode: "some-hand-typed-code",
      product: { digiflazzBrand: null, name: "Unrelated Product Name" },
    } as unknown as Fixture;

    expect(resolveNicknameGate(denomination)).toEqual({
      gameCode: "some-hand-typed-code",
      requiresZone: false,
      requiresServer: false,
    });
  });

  it("override absent, brand matches a catalog entry: auto-detects from digiflazzBrand", () => {
    const denomination = {
      nicknameCheckGameCode: null,
      product: { digiflazzBrand: "Mobile Legends (Indonesia)", name: "ML 86 Diamonds" },
    } as unknown as Fixture;

    expect(resolveNicknameGate(denomination)).toEqual({
      gameCode: "mobile-legends",
      requiresZone: false,
      requiresServer: true,
    });
  });

  it("override absent, digiflazzBrand null, name matches a catalog entry, product is Digiflazz-sourced: falls back to name", () => {
    const denomination = {
      nicknameCheckGameCode: null,
      autoDeliverySource: "digiflazz",
      product: { digiflazzBrand: null, name: "Free Fire 100 Diamonds" },
    } as unknown as Fixture;

    expect(resolveNicknameGate(denomination)).toEqual({
      gameCode: "free-fire",
      requiresZone: false,
      requiresServer: false,
    });
  });

  it("override absent, digiflazzBrand null, name matches a catalog entry, but product is NOT Digiflazz-sourced: no name fallback (I-8 false-positive guard)", () => {
    const denomination = {
      nicknameCheckGameCode: null,
      autoDeliverySource: null,
      product: { digiflazzBrand: null, name: "Joki Mobile Legends" },
    } as unknown as Fixture;

    expect(resolveNicknameGate(denomination)).toEqual({ gameCode: null, requiresZone: false, requiresServer: false });
  });

  it("neither override nor a catalog match: gameCode null, requiresZone/requiresServer false", () => {
    const denomination = {
      nicknameCheckGameCode: null,
      product: { digiflazzBrand: "Some Unrelated Voucher", name: "Some Unrelated Voucher" },
    } as unknown as Fixture;

    expect(resolveNicknameGate(denomination)).toEqual({ gameCode: null, requiresZone: false, requiresServer: false });
  });

  it("override always wins over an auto-detectable brand", () => {
    const denomination = {
      nicknameCheckGameCode: "free-fire",
      product: { digiflazzBrand: "Mobile Legends", name: "Mobile Legends 86 Diamonds" },
    } as unknown as Fixture;

    expect(resolveNicknameGate(denomination)).toEqual({ gameCode: "free-fire", requiresZone: false, requiresServer: false });
  });

  it("null/undefined denomination degrades to gameCode null, never throws", () => {
    expect(resolveNicknameGate(null)).toEqual({ gameCode: null, requiresZone: false, requiresServer: false });
    expect(resolveNicknameGate(undefined)).toEqual({ gameCode: null, requiresZone: false, requiresServer: false });
  });

  it("no product on the denomination degrades to gameCode null unless an override is set", () => {
    expect(resolveNicknameGate({ nicknameCheckGameCode: null, product: null } as unknown as Fixture)).toEqual({
      gameCode: null,
      requiresZone: false,
      requiresServer: false,
    });
  });
});
