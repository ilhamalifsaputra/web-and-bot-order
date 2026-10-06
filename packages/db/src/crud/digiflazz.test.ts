/**
 * Tests for the Digiflazz dispatch poller and auto-fulfillment path —
 * getDigiflazzCreds, buildDigiflazzCustomerNo, dispatchPendingDigiflazzOrders,
 * fulfillDigiflazzOrder. Follows crud/tokopay.test.ts's makeTestDb +
 * buildSampleData shape; mocks @app/core/suppliers/digiflazz's
 * createTransaction since this file never makes a real HTTP call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const digiflazzMock = vi.hoisted(() => ({
  createTransaction: vi.fn(),
  getPriceList: vi.fn(),
}));
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()),
  createTransaction: digiflazzMock.createTransaction,
  getPriceList: digiflazzMock.getPriceList,
}));

// Reactive account/region diagnostic (Task 5): terminalFailDigiflazzOrder
// runs a fallback KokinPay nickname lookup through NicknameService/
// resolveNicknameGate/buildNicknameProviderEntries — mock the HTTP-layer
// checkGameNickname (same choke point apiTopup.ts's test suite mocks) so
// these tests never make a real network call.
const kokinpayHttpMock = vi.hoisted(() => ({ checkGameNickname: vi.fn() }));
vi.mock("@app/core/suppliers/kokinpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/kokinpay")>()),
  checkGameNickname: kokinpayHttpMock.checkGameNickname,
}));

// Fix-pass regression test support (Critical #2): enqueueManualDeliveredDm is
// called INSIDE fulfillDigiflazzOrder, AFTER its own PROCESSING->DELIVERED
// claim and finalizeDeliverySideEffects have already run — mocking it to
// reject for one test is the cleanest way to reproduce "a side effect after
// the DELIVERED claim already committed threw". Defaults to the real
// implementation (set below once importOriginal resolves) so every other
// test in this file keeps exercising the genuine notification-enqueue path.
const notificationsMock = vi.hoisted(() => ({
  enqueueManualDeliveredDm: vi.fn(),
}));
vi.mock("./notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./notifications")>();
  notificationsMock.enqueueManualDeliveredDm.mockImplementation(actual.enqueueManualDeliveredDm);
  return {
    ...actual,
    enqueueManualDeliveredDm: notificationsMock.enqueueManualDeliveredDm,
  };
});

import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  createOrderFromCart,
  addToCart,
  createCatalogProduct,
  createDenomination,
  setSetting,
  deleteSetting,
  getOrder,
  ADMIN_IDS_KEY,
  KOKINPAY_API_KEY_KEY,
} from "@app/db";
import {
  getDigiflazzCreds,
  buildDigiflazzCustomerNo,
  dispatchPendingDigiflazzOrders,
  fulfillDigiflazzOrder,
  resolveSingleDigiflazzItem,
  DIGIFLAZZ_USERNAME_KEY,
  DIGIFLAZZ_API_KEY_KEY,
  DIGIFLAZZ_ENABLED_KEY,
  collapseToCheapestSeller,
  groupDigiflazzPriceListByBrand,
  computeDigiflazzMarkupPrice,
  readDigiflazzMarkup,
  applyDigiflazzMarkup,
  InvalidDigiflazzMarkupError,
  isDigiflazzPriceOverridden,
  importDigiflazzBrand,
  resyncDigiflazzCatalog,
  detectMixedDigiflazzProducts,
  splitMixedDigiflazzProducts,
  detectMixedTypeProducts,
  splitMixedTypeProducts,
  DIGIFLAZZ_MARKUP_TYPE_KEY,
  DIGIFLAZZ_MARKUP_VALUE_KEY,
  getDigiflazzSyncStatus,
  DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS,
} from "@app/db";
import { OrderStatus, DeliveryType, NotificationEvent } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { buildCustomerDataUnit } from "@app/core/nickname/fieldMapping";
import { parseAdditionalFields } from "@app/core/deliveryFields";
import { digiflazzGroupKey } from "@app/core/suppliers/digiflazz";
import type { DigiflazzPriceListItem } from "@app/core/suppliers/digiflazz";
import {
  credentialEnvelopeVersion,
  encryptCredentials,
  settingValueAad,
  decryptDeliveredContent,
  isEncryptedCredentialEnvelope,
} from "@app/core/credentialCrypto";
import { useEnvelopeWriteV2 } from "../../../../tests/helpers/envelopeFlag";
// I3 test: spy on getSetting itself (not just the underlying Prisma query,
// which a 30s TTL cache can mask) to confirm the markup setting is read a
// CONSTANT number of times per run, not once per denomination.
import * as settingsModule from "./settings";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  digiflazzMock.createTransaction.mockReset();
  digiflazzMock.getPriceList.mockReset();
  kokinpayHttpMock.checkGameNickname.mockReset();
  await setSetting(prisma, DIGIFLAZZ_USERNAME_KEY, "shopuser");
  await setSetting(prisma, DIGIFLAZZ_API_KEY_KEY, "shopkey");
});

/** Flip the sample denomination into a Digiflazz-mapped, manual_with_info SKU
 * and place a PROCESSING order against it — the state the poller looks for. */
async function makeProcessingDigiflazzOrder(supplierSku = "ml100") {
  await prisma.denomination.update({
    where: { id: sample.product.id },
    data: {
      autoDeliverySource: "digiflazz",
      supplierSku,
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      ]),
    },
  });
  const order = (await createOrderDirect(prisma, {
   channel: "bot",
    user: sample.user,
    productId: sample.product.id,
    quantity: 1,
    customerData: JSON.stringify([{ user_id: "123456789" }]),
  }))!;
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });
  return order;
}

/** Same shape as makeProcessingDigiflazzOrder, but built for the reactive
 * account/region diagnostic tests: no additionalFields (customerNo/
 * buildDigiflazzCustomerNo aren't under test here), an optional
 * `nicknameCheckGameCode` override on the denomination, and a customerData
 * unit shaped `{ target, zone?, server? }` — the exact shape
 * nicknameCheck.ts (order-bot) stashes into Order.customerData when a
 * checkout actually went through the nickname-check gate (see
 * apps/order-bot/src/conversations/nicknameCheck.ts). */
async function makeProcessingDigiflazzOrderForDiagnostic(opts: {
  nicknameCheckGameCode?: string | null;
  customerDataUnit?: Record<string, string>;
  supplierSku?: string;
} = {}) {
  await prisma.denomination.update({
    where: { id: sample.product.id },
    data: {
      autoDeliverySource: "digiflazz",
      supplierSku: opts.supplierSku ?? "ml100",
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      // Field defs matching the customerData keys these tests write —
      // createOrderDirect re-validates manual_with_info customerData
      // against the denomination's field spec (orders.ts), so an
      // undeclared key (like "target") would otherwise be silently
      // stripped before it ever reaches the diagnostic. Exactly 2 fields,
      // matching what a real "mobile-legends" SKU (requiresZone: false,
      // requiresServer: true) would actually be configured with —
      // nicknameFieldMapping reads fields POSITIONALLY (final-review round
      // 2), so `server` must sit at field index 1 (right after `target`),
      // not a 3rd slot behind an unused `zone` field this game never needs.
      additionalFields: JSON.stringify([
        { key: "target", label: { id: "Target", en: "Target" }, type: "text", required: true, options: [], placeholder: "" },
        { key: "server", label: { id: "Server", en: "Server" }, type: "text", required: false, options: [], placeholder: "" },
      ]),
      nicknameCheckGameCode: opts.nicknameCheckGameCode ?? null,
    },
  });
  const order = (await createOrderDirect(prisma, {
   channel: "bot",
    user: sample.user,
    productId: sample.product.id,
    quantity: 1,
    customerData: JSON.stringify([opts.customerDataUnit ?? {}]),
  }))!;
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });
  return order;
}

describe("terminalFailDigiflazzOrder — reactive account/region diagnostic (Task 5)", () => {
  it("supplierGaveReason:false + a game code that resolves + KokinPay credentials configured -> accountDiagnosticNote is set from the lookup", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    const order = await makeProcessingDigiflazzOrderForDiagnostic({
      nicknameCheckGameCode: "mobile-legends",
      customerDataUnit: { target: "123456789", server: "2001" },
    });
    kokinpayHttpMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "ProGamer99" });
    // Bare "Gagal" — no message field at all — is exactly the "Digiflazz
    // gave no reason" trigger (supplierGaveReason: Boolean(result.message)).
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Gagal", sn: null, message: null, price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });

    expect(kokinpayHttpMock.checkGameNickname).toHaveBeenCalledTimes(1);
    expect(kokinpayHttpMock.checkGameNickname).toHaveBeenCalledWith(
      { apiKey: "kp-key" },
      { gameCode: "mobile-legends", id: "123456789", server: "2001" },
    );
    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.digiflazzStatus).toBe("failed");
    expect(refreshed!.accountDiagnosticNote).toContain("ProGamer99");
    expect(refreshed!.accountDiagnosticNote).toContain("ditemukan");

    // Recommended §5 wiring: the note is folded into the audit log sentence.
    const auditRow = await prisma.auditLog.findFirst({ where: { targetId: order.id, action: "order.digiflazz_dispatch_failed" } });
    expect(auditRow!.details).toContain("ProGamer99");
  });

  it("supplierGaveReason:true (Digiflazz gave a real message) -> KokinPay is never called, accountDiagnosticNote stays null", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    const order = await makeProcessingDigiflazzOrderForDiagnostic({
      nicknameCheckGameCode: "mobile-legends",
      customerDataUnit: { target: "123456789" },
    });
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Gagal", sn: null, message: "Saldo tidak cukup", price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });

    expect(kokinpayHttpMock.checkGameNickname).not.toHaveBeenCalled();
    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.digiflazzStatus).toBe("failed");
    expect(refreshed!.accountDiagnosticNote).toBeNull();
  });

  it("supplierGaveReason:true (structural resolution failure, e.g. missing supplierSku) -> KokinPay is never called, accountDiagnosticNote stays null", async () => {
    // No supplierSku configured on the denomination at all — resolveSingleDigiflazzItem
    // refuses before createTransaction is ever called, and that reason is
    // always structural/meaningful (never "Digiflazz gave no reason").
    await prisma.denomination.update({
      where: { id: sample.product.id },
      data: {
        autoDeliverySource: "digiflazz",
        supplierSku: null,
        deliveryType: DeliveryType.MANUAL_WITH_INFO,
        nicknameCheckGameCode: "mobile-legends",
      },
    });
    const order = (await createOrderDirect(prisma, {
     channel: "bot",
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
      customerData: JSON.stringify([{ target: "123456789" }]),
    }))!;
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });

    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();
    expect(kokinpayHttpMock.checkGameNickname).not.toHaveBeenCalled();
    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.accountDiagnosticNote).toBeNull();
  });

  it("supplierGaveReason:false but the product doesn't match any catalog game -> no crash, accountDiagnosticNote stays null, failure-handling still happens normally", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    // No nicknameCheckGameCode override, and the sample denomination's
    // parent Product ("Netflix Premium 1M") doesn't auto-detect against the
    // static game catalog — resolveNicknameGate resolves gameCode: null.
    const order = await makeProcessingDigiflazzOrderForDiagnostic({
      customerDataUnit: { target: "123456789" },
    });
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Gagal", sn: null, message: null, price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });

    expect(kokinpayHttpMock.checkGameNickname).not.toHaveBeenCalled();
    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.digiflazzStatus).toBe("failed");
    expect(refreshed!.accountDiagnosticNote).toBeNull();
    // Existing failure-handling behavior (alert, audit log, realtime emit)
    // still happens normally — same assertions as the pre-existing "alerts
    // admins... on Gagal" test.
    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull();
    const auditRow = await prisma.auditLog.findFirst({ where: { targetId: order.id, action: "order.digiflazz_dispatch_failed" } });
    expect(auditRow).not.toBeNull();
  });

  it("supplierGaveReason:false, game code resolves, but no KokinPay credentials configured -> no crash, accountDiagnosticNote stays null", async () => {
    await deleteSetting(prisma, KOKINPAY_API_KEY_KEY);
    const order = await makeProcessingDigiflazzOrderForDiagnostic({
      nicknameCheckGameCode: "mobile-legends",
      customerDataUnit: { target: "123456789" },
    });
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Gagal", sn: null, message: null, price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });

    expect(kokinpayHttpMock.checkGameNickname).not.toHaveBeenCalled();
    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.accountDiagnosticNote).toBeNull();
  });

  it("supplierGaveReason:false, game code resolves, KokinPay configured, but the lookup is a definitive not_found -> accountDiagnosticNote reports the mismatch", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    const order = await makeProcessingDigiflazzOrderForDiagnostic({
      nicknameCheckGameCode: "mobile-legends",
      customerDataUnit: { target: "000000000" },
    });
    kokinpayHttpMock.checkGameNickname.mockResolvedValueOnce({ valid: false, nickname: null });
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Gagal", sn: null, message: null, price: null,
    });

    await dispatchPendingDigiflazzOrders(prisma);

    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.accountDiagnosticNote).toContain("tidak ditemukan");
    expect(refreshed!.accountDiagnosticNote).toContain("mobile-legends");
  });

  // Minor-4 (final whole-branch review): every case above drives the
  // diagnostic via the nicknameCheckGameCode override — none exercises
  // catalog auto-detect through the nested `product: { digiflazzBrand,
  // name }` select dispatchPendingDigiflazzOrders's query joins. This one
  // does: no override at all, only the parent Product's digiflazzBrand.
  it("supplierGaveReason:false, an explicitly backfilled game code -> accountDiagnosticNote is set from the lookup", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await prisma.product.update({ where: { id: sample.parentProduct.id }, data: { digiflazzBrand: "Mobile Legends" } });
    const order = await makeProcessingDigiflazzOrderForDiagnostic({
      nicknameCheckGameCode: "mobile-legends",
      customerDataUnit: { target: "123456789", server: "2001" },
    });
    kokinpayHttpMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "AutoDetectedPlayer" });
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Gagal", sn: null, message: null, price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });

    expect(kokinpayHttpMock.checkGameNickname).toHaveBeenCalledTimes(1);
    expect(kokinpayHttpMock.checkGameNickname).toHaveBeenCalledWith(
      { apiKey: "kp-key" },
      { gameCode: "mobile-legends", id: "123456789", server: "2001" },
    );
    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.accountDiagnosticNote).toContain("AutoDetectedPlayer");
    expect(refreshed!.accountDiagnosticNote).toContain("ditemukan");
  });

  // ===========================================================================
  // Final-review round 2 (money-critical gap this closes): every case above
  // uses a bot-shaped {target,zone,server} customerData fixture. Before this
  // fix, computeAccountDiagnosticNote ONLY ever read `unit.target` — so it
  // silently returned null for every STOREFRONT-placed order, whose
  // customerData is keyed by the SKU's own additionalFields (e.g.
  // {user_id,server_id}), never `target`. This test uses a
  // storefront-shaped fixture to prove the diagnostic now actually works for
  // that traffic too — this is the exact gap the re-review found the
  // existing test suite blind to.
  // ===========================================================================
  it("a STOREFRONT-shaped customerData fixture ({user_id,server_id}, no 'target' key at all) still produces a diagnostic note", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await prisma.denomination.update({
      where: { id: sample.product.id },
      data: {
        autoDeliverySource: "digiflazz",
        supplierSku: "ml100",
        deliveryType: DeliveryType.MANUAL_WITH_INFO,
        // Storefront-shaped field keys — exactly what apiTopup.ts's
        // checkout form (and the storefront's account-info step generally)
        // writes, driven by the SKU's OWN additionalFields schema. No
        // "target" key anywhere.
        additionalFields: JSON.stringify([
          { key: "user_id", label: { id: "User ID", en: "User ID" }, type: "text", required: true, options: [], placeholder: "" },
          { key: "server_id", label: { id: "Server ID", en: "Server ID" }, type: "text", required: false, options: [], placeholder: "" },
        ]),
        nicknameCheckGameCode: "mobile-legends", // requiresZone:false, requiresServer:true
      },
    });
    const order = (await createOrderDirect(prisma, {
     channel: "bot",
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
      customerData: JSON.stringify([{ user_id: "12345", server_id: "6" }]),
    }))!;
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });
    kokinpayHttpMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "StorefrontPlayer" });
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Gagal", sn: null, message: null, price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });

    expect(kokinpayHttpMock.checkGameNickname).toHaveBeenCalledTimes(1);
    expect(kokinpayHttpMock.checkGameNickname).toHaveBeenCalledWith(
      { apiKey: "kp-key" },
      { gameCode: "mobile-legends", id: "12345", server: "6" },
    );
    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.accountDiagnosticNote).toContain("StorefrontPlayer");
    expect(refreshed!.accountDiagnosticNote).toContain("ditemukan");
  });
});

describe("getDigiflazzCreds", () => {
  it("returns credentials when username/apiKey are set and not disabled", async () => {
    const creds = await getDigiflazzCreds(prisma);
    expect(creds).toEqual({ username: "shopuser", apiKey: "shopkey" });
  });

  it("returns null when credentials are missing", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
    expect(await getDigiflazzCreds(prisma)).toBeNull();
  });

  it("returns null when explicitly disabled", async () => {
    await setSetting(prisma, DIGIFLAZZ_ENABLED_KEY, "false");
    expect(await getDigiflazzCreds(prisma)).toBeNull();
  });

  it("decrypts the digiflazz api key when stored as an encrypted envelope (Task 13)", async () => {
    await setSetting(prisma, DIGIFLAZZ_API_KEY_KEY, encryptCredentials("real-digiflazz-apikey", settingValueAad(DIGIFLAZZ_API_KEY_KEY)));
    expect(await getDigiflazzCreds(prisma)).toEqual({ username: "shopuser", apiKey: "real-digiflazz-apikey" });
  });
});

