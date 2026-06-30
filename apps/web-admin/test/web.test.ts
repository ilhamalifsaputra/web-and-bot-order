import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { ProductType, UserRole } from "@app/core/enums";
import {
  prisma,
  initDb,
  upsertUser,
  createCategory,
  createCatalogProduct,
  getCatalogProduct,
  getCatalogProductWithDenominations,
  getDenomination,
  createDenomination,
  updateDenomination,
  bulkAddStock,
  getUser,
  getUserByTelegramId,
  getOrder,
  createOrderDirect,
  finalizeOrderPayment,
  createWebUser,
  attachPaymentProof,
  createTicket,
  listTicketMessages,
  setSetting,
  getSetting,
  deleteSetting,
  getVoucherByCode,
  countAvailableStock,
  markUnderpaid,
  recordUnmatchedTx,
  listAuditLogs,
} from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import { setTokenValidator, setChannelValidator } from "../src/routes/settings";
import { setTokenValidator as setSetupTokenValidator } from "../src/routes/setup";
import { Decimal } from "@app/core/money";
import { setFxRateFetcher } from "@app/db";
import {
  makeSession,
  newJti,
  sessionJtiKey,
  passwordHashKey,
  hashPassword,
  verifyPassword,
  webRoleKey,
  twoFaSecretKey,
  twoFaPendingKey,
  generateTotpSecret,
  currentTotp,
  verifyTotp,
  newResetCode,
  consumeResetCode,
  pwResetKey,
  PW_RESET_MAX_ATTEMPTS,
  resetLoginAttempts,
  accountLockedOut,
  recordAccountFailure,
  resetAccountFailures,
} from "../src/auth";
import { canMutate } from "../src/plugins/auth";
import { isAdmin, adminIds, setAdminIds, setBotIdentity, resetBotIdentity } from "@app/core/runtime";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
const CUSTOMER_TG = 42;

let app: FastifyInstance;

interface Seed {
  adminId: number;
  customerId: number;
  productId: number;
  /** Mid-tier Product (table `products`) that owns `productId`'s denomination. */
  catalogProductId: number;
  categoryId: number;
  cookie: string;
  csrf: string;
}
let seed: Seed;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

let counter = 0;
beforeEach(async () => {
  await resetDb(prisma);
  // Limiters are in-process Maps shared across tests; clear what the auth flows
  // touch (app.inject's IP + the seeded admin ids) so attempts don't leak.
  resetLoginAttempts("127.0.0.1");
  resetAccountFailures(ADMIN_TG);
  resetAccountFailures(1000);
  resetBotIdentity();
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const customer = await upsertUser(prisma, { telegramId: CUSTOMER_TG, username: "cust", fullName: "Customer" });
  const cat = await createCategory(prisma, `Cat${counter++}`);
  const parentProduct = await createCatalogProduct(prisma, {
    categoryId: cat.id,
    name: `Prod${counter}`,
    description: "x",
  });
  const product = await createDenomination(prisma, {
    productId: parentProduct.id,
    name: `Prod${counter}`,
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price: "5.00",
    description: "x",
  });
  await bulkAddStock(prisma, product.id, Array.from({ length: 4 }, (_, i) => `a${counter}_${i}@e.com:p`));

  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);

  seed = {
    adminId: admin.id,
    customerId: customer.id,
    productId: product.id,
    catalogProductId: product.productId,
    categoryId: cat.id,
    cookie: raw,
    csrf: data.csrf,
  };
  // Existing suites model a CONFIGURED deploy — keep the first-run gate open.
  await setSetting(prisma, "setup_completed", "true");
});

// ---- helpers --------------------------------------------------------------

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function post(url: string, cookie: string | null, fields: Record<string, string>) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    cookies: cookie ? { [COOKIE]: cookie } : {},
    payload: form(fields),
  });
}

function get(url: string, cookie: string | null) {
  return app.inject({ method: "GET", url, cookies: cookie ? { [COOKIE]: cookie } : {} });
}

async function makePendingOrder(): Promise<number> {
  const user = (await getUser(prisma, seed.customerId))!;
  const order = (await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 }))!;
  await attachPaymentProof(prisma, order.id, { fileId: "proof123", txid: "TX1234567890" });
  return order.id;
}

// ---- auth (acceptance #4) -------------------------------------------------

describe("auth", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("serves the dashboard SPA shell with the real CSRF token baked in, not the build-time placeholder", async () => {
    const res = await get("/", seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain(`name="csrf-token" content="${seed.csrf}"`);
    expect(res.body).not.toContain("__CSRF_TOKEN__");
  });

  it("login happy path sets a working cookie", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("supersecret"));
    const res = await post("/login", null, { telegram_id: String(ADMIN_TG), password: "supersecret" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/");

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    const value = raw.split(";")[0]!.split("=").slice(1).join("=");
    const dash = await get("/", decodeURIComponent(value));
    expect(dash.statusCode).toBe(200);
  });

  it("login with wrong password is rejected (401)", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("supersecret"));
    const res = await post("/login", null, { telegram_id: String(ADMIN_TG), password: "WRONG" });
    expect(res.statusCode).toBe(401);
  });

  it("logout invalidates the session server-side", async () => {
    expect((await get("/", seed.cookie)).statusCode).toBe(200);
    const before = await getSetting(prisma, sessionJtiKey(ADMIN_TG));

    const res = await post("/logout", seed.cookie, {});
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");

    const after = await getSetting(prisma, sessionJtiKey(ADMIN_TG));
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);

    // Same cookie now rejected (jti rotated), not just cookie-cleared.
    const follow = await get("/", seed.cookie);
    expect(follow.statusCode).toBe(303);
    expect(follow.headers.location).toBe("/login");
  });

  it("SPA wildcard: authenticated request to unknown path gets the SPA shell", async () => {
    const res = await get("/this-path-does-not-exist", seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain(`name="csrf-token" content="${seed.csrf}"`);
  });

  it("SPA wildcard: anon request to unknown path redirects to /login", async () => {
    const res = await get("/this-path-does-not-exist", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});

// ---- auth — JSON mode -------------------------------------------------------

describe("auth — JSON mode", () => {
  function postJson(url: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  it("POST /login JSON: wrong password → { error } with 401", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("supersecret"));
    const res = await postJson("/login", { telegram_id: String(ADMIN_TG), password: "wrongpassword" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("POST /login JSON: success → { ok, redirect } + sets cookie", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("supersecret"));
    const res = await postJson("/login", { telegram_id: String(ADMIN_TG), password: "supersecret" });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ok: boolean; redirect: string };
    expect(data.ok).toBe(true);
    expect(data.redirect).toBe("/");
    expect(res.headers["set-cookie"]).toBeTruthy();
  });

  it("GET /login → 200 HTML SPA shell", async () => {
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
  });
});

// ---- forgot / reset password (suggestion 1) ------------------------------

describe("forgot/reset password", () => {
  it("consumeResetCode: ok / expired / locked / mismatch-then-lock", () => {
    const { code, store } = newResetCode();
    expect(consumeResetCode(store, code).ok).toBe(true);
    expect(consumeResetCode(null, code)).toMatchObject({ ok: false, reason: "missing" });

    const expired = newResetCode(-1).store; // already in the past
    expect(consumeResetCode(expired, "000000")).toMatchObject({ ok: false, reason: "expired" });

    // Wrong code burns attempts; the final wrong guess drops the record (store=null).
    let cur: string | null = store;
    for (let i = 1; i < PW_RESET_MAX_ATTEMPTS; i++) {
      const out = consumeResetCode(cur, "999999"); // wrong (code is random 6-digit; collision negligible)
      expect(out.ok).toBe(false);
      cur = out.ok ? null : out.store;
      expect(cur).not.toBeNull();
    }
    const last = consumeResetCode(cur, "999999");
    expect(last).toMatchObject({ ok: false, reason: "mismatch", store: null });
  });

  it("forgot enqueues an ADMIN_PW_RESET DM for a real admin, then reset works", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("oldpassword"));

    const forgot = await post("/forgot", null, { telegram_id: String(ADMIN_TG) });
    expect(forgot.statusCode).toBe(200);

    const rows = await prisma.notificationOutbox.findMany({ where: { event: "ADMIN_PW_RESET" } });
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0]!.payloadJson);
    expect(payload.chat_id).toBe(ADMIN_TG);
    expect(rows[0]!.orderId).toBeNull();
    expect(await getSetting(prisma, pwResetKey(ADMIN_TG))).not.toBeNull();

    // Use the delivered code to set a new password.
    const reset = await post("/reset", null, {
      telegram_id: String(ADMIN_TG), code: payload.code, password: "brandnewpw", password_confirm: "brandnewpw",
    });
    expect(reset.statusCode).toBe(303);
    expect(reset.headers.location).toBe("/login");
    expect(verifyPassword("brandnewpw", (await getSetting(prisma, passwordHashKey(ADMIN_TG)))!)).toBe(true);
    expect(await getSetting(prisma, pwResetKey(ADMIN_TG))).toBeNull(); // consumed
  });

  it("forgot for a non-admin / no-password id is neutral and enqueues nothing", async () => {
    const res = await post("/forgot", null, { telegram_id: "424242" });
    expect(res.statusCode).toBe(200); // same page, no enumeration
    expect(await prisma.notificationOutbox.count({ where: { event: "ADMIN_PW_RESET" } })).toBe(0);

    // Admin in ADMIN_IDS but with NO password set yet → must bootstrap, not reset.
    const noPw = await post("/forgot", null, { telegram_id: String(ADMIN_TG) });
    expect(noPw.statusCode).toBe(200);
    expect(await prisma.notificationOutbox.count({ where: { event: "ADMIN_PW_RESET" } })).toBe(0);
  });

  it("reset rejects a wrong code without changing the password", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("oldpassword"));
    await post("/forgot", null, { telegram_id: String(ADMIN_TG) });

    const res = await post("/reset", null, {
      telegram_id: String(ADMIN_TG), code: "000000", password: "brandnewpw", password_confirm: "brandnewpw",
    });
    expect(res.statusCode).toBe(400);
    expect(verifyPassword("oldpassword", (await getSetting(prisma, passwordHashKey(ADMIN_TG)))!)).toBe(true);
  });
});

// ---- per-account login throttle (hardening) -------------------------------

describe("account lockout", () => {
  it("locks an account after the failure cap and clears on reset", () => {
    const tg = 7777771; // dedicated id, untouched elsewhere
    const max = config.WEB_LOGIN_RATE_LIMIT_MAX;
    resetAccountFailures(tg);
    for (let i = 0; i < max - 1; i++) recordAccountFailure(tg);
    expect(accountLockedOut(tg)).toBe(false);
    recordAccountFailure(tg); // now at the cap
    expect(accountLockedOut(tg)).toBe(true);
    resetAccountFailures(tg);
    expect(accountLockedOut(tg)).toBe(false);
  });
});

// ---- orders (acceptance #3 + #5) ------------------------------------------

