// Game top-up details on the buyer's pay page (GET /api/v1/orders/:code/pay)
// and order detail (GET /api/v1/account/orders/:code): `product_slug`,
// `game_target` (only through the denomination's input mapping) and `sn`
// (the decrypted Digiflazz serial number, owner-only, DELIVERED only).
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import { prisma, initDb, setSetting, createCategory, createCatalogProduct, createDenomination } from "@app/db";
import { OrderStatus } from "@app/core/enums";
import { encryptDeliveredContent } from "@app/core/credentialCrypto";
import { logger } from "@app/core/logger";
import { newJti, shopSessionJtiKey, makeCustomerSession, SHOP_COOKIE_NAME } from "../src/auth";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let gameDenomId: number;
let gameSlug: string;
let premiumDenomId: number;
let premiumSlug: string;

const fields = JSON.stringify([
  { key: "uid", label: { id: "UID", en: "UID" }, type: "text", required: true },
  { key: "zone", label: { id: "Zone", en: "Zone" }, type: "text", required: true },
  { key: "password", label: { id: "Sandi", en: "Password" }, type: "text", required: false },
  { key: "email", label: { id: "Email", en: "Email" }, type: "text", required: false },
]);
const answers = [{ uid: "12345678", zone: "2201", password: "hunter2-secret", email: "buyer@example.com" }];
const LONG_SN = "SN" + "ab12-".repeat(40);

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  const gameCat = await createCategory(prisma, { name: "Game Details Cat", group: "GAME_TOPUP" });
  const game = await createCatalogProduct(prisma, { categoryId: gameCat.id, name: "Game Details Legends" });
  gameSlug = game.slug;
  gameDenomId = (await createDenomination(prisma, {
    productId: game.id, name: "86 Diamonds", type: "SHARED", durationLabel: "1x", price: "15000",
    autoDeliverySource: "digiflazz", additionalFields: fields,
  })).id;
  const premiumCat = await createCategory(prisma, { name: "Premium Details Cat", group: "PREMIUM_APPS" });
  const premium = await createCatalogProduct(prisma, { categoryId: premiumCat.id, name: "Premium Details App" });
  premiumSlug = premium.slug;
  premiumDenomId = (await createDenomination(prisma, {
    productId: premium.id, name: "1 Month", type: "SHARED", durationLabel: "1 month", price: "15000",
  })).id;
  await setSetting(prisma, "setup_completed", "true");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

let counter = 0;
async function makeCustomer(opts: { guest?: boolean; scope?: string } = {}) {
  counter += 1;
  const user = await prisma.user.create({
    data: { telegramId: 930_000 + counter, referralCode: `GTD${counter}`, ...(opts.guest ? { isGuest: true } : {}) },
  });
  const jti = newJti();
  await setSetting(prisma, shopSessionJtiKey(user.id), jti);
  return { userId: user.id, cookie: makeCustomerSession(user.id, user.telegramId, jti, opts.scope).raw };
}

async function makeOrder(userId: number, opts: { denomId?: number; status?: string; sn?: string | null; deliveredContent?: (id: number) => string } = {}) {
  counter += 1;
  const order = await prisma.order.create({
    data: {
      orderCode: `ORD-GTD-${counter}`, userId, subtotalAmount: "15000", totalAmount: "15000",
      status: opts.status ?? OrderStatus.DELIVERED, currency: "IDR", paymentMethod: "TOKOPAY", paymentState: "PAID", kind: "PRODUCT",
      customerData: JSON.stringify(answers),
      items: { create: [{ productId: opts.denomId ?? gameDenomId, quantity: 1, unitPrice: "15000", warrantyDaysSnapshot: 0 }] },
    },
  });
  const deliveredContent = opts.deliveredContent ? opts.deliveredContent(order.id)
    : opts.sn === null ? null : encryptDeliveredContent(opts.sn ?? LONG_SN, order.id);
  return prisma.order.update({ where: { id: order.id }, data: { deliveredContent } });
}

const get = (url: string, cookie: string) => app.inject({ method: "GET", url, cookies: { [SHOP_COOKIE_NAME]: cookie } });
const routes = (code: string) => [`/api/v1/orders/${code}/pay`, `/api/v1/account/orders/${code}`];