describe("buildDigiflazzCustomerNo", () => {
  it("joins non-empty answers in field-definition order", () => {
    const product = {
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
        { key: "server_id", label: { id: "Server", en: "Server" }, type: "text", required: false, options: [], placeholder: "" },
      ]),
    };
    const customerData = JSON.stringify([{ user_id: "123456789", server_id: "2001" }]);
    expect(buildDigiflazzCustomerNo(product, customerData)).toBe("123456789 2001");
  });

  it("skips blank answers", () => {
    const product = {
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
        { key: "server_id", label: { id: "Server", en: "Server" }, type: "text", required: false, options: [], placeholder: "" },
      ]),
    };
    const customerData = JSON.stringify([{ user_id: "123456789", server_id: "" }]);
    expect(buildDigiflazzCustomerNo(product, customerData)).toBe("123456789");
  });

  // ===========================================================================
  // Money-critical (final-review round 2). The bug this closes: nicknameCheck.ts
  // (the bot's live nickname-check wizard) used to write Order.customerData as
  // a hardcoded {target,zone,server} object, completely independent of the
  // SKU's OWN additionalFields — which is what buildDigiflazzCustomerNo (this
  // function, the thing that actually builds the string sent to the real
  // Digiflazz supplier API) reads. That meant an order that went through the
  // nickname-check wizard dispatched to Digiflazz with an EMPTY customer_no —
  // a real order with no account id at all. The fix: nicknameCheck.ts now
  // builds its customerData unit through nicknameFieldMapping, keyed into the
  // SKU's actual additionalFields, positionally — exactly what this test
  // reproduces and asserts round-trips into a NON-EMPTY customerNo.
  // ===========================================================================
  it("[MONEY-CRITICAL] a unit built the way nicknameCheck.ts now builds it (via the shared buildCustomerDataUnit) round-trips into a NON-EMPTY customerNo containing the target", () => {
    // The SKU's own admin-defined additionalFields — e.g. a real
    // "mobile-legends" SKU (requiresZone: false, requiresServer: true).
    const product = {
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "User ID", en: "User ID" }, type: "text", required: true, options: [], placeholder: "" },
        { key: "server_id", label: { id: "Server ID", en: "Server ID" }, type: "text", required: false, options: [], placeholder: "" },
      ]),
    };
    const additionalFields = parseAdditionalFields(product.additionalFields);

    // Final-review round 3 dedup: call the REAL, shared buildCustomerDataUnit
    // (packages/core/src/nickname/fieldMapping.ts) — the exact function
    // nicknameCheck.ts's production code calls — instead of an inlined copy
    // of its logic, so this test actually catches drift in the shipped
    // implementation, not just in the mapping pattern.
    const requiresZone = false;
    const requiresServer = true;
    const answer: { target: string; zone?: string; server?: string; nickname?: string } = {
      target: "GAMER-999888777",
      server: "SRV-42",
      nickname: "MoneyCriticalPlayer",
    };
    const unit = buildCustomerDataUnit(additionalFields, requiresZone, requiresServer, answer);

    // This is exactly what nicknameCheck.ts now writes onto
    // scratch.customerData / Order.customerData.
    expect(unit).toEqual({ user_id: "GAMER-999888777", server_id: "SRV-42", nickname: "MoneyCriticalPlayer" });

    const customerNo = buildDigiflazzCustomerNo(product, JSON.stringify([unit]));

    // The exact assertion that would have caught the pre-fix bug: a
    // regression back to the old hardcoded {target,zone,server} shape would
    // make this an EMPTY string (buildDigiflazzCustomerNo's field.key ->
    // unit[field.key] lookup would find nothing under "user_id"/"server_id").
    expect(customerNo).not.toBe("");
    expect(customerNo.length).toBeGreaterThan(0);
    expect(customerNo).toContain("GAMER-999888777");
    expect(customerNo).toBe("GAMER-999888777 SRV-42");
  });

  it("[MONEY-CRITICAL] historical target/server aliases remain fulfillable through configured keys", () => {
    const product = {
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "User ID", en: "User ID" }, type: "text", required: true, options: [], placeholder: "" },
        { key: "server_id", label: { id: "Server ID", en: "Server ID" }, type: "text", required: false, options: [], placeholder: "" },
      ]),
    };
    // The pre-fix nicknameCheck.ts shape — none of these keys match the
    // SKU's actual additionalFields ("user_id"/"server_id"), so every value
    // filters out of buildDigiflazzCustomerNo's field.map(f => unit[f.key]).
    const legacyUnit = JSON.stringify([{ target: "GAMER-999888777", server: "SRV-42" }]);
    expect(buildDigiflazzCustomerNo(product, legacyUnit)).toBe("GAMER-999888777 SRV-42");
  });
});

describe("resolveSingleDigiflazzItem", () => {
  function line(overrides: {
    quantity?: number;
    supplierSku?: string | null;
    autoDeliverySource?: string | null;
    additionalFields?: string | null;
  } = {}) {
    return {
      quantity: overrides.quantity ?? 1,
      product: {
        supplierSku: "supplierSku" in overrides ? overrides.supplierSku! : "ml100",
        additionalFields: overrides.additionalFields ?? null,
        autoDeliverySource: "autoDeliverySource" in overrides ? overrides.autoDeliverySource! : "digiflazz",
      },
    };
  }

  it("resolves ok:true for exactly one Digiflazz-routed item at quantity 1", () => {
    const result = resolveSingleDigiflazzItem({ items: [line()] });
    expect(result).toEqual({ ok: true, supplierSku: "ml100", product: { additionalFields: null } });
  });

  it("resolves ok:false when the order has no Digiflazz-routed item", () => {
    const result = resolveSingleDigiflazzItem({ items: [line({ autoDeliverySource: null })] });
    expect(result.ok).toBe(false);
  });

  it("resolves ok:false when the single Digiflazz item's quantity is more than 1", () => {
    const result = resolveSingleDigiflazzItem({ items: [line({ quantity: 2 })] });
    expect(result.ok).toBe(false);
  });

  it("resolves ok:false when the order has more than one Digiflazz-routed line", () => {
    const result = resolveSingleDigiflazzItem({ items: [line(), line({ supplierSku: "ff100" })] });
    expect(result.ok).toBe(false);
  });
});

describe("dispatchPendingDigiflazzOrders", () => {
  it("delivers a Sukses order and flips it to DELIVERED", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Sukses",
      sn: "SN-12345",
      message: "ok",
      price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 1, pending: 0, failed: 0 });

    const refreshed = await getOrder(prisma, order.id);
    expect(refreshed!.status).toBe(OrderStatus.DELIVERED);
    expect(refreshed!.deliveredContent).toBe("SN-12345");
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
  });

  // A Pending order's next recheck is scheduled a couple of minutes out
  // (see nextDigiflazzRecheckAt/DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES[0] in
  // digiflazzBackoff.ts), so calling the poller again immediately after
  // still finds nothing due — the claim query's recheck branch
  // (digiflazzNextRecheckAt <= now) doesn't match yet. This is no longer
  // "this order can NEVER be retried" (it will be, once due — see the
  // "recheck claim picks up a due Pending order on a later tick" test
  // below), only "not due for its first recheck yet".
  it("does not re-call Digiflazz on an immediate second tick — the recheck isn't due yet", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Pending", sn: null, message: null, price: null,
    });

    await dispatchPendingDigiflazzOrders(prisma);
    const second = await dispatchPendingDigiflazzOrders(prisma);

    expect(second).toEqual({ claimed: 0, delivered: 0, pending: 0, failed: 0 });
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("leaves a Pending order PROCESSING with the claim set", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Pending", sn: null, message: null, price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 1, failed: 0 });

    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.status).toBe(OrderStatus.PROCESSING);
    expect(refreshed!.digiflazzDispatchedAt).not.toBeNull();
    expect(refreshed!.digiflazzStatus).toBe("pending_at_supplier");
    expect(refreshed!.digiflazzAttempts).toBe(1);
    expect(refreshed!.digiflazzNextRecheckAt).not.toBeNull();
    // ~2 minutes ahead per DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES[0] (digiflazzBackoff.ts)
    const deltaMs = refreshed!.digiflazzNextRecheckAt!.getTime() - refreshed!.digiflazzDispatchedAt!.getTime();
    expect(deltaMs).toBeGreaterThan(60_000);
    expect(deltaMs).toBeLessThanOrEqual(3 * 60_000);
  });

  it("alerts admins and leaves PROCESSING on Gagal, without fulfilling", async () => {
    // enqueueManualOrderAdminAlert fans out over resolveAdminIds, which is
    // empty unless a shop admin is configured (env ADMIN_IDS or the DB
    // setting) — give it one, same as bybit_deposit.test.ts's admin-alert
    // assertions.
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Gagal", sn: null, message: "Saldo tidak cukup", price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });

    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.status).toBe(OrderStatus.PROCESSING);
    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull();
    expect(refreshed!.digiflazzStatus).toBe("failed");
    expect(refreshed!.digiflazzNextRecheckAt).toBeNull();
    expect(refreshed!.digiflazzFailureDetail).toContain("Saldo tidak cukup");
  });

  it("is a no-op when Digiflazz isn't configured", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
    await makeProcessingDigiflazzOrder();
    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 0, delivered: 0, pending: 0, failed: 0 });
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();
  });

  // I6 regression (final-review batch 1): the candidate query is a
  // `some`-filter — it never guaranteed the Digiflazz-routed item is
  // order.items[0]. Build an order whose Digiflazz line is SECOND (a plain,
  // non-Digiflazz auto line is added to the cart first) and confirm the
  // poller still finds and dispatches the right one.
  it("dispatches correctly when the Digiflazz item is not order.items[0]", async () => {
    // Decoy line — sample.product, untouched (still plain AUTO, no
    // autoDeliverySource) — added to the cart FIRST.
    await addToCart(prisma, sample.user.id, sample.product.id, 1);

    // The actual Digiflazz-routed denomination — a separate product, added
    // to the cart SECOND.
    const category = await prisma.category.findFirstOrThrow();
    const digiProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "Mobile Legends" });
    const digiDenom = await createDenomination(prisma, {
      productId: digiProduct.id,
      name: "100 Diamond",
      type: "SHARED",
      durationLabel: "",
      price: "16500",
      autoDeliverySource: "digiflazz",
      supplierSku: "ml100",
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      ]),
    });
    await addToCart(prisma, sample.user.id, digiDenom.id, 1);

    const order = (await createOrderFromCart(prisma, {
     channel: "bot",
      user: sample.user,
      customerData: JSON.stringify([{ user_id: "987654321" }]),
    }))!;
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });

    // Confirm the fixture actually reproduces "Digiflazz item is not
    // items[0]" before trusting the dispatch result below — otherwise this
    // test would pass for the wrong reason if cart ordering ever changes.
    const beforeDispatch = await getOrder(prisma, order.id);
    expect(beforeDispatch!.items[0]!.productId).toBe(sample.product.id);
    expect(beforeDispatch!.items[1]!.productId).toBe(digiDenom.id);

    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Sukses", sn: "SN-I6", message: "ok", price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 1, pending: 0, failed: 0 });
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
    expect(digiflazzMock.createTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ buyerSkuCode: "ml100" }),
    );

    const refreshed = await getOrder(prisma, order.id);
    expect(refreshed!.status).toBe(OrderStatus.DELIVERED);
    expect(refreshed!.deliveredContent).toBe("SN-I6");
  });

  // N1 defense-in-depth (final-review batch 1): the front-door cart guards
  // (POST /cart, POST /cart/update) close off the normal way to reach this,
  // but the poller must ALSO refuse a Digiflazz item whose quantity isn't 1
  // — e.g. a pre-existing PROCESSING order from before those guards shipped,
  // or an admin hand-editing an OrderItem row.
  it("refuses to dispatch (alerts, never calls Digiflazz) when the Digiflazz item's quantity is not 1", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const order = await makeProcessingDigiflazzOrder();
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { quantity: 2 } });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();

    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.status).toBe(OrderStatus.PROCESSING);
    // The atomic claim still commits — this is a "needs a human" outcome,
    // not a retry-later one, same as every other alertDigiflazzDispatchFailed
    // branch in this function.
    expect(refreshed!.digiflazzDispatchedAt).not.toBeNull();
    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull();
  });

  // Same invariant, the OTHER shape it can take: not one row with quantity
  // > 1, but more than one Digiflazz-routed row in the same order (what the
  // storefront's per-unit OrderItem creation would produce for a qty>1 cart
  // line, before the front-door guards existed). Also refused, never
  // partially dispatched.
  it("refuses to dispatch when an order has more than one Digiflazz-routed line", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const fields = JSON.stringify([
      { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ]);
    await prisma.denomination.update({
      where: { id: sample.product.id },
      data: {
        autoDeliverySource: "digiflazz",
        supplierSku: "ml100",
        deliveryType: DeliveryType.MANUAL_WITH_INFO,
        additionalFields: fields,
      },
    });
    const category = await prisma.category.findFirstOrThrow();
    const product2 = await createCatalogProduct(prisma, { categoryId: category.id, name: "Free Fire" });
    const digiDenom2 = await createDenomination(prisma, {
      productId: product2.id,
      name: "100 Diamond",
      type: "SHARED",
      durationLabel: "",
      price: "10000",
      autoDeliverySource: "digiflazz",
      supplierSku: "ff100",
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: fields,
    });
    const order = (await createOrderDirect(prisma, {
      channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1,
      customerData: JSON.stringify([{ user_id: "111" }]),
    }))!;
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const { id: _id, ...itemData } = item;
    await prisma.orderItem.create({ data: { ...itemData, productId: digiDenom2.id } });
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();
    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull();
  });

  // Task 5 (realtime Digiflazz status): the recheck half of the OR-query and
  // atomic claim added alongside recordDigiflazzOutcome.
  it("recheck claim picks up a due Pending order on a later tick", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Pending", sn: null, message: null, price: null,
    });
    await dispatchPendingDigiflazzOrders(prisma);
    const afterFirst = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterFirst.digiflazzStatus).toBe("pending_at_supplier");

    // Simulate time having passed: back-date the scheduled recheck into the
    // past so the next tick's OR-query/claim picks this order up again.
    await prisma.order.update({
      where: { id: order.id },
      data: { digiflazzNextRecheckAt: new Date(Date.now() - 5_000) },
    });
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Sukses", sn: "SN-RECHECK", message: "ok", price: null,
    });

    const second = await dispatchPendingDigiflazzOrders(prisma);

    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(2);
    expect(second).toEqual({ claimed: 1, delivered: 1, pending: 0, failed: 0 });
    const refreshed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(refreshed.status).toBe(OrderStatus.DELIVERED);
  });

  it("marks failed after the backoff window is exhausted while still Pending", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const order = await makeProcessingDigiflazzOrder();
    // Simulate a long-running retry sequence: first dispatch was 25h ago (past
    // the 24h window), 20 attempts already made (past the front-loaded
    // schedule), and a recheck that's due now.
    await prisma.order.update({
      where: { id: order.id },
      data: {
        digiflazzDispatchedAt: new Date(Date.now() - 25 * 3_600_000),
        digiflazzAttempts: 20,
        digiflazzStatus: "pending_at_supplier",
        digiflazzNextRecheckAt: new Date(Date.now() - 60_000),
      },
    });
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Pending", sn: null, message: null, price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);

    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });
    const refreshed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(refreshed.digiflazzStatus).toBe("failed");
    expect(refreshed.digiflazzNextRecheckAt).toBeNull();
    expect(refreshed.digiflazzFailureDetail).toBeTruthy();
    expect(refreshed.digiflazzFailureDetail).toMatch(/24h|never resolved/i);
    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull();
  });

  it("transient HTTP error is retried on the same schedule, not immediately terminal", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockRejectedValue(new Error("network blip"));

    const summary = await dispatchPendingDigiflazzOrders(prisma);

    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 1, failed: 0 });
    const refreshed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(refreshed.digiflazzStatus).toBe("pending_at_supplier");
    expect(refreshed.digiflazzAttempts).toBe(1);
    expect(refreshed.digiflazzNextRecheckAt).not.toBeNull();
    const deltaMs = refreshed.digiflazzNextRecheckAt!.getTime() - refreshed.digiflazzDispatchedAt!.getTime();
    expect(deltaMs).toBeGreaterThan(60_000);
    expect(deltaMs).toBeLessThanOrEqual(3 * 60_000);
    expect(refreshed.digiflazzFailureDetail).toContain("network blip");
  });

  it("explicit Gagal is terminal immediately regardless of attempt count", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const order = await makeProcessingDigiflazzOrder();
    // Already mid-backoff: a third recheck is due now.
    await prisma.order.update({
      where: { id: order.id },
      data: {
        digiflazzDispatchedAt: new Date(Date.now() - 20 * 60_000),
        digiflazzAttempts: 3,
        digiflazzStatus: "pending_at_supplier",
        digiflazzNextRecheckAt: new Date(Date.now() - 60_000),
      },
    });
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Gagal", sn: null, message: "Saldo tidak cukup", price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);

    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });
    const refreshed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(refreshed.digiflazzStatus).toBe("failed");
    expect(refreshed.digiflazzNextRecheckAt).toBeNull();
  });

  // Fix-pass regression guard (Critical #1): the recheck claim used to write
  // digiflazzNextRecheckAt: null, which permanently orphans an order if the
  // process crashes between the claim committing and recordDigiflazzOutcome
  // running (neither candidate-query arm would ever match a bare null — see
  // this file's module doc comment). The fix writes a future LEASE instead.
  // This test constructs that exact post-claim lease state directly (rather
  // than relying on the "recheck claim picks up a due Pending order on a
  // later tick" test above, which already covers "any due order gets
  // re-picked-up" but never specifically proves the self-heal depends on
  // lease EXPIRY) and confirms: not claimed while the lease is still in the
  // future, then claimed once the lease has passed.
  it("a crashed recheck claim self-heals only after its lease expires, not before", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Pending", sn: null, message: null, price: null,
    });
    await dispatchPendingDigiflazzOrders(prisma);
    await prisma.order.update({
      where: { id: order.id },
      data: { digiflazzNextRecheckAt: new Date(Date.now() - 5_000) }, // due for a recheck
    });

    // Inspect the ACTUAL recheck claim's write (not a hand-simulated one):
    // createTransaction is only ever called AFTER the recheck claim has
    // already committed, so peeking at the row from inside this mock
    // observes exactly the intermediate state a process crash between the
    // claim and recordDigiflazzOutcome would leave behind. Before the C-1
    // fix this was `null` (permanently unclaimable — neither candidate-query
    // arm ever matches null); after the fix it must be a future lease.
    // NOTE: any `expect()` thrown from inside this mock would be swallowed
    // by dispatchPendingDigiflazzOrders' own try/catch (it treats a thrown
    // createTransaction as a transient HTTP error) instead of failing the
    // test, so capture the observed value and assert on it AFTER the call
    // returns instead of asserting inside the mock.
    let midFlightNextRecheckAt: Date | null | undefined;
    digiflazzMock.createTransaction.mockImplementation(async (_creds: unknown, args: { refId: string }) => {
      const midFlight = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      midFlightNextRecheckAt = midFlight.digiflazzNextRecheckAt;
      return { refId: args.refId, status: "Pending", sn: null, message: null, price: null };
    });
    await dispatchPendingDigiflazzOrders(prisma);
    expect(midFlightNextRecheckAt).not.toBeNull();
    expect(midFlightNextRecheckAt!.getTime()).toBeGreaterThan(Date.now());
    expect(midFlightNextRecheckAt!.getTime()).toBeLessThanOrEqual(Date.now() + DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS);

    // Now exercise the self-heal timing itself: overwrite whatever real
    // backoff value recordDigiflazzOutcome just wrote with a lease-shaped
    // value that is STILL in the future (simulating "claimed, then crashed
    // right after") and confirm it is NOT re-claimed yet — proving the
    // self-heal genuinely depends on lease expiry, not just "any due order
    // gets picked up" (which the "recheck claim picks up a due Pending
    // order on a later tick" test above already covers).
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Sukses", sn: "SN-SELF-HEAL", message: "ok", price: null,
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { digiflazzNextRecheckAt: new Date(Date.now() + DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS) },
    });
    const whileLeased = await dispatchPendingDigiflazzOrders(prisma);
    expect(whileLeased).toEqual({ claimed: 0, delivered: 0, pending: 0, failed: 0 });

    // Advance the lease into the past — simulating it having expired after
    // the crashed attempt — and confirm the order self-heals: it's
    // re-claimed and dispatched again.
    await prisma.order.update({
      where: { id: order.id },
      data: { digiflazzNextRecheckAt: new Date(Date.now() - 1_000) },
    });
    const afterExpiry = await dispatchPendingDigiflazzOrders(prisma);
    expect(afterExpiry).toEqual({ claimed: 1, delivered: 1, pending: 0, failed: 0 });
    const refreshed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(refreshed.status).toBe(OrderStatus.DELIVERED);
  });

  // Fix-pass regression guard (Critical #2): fulfillDigiflazzOrder used to be
  // called inside the SAME try/catch as createTransaction, so a failure AFTER
  // its own PROCESSING->DELIVERED claim committed (e.g. a side effect like
  // enqueueManualDeliveredDm throwing) was miscategorized as a retryable
  // transient error — no admin alert, and a scheduled "retry" that could
  // never fire because the order no longer matches the PROCESSING candidate
  // query. Mock enqueueManualDeliveredDm (called INSIDE fulfillDigiflazzOrder
  // after the DELIVERED claim and finalizeDeliverySideEffects have already
  // run) to reject once, reproducing exactly that shape.
  it("a failure inside fulfillDigiflazzOrder after Sukses alerts admins instead of being silently retried", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const order = await makeProcessingDigiflazzOrder();

    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Sukses", sn: "SN-POST-FAIL", message: "ok", price: null,
    });
    notificationsMock.enqueueManualDeliveredDm.mockRejectedValueOnce(new Error("outbox write failed"));

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });

    const refreshed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    // The claim inside fulfillDigiflazzOrder still committed — that part
    // didn't fail; only the later side effect did.
    expect(refreshed.status).toBe(OrderStatus.DELIVERED);
    expect(decryptDeliveredContent(refreshed.deliveredContent, order.id)).toBe("SN-POST-FAIL");
    // Final whole-branch review I-1 fix: fulfillDigiflazzOrder's own
    // PROCESSING->DELIVERED claim now unconditionally clears digiflazzStatus/
    // digiflazzNextRecheckAt/digiflazzFailureDetail as part of that SAME
    // atomic update — the order genuinely delivered (the claim committed
    // before the later enqueueManualDeliveredDm side effect threw), so it's
    // no longer "in flight at the supplier" regardless of that later
    // failure. digiflazzAttempts staying at its untouched default (0) is
    // what actually proves recordDigiflazzOutcome's transient_error branch
    // never ran — that branch would have bumped attempts to 1, and
    // terminalFailDigiflazzOrder would have set digiflazzStatus to "failed"
    // instead of null — neither happened.
    expect(refreshed.digiflazzStatus).toBeNull();
    expect(refreshed.digiflazzAttempts).toBe(0);
    expect(refreshed.digiflazzNextRecheckAt).toBeNull();
    // The admin alert fired — this is what proves the failure is treated as
    // terminal-needs-a-human, not a silently-retried transient error.
    // Deferred finding #5 fix: filter by the specific event this alert path
    // enqueues (alertDigiflazzDispatchFailed -> enqueueManualOrderAdminAlert
    // -> NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED, see notifications.ts)
    // rather than matching ANY row for this orderId — an unfiltered query
    // only passed today because PUBLIC_CHANNEL_ID is unset in the test
    // environment, which happens to suppress the unrelated ORDER_DELIVERED
    // testimonial-post notification finalizeDeliverySideEffects also
    // enqueues for the same delivered order.
    const alertRow = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED },
    });
    expect(alertRow).not.toBeNull();
    // Deferred finding #3 fix (describeFulfillFailure): the natural-language
    // `reason` this alert path builds only lands in the AuditLog's `details`
    // (enqueueManualOrderAdminAlert's own payload never carries it — see
    // alertDigiflazzDispatchFailed) — assert it never leaks a raw
    // ValidationError i18n key like "error.order_not_processing". A cheap,
    // general substring guard, regardless of which ValidationError (if any)
    // actually fired.
    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "order.digiflazz_dispatch_failed", targetId: order.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.details).not.toContain("error.");
  });
});