describe("orders", () => {
  it("approve → DELIVERED + outbox row (buyer_language) + audit", async () => {
    // The testimonial channel post (ORDER_DELIVERED) only gets enqueued when
    // a public channel is configured.
    setBotIdentity({ publicChannelId: -100123456789 });
    const orderId = await makePendingOrder();
    const res = await post(`/orders/${orderId}/approve`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(new RegExp(`^/orders/${orderId}`));
    // Credentials must never leak into the redirect URL (it lands in logs).
    expect(res.headers.location).not.toContain("@");

    const order = (await getOrder(prisma, orderId))!;
    expect(order.status).toBe("DELIVERED");

    const rows = await prisma.notificationOutbox.findMany({ where: { orderId } });
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.payloadJson).buyer_language).toBe("en");

    const audit = await prisma.auditLog.findMany({ where: { action: "approve_order", targetId: orderId } });
    expect(audit.length).toBe(1);
  });

  it("approve is atomic: mid-loop out-of-stock failure rolls back the FIRST item's allocation too", async () => {
    // Stock is now reserved at order CREATION (Checkout-2/Stock-1 fix), so
    // approveOrder's per-item loop normally just flips already-RESERVED rows
    // to SOLD — the old "stock ran out between creation and approval" race
    // this test used to simulate can no longer happen for orders created
    // through the app's own mutators. The one residual case approveOrder
    // still defends is a reserved stock row vanishing by some OTHER means
    // (e.g. direct DB intervention, never through the app's guarded helpers)
    // between creation and approval — simulated here by deleting item #2's
    // reserved stock row directly and draining the remaining AVAILABLE pool,
    // so approveOrder's replacement-allocation attempt for item #2 fails
    // after item #1 (still healthy/RESERVED) has already been flipped to SOLD.
    const user = (await getUser(prisma, seed.customerId))!;
    // Seed has 4 AVAILABLE stock items; a qty=2 order reserves 2 of them,
    // leaving 2 AVAILABLE.
    const order = (await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 2 }))!;
    await attachPaymentProof(prisma, order.id, { fileId: "proof123", txid: "TX1234567890" });
    const orderId = order.id;

    const items = await prisma.orderItem.findMany({ where: { orderId }, orderBy: { id: "asc" } });
    expect(items.length).toBe(2);
    const [item1, item2] = items;

    // Item #2's reserved row vanishes (onDelete: SetNull clears stockItemId).
    await prisma.stockItem.delete({ where: { id: item2!.stockItemId! } });
    // Drain the rest of the AVAILABLE pool so item #2's replacement allocation
    // attempt has nothing to grab.
    await prisma.stockItem.deleteMany({
      where: { productId: seed.productId, status: "AVAILABLE" },
    });

    const res = await post(`/orders/${orderId}/approve`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(new RegExp(`^/orders/${orderId}`));
    expect(res.headers.location).toContain("kind=error");

    // Order must be unchanged — the failed second allocation must not leave a
    // partial DELIVERED/approve side-effect behind.
    const reloaded = (await getOrder(prisma, orderId))!;
    expect(reloaded.status).toBe("PENDING_VERIFICATION");

    // Item #1's stock DID get flipped to SOLD inside the loop before item #2
    // failed — it must roll back to RESERVED, not stay SOLD.
    const stock1 = await prisma.stockItem.findUnique({ where: { id: item1!.stockItemId! } });
    expect(stock1!.status).toBe("RESERVED");
    const leftoverSold = await prisma.stockItem.count({
      where: { productId: seed.productId, status: "SOLD" },
    });
    expect(leftoverSold).toBe(0);

    // The audit write must have rolled back with the failed state change —
    // proving approveOrder + logAdminAction share one transaction.
    const audit = await prisma.auditLog.findMany({ where: { action: "approve_order", targetId: orderId } });
    expect(audit.length).toBe(0);
  });

  it("list shows a web buyer's login handle, not a dash", async () => {
    // Web-store buyers have no Telegram fullName/username — only loginUsername /
    // email. The API must expose loginUsername so the client can show it.
    const web = await createWebUser(prisma, {
      loginUsername: "weshopper",
      email: "we@shop.test",
      passwordHash: "x",
    });
    await createOrderDirect(prisma, { user: web, productId: seed.productId, quantity: 1 });

    const res = await get("/api/orders", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { orders: Array<{ user: { loginUsername?: string } | null }> };
    expect(data.orders.some((o) => o.user?.loginUsername === "weshopper")).toBe(true);
  });

  it("reject → REJECTED + audit", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/orders/${orderId}/reject`, seed.cookie, { csrf_token: seed.csrf, reason: "blurry proof" });
    expect(res.statusCode).toBe(303);
    const order = (await getOrder(prisma, orderId))!;
    expect(order.status).toBe("REJECTED");
    const audit = await prisma.auditLog.findMany({ where: { action: "reject_order", targetId: orderId } });
    expect(audit.length).toBe(1);
  });

  it("reject requires a reason", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/orders/${orderId}/reject`, seed.cookie, { csrf_token: seed.csrf, reason: "   " });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("approve requires auth (anon → 303 /login)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/orders/${orderId}/approve`, null, { csrf_token: "anything" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("approve rejects bad CSRF (403)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/orders/${orderId}/approve`, seed.cookie, { csrf_token: "wrong-token" });
    expect(res.statusCode).toBe(403);
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("approve accepts the CSRF token via an X-CSRF-Token header, with no body field at all", async () => {
    const orderId = await makePendingOrder();
    setBotIdentity({ publicChannelId: -100123456789 });
    const res = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/approve`,
      headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": seed.csrf },
      cookies: { [COOKIE]: seed.cookie },
      payload: form({}),
    });
    expect(res.statusCode).toBe(303);
    expect((await getOrder(prisma, orderId))!.status).toBe("DELIVERED");
  });

  it("credit-balance on a paid order → CANCELLED + buyer credited + audit", async () => {
    const orderId = await makePendingOrder(); // PENDING_VERIFICATION (paid)
    const order = (await getOrder(prisma, orderId))!;
    const before = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    const res = await post(`/orders/${orderId}/credit-balance`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect((await getOrder(prisma, orderId))!.status).toBe("CANCELLED");
    const after = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    expect(after - before).toBeCloseTo(Number(order.totalAmount));
    const audit = await prisma.auditLog.findMany({ where: { action: "order_credit_balance", targetId: orderId } });
    expect(audit.length).toBe(1);
  });

  it("credit-balance requires auth (anon → /login)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/orders/${orderId}/credit-balance`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("credit-balance rejects bad CSRF (403)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/orders/${orderId}/credit-balance`, seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });
});

// ---- catalog (acceptance #5) ----------------------------------------------

describe("catalog", () => {
  it("product list is available via the API", async () => {
    const res = await get("/api/catalog", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { products: Array<{ id: number }> };
    expect(data.products.some((p) => p.id === seed.catalogProductId)).toBe(true);
  });

  it("create category happy + audit", async () => {
    const res = await post("/catalog/category", seed.cookie, { csrf_token: seed.csrf, name: "VPNs", emoji: "🔒", sort_order: "1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const cats = await prisma.category.findMany({ where: { name: "VPNs" } });
    expect(cats.length).toBe(1);
    const audit = await prisma.auditLog.findMany({ where: { action: "category_create" } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("update category happy + audit", async () => {
    const res = await post(`/catalog/category/${seed.categoryId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Renamed Cat",
      emoji: "🌟",
      description: "desc",
      sort_order: "2",
      is_active: "true",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const cat = await prisma.category.findUnique({ where: { id: seed.categoryId } });
    expect(cat!.name).toBe("Renamed Cat");
    expect(cat!.description).toBe("desc");
    const audit = await prisma.auditLog.findMany({ where: { action: "category_update" } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("update category requires auth", async () => {
    const res = await post(`/catalog/category/${seed.categoryId}/update`, null, { csrf_token: "x", name: "Hax" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("update category rejects bad CSRF", async () => {
    const res = await post(`/catalog/category/${seed.categoryId}/update`, seed.cookie, { csrf_token: "bad", name: "Hax" });
    expect(res.statusCode).toBe(403);
  });

  it("create product happy — no price/type/duration on the mid-tier Product", async () => {
    const product = await getCatalogProduct(prisma, seed.catalogProductId);
    const res = await post("/catalog/product", seed.cookie, {
      csrf_token: seed.csrf,
      category_id: String(product!.categoryId),
      name: "Netflix",
      description: "shared",
      emoji: "🎬",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const created = await prisma.product.findFirst({ where: { name: "Netflix" } });
    expect(created).toBeTruthy();
    // The mid-tier product carries no price/type/duration columns at all.
    expect(created).not.toHaveProperty("price");
    expect(created).not.toHaveProperty("type");
    expect(created).not.toHaveProperty("durationLabel");
  });

  it("create product requires auth", async () => {
    const res = await post("/catalog/product", null, { csrf_token: "x", category_id: String(seed.categoryId), name: "Hax" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("create product rejects bad CSRF", async () => {
    const res = await post("/catalog/product", seed.cookie, { csrf_token: "bad", category_id: String(seed.categoryId), name: "Hax" });
    expect(res.statusCode).toBe(403);
  });

  it("update product happy + audit", async () => {
    const res = await post(`/catalog/product/${seed.catalogProductId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Renamed Product",
      description: "new desc",
      is_active: "true",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect((await getCatalogProduct(prisma, seed.catalogProductId))!.name).toBe("Renamed Product");
    const audit = await prisma.auditLog.findMany({ where: { action: "product_update" } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("update product requires auth", async () => {
    const res = await post(`/catalog/product/${seed.catalogProductId}/update`, null, { csrf_token: "x", name: "Hax" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("update product rejects bad CSRF", async () => {
    const res = await post(`/catalog/product/${seed.catalogProductId}/update`, seed.cookie, { csrf_token: "bad", name: "Hax" });
    expect(res.statusCode).toBe(403);
  });

  it("delete product refuses while it still has a denomination, succeeds once emptied", async () => {
    const blocked = await post(`/catalog/product/${seed.catalogProductId}/delete`, seed.cookie, { csrf_token: seed.csrf });
    expect(blocked.statusCode).toBe(303);
    expect(blocked.headers.location).toContain("kind=error");
    expect(await getCatalogProduct(prisma, seed.catalogProductId)).not.toBeNull();

    await prisma.denomination.deleteMany({ where: { productId: seed.catalogProductId } });
    const ok = await post(`/catalog/product/${seed.catalogProductId}/delete`, seed.cookie, { csrf_token: seed.csrf });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toContain("kind=success");
    expect(await getCatalogProduct(prisma, seed.catalogProductId)).toBeNull();
  });

  it("delete product on an unrelated failure does NOT flash the 'move or delete denominations' message", async () => {
    // Deleting a non-existent product throws Prisma's "record to delete does
    // not exist" (P2025) — a real Error, but NOT the crud's specific "product
    // not empty: move or delete its denominations first" message. The route
    // must not mislabel this as the denominations-not-empty case; it should
    // rethrow into the app's generic 500 error page instead.
    const missingId = 999999;
    const res = await post(`/catalog/product/${missingId}/delete`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("move or delete its denominations first");
  });

  it("delete product requires auth", async () => {
    const res = await post(`/catalog/product/${seed.catalogProductId}/delete`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("delete product rejects bad CSRF", async () => {
    const res = await post(`/catalog/product/${seed.catalogProductId}/delete`, seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
  });
});

// ---- catalog JSON API — create product (acceptance #5b) -------------------

describe("catalog JSON API — create product", () => {
  function postProductJson(cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

  it("happy path: creates product and logs audit", async () => {
    const before = await prisma.product.count();
    const res = await postProductJson(seed.cookie, seed.csrf, {
      name: "Netflix Premium",
      categoryId: seed.categoryId,
      emoji: "🎬",
      description: "Streaming service",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number; name: string; slug: string };
    expect(body.name).toBe("Netflix Premium");
    expect(typeof body.slug).toBe("string");
    expect(body.slug.length).toBeGreaterThan(0);
    expect(await prisma.product.count()).toBe(before + 1);
    const audit = await prisma.auditLog.findMany({
      where: { action: "catalog_product_create", targetId: body.id },
    });
    expect(audit.length).toBe(1);
  });

  it("rejects missing name with 400", async () => {
    const res = await postProductJson(seed.cookie, seed.csrf, { categoryId: seed.categoryId });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects missing categoryId with 400", async () => {
    const res = await postProductJson(seed.cookie, seed.csrf, { name: "X" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects non-integer categoryId with 400", async () => {
    const res = await postProductJson(seed.cookie, seed.csrf, { name: "X", categoryId: "abc" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects missing auth (anon → 303 /login)", async () => {
    const res = await postProductJson(null, "x", { name: "X", categoryId: seed.categoryId });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF with 403", async () => {
    const res = await postProductJson(seed.cookie, "bad-token", { name: "X", categoryId: seed.categoryId });
    expect(res.statusCode).toBe(403);
  });
});

describe("denominations (leaf SKU, inside product detail)", () => {
  it("create denomination happy + audit", async () => {
    const res = await post(`/catalog/product/${seed.catalogProductId}/denomination`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "1 Week",
      type: "shared",
      duration_label: "1 Week",
      price: "2.50",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const d = await prisma.denomination.findFirst({ where: { name: "1 Week", productId: seed.catalogProductId } });
    expect(d).toBeTruthy();
    expect(Number(d!.price)).toBeCloseTo(2.5);
    const audit = await prisma.auditLog.findMany({ where: { action: "denomination_create" } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("create denomination requires auth", async () => {
    const res = await post(`/catalog/product/${seed.catalogProductId}/denomination`, null, {
      csrf_token: "x", name: "Hax", type: "shared", duration_label: "1 Week", price: "1",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("create denomination rejects bad CSRF", async () => {
    const res = await post(`/catalog/product/${seed.catalogProductId}/denomination`, seed.cookie, {
      csrf_token: "bad", name: "Hax", type: "shared", duration_label: "1 Week", price: "1",
    });
    expect(res.statusCode).toBe(403);
  });

  it("update denomination happy + audit", async () => {
    const res = await post(`/catalog/denomination/${seed.productId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Renamed Denom",
      duration_label: "1 Month",
      price: "7.00",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const d = await getDenomination(prisma, seed.productId);
    expect(d!.name).toBe("Renamed Denom");
    expect(Number(d!.price)).toBeCloseTo(7);
    const audit = await prisma.auditLog.findMany({ where: { action: "denomination_update" } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("quick toggle (Hide/Show) only sends name/duration_label/price/is_active and must not null other columns", async () => {
    // Give the denomination cost/reseller/auto-delivery/description first, the
    // way the full edit dropdown would.
    await updateDenomination(prisma, seed.productId, {
      costPrice: new Decimal("3.00"),
      resellerPrice: new Decimal("4.00"),
      autoDeliverySource: "stock-pool-a",
      description: "Shared profile",
    });
    // The quick Hide/Show toggle form (product_detail.njk) posts ONLY these 4
    // fields — it must not be treated as "the rest are cleared".
    const res = await post(`/catalog/denomination/${seed.productId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Renamed Denom",
      duration_label: "1 Month",
      price: "7.00",
      is_active: "false",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const d = await getDenomination(prisma, seed.productId);
    expect(d!.isActive).toBe(false);
    expect(d!.name).toBe("Renamed Denom");
    // The columns absent from the toggle's body must survive untouched.
    expect(Number(d!.costPrice)).toBeCloseTo(3);
    expect(Number(d!.resellerPrice)).toBeCloseTo(4);
    expect(d!.autoDeliverySource).toBe("stock-pool-a");
    expect(d!.description).toBe("Shared profile");
  });

  it("full edit form CAN clear cost_price/reseller_price/auto_delivery_source/description by sending them empty", async () => {
    await updateDenomination(prisma, seed.productId, {
      costPrice: new Decimal("3.00"),
      resellerPrice: new Decimal("4.00"),
      autoDeliverySource: "stock-pool-a",
      description: "Shared profile",
    });
    const res = await post(`/catalog/denomination/${seed.productId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Renamed Denom",
      duration_label: "1 Month",
      price: "7.00",
      cost_price: "",
      reseller_price: "",
      auto_delivery_source: "",
      description: "",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const d = await getDenomination(prisma, seed.productId);
    expect(d!.costPrice).toBeNull();
    expect(d!.resellerPrice).toBeNull();
    expect(d!.autoDeliverySource).toBeNull();
    expect(d!.description).toBeNull();
  });

  it("update denomination accepts sort_order and the list re-orders by it", async () => {
    const other = await createDenomination(prisma, {
      productId: seed.catalogProductId,
      name: "OtherDenom",
      type: ProductType.SHARED,
      durationLabel: "1 Month",
      price: "9.00",
      sortOrder: 0,
    });
    // seed.productId's denomination currently has sortOrder 0 (default) too;
    // price-asc tiebreak would put it before `other` (price 9 > 5). Push it
    // after `other` purely via sort_order.
    const res = await post(`/catalog/denomination/${seed.productId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Renamed Denom",
      duration_label: "1 Month",
      price: "7.00",
      sort_order: "10",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const d = await getDenomination(prisma, seed.productId);
    expect(d!.sortOrder).toBe(10);

    const product = await getCatalogProductWithDenominations(prisma, seed.catalogProductId);
    const ids = product!.denominations.map((x) => x.id);
    expect(ids.indexOf(other.id)).toBeLessThan(ids.indexOf(seed.productId));
  });

  it("update denomination requires auth", async () => {
    const res = await post(`/catalog/denomination/${seed.productId}/update`, null, { csrf_token: "x", name: "Hax", duration_label: "x", price: "1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("update denomination rejects bad CSRF", async () => {
    const res = await post(`/catalog/denomination/${seed.productId}/update`, seed.cookie, { csrf_token: "bad", name: "Hax", duration_label: "x", price: "1" });
    expect(res.statusCode).toBe(403);
  });

  it("re-parenting to a product in a different category is rejected", async () => {
    const otherCat = await createCategory(prisma, `OtherCat${Math.random()}`);
    const otherProduct = await prisma.product.create({
      data: { categoryId: otherCat.id, name: "OtherProd", slug: `other-prod-${Math.random()}` },
    });
    const res = await post(`/catalog/denomination/${seed.productId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Cross",
      duration_label: "1 Month",
      price: "5",
      product_id: String(otherProduct.id),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect((await getDenomination(prisma, seed.productId))!.productId).toBe(seed.catalogProductId);
  });

  it("re-parenting to a product in the SAME category succeeds", async () => {
    const sibling = await prisma.product.create({
      data: { categoryId: seed.categoryId, name: "SiblingProd", slug: `sibling-prod-${Math.random()}` },
    });
    const res = await post(`/catalog/denomination/${seed.productId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Moved",
      duration_label: "1 Month",
      price: "5",
      product_id: String(sibling.id),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect((await getDenomination(prisma, seed.productId))!.productId).toBe(sibling.id);
  });

  it("delete denomination refuses with order history, succeeds without", async () => {
    const extra = await createDenomination(prisma, {
      productId: seed.catalogProductId,
      name: "Deletable",
      type: ProductType.SHARED,
      durationLabel: "1 Month",
      price: "3.00",
    });
    const res = await post(`/catalog/denomination/${extra.id}/delete`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getDenomination(prisma, extra.id)).toBeNull();
  });

  it("delete denomination with order history is blocked", async () => {
    // seed.productId is already stocked — place an order against it first.
    const user = (await getUser(prisma, seed.customerId))!;
    await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 });
    const blocked = await post(`/catalog/denomination/${seed.productId}/delete`, seed.cookie, { csrf_token: seed.csrf });
    expect(blocked.statusCode).toBe(303);
    expect(blocked.headers.location).toContain("kind=error");
    expect(await getDenomination(prisma, seed.productId)).not.toBeNull();
  });

  it("delete denomination requires auth", async () => {
    const res = await post(`/catalog/denomination/${seed.productId}/delete`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("delete denomination rejects bad CSRF", async () => {
    const res = await post(`/catalog/denomination/${seed.productId}/delete`, seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
  });

  it("bulk-pricing set + remove on a denomination + audit", async () => {
    const set = await post(`/catalog/denomination/${seed.productId}/bulk-pricing`, seed.cookie, {
      csrf_token: seed.csrf, min_quantity: "3", discount_percent: "10",
    });
    expect(set.statusCode).toBe(303);
    expect(set.headers.location).toContain("kind=success");
    expect(await prisma.bulkPricing.findUnique({ where: { productId: seed.productId } })).toBeTruthy();

    const remove = await post(`/catalog/denomination/${seed.productId}/bulk-pricing`, seed.cookie, {
      csrf_token: seed.csrf, min_quantity: "", discount_percent: "",
    });
    expect(remove.statusCode).toBe(303);
    expect(await prisma.bulkPricing.findUnique({ where: { productId: seed.productId } })).toBeNull();

    const audit = await prisma.auditLog.findMany({ where: { action: { in: ["bulk_pricing_set", "bulk_pricing_delete"] } } });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("bulk-pricing requires auth", async () => {
    const res = await post(`/catalog/denomination/${seed.productId}/bulk-pricing`, null, { csrf_token: "x", min_quantity: "3", discount_percent: "10" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("bulk-pricing rejects bad CSRF", async () => {
    const res = await post(`/catalog/denomination/${seed.productId}/bulk-pricing`, seed.cookie, { csrf_token: "bad", min_quantity: "3", discount_percent: "10" });
    expect(res.statusCode).toBe(403);
  });
});

// ---- product detail page (new /catalog/product/:id) -----------------------

describe("product detail page", () => {
  it("product detail is available via the API with denominations", async () => {
    const res = await get(`/api/catalog/${seed.catalogProductId}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { product: { id: number; denominations: Array<{ price: string }> } };
    expect(data.product.id).toBe(seed.catalogProductId);
    expect(data.product.denominations.length).toBeGreaterThan(0);
  });

  it("redirects anon to /login", async () => {
    const res = await get(`/catalog/product/${seed.catalogProductId}`, null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("404s for a missing product", async () => {
    const res = await get(`/api/catalog/99999999`, seed.cookie);
    expect(res.statusCode).toBe(404);
  });

  it("honors an allowlisted return_to on update", async () => {
    const product = await getCatalogProduct(prisma, seed.catalogProductId);
    const back = `/catalog/product/${seed.catalogProductId}`;
    const res = await post(`/catalog/product/${seed.catalogProductId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: product!.name,
      return_to: back,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(new RegExp(`^${back}\\?`));
    expect(res.headers.location).toContain("kind=success");
  });

  it("rejects a hostile return_to and falls back to /catalog", async () => {
    const product = await getCatalogProduct(prisma, seed.catalogProductId);
    const res = await post(`/catalog/product/${seed.catalogProductId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: product!.name,
      return_to: "https://evil.example.com/phish",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/catalog\?/);
    expect(res.headers.location).not.toContain("evil.example.com");
  });
});

describe("denomination-to-product assignment (carry-over: parent is mandatory)", () => {
  // NOTE: pre-rework, an old SKU's `product_group_id` could be unlinked to
  // null (no parent). In the 3-tier model a Denomination's parent Product is
  // mandatory — `assignDenominationToProduct` always requires a real target,
  // and the route never offers a "no parent" option. These tests close that
  // carry-over gap: moving within the category succeeds, across categories is
  // rejected with a friendly error (not a 500), and the column itself is non-null.
  it("moving a denomination to a sibling product in the same category succeeds", async () => {
    const sibling = await prisma.product.create({
      data: { categoryId: seed.categoryId, name: `Sibling${Math.random()}`, slug: `sibling-${Math.random()}` },
    });
    const res = await post(`/catalog/denomination/${seed.productId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Moved Denom",
      duration_label: "1 Month",
      price: "5",
      product_id: String(sibling.id),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect((await getDenomination(prisma, seed.productId))!.productId).toBe(sibling.id);
  });

  it("moving a denomination across categories is rejected with a flash error, not a 500", async () => {
    const otherCat = await createCategory(prisma, `OtherCat${Math.random()}`);
    const otherProduct = await prisma.product.create({
      data: { categoryId: otherCat.id, name: `Other${Math.random()}`, slug: `other-${Math.random()}` },
    });
    const res = await post(`/catalog/denomination/${seed.productId}/update`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Should Not Move",
      duration_label: "1 Month",
      price: "5",
      product_id: String(otherProduct.id),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect((await getDenomination(prisma, seed.productId))!.productId).toBe(seed.catalogProductId);
  });

  it("the productId column on Denomination is non-null at the schema level", async () => {
    const d = await getDenomination(prisma, seed.productId);
    expect(d!.productId).not.toBeNull();
    expect(typeof d!.productId).toBe("number");
  });
});

// ---- stock (acceptance #5) ------------------------------------------------

describe("stock", () => {
  it("bulk add happy + audit never logs raw credentials", async () => {
    const before = await countAvailableStock(prisma, seed.productId);
    const res = await post(`/stock/${seed.productId}/add`, seed.cookie, {
      csrf_token: seed.csrf,
      credentials: "new1@e.com:p\nnew2@e.com:p",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await countAvailableStock(prisma, seed.productId)).toBe(before + 2);

    const audit = await prisma.auditLog.findMany({ where: { action: "stock_upload", targetId: seed.productId } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit.every((a) => !(a.details ?? "").includes("@"))).toBe(true);
  });

  it("bulk add requires auth", async () => {
    const res = await post(`/stock/${seed.productId}/add`, null, { csrf_token: "x", credentials: "leak@e.com:p" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("bulk add rejects bad CSRF", async () => {
    const res = await post(`/stock/${seed.productId}/add`, seed.cookie, { csrf_token: "nope", credentials: "x@e.com:p" });
    expect(res.statusCode).toBe(403);
  });

  it("bulk delete removes available rows but keeps sold + audit never logs credentials", async () => {
    const avail = await prisma.stockItem.findMany({ where: { productId: seed.productId, status: "AVAILABLE" } });
    const delId = avail[0]!.id;
    const sold = await prisma.stockItem.update({
      where: { id: avail[1]!.id },
      data: { status: "SOLD", soldAt: new Date() },
    });
    const res = await post(`/stock/${seed.productId}/bulk-delete`, seed.cookie, {
      csrf_token: seed.csrf,
      ids: `${delId},${sold.id}`,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await prisma.stockItem.findUnique({ where: { id: delId } })).toBeNull();
    expect(await prisma.stockItem.findUnique({ where: { id: sold.id } })).not.toBeNull();

    const audit = await prisma.auditLog.findMany({ where: { action: "stock_bulk_delete", targetId: seed.productId } });
    expect(audit.length).toBe(1);
    expect(audit.every((a) => !(a.details ?? "").includes("@"))).toBe(true);
  });

  it("bulk delete requires auth", async () => {
    const res = await post(`/stock/${seed.productId}/bulk-delete`, null, { csrf_token: "x", ids: "1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("bulk delete rejects bad CSRF", async () => {
    const res = await post(`/stock/${seed.productId}/bulk-delete`, seed.cookie, { csrf_token: "nope", ids: "1" });
    expect(res.statusCode).toBe(403);
  });

  it("download returns AVAILABLE credentials as a text attachment + audit by count", async () => {
    const avail = await prisma.stockItem.findMany({ where: { productId: seed.productId, status: "AVAILABLE" }, orderBy: { id: "asc" } });
    const res = await get(`/stock/${seed.productId}/download`, seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".txt");
    for (const it of avail) expect(res.body).toContain(it.credentials);

    const audit = await prisma.auditLog.findMany({ where: { action: "stock_download", targetId: seed.productId } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit.every((a) => !(a.details ?? "").includes("@"))).toBe(true);
  });

  it("download requires auth", async () => {
    const res = await get(`/stock/${seed.productId}/download`, null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});

// ---- users (acceptance #5) ------------------------------------------------

describe("users", () => {
  it("GET /api/users with no query returns the recent-customers list", async () => {
    const res = await get("/api/users", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { users: Array<{ username?: string }> };
    expect(data.users.some((u) => u.username === "cust")).toBe(true);
  });

  it("GET /api/users?q= finds a customer by username substring", async () => {
    const res = await get("/api/users?q=cust", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { users: Array<unknown> };
    expect(data.users.length).toBeGreaterThan(0);
  });

  it("GET /api/users?q= with no match returns an empty users list", async () => {
    const res = await get("/api/users?q=no-such-customer-xyz", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { users: Array<unknown> };
    expect(data.users).toHaveLength(0);
  });

  it("wallet adjust happy (+ audit row — L-9)", async () => {
    const before = (await getUser(prisma, seed.customerId))!.walletBalance;
    const res = await post(`/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: seed.csrf, delta: "5.00", note: "goodwill" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const after = (await getUser(prisma, seed.customerId))!.walletBalance;
    expect(Number(after) - Number(before)).toBeCloseTo(5);
    // L-9 (execution/10): a money-moving admin route must leave an audit trail.
    const audit = await prisma.auditLog.findMany({ where: { action: "wallet_adjust", targetId: seed.customerId } });
    expect(audit.length).toBe(1);
    expect(audit[0]!.adminId).toBe(seed.adminId);
  });

  it("set role happy (lowercase accepted)", async () => {
    const res = await post(`/users/${seed.customerId}/role`, seed.cookie, { csrf_token: seed.csrf, role: "reseller" });
    expect(res.statusCode).toBe(303);
    expect((await getUser(prisma, seed.customerId))!.role).toBe("RESELLER");
  });

  // Admin-5 (security audit, 2026-06-23): /users/:id/role must not be a back
  // door to ADMIN — that's a derived field synced from admin_ids, and
  // promotion goes through /admins only.
  it("set role refuses ADMIN — that's managed via /admins, not here", async () => {
    const res = await post(`/users/${seed.customerId}/role`, seed.cookie, { csrf_token: seed.csrf, role: "admin" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect((await getUser(prisma, seed.customerId))!.role).not.toBe("ADMIN");
  });

  it("ban happy", async () => {
    const res = await post(`/users/${seed.customerId}/ban`, seed.cookie, { csrf_token: seed.csrf, banned: "true", reason: "abuse" });
    expect(res.statusCode).toBe(303);
    expect((await getUser(prisma, seed.customerId))!.banned).toBe(true);
  });

  it("wallet requires auth", async () => {
    const res = await post(`/users/${seed.customerId}/wallet`, null, { csrf_token: "x", delta: "1000" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("wallet rejects bad CSRF", async () => {
    const res = await post(`/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: "bad", delta: "1000" });
    expect(res.statusCode).toBe(403);
  });
});

// ---- vouchers (acceptance #5) ---------------------------------------------

describe("vouchers", () => {
  it("create happy (lowercase code+type normalized)", async () => {
    const res = await post("/vouchers", seed.cookie, {
      csrf_token: seed.csrf, code: "save10", type: "percent", value: "10", usage_limit: "100", min_purchase: "0",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const v = await getVoucherByCode(prisma, "SAVE10");
    expect(v).not.toBeNull();
    expect(v!.isActive).toBe(true);
  });

  it("duplicate code rejected", async () => {
    const fields = { csrf_token: seed.csrf, code: "dup1", type: "percent", value: "5" };
    expect((await post("/vouchers", seed.cookie, fields)).statusCode).toBe(303);
    const res = await post("/vouchers", seed.cookie, fields);
    expect(res.headers.location).toContain("kind=error");
  });

  it("toggle voucher", async () => {
    await post("/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "tog1", type: "percent", value: "5" });
    const v = (await getVoucherByCode(prisma, "TOG1"))!;
    const res = await post(`/vouchers/${v.id}/toggle`, seed.cookie, { csrf_token: seed.csrf, is_active: "false" });
    expect(res.statusCode).toBe(303);
    expect((await prisma.voucher.findUnique({ where: { id: v.id } }))!.isActive).toBe(false);
  });

  it("create requires auth", async () => {
    const res = await post("/vouchers", null, { csrf_token: "x", code: "HAX", type: "percent", value: "99" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("create rejects bad CSRF", async () => {
    const res = await post("/vouchers", seed.cookie, { csrf_token: "bad", code: "HAX2", type: "percent", value: "99" });
    expect(res.statusCode).toBe(403);
  });

  it("delete voucher succeeds when never used, refuses once used", async () => {
    await post("/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "del1", type: "percent", value: "5" });
    const v = (await getVoucherByCode(prisma, "DEL1"))!;

    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 1 } });
    const blocked = await post(`/vouchers/${v.id}/delete`, seed.cookie, { csrf_token: seed.csrf });
    expect(blocked.statusCode).toBe(303);
    expect(blocked.headers.location).toContain("kind=error");
    expect(await prisma.voucher.findUnique({ where: { id: v.id } })).not.toBeNull();

    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 0 } });
    const ok = await post(`/vouchers/${v.id}/delete`, seed.cookie, { csrf_token: seed.csrf });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toContain("kind=success");
    expect(await prisma.voucher.findUnique({ where: { id: v.id } })).toBeNull();
  });

  it("delete voucher requires auth", async () => {
    const res = await post("/vouchers/99999/delete", null, { csrf_token: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("delete voucher rejects bad CSRF", async () => {
    const res = await post("/vouchers/99999/delete", seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
  });
});

// ---- support (acceptance #5) ----------------------------------------------

describe("support", () => {
  async function makeTicket(): Promise<number> {
    const t = await createTicket(prisma, seed.customerId, "help me");
    return t.id;
  }

  it("ticket detail page is available via the API", async () => {
    const tid = await makeTicket();
    const res = await get(`/api/support/${tid}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ticket: { id: number } };
    expect(data.ticket.id).toBe(tid);
  });

  it("reply records a message (never sent to Telegram)", async () => {
    const tid = await makeTicket();
    const res = await post(`/support/${tid}/reply`, seed.cookie, { csrf_token: seed.csrf, content: "Looking into it." });
    expect(res.statusCode).toBe(303);
    const msgs = await listTicketMessages(prisma, tid, 10);
    const adminMsgs = msgs.filter((m) => m.senderType === "ADMIN");
    expect(adminMsgs.some((m) => m.content === "Looking into it.")).toBe(true);
  });

  it("close ticket", async () => {
    const tid = await makeTicket();
    const res = await post(`/support/${tid}/close`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect((await prisma.supportTicket.findUnique({ where: { id: tid } }))!.status).toBe("CLOSED");
  });

  it("reply requires auth", async () => {
    const tid = await makeTicket();
    const res = await post(`/support/${tid}/reply`, null, { csrf_token: "x", content: "hi" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("reply rejects bad CSRF", async () => {
    const tid = await makeTicket();
    const res = await post(`/support/${tid}/reply`, seed.cookie, { csrf_token: "bad", content: "hi" });
    expect(res.statusCode).toBe(403);
  });
});

// ---- settings (acceptance #4 secret-redaction + #5) -----------------------

describe("settings", () => {
  it("edit whitelisted key happy", async () => {
    const res = await post("/settings/edit", seed.cookie, { csrf_token: seed.csrf, key: "support_contact", value: "@helpdesk" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "support_contact")).toBe("@helpdesk");
  });

  it("non-whitelisted key rejected, protected value untouched", async () => {
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "web_admin_password_hash:999", value: "x",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, "web_admin_password_hash:999")).not.toBe("x");
  });

  it("secret values are not exposed via the settings API", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("secretpw"));
    const res = await get("/api/settings", seed.cookie);
    expect(res.statusCode).toBe(200);
    // The raw hash must never appear in the API response.
    expect(res.body).not.toContain("secretpw");
    // Secret-flagged editable keys must return value:"" (redacted).
    const data = JSON.parse(res.body) as { fields: Array<{ key: string; secret: boolean; value: string }> };
    for (const f of data.fields.filter((field) => field.secret)) {
      expect(f.value).toBe("");
    }
  });

  it("password change happy", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("oldpassword"));
    const res = await post("/settings/password", seed.cookie, {
      csrf_token: seed.csrf, current_password: "oldpassword", new_password: "newpassword1", confirm_password: "newpassword1",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const stored = await getSetting(prisma, passwordHashKey(ADMIN_TG));
    expect(verifyPassword("newpassword1", stored!)).toBe(true);
  });

  it("password change with wrong current rejected", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("realpw12"));
    const res = await post("/settings/password", seed.cookie, {
      csrf_token: seed.csrf, current_password: "wrongpw12", new_password: "newpassword1", confirm_password: "newpassword1",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(verifyPassword("realpw12", (await getSetting(prisma, passwordHashKey(ADMIN_TG)))!)).toBe(true);
  });

  it("edit requires auth", async () => {
    const res = await post("/settings/edit", null, { csrf_token: "x", key: "support_contact", value: "pwned" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("edit rejects bad CSRF", async () => {
    const res = await post("/settings/edit", seed.cookie, { csrf_token: "bad", key: "support_contact", value: "pwned" });
    expect(res.statusCode).toBe(403);
  });

  it("settings API includes support_whatsapp in editable fields", async () => {
    const res = await get("/api/settings", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { fields: Array<{ key: string }> };
    expect(data.fields.some((f) => f.key === "support_whatsapp")).toBe(true);
  });

  it("accepts binance_receive_uid (not a secret — exposed via the API)", async () => {
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "binance_receive_uid", value: "123456789",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "binance_receive_uid")).toBe("123456789");
    const page = await get("/api/settings", seed.cookie);
    const apiData = JSON.parse(page.body) as { fields: Array<{ key: string; value: string }> };
    expect(apiData.fields.find((f) => f.key === "binance_receive_uid")?.value).toBe("123456789");
  });

  it("binance_api_key / binance_api_secret are write-only (blank keeps value, never echoed)", async () => {
    await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "binance_api_key", value: "BINKEYSECRET",
    });
    await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "binance_api_secret", value: "BINSECRETVALUE",
    });
    expect(await getSetting(prisma, "binance_api_key")).toBe("BINKEYSECRET");
    expect(await getSetting(prisma, "binance_api_secret")).toBe("BINSECRETVALUE");

    // Blank submit keeps the existing value (the "'<key>' left unchanged." path).
    const blank = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "binance_api_key", value: "",
    });
    expect(blank.statusCode).toBe(303);
    expect(blank.headers.location).toContain("kind=info");
    expect(await getSetting(prisma, "binance_api_key")).toBe("BINKEYSECRET");

    // The stored secrets are never echoed into the form or the saved-data table.
    const page = await get("/settings", seed.cookie);
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("BINKEYSECRET");
    expect(page.body).not.toContain("BINSECRETVALUE");

    // Audit records "(updated)" without the value (CLAUDE.md: never log secrets).
    const logs = await listAuditLogs(prisma, { limit: 10 });
    const entry = logs.find((l) => l.action === "setting_set" && (l.details ?? "").includes("binance_api_secret"));
    expect(entry).toBeTruthy();
    expect(entry!.details).not.toContain("BINSECRETVALUE");
  });

  it("accepts paydisini_userkey (not a secret — exposed via the API)", async () => {
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "paydisini_userkey", value: "userkey123",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "paydisini_userkey")).toBe("userkey123");
    const page = await get("/api/settings", seed.cookie);
    const apiData = JSON.parse(page.body) as { fields: Array<{ key: string; value: string }> };
    expect(apiData.fields.find((f) => f.key === "paydisini_userkey")?.value).toBe("userkey123");
  });

  it("paydisini_apikey is write-only (blank keeps value, never echoed)", async () => {
    await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "paydisini_apikey", value: "PDAPIKEYSECRET",
    });
    expect(await getSetting(prisma, "paydisini_apikey")).toBe("PDAPIKEYSECRET");

    // Blank submit keeps the existing value (the "'<key>' left unchanged." path).
    const blank = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "paydisini_apikey", value: "",
    });
    expect(blank.statusCode).toBe(303);
    expect(blank.headers.location).toContain("kind=info");
    expect(await getSetting(prisma, "paydisini_apikey")).toBe("PDAPIKEYSECRET");

    // The stored secret is never echoed into the form or the saved-data table.
    const page = await get("/settings", seed.cookie);
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("PDAPIKEYSECRET");

    // Audit records "(updated)" without the value (CLAUDE.md: never log secrets).
    const logs = await listAuditLogs(prisma, { limit: 10 });
    const entry = logs.find((l) => l.action === "setting_set" && (l.details ?? "").includes("paydisini_apikey"));
    expect(entry).toBeTruthy();
    expect(entry!.details).not.toContain("PDAPIKEYSECRET");
  });

  it("accepts nowpayments_pay_currency (not a secret — exposed via the API)", async () => {
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_pay_currency", value: "usdttrc20",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "nowpayments_pay_currency")).toBe("usdttrc20");
    const page = await get("/api/settings", seed.cookie);
    const apiData = JSON.parse(page.body) as { fields: Array<{ key: string; value: string }> };
    expect(apiData.fields.find((f) => f.key === "nowpayments_pay_currency")?.value).toBe("usdttrc20");
  });

  it("nowpayments_api_key / nowpayments_ipn_secret are write-only (blank keeps value, never echoed)", async () => {
    await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_api_key", value: "NOWAPIKEYSECRET",
    });
    await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_ipn_secret", value: "NOWIPNSECRETVALUE",
    });
    expect(await getSetting(prisma, "nowpayments_api_key")).toBe("NOWAPIKEYSECRET");
    expect(await getSetting(prisma, "nowpayments_ipn_secret")).toBe("NOWIPNSECRETVALUE");

    // Blank submit keeps the existing value (the "'<key>' left unchanged." path).
    const blank = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_api_key", value: "",
    });
    expect(blank.statusCode).toBe(303);
    expect(blank.headers.location).toContain("kind=info");
    expect(await getSetting(prisma, "nowpayments_api_key")).toBe("NOWAPIKEYSECRET");

    // The stored secrets are never echoed into the form or the saved-data table.
    const page = await get("/settings", seed.cookie);
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("NOWAPIKEYSECRET");
    expect(page.body).not.toContain("NOWIPNSECRETVALUE");

    // Audit records "(updated)" without the value (CLAUDE.md: never log secrets).
    const logs = await listAuditLogs(prisma, { limit: 10 });
    const entry = logs.find((l) => l.action === "setting_set" && (l.details ?? "").includes("nowpayments_ipn_secret"));
    expect(entry).toBeTruthy();
    expect(entry!.details).not.toContain("NOWIPNSECRETVALUE");
  });

  it("accepts bybit_bsc_deposit_address (not a secret — exposed via the API)", async () => {
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_bsc_deposit_address", value: "0xMERCHANTADDR",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "bybit_bsc_deposit_address")).toBe("0xMERCHANTADDR");
    const page = await get("/api/settings", seed.cookie);
    const apiData = JSON.parse(page.body) as { fields: Array<{ key: string; value: string }> };
    expect(apiData.fields.find((f) => f.key === "bybit_bsc_deposit_address")?.value).toBe("0xMERCHANTADDR");
  });

  it("a positive number is accepted for any *_min_amount key", async () => {
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_bsc_min_amount", value: "10",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "bybit_bsc_min_amount")).toBe("10");
  });

  it("a blank *_min_amount value is accepted (hides the note)", async () => {
    await setSetting(prisma, "tokopay_min_amount", "5000");
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "tokopay_min_amount", value: "",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "tokopay_min_amount")).toBe("");
  });

  it("rejects a non-numeric *_min_amount value, leaving the prior value untouched", async () => {
    await setSetting(prisma, "nowpayments_min_amount", "3.5");
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_min_amount", value: "not-a-number",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, "nowpayments_min_amount")).toBe("3.5");
  });

  it("rejects a non-positive *_min_amount value (zero/negative)", async () => {
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_min_amount", value: "0",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, "bybit_min_amount")).toBeNull();
  });

  it("accepts a positive whole number for bybit_bsc_required_confirmations", async () => {
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_bsc_required_confirmations", value: "20",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "bybit_bsc_required_confirmations")).toBe("20");
  });

  it("rejects a non-whole-number bybit_bsc_required_confirmations value, leaving the prior value untouched", async () => {
    await setSetting(prisma, "bybit_bsc_required_confirmations", "15");
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_bsc_required_confirmations", value: "12.5",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, "bybit_bsc_required_confirmations")).toBe("15");
  });

  it("a blank bybit_bsc_required_confirmations value is accepted (falls back to the default)", async () => {
    await setSetting(prisma, "bybit_bsc_required_confirmations", "20");
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_bsc_required_confirmations", value: "",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "bybit_bsc_required_confirmations")).toBe("");
  });

  it("bscscan_api_key is treated as a write-only secret (never echoed back, audited without the value)", async () => {
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bscscan_api_key", value: "SUPERSECRETBSCSCANKEY",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "bscscan_api_key")).toBe("SUPERSECRETBSCSCANKEY");

    const page = await get("/settings", seed.cookie);
    expect(page.body).not.toContain("SUPERSECRETBSCSCANKEY");

    const logs = await listAuditLogs(prisma, { limit: 10 });
    const entry = logs.find((l) => l.action === "setting_set" && (l.details ?? "").includes("bscscan_api_key"));
    expect(entry).toBeTruthy();
    expect(entry!.details).not.toContain("SUPERSECRETBSCSCANKEY");
  });
});

// ---- market USDT rate refresh (plan.md §15.8 resolved) ----------------------

describe("settings: USDT rate from the market", () => {
  it("refresh button pulls, rounds and saves the rate", async () => {
    setFxRateFetcher(async () => new Decimal("16243.7"));
    const res = await post("/settings/fx/refresh", seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16200");
  });

  it("a fetch failure flashes an error and keeps the saved rate", async () => {
    await setSetting(prisma, "usd_idr_rate", "16000");
    setFxRateFetcher(async () => {
      throw new Error("down");
    });
    const res = await post("/settings/fx/refresh", seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16000");
  });

  it("refresh rejects bad CSRF", async () => {
    const res = await post("/settings/fx/refresh", seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
  });
});

// ---- bot credentials in Settings (plan.md §16) -----------------------------

describe("settings: bot tokens (§16)", () => {
  it("saves a Telegram-accepted token and auto-fills bot_username", async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bot_token", value: "123456:goodtokenvalue",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "bot_token")).toBe("123456:goodtokenvalue");
    expect(await getSetting(prisma, "bot_username")).toBe("MyShopBot");
  });

  it("rejects a token Telegram refuses — nothing is stored", async () => {
    setTokenValidator(async () => ({ ok: false }));
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bot_token", value: "123456:badtoken",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });

  it("token edits are owner-only (support role refused)", async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    await setSetting(prisma, webRoleKey(ADMIN_TG), "support");
    await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bot_token", value: "123456:goodtokenvalue",
    });
    // The generic RBAC gate (support can't mutate /settings) or the explicit
    // owner check — either way: not saved.
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });

  it('a single "-" clears the saved token (recovery path back to env)', async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    await setSetting(prisma, "bot_token", "123456:oldtokenvalue");
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bot_token", value: "-",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });

  it("audit never records the token value", async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "notif_bot_token", value: "999:notifsecrettoken",
    });
    const logs = await listAuditLogs(prisma, { limit: 5 });
    const entry = logs.find((l) => l.action === "setting_set" && (l.details ?? "").includes("notif_bot_token"));
    expect(entry).toBeTruthy();
    expect(entry!.details).not.toContain("notifsecrettoken");
  });

  it("saved tokens stay hidden on the page", async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bot_token", value: "123456:goodtokenvalue",
    });
    const res = await get("/settings", seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("123456:goodtokenvalue");
  });

  it("resolves a channel link to its numeric id and saves it", async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    await setSetting(prisma, "bot_token", "123456:goodtokenvalue"); // a token must exist to resolve with
    setChannelValidator(async () => ({ ok: true, id: -1003960444894, title: "TESTIMONI" }));
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "t.me/testiilha",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "public_channel_id")).toBe("-1003960444894");
  });

  it("rejects an unresolvable channel — nothing is stored", async () => {
    await setSetting(prisma, "bot_token", "123456:goodtokenvalue");
    setChannelValidator(async () => ({ ok: false }));
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "@nope",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, "public_channel_id")).toBeNull();
  });

  it("rejects when no bot token is configured to resolve with", async () => {
    await deleteSetting(prisma, "bot_token");
    setChannelValidator(async () => ({ ok: true, id: -100123, title: "x" }));
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "@chan",
    });
    expect(res.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, "public_channel_id")).toBeNull();
  });

  it("channel edits are owner-only (support role refused)", async () => {
    await setSetting(prisma, "bot_token", "123456:goodtokenvalue");
    setChannelValidator(async () => ({ ok: true, id: -100123, title: "x" }));
    await setSetting(prisma, webRoleKey(ADMIN_TG), "support");
    await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "@chan",
    });
    expect(await getSetting(prisma, "public_channel_id")).toBeNull();
  });

  it('a single "-" clears the saved channel id', async () => {
    await setSetting(prisma, "public_channel_id", "-1003960444894");
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "-",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "public_channel_id")).toBeNull();
  });
});

// ---- payments / Binance Internal ops (acceptance #5) ----------------------

describe("payments", () => {
  async function makeUnderpaidOrder(received = "3.00"): Promise<number> {
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 }))!;
    await markUnderpaid(prisma, { orderId: order.id, binanceTxId: `UTX-${order.id}`, amount: received });
    return order.id;
  }

  it("deliver underpaid → DELIVERED + audit", async () => {
    const id = await makeUnderpaidOrder();
    const res = await post(`/payments/order/${id}/deliver`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect((await getOrder(prisma, id))!.status).toBe("DELIVERED");
    const audit = await prisma.auditLog.findMany({ where: { action: "underpaid_deliver", targetId: id } });
    expect(audit.length).toBe(1);
  });

  it("refund underpaid → REFUNDED + wallet credit", async () => {
    const before = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    const id = await makeUnderpaidOrder("3.00");
    const res = await post(`/payments/order/${id}/refund`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect((await getOrder(prisma, id))!.status).toBe("REFUNDED");
    const after = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    expect(after - before).toBeCloseTo(3);
  });

  it("cancel underpaid → CANCELLED", async () => {
    const id = await makeUnderpaidOrder();
    const res = await post(`/payments/order/${id}/cancel`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect((await getOrder(prisma, id))!.status).toBe("CANCELLED");
  });

  it("manual match unmatched tx → delivered + ledger updated", async () => {
    // The testimonial channel post (ORDER_DELIVERED) only gets enqueued when
    // a public channel is configured.
    setBotIdentity({ publicChannelId: -100123456789 });
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 }))!;
    await recordUnmatchedTx(prisma, { binanceTxId: "MTX1", amount: "5.00" });
    const res = await post("/payments/match", seed.cookie, {
      csrf_token: seed.csrf,
      binance_tx_id: "MTX1",
      order_code: order.orderCode,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect((await getOrder(prisma, order.id))!.status).toBe("DELIVERED");
    const tx = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "MTX1" } });
    expect(tx!.outcome).toBe("matched");
    expect(tx!.orderId).toBe(order.id);
    // approve path enqueues exactly one testimoni outbox row.
    expect((await prisma.notificationOutbox.findMany({ where: { orderId: order.id } })).length).toBe(1);
  });

  it("credit unmatched tx → buyer credit balance + order CANCELLED + tx credited_to_balance + audit", async () => {
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 }))!;
    const before = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    await recordUnmatchedTx(prisma, { binanceTxId: "CRTX1", amount: "5.00" });

    const res = await post("/payments/credit", seed.cookie, {
      csrf_token: seed.csrf,
      binance_tx_id: "CRTX1",
      order_code: order.orderCode,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");

    expect((await getOrder(prisma, order.id))!.status).toBe("CANCELLED");
    const after = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    expect(after - before).toBeCloseTo(5);

    const tx = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "CRTX1" } });
    expect(tx!.outcome).toBe("credited_to_balance");
    expect(tx!.orderId).toBe(order.id);

    const logs = await listAuditLogs(prisma, { limit: 5 });
    expect(logs.some((l) => l.action === "tx_credit_balance")).toBe(true);
  });

  it("credit requires auth (anon → /login)", async () => {
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 }))!;
    await recordUnmatchedTx(prisma, { binanceTxId: "CRTX2", amount: "5.00" });
    const res = await post("/payments/credit", null, {
      csrf_token: "x",
      binance_tx_id: "CRTX2",
      order_code: order.orderCode,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await getOrder(prisma, order.id))!.status).toBe("PENDING_PAYMENT");
  });

  it("credit rejects bad CSRF (403)", async () => {
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 }))!;
    await recordUnmatchedTx(prisma, { binanceTxId: "CRTX3", amount: "5.00" });
    const res = await post("/payments/credit", seed.cookie, {
      csrf_token: "bad",
      binance_tx_id: "CRTX3",
      order_code: order.orderCode,
    });
    expect(res.statusCode).toBe(403);
    expect((await getOrder(prisma, order.id))!.status).toBe("PENDING_PAYMENT");
  });

  it("GET /api/payments lists unmatched transactions", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "RENDTX", amount: "1.00" });
    const res = await get("/api/payments", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ledger: Array<{ binanceTxId: string }> };
    expect(data.ledger.some((tx) => tx.binanceTxId === "RENDTX")).toBe(true);
  });

  it("dismiss unmatched tx → outcome dismissed + audit", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "DTX1", amount: "1.00" });
    const res = await post("/payments/dismiss", seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "DTX1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const tx = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "DTX1" } });
    expect(tx!.outcome).toBe("dismissed");
    const logs = await listAuditLogs(prisma, { limit: 5 });
    expect(logs.some((l) => l.action === "tx_dismiss")).toBe(true);
  });

  it("dismiss an already-dismissed (non-unmatched) tx → error flash, row unchanged", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "DTX3", amount: "1.00" });
    await post("/payments/dismiss", seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "DTX3" });
    // second dismiss: the row is no longer "unmatched" → rejected
    const res = await post("/payments/dismiss", seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "DTX3" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "DTX3" } }))!.outcome).toBe("dismissed");
  });

  it("dismiss requires auth (anon → /login)", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "DTX4", amount: "1.00" });
    const res = await post("/payments/dismiss", null, { csrf_token: "x", binance_tx_id: "DTX4" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "DTX4" } }))!.outcome).toBe("unmatched");
  });

  it("dismiss rejects bad CSRF", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "DTX5", amount: "1.00" });
    const res = await post("/payments/dismiss", seed.cookie, { csrf_token: "bad", binance_tx_id: "DTX5" });
    expect(res.statusCode).toBe(403);
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "DTX5" } }))!.outcome).toBe("unmatched");
  });

  it("deliver requires auth", async () => {
    const id = await makeUnderpaidOrder();
    const res = await post(`/payments/order/${id}/deliver`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await getOrder(prisma, id))!.status).toBe("UNDERPAID");
  });

  it("deliver rejects bad CSRF", async () => {
    const id = await makeUnderpaidOrder();
    const res = await post(`/payments/order/${id}/deliver`, seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
    expect((await getOrder(prisma, id))!.status).toBe("UNDERPAID");
  });

  it("dismiss is atomic: audit-log failure rolls back the ledger flip too", async () => {
    // dismissUnmatchedTx (no internal $transaction of its own — its contract
    // requires the CALLER to wrap it) flips the ledger row unmatched→dismissed
    // as its own write, separate from logAdminAction. Force the audit insert
    // to fail (FK violation: the acting admin's User row no longer exists, so
    // audit_logs.admin_id has nothing to reference) and prove the route's
    // prisma.$transaction rolls the ledger flip back with it — not just the
    // audit write — so the two can never diverge.
    await recordUnmatchedTx(prisma, { binanceTxId: "ATOMTX1", amount: "1.00" });
    await prisma.user.delete({ where: { id: seed.adminId } });

    const res = await post("/payments/dismiss", seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "ATOMTX1" });
    // Not a ValidationError, so the route's catch rethrows → Fastify 500,
    // not the usual redirect-with-flash.
    expect(res.statusCode).toBe(500);

    // The ledger row must still be "unmatched" — the dismiss write must have
    // rolled back alongside the failed audit insert.
    const tx = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "ATOMTX1" } });
    expect(tx!.outcome).toBe("unmatched");

    // And of course no audit row exists either.
    const audit = await prisma.auditLog.findMany({ where: { action: "tx_dismiss", details: "tx=ATOMTX1" } });
    expect(audit.length).toBe(0);
  });
});

