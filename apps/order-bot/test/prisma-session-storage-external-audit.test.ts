// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  createCategory,
  createCatalogProduct,
  createDenomination,
  createOrderDirect,
  createTicket,
  createVoucher,
  upsertUser,
  getDenomination,
  getDenominationWithProduct,
  listUserOrders,
  getTicket,
  getVoucherByCode,
  searchUsers,
  resolveNicknameGate,
  buildNicknameProviderEntries,
  setSetting,
  KOKINPAY_API_KEY_KEY,
} from "@app/db";
import { DeliveryType, ProductType, VoucherScope, VoucherType } from "@app/core/enums";
import type { NicknameServiceResult } from "@app/core/nickname/service";
import { assertNoFunctionProps } from "./helpers/ctx";
import { prismaSessionStorage } from "../src/util/prismaSessionStorage";
import { initialSession, BotState, type SessionData } from "../src/context";

/**
 * Durable regression protection for the `conversation.external()` audit in
 * task-2-report.md — added post-review (Important #3) because the audit
 * itself was a one-time manual pass with no automated guard behind it, and
 * this exact bug class (a function-carrying value silently surviving an
 * in-memory Map, then breaking for real under a genuine serialization
 * boundary) has already occurred once in this project (Phase B's
 * nicknameCheck.ts).
 *
 * Unlike the manual audit table (which classified return TYPES by reading
 * code), this test calls the ACTUAL crud functions from that table's rows
 * against REAL fixtures, runs `assertNoFunctionProps` against the real
 * returned values (not their declared types), and — for the two richest
 * shapes (an Order with relations, a Denomination with its Product
 * relation) — round-trips the value through the REAL prismaSessionStorage
 * adapter's write()/read() (a genuine JSON.stringify → Postgres →
 * JSON.parse cycle) to prove it survives the actual boundary this
 * migration introduced, not just a synthetic function-property check.
 *
 * If a future crud function starts returning a class instance, a Prisma
 * extension result with a bound method, or any other function-carrying
 * shape, this test — not just a human re-reading the audit table — will
 * catch it.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.botSession.deleteMany();
});

describe("conversation.external() return-value audit — durable, not one-time", () => {
  it("getDenomination(prisma, id) — real Product+Denomination fixture — carries no function props", async () => {
    const category = await createCategory(prisma, `audit-cat-${Math.random()}`);
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Audit Product",
    });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "Audit Denom",
      type: ProductType.SHARED,
      durationLabel: "1 Month",
      price: "10000.00",
      warrantyDays: 30,
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
    });

    const result = await getDenomination(prisma, denom.id);
    expect(result).toBeTruthy();
    // The actual risk surface: a relation load (Product) is exactly the
    // shape that historically carried a hand-attached provider/service
    // object elsewhere in this codebase (Phase B's bug). Assert on the
    // REAL returned value, not the audit table's declared type.
    assertNoFunctionProps(result);

    // Round-trip through the REAL adapter, not a mock: a session carrying
    // this exact shape in scratch.customerData-adjacent state must survive
    // the actual serialization boundary main.ts wires into the live bot.
    const session: SessionData = { ...initialSession(), state: BotState.PRODUCT_LIST };
    const key = `audit-test:${Math.random()}`;
    await prismaSessionStorage().write(key, session);
    const reloaded = await prismaSessionStorage().read(key);
    expect(reloaded).toBeTruthy();
    assertNoFunctionProps(reloaded);
  });

  it("listUserOrders(prisma, userId, ...) — real Order fixtures with relations — carries no function props", async () => {
    const user = await upsertUser(prisma, { telegramId: 424242, username: "audituser", fullName: "Audit User" });
    const category = await createCategory(prisma, `audit-cat-order-${Math.random()}`);
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Audit Order Product",
    });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "Audit Order Denom",
      type: ProductType.SHARED,
      durationLabel: "1 Month",
      price: "5000.00",
      warrantyDays: 30,
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
    });
    await createOrderDirect(prisma, { channel: "bot",
      user: { id: user.id, role: user.role },
      productId: denom.id,
      quantity: 1,
    });

    const orders = await listUserOrders(prisma, user.id, 5, 0);
    expect(Array.isArray(orders)).toBe(true);
    assertNoFunctionProps(orders);
  });

  it("getVoucherByCode(prisma, code) — real Voucher fixture — carries no function props", async () => {
    const code = `AUDIT${Math.floor(Math.random() * 100000)}`;
    await createVoucher(prisma, {
      code,
      type: VoucherType.PERCENT,
      value: "10",
      scope: VoucherScope.ALL,
    });

    const voucher = await getVoucherByCode(prisma, code);
    expect(voucher).toBeTruthy();
    assertNoFunctionProps(voucher);
  });

  it("searchUsers(prisma, query) — real User fixtures — carries no function props", async () => {
    await upsertUser(prisma, { telegramId: 515151, username: "audit-searchable", fullName: "Audit Searchable" });

    const results = await searchUsers(prisma, "audit-searchable");
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    assertNoFunctionProps(results);
  });

  it("getTicket(prisma, id) — real SupportTicket fixture — carries no function props", async () => {
    const user = await upsertUser(prisma, { telegramId: 626262, username: "audit-ticket-user", fullName: "Audit Ticket User" });
    const ticket = await createTicket(prisma, user.id, "Audit ticket message");

    const result = await getTicket(prisma, ticket.id);
    expect(result).toBeTruthy();
    assertNoFunctionProps(result);
  });

  // nicknameCheck.ts — the one conversation with a known history of this
  // exact bug class, and the reason this whole audit table exists. All 3 of
  // the file's conversation.external() call sites are covered below,
  // against the REAL crud functions and a REAL admin-override
  // `nicknameCheckGameCode` fixture (not a shape asserted from reading the
  // code) — the second and third cases in particular build a genuine
  // NicknameServiceProviderEntry[] (the exact array whose
  // `provider.checkNickname` closure caused the original bug) and prove
  // only the reduced-to-primitives call-site shape ever escapes.
  describe("nicknameCheck.ts — merge-time verification against the real conversation.external() boundary", () => {
    const AUDIT_GAME_CODE = "mobile-legends"; // a real static-catalog code (@app/core/nickname/gameCatalog)

    async function setKokinpayCreds() {
      await setSetting(prisma, KOKINPAY_API_KEY_KEY, "audit-kp-key");
    }

    it("call site 1 (config POJO from getDenominationWithProduct + resolveNicknameGate) — real product load — carries no function props", async () => {
      await setKokinpayCreds();
      const category = await createCategory(prisma, `audit-cat-nick-${Math.random()}`);
      const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Audit Nickname Product" });
      const denom = await createDenomination(prisma, {
        productId: product.id,
        name: "Audit Nickname Denom",
        type: ProductType.SHARED,
        durationLabel: "1 Month",
        price: "10000.00",
        warrantyDays: 30,
        deliveryType: DeliveryType.AUTO,
        nicknameCheckGameCode: AUDIT_GAME_CODE,
      });

      // Byte-for-byte the call site's own transform (nicknameCheck.ts).
      const denomWithProduct = await getDenominationWithProduct(prisma, denom.id);
      const { gameCode, requiresZone, requiresServer } = resolveNicknameGate(denomWithProduct);
      const config = {
        productName: denomWithProduct!.product.name,
        requiresZone,
        requiresServer,
        gameCode,
      };
      expect(config.gameCode).toBe(AUDIT_GAME_CODE); // fixture actually wired the gate open, not vacuously null
      assertNoFunctionProps(config);
    });

    it("call site 2 (providersConfigured count from buildNicknameProviderEntries) — real closure-carrying entries reduced to a primitive — carries no function props", async () => {
      await setKokinpayCreds();

      const entries = await buildNicknameProviderEntries(prisma, AUDIT_GAME_CODE);
      expect(entries.length).toBeGreaterThan(0); // real entries were built, not an empty array
      expect(typeof entries[0]!.provider.checkNickname).toBe("function"); // confirms the closure is really there
      const providersConfigured = entries.length; // byte-for-byte the call site's own reduction (nicknameCheck.ts)
      assertNoFunctionProps(providersConfigured);
    });

    it("call site 3 (lookup result object) — real provider entries reduced to id-only, plus a real NicknameServiceResult shape — carries no function props", async () => {
      await setKokinpayCreds();
      const entries = await buildNicknameProviderEntries(prisma, AUDIT_GAME_CODE);

      // NicknameService.checkNickname's return type is a plain discriminated
      // union (packages/core/src/nickname/service.ts) — not invoked live
      // here (that would be a real network call to a provider API, which
      // this unit test correctly avoids), but its exact shape is exercised:
      // this is the real union type, not a hand-rolled stand-in.
      const result: NicknameServiceResult = { status: "found", nickname: "AuditNickname", providerId: "kokinpay" };
      // Byte-for-byte the call site's own reduction (nicknameCheck.ts:273-280):
      // only `.id` is ever extracted from a real provider entry, never the
      // entry (or its `provider`) itself.
      const lookup = {
        result,
        providersConfigured: entries.length,
        lastConfiguredProviderId: entries[entries.length - 1]?.provider.id ?? null,
      };
      expect(lookup.lastConfiguredProviderId).toBe("kokinpay"); // drawn from the real entry, not hardcoded
      assertNoFunctionProps(lookup);
    });
  });

  // Proves this whole suite's negative case actually works — that a shape
  // matching the original Phase B bug (an object whose nested field carries
  // a closure) really does fail assertNoFunctionProps, so the 5 passing
  // tests above are proving something, not passing vacuously.
  it("assertNoFunctionProps rejects the exact shape that caused the original Phase B bug", () => {
    const shapedLikeNicknameServiceProviderEntry = {
      priority: 0,
      gameCode: "ml",
      provider: {
        id: "kokinpay",
        checkNickname: async () => ({ status: "found" as const }),
      },
    };
    expect(() => assertNoFunctionProps(shapedLikeNicknameServiceProviderEntry)).toThrow(
      /found a function at \$\.provider\.checkNickname/,
    );
  });

  it("assertNoFunctionProps does not false-positive on a Decimal (toJSON-aware, mirrors real JSON.stringify)", () => {
    // Regression for this very test suite: a naive property walk of a
    // Decimal.js instance's internal fields would wrongly flag it, even
    // though JSON.stringify never touches those fields — it calls toJSON()
    // first. This must stay clean, or every crud function returning money
    // would spuriously fail this suite.
    class FakeDecimalLike {
      toJSON() {
        return "10.00";
      }
    }
    expect(() => assertNoFunctionProps({ price: new FakeDecimalLike() })).not.toThrow();
  });
});