describe("fulfillDigiflazzOrder", () => {
  it("delivers, records history, and audits as a system actor", async () => {
    const order = await makeProcessingDigiflazzOrder();
    const { order: delivered } = await fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-999" });
    expect(delivered.status).toBe(OrderStatus.DELIVERED);
    expect(delivered.deliveredContent).toBe("SN-999");
    // The serial number is stored encrypted at rest, never as plaintext.
    const raw = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(isEncryptedCredentialEnvelope(raw.deliveredContent!)).toBe(true);
    expect(raw.deliveredContent).not.toContain("SN-999");

    const history = await prisma.orderStatusHistory.findFirst({
      where: { orderId: order.id, status: OrderStatus.DELIVERED },
    });
    expect(history).not.toBeNull();

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "order.auto_fulfill_digiflazz", targetId: order.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.adminId).toBeNull();
  });

  // Final whole-branch review I-1 (+ deferred #1/#2): the atomic
  // PROCESSING->DELIVERED claim must clear digiflazzStatus/
  // digiflazzNextRecheckAt/digiflazzFailureDetail — without this, every
  // successfully auto-delivered order kept showing a stale
  // "pending_at_supplier" badge forever (the schema's own "null once
  // terminal" doc comment on digiflazzStatus, violated). Dispatch to
  // pending_at_supplier first (same Pending-dispatch setup as the "leaves a
  // Pending order PROCESSING with the claim set" test above), then call
  // fulfillDigiflazzOrder directly with a Sukses-equivalent sn.
  it("clears digiflazzStatus/digiflazzNextRecheckAt/digiflazzFailureDetail on delivery", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Pending", sn: null, message: null, price: null,
    });
    await dispatchPendingDigiflazzOrders(prisma);
    const pending = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(pending.digiflazzStatus).toBe("pending_at_supplier");
    expect(pending.digiflazzNextRecheckAt).not.toBeNull();

    await fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-CLEARED" });

    const refreshed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(refreshed.status).toBe(OrderStatus.DELIVERED);
    expect(refreshed.digiflazzStatus).toBeNull();
    expect(refreshed.digiflazzNextRecheckAt).toBeNull();
    expect(refreshed.digiflazzFailureDetail).toBeNull();
    // digiflazzAttempts/digiflazzDispatchedAt are historical facts, not
    // in-flight state — left untouched by the fix.
    expect(refreshed.digiflazzAttempts).toBe(1);
    expect(refreshed.digiflazzDispatchedAt).not.toBeNull();
  });

  it("rejects a second claim on an already-delivered order", async () => {
    const order = await makeProcessingDigiflazzOrder();
    await fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-1" });
    await expect(fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-2" })).rejects.toThrow();
  });

  // I-4 fix (backend audit 2026-08-21): fulfillDigiflazzOrder must refuse to
  // deliver an order whose item isn't actually Digiflazz-routed, regardless
  // of caller — sample.product here is a plain denomination (no
  // autoDeliverySource set), so this order never should have reached this
  // function in the first place.
  it("throws and leaves the order untouched when the order's item isn't Digiflazz-routed", async () => {
    const order = (await createOrderDirect(prisma, {
     channel: "bot",
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
    }))!;
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });

    await expect(fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-1" })).rejects.toThrow();

    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.status).toBe(OrderStatus.PROCESSING);
    expect(refreshed!.deliveredContent).toBeNull();
  });
});

function priceListItem(overrides: Partial<DigiflazzPriceListItem> = {}): DigiflazzPriceListItem {
  return {
    buyerSkuCode: "ml100",
    productName: "Mobile Legends 100 Diamond",
    category: "Game",
    brand: "Mobile Legends",
    type: "Umum",
    price: new Decimal(15000),
    buyerProductStatus: true,
    sellerProductStatus: true,
    stock: null,
    ...overrides,
  };
}

describe.each([false, true])("fulfillDigiflazzOrder with CREDENTIAL_ENVELOPE_WRITE_V2 %s (Fase 6d)", (on) => {
  useEnvelopeWriteV2(on);

  it("stores the serial number in the flag's envelope version, bound to the order", async () => {
    const order = await makeProcessingDigiflazzOrder();
    const { order: delivered } = await fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-6D" });
    expect(delivered.deliveredContent).toBe("SN-6D");
    const raw = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).deliveredContent!;
    expect(credentialEnvelopeVersion(raw)).toBe(on ? 2 : 1);
    expect(decryptDeliveredContent(raw, order.id)).toBe("SN-6D");
  });
});

describe("collapseToCheapestSeller", () => {
  it("keeps only the lowest-price row when the same buyerSkuCode appears from multiple sellers", () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(16000) }),
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15500) }),
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15800) }),
      priceListItem({ buyerSkuCode: "ml250", price: new Decimal(41000) }),
    ];
    const collapsed = collapseToCheapestSeller(items);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.find((i) => i.buyerSkuCode === "ml100")!.price.toString()).toBe("15500");
  });

  it("is a no-op when every buyerSkuCode is already unique", () => {
    const items = [priceListItem({ buyerSkuCode: "ml100" }), priceListItem({ buyerSkuCode: "ml250" })];
    expect(collapseToCheapestSeller(items)).toHaveLength(2);
  });
});

describe("groupDigiflazzPriceListByBrand", () => {
  it("groups items by brand and flags brands with no existing Product as new", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends" }),
      priceListItem({ buyerSkuCode: "ml250", brand: "Mobile Legends", productName: "Mobile Legends 250 Diamond" }),
      priceListItem({ buyerSkuCode: "ff100", brand: "Free Fire", productName: "Free Fire 100 Diamond" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(2);
    const ml = groups.find((g) => g.brand === "Mobile Legends")!;
    expect(ml.items).toHaveLength(2);
    expect(ml.existingProductId).toBeNull();
  });

  it("collapses a multi-seller SKU to its cheapest offer before grouping, so it never produces two lookalike rows", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends", price: new Decimal(16000) }),
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends", price: new Decimal(15500) }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(1);
    expect(groups[0]!.items[0]!.price.toString()).toBe("15500");
  });

  it("separates region variants that Digiflazz reports as distinct brand strings", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends" }),
      priceListItem({ buyerSkuCode: "mlglobal100", brand: "Mobile Legends (Region Lain)" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups.map((g) => g.brand).sort()).toEqual(["Mobile Legends", "Mobile Legends (Region Lain)"]);
  });

  it("flags a brand already imported via digiflazzBrand as existing", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const product = await prisma.product.create({
      data: { categoryId: category.id, name: "Mobile Legends", slug: "mobile-legends-x", digiflazzBrand: "Mobile Legends" },
    });
    const groups = await groupDigiflazzPriceListByBrand(prisma, [priceListItem({ brand: "Mobile Legends" })]);
    expect(groups[0]!.existingProductId).toBe(product.id);
  });

  // Region-suffix splitting (task 2): Digiflazz encodes a SKU's region as a
  // trailing "(Region)" parenthetical on productName, not as a distinct
  // brand string — a raw brand with a mix of region-suffixed and
  // non-suffixed rows must split into separate groups, one per
  // digiflazzGroupKey displayName.
  it("splits a raw brand's rows into separate groups by region suffix parsed from productName", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends", productName: "Mobile Legends 100 Diamond" }),
      priceListItem({
        buyerSkuCode: "ml100id",
        brand: "Mobile Legends",
        productName: "Mobile Legends 100 Diamond (Indonesia)",
      }),
      priceListItem({
        buyerSkuCode: "ml100ph",
        brand: "Mobile Legends",
        productName: "Mobile Legends 100 Diamond (Filipina)",
      }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(3);

    const plain = groups.find((g) => g.brand === "Mobile Legends")!;
    expect(plain.items).toHaveLength(1);
    expect(plain.rawBrand).toBe("Mobile Legends");
    expect(plain.region).toBeNull();

    const indonesia = groups.find((g) => g.brand === "Mobile Legends (Indonesia)")!;
    expect(indonesia.items).toHaveLength(1);
    expect(indonesia.rawBrand).toBe("Mobile Legends");
    expect(indonesia.region).toBe("Indonesia");

    const filipina = groups.find((g) => g.brand === "Mobile Legends (Filipina)")!;
    expect(filipina.items).toHaveLength(1);
    expect(filipina.region).toBe("Filipina");
  });

  // Regression guard: a trailing parenthetical that's on parseProductRegion's
  // denylist (e.g. "(Instant)") must NOT be treated as a region — every row
  // stays in one group keyed by the plain brand.
  it("keeps a single group keyed by the plain brand when every row's trailing paren is denylisted", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "pulsa10", brand: "Pulsa Telkomsel", productName: "Pulsa Telkomsel 10.000 (Instant)" }),
      priceListItem({ buyerSkuCode: "pulsa25", brand: "Pulsa Telkomsel", productName: "Pulsa Telkomsel 25.000 (Instant)" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.brand).toBe("Pulsa Telkomsel");
    expect(groups[0]!.region).toBeNull();
    expect(groups[0]!.items).toHaveLength(2);
  });

  it("matches an existing Product against a composite region key, not just the raw brand", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const product = await prisma.product.create({
      data: {
        categoryId: category.id,
        name: "Mobile Legends (Indonesia)",
        slug: "mobile-legends-indonesia",
        digiflazzBrand: "Mobile Legends (Indonesia)",
      },
    });
    const items = [
      priceListItem({
        buyerSkuCode: "ml100id",
        brand: "Mobile Legends",
        productName: "Mobile Legends 100 Diamond (Indonesia)",
      }),
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends", productName: "Mobile Legends 100 Diamond" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    const indonesia = groups.find((g) => g.brand === "Mobile Legends (Indonesia)")!;
    expect(indonesia.existingProductId).toBe(product.id);
    const plain = groups.find((g) => g.brand === "Mobile Legends")!;
    expect(plain.existingProductId).toBeNull();
  });

  // Task 10 (shadow mode): every group additionally carries a `detection`
  // field — the DetectionResult for its items[0]. It never influences
  // brand/region/existingProductId (every assertion above still holds
  // unchanged); this only checks the new field is populated and well-shaped.
  it("Task 10: attaches a shadow-mode detection result to every group", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends" }),
      priceListItem({ buyerSkuCode: "ff100", brand: "Free Fire", productName: "Free Fire 100 Diamond" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.detection).toBeDefined();
      expect(["resolved", "ambiguous", "unknown"]).toContain(group.detection!.status);
      expect(typeof group.detection!.detectorVersion).toBe("string");
      expect(group.detection!.detectorVersion.length).toBeGreaterThan(0);
    }
  });
});