// ---- outbox monitor (acceptance #5) ---------------------------------------

describe("outbox", () => {
  async function makeFailedNotif(): Promise<number> {
    const row = await prisma.notificationOutbox.create({
      data: { event: "ORDER_DELIVERED", payloadJson: JSON.stringify({ x: 1 }), status: "FAILED", attempts: 5, lastError: "boom" },
    });
    return row.id;
  }

  it("retry requeues a failed notification + audit", async () => {
    const id = await makeFailedNotif();
    const res = await post(`/outbox/${id}/retry`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const row = await prisma.notificationOutbox.findUnique({ where: { id } });
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(0);
    expect(row!.lastError).toBeNull();
    const audit = await prisma.auditLog.findMany({ where: { action: "outbox_retry", targetId: id } });
    expect(audit.length).toBe(1);
  });

  it("retry requires auth", async () => {
    const id = await makeFailedNotif();
    const res = await post(`/outbox/${id}/retry`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.notificationOutbox.findUnique({ where: { id } }))!.status).toBe("FAILED");
  });

  it("retry rejects bad CSRF", async () => {
    const id = await makeFailedNotif();
    const res = await post(`/outbox/${id}/retry`, seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
    expect((await prisma.notificationOutbox.findUnique({ where: { id } }))!.status).toBe("FAILED");
  });
});

// ---- wallet ledger (Tier 2 §4) --------------------------------------------

describe("wallet ledger", () => {
  it("adjustment requires a reason", async () => {
    const before = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    const res = await post(`/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: seed.csrf, delta: "5.00" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(Number((await getUser(prisma, seed.customerId))!.walletBalance)).toBe(before);
  });

  it("ledger lists a prior adjustment with its reason", async () => {
    await post(`/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: seed.csrf, delta: "7.50", note: "promo credit" });
    const res = await get(`/api/users/${seed.customerId}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ledger: Array<{ note: string }> };
    expect(data.ledger.some((e) => e.note === "promo credit")).toBe(true);
  });
});

// ---- reviews moderation (Tier 2 §5) ---------------------------------------

describe("reviews moderation", () => {
  async function makeReview(hidden = false): Promise<number> {
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 }))!;
    const r = await prisma.review.create({
      data: { userId: seed.customerId, orderId: order.id, productId: seed.productId, rating: 5, comment: "great", hidden },
    });
    return r.id;
  }

  it("hide → hidden + audit", async () => {
    const id = await makeReview();
    const res = await post(`/reviews/${id}/hide`, seed.cookie, { csrf_token: seed.csrf, hidden: "true" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect((await prisma.review.findUnique({ where: { id } }))!.hidden).toBe(true);
    const audit = await prisma.auditLog.findMany({ where: { action: "review_hide", targetId: id } });
    expect(audit.length).toBe(1);
  });

  it("unhide restores the review", async () => {
    const id = await makeReview(true);
    const res = await post(`/reviews/${id}/hide`, seed.cookie, { csrf_token: seed.csrf, hidden: "false" });
    expect(res.statusCode).toBe(303);
    expect((await prisma.review.findUnique({ where: { id } }))!.hidden).toBe(false);
  });

  it("hide requires auth", async () => {
    const id = await makeReview();
    const res = await post(`/reviews/${id}/hide`, null, { csrf_token: "x", hidden: "true" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.review.findUnique({ where: { id } }))!.hidden).toBe(false);
  });

  it("hide rejects bad CSRF", async () => {
    const id = await makeReview();
    const res = await post(`/reviews/${id}/hide`, seed.cookie, { csrf_token: "bad", hidden: "true" });
    expect(res.statusCode).toBe(403);
    expect((await prisma.review.findUnique({ where: { id } }))!.hidden).toBe(false);
  });
});

// ---- restock waitlist (Tier 2 §6) -----------------------------------------

describe("restock waitlist", () => {
  it("stock API surfaces the waiting count", async () => {
    await prisma.restockSubscription.create({ data: { userId: seed.customerId, productId: seed.productId } });
    const list = await get("/api/stock", seed.cookie);
    expect(list.statusCode).toBe(200);
    const detail = await get(`/api/stock/${seed.productId}`, seed.cookie);
    expect(detail.statusCode).toBe(200);
    const detailData = JSON.parse(detail.body) as { waiting: number };
    expect(detailData.waiting).toBeGreaterThan(0);
  });
});

// ---- global search (Tier 3 §13) -------------------------------------------

describe("global search", () => {
  it("exact order code returns the matching order id via the API", async () => {
    const orderId = await makePendingOrder();
    const order = (await getOrder(prisma, orderId))!;
    const res = await get(`/api/search?q=${encodeURIComponent(order.orderCode)}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { exactOrderId: number | null };
    expect(data.exactOrderId).toBe(orderId);
  });

  it("a free-text query returns grouped results via the API", async () => {
    const res = await get("/api/search?q=cust", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { users: unknown[]; products: unknown[] };
    expect(Array.isArray(data.users)).toBe(true);
    expect(Array.isArray(data.products)).toBe(true);
    expect(data.users.length).toBeGreaterThan(0);
  });

  it("requires auth", async () => {
    const res = await get("/api/search?q=x", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});

// ---- bulk operations (Tier 2 §8) ------------------------------------------

describe("bulk operations", () => {
  it("bulk deactivate then activate PRODUCTS (mid-tier) + audit", async () => {
    const res = await post("/catalog/products/bulk", seed.cookie, { csrf_token: seed.csrf, ids: String(seed.catalogProductId), action: "deactivate" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect((await getCatalogProduct(prisma, seed.catalogProductId))!.isActive).toBe(false);
    const audit = await prisma.auditLog.findMany({ where: { action: "product_bulk_active" } });
    expect(audit.length).toBeGreaterThanOrEqual(1);

    await post("/catalog/products/bulk", seed.cookie, { csrf_token: seed.csrf, ids: String(seed.catalogProductId), action: "activate" });
    expect((await getCatalogProduct(prisma, seed.catalogProductId))!.isActive).toBe(true);
  });

  it("bulk mark stock dead (available only) + audit never logs credentials", async () => {
    const items = await prisma.stockItem.findMany({ where: { productId: seed.productId, status: "AVAILABLE" } });
    const ids = items.slice(0, 2).map((i) => i.id);
    const res = await post(`/stock/${seed.productId}/bulk-dead`, seed.cookie, { csrf_token: seed.csrf, ids: ids.join(","), note: "leaked batch" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    for (const id of ids) expect((await prisma.stockItem.findUnique({ where: { id } }))!.status).toBe("DEAD");
    const audit = await prisma.auditLog.findMany({ where: { action: "stock_bulk_dead", targetId: seed.productId } });
    expect(audit.length).toBe(1);
    expect(audit.every((a) => !(a.details ?? "").includes("@"))).toBe(true);
  });

  it("empty selection is rejected", async () => {
    const res = await post("/catalog/products/bulk", seed.cookie, { csrf_token: seed.csrf, ids: "", action: "deactivate" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
  });

  it("CSV import: preview is read-only, apply creates the valid rows (category|product|denomination|type|duration|price|cost|reseller|warranty)", async () => {
    const cat = (await prisma.category.findUnique({ where: { id: seed.categoryId } }))!;
    const csv =
      `${cat.name} | Imported Product A | 1 Month | shared | 1 Month | 9.99\n` +
      `NoSuchCat | Bad Product | 1 Month | shared | 1 Month | 5\n` +
      `${cat.name} | Imported Product B | 12 Months | private | 12 Months | 19 | 15 | 60 | 30 | nice`;
    const beforeProducts = await prisma.product.count();
    const beforeDenoms = await prisma.denomination.count();

    // Step 1 — preview (JSON API): shows ready + the error, writes nothing.
    const preview = await app.inject({
      method: "POST",
      url: "/api/catalog/products/import",
      headers: { "content-type": "application/json", "x-csrf-token": seed.csrf },
      cookies: { [COOKIE]: seed.cookie },
      payload: JSON.stringify({ csv }),
    });
    expect(preview.statusCode).toBe(200);
    const previewData = JSON.parse(preview.body) as {
      rows: Array<{ ok: boolean; product?: string; error?: string }>;
      validCount: number;
      invalidCount: number;
    };
    expect(previewData.validCount).toBe(2);
    expect(previewData.invalidCount).toBe(1);
    expect(previewData.rows.some((r) => r.product === "Imported Product A")).toBe(true);
    expect(previewData.rows.some((r) => (r.error ?? "").includes("unknown category"))).toBe(true);
    expect(await prisma.product.count()).toBe(beforeProducts);
    expect(await prisma.denomination.count()).toBe(beforeDenoms);

    // Step 2 — apply: only the 2 valid rows are created (2 new products, 2 new denominations).
    const apply = await post("/catalog/products/import/apply", seed.cookie, { csrf_token: seed.csrf, csv });
    expect(apply.statusCode).toBe(303);
    expect(apply.headers.location).toContain("kind=success");
    expect(await prisma.product.count()).toBe(beforeProducts + 2);
    expect(await prisma.denomination.count()).toBe(beforeDenoms + 2);
    const b = await prisma.denomination.findFirst({ where: { name: "12 Months" } });
    expect(b!.type).toBe("PRIVATE");
    expect(Number(b!.costPrice)).toBeCloseTo(15);
    expect(Number(b!.resellerPrice)).toBeCloseTo(60);
    expect(b!.warrantyDays).toBe(30);
    expect(b!.description).toBe("nice");
    const audit = await prisma.auditLog.findMany({ where: { action: "product_csv_import" } });
    expect(audit.length).toBe(1);
  });

  it("CSV import: re-uses an existing product by name instead of duplicating it", async () => {
    const cat = (await prisma.category.findUnique({ where: { id: seed.categoryId } }))!;
    const existing = await getCatalogProduct(prisma, seed.catalogProductId);
    const csv = `${cat.name} | ${existing!.name} | 1 Year | shared | 1 Year | 50`;
    const beforeProducts = await prisma.product.count();

    const apply = await post("/catalog/products/import/apply", seed.cookie, { csrf_token: seed.csrf, csv });
    expect(apply.statusCode).toBe(303);
    expect(apply.headers.location).toContain("kind=success");
    expect(await prisma.product.count()).toBe(beforeProducts); // no new product
    const newDenom = await prisma.denomination.findFirst({ where: { name: "1 Year" } });
    expect(newDenom!.productId).toBe(seed.catalogProductId);
  });

  it("CSV import: all-invalid is rejected on apply", async () => {
    const before = await prisma.denomination.count();
    const res = await post("/catalog/products/import/apply", seed.cookie, {
      csrf_token: seed.csrf, csv: "NoSuchCat | X | 1 Month | shared | 1 Month | 5",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(await prisma.denomination.count()).toBe(before);
  });

  it("CSV import apply requires auth and rejects bad CSRF", async () => {
    const anon = await post("/catalog/products/import/apply", null, { csrf_token: "x", csv: "a|b|c|shared|1 Month|5" });
    expect(anon.statusCode).toBe(303);
    expect(anon.headers.location).toBe("/login");
    const bad = await post("/catalog/products/import/apply", seed.cookie, { csrf_token: "bad", csv: "a|b|c|shared|1 Month|5" });
    expect(bad.statusCode).toBe(403);
  });

  it("bulk requires auth and rejects bad CSRF", async () => {
    const anon = await post("/catalog/products/bulk", null, { csrf_token: "x", ids: String(seed.catalogProductId), action: "deactivate" });
    expect(anon.statusCode).toBe(303);
    expect(anon.headers.location).toBe("/login");
    const bad = await post("/catalog/products/bulk", seed.cookie, { csrf_token: "bad", ids: String(seed.catalogProductId), action: "deactivate" });
    expect(bad.statusCode).toBe(403);
    expect((await getCatalogProduct(prisma, seed.catalogProductId))!.isActive).toBe(true);
  });
});

// ---- RBAC / multi-admin (Tier 3 §9) ---------------------------------------

describe("rbac", () => {
  const setRole = (tg: number, role: string) => setSetting(prisma, webRoleKey(tg), role);

  it("canMutate role/area matrix", () => {
    expect(canMutate("super", "/settings/edit")).toBe(true);
    expect(canMutate("readonly", "/orders/1/approve")).toBe(false);
    expect(canMutate("readonly", "/settings/password")).toBe(true); // self-service
    expect(canMutate("support", "/orders/1/approve")).toBe(true);
    expect(canMutate("support", "/reviews/1/hide")).toBe(true);
    expect(canMutate("support", "/catalog/category")).toBe(false);
    expect(canMutate("support", "/settings/edit")).toBe(false);
  });

  // Admin-4 (security audit, 2026-06-23): canMutate now strips the query
  // string itself, so callers that pass raw `req.url` (upload.ts, branding.ts,
  // catalog.ts) can't get an exact-match path check wrong.
  it("canMutate strips a query string itself, matching exact-path checks correctly", () => {
    expect(canMutate("readonly", "/settings/password?foo=bar")).toBe(true); // self-service, still matches
    expect(canMutate("support", "/orders/1/approve?ref=abc")).toBe(true);
    expect(canMutate("support", "/catalog/category?x=1")).toBe(false);
    expect(canMutate("readonly", "/orders/1/approve?x=1")).toBe(false);
  });

  it("readonly is blocked from mutations (403) but can still view", async () => {
    await setRole(ADMIN_TG, "readonly");
    const cat = await post("/catalog/category", seed.cookie, { csrf_token: seed.csrf, name: "Nope" });
    expect(cat.statusCode).toBe(403);
    const approveAttempt = await post(`/payments/match`, seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "x", order_code: "y" });
    expect(approveAttempt.statusCode).toBe(403);
    expect((await get("/catalog", seed.cookie)).statusCode).toBe(200); // reads OK
  });

  it("support can mutate ops but not config", async () => {
    await setRole(ADMIN_TG, "support");
    const orderId = await makePendingOrder();
    const approve = await post(`/orders/${orderId}/approve`, seed.cookie, { csrf_token: seed.csrf });
    expect(approve.statusCode).toBe(303); // ops allowed
    expect((await getOrder(prisma, orderId))!.status).toBe("DELIVERED");
    const cat = await post("/catalog/category", seed.cookie, { csrf_token: seed.csrf, name: "Denied" });
    expect(cat.statusCode).toBe(403); // config denied
  });

  it("/api/admins is super-only, assigns roles, and blocks self-demotion", async () => {
    expect((await get("/api/admins", seed.cookie)).statusCode).toBe(200); // super sees it

    const set = await post("/admins/1000/role", seed.cookie, { csrf_token: seed.csrf, role: "support" });
    expect(set.statusCode).toBe(303);
    expect(set.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, webRoleKey(1000))).toBe("support");

    const self = await post(`/admins/${ADMIN_TG}/role`, seed.cookie, { csrf_token: seed.csrf, role: "readonly" });
    expect(self.headers.location).toContain("kind=error"); // can't demote yourself
    expect(await getSetting(prisma, webRoleKey(ADMIN_TG))).not.toBe("readonly");

    const notAdmin = await post("/admins/424242/role", seed.cookie, { csrf_token: seed.csrf, role: "support" });
    expect(notAdmin.headers.location).toContain("kind=error"); // not in ADMIN_IDS

    await setRole(ADMIN_TG, "support");
    expect((await get("/api/admins", seed.cookie)).statusCode).toBe(403); // non-super blocked
  });
});

// ---- 2FA (TOTP) + session management (Tier 3 §10) -------------------------

describe("2fa", () => {
  it("verifyTotp accepts the live code and rejects a wrong one", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, currentTotp(secret))).toBe(true);
    expect(verifyTotp(secret, "000000")).toBe(false);
    expect(verifyTotp(secret, "notnum")).toBe(false);
  });

  it("enroll flow: begin → enable with a valid code (wrong code rejected)", async () => {
    const begin = await post("/settings/2fa/begin", seed.cookie, { csrf_token: seed.csrf });
    expect(begin.statusCode).toBe(303);
    const pending = await getSetting(prisma, twoFaPendingKey(ADMIN_TG));
    expect(pending).not.toBeNull();

    const wrong = await post("/settings/2fa/enable", seed.cookie, { csrf_token: seed.csrf, totp_code: "000000" });
    expect(wrong.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBeNull();

    const ok = await post("/settings/2fa/enable", seed.cookie, { csrf_token: seed.csrf, totp_code: currentTotp(pending!) });
    expect(ok.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBe(pending);
    expect(await getSetting(prisma, twoFaPendingKey(ADMIN_TG))).toBeNull(); // pending consumed
  });

  it("login requires the 2FA code once enabled", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("supersecret"));
    const secret = generateTotpSecret();
    await setSetting(prisma, twoFaSecretKey(ADMIN_TG), secret);

    const noCode = await post("/login", null, { telegram_id: String(ADMIN_TG), password: "supersecret" });
    expect(noCode.statusCode).toBe(401);

    const badCode = await post("/login", null, { telegram_id: String(ADMIN_TG), password: "supersecret", totp_code: "000000" });
    expect(badCode.statusCode).toBe(401);

    const ok = await post("/login", null, { telegram_id: String(ADMIN_TG), password: "supersecret", totp_code: currentTotp(secret) });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe("/");
  });

  it("disable requires the current password AND a valid code", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("pw12345678"));
    const secret = generateTotpSecret();
    await setSetting(prisma, twoFaSecretKey(ADMIN_TG), secret);

    const badPw = await post("/settings/2fa/disable", seed.cookie, { csrf_token: seed.csrf, current_password: "wrong", totp_code: currentTotp(secret) });
    expect(badPw.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBe(secret);

    const ok = await post("/settings/2fa/disable", seed.cookie, { csrf_token: seed.csrf, current_password: "pw12345678", totp_code: currentTotp(secret) });
    expect(ok.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBeNull();
  });

  it("a readonly admin can still manage their own 2FA", async () => {
    await setSetting(prisma, webRoleKey(ADMIN_TG), "readonly");
    const begin = await post("/settings/2fa/begin", seed.cookie, { csrf_token: seed.csrf });
    expect(begin.statusCode).toBe(303);
    expect(begin.headers.location).not.toContain("kind=error"); // self-service allowed
  });
});

describe("session management", () => {
  it("super can force-logout another admin (rotates their jti); not self", async () => {
    await setSetting(prisma, sessionJtiKey(1000), "jti-1000");
    const res = await post("/admins/1000/logout", seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, sessionJtiKey(1000))).not.toBe("jti-1000"); // rotated

    const self = await post(`/admins/${ADMIN_TG}/logout`, seed.cookie, { csrf_token: seed.csrf });
    expect(self.headers.location).toContain("kind=error");
  });
});

// ---- manage DB admins (Unit 6) --------------------------------------------

describe("manage DB admins", () => {
  const NEW_ADMIN_TG = 777999;

  beforeEach(() => {
    // Reset runtime to env-only list so tests are isolated.
    setAdminIds([...config.ADMIN_IDS]);
  });

  it("add: happy path — id appears in adminIds() and GET /api/admins lists it", async () => {
    const res = await post("/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    // Live runtime updated without restart.
    expect(isAdmin(NEW_ADMIN_TG)).toBe(true);
    // API lists the new id.
    const page = await get("/api/admins", seed.cookie);
    expect(page.statusCode).toBe(200);
    const data = JSON.parse(page.body) as { admins: Array<{ telegramId: number }> };
    expect(data.admins.some((a) => a.telegramId === NEW_ADMIN_TG)).toBe(true);
  });

  it("add: rejects a non-integer telegram_id", async () => {
    const res = await post("/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: "notanumber" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(isAdmin(NaN)).toBe(false);
  });

  it("add: requires auth (anon → 303 /login)", async () => {
    const res = await post("/admins/add", null, { csrf_token: "x", telegram_id: String(NEW_ADMIN_TG) });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(isAdmin(NEW_ADMIN_TG)).toBe(false);
  });

  it("add: rejects bad CSRF (403)", async () => {
    const res = await post("/admins/add", seed.cookie, { csrf_token: "wrong", telegram_id: String(NEW_ADMIN_TG) });
    expect(res.statusCode).toBe(403);
    expect(isAdmin(NEW_ADMIN_TG)).toBe(false);
  });

  it("remove: removes a DB admin from runtime and DB", async () => {
    // First add it.
    await post("/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    expect(isAdmin(NEW_ADMIN_TG)).toBe(true);

    const res = await post("/admins/remove", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(isAdmin(NEW_ADMIN_TG)).toBe(false);
  });

  it("remove: cannot remove an env-based admin", async () => {
    const envAdmin = config.ADMIN_IDS[0]!;
    const res = await post("/admins/remove", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(envAdmin) });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(isAdmin(envAdmin)).toBe(true);
  });

  it("remove: cannot remove self", async () => {
    const res = await post("/admins/remove", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(ADMIN_TG) });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
  });

  it("add: defaults a new DB admin to readonly, NOT super (no privilege escalation by default)", async () => {
    await post("/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    expect(await getSetting(prisma, webRoleKey(NEW_ADMIN_TG))).toBe("readonly");
  });

  it("a DB-added admin's role CAN be set/demoted/promoted via /admins/:tgId/role", async () => {
    await post("/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    const res = await post(`/admins/${NEW_ADMIN_TG}/role`, seed.cookie, { csrf_token: seed.csrf, role: "support" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, webRoleKey(NEW_ADMIN_TG))).toBe("support");
  });

  it("a DB-added admin CAN be force-logged-out via /admins/:tgId/logout", async () => {
    await post("/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    await setSetting(prisma, sessionJtiKey(NEW_ADMIN_TG), "jti-db-admin");
    const res = await post(`/admins/${NEW_ADMIN_TG}/logout`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, sessionJtiKey(NEW_ADMIN_TG))).not.toBe("jti-db-admin");
  });
});

// ---- broadcast composer (Tier 3 §12) — web ENQUEUES, never sends ----------

describe("broadcast", () => {
  it("broadcast API returns segments and history", async () => {
    const res = await get("/api/broadcast", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { segments: unknown[]; history: unknown[] };
    expect(Array.isArray(data.segments)).toBe(true);
  });

  it("enqueues a PENDING broadcast + audit, and sends nothing itself", async () => {
    const res = await post("/broadcast", seed.cookie, { csrf_token: seed.csrf, message: "New stock!", segment: "ALL" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const rows = await prisma.broadcast.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("PENDING");
    expect(rows[0]!.segment).toBe("ALL");
    // The web must NOT deliver — no outbox/Telegram side effect at enqueue.
    expect(await prisma.notificationOutbox.count()).toBe(0);
    const audit = await prisma.auditLog.findMany({ where: { action: "broadcast_enqueue" } });
    expect(audit.length).toBe(1);
  });

  it("rejects empty message and bad segment", async () => {
    expect((await post("/broadcast", seed.cookie, { csrf_token: seed.csrf, message: "   ", segment: "ALL" })).headers.location).toContain("kind=error");
    expect((await post("/broadcast", seed.cookie, { csrf_token: seed.csrf, message: "hi", segment: "NOPE" })).headers.location).toContain("kind=error");
    expect(await prisma.broadcast.count()).toBe(0);
  });

  it("cancels a PENDING broadcast but not one already sent", async () => {
    await post("/broadcast", seed.cookie, { csrf_token: seed.csrf, message: "x", segment: "RESELLERS" });
    const bc = (await prisma.broadcast.findFirst())!;
    const ok = await post(`/broadcast/${bc.id}/cancel`, seed.cookie, { csrf_token: seed.csrf });
    expect(ok.headers.location).toContain("kind=success");
    expect((await prisma.broadcast.findUnique({ where: { id: bc.id } }))!.status).toBe("CANCELLED");
    expect((await post(`/broadcast/${bc.id}/cancel`, seed.cookie, { csrf_token: seed.csrf })).headers.location).toContain("kind=error");
  });

  it("requires auth and rejects bad CSRF", async () => {
    const anon = await post("/broadcast", null, { csrf_token: "x", message: "hi", segment: "ALL" });
    expect(anon.statusCode).toBe(303);
    expect(anon.headers.location).toBe("/login");
    const bad = await post("/broadcast", seed.cookie, { csrf_token: "bad", message: "hi", segment: "ALL" });
    expect(bad.statusCode).toBe(403);
    expect(await prisma.broadcast.count()).toBe(0);
  });
});

// ---- smoke: every GET page renders 200 for an admin -----------------------

// NOTE: the `dashboard` describe block that lived here asserted on
// dashboard.njk's server-rendered revenue HTML at GET / ("shows delivered
// revenue as a Rupiah amount", "leads with the USDT amount...", "shows both
// currencies on one headline..."). The Phase-2 cutover replaced that render
// with the React SPA shell (apps/web-admin/src/routes/spaShell.ts), so GET /
// no longer renders revenue figures server-side at all — those three
// regression tests were asserting on HTML that the route no longer produces by
// design, not a regression. They were removed rather than left permanently red.
// The revenue figures now render client-side in the React dashboard
// (apps/web-admin/client/src/components/dashboard/RevenueKpiCard.tsx via
// CurrencyStack — one row per currency, never a concatenated headline), with
// their own component-level test coverage; the old server-side shapeRevenue
// helper and dashboard.ts route were deleted when the SLA route was retired.

describe("page smoke tests", () => {
  it("all nav pages render 200", async () => {
    for (const path of ["/", "/stock", "/orders", "/payments", "/outbox", "/catalog", "/vouchers", "/users", "/reviews", "/reports", "/support", "/settings", "/audit", "/search", "/admins", "/broadcast"]) {
      const res = await get(path, seed.cookie);
      expect(res.statusCode, `GET ${path}`).toBe(200);
    }
  });

  it("order detail + stock product + user detail render 200", async () => {
    const orderId = await makePendingOrder();
    expect((await get(`/orders/${orderId}`, seed.cookie)).statusCode).toBe(200);
    expect((await get(`/stock/${seed.productId}`, seed.cookie)).statusCode).toBe(200);
    expect((await get(`/users/${seed.customerId}`, seed.cookie)).statusCode).toBe(200);
  });

  it("API returns a USDT order's money in USDT currency, never IDR", async () => {
    // Regression: the old Nunjucks Money card used to format every field with
    // the `idr` filter regardless of `order.currency`. The API must return the
    // correct currency so the React client renders it properly.
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 }))!;
    // rate "1" keeps the USDT total numerically equal to the central price,
    // so the rendered total is a deterministic, non-trivial USDT amount.
    await finalizeOrderPayment(prisma, order.id, { currency: "USDT", rate: "1" });

    const res = await get(`/api/orders/${order.id}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { money: { currency: string } };
    expect(data.money.currency).toBe("USDT");
  });
});

describe("first-run setup gate", () => {
  it("redirects to /setup when setup is pending (no flag, no admin password)", async () => {
    await deleteSetting(prisma, "setup_completed"); // seeded admin has no password
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/setup");
  });

  it("does NOT gate once an admin already has a password (backward compat)", async () => {
    await deleteSetting(prisma, "setup_completed");
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("password123"));
    const res = await app.inject({ method: "GET", url: "/", headers: { cookie: `${COOKIE}=${seed.cookie}` } });
    expect(res.statusCode).toBe(200); // dashboard renders, gate stayed open
  });

  it("never gates excluded paths (/healthz)", async () => {
    await deleteSetting(prisma, "setup_completed");
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});

describe("setup wizard — step 1 (connect bot)", () => {
  beforeEach(async () => {
    await deleteSetting(prisma, "setup_completed"); // open the wizard
  });

  it("serves the SPA shell at GET /setup (React now owns this page)", async () => {
    const res = await app.inject({ method: "GET", url: "/setup" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
  });

  it("rejects a bad token (getMe fails) and saves nothing", async () => {
    setSetupTokenValidator(async () => ({ ok: false }));
    const res = await app.inject({
      method: "POST",
      url: "/setup/bot",
      payload: form({ bot_token: "garbage" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });

  it("rejects a whitespace-only token (trims to empty) and saves nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/setup/bot",
      payload: form({ bot_token: "   " }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });

  it("saves token + username on a valid token and advances to step 2", async () => {
    setSetupTokenValidator(async () => ({ ok: true, username: "ShopBot" }));
    const res = await app.inject({
      method: "POST",
      url: "/setup/bot",
      payload: form({ bot_token: "123:VALID" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/setup/owner");
    expect(await getSetting(prisma, "bot_token")).toBe("123:VALID");
    expect(await getSetting(prisma, "bot_username")).toBe("ShopBot");
  });

  it("can skip step 1 (Atur nanti) without saving a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/setup/bot",
      payload: form({ skip: "1" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/setup/owner");
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });
});

describe("setup wizard — restart trigger", () => {
  it("writes the Passenger restart file best-effort", async () => {
    await setSetting(prisma, "bot_token", "123:test-token");
    const target = join(tmpdir(), `restart-${Date.now()}.txt`);
    process.env.RESTART_TRIGGER_FILE = target;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/setup/restart",
        payload: form({}),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(res.statusCode).toBe(200);
      expect(existsSync(target)).toBe(true);
      const data = JSON.parse(res.body) as { ok: boolean; restarted: boolean; bot_configured: boolean };
      expect(data.ok).toBe(true);
      expect(data.restarted).toBe(true);
      expect(data.bot_configured).toBe(true);
    } finally {
      if (existsSync(target)) rmSync(target);
      delete process.env.RESTART_TRIGGER_FILE;
    }
  });
});

describe("setup wizard — step 2/3/finish", () => {
  const OWNER_TG = 7000123;
  beforeEach(async () => {
    await deleteSetting(prisma, "setup_completed");
    await deleteSetting(prisma, "setup_owner_tg");
    resetAccountFailures(OWNER_TG);
    setAdminIds([...config.ADMIN_IDS]);
  });

  async function createOwner() {
    return app.inject({
      method: "POST",
      url: "/setup/owner",
      payload: form({ telegram_id: String(OWNER_TG), username: "owner", password: "supersecret", password_confirm: "supersecret" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }

  it("rejects mismatched passwords without creating an admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/setup/owner",
      payload: form({ telegram_id: String(OWNER_TG), username: "owner", password: "supersecret", password_confirm: "nope" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(400);
    expect(isAdmin(OWNER_TG)).toBe(false);
  });

  it("creates an ADMIN owner with a password and advances to step 3", async () => {
    const res = await createOwner();
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/setup/shop");
    expect(isAdmin(OWNER_TG)).toBe(true);
    expect(adminIds()).toContain(OWNER_TG);
    const user = await getUser(prisma, (await getUserByTelegramId(prisma, OWNER_TG))!.id);
    expect(user!.role).toBe(UserRole.ADMIN);
    expect(await getSetting(prisma, passwordHashKey(OWNER_TG))).not.toBeNull();
    expect(await getSetting(prisma, "setup_owner_tg")).toBe(String(OWNER_TG));
  });

  it("finish: marks setup complete, sets a session cookie, locks the wizard", async () => {
    await createOwner();
    const res = await app.inject({
      method: "POST",
      url: "/setup/shop",
      payload: form({ shop_name: "Toko Demo" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/setup/done");
    expect(await getSetting(prisma, "shop_name")).toBe("Toko Demo");
    expect(await getSetting(prisma, "setup_completed")).toBe("true");
    const setCookie = res.headers["set-cookie"];
    expect(String(setCookie)).toContain(`${COOKIE}=`);
    // Wizard now locked: GET /setup → /login.
    const locked = await app.inject({ method: "GET", url: "/setup" });
    expect(locked.statusCode).toBe(303);
    expect(locked.headers.location).toBe("/login");
  });

  it("does NOT lock between step 2 and step 3 (mid-wizard owner password already set)", async () => {
    await createOwner();
    // setup_completed is still unset and an admin password now exists, but the
    // wizard is mid-flight (setup_owner_tg set in step 2) — /setup/shop must
    // stay reachable, not get self-healed into a premature lock.
    const shopPage = await app.inject({ method: "GET", url: "/setup/shop" });
    expect(shopPage.statusCode).toBe(200);
  });

  it("locks /setup/owner once an admin password exists outside the wizard (bootstrap takeover)", async () => {
    // Simulates a deploy bootstrapped via /bootstrap (sets a password hash
    // directly, never touches setup_owner_tg) instead of the wizard.
    await deleteSetting(prisma, "setup_owner_tg");
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("password123"));
    const res = await app.inject({
      method: "POST",
      url: "/setup/owner",
      payload: form({ telegram_id: "1234567", username: "attacker", password: "attackerpw", password_confirm: "attackerpw" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(isAdmin(1234567)).toBe(false); // attacker was NOT promoted
    expect(await getSetting(prisma, "setup_completed")).toBe("true"); // self-healed
  });
});

// ---- setup wizard — JSON mode -----------------------------------------------

describe("setup wizard — JSON mode", () => {
  beforeEach(async () => {
    await deleteSetting(prisma, "setup_completed");
    await deleteSetting(prisma, "setup_owner_tg");
  });

  function postJson(url: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  it("POST /setup/bot JSON: skip → { ok, redirect: '/setup/owner' }", async () => {
    const res = await postJson("/setup/bot", { skip: "1" });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ok: boolean; redirect: string };
    expect(data.ok).toBe(true);
    expect(data.redirect).toBe("/setup/owner");
  });

  it("GET /setup → 200 SPA HTML when setup not complete", async () => {
    const res = await app.inject({ method: "GET", url: "/setup" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
  });
});