describe("game top-up details on the pay and order-detail payloads", () => {
  it("gives the owner the full long SN, the mapped Game ID / Zone and the product slug", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeOrder(userId);
    for (const url of routes(order.orderCode)) {
      const res = await get(url, cookie);
      expect(res.statusCode, url).toBe(200);
      const body = res.json();
      expect(body.product_slug).toBe(gameSlug);
      expect(body.game_target).toEqual([{ game_id: "12345678", zone_id: "2201" }]);
      expect(body.sn).toBe(LONG_SN);
      expect(LONG_SN.length).toBe(202);
    }
  });

  it("never sends another answer (password, e-mail) through game_target", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeOrder(userId);
    for (const url of routes(order.orderCode)) {
      const body = (await get(url, cookie)).json();
      expect(JSON.stringify(body.game_target)).not.toMatch(/hunter2|buyer@example|password|email/);
    }
    // The pay page carries no customer answers at all.
    expect((await get(routes(order.orderCode)[0]!, cookie)).body).not.toMatch(/hunter2|buyer@example/);
  });

  it("a non-owner gets 404 with no sn or game_target", async () => {
    const owner = await makeCustomer();
    const other = await makeCustomer();
    const order = await makeOrder(owner.userId);
    for (const url of routes(order.orderCode)) {
      const res = await get(url, other.cookie);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(LONG_SN);
      expect(res.json()).not.toHaveProperty("sn");
      expect(res.json()).not.toHaveProperty("game_target");
    }
  });

  it("a guest reaching the order through /track's scoped session gets the same details", async () => {
    counter += 1;
    const user = await prisma.user.create({ data: { telegramId: 930_000 + counter, referralCode: `GTD${counter}`, isGuest: true } });
    const order = await makeOrder(user.id);
    const jti = newJti();
    await setSetting(prisma, shopSessionJtiKey(user.id), jti);
    const cookie = makeCustomerSession(user.id, user.telegramId, jti, order.orderCode).raw;
    for (const url of routes(order.orderCode)) {
      const body = (await get(url, cookie)).json();
      expect(body.sn).toBe(LONG_SN);
      expect(body.game_target).toEqual([{ game_id: "12345678", zone_id: "2201" }]);
    }
  });

  it("a processing order has no SN yet but still shows its Game ID", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeOrder(userId, { status: OrderStatus.PROCESSING });
    for (const url of routes(order.orderCode)) {
      const body = (await get(url, cookie)).json();
      expect(body.sn).toBeNull();
      expect(body.game_target).toEqual([{ game_id: "12345678", zone_id: "2201" }]);
    }
  });

  it("an undecryptable SN becomes null with a content-free warning, not a crash", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeOrder(userId, { deliveredContent: (id) => {
      const envelope = JSON.parse(encryptDeliveredContent("SECRET-SN-PLAINTEXT", id)) as { authTag: string };
      envelope.authTag = Buffer.alloc(16).toString("base64");
      return JSON.stringify(envelope);
    } });
    const warn = vi.spyOn(logger, "warn");
    try {
      for (const url of routes(order.orderCode)) {
        const res = await get(url, cookie);
        expect(res.statusCode, url).toBe(200);
        expect(res.json().sn).toBeNull();
        expect(res.json().game_target).toEqual([{ game_id: "12345678", zone_id: "2201" }]);
      }
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ orderCode: order.orderCode, errorName: expect.any(String) }), expect.any(String));
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-SN-PLAINTEXT");
    } finally {
      warn.mockRestore();
    }
  });

  it("a Premium Apps order has product_slug but no game_target or sn, and still its credentials path", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeOrder(userId, { denomId: premiumDenomId, sn: "PREMIUM-DELIVERY" });
    for (const url of routes(order.orderCode)) {
      const body = (await get(url, cookie)).json();
      expect(body.product_slug).toBe(premiumSlug);
      expect(body.game_target).toBeNull();
      expect(body.sn).toBeNull();
    }
    const detail = (await get(routes(order.orderCode)[1]!, cookie)).json();
    expect(detail.order.delivered_content).toBe("PREMIUM-DELIVERY");
  });

  it("a game order's detail sends no stock credentials", async () => {
    const { userId, cookie } = await makeCustomer();
    const order = await makeOrder(userId);
    const detail = (await get(routes(order.orderCode)[1]!, cookie)).json();
    expect(detail.order.items.map((i: { credentials: unknown }) => i.credentials)).toEqual([null]);
  });

  it("the wallet top-up pay page is unaffected", async () => {
    const { userId, cookie } = await makeCustomer();
    counter += 1;
    const topup = await prisma.order.create({
      data: { orderCode: `ORD-GTD-W${counter}`, userId, subtotalAmount: "15000", totalAmount: "15000", status: OrderStatus.DELIVERED,
        currency: "IDR", paymentMethod: "TOKOPAY", kind: "WALLET_TOPUP" },
    });
    const res = await get(`/api/v1/wallet/topup/${topup.orderCode}/pay`, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty("product_slug");
    expect(body).not.toHaveProperty("game_target");
    expect(body).not.toHaveProperty("sn");
  });
});