describe("groupDigiflazzPriceListByBrand — type-split by Digiflazz `type` (Task 21)", () => {
  // 1 — the split itself
  it("splits one brand into a base group and a variant group when it reports >= 2 distinct types", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ab-umum-3200", brand: "Arena Breakout", type: "Umum", productName: "Arena Breakout 3.200 Bonds" }),
      priceListItem({ buyerSkuCode: "ab-umum-6400", brand: "Arena Breakout", type: "Umum", productName: "Arena Breakout 6.400 Bonds" }),
      priceListItem({ buyerSkuCode: "ab-inf-1000", brand: "Arena Breakout", type: "Infinite", productName: "Arena Breakout Infinite 1.000 Bonds" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(2);

    const base = groups.find((g) => g.brand === "Arena Breakout")!;
    expect(base.gameVariant).toBe("Umum");
    expect(base.rawBrand).toBe("Arena Breakout");
    expect(base.items).toHaveLength(2);

    const infinite = groups.find((g) => g.brand === "Arena Breakout Infinite")!;
    expect(infinite.gameVariant).toBe("Infinite");
    expect(infinite.rawBrand).toBe("Arena Breakout");
    expect(infinite.items).toHaveLength(1);
  });

  // 2 — non-regression #1: no type variation
  it("non-regression #1: a brand with no type variation stays one group, gameVariant null", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends" }),
      priceListItem({ buyerSkuCode: "ml250", brand: "Mobile Legends", productName: "Mobile Legends 250 Diamond" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.brand).toBe("Mobile Legends");
    expect(groups[0]!.brand).toBe(groups[0]!.rawBrand);
    expect(groups[0]!.gameVariant).toBeNull();
  });

  // 3 — non-regression #2 (most important): 100% one non-"Umum" type
  it('non-regression #2: a brand that is 100% one non-"Umum" type stays one group under the plain brand name, gameVariant null', async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ab-inf-1000", brand: "Arena Breakout", type: "Infinite", productName: "Arena Breakout Infinite 1.000 Bonds" }),
      priceListItem({ buyerSkuCode: "ab-inf-2000", brand: "Arena Breakout", type: "Infinite", productName: "Arena Breakout Infinite 2.000 Bonds" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.brand).toBe("Arena Breakout");
    expect(groups[0]!.gameVariant).toBeNull();
    expect(groups[0]!.items).toHaveLength(2);
  });

  // 4 — base-type casing tolerance
  it("treats UMUM / ' umum ' / null type as the base subset (case + whitespace tolerant) when splitting", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ab-a", brand: "Arena Breakout", type: "UMUM", productName: "Arena Breakout 3.200 Bonds" }),
      priceListItem({ buyerSkuCode: "ab-b", brand: "Arena Breakout", type: " umum ", productName: "Arena Breakout 6.400 Bonds" }),
      priceListItem({ buyerSkuCode: "ab-c", brand: "Arena Breakout", type: null, productName: "Arena Breakout 12.800 Bonds" }),
      priceListItem({ buyerSkuCode: "ab-inf", brand: "Arena Breakout", type: "Infinite", productName: "Arena Breakout Infinite 1.000 Bonds" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(2);
    const base = groups.find((g) => g.brand === "Arena Breakout")!;
    expect(base.gameVariant).toBe("Umum");
    expect(base.items).toHaveLength(3);
    const infinite = groups.find((g) => g.brand === "Arena Breakout Infinite")!;
    expect(infinite.items).toHaveLength(1);
  });

  // 5 — region x type dedupe
  it("region x type dedupe: when the type suffix repeats the (Region) paren, uses the suffix once and drops the region", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ff-umum-100", brand: "Free Fire", type: "Umum", productName: "Free Fire 100 Diamond" }),
      priceListItem({ buyerSkuCode: "ff-global-100", brand: "Free Fire", type: "Global", productName: "Free Fire 100 Diamond (Global)" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(2);
    const global = groups.find((g) => g.gameVariant === "Global")!;
    expect(global.brand).toBe("Free Fire Global");
    expect(global.region).toBeNull();
    const base = groups.find((g) => g.gameVariant === "Umum")!;
    expect(base.brand).toBe("Free Fire");
  });

  // 6 — region x type, non-overlapping
  it("region x type non-overlapping: a genuine region paren is kept alongside the type suffix", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ff-umum-100", brand: "Free Fire", type: "Umum", productName: "Free Fire 100 Diamond" }),
      priceListItem({ buyerSkuCode: "ff-global-id-100", brand: "Free Fire", type: "Global", productName: "Free Fire 100 Diamond (Indonesia)" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    const global = groups.find((g) => g.gameVariant === "Global")!;
    expect(global.brand).toBe("Free Fire Global (Indonesia)");
    expect(global.region).toBe("Indonesia");
    expect(global.gameVariant).toBe("Global");
  });

  // 7 — existing-Product match after split
  it("computes existingProductId against the post-split displayName set", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const infiniteProduct = await prisma.product.create({
      data: {
        categoryId: category.id,
        name: "Arena Breakout Infinite",
        slug: "arena-breakout-infinite",
        digiflazzBrand: "Arena Breakout Infinite",
      },
    });
    const items = [
      priceListItem({ buyerSkuCode: "ab-umum-3200", brand: "Arena Breakout", type: "Umum", productName: "Arena Breakout 3.200 Bonds" }),
      priceListItem({ buyerSkuCode: "ab-inf-1000", brand: "Arena Breakout", type: "Infinite", productName: "Arena Breakout Infinite 1.000 Bonds" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    const infinite = groups.find((g) => g.brand === "Arena Breakout Infinite")!;
    expect(infinite.existingProductId).toBe(infiniteProduct.id);
    const base = groups.find((g) => g.brand === "Arena Breakout")!;
    expect(base.existingProductId).toBeNull();
  });

  // 8 — deterministic order
  it("emits groups in a deterministic order across repeated runs over the same input", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ab-umum-3200", brand: "Arena Breakout", type: "Umum", productName: "Arena Breakout 3.200 Bonds" }),
      priceListItem({ buyerSkuCode: "ab-inf-1000", brand: "Arena Breakout", type: "Infinite", productName: "Arena Breakout Infinite 1.000 Bonds" }),
      priceListItem({ buyerSkuCode: "ab-gar-1000", brand: "Arena Breakout", type: "Garena", productName: "Arena Breakout Garena 1.000 Bonds" }),
    ];
    const first = await groupDigiflazzPriceListByBrand(prisma, items);
    const second = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(first.map((g) => g.brand)).toEqual(second.map((g) => g.brand));
    // base first, then the non-null suffixes ascending by `<`
    expect(first.map((g) => g.brand)).toEqual([
      "Arena Breakout",
      "Arena Breakout Garena",
      "Arena Breakout Infinite",
    ]);
  });
});

describe("importDigiflazzBrand — gameVariant seeding (Task 21)", () => {
  // 9 — with gameVariant
  it("writes gameVariant onto the Product it creates when the arg is passed", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Arena Breakout Infinite",
      categoryId: category.id,
      gameVariant: "Infinite",
      rows: [{ buyerSkuCode: "ab-inf-1000", productName: "Arena Breakout Infinite 1.000 Bonds", price: "16500", costPrice: "15000" }],
    });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.gameVariant).toBe("Infinite");
    expect(product.digiflazzBrand).toBe("Arena Breakout Infinite");
  });

  // 10 — without gameVariant
  it("leaves gameVariant null on the created Product when the arg is omitted", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends",
      categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.gameVariant).toBeNull();
  });

  // 11 — re-import never overwrites
  it("never overwrites an existing Product's admin-set gameVariant on re-import", async () => {
    const category = await prisma.category.findFirstOrThrow();
    await prisma.product.create({
      data: {
        categoryId: category.id,
        name: "X",
        slug: "x-existing",
        digiflazzBrand: "X",
        gameVariant: "AdminChose",
      },
    });
    await importDigiflazzBrand(prisma, {
      brand: "X",
      categoryId: category.id,
      gameVariant: "Infinite",
      rows: [{ buyerSkuCode: "x-100", productName: "X 100", price: "16500", costPrice: "15000" }],
    });
    const product = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: "X" } });
    expect(product.gameVariant).toBe("AdminChose");
  });

  // 12 — idempotency of group + import over a split price list
  it("is idempotent: grouping + importing the same split price list twice does not duplicate products or denominations", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const rawItems = [
      priceListItem({ buyerSkuCode: "ab-umum-3200", brand: "Arena Breakout", type: "Umum", productName: "Arena Breakout 3.200 Bonds", price: new Decimal(15000) }),
      priceListItem({ buyerSkuCode: "ab-inf-1000", brand: "Arena Breakout", type: "Infinite", productName: "Arena Breakout Infinite 1.000 Bonds", price: new Decimal(15000) }),
    ];
    const runOnce = async () => {
      const groups = await groupDigiflazzPriceListByBrand(prisma, rawItems);
      for (const g of groups) {
        await importDigiflazzBrand(prisma, {
          brand: g.brand,
          categoryId: category.id,
          gameVariant: g.gameVariant,
          rows: g.items.map((i) => ({
            buyerSkuCode: i.buyerSkuCode,
            productName: i.productName,
            price: i.price.toString(),
            costPrice: i.price.toString(),
          })),
        });
      }
    };
    await runOnce();
    await runOnce();

    const products = await prisma.product.findMany({
      where: { digiflazzBrand: { in: ["Arena Breakout", "Arena Breakout Infinite"] } },
      include: { denominations: true },
    });
    expect(products).toHaveLength(2);
    for (const p of products) {
      expect(p.denominations).toHaveLength(1);
    }
  });
});

describe("computeDigiflazzMarkupPrice", () => {
  it("applies a percent markup", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    const price = await computeDigiflazzMarkupPrice(prisma, new Decimal(10000));
    expect(price.toString()).toBe("11000");
  });

  it("applies a flat markup", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "flat");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "1500");
    const price = await computeDigiflazzMarkupPrice(prisma, new Decimal(10000));
    expect(price.toString()).toBe("11500");
  });

  it("defaults to zero markup (equals cost) when unset", async () => {
    const price = await computeDigiflazzMarkupPrice(prisma, new Decimal(10000));
    expect(price.toString()).toBe("10000");
  });
});

describe("isDigiflazzPriceOverridden", () => {
  it("is false when the price matches the markup suggestion for the given cost", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    const overridden = await isDigiflazzPriceOverridden(prisma, new Decimal(11000), new Decimal(10000));
    expect(overridden).toBe(false);
  });

  it("is true when the price disagrees with the markup suggestion for the given cost", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    const overridden = await isDigiflazzPriceOverridden(prisma, new Decimal(12000), new Decimal(10000));
    expect(overridden).toBe(true);
  });

  // The safe default: with no cost to compare against, there's no way to
  // confirm the price matches a computed suggestion, so it's protected
  // rather than assumed to need no protecting.
  it("is true when costPrice is null, regardless of price", async () => {
    const overridden = await isDigiflazzPriceOverridden(prisma, new Decimal(12345), null);
    expect(overridden).toBe(true);
  });
});

describe("importDigiflazzBrand", () => {
  it("creates a Product with digiflazzBrand set and one Denomination per row", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const result = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends",
      categoryId: category.id,
      rows: [
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" },
        { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000", costPrice: "38000" },
      ],
    });
    expect(result.denominationCount).toBe(2);

    const product = await prisma.product.findUnique({ where: { id: result.productId }, include: { denominations: true } });
    expect(product!.digiflazzBrand).toBe("Mobile Legends");
    expect(product!.isActive).toBe(false); // imported inactive — review-before-live
    expect(product!.denominations).toHaveLength(2);
    const denom = product!.denominations.find((d) => d.supplierSku === "ml100")!;
    expect(denom.autoDeliverySource).toBe("digiflazz");
    expect(denom.supplierRawName).toBe("Mobile Legends 100 Diamond");
    expect(denom.deliveryType).toBe("manual_with_info");
    expect(JSON.parse(denom.additionalFields!)).toEqual([
      { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ]);
  });

  it("reuses the existing Product on a second import for the same brand rather than duplicating it", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const first = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    const second = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000", costPrice: "38000" }],
    });
    expect(second.productId).toBe(first.productId);
    const count = await prisma.product.count({ where: { digiflazzBrand: "Mobile Legends" } });
    expect(count).toBe(1);
  });

  // I4: re-running the import wizard on an already-imported SKU (e.g. an
  // admin re-syncs and re-imports the same brand because they missed a row
  // the first time) must UPDATE the existing denomination, not create a
  // second one sharing the same supplierSku.
  it("I4: re-importing the same brand+SKU updates the existing denomination instead of duplicating it", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const first = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    const firstDenom = await prisma.denomination.findFirstOrThrow({
      where: { productId: first.productId, supplierSku: "ml100" },
    });

    const second = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      // No parenthetical here (deliberately, unlike a region suffix) — this
      // test is about the update-in-place path, not stripRegionSuffix.
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond Updated", price: "17000", costPrice: "15500" }],
    });
    expect(second.denominationCount).toBe(1);

    const denoms = await prisma.denomination.findMany({ where: { productId: first.productId, supplierSku: "ml100" } });
    expect(denoms).toHaveLength(1); // still exactly one row, not two
    expect(denoms[0]!.id).toBe(firstDenom.id); // same row, updated in place
    expect(denoms[0]!.name).toBe("Mobile Legends 100 Diamond Updated");
    expect(denoms[0]!.supplierRawName).toBe("Mobile Legends 100 Diamond Updated");
    expect(denoms[0]!.price.toString()).toBe("17000");
    expect(denoms[0]!.costPrice!.toString()).toBe("15500");
  });

  // Task 6: the per-row existence-check findFirst was batched into one
  // findMany + Map lookup ahead of the loop. Confirms the batched lookup
  // still routes each row to the correct create/update path when a single
  // import call mixes brand-new SKUs with already-existing ones.
  it("Task 6: a single import mixing new and already-existing SKUs creates the new ones and updates the existing ones, not vice versa", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const first = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" },
        { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000", costPrice: "38000" },
      ],
    });
    const preexisting = await prisma.denomination.findMany({
      where: { productId: first.productId, supplierSku: { in: ["ml100", "ml250"] } },
    });
    const preexistingIds = new Map(preexisting.map((d) => [d.supplierSku, d.id]));

    const second = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [
        // Existing — must UPDATE in place, keeping the same row id.
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond Updated", price: "17000", costPrice: "15500" },
        { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond Updated", price: "42000", costPrice: "39000" },
        // Brand-new — must CREATE.
        { buyerSkuCode: "ml500", productName: "Mobile Legends 500 Diamond", price: "82000", costPrice: "76000" },
        { buyerSkuCode: "ml1000", productName: "Mobile Legends 1000 Diamond", price: "160000", costPrice: "148000" },
      ],
    });
    expect(second.denominationCount).toBe(4);
    expect(second.productId).toBe(first.productId);

    const denoms = await prisma.denomination.findMany({ where: { productId: first.productId } });
    expect(denoms).toHaveLength(4); // exactly 4 rows total — no duplicates from the "existing" SKUs

    const bySku = new Map(denoms.map((d) => [d.supplierSku, d]));
    // Updated in place — same row id as before, new name/price.
    expect(bySku.get("ml100")!.id).toBe(preexistingIds.get("ml100"));
    expect(bySku.get("ml100")!.name).toBe("Mobile Legends 100 Diamond Updated");
    expect(bySku.get("ml100")!.price.toString()).toBe("17000");
    expect(bySku.get("ml250")!.id).toBe(preexistingIds.get("ml250"));
    expect(bySku.get("ml250")!.name).toBe("Mobile Legends 250 Diamond Updated");
    expect(bySku.get("ml250")!.price.toString()).toBe("42000");
    // Newly created — fresh rows, not among the pre-existing ids.
    expect(bySku.has("ml500")).toBe(true);
    expect(preexistingIds.has("ml500")).toBe(false);
    expect(bySku.get("ml500")!.name).toBe("Mobile Legends 500 Diamond");
    expect(bySku.has("ml1000")).toBe(true);
    expect(bySku.get("ml1000")!.name).toBe("Mobile Legends 1000 Diamond");
  });

  // Regression fix (task review on the Task 6 batching change): the batched
  // existence-check Map is built once before the loop, from what existed in
  // the DB before this call started — it never sees rows created earlier in
  // the SAME loop iteration. Before batching, a duplicate buyerSkuCode
  // within one call's rows was create-then-update-in-place (each iteration
  // re-queried the DB and saw its own prior write), ending in exactly one
  // row with the LAST occurrence's data. De-duping args.rows by
  // buyerSkuCode before the loop (last occurrence wins) restores that
  // exact behavior.
  it("a single import with a duplicate buyerSkuCode in args.rows creates exactly one denomination, with the last occurrence's data", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const result = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond First", price: "16500", costPrice: "15000" },
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond Last", price: "17000", costPrice: "15500" },
      ],
    });
    expect(result.denominationCount).toBe(1); // deduped count, not the raw 2-row input

    const denoms = await prisma.denomination.findMany({
      where: { productId: result.productId, supplierSku: "ml100" },
    });
    expect(denoms).toHaveLength(1); // exactly one row, not two
    expect(denoms[0]!.name).toBe("Mobile Legends 100 Diamond Last"); // last occurrence's data wins
    expect(denoms[0]!.price.toString()).toBe("17000");
    expect(denoms[0]!.costPrice!.toString()).toBe("15500");
  });

  // I11: a freshly-imported denomination must have the correct costPrice
  // immediately — no resync needed to fill it in.
  it("I11: a freshly-imported denomination has costPrice set immediately, matching the submitted value", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    const denom = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    expect(denom.costPrice).not.toBeNull();
    expect(denom.costPrice!.toString()).toBe("15000");
  });

  // C2 (import side): the wizard lets an admin hand-edit a row's price
  // before submitting — that edit must be flagged priceOverridden so the
  // very first resync tick after import doesn't silently recompute it away.
  describe("C2: priceOverridden on import", () => {
    beforeEach(async () => {
      await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
      await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    });

    it("a row submitted at exactly the suggested markup price is NOT flagged overridden", async () => {
      const category = await prisma.category.findFirstOrThrow();
      const { productId } = await importDigiflazzBrand(prisma, {
        brand: "Mobile Legends", categoryId: category.id,
        rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }], // 15000 * 1.10 = 16500
      });
      const denom = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
      expect(denom.priceOverridden).toBe(false);
    });

    it("a row submitted with a hand-edited price different from the suggested markup IS flagged overridden", async () => {
      const category = await prisma.category.findFirstOrThrow();
      const { productId } = await importDigiflazzBrand(prisma, {
        brand: "Mobile Legends", categoryId: category.id,
        rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "18000", costPrice: "15000" }], // hand-edited above the 16500 suggestion
      });
      const denom = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
      expect(denom.priceOverridden).toBe(true);
    });
  });

  // Task 2: once grouping has split by region, the Product itself is already
  // region-scoped (args.brand arrives as the composite display name) — so
  // repeating the region suffix on every denomination name/durationLabel
  // would be redundant. supplierSku must stay exactly row.buyerSkuCode,
  // untouched by the strip.
  it("imports with a composite brand, stores the Product under the composite name, and strips the region suffix from denomination name/durationLabel", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends (Indonesia)",
      categoryId: category.id,
      rows: [
        { buyerSkuCode: "ml100id", productName: "Mobile Legends 100 Diamond (Indonesia)", price: "16500", costPrice: "15000" },
      ],
    });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.name).toBe("Mobile Legends (Indonesia)");
    expect(product.digiflazzBrand).toBe("Mobile Legends (Indonesia)");

    const denom = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100id" } });
    expect(denom.name).toBe("Mobile Legends 100 Diamond");
    expect(denom.durationLabel).toBe("Mobile Legends 100 Diamond");
    expect(denom.supplierRawName).toBe("Mobile Legends 100 Diamond (Indonesia)");
    expect(denom.supplierSku).toBe("ml100id"); // resync matching key — exact, untouched by the strip
  });

  // Task 10 (shadow mode): the created Product and denominations carry
  // non-null detection* columns after import. The just-created Product is
  // visible to getCatalogIndex(tx) within the same transaction, so it
  // self-matches by name and detection resolves. This is additive — none of
  // the brand/price/isActive/supplierSku assertions above change.
  it("Task 10: writes non-null detection columns onto the created Product and denominations", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends",
      categoryId: category.id,
      rows: [
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" },
        { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000", costPrice: "38000" },
      ],
    });
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
      include: { denominations: true },
    });
    expect(product.detectionStatus).toBe("resolved");
    expect(product.detectionProductKey).not.toBeNull();
    expect(product.detectionBaseProductKey).not.toBeNull();
    expect(product.detectionStamp).not.toBeNull();
    expect(product.detectionConfidence).not.toBeNull();
    // Decimal column (schema type Decimal?), not a JS float.
    expect(product.detectionConfidence!.toNumber()).toBeGreaterThan(0);

    expect(product.denominations).toHaveLength(2);
    for (const denom of product.denominations) {
      expect(denom.detectionSkuKey).not.toBeNull();
      expect(denom.detectionStamp).not.toBeNull();
      expect(denom.detectionSkuKey!.startsWith(product.detectionProductKey!)).toBe(true);
      expect(denom.detectionStamp).toBe(product.detectionStamp);
    }
    // Distinct denominations get distinct SKU keys (AC-04's differentiation).
    const skuKeys = new Set(product.denominations.map((d) => d.detectionSkuKey));
    expect(skuKeys.size).toBe(2);
  });
});

// Money audit C13: the markup setting was read with new Decimal(value), so a
// stored "10%" or "1,5" threw and aborted the whole hourly resync, and a
// negative value priced below cost.
describe("Digiflazz markup setting read safely", () => {
  it.each([
    [{ type: "percent", value: "10" }, "10"],
    [{ type: "percent", value: "12.345" }, "12.345"],
    [{ type: "percent", value: "1,5" }, "1.5"],
    [{ type: "flat", value: "1500" }, "1500"],
    [{ type: "flat", value: "1,500" }, "1500"],
    [{ type: null, value: null }, "0"],
    [{ type: "percent", value: "" }, "0"],
  ])("reads %j as %s", (settings, expected) => {
    expect(readDigiflazzMarkup(settings)?.toString()).toBe(expected);
  });

  it.each(["10%", "-5", "abc", "NaN", "Infinity", "1e3"])("refuses a stored %j", (value) => {
    expect(readDigiflazzMarkup({ type: "percent", value })).toBeNull();
    expect(() => applyDigiflazzMarkup(new Decimal(100), { type: "percent", value })).toThrow(InvalidDigiflazzMarkupError);
  });

  it("isDigiflazzPriceOverridden protects the price when the markup is unreadable", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10%");
    expect(await isDigiflazzPriceOverridden(prisma, new Decimal(11000), new Decimal(10000))).toBe(true);
  });

  it("importDigiflazzBrand still imports with an unreadable markup, marking every row overridden", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10%");
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    const row = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    expect(row.price.toString()).toBe("16500");
    expect(row.priceOverridden).toBe(true);
  });

  it.each(["10%", "1,5,0", "-5"])(
    "resync with a stored markup of %j does not abort: keeps current prices, lifts one below the new cost to the cost, still updates cost and status, and tells admins",
    async (bad) => {
      await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
      await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
      const category = await prisma.category.findFirstOrThrow();
      const { productId } = await importDigiflazzBrand(prisma, {
        brand: "Mobile Legends", categoryId: category.id,
        rows: [
          { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" },
          { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41800", costPrice: "38000" },
        ],
      });
      const ml250 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml250" } });
      await prisma.denomination.update({ where: { id: ml250.id }, data: { isActive: true } });
      // The stored value goes bad after the import (legacy / hand-edited row).
      await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, bad);

      digiflazzMock.getPriceList.mockResolvedValue([
        priceListItem({ buyerSkuCode: "ml100", price: new Decimal(16000), buyerProductStatus: true }),
        priceListItem({ buyerSkuCode: "ml250", price: new Decimal(43000), buyerProductStatus: false }),
      ]);

      await expect(resyncDigiflazzCatalog(prisma)).resolves.toMatchObject({ deactivated: 1 });

      const ml100 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
      expect(ml100.costPrice!.toString()).toBe("16000");
      expect(ml100.price.toString()).toBe("16500"); // kept: still above the new cost
      const ml250After = await prisma.denomination.findFirstOrThrow({ where: { id: ml250.id } });
      expect(ml250After.costPrice!.toString()).toBe("43000");
      expect(ml250After.price.toString()).toBe("43000"); // lifted to the cost, never left below it
      expect(ml250After.isActive).toBe(false);

      const audit = await prisma.auditLog.findFirst({ where: { action: "digiflazz_markup_unreadable" } });
      expect(audit?.details).toMatch(/markup/i);
    },
  );
});

