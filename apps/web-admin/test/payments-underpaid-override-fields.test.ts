/**
 * GET /api/payments — what each underpaid row carries so the Payments page can word "Deliver anyway" for the
 * order's own product family (Game Top Up: forward to the supplier; Premium Apps: deliver an account), and
 * POST /api/payments/credit — its audit entry when an admin-override order's credit is capped.
 *
 * The family comes from the category group (never a product name), the buyer's target is only ever the
 * decrypted display string for a game top-up, and a readonly admin's rows carry none of the new fields.
 */
import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { DeliveryType, PaymentMethod } from "@app/core/enums";
import { encryptCustomerData } from "@app/core/credentialCrypto";
import { prisma, initDb, setSetting, markUnderpaid, createOrderDirect, createInternalOrder, createWalletTopupOrder } from "@app/db";
import { routeDenominationToDigiflazz, routeOrderToDigiflazz, DIGIFLAZZ_CUSTOMER_DATA } from "../../../tests/helpers/digiflazzRouting";
import { resetDb, buildSampleData, type SampleData } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import { makeSession, sessionJtiKey, newJti, webRoleKey } from "../src/auth";

const ADMIN_TG = 999;
const COOKIE = config.WEB_COOKIE_NAME;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let sample: SampleData;

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
  sample = await buildSampleData(prisma);
  const admin = await prisma.user.create({ data: { telegramId: ADMIN_TG, username: "admin", fullName: "Admin", role: "ADMIN", referralCode: `a${Math.random()}` } });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

/** A real encrypted answers value whose authentication tag is damaged, so it can never be decrypted. */
function tamperedEnvelope(orderId: number): string {
  const envelope = JSON.parse(encryptCustomerData(DIGIFLAZZ_CUSTOMER_DATA, orderId)) as { authTag: string };
  envelope.authTag = Buffer.alloc(16, 1).toString("base64");
  return JSON.stringify(envelope);
}

let txCounter = 0;
const nextTx = () => `ovr-fields-${++txCounter}`;

async function flagUnderpaid(orderId: number) {
  expect(await markUnderpaid(prisma, { orderId, binanceTxId: nextTx(), amount: "1.00" })).toBe(true);
}

/** An UNDERPAID game order routed to Digiflazz, carrying the buyer's player id. */
async function underpaidGameOrder(opts: { group: "GAME_TOPUP" | null; provider?: "DIGIFLAZZ" | "MANUAL" }) {
  await prisma.category.update({ where: { id: sample.category.id }, data: { group: opts.group } });
  await routeDenominationToDigiflazz(prisma, sample.product.id);
  await prisma.denomination.update({ where: { id: sample.product.id }, data: { deliveryType: DeliveryType.MANUAL_WITH_INFO } });
  const order = (await createOrderDirect(prisma, {
    channel: "web", user: sample.user, productId: sample.product.id, quantity: 1, customerData: DIGIFLAZZ_CUSTOMER_DATA,
  }))!;
  if ((opts.provider ?? "DIGIFLAZZ") === "DIGIFLAZZ") await routeOrderToDigiflazz(prisma, order.id);
  else await prisma.order.update({ where: { id: order.id }, data: { fulfillmentProvider: opts.provider } });
  await flagUnderpaid(order.id);
  return order;
}

async function underpaidPremiumOrder() {
  await prisma.category.update({ where: { id: sample.category.id }, data: { group: "PREMIUM_APPS" } });
  const order = (await createOrderDirect(prisma, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
  await flagUnderpaid(order.id);
  return order;
}

async function listRows() {
  const res = await app.inject({ method: "GET", url: "/api/payments", cookies: { [COOKIE]: cookie } });
  expect(res.statusCode).toBe(200);
  return { rows: res.json().underpaid as Array<Record<string, unknown>>, raw: res.body };
}

describe("GET /api/payments — underpaid rows carry the override family fields", () => {
  it("a Game Top Up order fulfilled by Digiflazz: family, provider, product name and the buyer's decrypted target", async () => {
    const order = await underpaidGameOrder({ group: "GAME_TOPUP" });

    const { rows, raw } = await listRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: order.id,
      overrideFamily: "GAME_TOPUP",
      overrideProvider: "DIGIFLAZZ",
      overrideProductName: sample.product.name,
      overrideTarget: "123456789",
    });
    // The raw encrypted column never leaves the server, and the response holds no envelope.
    expect(rows[0]).not.toHaveProperty("customerData");
    expect(raw).not.toContain("ciphertext");
    expect(raw).not.toContain("authTag");
  });

  it("a Game Top Up order not fulfilled by Digiflazz is still a game top-up, with provider MANUAL", async () => {
    await underpaidGameOrder({ group: "GAME_TOPUP", provider: "MANUAL" });
    const { rows } = await listRows();
    expect(rows[0]).toMatchObject({ overrideFamily: "GAME_TOPUP", overrideProvider: "MANUAL", overrideTarget: "123456789" });
  });

  it("a Premium Apps stock order: family PREMIUM_APPS, provider STOCK, no target", async () => {
    await underpaidPremiumOrder();
    const { rows } = await listRows();
    expect(rows[0]).toMatchObject({ overrideFamily: "PREMIUM_APPS", overrideProvider: "STOCK", overrideProductName: sample.product.name, overrideTarget: null });
  });

  it("a Premium Apps order routed to the manual queue reports provider MANUAL and no target even if answers exist", async () => {
    const order = await underpaidPremiumOrder();
    await prisma.order.update({ where: { id: order.id }, data: { fulfillmentProvider: "MANUAL" } });
    const { rows } = await listRows();
    expect(rows[0]).toMatchObject({ overrideFamily: "PREMIUM_APPS", overrideProvider: "MANUAL", overrideTarget: null });
  });

  it("a legacy order whose category has no group and whose provider is DIGIFLAZZ is a game top-up", async () => {
    await underpaidGameOrder({ group: null });
    const { rows } = await listRows();
    expect(rows[0]).toMatchObject({ overrideFamily: "GAME_TOPUP", overrideProvider: "DIGIFLAZZ", overrideTarget: "123456789" });
  });

  it("a Premium Apps category stays Premium Apps even when the order is routed to Digiflazz", async () => {
    const order = await underpaidPremiumOrder();
    await routeOrderToDigiflazz(prisma, order.id);
    const { rows } = await listRows();
    expect(rows[0]).toMatchObject({ overrideFamily: "PREMIUM_APPS", overrideProvider: "DIGIFLAZZ", overrideTarget: null });
  });

  it("an answer that cannot be decrypted (tampered) gives no target instead of failing the list", async () => {
    const order = await underpaidGameOrder({ group: "GAME_TOPUP" });
    await prisma.order.update({ where: { id: order.id }, data: { customerData: tamperedEnvelope(order.id) } });
    const { rows } = await listRows();
    expect(rows[0]).toMatchObject({ overrideFamily: "GAME_TOPUP", overrideTarget: null });
  });

  it("a misconfigured encryption key gives that row no target instead of failing the whole list", async () => {
    const order = await underpaidGameOrder({ group: "GAME_TOPUP" });
    const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = "tooshort";
    try {
      const { rows, raw } = await listRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: order.id,
        overrideFamily: "GAME_TOPUP",
        overrideProvider: "DIGIFLAZZ",
        overrideProductName: sample.product.name,
        overrideTarget: null,
      });
      expect(raw).not.toContain("123456789");
    } finally {
      if (originalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
    }
  });

  it("a wallet top-up row carries none of the override fields", async () => {
    const topup = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "10", currency: "USDT", method: PaymentMethod.BINANCE_INTERNAL, rate: "16000" }),
    );
    await flagUnderpaid(topup.id);
    const { rows } = await listRows();
    expect(rows).toHaveLength(1);
    for (const key of ["overrideFamily", "overrideProvider", "overrideProductName", "overrideTarget"]) {
      expect(rows[0]).not.toHaveProperty(key);
    }
  });

  it("a readonly admin's rows carry none of the override fields and no target", async () => {
    await underpaidGameOrder({ group: "GAME_TOPUP" });
    await setSetting(prisma, webRoleKey(ADMIN_TG), "readonly");

    const { rows, raw } = await listRows();

    expect(rows).toHaveLength(1);
    for (const key of ["overrideFamily", "overrideProvider", "overrideProductName", "overrideTarget"]) {
      expect(rows[0]).not.toHaveProperty(key);
    }
    expect(raw).not.toContain("123456789");
  });
});

describe("POST /api/payments/credit — audit entry for an admin-override order", () => {
  function credit(binanceTxId: string, orderCode: string) {
    return app.inject({
      method: "POST",
      url: "/api/payments/credit",
      headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded" },
      cookies: { [COOKIE]: cookie },
      payload: new URLSearchParams({ binance_tx_id: binanceTxId, order_code: orderCode }).toString(),
    });
  }

  /** A USDT order of 5 delivered by an admin override after a 3.5 short payment, and a Binance transfer whose
   *  amount the ledger did not record (so the credit is the order total, capped by what arrived). */
  async function overrideUsdtOrder() {
    const order = (await prisma.$transaction((tx) =>
      createInternalOrder(tx, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1, rate: 1 }),
    ))!;
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "PROCESSING", paidAt: new Date(), paymentState: "UNDERPAID", completionMode: "ADMIN_OVERRIDE", completionReason: "short by a little" },
    });
    return order;
  }

  const auditDetails = async (orderId: number) =>
    (await prisma.auditLog.findFirst({ where: { action: "tx_credit_balance", targetId: orderId } }))?.details;

  it("says the credit was limited to what the buyer paid when the override cap applied", async () => {
    const order = await overrideUsdtOrder();
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "cap-1", orderId: order.id, amount: "3.5", outcome: "underpaid" } });
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "cap-evidence", outcome: "unmatched" } });

    const res = await credit("cap-evidence", order.orderCode);

    expect(res.statusCode).toBe(200);
    const details = await auditDetails(order.id);
    expect(details).toContain(`Credited transfer cap-evidence (3.5 USDT) to order ${order.orderCode}'s buyer balance.`);
    expect(details).toContain("limited to the amount the buyer actually paid on this underpaid order");
    expect(details).toContain(`order total ${order.totalAmount.toString()} USDT`);
  });

  it("an uncapped credit keeps its audit sentence exactly", async () => {
    const usdt = (await prisma.$transaction((tx) =>
      createInternalOrder(tx, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1, rate: 1 }),
    ))!;
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "plain-1", amount: "1.00", outcome: "unmatched" } });

    const res = await credit("plain-1", usdt.orderCode);

    expect(res.statusCode).toBe(200);
    expect(await auditDetails(usdt.id)).toBe(`Credited transfer plain-1 (1 USDT) to order ${usdt.orderCode}'s buyer balance.`);
  });

  it("an override order with no recorded payment is a 422 error.override_credit_nothing_received", async () => {
    const order = await overrideUsdtOrder();
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "nothing-1", outcome: "unmatched" } });

    const res = await credit("nothing-1", order.orderCode);

    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain("error.override_credit_nothing_received");
    expect(await auditDetails(order.id)).toBeUndefined();
  });
});