describe("resyncDigiflazzCatalog", () => {
  it("alerts once for newly below-cost retail/reseller prices without changing protected prices", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "777");
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, { brand: "Margin", categoryId: category.id, rows: [
      { buyerSkuCode: "margin-reseller", productName: "Reseller", price: "10000", costPrice: "9000" },
      { buyerSkuCode: "margin-retail", productName: "Retail", price: "9500", costPrice: "9000" },
    ] });
    await prisma.denomination.updateMany({ where: { productId }, data: { priceOverridden: true } });
    await prisma.denomination.updateMany({ where: { supplierSku: "margin-reseller" }, data: { resellerPrice: "9500" } });
    const response = (cost: string) => ["margin-reseller", "margin-retail"].map(buyerSkuCode => priceListItem({ buyerSkuCode, price: new Decimal(cost) }));
    digiflazzMock.getPriceList.mockResolvedValue(response("9800"));
    await resyncDigiflazzCatalog(prisma);
    const alerts = () => prisma.notificationOutbox.findMany({ where: { event: "ADMIN_DIGIFLAZZ_BELOW_COST" } });
    expect(await alerts()).toHaveLength(1);
    expect(JSON.parse((await alerts())[0]!.payloadJson)).toMatchObject({ below_cost_count: 2, newly_below_cost_count: 2 });
    const reseller = await prisma.denomination.findFirstOrThrow({ where: { supplierSku: "margin-reseller" } });
    expect(reseller.resellerPrice!.toString()).toBe("9500");
    expect(reseller.price.toString()).toBe("10000");
    await resyncDigiflazzCatalog(prisma);
    expect(await alerts()).toHaveLength(1);
    // Recovery clears the remembered set; a later loss warrants a fresh alert.
    digiflazzMock.getPriceList.mockResolvedValue(response("9000"));
    await resyncDigiflazzCatalog(prisma);
    digiflazzMock.getPriceList.mockResolvedValue(response("9800"));
    await resyncDigiflazzCatalog(prisma);
    expect(await alerts()).toHaveLength(2);
  });

  it("updates costPrice/price from a fresh price list and leaves priceOverridden rows untouched", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" },
        { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000", costPrice: "38000" },
      ],
    });
    // Admin reviews, hand-edits ml250's price, and publishes it (imports land
    // inactive — this is the "review before it goes live" step).
    const ml250 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml250" } });
    await prisma.denomination.update({
      where: { id: ml250.id },
      data: { price: "50000", priceOverridden: true, isActive: true },
    });

    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond Fresh (Global)", price: new Decimal(20000), buyerProductStatus: true }),
      priceListItem({ buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond Fresh (Indonesia)", price: new Decimal(45000), buyerProductStatus: false }),
    ]);

    const result = await resyncDigiflazzCatalog(prisma);
    expect(result.updated).toBe(1); // only ml100 — ml250 is priceOverridden
    expect(result.deactivated).toBe(1); // ml250's isActive still flips off from buyerProductStatus, independent of price

    const ml100 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    expect(ml100.costPrice!.toString()).toBe("20000");
    expect(ml100.price.toString()).toBe("22000"); // 20000 + 10%
    expect(ml100.supplierRawName).toBe("Mobile Legends 100 Diamond Fresh (Global)");

    const ml250After = await prisma.denomination.findFirstOrThrow({ where: { id: ml250.id } });
    expect(ml250After.price.toString()).toBe("50000"); // untouched
    expect(ml250After.supplierRawName).toBe("Mobile Legends 250 Diamond Fresh (Indonesia)");
    expect(ml250After.isActive).toBe(false); // status still mirrors buyerProductStatus
  });

  it("is a no-op when Digiflazz isn't configured", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
    const result = await resyncDigiflazzCatalog(prisma);
    expect(result).toEqual({ updated: 0, deactivated: 0 });
  });

  it("uses the cheapest seller's price when the fresh list has a duplicate buyerSkuCode", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(21000) }),
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(19500) }), // cheaper seller, same SKU
    ]);

    await resyncDigiflazzCatalog(prisma);

    const ml100 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    expect(ml100.costPrice!.toString()).toBe("19500");
  });

  // I1: sync can only ever deactivate, never reactivate — a manually
  // deactivated SKU (including a freshly-imported, deliberately-unreviewed
  // one) must stay off even when Digiflazz reports it as available again.
  it("I1: does not reactivate a manually-deactivated denomination even when buyerProductStatus is true", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    // importDigiflazzBrand always creates isActive: false — this row has
    // never been reviewed/activated by an admin.
    const denom = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    expect(denom.isActive).toBe(false);

    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15000), buyerProductStatus: true }),
    ]);
    await resyncDigiflazzCatalog(prisma);

    const after = await prisma.denomination.findFirstOrThrow({ where: { id: denom.id } });
    expect(after.isActive).toBe(false); // stays off — resync never flips isActive back to true
  });

  it("I1: still correctly deactivates an active denomination whose SKU goes buyerProductStatus false", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    const denom = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    await prisma.denomination.update({ where: { id: denom.id }, data: { isActive: true } });

    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15000), buyerProductStatus: false }),
    ]);
    const result = await resyncDigiflazzCatalog(prisma);
    expect(result.deactivated).toBe(1);

    const after = await prisma.denomination.findFirstOrThrow({ where: { id: denom.id } });
    expect(after.isActive).toBe(false);
  });

  // I5: resync must quantize to the same 4-decimal precision createDenomination
  // already uses — a percentage markup can otherwise produce a longer decimal
  // expansion that drifts from import-time precision.
  it("I5: quantizes price/costPrice to 4 decimals even when the markup percentage produces a longer expansion", async () => {
    const category = await prisma.category.findFirstOrThrow();
    // price === costPrice here (no markup configured yet at import time, so
    // computeDigiflazzMarkupPrice's zero-markup default suggests cost as-is)
    // — keeps this row NOT priceOverridden, so the resync below actually
    // recomputes price instead of skipping it.
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "15000", costPrice: "15000" }],
    });
    // Zero markup (sell === cost) so `price` mirrors `costPrice` exactly —
    // isolates the quantization behavior from the markup math. A cost value
    // that doesn't divide evenly (10000 / 3 -> 3333.333...) forces
    // quantization to actually do work.
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "flat");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "0");
    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal("10000").dividedBy(3) }),
    ]);

    await resyncDigiflazzCatalog(prisma);

    const ml100 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    // decimal.js division defaults to 20 significant digits — unquantized
    // this would be "3333.33333333333333333" or similar, not a clean 4dp value.
    expect(ml100.costPrice!.toString()).toBe("3333.3333");
    expect(ml100.price.toString()).toBe("3333.3333");
    expect(ml100.costPrice!.decimalPlaces()).toBeLessThanOrEqual(4);
    expect(ml100.price.decimalPlaces()).toBeLessThanOrEqual(4);
  });

  // I3: the markup setting must be read a CONSTANT number of times per
  // resync run, not once per denomination touched. Compares the getSetting
  // call count for a 1-denomination run against a 3-denomination run rather
  // than hard-coding a literal — the old per-row computeDigiflazzMarkupPrice
  // call would have made the 3-row run's count strictly larger; the fixed
  // code makes both counts equal (the constant overhead of
  // getDigiflazzCreds + getDigiflazzMarkupSettings, read once regardless of
  // row count).
  it("I3: reads the markup settings a constant number of times regardless of how many denominations are touched", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Mobile Legends" });
    async function makeDigiflazzDenom(sku: string, price: string) {
      return createDenomination(prisma, {
        productId: product.id,
        name: sku,
        type: "SHARED",
        durationLabel: sku,
        price,
        costPrice: price,
        autoDeliverySource: "digiflazz",
        supplierSku: sku,
        deliveryType: DeliveryType.MANUAL_WITH_INFO,
        isActive: true,
      });
    }

    await makeDigiflazzDenom("ml100", "15000");
    digiflazzMock.getPriceList.mockResolvedValue([priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15500) })]);
    const spyOneRow = vi.spyOn(settingsModule, "getSetting");
    await resyncDigiflazzCatalog(prisma);
    const callsForOneRow = spyOneRow.mock.calls.length;
    spyOneRow.mockRestore();
    expect(callsForOneRow).toBeGreaterThan(0);

    await makeDigiflazzDenom("ml250", "38000");
    await makeDigiflazzDenom("ml500", "75000");
    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15600) }),
      priceListItem({ buyerSkuCode: "ml250", price: new Decimal(38500) }),
      priceListItem({ buyerSkuCode: "ml500", price: new Decimal(76000) }),
    ]);
    const spyThreeRows = vi.spyOn(settingsModule, "getSetting");
    await resyncDigiflazzCatalog(prisma);
    const callsForThreeRows = spyThreeRows.mock.calls.length;
    spyThreeRows.mockRestore();

    expect(callsForThreeRows).toBe(callsForOneRow);
  });

  // I2: resync writes exactly one summary audit entry per run that actually
  // changed something, and none for a no-op run — never one per denomination.
  describe("I2: audit trail", () => {
    it("writes exactly one digiflazz_catalog_resync audit entry (adminId: null) when a run changes something", async () => {
      const category = await prisma.category.findFirstOrThrow();
      // price === costPrice (no markup configured at import time) so neither
      // row is priceOverridden — the resync below must actually update both.
      await importDigiflazzBrand(prisma, {
        brand: "Mobile Legends", categoryId: category.id,
        rows: [
          { buyerSkuCode: "ml100", productName: "ML 100", price: "15000", costPrice: "15000" },
          { buyerSkuCode: "ml250", productName: "ML 250", price: "38000", costPrice: "38000" },
        ],
      });
      digiflazzMock.getPriceList.mockResolvedValue([
        priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15500) }),
        priceListItem({ buyerSkuCode: "ml250", price: new Decimal(38500) }),
      ]);

      await resyncDigiflazzCatalog(prisma);

      const entries = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_resync" } });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.adminId).toBeNull();
    });

    it("writes no audit entry for a no-op run (nothing changed)", async () => {
      // No Digiflazz-mapped denominations at all — mapped is empty, the loop
      // never runs, nothing changes.
      digiflazzMock.getPriceList.mockResolvedValue([]);
      const result = await resyncDigiflazzCatalog(prisma);
      expect(result).toEqual({ updated: 0, deactivated: 0 });

      const entries = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_resync" } });
      expect(entries).toHaveLength(0);
    });
  });

  // Task 10 (backend audit 2026-08-21, C-1 second half): Task 9 already
  // rejects an individually invalid/non-finite/non-positive supplier price,
  // but a genuinely malformed *response* (a field rename, a partial outage,
  // the wrong endpoint) can still hand back prices that are each
  // individually "valid" yet collectively wrong for a large swath of the
  // catalog. This breaker compares each would-reprice row's new price
  // against its current price and aborts the whole run — writing nothing —
  // when too many of them moved too sharply at once.
  describe("Task 10: blast-radius circuit breaker", () => {
    /** N digiflazz-mapped, not-priceOverridden denominations sharing one
     * product, each named/skinned by index — the shape the breaker's
     * would-reprice set walks. */
    async function makeDigiflazzDenoms(
      count: number,
      price: string,
      overrides: { priceOverridden?: boolean } = {},
    ) {
      const category = await prisma.category.findFirstOrThrow();
      const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Breaker Test Product" });
      const denoms = [];
      for (let i = 0; i < count; i++) {
        const sku = `bt${i}`;
        denoms.push(
          await createDenomination(prisma, {
            productId: product.id,
            name: sku,
            type: "SHARED",
            durationLabel: sku,
            price,
            costPrice: price,
            autoDeliverySource: "digiflazz",
            supplierSku: sku,
            deliveryType: DeliveryType.MANUAL_WITH_INFO,
            isActive: true,
            priceOverridden: overrides.priceOverridden ?? false,
          }),
        );
      }
      return denoms;
    }

    it("trips when every mapped denomination's price would move sharply: writes nothing, logs an aborted audit entry, and alerts every admin", async () => {
      await setSetting(prisma, ADMIN_IDS_KEY, "700,701");
      const denoms = await makeDigiflazzDenoms(6, "15000");
      digiflazzMock.getPriceList.mockResolvedValue(
        denoms.map((d) => priceListItem({ buyerSkuCode: d.supplierSku!, price: new Decimal(10) })), // markup-implied new price collapses toward zero — same failure shape C-1 originally described
      );

      const result = await resyncDigiflazzCatalog(prisma);
      expect(result).toEqual({ updated: 0, deactivated: 0 });

      // No Denomination.price/costPrice/isActive write happened for any row.
      for (const d of denoms) {
        const after = await prisma.denomination.findUniqueOrThrow({ where: { id: d.id } });
        expect(after.price.toString()).toBe("15000");
        expect(after.costPrice!.toString()).toBe("15000");
        expect(after.isActive).toBe(true);
      }

      const abortedEntries = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_resync_aborted" } });
      expect(abortedEntries).toHaveLength(1);
      expect(abortedEntries[0]!.adminId).toBeNull();
      const successEntries = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_resync" } });
      expect(successEntries).toHaveLength(0);

      const alertRows = await prisma.notificationOutbox.findMany({
        where: { event: NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED },
      });
      expect(alertRows).toHaveLength(2); // one per configured admin (700, 701)
      const chatIds = alertRows
        .map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id)
        .sort((a, b) => a - b);
      expect(chatIds).toEqual([700, 701]);
      const payload = JSON.parse(alertRows[0]!.payloadJson) as {
        kind: string;
        sharp_changes: number;
        considered_rows: number;
      };
      expect(payload.kind).toBe("sharp_change");
      expect(payload.sharp_changes).toBe(6);
      expect(payload.considered_rows).toBe(6);
    });

    it("does not trip when fewer than 5 rows would be repriced, even though every one of them individually exceeds the 50% band", async () => {
      const denoms = await makeDigiflazzDenoms(3, "15000");
      digiflazzMock.getPriceList.mockResolvedValue(
        denoms.map((d) => priceListItem({ buyerSkuCode: d.supplierSku!, price: new Decimal(10) })),
      );

      const result = await resyncDigiflazzCatalog(prisma);
      expect(result).toEqual({ updated: 3, deactivated: 0 }); // proceeds exactly as before the breaker existed

      for (const d of denoms) {
        const after = await prisma.denomination.findUniqueOrThrow({ where: { id: d.id } });
        expect(after.price.toString()).toBe("10");
      }

      const abortedEntries = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_resync_aborted" } });
      expect(abortedEntries).toHaveLength(0);
      const alertRows = await prisma.notificationOutbox.findMany({
        where: { event: NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED },
      });
      expect(alertRows).toHaveLength(0);
    });

    it("does not trip when every would-be-repriced row is priceOverridden (nothing to compare)", async () => {
      const denoms = await makeDigiflazzDenoms(6, "15000", { priceOverridden: true });
      digiflazzMock.getPriceList.mockResolvedValue(
        denoms.map((d) => priceListItem({ buyerSkuCode: d.supplierSku!, price: new Decimal(10) })),
      );

      const result = await resyncDigiflazzCatalog(prisma);
      expect(result).toEqual({ updated: 0, deactivated: 0 }); // every row skipped — priceOverridden protects it

      for (const d of denoms) {
        const after = await prisma.denomination.findUniqueOrThrow({ where: { id: d.id } });
        expect(after.price.toString()).toBe("15000");
      }

      const abortedEntries = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_resync_aborted" } });
      expect(abortedEntries).toHaveLength(0);
      const alertRows = await prisma.notificationOutbox.findMany({
        where: { event: NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED },
      });
      expect(alertRows).toHaveLength(0);
    });

    // Important #2 (final whole-branch review, 2026-08-21): the breaker above
    // only ever compares rows present in the fetched price list — if the
    // fetch itself is malformed enough that EVERY row is unusable (Task 9's
    // toPriceListItem returning null for every row) or the response is
    // simply empty, `consideredRows` stays 0 for every denomination and the
    // sharp-change threshold above can never fire, even though this is the
    // most total form of the exact "malformed response" scenario the breaker
    // exists to catch.
    it("trips when the price-list fetch returns zero usable rows at all, even though this shop has Digiflazz-routed denominations to check (Important #2)", async () => {
      await setSetting(prisma, ADMIN_IDS_KEY, "700,701");
      const denoms = await makeDigiflazzDenoms(6, "15000");
      // Simulates a malformed/empty supplier response — e.g. every row's
      // price field was renamed, so Task 9's toPriceListItem rejected every
      // single one and getPriceList returned nothing usable at all.
      digiflazzMock.getPriceList.mockResolvedValue([]);

      const result = await resyncDigiflazzCatalog(prisma);
      expect(result).toEqual({ updated: 0, deactivated: 0 });

      // No Denomination.price/costPrice/isActive write happened for any row.
      for (const d of denoms) {
        const after = await prisma.denomination.findUniqueOrThrow({ where: { id: d.id } });
        expect(after.price.toString()).toBe("15000");
        expect(after.costPrice!.toString()).toBe("15000");
        expect(after.isActive).toBe(true);
      }

      const abortedEntries = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_resync_aborted" } });
      expect(abortedEntries).toHaveLength(1);
      expect(abortedEntries[0]!.adminId).toBeNull();
      expect(abortedEntries[0]!.details).toContain("no usable price data");
      const successEntries = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_resync" } });
      expect(successEntries).toHaveLength(0);

      const alertRows = await prisma.notificationOutbox.findMany({
        where: { event: NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED },
      });
      expect(alertRows).toHaveLength(2); // one per configured admin (700, 701)
      const chatIds = alertRows
        .map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id)
        .sort((a, b) => a - b);
      expect(chatIds).toEqual([700, 701]);
      const payload = JSON.parse(alertRows[0]!.payloadJson) as {
        kind: string;
        sharp_changes?: number;
        considered_rows?: number;
      };
      expect(payload.kind).toBe("no_usable_rows");
      expect(payload.sharp_changes).toBeUndefined();
      expect(payload.considered_rows).toBeUndefined();
    });

    // Regression guard for the distinction the fix must get right: a supplier
    // response that returns plenty of valid rows, just none that happen to
    // match THIS shop's configured SKUs this cycle, is normal and must NOT
    // trip anything — only `rawPriceList.length === 0` (nothing usable at
    // all) counts as malformed.
    it("does not trip when the supplier returns plenty of valid rows that simply don't match this shop's configured SKUs (Important #2 regression guard)", async () => {
      const denoms = await makeDigiflazzDenoms(6, "15000");
      // Hundreds of OTHER valid rows, none of which match any of this shop's
      // configured supplierSkus.
      digiflazzMock.getPriceList.mockResolvedValue(
        Array.from({ length: 200 }, (_, i) => priceListItem({ buyerSkuCode: `other-sku-${i}`, price: new Decimal(999) })),
      );

      const result = await resyncDigiflazzCatalog(prisma);
      expect(result).toEqual({ updated: 0, deactivated: 0 }); // nothing matched, nothing to update — not an abort

      for (const d of denoms) {
        const after = await prisma.denomination.findUniqueOrThrow({ where: { id: d.id } });
        expect(after.price.toString()).toBe("15000"); // untouched
      }

      const abortedEntries = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_resync_aborted" } });
      expect(abortedEntries).toHaveLength(0);
      const alertRows = await prisma.notificationOutbox.findMany({
        where: { event: NotificationEvent.ADMIN_DIGIFLAZZ_RESYNC_ABORTED },
      });
      expect(alertRows).toHaveLength(0);
    });

    // Task 5 (realtime Digiflazz status): the sync-status-store write added to
    // resyncDigiflazzCatalog's abort branches, recording the SAME abortReason
    // this describe block's other tests already assert on via the audit log /
    // admin alert.
    it("records an aborted status with the right abortReason when the circuit breaker trips", async () => {
      await setSetting(prisma, ADMIN_IDS_KEY, "700");
      const denoms = await makeDigiflazzDenoms(6, "15000");
      digiflazzMock.getPriceList.mockResolvedValue(
        denoms.map((d) => priceListItem({ buyerSkuCode: d.supplierSku!, price: new Decimal(10) })),
      );

      await resyncDigiflazzCatalog(prisma);
      const status = await getDigiflazzSyncStatus(prisma);

      expect(status).not.toBeNull();
      expect(status!.status).toBe("aborted");
      expect(status!.abortReason).toBe("sharp_change");
      expect(status!.updated).toBe(0);
      expect(status!.deactivated).toBe(0);
    });
  });

  // Task 5 (realtime Digiflazz status): the sync-status-store write added to
  // resyncDigiflazzCatalog's normal-completion path (recordDigiflazzSyncStatus,
  // digiflazzSyncStatus.ts), unconditional even on a no-op tick.
  it("records a success status after a normal run", async () => {
    const category = await prisma.category.findFirstOrThrow();
    await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(20000), buyerProductStatus: true }),
    ]);

    const result = await resyncDigiflazzCatalog(prisma);
    const status = await getDigiflazzSyncStatus(prisma);

    expect(status).not.toBeNull();
    expect(status!.status).toBe("success");
    expect(status!.updated).toBe(result.updated);
    expect(status!.deactivated).toBe(result.deactivated);
    expect(status!.abortReason).toBeNull();
    const finishedAtMs = new Date(status!.finishedAt).getTime();
    expect(Date.now() - finishedAtMs).toBeLessThan(5_000);
  });

  // Task 10 sentinel: the shadow-wiring must not change resyncDigiflazzCatalog's
  // return shape or its price/status/breaker behavior. Mirrors the return-shape
  // assertions the tests above already make ({ updated, deactivated } and
  // nothing else), kept as an explicit guard for a future Task 10 change (e.g.
  // wiring in runDetectionForCatalog) that must stay behind this contract.
  it("Task 10 sentinel: return shape is exactly { updated, deactivated } after a real run", async () => {
    const category = await prisma.category.findFirstOrThrow();
    await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends",
      categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(20000), buyerProductStatus: true }),
    ]);

    const result = await resyncDigiflazzCatalog(prisma);

    expect(Object.keys(result).sort()).toEqual(["deactivated", "updated"]);
    expect(typeof result.updated).toBe("number");
    expect(typeof result.deactivated).toBe("number");
  });

  // Also mirror the "no-op when Digiflazz isn't configured" return-shape
  // assertion verbatim as a second sentinel on the early-return path.
  it("Task 10 sentinel: still returns { updated: 0, deactivated: 0 } when Digiflazz isn't configured", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
    const result = await resyncDigiflazzCatalog(prisma);
    expect(result).toEqual({ updated: 0, deactivated: 0 });
  });
});

// Task 3: migration for products imported BEFORE Task 2's region-aware
// grouping/stripping fix — a single Product whose denominations mix several
// regions' pricing together (the real "Mobile Legends" bug: Indonesia/
// Filipina/Russia/Brazil all under one brand).
describe("splitMixedDigiflazzProducts / detectMixedDigiflazzProducts", () => {
  /** Seed one Digiflazz Product with denominations spread across 4 regions
   * with UNEVEN counts (Indonesia 4 > Filipina 3 > Russia 2 > Brazil 1) so
   * there's an unambiguous largest-bucket winner — mirrors the real bug:
   * pre-migration rows carry the raw, still-suffixed Digiflazz productName in
   * `name` (created directly here, not via importDigiflazzBrand, which would
   * already strip it). */
  async function seedMixedProduct(categoryId: number) {
    const product = await createCatalogProduct(prisma, {
      categoryId,
      name: "Mobile Legends",
      digiflazzBrand: "Mobile Legends",
    });
    const regionCounts: [string, number][] = [
      ["Indonesia", 4],
      ["Filipina", 3],
      ["Russia", 2],
      ["Brazil", 1],
    ];
    const denomsByRegion = new Map<string, { id: number; name: string }[]>();
    let sku = 0;
    for (const [region, count] of regionCounts) {
      const records: { id: number; name: string }[] = [];
      for (let i = 0; i < count; i++) {
        sku++;
        const name = `Mobile Legends ${100 * (i + 1)} Diamond (${region})`;
        const denom = await createDenomination(prisma, {
          productId: product.id,
          name,
          type: "SHARED",
          durationLabel: name,
          price: "16500",
          autoDeliverySource: "digiflazz",
          supplierSku: `ml-${region}-${sku}`,
        });
        records.push({ id: denom.id, name });
      }
      denomsByRegion.set(region, records);
    }
    return { product, denomsByRegion };
  }

  it("splits a 4-region mixed product into 4 Products; the winner (largest bucket) keeps the original id and its denominations' original names, denomination ids are unchanged, and only MOVED denominations are stripped", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { product, denomsByRegion } = await seedMixedProduct(category.id);
    const allDenomIdsBefore = [...denomsByRegion.values()].flatMap((records) => records.map((r) => r.id)).sort();

    const result = await splitMixedDigiflazzProducts(prisma);
    expect(result).toEqual({
      productsSplit: 1,
      productsCreated: 3,
      denominationsMoved: 3 + 2 + 1,
      skipped: [],
      conflicts: [],
      failures: [],
    });

    const allProducts = await prisma.product.findMany({
      where: { digiflazzBrand: { in: ["Mobile Legends (Indonesia)", "Mobile Legends (Filipina)", "Mobile Legends (Russia)", "Mobile Legends (Brazil)"] } },
      include: { denominations: true },
    });
    expect(allProducts).toHaveLength(4);

    // Indonesia has the largest bucket (4) — it wins and keeps the original
    // product id.
    const indonesia = allProducts.find((p) => p.name === "Mobile Legends (Indonesia)")!;
    expect(indonesia.id).toBe(product.id);
    expect(indonesia.slug).not.toBe("mobile-legends"); // slug regenerated for the new composite name
    expect(indonesia.denominations).toHaveLength(4);

    const filipina = allProducts.find((p) => p.name === "Mobile Legends (Filipina)")!;
    expect(filipina.id).not.toBe(product.id);
    expect(filipina.denominations).toHaveLength(3);

    const russia = allProducts.find((p) => p.name === "Mobile Legends (Russia)")!;
    expect(russia.denominations).toHaveLength(2);

    const brazil = allProducts.find((p) => p.name === "Mobile Legends (Brazil)")!;
    expect(brazil.denominations).toHaveLength(1);

    // Denomination ids are never touched by the split — only
    // productId/name/durationLabel change. Compare the full id set before
    // and after.
    const allDenomIdsAfter = allProducts.flatMap((p) => p.denominations.map((d) => d.id)).sort();
    expect(allDenomIdsAfter).toEqual(allDenomIdsBefore);

    // Finding 1 (final whole-branch review, user-decided): only
    // denominations that MOVED to a new product get the region suffix
    // stripped from name/durationLabel. Denominations that STAYED on the
    // winning/original product (Indonesia) keep their exact original
    // suffixed name, byte-identical to before the migration — OrderItem has
    // no name snapshot, so a historical order view renders the live
    // denomination name, and stripping a stayed denomination's name would
    // silently rewrite what an old order displays even though the product
    // never actually changed.
    const indonesiaBefore = new Map(denomsByRegion.get("Indonesia")!.map((r) => [r.id, r.name]));
    for (const denom of indonesia.denominations) {
      expect(denom.name).toBe(indonesiaBefore.get(denom.id));
      expect(denom.durationLabel).toBe(indonesiaBefore.get(denom.id));
      expect(denom.name).toContain("(Indonesia)");
    }
    for (const p of [filipina, russia, brazil]) {
      for (const denom of p.denominations) {
        expect(denom.name).not.toContain("(");
        expect(denom.durationLabel).not.toContain("(");
      }
    }
  });

  it("is a full no-op on a second run over the same (now-split) data", async () => {
    const category = await prisma.category.findFirstOrThrow();
    await seedMixedProduct(category.id);
    await splitMixedDigiflazzProducts(prisma);

    const second = await splitMixedDigiflazzProducts(prisma);
    expect(second.productsSplit).toBe(0);
    expect(second.productsCreated).toBe(0);
    expect(second.denominationsMoved).toBe(0);
    expect(second.skipped.sort()).toEqual(
      ["Mobile Legends (Indonesia)", "Mobile Legends (Filipina)", "Mobile Legends (Russia)", "Mobile Legends (Brazil)"].sort(),
    );

    // detectMixedDigiflazzProducts (the read-only side the dry-run script
    // uses) agrees: nothing mixed remains.
    const detection = await detectMixedDigiflazzProducts(prisma);
    expect(detection.mixed).toHaveLength(0);
  });

  it("leaves an unrelated non-mixed Digiflazz product untouched and reports it in skipped", async () => {
    const category = await prisma.category.findFirstOrThrow();
    await seedMixedProduct(category.id);

    // Single-region product (every row's name maps to the same region).
    const singleRegionProduct = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Free Fire (Indonesia)",
      digiflazzBrand: "Free Fire (Indonesia)",
    });
    const ffDenom = await createDenomination(prisma, {
      productId: singleRegionProduct.id,
      name: "100 Diamond (Indonesia)",
      type: "SHARED",
      durationLabel: "100 Diamond (Indonesia)",
      price: "10000",
      autoDeliverySource: "digiflazz",
      supplierSku: "ff-id-100",
    });

    // No-region-at-all product (every row unsuffixed).
    const noRegionProduct = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Pulsa Telkomsel",
      digiflazzBrand: "Pulsa Telkomsel",
    });
    await createDenomination(prisma, {
      productId: noRegionProduct.id,
      name: "Pulsa 10.000",
      type: "SHARED",
      durationLabel: "Pulsa 10.000",
      price: "10500",
      autoDeliverySource: "digiflazz",
      supplierSku: "pulsa-10k",
    });

    const result = await splitMixedDigiflazzProducts(prisma);
    expect(result.skipped.sort()).toEqual(["Free Fire (Indonesia)", "Pulsa Telkomsel"].sort());
    expect(result.productsSplit).toBe(1); // only the seeded mixed product

    // Untouched: same id, same denomination, same name — nothing rewritten.
    const ffAfter = await prisma.product.findUniqueOrThrow({ where: { id: singleRegionProduct.id } });
    expect(ffAfter.name).toBe("Free Fire (Indonesia)");
    const ffDenomAfter = await prisma.denomination.findUniqueOrThrow({ where: { id: ffDenom.id } });
    expect(ffDenomAfter.name).toBe("100 Diamond (Indonesia)"); // NOT stripped — this product was never mixed
  });

  it("calls logAdminAction exactly once per split product, with adminId: null", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { product } = await seedMixedProduct(category.id);

    await splitMixedDigiflazzProducts(prisma);

    const entries = await prisma.auditLog.findMany({
      where: { action: "digiflazz_catalog_region_split", targetId: product.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.adminId).toBeNull();
    expect(entries[0]!.details).toContain("Mobile Legends");
    expect(entries[0]!.details).toContain("4 region products");
  });

  it("tie-breaks the winning region alphabetically when two buckets have equal counts", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Free Fire",
      digiflazzBrand: "Free Fire",
    });
    // Zulu and Alpha tie at 1 denomination each — "Alpha" sorts first.
    await createDenomination(prisma, {
      productId: product.id,
      name: "100 Diamond (Zulu)",
      type: "SHARED",
      durationLabel: "100 Diamond (Zulu)",
      price: "10000",
      autoDeliverySource: "digiflazz",
      supplierSku: "ff-zulu",
    });
    await createDenomination(prisma, {
      productId: product.id,
      name: "100 Diamond (Alpha)",
      type: "SHARED",
      durationLabel: "100 Diamond (Alpha)",
      price: "10000",
      autoDeliverySource: "digiflazz",
      supplierSku: "ff-alpha",
    });

    await splitMixedDigiflazzProducts(prisma);

    const winner = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(winner.name).toBe("Free Fire (Alpha)");
  });

  it("detectMixedDigiflazzProducts is read-only — computes the same plan without writing anything", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { product } = await seedMixedProduct(category.id);

    const detection = await detectMixedDigiflazzProducts(prisma);
    expect(detection.mixed).toHaveLength(1);
    expect(detection.mixed[0]!.productId).toBe(product.id);
    expect(detection.mixed[0]!.groups.map((g) => g.region).sort()).toEqual(
      ["Brazil", "Filipina", "Indonesia", "Russia"].sort(),
    );
    // Winning bucket (largest count) is first.
    expect(detection.mixed[0]!.groups[0]!.region).toBe("Indonesia");

    // Nothing was written — same name/id, same denomination names.
    const unchanged = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(unchanged.name).toBe("Mobile Legends");
    const denoms = await prisma.denomination.findMany({ where: { productId: product.id } });
    expect(denoms.every((d) => d.name.includes("("))).toBe(true);
  });

  // Finding 3 (regression test for Finding 1): exercise the null/
  // "(unspecified)" region bucket, which is exactly the scenario that
  // triggers the slug-corruption bug — its displayName always equals the
  // product's current name (digiflazzGroupKey leaves displayName === brand
  // when region is null), and the tie-break rule (region ?? "" sorts before
  // any named region) makes it likely to win. Mirrors this worktree's own
  // real "Valorant" data noted in the task-3 review.
  it("Finding 1: when the null/unspecified bucket wins, the product's name AND slug stay unchanged (no slug corruption)", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Valorant",
      digiflazzBrand: "Valorant",
    });
    const originalSlug = product.slug;

    // Unspecified (3, no suffix) ties with Malaysia (3) — "" sorts before
    // "Malaysia" alphabetically, so unspecified wins. Singapore (2) is
    // strictly smaller and never in contention, just there to prove a
    // 3-way split still works correctly alongside the Finding 1 fix.
    const unspecifiedIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await createDenomination(prisma, {
        productId: product.id,
        name: `Valorant ${100 * (i + 1)} Points`,
        type: "SHARED",
        durationLabel: `Valorant ${100 * (i + 1)} Points`,
        price: "16500",
        autoDeliverySource: "digiflazz",
        supplierSku: `vp-none-${i}`,
      });
      unspecifiedIds.push(d.id);
    }
    const malaysiaIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await createDenomination(prisma, {
        productId: product.id,
        name: `Valorant ${100 * (i + 1)} Points (Malaysia)`,
        type: "SHARED",
        durationLabel: `Valorant ${100 * (i + 1)} Points (Malaysia)`,
        price: "16500",
        autoDeliverySource: "digiflazz",
        supplierSku: `vp-my-${i}`,
      });
      malaysiaIds.push(d.id);
    }
    const singaporeIds: number[] = [];
    for (let i = 0; i < 2; i++) {
      const d = await createDenomination(prisma, {
        productId: product.id,
        name: `Valorant ${100 * (i + 1)} Points (Singapore)`,
        type: "SHARED",
        durationLabel: `Valorant ${100 * (i + 1)} Points (Singapore)`,
        price: "16500",
        autoDeliverySource: "digiflazz",
        supplierSku: `vp-sg-${i}`,
      });
      singaporeIds.push(d.id);
    }

    const result = await splitMixedDigiflazzProducts(prisma);
    expect(result).toEqual({
      productsSplit: 1,
      productsCreated: 2,
      denominationsMoved: 3 + 2,
      skipped: [],
      conflicts: [],
      failures: [],
    });

    // The winner (null/unspecified bucket) keeps the original product's id,
    // NAME, and SLUG completely unchanged — this is the Finding 1 assertion.
    const winner = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(winner.name).toBe("Valorant");
    expect(winner.slug).toBe(originalSlug);
    expect(winner.digiflazzBrand).toBe("Valorant");
    const winnerDenoms = await prisma.denomination.findMany({ where: { productId: product.id } });
    expect(winnerDenoms.map((d) => d.id).sort()).toEqual(unspecifiedIds.sort());
    for (const d of winnerDenoms) {
      expect(d.name).not.toContain("(");
    }

    // Malaysia and Singapore each got their own new product.
    const malaysia = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: "Valorant (Malaysia)" } });
    expect(malaysia.id).not.toBe(product.id);
    const malaysiaDenoms = await prisma.denomination.findMany({ where: { productId: malaysia.id } });
    expect(malaysiaDenoms.map((d) => d.id).sort()).toEqual(malaysiaIds.sort());

    const singapore = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: "Valorant (Singapore)" } });
    expect(singapore.id).not.toBe(product.id);
    const singaporeDenoms = await prisma.denomination.findMany({ where: { productId: singapore.id } });
    expect(singaporeDenoms.map((d) => d.id).sort()).toEqual(singaporeIds.sort());
  });

  // Finding 2: the collision guard. Neither Product.name nor
  // Product.digiflazzBrand is unique, so a fresh region-aware import could
  // have already created a separate product for one of this mixed product's
  // target region names before this migration runs.
  it("Finding 2: skips the whole product (untouched) and reports a conflict when a target region name already belongs to a different existing product's digiflazzBrand", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { product } = await seedMixedProduct(category.id);
    const denomsBefore = await prisma.denomination.findMany({ where: { productId: product.id } });

    // Simulate: a fresh Digiflazz import (using the new region-aware
    // grouping) already created a separate product for the Filipina region
    // before this migration ran on the old mixed data.
    const preExisting = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Mobile Legends (Filipina)",
      digiflazzBrand: "Mobile Legends (Filipina)",
    });

    const result = await splitMixedDigiflazzProducts(prisma);
    expect(result.productsSplit).toBe(0);
    expect(result.productsCreated).toBe(0);
    expect(result.denominationsMoved).toBe(0);
    // The pre-existing conflicting product itself has no denominations, so
    // it's a "skipped" (nothing-to-split) candidate in its own right —
    // that's unrelated to the conflict this test is about.
    expect(result.skipped).toEqual(["Mobile Legends (Filipina)"]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toContain("Mobile Legends (Filipina)");
    expect(result.conflicts[0]).toContain(String(preExisting.id));
    expect(result.conflicts[0]).toContain(String(product.id));

    // The original mixed product is left COMPLETELY untouched — not
    // partially split.
    const original = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(original.name).toBe("Mobile Legends");
    expect(original.digiflazzBrand).toBe("Mobile Legends");
    const denomsAfter = await prisma.denomination.findMany({ where: { productId: product.id } });
    expect(denomsAfter.map((d) => d.id).sort()).toEqual(denomsBefore.map((d) => d.id).sort());
    for (const d of denomsAfter) {
      expect(d.name).toContain("("); // never stripped
    }

    // No duplicate was created for the colliding brand — still exactly one
    // product with that digiflazzBrand, and it's the pre-existing one.
    const dupes = await prisma.product.findMany({ where: { digiflazzBrand: "Mobile Legends (Filipina)" } });
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.id).toBe(preExisting.id);
    expect(dupes[0]!.name).toBe("Mobile Legends (Filipina)");

    // detectMixedDigiflazzProducts (the dry-run script's read side) agrees.
    const detection = await detectMixedDigiflazzProducts(prisma);
    expect(detection.mixed).toHaveLength(0);
    expect(detection.conflicts).toHaveLength(1);
  });

  // Finding 3 (final whole-branch review): detectMixedDigiflazzProducts only
  // checks for a digiflazzBrand collision ONCE, up front, before any
  // product's write transaction runs. Simulate a concurrent wizard import
  // landing in the TOCTOU gap between that detection and this product's own
  // transaction — the in-transaction re-check must catch it and fail that
  // product's split safely (caught by the existing per-product try/catch,
  // recorded in `failures`) rather than writing a second product sharing the
  // colliding digiflazzBrand.
  it("Finding 3 (TOCTOU): re-checks for a digiflazzBrand collision inside the transaction and fails that product's split if one appeared after detection", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { product } = await seedMixedProduct(category.id); // winner is "Mobile Legends (Indonesia)" (largest bucket)

    const originalTransaction = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: unknown[]) => {
      // Simulate a concurrent Digiflazz wizard import creating the exact
      // target product AFTER detectMixedDigiflazzProducts already reported
      // "no conflict", but before this product's own transaction starts.
      await prisma.product.create({
        data: {
          categoryId: category.id,
          name: "Mobile Legends (Indonesia)",
          slug: "mobile-legends-indonesia-concurrent",
          digiflazzBrand: "Mobile Legends (Indonesia)",
        },
      });
      return (originalTransaction as (...a: unknown[]) => unknown)(...args);
    }) as typeof prisma.$transaction);

    try {
      const result = await splitMixedDigiflazzProducts(prisma);

      expect(result.productsSplit).toBe(0);
      expect(result.productsCreated).toBe(0);
      expect(result.denominationsMoved).toBe(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.productName).toBe("Mobile Legends");
      expect(result.failures[0]!.error).toContain("collision detected inside transaction");
      expect(result.failures[0]!.error).toContain("Mobile Legends (Indonesia)");

      // The original mixed product's transaction rolled back — left
      // completely untouched, same as a detection-time conflict.
      const original = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(original.name).toBe("Mobile Legends");
      expect(original.digiflazzBrand).toBe("Mobile Legends");
      const denoms = await prisma.denomination.findMany({ where: { productId: product.id } });
      expect(denoms).toHaveLength(10);
      for (const d of denoms) {
        expect(d.name).toContain("("); // never stripped
      }

      // No duplicate digiflazzBrand — still exactly the one concurrently-
      // created product holding "Mobile Legends (Indonesia)".
      const dupes = await prisma.product.findMany({ where: { digiflazzBrand: "Mobile Legends (Indonesia)" } });
      expect(dupes).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  // Re-review Finding A: the CLI's dry-run print needs each region bucket's
  // denomination NAMES (not just a count) so an operator can visually spot a
  // false-positive split — e.g. a legitimately-named denomination like
  // "Weekly Diamond Pass (Promo)" that parseProductRegion mis-parses as its
  // own 1-row "region". This only asserts the underlying data plumbing
  // (DigiflazzRegionGroup.denominations carries real names) is present and
  // correct; the script's console output itself isn't unit-tested here.
  it("Finding A: each region group's denominations carry their original names, giving the dry-run print something to show besides a bare count", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { product } = await seedMixedProduct(category.id);

    const detection = await detectMixedDigiflazzProducts(prisma);
    const plan = detection.mixed.find((p) => p.productId === product.id)!;
    expect(plan.groups.length).toBeGreaterThan(0);
    for (const group of plan.groups) {
      expect(group.denominations.length).toBeGreaterThan(0);
      for (const denom of group.denominations) {
        expect(typeof denom.name).toBe("string");
        expect(denom.name.length).toBeGreaterThan(0);
      }
    }
    // Brazil is the single-row bucket in this fixture — exactly the shape a
    // false-positive "(Promo)" bucket would have, which is why the operator
    // needs to see the name, not just "1 denomination(s)".
    const brazil = plan.groups.find((g) => g.region === "Brazil")!;
    expect(brazil.denominations.map((d) => d.name)).toEqual(["Mobile Legends 100 Diamond (Brazil)"]);
  });

  // Re-review Finding B: a per-product transaction failure must not abort
  // the whole run — earlier/other products already committed by that point
  // must be reported, not silently thrown away past the caller.
  describe("Finding B: per-product failure isolation", () => {
    it("continues splitting the other product when one product's transaction throws, and reports the failure without losing the other's result", async () => {
      const category = await prisma.category.findFirstOrThrow();
      await seedMixedProduct(category.id); // "Mobile Legends" -> 4 regions, 10 denominations total

      const productB = await createCatalogProduct(prisma, {
        categoryId: category.id,
        name: "Free Fire",
        digiflazzBrand: "Free Fire",
      });
      await createDenomination(prisma, {
        productId: productB.id, name: "100 Diamond", type: "SHARED", durationLabel: "100 Diamond",
        price: "10000", autoDeliverySource: "digiflazz", supplierSku: "ff-none",
      });
      await createDenomination(prisma, {
        productId: productB.id, name: "100 Diamond (Malaysia)", type: "SHARED", durationLabel: "100 Diamond (Malaysia)",
        price: "10000", autoDeliverySource: "digiflazz", supplierSku: "ff-my",
      });

      // Force exactly ONE of the two products' $transaction calls to reject
      // (simulating a transient DB error mid-run) while the other runs for
      // real — proves the failure of one product's transaction doesn't touch
      // the other's already-committed (or about-to-commit) result.
      const originalTransaction = prisma.$transaction.bind(prisma);
      let callIndex = 0;
      const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: unknown[]) => {
        callIndex++;
        if (callIndex === 2) {
          throw new Error("Simulated transient DB failure");
        }
        return (originalTransaction as (...a: unknown[]) => unknown)(...args);
      }) as typeof prisma.$transaction);

      // Minor fix (third-round review, Finding 2): restore the spy in a
      // `finally` block, not as a plain statement after the awaited call.
      // `prisma` is a file-scoped singleton with no global
      // afterEach(vi.restoreAllMocks) — if splitMixedDigiflazzProducts ever
      // threw unexpectedly (exactly the regression this test exists to
      // catch), the plain-statement mockRestore() would never run and the
      // mocked $transaction would leak into every later test in this file,
      // turning one clear failure into a confusing cascade.
      try {
        const result = await splitMixedDigiflazzProducts(prisma);

        // Exactly one product failed and one succeeded — the run did not
        // throw and did not lose track of either outcome.
        expect(result.failures).toHaveLength(1);
        expect(result.productsSplit).toBe(1);
        expect(result.failures[0]!.error).toContain("Simulated transient DB failure");
        const failedName = result.failures[0]!.productName;
        expect(["Mobile Legends", "Free Fire"]).toContain(failedName);

        if (failedName === "Free Fire") {
          expect(result.productsCreated).toBe(3); // Mobile Legends' 3 non-winning regions
          const ml = await prisma.product.findMany({ where: { digiflazzBrand: { startsWith: "Mobile Legends" } } });
          expect(ml).toHaveLength(4); // fully split and committed
          const ffAfter = await prisma.product.findUniqueOrThrow({ where: { id: productB.id } });
          expect(ffAfter.name).toBe("Free Fire"); // untouched — its transaction rolled back
          const ffDenoms = await prisma.denomination.findMany({ where: { productId: productB.id } });
          expect(ffDenoms).toHaveLength(2); // neither moved nor stripped
          expect(ffDenoms.some((d) => d.name.includes("Malaysia"))).toBe(true);
        } else {
          expect(result.productsCreated).toBe(1); // Free Fire's 1 non-winning region
          const ff = await prisma.product.findMany({ where: { digiflazzBrand: { startsWith: "Free Fire" } } });
          expect(ff).toHaveLength(2); // fully split and committed
          const mlAfter = await prisma.product.findFirstOrThrow({ where: { name: "Mobile Legends" } });
          const mlDenoms = await prisma.denomination.findMany({ where: { productId: mlAfter.id } });
          expect(mlDenoms).toHaveLength(10); // untouched — its transaction rolled back
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Re-review Finding C: the slug-skip decision must compare SLUGS, not
  // names — comparing names could mis-fire "changed" when a product's `name`
  // differs from its `digiflazzBrand`-derived displayName only in ways that
  // slugify identically (case here), needlessly calling ensureUniqueSlug and
  // corrupting a live storefront URL that isn't actually changing.
  it("Finding C: does not regenerate the slug when the winning bucket's displayName differs from the current name only in ways that slugify identically", async () => {
    const category = await prisma.category.findFirstOrThrow();
    // name and digiflazzBrand deliberately differ only in case — both
    // slugify to "free-fire", so the slug must NOT be regenerated even
    // though the old name !== displayName check would have said it changed.
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Free Fire",
      digiflazzBrand: "FREE FIRE",
    });
    const originalSlug = product.slug;
    expect(originalSlug).toBe("free-fire");

    // Unspecified (2) beats Malaysia (1) — the null bucket wins and its
    // displayName is the raw digiflazzBrand ("FREE FIRE"), unstripped.
    await createDenomination(prisma, {
      productId: product.id, name: "100 Diamond", type: "SHARED", durationLabel: "100 Diamond",
      price: "10000", autoDeliverySource: "digiflazz", supplierSku: "ff-1",
    });
    await createDenomination(prisma, {
      productId: product.id, name: "200 Diamond", type: "SHARED", durationLabel: "200 Diamond",
      price: "19000", autoDeliverySource: "digiflazz", supplierSku: "ff-2",
    });
    await createDenomination(prisma, {
      productId: product.id, name: "100 Diamond (Malaysia)", type: "SHARED", durationLabel: "100 Diamond (Malaysia)",
      price: "10000", autoDeliverySource: "digiflazz", supplierSku: "ff-my",
    });

    const result = await splitMixedDigiflazzProducts(prisma);
    expect(result.productsSplit).toBe(1);
    expect(result.failures).toEqual([]);

    const winner = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(winner.name).toBe("FREE FIRE"); // renamed to the digiflazzBrand casing
    expect(winner.slug).toBe(originalSlug); // slug untouched — no spurious "-2"
  });

  // Third-round review, Finding 1 (Important): the slug-skip guard had
  // regressed to comparing ONLY slugs, dropping the earlier name-based
  // guard entirely instead of combining the two. Product slugs are frozen at
  // creation and ensureUniqueSlug appends "-2", "-3", ... on a name
  // collision — so a product can legitimately have name "Valorant" but slug
  // "valorant-2" because a DIFFERENT, unrelated product already held the
  // plain "valorant" slug when this one was created. Seed exactly that via
  // createCatalogProduct's real slug-dedup path (not a hand-written "-2"
  // suffix), so the winning bucket's displayName equals plan.originalName
  // (the product is NOT being renamed) while slugify(displayName) !==
  // plan.originalSlug (because the slug carries the "-2" from the earlier
  // collision) — exactly the case the slug-only check got wrong.
  it("Finding 1: does not cascade a product's deduped '-2' slug into '-3' when its name isn't actually changing", async () => {
    const category = await prisma.category.findFirstOrThrow();

    // An unrelated, earlier product that claims the plain "valorant" slug —
    // NOT part of the Digiflazz split candidate set (no digiflazzBrand).
    await createCatalogProduct(prisma, { categoryId: category.id, name: "Valorant" });

    // The actual Digiflazz-backed product: same name, so createCatalogProduct's
    // own ensureUniqueSlug call naturally dedupes it to "valorant-2".
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Valorant",
      digiflazzBrand: "Valorant",
    });
    expect(product.slug).toBe("valorant-2");

    // Unspecified (2) beats Malaysia (1) — the null bucket wins, and its
    // displayName is exactly the raw digiflazzBrand/name "Valorant", i.e.
    // the product is genuinely not being renamed.
    await createDenomination(prisma, {
      productId: product.id, name: "100 Points", type: "SHARED", durationLabel: "100 Points",
      price: "16500", autoDeliverySource: "digiflazz", supplierSku: "vp-1",
    });
    await createDenomination(prisma, {
      productId: product.id, name: "200 Points", type: "SHARED", durationLabel: "200 Points",
      price: "31000", autoDeliverySource: "digiflazz", supplierSku: "vp-2",
    });
    await createDenomination(prisma, {
      productId: product.id, name: "100 Points (Malaysia)", type: "SHARED", durationLabel: "100 Points (Malaysia)",
      price: "16500", autoDeliverySource: "digiflazz", supplierSku: "vp-my",
    });

    const result = await splitMixedDigiflazzProducts(prisma);
    expect(result.productsSplit).toBe(1);
    expect(result.failures).toEqual([]);

    const winner = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(winner.name).toBe("Valorant");
    // The bug: the slug-only guard would see slugify("Valorant") ===
    // "valorant" !== "valorant-2" and call ensureUniqueSlug, which finds
    // both "valorant" and "valorant-2" taken and returns "valorant-3" —
    // silently rewriting a live storefront URL for a product whose name
    // never changed. The fix keeps it at "valorant-2".
    expect(winner.slug).toBe("valorant-2");
  });
});

describe("splitMixedTypeProducts / detectMixedTypeProducts", () => {
  /** Seed one Digiflazz Product ("Arena Breakout") whose denominations split
   * across 2 type buckets (base "Umum" + "Infinite") with UNEVEN counts, and
   * build the `typeMap` a fresh `getPriceList()` fetch would have produced
   * for these SKUs. `baseCount`/`suffixCount` let callers control which
   * bucket wins (larger count) without duplicating this setup per test. */
  async function seedMixedTypeProduct(
    categoryId: number,
    opts: { brand?: string; baseCount: number; suffixCount: number; suffix?: string } = { baseCount: 3, suffixCount: 5 },
  ) {
    const brand = opts.brand ?? "Arena Breakout";
    const suffix = opts.suffix ?? "Infinite";
    const product = await createCatalogProduct(prisma, {
      categoryId,
      name: brand,
      digiflazzBrand: brand,
    });
    const typeMap = new Map<string, string | null>();
    const denomsBySuffix = new Map<string | null, { id: number; name: string }[]>();

    const buckets: [string | null, number][] = [
      [null, opts.baseCount],
      [suffix, opts.suffixCount],
    ];
    let sku = 0;
    for (const [bucketSuffix, count] of buckets) {
      const records: { id: number; name: string }[] = [];
      for (let i = 0; i < count; i++) {
        sku++;
        const name = bucketSuffix
          ? `${brand} ${bucketSuffix} ${1000 * (i + 1)} Bonds`
          : `${brand} ${1000 * (i + 1)} Bonds`;
        const supplierSku = `ab-${bucketSuffix ?? "umum"}-${sku}`;
        const denom = await createDenomination(prisma, {
          productId: product.id,
          name,
          type: "SHARED",
          durationLabel: name,
          price: "16500",
          autoDeliverySource: "digiflazz",
          supplierSku,
        });
        records.push({ id: denom.id, name });
        typeMap.set(supplierSku, bucketSuffix);
      }
      denomsBySuffix.set(bucketSuffix, records);
    }
    return { product, denomsBySuffix, typeMap, brand, suffix };
  }

  it("1. detects and splits a product whose denominations map to 2 distinct suffixes into 2 products, with correct gameVariant and bucket sizes", async () => {
    const category = await prisma.category.findFirstOrThrow();
    // Infinite (5) > Umum (3) — Infinite is the unambiguous winner.
    const { product, typeMap } = await seedMixedTypeProduct(category.id, { baseCount: 3, suffixCount: 5 });

    const result = await splitMixedTypeProducts(prisma, typeMap);
    expect(result).toEqual({
      productsSplit: 1,
      productsCreated: 1,
      denominationsMoved: 3,
      skipped: [],
      conflicts: [],
      unmapped: [],
      failures: [],
    });

    const winner = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(winner.name).toBe("Arena Breakout Infinite");
    expect(winner.digiflazzBrand).toBe("Arena Breakout Infinite");
    expect(winner.gameVariant).toBe("Infinite");
    const winnerDenoms = await prisma.denomination.findMany({ where: { productId: product.id } });
    expect(winnerDenoms).toHaveLength(5);

    const created = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: "Arena Breakout" } });
    expect(created.id).not.toBe(product.id);
    expect(created.gameVariant).toBe("Umum");
    const createdDenoms = await prisma.denomination.findMany({ where: { productId: created.id } });
    expect(createdDenoms).toHaveLength(3);
  });

  it("2. winner keeps productId and slug unchanged when the winning (larger) bucket is the base edition; the smaller bucket becomes a new product", async () => {
    const category = await prisma.category.findFirstOrThrow();
    // Umum (5) > Infinite (3) — base bucket wins, and its displayName equals
    // the product's current name/digiflazzBrand, so nothing is "renamed".
    const { product, typeMap } = await seedMixedTypeProduct(category.id, { baseCount: 5, suffixCount: 3 });
    const originalSlug = product.slug;

    const result = await splitMixedTypeProducts(prisma, typeMap);
    expect(result.productsSplit).toBe(1);
    expect(result.productsCreated).toBe(1);

    const winner = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(winner.id).toBe(product.id);
    expect(winner.slug).toBe(originalSlug);
    expect(winner.name).toBe("Arena Breakout");

    const created = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: "Arena Breakout Infinite" } });
    expect(created.id).not.toBe(product.id);
  });

  it("3. tie-break: equal bucket sizes resolve to the base (null suffix) edition winning", async () => {
    const category = await prisma.category.findFirstOrThrow();
    // 6 Umum / 6 Infinite, matching the plan's own worked example.
    const { product, typeMap } = await seedMixedTypeProduct(category.id, { baseCount: 6, suffixCount: 6 });

    await splitMixedTypeProducts(prisma, typeMap);

    const winner = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(winner.name).toBe("Arena Breakout");
    expect(winner.digiflazzBrand).toBe("Arena Breakout");
    const winnerDenoms = await prisma.denomination.findMany({ where: { productId: product.id } });
    expect(winnerDenoms).toHaveLength(6);

    const created = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: "Arena Breakout Infinite" } });
    const createdDenoms = await prisma.denomination.findMany({ where: { productId: created.id } });
    expect(createdDenoms).toHaveLength(6);
  });

  it("4. gameVariant is non-null on both sides of a real split, even when the winner is the base bucket", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { product, typeMap } = await seedMixedTypeProduct(category.id, { baseCount: 6, suffixCount: 6 });

    await splitMixedTypeProducts(prisma, typeMap);

    const winner = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(winner.gameVariant).toBe("Umum"); // NOT null — this product is provably mixed
    const created = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: "Arena Breakout Infinite" } });
    expect(created.gameVariant).toBe("Infinite");
  });

  it("5. the new product's digiflazzBrand matches what a fresh import of equivalent data would produce", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { typeMap } = await seedMixedTypeProduct(category.id, { baseCount: 3, suffixCount: 5 });

    await splitMixedTypeProducts(prisma, typeMap);
    const createdWinnerBucket = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: "Arena Breakout" } });

    // Cross-check against groupDigiflazzPriceListByBrand's own displayName
    // for equivalent fresh-import input — the two paths must never name a
    // split differently.
    const freshRows: DigiflazzPriceListItem[] = [
      {
        buyerSkuCode: "fresh-umum-1",
        productName: "Arena Breakout 1000 Bonds",
        category: "Games",
        brand: "Arena Breakout",
        type: "Umum",
        price: new Decimal(1000),
        buyerProductStatus: true,
        sellerProductStatus: true,
        stock: null,
      },
      {
        buyerSkuCode: "fresh-inf-1",
        productName: "Arena Breakout Infinite 1000 Bonds",
        category: "Games",
        brand: "Arena Breakout",
        type: "Infinite",
        price: new Decimal(1000),
        buyerProductStatus: true,
        sellerProductStatus: true,
        stock: null,
      },
    ];
    const freshGroups = await groupDigiflazzPriceListByBrand(prisma, freshRows);
    const freshBaseGroup = freshGroups.find((g) => g.gameVariant === "Umum")!;
    const freshInfiniteGroup = freshGroups.find((g) => g.gameVariant === "Infinite")!;

    expect(createdWinnerBucket.digiflazzBrand).toBe(freshBaseGroup.brand);
    const migratedInfinite = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: "Arena Breakout Infinite" } });
    expect(migratedInfinite.digiflazzBrand).toBe(freshInfiniteGroup.brand);
  });

  it("6. denomination names/durationLabels are NOT rewritten — byte-identical before and after, for both a staying and a moved denomination", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { denomsBySuffix, typeMap } = await seedMixedTypeProduct(category.id, { baseCount: 3, suffixCount: 5 });
    const beforeByName = new Map<number, string>();
    for (const records of denomsBySuffix.values()) {
      for (const r of records) beforeByName.set(r.id, r.name);
    }

    await splitMixedTypeProducts(prisma, typeMap);

    for (const [id, nameBefore] of beforeByName) {
      const denom = await prisma.denomination.findUniqueOrThrow({ where: { id } });
      expect(denom.name).toBe(nameBefore);
      expect(denom.durationLabel).toBe(nameBefore);
    }
  });

  it("7. is a full no-op on a second run over the same (now-split) data", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { typeMap } = await seedMixedTypeProduct(category.id, { baseCount: 3, suffixCount: 5 });
    await splitMixedTypeProducts(prisma, typeMap);

    const second = await splitMixedTypeProducts(prisma, typeMap);
    expect(second.productsSplit).toBe(0);
    expect(second.productsCreated).toBe(0);
    expect(second.denominationsMoved).toBe(0);
    expect(second.unmapped).toEqual([]);
    expect(second.skipped.sort()).toEqual(["Arena Breakout Infinite", "Arena Breakout"].sort());

    const detection = await detectMixedTypeProducts(prisma, typeMap);
    expect(detection.mixed).toHaveLength(0);
  });

  it("8. collision guard: a target displayName already belongs to a different existing product excludes the whole plan into conflicts, product completely untouched", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { product, typeMap } = await seedMixedTypeProduct(category.id, { baseCount: 3, suffixCount: 5 });
    const denomsBefore = await prisma.denomination.findMany({ where: { productId: product.id } });

    // Simulate: a fresh type-aware import already created the "Infinite"
    // edition product before this migration ran on the old mixed data.
    const preExisting = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Arena Breakout Infinite",
      digiflazzBrand: "Arena Breakout Infinite",
    });

    const result = await splitMixedTypeProducts(prisma, typeMap);
    expect(result.productsSplit).toBe(0);
    expect(result.productsCreated).toBe(0);
    expect(result.denominationsMoved).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toContain("Arena Breakout Infinite");
    expect(result.conflicts[0]).toContain(String(preExisting.id));
    expect(result.conflicts[0]).toContain(String(product.id));

    const original = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(original.name).toBe("Arena Breakout");
    expect(original.digiflazzBrand).toBe("Arena Breakout");
    const denomsAfter = await prisma.denomination.findMany({ where: { productId: product.id } });
    expect(denomsAfter.map((d) => d.id).sort()).toEqual(denomsBefore.map((d) => d.id).sort());

    const detection = await detectMixedTypeProducts(prisma, typeMap);
    expect(detection.mixed).toHaveLength(0);
    expect(detection.conflicts).toHaveLength(1);
  });

  it("9. detectMixedTypeProducts is read-only — computes the plan without writing anything", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { product, typeMap } = await seedMixedTypeProduct(category.id, { baseCount: 3, suffixCount: 5 });

    const detection = await detectMixedTypeProducts(prisma, typeMap);
    expect(detection.mixed).toHaveLength(1);
    expect(detection.mixed[0]!.productId).toBe(product.id);
    // Winning bucket (largest count) is first.
    expect(detection.mixed[0]!.groups[0]!.suffix).toBe("Infinite");

    const unchanged = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(unchanged.name).toBe("Arena Breakout");
    expect(unchanged.gameVariant).toBeNull();
    const denoms = await prisma.denomination.findMany({ where: { productId: product.id } });
    expect(denoms).toHaveLength(8);
  });

  describe("10. per-product failure isolation", () => {
    it("continues splitting the other product when one product's transaction throws, and reports the failure without losing the other's result", async () => {
      const category = await prisma.category.findFirstOrThrow();
      const first = await seedMixedTypeProduct(category.id, { baseCount: 3, suffixCount: 5 });
      const second = await seedMixedTypeProduct(category.id, {
        brand: "Free Fire Max",
        baseCount: 2,
        suffixCount: 1,
        suffix: "Garena",
      });
      const combinedTypeMap = new Map<string, string | null>([...first.typeMap, ...second.typeMap]);

      const originalTransaction = prisma.$transaction.bind(prisma);
      let callIndex = 0;
      const spy = vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: unknown[]) => {
        callIndex++;
        if (callIndex === 2) {
          throw new Error("Simulated transient DB failure");
        }
        return (originalTransaction as (...a: unknown[]) => unknown)(...args);
      }) as typeof prisma.$transaction);

      try {
        const result = await splitMixedTypeProducts(prisma, combinedTypeMap);

        expect(result.failures).toHaveLength(1);
        expect(result.productsSplit).toBe(1);
        expect(result.failures[0]!.error).toContain("Simulated transient DB failure");
        expect(["Arena Breakout", "Free Fire Max"]).toContain(result.failures[0]!.productName);

        if (result.failures[0]!.productName === "Free Fire Max") {
          const ab = await prisma.product.findMany({ where: { digiflazzBrand: { startsWith: "Arena Breakout" } } });
          expect(ab).toHaveLength(2); // fully split and committed
          const ffAfter = await prisma.product.findUniqueOrThrow({ where: { id: second.product.id } });
          expect(ffAfter.name).toBe("Free Fire Max"); // untouched — its transaction rolled back
          const ffDenoms = await prisma.denomination.findMany({ where: { productId: second.product.id } });
          expect(ffDenoms).toHaveLength(3); // neither moved nor rewritten
        } else {
          const ff = await prisma.product.findMany({ where: { digiflazzBrand: { startsWith: "Free Fire Max" } } });
          expect(ff).toHaveLength(2); // fully split and committed
          const abAfter = await prisma.product.findFirstOrThrow({ where: { name: "Arena Breakout" } });
          const abDenoms = await prisma.denomination.findMany({ where: { productId: abAfter.id } });
          expect(abDenoms).toHaveLength(8); // untouched — its transaction rolled back
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("11. calls logAdminAction exactly once per split product, with adminId: null and action digiflazz_catalog_type_split", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { product, typeMap } = await seedMixedTypeProduct(category.id, { baseCount: 3, suffixCount: 5 });

    await splitMixedTypeProducts(prisma, typeMap);

    const entries = await prisma.auditLog.findMany({
      where: { action: "digiflazz_catalog_type_split", targetId: product.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.adminId).toBeNull();
    expect(entries[0]!.details).toContain("Arena Breakout");
    expect(entries[0]!.details).toContain("2 edition products");
  });

  it("12. a denomination that can't be mapped to a type excludes the whole product into unmapped, leaving it completely untouched", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Genshin Impact",
      digiflazzBrand: "Genshin Impact",
    });
    // This denomination WOULD otherwise indicate a split (maps to "Infinite")...
    const mapped = await createDenomination(prisma, {
      productId: product.id,
      name: "Genshin Impact Infinite 100 Crystal",
      type: "SHARED",
      durationLabel: "Genshin Impact Infinite 100 Crystal",
      price: "16500",
      autoDeliverySource: "digiflazz",
      supplierSku: "gi-inf-1",
    });
    // ...but this one's supplierSku is absent from typeMap (a manually-added
    // SKU, or one Digiflazz has retired).
    const unmappedDenom = await createDenomination(prisma, {
      productId: product.id,
      name: "Genshin Impact 100 Crystal",
      type: "SHARED",
      durationLabel: "Genshin Impact 100 Crystal",
      price: "16500",
      autoDeliverySource: "digiflazz",
      supplierSku: "gi-manual-1",
    });
    const typeMap = new Map<string, string | null>([["gi-inf-1", "Infinite"]]);

    const detection = await detectMixedTypeProducts(prisma, typeMap);
    expect(detection.mixed).toHaveLength(0);
    expect(detection.skipped).toEqual([]);
    expect(detection.unmapped).toHaveLength(1);
    expect(detection.unmapped[0]!.productId).toBe(product.id);
    expect(detection.unmapped[0]!.productName).toBe("Genshin Impact");
    expect(detection.unmapped[0]!.denominationNames).toEqual(["Genshin Impact 100 Crystal"]);

    const result = await splitMixedTypeProducts(prisma, typeMap);
    expect(result.productsSplit).toBe(0);
    expect(result.productsCreated).toBe(0);
    expect(result.unmapped).toHaveLength(1);

    const unchanged = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(unchanged.name).toBe("Genshin Impact");
    const mappedAfter = await prisma.denomination.findUniqueOrThrow({ where: { id: mapped.id } });
    expect(mappedAfter.productId).toBe(product.id);
    const unmappedAfter = await prisma.denomination.findUniqueOrThrow({ where: { id: unmappedDenom.id } });
    expect(unmappedAfter.productId).toBe(product.id);
  });

  it("13. region-then-type: a product already split by region (digiflazzBrand carries a region parenthetical) produces correctly-composed names, not a malformed concatenation", async () => {
    const category = await prisma.category.findFirstOrThrow();
    // Simulates a product that already went through the region migration —
    // its digiflazzBrand carries a trailing region suffix.
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Foo (Indonesia)",
      digiflazzBrand: "Foo (Indonesia)",
    });
    await createDenomination(prisma, {
      productId: product.id,
      name: "Foo 100 Gold (Indonesia)",
      type: "SHARED",
      durationLabel: "Foo 100 Gold (Indonesia)",
      price: "16500",
      autoDeliverySource: "digiflazz",
      supplierSku: "foo-umum-1",
    });
    await createDenomination(prisma, {
      productId: product.id,
      name: "Foo Infinite 100 Gold (Indonesia)",
      type: "SHARED",
      durationLabel: "Foo Infinite 100 Gold (Indonesia)",
      price: "16500",
      autoDeliverySource: "digiflazz",
      supplierSku: "foo-inf-1",
    });
    await createDenomination(prisma, {
      productId: product.id,
      name: "Foo Infinite 200 Gold (Indonesia)",
      type: "SHARED",
      durationLabel: "Foo Infinite 200 Gold (Indonesia)",
      price: "31000",
      autoDeliverySource: "digiflazz",
      supplierSku: "foo-inf-2",
    });
    const typeMap = new Map<string, string | null>([
      ["foo-umum-1", null],
      ["foo-inf-1", "Infinite"],
      ["foo-inf-2", "Infinite"],
    ]);

    const result = await splitMixedTypeProducts(prisma, typeMap);
    expect(result.productsSplit).toBe(1);
    expect(result.productsCreated).toBe(1);
    expect(result.failures).toEqual([]);

    // Infinite (2) wins over Umum (1) and keeps the original product id.
    const winner = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(winner.name).toBe("Foo Infinite (Indonesia)");
    expect(winner.digiflazzBrand).toBe("Foo Infinite (Indonesia)");
    expect(winner.name).not.toBe("Foo (Indonesia) Infinite"); // malformed concatenation

    const created = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: "Foo (Indonesia)" } });
    expect(created.id).not.toBe(product.id);
    expect(created.name).toBe("Foo (Indonesia)");
  });

  // Final whole-branch review Critical finding: importDigiflazzBrand and
  // splitMixedDigiflazzProducts both unconditionally strip the region suffix
  // off every denomination name they write (stripRegionSuffix), so a REAL
  // region-suffixed product's denomination names never carry the region —
  // unlike test 13 above, whose fixture (denom names DO carry "(Indonesia)")
  // happened to mask the bug. This test uses the realistic shape: region
  // lives ONLY on digiflazzBrand, never on a denomination name.
  it("13b. region-then-type with REALISTIC (already-stripped) denomination names: region is recovered from digiflazzBrand, not lost", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Mobile Legends (Indonesia)",
      digiflazzBrand: "Mobile Legends (Indonesia)",
    });
    // Denomination names carry NO region suffix — exactly what
    // importDigiflazzBrand's stripRegionSuffix(row.productName) produces.
    await createDenomination(prisma, {
      productId: product.id,
      name: "ML 100 Diamond",
      type: "SHARED",
      durationLabel: "ML 100 Diamond",
      price: "16500",
      autoDeliverySource: "digiflazz",
      supplierSku: "ml-umum-1",
    });
    await createDenomination(prisma, {
      productId: product.id,
      name: "ML Infinite 500 Diamond",
      type: "SHARED",
      durationLabel: "ML Infinite 500 Diamond",
      price: "80000",
      autoDeliverySource: "digiflazz",
      supplierSku: "ml-inf-1",
    });
    const typeMap = new Map<string, string | null>([
      ["ml-umum-1", null],
      ["ml-inf-1", "Infinite"],
    ]);

    const result = await splitMixedTypeProducts(prisma, typeMap);
    expect(result.failures).toEqual([]);
    expect(result.productsSplit).toBe(1);
    expect(result.productsCreated).toBe(1);

    // Umum (1) ties Infinite (1) on count -> base wins the tie-break and
    // keeps the original product id, VERBATIM (region never dropped).
    const winner = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(winner.digiflazzBrand).toBe("Mobile Legends (Indonesia)");
    expect(winner.name).toBe("Mobile Legends (Indonesia)");

    const created = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: { contains: "Infinite" } } });
    expect(created.id).not.toBe(product.id);
    // The region must survive onto the new edition product too.
    expect(created.digiflazzBrand).toBe("Mobile Legends Infinite (Indonesia)");
  });

  it("13c. region x type dedupe on the migration path: a type suffix matching the brand's own region folds into one, not a doubled parenthetical", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const product = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Free Fire (Global)",
      digiflazzBrand: "Free Fire (Global)",
    });
    await createDenomination(prisma, {
      productId: product.id,
      name: "FF 100 Diamond",
      type: "SHARED",
      durationLabel: "FF 100 Diamond",
      price: "15000",
      autoDeliverySource: "digiflazz",
      supplierSku: "ff-umum-1",
    });
    await createDenomination(prisma, {
      productId: product.id,
      name: "FF Global 200 Diamond",
      type: "SHARED",
      durationLabel: "FF Global 200 Diamond",
      price: "30000",
      autoDeliverySource: "digiflazz",
      supplierSku: "ff-global-1",
    });
    await createDenomination(prisma, {
      productId: product.id,
      name: "FF Global 500 Diamond",
      type: "SHARED",
      durationLabel: "FF Global 500 Diamond",
      price: "70000",
      autoDeliverySource: "digiflazz",
      supplierSku: "ff-global-2",
    });
    const typeMap = new Map<string, string | null>([
      ["ff-umum-1", null],
      ["ff-global-1", "Global"],
      ["ff-global-2", "Global"],
    ]);

    const result = await splitMixedTypeProducts(prisma, typeMap);
    expect(result.failures).toEqual([]);

    // Global (2) wins over Umum (1) and keeps the original product id.
    const winner = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(winner.digiflazzBrand).toBe("Free Fire Global");
    expect(winner.digiflazzBrand).not.toBe("Free Fire Global (Global)");

    const created = await prisma.product.findFirstOrThrow({ where: { digiflazzBrand: "Free Fire (Global)" } });
    expect(created.id).not.toBe(product.id);
  });

  it("14. a non-mixed product (all denominations map to the same suffix, including all-base) stays in skipped, untouched", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { typeMap } = await seedMixedTypeProduct(category.id, { baseCount: 3, suffixCount: 5 });

    // All-base product: every denomination maps to null (Umum).
    const allBaseProduct = await createCatalogProduct(prisma, {
      categoryId: category.id,
      name: "Pulsa Telkomsel",
      digiflazzBrand: "Pulsa Telkomsel",
    });
    const pulsaDenom = await createDenomination(prisma, {
      productId: allBaseProduct.id,
      name: "Pulsa 10.000",
      type: "SHARED",
      durationLabel: "Pulsa 10.000",
      price: "10500",
      autoDeliverySource: "digiflazz",
      supplierSku: "pulsa-10k",
    });
    typeMap.set("pulsa-10k", null);

    const result = await splitMixedTypeProducts(prisma, typeMap);
    expect(result.skipped).toContain("Pulsa Telkomsel");
    expect(result.productsSplit).toBe(1); // only the seeded mixed product

    const pulsaAfter = await prisma.product.findUniqueOrThrow({ where: { id: allBaseProduct.id } });
    expect(pulsaAfter.name).toBe("Pulsa Telkomsel");
    const pulsaDenomAfter = await prisma.denomination.findUniqueOrThrow({ where: { id: pulsaDenom.id } });
    expect(pulsaDenomAfter.productId).toBe(allBaseProduct.id);
  });
});
