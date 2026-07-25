import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { localize } from "@app/core/datetime";
import { ProductType, UserRole, DeliveryType } from "@app/core/enums";
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
  settlePaidOrder,
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
import { UPLOADS_DIR } from "../src/paths";
import { setTokenValidator, setChannelValidator } from "../src/lib/telegramCheck";
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
import { registerOutboxNudge } from "@app/core/nudge";
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

// Form-encoded PATCH/DELETE — for the JSON API routes whose bodies are read
// as plain strings (no boolean/array typing), @fastify/formbody parses these
// the same as a JSON body would.
function patchForm(url: string, cookie: string | null, fields: Record<string, string>) {
  return app.inject({
    method: "PATCH",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    cookies: cookie ? { [COOKIE]: cookie } : {},
    payload: form(fields),
  });
}

function deleteForm(url: string, cookie: string | null, fields: Record<string, string> = {}) {
  return app.inject({
    method: "DELETE",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    cookies: cookie ? { [COOKIE]: cookie } : {},
    payload: form(fields),
  });
}

// 1x1 PNG, mirrors apps/web-admin/test/branding.test.ts's fixture.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function multipart(
  fields: Record<string, string>,
  file?: { field: string; filename: string; contentType: string; content: Buffer },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----vitest" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(file.content, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function postMultipart(url: string, cookie: string | null, mp: ReturnType<typeof multipart>) {
  return app.inject({ method: "POST", url, headers: mp.headers, cookies: cookie ? { [COOKIE]: cookie } : {}, payload: mp.payload });
}

async function makePendingOrder(): Promise<number> {
  const user = (await getUser(prisma, seed.customerId))!;
  const order = (await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 }))!;
  await attachPaymentProof(prisma, order.id, { fileId: "proof123", txid: "TX1234567890" });
  return order.id;
}

/** A manual-SKU order driven all the way to PROCESSING (paid, awaiting an
 * admin to hand-type and send the account content) — mirrors makePendingOrder
 * but for the manual-fulfilment queue's own status, exercising the same
 * createOrderDirect -> attachPaymentProof -> settlePaidOrder path every real
 * payment rail uses. */
async function makeProcessingOrder(): Promise<number> {
  const manualDenom = await createDenomination(prisma, {
    productId: seed.catalogProductId,
    name: `ManualDenom${Math.random()}`,
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price: "5.00",
  });
  await updateDenomination(prisma, manualDenom.id, { deliveryType: DeliveryType.MANUAL });
  const user = (await getUser(prisma, seed.customerId))!;
  const order = (await createOrderDirect(prisma, { user, productId: manualDenom.id, quantity: 1 }))!;
  await attachPaymentProof(prisma, order.id, { fileId: "proof123", txid: "TX1234567890" });
  await settlePaidOrder(prisma, order.id, { adminId: seed.adminId });
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

    // The OTP must wake the dispatcher immediately rather than waiting for
    // its next poll tick — registerOutboxNudge is the same hook runDispatcher
    // installs while it's asleep between ticks.
    let nudged = false;
    registerOutboxNudge(() => { nudged = true; });

    const forgot = await post("/forgot", null, { telegram_id: String(ADMIN_TG) });
    expect(forgot.statusCode).toBe(200);
    expect(nudged).toBe(true);
    registerOutboxNudge(null);

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
    let nudged = false;
    registerOutboxNudge(() => { nudged = true; });

    const res = await post("/forgot", null, { telegram_id: "424242" });
    expect(res.statusCode).toBe(200); // same page, no enumeration
    expect(await prisma.notificationOutbox.count({ where: { event: "ADMIN_PW_RESET" } })).toBe(0);
    expect(nudged).toBe(false); // nothing enqueued -> nothing to wake the dispatcher for
    registerOutboxNudge(null);

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

// ---- per-IP login throttle is not spoofable via X-Forwarded-For -----------
// Security patch: trustProxy is unset (false) by default, so a caller cannot
// evade loginRateLimited(ip) by sending a different X-Forwarded-For header on
// every request — every attempt below must be counted against the same real
// peer IP (app.inject's default remote address), not the forged header.

describe("login rate limit ignores a forged X-Forwarded-For", () => {
  it("still trips the per-IP throttle after WEB_LOGIN_RATE_LIMIT_MAX attempts from spoofed IPs", async () => {
    resetLoginAttempts("127.0.0.1");
    const max = config.WEB_LOGIN_RATE_LIMIT_MAX;
    // A distinct, never-admin telegram_id per attempt so the SEPARATE
    // per-account lockout (keyed by telegram_id) never trips — this isolates
    // the per-IP throttle under test. loginRateLimited(ip) is checked before
    // the account lockout in routes/auth.ts, so every attempt below still
    // counts against the real peer IP regardless of the forged header.
    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/login",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": `10.0.0.${i}`, // a different forged IP every attempt
        },
        payload: form({ telegram_id: String(800000 + i), password: "WRONG" }),
      });
      expect(res.statusCode).toBe(401);
    }

    const res = await app.inject({
      method: "POST",
      url: "/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "10.0.0.999", // yet another forged IP
      },
      payload: form({ telegram_id: "800999", password: "WRONG" }),
    });
    expect(res.statusCode).toBe(429);
    resetLoginAttempts("127.0.0.1");
  });
});

// ---- orders (acceptance #3 + #5) ------------------------------------------

describe("orders", () => {
  it("approve → DELIVERED + outbox rows (testimonial + buyer DM) + audit", async () => {
    // The testimonial channel post (ORDER_DELIVERED) only gets enqueued when
    // a public channel is configured. The buyer DM (ORDER_DELIVERED_DM) is
    // enqueued whenever the buyer has a Telegram id — web-admin never sends
    // Telegram itself, so this outbox row is the only way a web-approved
    // order's credentials ever reach a Telegram buyer.
    setBotIdentity({ publicChannelId: -100123456789 });
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/approve`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    // JSON API responds with just { ok: true } — no redirect URL for
    // credentials to ever leak into (that was the legacy 303's risk).
    expect(res.body).not.toContain("@");

    const order = (await getOrder(prisma, orderId))!;
    expect(order.status).toBe("DELIVERED");

    const rows = await prisma.notificationOutbox.findMany({ where: { orderId } });
    expect(rows.length).toBe(2);
    const testimonial = rows.find((r) => r.event === "ORDER_DELIVERED")!;
    expect(JSON.parse(testimonial.payloadJson).buyer_language).toBe("en");
    const dm = rows.find((r) => r.event === "ORDER_DELIVERED_DM")!;
    const dmPayload = JSON.parse(dm.payloadJson);
    expect(dmPayload.chat_id).toBe(CUSTOMER_TG);
    expect(dmPayload.order_code).toBe(order.orderCode);

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

    const res = await post(`/api/orders/${orderId}/approve`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(422);

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

  describe("CSV export", () => {
    it("returns CSV headers, Content-Disposition, and the matching rows", async () => {
      await makePendingOrder();
      const res = await get("/api/orders/export", seed.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toBe('attachment; filename="orders.csv"');
      const lines = res.body.trim().split("\r\n");
      expect(lines[0]).toBe(
        "Order Code,Customer,Status,Currency,Total Amount,Payment Method,Created At",
      );
      expect(lines.length).toBe(2); // header + the one seeded order
    });

    it("returns more than 50 rows when more than 50 orders match (proves the limit override)", async () => {
      const items = Array.from({ length: 55 }, (_, i) => `bulk${counter}_${i}@e.com:p`);
      await bulkAddStock(prisma, seed.productId, items);
      const user = (await getUser(prisma, seed.customerId))!;
      for (let i = 0; i < 55; i++) {
        await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 });
      }

      const res = await get("/api/orders/export", seed.cookie);
      expect(res.statusCode).toBe(200);
      const lines = res.body.trim().split("\r\n");
      expect(lines.length - 1).toBe(55); // header excluded — proves no 50-row truncation
    });

    it("quotes a customer name containing a comma", async () => {
      const commaUser = await upsertUser(prisma, {
        telegramId: 555555,
        username: "commauser",
        fullName: "Doe, Jane",
      });
      await createOrderDirect(prisma, { user: commaUser, productId: seed.productId, quantity: 1 });

      const res = await get("/api/orders/export", seed.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('"Doe, Jane"');
    });

    it("respects the status filter", async () => {
      setBotIdentity({ publicChannelId: -100123456789 });
      const deliveredId = await makePendingOrder();
      await post(`/api/orders/${deliveredId}/approve`, seed.cookie, { csrf_token: seed.csrf });
      await makePendingOrder(); // stays PENDING_VERIFICATION — must be excluded below

      const res = await get("/api/orders/export?status=DELIVERED", seed.cookie);
      expect(res.statusCode).toBe(200);
      const lines = res.body.trim().split("\r\n");
      expect(lines.length - 1).toBe(1); // header + exactly the one DELIVERED order
      expect(lines[1]).toContain(",DELIVERED,");
    });
  });

  it("reject → REJECTED + audit", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/reject`, seed.cookie, { csrf_token: seed.csrf, reason: "blurry proof" });
    expect(res.statusCode).toBe(200);
    const order = (await getOrder(prisma, orderId))!;
    expect(order.status).toBe("REJECTED");
    const audit = await prisma.auditLog.findMany({ where: { action: "reject_order", targetId: orderId } });
    expect(audit.length).toBe(1);
    expect(audit[0]!.details).toBe(`Rejected order ${order.orderCode}: "blurry proof".`);
  });

  it("reject requires a reason", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/reject`, seed.cookie, { csrf_token: seed.csrf, reason: "   " });
    expect(res.statusCode).toBe(400);
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  // Finding #2 (audit-per-sku-delivery-flows-2026-07-13.md): a PROCESSING
  // order (paid manual SKU an admin can't source) previously had no
  // reject/refund path at all — rejectOrder hard-guarded PENDING_VERIFICATION
  // only, even though PROCESSING -> REJECTED is legal in LEGAL_TRANSITIONS.
  it("reject also works on a PROCESSING order (paid manual SKU an admin can't source)", async () => {
    const orderId = await makeProcessingOrder();
    const res = await post(`/api/orders/${orderId}/reject`, seed.cookie, {
      csrf_token: seed.csrf,
      reason: "out of stock, can't source",
    });
    expect(res.statusCode).toBe(200);
    const order = (await getOrder(prisma, orderId))!;
    expect(order.status).toBe("REJECTED");
    const audit = await prisma.auditLog.findMany({ where: { action: "reject_order", targetId: orderId } });
    expect(audit.length).toBe(1);
  });

  it("GET order detail: canReject is true for both PENDING_VERIFICATION and PROCESSING, but canAct (Approve) stays PENDING_VERIFICATION-only", async () => {
    const pendingId = await makePendingOrder();
    const pendingRes = await app.inject({
      method: "GET",
      url: `/api/orders/${pendingId}`,
      cookies: { [COOKIE]: seed.cookie },
    });
    expect(pendingRes.json().canReject).toBe(true);
    expect(pendingRes.json().canAct).toBe(true);

    const processingId = await makeProcessingOrder();
    const processingRes = await app.inject({
      method: "GET",
      url: `/api/orders/${processingId}`,
      cookies: { [COOKIE]: seed.cookie },
    });
    expect(processingRes.json().canReject).toBe(true);
    expect(processingRes.json().canAct).toBe(false);
  });

  it("approve requires auth (anon → 303 /login)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/approve`, null, { csrf_token: "anything" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("approve rejects bad CSRF (403)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/approve`, seed.cookie, { csrf_token: "wrong-token" });
    expect(res.statusCode).toBe(403);
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("approve accepts the CSRF token via an X-CSRF-Token header, with no body field at all", async () => {
    const orderId = await makePendingOrder();
    setBotIdentity({ publicChannelId: -100123456789 });
    const res = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/approve`,
      headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": seed.csrf },
      cookies: { [COOKIE]: seed.cookie },
      payload: form({}),
    });
    expect(res.statusCode).toBe(200);
    expect((await getOrder(prisma, orderId))!.status).toBe("DELIVERED");
  });

  it("credit-balance on a paid order → CANCELLED + buyer credited + audit", async () => {
    const orderId = await makePendingOrder(); // PENDING_VERIFICATION (paid)
    const order = (await getOrder(prisma, orderId))!;
    const before = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    const res = await post(`/api/orders/${orderId}/credit-balance`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect((await getOrder(prisma, orderId))!.status).toBe("CANCELLED");
    const after = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    expect(after - before).toBeCloseTo(Number(order.totalAmount));
    const audit = await prisma.auditLog.findMany({ where: { action: "order_credit_balance", targetId: orderId } });
    expect(audit.length).toBe(1);
  });

  it("credit-balance requires auth (anon → /login)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/credit-balance`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("credit-balance rejects bad CSRF (403)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/credit-balance`, seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });
});

// ---- manual fulfilment (POST /api/orders/:orderId/fulfill) ----------------

describe("orders API — manual fulfilment", () => {
  it("fulfill delivers a PROCESSING order with the typed content, enqueues the buyer DM, and audits exactly once", async () => {
    const orderId = await makeProcessingOrder();
    const res = await post(`/api/orders/${orderId}/fulfill`, seed.cookie, {
      csrf_token: seed.csrf,
      content: "user:x pass:y",
    });
    expect(res.statusCode).toBe(200);

    const order = (await getOrder(prisma, orderId))!;
    expect(order.status).toBe("DELIVERED");
    expect(order.deliveredContent).toBe("user:x pass:y");
    expect(order.deliveredAt).not.toBeNull();

    const outboxRow = await prisma.notificationOutbox.findFirst({
      where: { orderId, event: "ORDER_MANUAL_DELIVERED_DM" },
    });
    expect(outboxRow).not.toBeNull();

    // fulfillManualOrder itself always writes an order.manual_fulfill audit
    // row — exactly one row proves the route did NOT add a second one on top
    // (the double-logging check called out in the task brief).
    const audit = await prisma.auditLog.findMany({ where: { action: "order.manual_fulfill", targetId: orderId } });
    expect(audit.length).toBe(1);
  });

  it("fulfill requires non-empty content (400) and leaves the order PROCESSING", async () => {
    const orderId = await makeProcessingOrder();
    const res = await post(`/api/orders/${orderId}/fulfill`, seed.cookie, { csrf_token: seed.csrf, content: "   " });
    expect(res.statusCode).toBe(400);
    expect((await getOrder(prisma, orderId))!.status).toBe("PROCESSING");
  });

  it("fulfill rejects an order that isn't PROCESSING (422)", async () => {
    const orderId = await makePendingOrder(); // PENDING_VERIFICATION, not PROCESSING
    const res = await post(`/api/orders/${orderId}/fulfill`, seed.cookie, {
      csrf_token: seed.csrf,
      content: "user:x pass:y",
    });
    expect(res.statusCode).toBe(422);
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("fulfill requires auth (anon → 303 /login)", async () => {
    const orderId = await makeProcessingOrder();
    const res = await post(`/api/orders/${orderId}/fulfill`, null, { csrf_token: "anything", content: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await getOrder(prisma, orderId))!.status).toBe("PROCESSING");
  });

  it("fulfill rejects bad CSRF (403)", async () => {
    const orderId = await makeProcessingOrder();
    const res = await post(`/api/orders/${orderId}/fulfill`, seed.cookie, { csrf_token: "wrong-token", content: "x" });
    expect(res.statusCode).toBe(403);
    expect((await getOrder(prisma, orderId))!.status).toBe("PROCESSING");
  });

  it("GET order detail: canFulfill is true only while PROCESSING, and customerData/customerDataFields are labeled for the client", async () => {
    const orderId = await makeProcessingOrder();
    const res = await app.inject({ method: "GET", url: `/api/orders/${orderId}`, cookies: { [COOKIE]: seed.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canFulfill).toBe(true);
    expect(body.customerDataFields).toEqual([]); // plain MANUAL denom has no custom fields
    expect(body.customerData).toEqual([]);

    // Once delivered, canFulfill flips back off.
    await post(`/api/orders/${orderId}/fulfill`, seed.cookie, { csrf_token: seed.csrf, content: "user:x" });
    const after = await app.inject({ method: "GET", url: `/api/orders/${orderId}`, cookies: { [COOKIE]: seed.cookie } });
    expect(after.json().canFulfill).toBe(false);
  });
});

// ---- orders API (React panel): approve/resend deliver via the outbox ------

describe("orders API — approve/resend enqueue the buyer's account DM", () => {
  function postJson(url: string, cookie: string | null, csrf: string | null, body: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

  async function makeWebOnlyDeliveredOrder(loginUsername: string): Promise<number> {
    const web = await createWebUser(prisma, {
      loginUsername,
      email: `${loginUsername}@shop.test`,
      passwordHash: "x",
    });
    const order = (await createOrderDirect(prisma, { user: web, productId: seed.productId, quantity: 1 }))!;
    await attachPaymentProof(prisma, order.id, { fileId: "proof", txid: `TX${loginUsername.toUpperCase()}` });
    return order.id;
  }

  it("approve enqueues the buyer's ORDER_DELIVERED_DM for a Telegram buyer", async () => {
    const orderId = await makePendingOrder();
    const res = await postJson(`/api/orders/${orderId}/approve`, seed.cookie, seed.csrf);
    expect(res.statusCode).toBe(200);
    expect((await getOrder(prisma, orderId))!.status).toBe("DELIVERED");

    const dm = await prisma.notificationOutbox.findFirst({ where: { orderId, event: "ORDER_DELIVERED_DM" } });
    expect(dm).not.toBeNull();
    expect(JSON.parse(dm!.payloadJson).chat_id).toBe(CUSTOMER_TG);
  });

  it("approve skips the DM for a web-only buyer (no Telegram id)", async () => {
    const orderId = await makeWebOnlyDeliveredOrder("webbuyer1");
    const res = await postJson(`/api/orders/${orderId}/approve`, seed.cookie, seed.csrf);
    expect(res.statusCode).toBe(200);

    const dm = await prisma.notificationOutbox.findFirst({ where: { orderId, event: "ORDER_DELIVERED_DM" } });
    expect(dm).toBeNull();
  });

  it("resend re-enqueues the DM for an already-delivered order", async () => {
    const orderId = await makePendingOrder();
    await postJson(`/api/orders/${orderId}/approve`, seed.cookie, seed.csrf);
    expect(
      await prisma.notificationOutbox.count({ where: { orderId, event: "ORDER_DELIVERED_DM" } }),
    ).toBe(1);

    const res = await postJson(`/api/orders/${orderId}/resend`, seed.cookie, seed.csrf);
    expect(res.statusCode).toBe(200);
    expect(
      await prisma.notificationOutbox.count({ where: { orderId, event: "ORDER_DELIVERED_DM" } }),
    ).toBe(2);

    const audit = await prisma.auditLog.findMany({
      where: { action: "order_resend_credentials", targetId: orderId },
    });
    expect(audit.length).toBe(1);
  });

  it("resend rejects an order that isn't delivered yet (422)", async () => {
    const orderId = await makePendingOrder(); // still PENDING_VERIFICATION
    const res = await postJson(`/api/orders/${orderId}/resend`, seed.cookie, seed.csrf);
    expect(res.statusCode).toBe(422);
  });

  it("resend rejects a web-only buyer's order (422)", async () => {
    const orderId = await makeWebOnlyDeliveredOrder("webbuyer2");
    await postJson(`/api/orders/${orderId}/approve`, seed.cookie, seed.csrf);

    const res = await postJson(`/api/orders/${orderId}/resend`, seed.cookie, seed.csrf);
    expect(res.statusCode).toBe(422);
  });

  it("resend requires auth (anon → 303 /login)", async () => {
    const orderId = await makePendingOrder();
    await postJson(`/api/orders/${orderId}/approve`, seed.cookie, seed.csrf);
    const res = await postJson(`/api/orders/${orderId}/resend`, null, "anything");
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("resend rejects bad CSRF (403)", async () => {
    const orderId = await makePendingOrder();
    await postJson(`/api/orders/${orderId}/approve`, seed.cookie, seed.csrf);
    const res = await postJson(`/api/orders/${orderId}/resend`, seed.cookie, "wrong-token");
    expect(res.statusCode).toBe(403);
  });

  // Regression: a manually-fulfilled order (fulfillManualOrder) never reserves
  // a stockItem, so re-sending via ORDER_DELIVERED_DM would produce an empty
  // credentials file for the buyer (audit-per-sku-delivery-flows-2026-07-13.md
  // finding #1). The resend route must branch to ORDER_MANUAL_DELIVERED_DM
  // (enqueueManualDeliveredDm, which reads deliveredContent live) instead.
  it("resend on a manually-fulfilled order enqueues ORDER_MANUAL_DELIVERED_DM, not ORDER_DELIVERED_DM", async () => {
    const orderId = await makeProcessingOrder();
    await postJson(`/api/orders/${orderId}/fulfill`, seed.cookie, seed.csrf, { content: "user:x pass:y" });
    expect((await getOrder(prisma, orderId))!.status).toBe("DELIVERED");
    // fulfillManualOrder itself already enqueued one ORDER_MANUAL_DELIVERED_DM
    // row — the resend below must add a SECOND one of the same event, never
    // an ORDER_DELIVERED_DM (which would carry no credentials for this order).
    expect(
      await prisma.notificationOutbox.count({ where: { orderId, event: "ORDER_MANUAL_DELIVERED_DM" } }),
    ).toBe(1);

    const res = await postJson(`/api/orders/${orderId}/resend`, seed.cookie, seed.csrf);
    expect(res.statusCode).toBe(200);

    expect(
      await prisma.notificationOutbox.count({ where: { orderId, event: "ORDER_MANUAL_DELIVERED_DM" } }),
    ).toBe(2);
    expect(
      await prisma.notificationOutbox.count({ where: { orderId, event: "ORDER_DELIVERED_DM" } }),
    ).toBe(0);
  });
});

// ---- Orders admin-page refactor: pagination, KPIs, cancel, bulk-action ----

function postJsonOrders(url: string, cookie: string | null, csrf: string | null, body: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
    cookies: cookie ? { [COOKIE]: cookie } : {},
    payload: JSON.stringify(body),
  });
}

describe("GET /api/orders — pageSize resolution + eligibility", () => {
  it("accepts each valid pageSize option and echoes it back", async () => {
    for (const size of [20, 50, 100]) {
      const res = await get(`/api/orders?pageSize=${size}`, seed.cookie);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).pageSize).toBe(size);
    }
  });

  it("falls back to 20 for an invalid pageSize", async () => {
    const res = await get("/api/orders?pageSize=999", seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).pageSize).toBe(20);
  });

  it("defaults to 20 when pageSize is omitted", async () => {
    const res = await get("/api/orders", seed.cookie);
    expect(JSON.parse(res.body).pageSize).toBe(20);
  });

  it("list rows carry a server-computed eligibility object", async () => {
    await makePendingOrder();
    const res = await get("/api/orders", seed.cookie);
    const data = JSON.parse(res.body) as { orders: Array<{ eligibility: { canAct: boolean; isDelivered: boolean } }> };
    expect(data.orders[0]!.eligibility).toMatchObject({ canAct: true, isDelivered: false });
  });
});

describe("CSV export — q multi-field search + ids filter", () => {
  it("q now matches customer identity fields too, not just orderCode", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 314159, username: "csvsearchuser", fullName: "CSV Search" });
    await createOrderDirect(prisma, { user: buyer, productId: seed.productId, quantity: 1 });
    await makePendingOrder(); // unrelated order, must be excluded

    const res = await get("/api/orders/export?q=csvsearchuser", seed.cookie);
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split("\r\n");
    expect(lines.length - 1).toBe(1);
  });

  it("ids restricts the export to exactly the selected rows", async () => {
    const orderA = await makePendingOrder();
    await makePendingOrder(); // not selected, must be excluded

    const res = await get(`/api/orders/export?ids=${orderA}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split("\r\n");
    expect(lines.length - 1).toBe(1);
  });
});

describe("GET /api/orders/kpis", () => {
  it("returns the global KPI snapshot shape, ignoring any list filters", async () => {
    setBotIdentity({ publicChannelId: -100123456789 });
    await makePendingOrder(); // stays PENDING_VERIFICATION
    const deliveredId = await makePendingOrder();
    await post(`/api/orders/${deliveredId}/approve`, seed.cookie, { csrf_token: seed.csrf });

    const res = await get("/api/orders/kpis", seed.cookie);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      totalOrders: expect.any(Number),
      awaitingFulfillment: expect.any(Number),
      processing: expect.any(Number),
      delivered: expect.any(Number),
      cancelled: expect.any(Number),
    });
    // shapeRevenue nulls out a zero currency (dashboard.ts convention) — just
    // assert the three keys are present, not truthy.
    expect(Object.keys(body.revenueToday).sort()).toEqual(["idr", "usd", "usdt"]);
    expect(body.delivered).toBeGreaterThanOrEqual(1);
    expect(body.totalOrders).toBeGreaterThanOrEqual(2);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const res = await get("/api/orders/kpis", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});

describe("POST /api/orders/:orderId/cancel", () => {
  it("cancels a PENDING_VERIFICATION order and audits with the reason", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/cancel`, seed.cookie, {
      csrf_token: seed.csrf,
      reason: "buyer requested",
    });
    expect(res.statusCode).toBe(200);
    const order = (await getOrder(prisma, orderId))!;
    expect(order.status).toBe("CANCELLED");
    const audit = await prisma.auditLog.findMany({ where: { action: "cancel_order", targetId: orderId } });
    expect(audit.length).toBe(1);
    expect(audit[0]!.details).toBe(`Cancelled order ${order.orderCode}: "buyer requested".`);
  });

  it("requires a non-empty reason (400)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/cancel`, seed.cookie, { csrf_token: seed.csrf, reason: "   " });
    expect(res.statusCode).toBe(400);
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("refuses to cancel an already-DELIVERED order (422)", async () => {
    setBotIdentity({ publicChannelId: -100123456789 });
    const orderId = await makePendingOrder();
    await post(`/api/orders/${orderId}/approve`, seed.cookie, { csrf_token: seed.csrf });
    const res = await post(`/api/orders/${orderId}/cancel`, seed.cookie, { csrf_token: seed.csrf, reason: "too late" });
    expect(res.statusCode).toBe(422);
    expect((await getOrder(prisma, orderId))!.status).toBe("DELIVERED");
  });

  it("requires auth (anon → 303 /login)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/cancel`, null, { csrf_token: "anything", reason: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF (403)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/cancel`, seed.cookie, { csrf_token: "wrong-token", reason: "x" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/orders/bulk-action", () => {
  it("bulk deliver: eligible PENDING_VERIFICATION orders succeed, a PROCESSING (manual) order is skipped, exactly one summary audit row", async () => {
    setBotIdentity({ publicChannelId: -100123456789 });
    const eligible1 = await makePendingOrder();
    const eligible2 = await makePendingOrder();
    const ineligible = await makeProcessingOrder(); // canFulfill, NOT canAct — must be skipped, not bulk-delivered

    const res = await postJsonOrders("/api/orders/bulk-action", seed.cookie, seed.csrf, {
      ids: [eligible1, eligible2, ineligible],
      action: "deliver",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { succeeded: number[]; failed: { id: number; error: string }[] };
    expect(body.succeeded.slice().sort((a, b) => a - b)).toEqual([eligible1, eligible2].sort((a, b) => a - b));
    expect(body.failed).toEqual([{ id: ineligible, error: "error.not_eligible" }]);

    expect((await getOrder(prisma, eligible1))!.status).toBe("DELIVERED");
    expect((await getOrder(prisma, eligible2))!.status).toBe("DELIVERED");
    expect((await getOrder(prisma, ineligible))!.status).toBe("PROCESSING");

    const audit = await prisma.auditLog.findMany({ where: { action: "order_bulk_deliver" } });
    expect(audit.length).toBe(1);
    expect(audit[0]!.details).toBe("Bulk deliver: 2 succeeded, 1 failed (of 3 selected).");
  });

  it("bulk resend: only an already-DELIVERED order with a Telegram buyer succeeds", async () => {
    const delivered = await makePendingOrder();
    await post(`/api/orders/${delivered}/approve`, seed.cookie, { csrf_token: seed.csrf });
    const notDelivered = await makePendingOrder();

    const res = await postJsonOrders("/api/orders/bulk-action", seed.cookie, seed.csrf, {
      ids: [delivered, notDelivered],
      action: "resend",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { succeeded: number[]; failed: { id: number; error: string }[] };
    expect(body.succeeded).toEqual([delivered]);
    expect(body.failed).toEqual([{ id: notDelivered, error: "error.not_eligible" }]);

    const audit = await prisma.auditLog.findMany({ where: { action: "order_bulk_resend" } });
    expect(audit.length).toBe(1);
  });

  it("bulk cancel: requires a reason, cancels eligible orders, skips an already-delivered one", async () => {
    const cancelable = await makePendingOrder();
    const delivered = await makePendingOrder();
    await post(`/api/orders/${delivered}/approve`, seed.cookie, { csrf_token: seed.csrf });

    const missingReason = await postJsonOrders("/api/orders/bulk-action", seed.cookie, seed.csrf, {
      ids: [cancelable],
      action: "cancel",
    });
    expect(missingReason.statusCode).toBe(400);

    const res = await postJsonOrders("/api/orders/bulk-action", seed.cookie, seed.csrf, {
      ids: [cancelable, delivered],
      action: "cancel",
      reason: "storewide cleanup",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { succeeded: number[]; failed: { id: number; error: string }[] };
    expect(body.succeeded).toEqual([cancelable]);
    expect(body.failed).toEqual([{ id: delivered, error: "error.not_eligible" }]);
    expect((await getOrder(prisma, cancelable))!.status).toBe("CANCELLED");

    const audit = await prisma.auditLog.findMany({ where: { action: "order_bulk_cancel" } });
    expect(audit.length).toBe(1);
    expect(audit[0]!.details).toBe("Bulk cancel: 1 succeeded, 1 failed (of 2 selected).");
  });

  it("an unknown order id lands in failed with error.order_not_found, not a hard error for the whole batch", async () => {
    const res = await postJsonOrders("/api/orders/bulk-action", seed.cookie, seed.csrf, {
      ids: [999999],
      action: "cancel",
      reason: "x",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { succeeded: number[]; failed: { id: number; error: string }[] };
    expect(body.succeeded).toEqual([]);
    expect(body.failed).toEqual([{ id: 999999, error: "error.order_not_found" }]);
  });

  it("caps a batch at 50 ids (400)", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    const res = await postJsonOrders("/api/orders/bulk-action", seed.cookie, seed.csrf, {
      ids,
      action: "cancel",
      reason: "x",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown action (400)", async () => {
    const orderId = await makePendingOrder();
    const res = await postJsonOrders("/api/orders/bulk-action", seed.cookie, seed.csrf, {
      ids: [orderId],
      action: "explode",
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires auth (anon → 303 /login)", async () => {
    const orderId = await makePendingOrder();
    const res = await postJsonOrders("/api/orders/bulk-action", null, null, {
      ids: [orderId],
      action: "cancel",
      reason: "x",
    });
    expect(res.statusCode).toBe(303);
  });

  it("rejects bad CSRF (403)", async () => {
    const orderId = await makePendingOrder();
    const res = await postJsonOrders("/api/orders/bulk-action", seed.cookie, "wrong-token", {
      ids: [orderId],
      action: "cancel",
      reason: "x",
    });
    expect(res.statusCode).toBe(403);
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

  // NOTE: create/update category, create/update product, and delete-product
  // legacy-route tests were removed here — their behavior (happy path + audit,
  // auth-fail, bad-CSRF, and the "not empty" / 404 error shapes) is now
  // covered against the live JSON API in the "catalog JSON API — create
  // product", "catalog JSON API — create category", and "catalog JSON API —
  // category update/toggle, product delete/bulk-active, bulk pricing" describe
  // blocks below. Editing a mid-tier Product's own name/description (and its
  // `return_to` redirect) has no JSON API replacement at all — the React
  // ProductDetailPage only ever calls the active-toggle and delete endpoints
  // (apps/web-admin/client/src/pages/ProductDetailPage.tsx), so that specific
  // capability is genuinely gone rather than moved.

  it("product photo upload sets webImageUrl and audits with the product name", async () => {
    const mp = multipart(
      { csrf_token: seed.csrf },
      { field: "photo", filename: "p.png", contentType: "image/png", content: PNG_1x1 },
    );
    const res = await postMultipart(`/catalog/product/${seed.catalogProductId}/photo`, seed.cookie, mp);
    expect(res.statusCode).toBe(200);
    const product = await getCatalogProduct(prisma, seed.catalogProductId);
    expect(product!.webImageUrl).toMatch(/^\/uploads\/products\/product-[0-9a-f]+\.png$/);
    const audit = await prisma.auditLog.findFirst({ where: { action: "product_photo_upload" } });
    expect(audit).toBeTruthy();
    expect(audit!.targetType).toBe("product");
    expect(audit!.targetId).toBe(seed.catalogProductId);
    expect(audit!.details).toContain(product!.name);
  });

  it("product photo upload replaces the old file", async () => {
    const mp1 = multipart(
      { csrf_token: seed.csrf },
      { field: "photo", filename: "p1.png", contentType: "image/png", content: PNG_1x1 },
    );
    await postMultipart(`/catalog/product/${seed.catalogProductId}/photo`, seed.cookie, mp1);
    const first = (await getCatalogProduct(prisma, seed.catalogProductId))!.webImageUrl;

    const mp2 = multipart(
      { csrf_token: seed.csrf },
      { field: "photo", filename: "p2.png", contentType: "image/png", content: PNG_1x1 },
    );
    await postMultipart(`/catalog/product/${seed.catalogProductId}/photo`, seed.cookie, mp2);
    const second = (await getCatalogProduct(prisma, seed.catalogProductId))!.webImageUrl;

    expect(second).not.toBe(first);
    expect(existsSync(join(UPLOADS_DIR, "products", first!.replace(/^\/uploads\/products\//, "")))).toBe(false);
  });

  it("product photo upload rejects a spoofed MIME (image/png header, non-image bytes)", async () => {
    const mp = multipart(
      { csrf_token: seed.csrf },
      { field: "photo", filename: "evil.png", contentType: "image/png", content: Buffer.from("GIF89a not really a png <?php ?>") },
    );
    const res = await postMultipart(`/catalog/product/${seed.catalogProductId}/photo`, seed.cookie, mp);
    expect(res.statusCode).toBe(400);
    expect((await getCatalogProduct(prisma, seed.catalogProductId))!.webImageUrl).toBeNull();
  });

  it("product photo upload 404s for an unknown product", async () => {
    const mp = multipart(
      { csrf_token: seed.csrf },
      { field: "photo", filename: "p.png", contentType: "image/png", content: PNG_1x1 },
    );
    const res = await postMultipart("/catalog/product/999999/photo", seed.cookie, mp);
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Product not found.");
  });

  it("product photo upload rejects bad CSRF", async () => {
    const mp = multipart(
      { csrf_token: "bad" },
      { field: "photo", filename: "p.png", contentType: "image/png", content: PNG_1x1 },
    );
    const res = await postMultipart(`/catalog/product/${seed.catalogProductId}/photo`, seed.cookie, mp);
    expect(res.statusCode).toBe(403);
  });

  it("product photo upload requires auth", async () => {
    const mp = multipart(
      { csrf_token: seed.csrf },
      { field: "photo", filename: "p.png", contentType: "image/png", content: PNG_1x1 },
    );
    const res = await postMultipart(`/catalog/product/${seed.catalogProductId}/photo`, null, mp);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
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

  it("rejects a non-existent categoryId with 400", async () => {
    const res = await postProductJson(seed.cookie, seed.csrf, { name: "X", categoryId: 99999 });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/category/i);
  });

  it("rejects bad CSRF with 403", async () => {
    const res = await postProductJson(seed.cookie, "bad-token", { name: "X", categoryId: seed.categoryId });
    expect(res.statusCode).toBe(403);
  });
});

// ---- catalog JSON API — create category ------------------------------------

describe("catalog JSON API — create category", () => {
  function postCategoryJson(cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/catalog/categories",
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

  it("happy path: creates category and logs audit", async () => {
    const before = await prisma.category.count();
    const res = await postCategoryJson(seed.cookie, seed.csrf, { name: "Streaming" });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { category: { id: number; name: string; slug: string } };
    expect(body.category.name).toBe("Streaming");
    expect(typeof body.category.slug).toBe("string");
    expect(body.category.slug.length).toBeGreaterThan(0);
    expect(await prisma.category.count()).toBe(before + 1);
    const audit = await prisma.auditLog.findMany({
      where: { action: "category_create", targetId: body.category.id },
    });
    expect(audit.length).toBe(1);
    expect(audit[0]?.details).toBe(`Created category "Streaming".`);
  });

  it("rejects empty name with 400", async () => {
    const res = await postCategoryJson(seed.cookie, seed.csrf, { name: "" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects whitespace-only name with 400", async () => {
    const res = await postCategoryJson(seed.cookie, seed.csrf, { name: "   " });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects missing auth (anon → 303 /login)", async () => {
    const res = await postCategoryJson(null, "x", { name: "Streaming" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF with 403", async () => {
    const res = await postCategoryJson(seed.cookie, "bad-token", { name: "Streaming" });
    expect(res.statusCode).toBe(403);
  });
});

// ---- catalog JSON API — create denomination --------------------------------

describe("catalog JSON API — create denomination", () => {
  function postDenominationJson(
    productId: number,
    cookie: string | null,
    csrf: string | null,
    body: Record<string, unknown>,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/catalog/products/${productId}/denominations`,
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

  it("happy path: creates denomination and logs audit", async () => {
    const before = await prisma.denomination.count();
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number; name: string; slug: string };
    expect(body.name).toBe("1 Month");
    expect(typeof body.slug).toBe("string");
    expect(body.slug.length).toBeGreaterThan(0);
    expect(await prisma.denomination.count()).toBe(before + 1);
    const audit = await prisma.auditLog.findMany({
      where: { action: "denomination_create", targetId: body.id },
    });
    expect(audit.length).toBe(1);
    expect(audit[0]?.details).toBe(`Created denomination "1 Month" for product ${seed.catalogProductId}.`);
  });

  it("rejects missing name with 400", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects invalid type with 400", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "BOGUS",
      durationLabel: "1 Month",
      price: "15000",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects missing durationLabel with 400", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      price: "15000",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects an invalid price with 400", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "not-a-number",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects a non-existent productId with 404", async () => {
    const res = await postDenominationJson(99999, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects missing auth (anon → 303 /login)", async () => {
    const res = await postDenominationJson(seed.catalogProductId, null, "x", {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("rejects bad CSRF with 403", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, "bad-token", {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates a manual-delivery SKU with no custom fields required", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "manual",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.deliveryType).toBe("manual");
    expect(row!.additionalFields).toBeNull();
  });

  it("creates a manual_with_info SKU with valid custom fields and stores them as JSON", async () => {
    const fields = [
      { key: "ign", label: { id: "IGN", en: "IGN" }, type: "text", required: true, options: [], placeholder: "" },
    ];
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "manual_with_info",
      additionalFields: fields,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.deliveryType).toBe("manual_with_info");
    expect(JSON.parse(row!.additionalFields!)).toEqual(fields);
  });

  it("rejects a manual_with_info SKU with zero custom fields (400) and writes nothing", async () => {
    const before = await prisma.denomination.count();
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "manual_with_info",
      additionalFields: [],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
    expect(await prisma.denomination.count()).toBe(before);
  });

  it("rejects a manual_with_info SKU with an invalid field shape (400) and writes nothing", async () => {
    const before = await prisma.denomination.count();
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "manual_with_info",
      additionalFields: [{ key: "Bad Key!", label: { id: "x", en: "x" }, type: "text" }],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
    expect(await prisma.denomination.count()).toBe(before);
  });

  it("rejects an invalid deliveryType with 400", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "bogus",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("rejects a manual_with_info SKU when additionalFields is a pre-stringified JSON string instead of an array (400) and writes nothing", async () => {
    // Pins the client/server contract from the server side: the route expects
    // additionalFields to already be a decoded array (zAdditionalFields =
    // z.array(...)), same as `fields` in the "stores them as JSON" test above.
    // A caller that JSON.stringify()s the array before sending it — the bug
    // that made the real admin UI double-encode this field and fail every
    // manual_with_info submission with a 400 — must be rejected here too.
    const before = await prisma.denomination.count();
    const fields = [
      { key: "ign", label: { id: "IGN", en: "IGN" }, type: "text", required: true, options: [], placeholder: "" },
    ];
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "manual_with_info",
      additionalFields: JSON.stringify(fields),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
    expect(await prisma.denomination.count()).toBe(before);
  });

  it("defaults deliveryType to auto and additionalFields to null when omitted", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.deliveryType).toBe("auto");
    expect(row!.additionalFields).toBeNull();
  });

  it("ignores a stray additionalFields payload when deliveryType is not manual_with_info", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "auto",
      additionalFields: [
        { key: "ign", label: { id: "IGN", en: "IGN" }, type: "text", required: true, options: [], placeholder: "" },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.additionalFields).toBeNull();
  });
});

// ---- catalog JSON API — active toggle --------------------------------------

describe("catalog JSON API — active toggle", () => {
  function postJson(url: string, cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

  describe("POST /api/catalog/products/:id/active", () => {
    it("happy path: deactivates a product and audits", async () => {
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/active`, seed.cookie, seed.csrf, {
        active: false,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: seed.catalogProductId, isActive: false });
      expect((await getCatalogProduct(prisma, seed.catalogProductId))!.isActive).toBe(false);

      const audit = await prisma.auditLog.findFirst({
        where: { action: "product_active_toggle", targetId: seed.catalogProductId },
      });
      expect(audit).toBeTruthy();
      expect(audit?.targetType).toBe("product");
      expect(audit?.adminId).toBe(seed.adminId);
      const product = await getCatalogProduct(prisma, seed.catalogProductId);
      expect(audit?.details).toBe(`Deactivated product "${product!.name}".`);
    });

    it("happy path: reactivates a product and audits", async () => {
      await postJson(`/api/catalog/products/${seed.catalogProductId}/active`, seed.cookie, seed.csrf, { active: false });
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/active`, seed.cookie, seed.csrf, {
        active: true,
      });
      expect(res.statusCode).toBe(200);
      expect((await getCatalogProduct(prisma, seed.catalogProductId))!.isActive).toBe(true);
      const audit = await prisma.auditLog.findFirst({
        where: { action: "product_active_toggle", targetId: seed.catalogProductId },
        orderBy: { id: "desc" },
      });
      const product = await getCatalogProduct(prisma, seed.catalogProductId);
      expect(audit?.details).toBe(`Activated product "${product!.name}".`);
    });

    it("rejects a non-boolean active with 400", async () => {
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/active`, seed.cookie, seed.csrf, {
        active: "false",
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBeTruthy();
    });

    it("rejects a non-existent product id with 404", async () => {
      const res = await postJson(`/api/catalog/products/99999/active`, seed.cookie, seed.csrf, { active: false });
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/active`, null, "x", { active: false });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/active`, seed.cookie, "bad-token", {
        active: false,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/catalog/denominations/:id/active", () => {
    it("happy path: deactivates a denomination and audits", async () => {
      const res = await postJson(`/api/catalog/denominations/${seed.productId}/active`, seed.cookie, seed.csrf, {
        active: false,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: seed.productId, isActive: false });
      expect((await getDenomination(prisma, seed.productId))!.isActive).toBe(false);

      const audit = await prisma.auditLog.findFirst({
        where: { action: "denomination_active_toggle", targetId: seed.productId },
      });
      expect(audit).toBeTruthy();
      expect(audit?.targetType).toBe("denomination");
      expect(audit?.adminId).toBe(seed.adminId);
      const denom = await getDenomination(prisma, seed.productId);
      expect(audit?.details).toBe(`Deactivated denomination "${denom!.name}".`);
    });

    it("rejects a non-existent denomination id with 404", async () => {
      const res = await postJson(`/api/catalog/denominations/99999/active`, seed.cookie, seed.csrf, { active: false });
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await postJson(`/api/catalog/denominations/${seed.productId}/active`, null, "x", { active: false });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/catalog/denominations/${seed.productId}/active`, seed.cookie, "bad-token", {
        active: false,
      });
      expect(res.statusCode).toBe(403);
    });
  });
});

describe("catalog JSON API — category update/toggle, product delete/bulk-active, bulk pricing", () => {
  function postJson(url: string, cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }
  function patchJson(url: string, cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url,
      headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }
  function deleteJson(url: string, cookie: string | null, csrf: string | null) {
    return app.inject({
      method: "DELETE",
      url,
      headers: csrf ? { "x-csrf-token": csrf } : {},
      cookies: cookie ? { [COOKIE]: cookie } : {},
    });
  }

  describe("PATCH /api/catalog/categories/:id", () => {
    it("happy path: updates a category and audits", async () => {
      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, seed.csrf, {
        name: "Renamed Cat",
        emoji: "🌟",
        description: "desc",
        sortOrder: 2,
      });
      expect(res.statusCode).toBe(200);
      const cat = await prisma.category.findUnique({ where: { id: seed.categoryId } });
      expect(cat!.name).toBe("Renamed Cat");
      expect(cat!.description).toBe("desc");
      const audit = await prisma.auditLog.findFirst({ where: { action: "category_update", targetId: seed.categoryId } });
      expect(audit?.details).toBe(`Updated category "Renamed Cat".`);
    });

    it("rejects empty name with 400", async () => {
      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, seed.csrf, { name: "" });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a non-existent category id with 404", async () => {
      const res = await patchJson(`/api/catalog/categories/99999`, seed.cookie, seed.csrf, { name: "X" });
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, null, "x", { name: "X" });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, "bad-token", { name: "X" });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/catalog/categories/:id/active", () => {
    it("happy path: toggles a category and audits", async () => {
      const res = await postJson(`/api/catalog/categories/${seed.categoryId}/active`, seed.cookie, seed.csrf, { active: false });
      expect(res.statusCode).toBe(200);
      expect((await prisma.category.findUnique({ where: { id: seed.categoryId } }))!.isActive).toBe(false);
      const audit = await prisma.auditLog.findFirst({ where: { action: "category_toggle", targetId: seed.categoryId } });
      expect(audit).toBeTruthy();
    });

    it("rejects a non-boolean active with 400", async () => {
      const res = await postJson(`/api/catalog/categories/${seed.categoryId}/active`, seed.cookie, seed.csrf, { active: "false" });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await postJson(`/api/catalog/categories/${seed.categoryId}/active`, null, "x", { active: false });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/catalog/categories/${seed.categoryId}/active`, seed.cookie, "bad-token", { active: false });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("DELETE /api/catalog/products/:id", () => {
    it("happy path: deletes an empty product and audits", async () => {
      await prisma.denomination.deleteMany({ where: { productId: seed.catalogProductId } });
      const res = await deleteJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, seed.csrf);
      expect(res.statusCode).toBe(200);
      expect(await getCatalogProduct(prisma, seed.catalogProductId)).toBeNull();
      const audit = await prisma.auditLog.findFirst({ where: { action: "product_delete", targetId: seed.catalogProductId } });
      expect(audit).toBeTruthy();
    });

    it("refuses with 409 while the product still has denominations", async () => {
      const res = await deleteJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, seed.csrf);
      expect(res.statusCode).toBe(409);
      expect(await getCatalogProduct(prisma, seed.catalogProductId)).not.toBeNull();
    });

    it("rejects a non-existent product id with 404", async () => {
      const res = await deleteJson(`/api/catalog/products/99999`, seed.cookie, seed.csrf);
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await deleteJson(`/api/catalog/products/${seed.catalogProductId}`, null, "x");
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await deleteJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, "bad-token");
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/catalog/products/bulk-active", () => {
    it("happy path: deactivates multiple products and audits with a count", async () => {
      const other = await createCatalogProduct(prisma, { categoryId: seed.categoryId, name: "Other" });
      const res = await postJson(`/api/catalog/products/bulk-active`, seed.cookie, seed.csrf, {
        ids: [seed.catalogProductId, other.id],
        active: false,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, count: 2 });
      expect((await getCatalogProduct(prisma, seed.catalogProductId))!.isActive).toBe(false);
      expect((await getCatalogProduct(prisma, other.id))!.isActive).toBe(false);
      const audit = await prisma.auditLog.findFirst({ where: { action: "product_bulk_active" } });
      expect(audit?.details).toBe("Deactivated 2 products.");
    });

    it("rejects an empty ids array with 400", async () => {
      const res = await postJson(`/api/catalog/products/bulk-active`, seed.cookie, seed.csrf, { ids: [], active: false });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await postJson(`/api/catalog/products/bulk-active`, null, "x", { ids: [seed.catalogProductId], active: false });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/catalog/products/bulk-active`, seed.cookie, "bad-token", { ids: [seed.catalogProductId], active: false });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/catalog/products/:id/archive", () => {
    it("happy path: archives a product and audits", async () => {
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/archive`, seed.cookie, seed.csrf, {
        archived: true,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ id: seed.catalogProductId, isArchived: true });
      expect((await getCatalogProduct(prisma, seed.catalogProductId))!.isArchived).toBe(true);

      const audit = await prisma.auditLog.findFirst({
        where: { action: "product_archive_toggle", targetId: seed.catalogProductId },
      });
      expect(audit).toBeTruthy();
      expect(audit?.targetType).toBe("product");
      expect(audit?.adminId).toBe(seed.adminId);
      const product = await getCatalogProduct(prisma, seed.catalogProductId);
      expect(audit?.details).toBe(`Archived product "${product!.name}".`);
    });

    it("happy path: unarchives a product and audits", async () => {
      await postJson(`/api/catalog/products/${seed.catalogProductId}/archive`, seed.cookie, seed.csrf, { archived: true });
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/archive`, seed.cookie, seed.csrf, {
        archived: false,
      });
      expect(res.statusCode).toBe(200);
      expect((await getCatalogProduct(prisma, seed.catalogProductId))!.isArchived).toBe(false);
      const audit = await prisma.auditLog.findFirst({
        where: { action: "product_archive_toggle", targetId: seed.catalogProductId },
        orderBy: { id: "desc" },
      });
      const product = await getCatalogProduct(prisma, seed.catalogProductId);
      expect(audit?.details).toBe(`Unarchived product "${product!.name}".`);
    });

    it("rejects a non-boolean archived with 400", async () => {
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/archive`, seed.cookie, seed.csrf, {
        archived: "true",
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBeTruthy();
    });

    it("rejects a non-existent product id with 404", async () => {
      const res = await postJson(`/api/catalog/products/99999/archive`, seed.cookie, seed.csrf, { archived: true });
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/archive`, null, "x", { archived: true });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/archive`, seed.cookie, "bad-token", {
        archived: true,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/catalog/products/bulk-archive", () => {
    it("happy path: archives multiple products and audits with a count", async () => {
      const other = await createCatalogProduct(prisma, { categoryId: seed.categoryId, name: "Other" });
      const res = await postJson(`/api/catalog/products/bulk-archive`, seed.cookie, seed.csrf, {
        ids: [seed.catalogProductId, other.id],
        archived: true,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, count: 2 });
      expect((await getCatalogProduct(prisma, seed.catalogProductId))!.isArchived).toBe(true);
      expect((await getCatalogProduct(prisma, other.id))!.isArchived).toBe(true);
      const audit = await prisma.auditLog.findFirst({ where: { action: "product_bulk_archive" } });
      expect(audit?.details).toBe("Archived 2 products.");
    });

    it("rejects an empty ids array with 400", async () => {
      const res = await postJson(`/api/catalog/products/bulk-archive`, seed.cookie, seed.csrf, { ids: [], archived: true });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await postJson(`/api/catalog/products/bulk-archive`, null, "x", { ids: [seed.catalogProductId], archived: true });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/catalog/products/bulk-archive`, seed.cookie, "bad-token", { ids: [seed.catalogProductId], archived: true });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("bulk pricing (POST/DELETE /api/catalog/denominations/:id/bulk-pricing)", () => {
    it("happy path: sets bulk pricing and audits", async () => {
      const res = await postJson(`/api/catalog/denominations/${seed.productId}/bulk-pricing`, seed.cookie, seed.csrf, {
        minQuantity: 5,
        discountPercent: "10",
      });
      expect(res.statusCode).toBe(200);
      const rule = await prisma.bulkPricing.findUnique({ where: { productId: seed.productId } });
      expect(rule!.minQuantity).toBe(5);
      expect(Number(rule!.discountPercent)).toBe(10);
      const audit = await prisma.auditLog.findFirst({ where: { action: "bulk_pricing_set", targetId: seed.productId } });
      expect(audit).toBeTruthy();
    });

    it("happy path: removes bulk pricing and audits", async () => {
      await postJson(`/api/catalog/denominations/${seed.productId}/bulk-pricing`, seed.cookie, seed.csrf, {
        minQuantity: 5,
        discountPercent: "10",
      });
      const res = await deleteJson(`/api/catalog/denominations/${seed.productId}/bulk-pricing`, seed.cookie, seed.csrf);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, removed: true });
      expect(await prisma.bulkPricing.findUnique({ where: { productId: seed.productId } })).toBeNull();
      const audit = await prisma.auditLog.findFirst({ where: { action: "bulk_pricing_delete", targetId: seed.productId } });
      expect(audit).toBeTruthy();
    });

    it("removing when no rule exists returns removed: false and does not audit", async () => {
      const res = await deleteJson(`/api/catalog/denominations/${seed.productId}/bulk-pricing`, seed.cookie, seed.csrf);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, removed: false });
      expect(await prisma.auditLog.findFirst({ where: { action: "bulk_pricing_delete" } })).toBeNull();
    });

    it("rejects a discount percent outside (0,100] with 422", async () => {
      const res = await postJson(`/api/catalog/denominations/${seed.productId}/bulk-pricing`, seed.cookie, seed.csrf, {
        minQuantity: 5,
        discountPercent: "150",
      });
      expect(res.statusCode).toBe(422);
      expect(await prisma.bulkPricing.findUnique({ where: { productId: seed.productId } })).toBeNull();
    });

    it("rejects an invalid minQuantity with 400", async () => {
      const res = await postJson(`/api/catalog/denominations/${seed.productId}/bulk-pricing`, seed.cookie, seed.csrf, {
        minQuantity: 0,
        discountPercent: "10",
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a non-existent denomination id with 404", async () => {
      const res = await postJson(`/api/catalog/denominations/99999/bulk-pricing`, seed.cookie, seed.csrf, {
        minQuantity: 5,
        discountPercent: "10",
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await postJson(`/api/catalog/denominations/${seed.productId}/bulk-pricing`, null, "x", {
        minQuantity: 5,
        discountPercent: "10",
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/catalog/denominations/${seed.productId}/bulk-pricing`, seed.cookie, "bad-token", {
        minQuantity: 5,
        discountPercent: "10",
      });
      expect(res.statusCode).toBe(403);
    });
  });

});

describe("flash sales bulk API — /api/flash-sales/*", () => {
  function getJson(url: string, cookie: string | null) {
    return app.inject({ method: "GET", url, cookies: cookie ? { [COOKIE]: cookie } : {} });
  }
  function postJson(url: string, cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

  const shopLocal = (msFromNow: number) => localize(new Date(Date.now() + msFromNow), "yyyy-LL-dd'T'HH:mm");
  const HOUR = 3_600_000;

  /** A second denomination under a second product, so bulk actions have >1 SKU to select. */
  async function makeSecondDenomination(): Promise<number> {
    const cat2 = await createCategory(prisma, `BulkFlashCat${Math.random()}`);
    const product2 = await createCatalogProduct(prisma, { categoryId: cat2.id, name: "Second Product" });
    const denom2 = await createDenomination(prisma, {
      productId: product2.id,
      name: "1 Month",
      type: ProductType.SHARED,
      durationLabel: "1 Month",
      price: "20.00",
    });
    return denom2.id;
  }

  describe("GET /api/flash-sales/denominations", () => {
    it("happy path: lists denominations across products with flash status", async () => {
      const secondId = await makeSecondDenomination();
      const res = await getJson("/api/flash-sales/denominations", seed.cookie);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { denominations: Array<{ id: number; flash: { discountPercent: string } | null }> };
      const ids = body.denominations.map((d) => d.id);
      expect(ids).toContain(seed.productId);
      expect(ids).toContain(secondId);
      expect(body.denominations.find((d) => d.id === seed.productId)!.flash).toBeNull();
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await getJson("/api/flash-sales/denominations", null);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });
  });

  describe("POST /api/flash-sales/bulk-apply", () => {
    it("happy path: applies one schedule to many SKUs across products and audits by count", async () => {
      const secondId = await makeSecondDenomination();
      const res = await postJson("/api/flash-sales/bulk-apply", seed.cookie, seed.csrf, {
        denominationIds: [seed.productId, secondId],
        discountPercent: "20",
        startsAt: shopLocal(HOUR),
        endsAt: shopLocal(5 * HOUR),
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, applied: 2, overwritten: 0, failed: 0 });

      const d1 = await getDenomination(prisma, seed.productId);
      const d2 = await getDenomination(prisma, secondId);
      expect(Number(d1!.flashDiscountPercent)).toBe(20);
      expect(Number(d2!.flashDiscountPercent)).toBe(20);

      const audit = await prisma.auditLog.findFirst({ where: { action: "flash_sale_bulk_set" } });
      expect(audit).toBeTruthy();
      expect(audit?.targetType).toBe("denomination");
      expect(audit?.adminId).toBe(seed.adminId);
      expect(audit?.details).toContain("2 SKU(s)");
    });

    it("reports how many replaced an existing schedule", async () => {
      await postJson("/api/flash-sales/bulk-apply", seed.cookie, seed.csrf, {
        denominationIds: [seed.productId],
        discountPercent: "5",
        startsAt: shopLocal(HOUR),
        endsAt: shopLocal(2 * HOUR),
      });
      const res = await postJson("/api/flash-sales/bulk-apply", seed.cookie, seed.csrf, {
        denominationIds: [seed.productId],
        discountPercent: "30",
        startsAt: shopLocal(HOUR),
        endsAt: shopLocal(5 * HOUR),
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, applied: 1, overwritten: 1, failed: 0 });
    });

    it("mixed valid/invalid ids: applies to the valid one and reports the rest as failed", async () => {
      const res = await postJson("/api/flash-sales/bulk-apply", seed.cookie, seed.csrf, {
        denominationIds: [seed.productId, 999999],
        discountPercent: "20",
        startsAt: shopLocal(HOUR),
        endsAt: shopLocal(5 * HOUR),
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, applied: 1, overwritten: 0, failed: 1 });
    });

    it("rejects an empty selection with 400", async () => {
      const res = await postJson("/api/flash-sales/bulk-apply", seed.cookie, seed.csrf, {
        denominationIds: [],
        discountPercent: "20",
        startsAt: shopLocal(HOUR),
        endsAt: shopLocal(5 * HOUR),
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an invalid discount percent with 400", async () => {
      const res = await postJson("/api/flash-sales/bulk-apply", seed.cookie, seed.csrf, {
        denominationIds: [seed.productId],
        discountPercent: "not-a-number",
        startsAt: shopLocal(HOUR),
        endsAt: shopLocal(5 * HOUR),
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an invalid window with 400", async () => {
      const res = await postJson("/api/flash-sales/bulk-apply", seed.cookie, seed.csrf, {
        denominationIds: [seed.productId],
        discountPercent: "20",
        startsAt: "not-a-date",
        endsAt: shopLocal(5 * HOUR),
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await postJson("/api/flash-sales/bulk-apply", null, "x", {
        denominationIds: [seed.productId],
        discountPercent: "20",
        startsAt: shopLocal(HOUR),
        endsAt: shopLocal(5 * HOUR),
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson("/api/flash-sales/bulk-apply", seed.cookie, "bad-token", {
        denominationIds: [seed.productId],
        discountPercent: "20",
        startsAt: shopLocal(HOUR),
        endsAt: shopLocal(5 * HOUR),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/flash-sales/bulk-end", () => {
    it("happy path: clears the schedule on selected SKUs and audits by count", async () => {
      const secondId = await makeSecondDenomination();
      await postJson("/api/flash-sales/bulk-apply", seed.cookie, seed.csrf, {
        denominationIds: [seed.productId, secondId],
        discountPercent: "20",
        startsAt: shopLocal(HOUR),
        endsAt: shopLocal(5 * HOUR),
      });

      const res = await postJson("/api/flash-sales/bulk-end", seed.cookie, seed.csrf, {
        denominationIds: [seed.productId, secondId],
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, cleared: 2, skipped: 0 });

      const d1 = await getDenomination(prisma, seed.productId);
      expect(d1!.flashDiscountPercent).toBeNull();

      const audit = await prisma.auditLog.findFirst({ where: { action: "flash_sale_bulk_end" } });
      expect(audit?.details).toBe("Ended the flash sale on 2 SKU(s).");
    });

    it("reports SKUs with nothing scheduled as skipped", async () => {
      const res = await postJson("/api/flash-sales/bulk-end", seed.cookie, seed.csrf, {
        denominationIds: [seed.productId],
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, cleared: 0, skipped: 1 });
    });

    it("rejects an empty selection with 400", async () => {
      const res = await postJson("/api/flash-sales/bulk-end", seed.cookie, seed.csrf, { denominationIds: [] });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await postJson("/api/flash-sales/bulk-end", null, "x", { denominationIds: [seed.productId] });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson("/api/flash-sales/bulk-end", seed.cookie, "bad-token", {
        denominationIds: [seed.productId],
      });
      expect(res.statusCode).toBe(403);
    });
  });
});

describe("denominations (leaf SKU, inside product detail)", () => {
  // create denomination happy/auth/CSRF: covered by "catalog JSON API — create
  // denomination" (POST /api/catalog/products/:productId/denominations).

  // NOTE: sort_order and cross-product re-parenting (product_id) aren't read
  // by the JSON PATCH route at all (apps/web-admin/src/routes/api/catalog.ts)
  // and the React ProductDetailPage never sends them — genuinely dropped
  // capabilities, not moved ones. The old "quick toggle" test's guarantee
  // (toggling active doesn't touch other columns) is preserved by the
  // dedicated POST /api/catalog/denominations/:id/active endpoint tested in
  // "catalog JSON API — active toggle" instead of this full-update route.

  it("update denomination happy + audit", async () => {
    const res = await patchForm(`/api/catalog/denominations/${seed.productId}`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Renamed Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "7.00",
    });
    expect(res.statusCode).toBe(200);
    const d = await getDenomination(prisma, seed.productId);
    expect(d!.name).toBe("Renamed Denom");
    expect(Number(d!.price)).toBeCloseTo(7);
    const audit = await prisma.auditLog.findMany({ where: { action: "denomination_update" } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("full edit form CAN clear cost_price/reseller_price/description by omitting them", async () => {
    await updateDenomination(prisma, seed.productId, {
      costPrice: new Decimal("3.00"),
      resellerPrice: new Decimal("4.00"),
      description: "Shared profile",
    });
    // The JSON PATCH route always writes costPrice/resellerPrice/description
    // from the body — a field absent (or blank) from the request clears it,
    // there's no separate "quick toggle" partial-update shape anymore.
    const res = await patchForm(`/api/catalog/denominations/${seed.productId}`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Renamed Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "7.00",
    });
    expect(res.statusCode).toBe(200);
    const d = await getDenomination(prisma, seed.productId);
    expect(d!.costPrice).toBeNull();
    expect(d!.resellerPrice).toBeNull();
    expect(d!.description).toBeNull();
  });

  it("update denomination requires auth", async () => {
    const res = await patchForm(`/api/catalog/denominations/${seed.productId}`, null, { name: "Hax", type: "SHARED", durationLabel: "x", price: "1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("update denomination rejects bad CSRF", async () => {
    const res = await patchForm(`/api/catalog/denominations/${seed.productId}`, seed.cookie, { csrf_token: "bad", name: "Hax", type: "SHARED", durationLabel: "x", price: "1" });
    expect(res.statusCode).toBe(403);
  });

  it("delete denomination refuses with order history, succeeds without", async () => {
    const extra = await createDenomination(prisma, {
      productId: seed.catalogProductId,
      name: "Deletable",
      type: ProductType.SHARED,
      durationLabel: "1 Month",
      price: "3.00",
    });
    const res = await deleteForm(`/api/catalog/denominations/${extra.id}`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect(await getDenomination(prisma, extra.id)).toBeNull();
  });

  it("delete denomination with order history is blocked", async () => {
    // seed.productId is already stocked — place an order against it first.
    const user = (await getUser(prisma, seed.customerId))!;
    await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 });
    const blocked = await deleteForm(`/api/catalog/denominations/${seed.productId}`, seed.cookie, { csrf_token: seed.csrf });
    expect(blocked.statusCode).toBe(409);
    expect(await getDenomination(prisma, seed.productId)).not.toBeNull();
  });

  it("delete denomination requires auth", async () => {
    const res = await deleteForm(`/api/catalog/denominations/${seed.productId}`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("delete denomination rejects bad CSRF", async () => {
    const res = await deleteForm(`/api/catalog/denominations/${seed.productId}`, seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
  });

  // bulk-pricing set/remove/auth/CSRF: covered by "catalog JSON API —
  // category update/toggle, product delete/bulk-active, bulk pricing" (POST
  // /DELETE /api/catalog/denominations/:id/bulk-pricing).
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

  // NOTE: the return_to-honoring/hostile-return_to tests that lived here were
  // removed along with the legacy POST /catalog/product/:id/update route —
  // there's no JSON API replacement for editing a Product's own
  // name/description (see the note in the "catalog" describe block above), so
  // return_to (a legacy-form-only redirect concept) has nothing left to test.
});

describe("denomination-to-product assignment (carry-over: parent is mandatory)", () => {
  // NOTE: the "moving a denomination to a sibling product" / "across
  // categories" tests that lived here were removed — the legacy
  // POST /catalog/denomination/:id/update route supported re-parenting via a
  // product_id field, but PATCH /api/catalog/denominations/:id (its JSON
  // replacement; see "denominations (leaf SKU, inside product detail)" above)
  // never reads productId from the body, and the React
  // ProductDetailPage has no move-to-another-product UI at all
  // (apps/web-admin/client/src/pages/ProductDetailPage.tsx only calls
  // active-toggle and delete) — so re-parenting a denomination is genuinely
  // gone, not moved. The schema invariant below (parent is mandatory at the DB
  // level) still holds regardless.
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
    const res = await post(`/api/stock/${seed.productId}/bulk-add`, seed.cookie, {
      csrf_token: seed.csrf,
      credentials: "new1@e.com:p\nnew2@e.com:p",
    });
    expect(res.statusCode).toBe(200);
    expect(await countAvailableStock(prisma, seed.productId)).toBe(before + 2);

    const audit = await prisma.auditLog.findMany({ where: { action: "stock_upload", targetId: seed.productId } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit.every((a) => !(a.details ?? "").includes("@"))).toBe(true);
  });

  it("bulk add requires auth", async () => {
    const res = await post(`/api/stock/${seed.productId}/bulk-add`, null, { csrf_token: "x", credentials: "leak@e.com:p" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("bulk add rejects bad CSRF", async () => {
    const res = await post(`/api/stock/${seed.productId}/bulk-add`, seed.cookie, { csrf_token: "nope", credentials: "x@e.com:p" });
    expect(res.statusCode).toBe(403);
  });

  // Data-1: bulkAddStock is called inside prisma.$transaction (see
  // routes/api/stock.ts) so two concurrent uploads of the SAME fresh
  // credential can't both pass the "not already present" check and both
  // insert — SQLite's single-writer transaction serializes them, so the
  // second one sees the first one's row and skips it as a duplicate.
  it("two concurrent bulk-adds of the same credential never create duplicate AVAILABLE rows", async () => {
    const dupCred = `race${counter}@e.com:p`;
    const before = await countAvailableStock(prisma, seed.productId);

    const [res1, res2] = await Promise.all([
      post(`/api/stock/${seed.productId}/bulk-add`, seed.cookie, { csrf_token: seed.csrf, credentials: dupCred }),
      post(`/api/stock/${seed.productId}/bulk-add`, seed.cookie, { csrf_token: seed.csrf, credentials: dupCred }),
    ]);
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    // Exactly one of the two requests actually added the credential; the
    // other must have seen it as a duplicate and skipped it.
    const bodies = [JSON.parse(res1.body), JSON.parse(res2.body)] as { added: number; skipped: number }[];
    expect(bodies.reduce((sum, b) => sum + b.added, 0)).toBe(1);
    expect(bodies.reduce((sum, b) => sum + b.skipped, 0)).toBe(1);

    expect(await countAvailableStock(prisma, seed.productId)).toBe(before + 1);
    const rows = await prisma.stockItem.findMany({ where: { productId: seed.productId, credentials: dupCred } });
    expect(rows.length).toBe(1);
  });

  it("restock broadcast message names both the product type and the denomination", async () => {
    const cat = await createCategory(prisma, `BroadcastCat${counter++}`);
    const parentProduct = await createCatalogProduct(prisma, {
      categoryId: cat.id,
      name: "Netflix Premium",
      description: "x",
    });
    const denom = await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "1 Month",
      type: ProductType.SHARED,
      durationLabel: "1 Month",
      price: "5.00",
      description: "x",
    });
    await updateDenomination(prisma, denom.id, { broadcastOnRestock: true });

    const res = await post(`/api/stock/${denom.id}/bulk-add`, seed.cookie, {
      csrf_token: seed.csrf,
      credentials: `bcast${counter}@e.com:p`,
    });
    expect(res.statusCode).toBe(200);

    const broadcast = await prisma.broadcast.findFirst({ orderBy: { id: "desc" } });
    expect(broadcast?.message).toContain("Netflix Premium - 1 Month");

    const audit = await prisma.auditLog.findFirst({ where: { action: "restock_broadcast", targetId: denom.id } });
    expect(audit?.details).toContain("Netflix Premium - 1 Month");
  });

  // bulk delete / download happy paths: covered by "stock JSON API —
  // bulk-dead, bulk-delete, item note/dead, download" below.

  it("download requires auth", async () => {
    const res = await get(`/api/stock/${seed.productId}/download`, null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  // The Stock Items table shows the account credential (masked, with a reveal
  // toggle), so the detail payload must carry it — but nothing more of the raw
  // row than the page actually renders.
  it("detail returns each item's credential and no order linkage", async () => {
    const res = await get(`/api/stock/${seed.productId}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { items: Record<string, unknown>[] };
    expect(data.items.length).toBeGreaterThan(0);
    const item = data.items[0]!;
    expect(Object.keys(item).sort()).toEqual(
      ["createdAtDisplay", "credentials", "id", "note", "status"],
    );
    expect(typeof item.credentials).toBe("string");
    expect(item).not.toHaveProperty("orderId");
  });
});

describe("stock JSON API — bulk-dead, bulk-delete, item note/dead, download", () => {
  function postJson(url: string, cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

  describe("POST /api/stock/:productId/bulk-dead", () => {
    it("happy path marks items dead and audits without leaking credentials", async () => {
      const items = await prisma.stockItem.findMany({ where: { productId: seed.productId, status: "AVAILABLE" } });
      const ids = items.slice(0, 2).map((i) => i.id);
      const res = await postJson(`/api/stock/${seed.productId}/bulk-dead`, seed.cookie, seed.csrf, { ids, note: "leaked batch" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, count: 2 });
      for (const id of ids) expect((await prisma.stockItem.findUnique({ where: { id } }))!.status).toBe("DEAD");
      const audit = await prisma.auditLog.findMany({ where: { action: "stock_bulk_dead", targetId: seed.productId } });
      expect(audit.length).toBe(1);
      expect(audit.every((a) => !(a.details ?? "").includes("@"))).toBe(true);
    });

    it("rejects an empty ids array with 400", async () => {
      const res = await postJson(`/api/stock/${seed.productId}/bulk-dead`, seed.cookie, seed.csrf, { ids: [] });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await postJson(`/api/stock/${seed.productId}/bulk-dead`, null, "x", { ids: [1] });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/stock/${seed.productId}/bulk-dead`, seed.cookie, "bad-token", { ids: [1] });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/stock/:productId/bulk-delete", () => {
    it("happy path deletes available rows, keeps sold, and audits without leaking credentials", async () => {
      const avail = await prisma.stockItem.findMany({ where: { productId: seed.productId, status: "AVAILABLE" } });
      const delId = avail[0]!.id;
      const sold = await prisma.stockItem.update({ where: { id: avail[1]!.id }, data: { status: "SOLD", soldAt: new Date() } });
      const res = await postJson(`/api/stock/${seed.productId}/bulk-delete`, seed.cookie, seed.csrf, { ids: [delId, sold.id] });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, count: 1, skipped: 1 });
      expect(await prisma.stockItem.findUnique({ where: { id: delId } })).toBeNull();
      expect(await prisma.stockItem.findUnique({ where: { id: sold.id } })).not.toBeNull();
      const audit = await prisma.auditLog.findMany({ where: { action: "stock_bulk_delete", targetId: seed.productId } });
      expect(audit.length).toBe(1);
      expect(audit.every((a) => !(a.details ?? "").includes("@"))).toBe(true);
    });

    it("rejects an empty ids array with 400", async () => {
      const res = await postJson(`/api/stock/${seed.productId}/bulk-delete`, seed.cookie, seed.csrf, { ids: [] });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await postJson(`/api/stock/${seed.productId}/bulk-delete`, null, "x", { ids: [1] });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/stock/${seed.productId}/bulk-delete`, seed.cookie, "bad-token", { ids: [1] });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/stock/item/:stockId/dead", () => {
    it("happy path marks a single item dead and audits without leaking credentials", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId, status: "AVAILABLE" } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/dead`, seed.cookie, seed.csrf, { note: "checked and dead" });
      expect(res.statusCode).toBe(200);
      expect((await prisma.stockItem.findUnique({ where: { id: item.id } }))!.status).toBe("DEAD");
      const audit = await prisma.auditLog.findFirst({ where: { action: "stock_mark_dead", targetId: item.id } });
      expect(audit).toBeTruthy();
      expect((audit!.details ?? "").includes("@")).toBe(false);
    });

    it("rejects a non-existent stock item id with 404", async () => {
      const res = await postJson(`/api/stock/item/999999/dead`, seed.cookie, seed.csrf, {});
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/dead`, null, "x", {});
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/dead`, seed.cookie, "bad-token", {});
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/stock/item/:stockId/note", () => {
    it("happy path updates the note and audits", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/note`, seed.cookie, seed.csrf, { note: "checked ok" });
      expect(res.statusCode).toBe(200);
      expect((await prisma.stockItem.findUnique({ where: { id: item.id } }))!.note).toBe("checked ok");
      const audit = await prisma.auditLog.findFirst({ where: { action: "stock_edit_note", targetId: item.id } });
      expect(audit).toBeTruthy();
    });

    it("rejects a non-existent stock item id with 404", async () => {
      const res = await postJson(`/api/stock/item/999999/note`, seed.cookie, seed.csrf, { note: "x" });
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/note`, null, "x", { note: "x" });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/note`, seed.cookie, "bad-token", { note: "x" });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("GET /api/stock/:productId/download", () => {
    it("returns AVAILABLE credentials as a text attachment + audit by count", async () => {
      const avail = await prisma.stockItem.findMany({ where: { productId: seed.productId, status: "AVAILABLE" }, orderBy: { id: "asc" } });
      const res = await get(`/api/stock/${seed.productId}/download`, seed.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain(".txt");
      for (const it of avail) expect(res.body).toContain(it.credentials);

      const audit = await prisma.auditLog.findMany({ where: { action: "stock_download", targetId: seed.productId } });
      expect(audit.length).toBeGreaterThanOrEqual(1);
      expect(audit.every((a) => !(a.details ?? "").includes("@"))).toBe(true);
    });

    it("rejects a non-existent product id with 404", async () => {
      const res = await get(`/api/stock/999999/download`, seed.cookie);
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await get(`/api/stock/${seed.productId}/download`, null);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });
  });

  describe("GET /api/stock/export", () => {
    it("returns a CSV attachment with a header row and the seeded denomination", async () => {
      const denom = await getDenomination(prisma, seed.productId);
      const res = await get("/api/stock/export", seed.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain("stock.csv");
      expect(res.body.split("\r\n")[0]).toBe(
        "Denomination,Product,Category,Available,Reserved,Sold,Waiting,Status",
      );
      expect(res.body).toContain(denom!.name);
    });

    it("rejects missing auth (anon -> 303 /login)", async () => {
      const res = await get("/api/stock/export", null);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });
  });
});

// ---- users (acceptance #5) ------------------------------------------------

describe("users", () => {
  it("GET /api/users with no query returns the recent-customers list", async () => {
    const res = await get("/api/users", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { users: Array<{ username?: string; orderCount?: unknown }> };
    const cust = data.users.find((u) => u.username === "cust");
    expect(cust).toBeTruthy();
    expect(typeof cust!.orderCount).toBe("number");
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
    const res = await post(`/api/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: seed.csrf, delta: "5.00", note: "goodwill" });
    expect(res.statusCode).toBe(200);
    const after = (await getUser(prisma, seed.customerId))!.walletBalance;
    expect(Number(after) - Number(before)).toBeCloseTo(5);
    // L-9 (execution/10): a money-moving admin route must leave an audit trail.
    const audit = await prisma.auditLog.findMany({ where: { action: "wallet_adjust", targetId: seed.customerId } });
    expect(audit.length).toBe(1);
    expect(audit[0]!.adminId).toBe(seed.adminId);
  });

  it("set role happy (lowercase accepted)", async () => {
    const res = await post(`/api/users/${seed.customerId}/role`, seed.cookie, { csrf_token: seed.csrf, role: "reseller" });
    expect(res.statusCode).toBe(200);
    expect((await getUser(prisma, seed.customerId))!.role).toBe("RESELLER");
  });

  // Admin-5 (security audit, 2026-06-23): /users/:id/role must not be a back
  // door to ADMIN — that's a derived field synced from admin_ids, and
  // promotion goes through /admins only.
  it("set role refuses ADMIN — that's managed via /admins, not here", async () => {
    const res = await post(`/api/users/${seed.customerId}/role`, seed.cookie, { csrf_token: seed.csrf, role: "admin" });
    expect(res.statusCode).toBe(403);
    expect((await getUser(prisma, seed.customerId))!.role).not.toBe("ADMIN");
  });

  it("ban happy", async () => {
    const res = await post(`/api/users/${seed.customerId}/ban`, seed.cookie, { csrf_token: seed.csrf, banned: "true", reason: "abuse" });
    expect(res.statusCode).toBe(200);
    expect((await getUser(prisma, seed.customerId))!.banned).toBe(true);
  });

  it("wallet requires auth", async () => {
    const res = await post(`/api/users/${seed.customerId}/wallet`, null, { csrf_token: "x", delta: "1000" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("wallet rejects bad CSRF", async () => {
    const res = await post(`/api/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: "bad", delta: "1000" });
    expect(res.statusCode).toBe(403);
  });
});

// ---- users API — wallet currency (dual IDR/USDT wallet, admin panel) ------

describe("users API — wallet currency", () => {
  function postJson(url: string, cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

  it("defaults to IDR when currency is omitted", async () => {
    const before = await getUser(prisma, seed.customerId);
    const res = await postJson(`/api/users/${seed.customerId}/wallet`, seed.cookie, seed.csrf, { delta: "5.00", note: "goodwill" });
    expect(res.statusCode).toBe(200);
    const after = await getUser(prisma, seed.customerId);
    expect(Number(after!.walletBalance) - Number(before!.walletBalance)).toBeCloseTo(5);
    expect(Number(after!.walletBalanceUsdt)).toBe(Number(before!.walletBalanceUsdt));
  });

  it("adjusts the USDT balance when currency is USDT, leaving IDR untouched", async () => {
    const before = await getUser(prisma, seed.customerId);
    const res = await postJson(`/api/users/${seed.customerId}/wallet`, seed.cookie, seed.csrf, { delta: "2.50", note: "usdt credit", currency: "USDT" });
    expect(res.statusCode).toBe(200);
    const after = await getUser(prisma, seed.customerId);
    expect(Number(after!.walletBalanceUsdt) - Number(before!.walletBalanceUsdt)).toBeCloseTo(2.5);
    expect(Number(after!.walletBalance)).toBe(Number(before!.walletBalance));

    const ledgerRow = await prisma.walletTransaction.findFirst({
      where: { userId: seed.customerId, currency: "USDT" },
      orderBy: { id: "desc" },
    });
    expect(ledgerRow).not.toBeNull();
    expect(ledgerRow!.note).toBe("usdt credit");
  });

  it("rejects an invalid currency value with 400 and makes no balance change", async () => {
    const before = await getUser(prisma, seed.customerId);
    const res = await postJson(`/api/users/${seed.customerId}/wallet`, seed.cookie, seed.csrf, { delta: "1.00", note: "x", currency: "EUR" });
    expect(res.statusCode).toBe(400);
    const after = await getUser(prisma, seed.customerId);
    expect(Number(after!.walletBalance)).toBe(Number(before!.walletBalance));
    expect(Number(after!.walletBalanceUsdt)).toBe(Number(before!.walletBalanceUsdt));
  });
});

// ---- vouchers (acceptance #5) ---------------------------------------------

describe("vouchers", () => {
  it("create happy (lowercase code+type normalized)", async () => {
    const res = await post("/api/vouchers", seed.cookie, {
      csrf_token: seed.csrf, code: "save10", type: "percent", value: "10", usage_limit: "100", min_purchase: "0",
    });
    expect(res.statusCode).toBe(201);
    const v = await getVoucherByCode(prisma, "SAVE10");
    expect(v).not.toBeNull();
    expect(v!.isActive).toBe(true);
  });

  it("duplicate code rejected", async () => {
    const fields = { csrf_token: seed.csrf, code: "dup1", type: "percent", value: "5" };
    expect((await post("/api/vouchers", seed.cookie, fields)).statusCode).toBe(201);
    const res = await post("/api/vouchers", seed.cookie, fields);
    expect(res.statusCode).toBe(409);
  });

  it("toggle voucher", async () => {
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "tog1", type: "percent", value: "5" });
    const v = (await getVoucherByCode(prisma, "TOG1"))!;
    const res = await post(`/api/vouchers/${v.id}/toggle`, seed.cookie, { csrf_token: seed.csrf, is_active: "false" });
    expect(res.statusCode).toBe(200);
    expect((await prisma.voucher.findUnique({ where: { id: v.id } }))!.isActive).toBe(false);
  });

  it("create requires auth", async () => {
    const res = await post("/api/vouchers", null, { csrf_token: "x", code: "HAX", type: "percent", value: "99" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("create rejects bad CSRF", async () => {
    const res = await post("/api/vouchers", seed.cookie, { csrf_token: "bad", code: "HAX2", type: "percent", value: "99" });
    expect(res.statusCode).toBe(403);
  });

  it("delete voucher succeeds when never used, refuses once used", async () => {
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "del1", type: "percent", value: "5" });
    const v = (await getVoucherByCode(prisma, "DEL1"))!;

    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 1 } });
    const blocked = await post(`/api/vouchers/${v.id}/delete`, seed.cookie, { csrf_token: seed.csrf });
    expect(blocked.statusCode).toBe(409);
    expect(await prisma.voucher.findUnique({ where: { id: v.id } })).not.toBeNull();

    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 0 } });
    const ok = await post(`/api/vouchers/${v.id}/delete`, seed.cookie, { csrf_token: seed.csrf });
    expect(ok.statusCode).toBe(200);
    expect(await prisma.voucher.findUnique({ where: { id: v.id } })).toBeNull();
  });

  it("delete voucher requires auth", async () => {
    const res = await post("/api/vouchers/99999/delete", null, { csrf_token: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("delete voucher rejects bad CSRF", async () => {
    const res = await post("/api/vouchers/99999/delete", seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
  });

  it("GET /api/vouchers supports q, status, and page params, and returns stats + total", async () => {
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "SEARCHABLE1", type: "PERCENT", value: "10" });
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "OTHER2", type: "PERCENT", value: "5" });

    const res = await get("/api/vouchers?q=searchable", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as {
      vouchers: Array<{ code: string }>;
      total: number;
      page: number;
      pageSize: number;
      stats: { total: number; active: number; expiringSoon: number; usedUp: number };
    };
    expect(data.vouchers.map((v) => v.code)).toEqual(["SEARCHABLE1"]);
    expect(data.total).toBe(1);
    expect(data.page).toBe(1);
    expect(typeof data.pageSize).toBe("number");
    expect(data.stats.total).toBeGreaterThanOrEqual(2);
  });

  it("POST /api/vouchers/bulk-action deactivates a batch and audit-logs once (not per id)", async () => {
    const r1 = await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "BULKA1", type: "PERCENT", value: "10" });
    const r2 = await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "BULKA2", type: "PERCENT", value: "10" });
    const id1 = (JSON.parse(r1.body) as { voucher: { id: number } }).voucher.id;
    const id2 = (JSON.parse(r2.body) as { voucher: { id: number } }).voucher.id;

    const res = await postJsonOrders("/api/vouchers/bulk-action", seed.cookie, seed.csrf, {
      ids: [id1, id2],
      action: "deactivate",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { succeeded: number[]; failed: unknown[] };
    expect(body.succeeded.slice().sort((a, b) => a - b)).toEqual([id1, id2].sort((a, b) => a - b));
    expect(body.failed).toEqual([]);

    expect((await prisma.voucher.findUnique({ where: { id: id1 } }))!.isActive).toBe(false);
    expect((await prisma.voucher.findUnique({ where: { id: id2 } }))!.isActive).toBe(false);

    const audit = await prisma.auditLog.findMany({ where: { action: "voucher_bulk_deactivate" } });
    expect(audit.length).toBe(1);
  });

  it("POST /api/vouchers/bulk-action rejects an empty id list", async () => {
    const res = await postJsonOrders("/api/vouchers/bulk-action", seed.cookie, seed.csrf, {
      ids: [],
      action: "deactivate",
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/vouchers/bulk-action caps a batch at 50 ids (400)", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    const res = await postJsonOrders("/api/vouchers/bulk-action", seed.cookie, seed.csrf, {
      ids,
      action: "deactivate",
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/vouchers/bulk-action rejects an unknown action", async () => {
    const res = await postJsonOrders("/api/vouchers/bulk-action", seed.cookie, seed.csrf, {
      ids: [1],
      action: "nonsense",
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/vouchers/bulk-action delete reports per-id failures for used vouchers", async () => {
    const r1 = await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "BULKDEL1", type: "PERCENT", value: "10" });
    const r2 = await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "BULKDEL2", type: "PERCENT", value: "10" });
    const id1 = (JSON.parse(r1.body) as { voucher: { id: number } }).voucher.id;
    const id2 = (JSON.parse(r2.body) as { voucher: { id: number } }).voucher.id;
    await prisma.voucher.update({ where: { id: id2 }, data: { usedCount: 1 } });

    const res = await postJsonOrders("/api/vouchers/bulk-action", seed.cookie, seed.csrf, {
      ids: [id1, id2],
      action: "delete",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { succeeded: number[]; failed: { id: number; error: string }[] };
    expect(body.succeeded).toEqual([id1]);
    expect(body.failed).toEqual([{ id: id2, error: "cannot delete a voucher that has been used" }]);

    expect(await prisma.voucher.findUnique({ where: { id: id1 } })).toBeNull();
    expect(await prisma.voucher.findUnique({ where: { id: id2 } })).not.toBeNull();

    const audit = await prisma.auditLog.findMany({ where: { action: "voucher_bulk_delete" } });
    expect(audit.length).toBe(1);
  });

  it("POST /api/vouchers/bulk-action requires auth (anon -> 303 /login)", async () => {
    const res = await postJsonOrders("/api/vouchers/bulk-action", null, null, {
      ids: [1],
      action: "deactivate",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("POST /api/vouchers/bulk-action rejects bad CSRF (403)", async () => {
    const res = await postJsonOrders("/api/vouchers/bulk-action", seed.cookie, "wrong-token", {
      ids: [1],
      action: "deactivate",
    });
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
    const res = await post(`/api/support/${tid}/reply`, seed.cookie, { csrf_token: seed.csrf, content: "Looking into it." });
    expect(res.statusCode).toBe(200);
    const msgs = await listTicketMessages(prisma, tid, 10);
    const adminMsgs = msgs.filter((m) => m.senderType === "ADMIN");
    expect(adminMsgs.some((m) => m.content === "Looking into it.")).toBe(true);
  });

  it("close ticket", async () => {
    const tid = await makeTicket();
    const res = await post(`/api/support/${tid}/close`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect((await prisma.supportTicket.findUnique({ where: { id: tid } }))!.status).toBe("CLOSED");
  });

  it("reply requires auth", async () => {
    const tid = await makeTicket();
    const res = await post(`/api/support/${tid}/reply`, null, { csrf_token: "x", content: "hi" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("reply rejects bad CSRF", async () => {
    const tid = await makeTicket();
    const res = await post(`/api/support/${tid}/reply`, seed.cookie, { csrf_token: "bad", content: "hi" });
    expect(res.statusCode).toBe(403);
  });

  function postJson(url: string, cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

  describe("POST /api/support/:ticketId/assign", () => {
    async function makeSecondAdmin() {
      return upsertUser(prisma, { telegramId: 1000, username: "second", fullName: "Second Admin" });
    }

    it("happy path: assigns a ticket to an admin and audits", async () => {
      const tid = await makeTicket();
      const second = await makeSecondAdmin();
      const res = await postJson(`/api/support/${tid}/assign`, seed.cookie, seed.csrf, { adminId: second.id });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      expect((await prisma.supportTicket.findUnique({ where: { id: tid } }))!.adminId).toBe(second.id);

      const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_assign", targetId: tid } });
      expect(audit).toBeTruthy();
      expect(audit?.targetType).toBe("ticket");
      expect(audit?.adminId).toBe(seed.adminId);
      expect(audit?.details).toBe(`Assigned ticket #${tid} to "Second Admin".`);
    });

    it("unassign (adminId: null) clears the assignment and audits", async () => {
      const tid = await makeTicket();
      const second = await makeSecondAdmin();
      await postJson(`/api/support/${tid}/assign`, seed.cookie, seed.csrf, { adminId: second.id });

      const res = await postJson(`/api/support/${tid}/assign`, seed.cookie, seed.csrf, { adminId: null });
      expect(res.statusCode).toBe(200);
      expect((await prisma.supportTicket.findUnique({ where: { id: tid } }))!.adminId).toBeNull();

      const audit = await prisma.auditLog.findFirst({
        where: { action: "ticket_assign", targetId: tid },
        orderBy: { id: "desc" },
      });
      expect(audit?.details).toBe(`Unassigned ticket #${tid}.`);
    });

    it("rejects a non-existent ticket id with 404", async () => {
      const res = await postJson(`/api/support/99999/assign`, seed.cookie, seed.csrf, { adminId: null });
      expect(res.statusCode).toBe(404);
    });

    it("rejects a non-existent admin id with 400", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/assign`, seed.cookie, seed.csrf, { adminId: 999999 });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a non-number, non-null adminId with 400", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/assign`, seed.cookie, seed.csrf, { adminId: "7" });
      expect(res.statusCode).toBe(400);
    });

    it("requires auth (anon -> 303 /login)", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/assign`, null, "x", { adminId: null });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
    });

    it("rejects bad CSRF with 403", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/assign`, seed.cookie, "bad-token", { adminId: null });
      expect(res.statusCode).toBe(403);
    });
  });
});

// ---- settings (acceptance #4 secret-redaction + #5) -----------------------

describe("settings", () => {
  it("edit whitelisted key happy", async () => {
    const res = await post("/api/settings/edit", seed.cookie, { csrf_token: seed.csrf, key: "support_contact", value: "@helpdesk" });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "support_contact")).toBe("@helpdesk");
  });

  it("non-whitelisted key rejected, protected value untouched", async () => {
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "web_admin_password_hash:999", value: "x",
    });
    expect(res.statusCode).toBe(400);
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
    const res = await post("/api/settings/password", seed.cookie, {
      csrf_token: seed.csrf, current_password: "oldpassword", new_password: "newpassword1", confirm_password: "newpassword1",
    });
    expect(res.statusCode).toBe(200);
    const stored = await getSetting(prisma, passwordHashKey(ADMIN_TG));
    expect(verifyPassword("newpassword1", stored!)).toBe(true);
  });

  it("password change with wrong current rejected", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("realpw12"));
    const res = await post("/api/settings/password", seed.cookie, {
      csrf_token: seed.csrf, current_password: "wrongpw12", new_password: "newpassword1", confirm_password: "newpassword1",
    });
    expect(res.statusCode).toBe(403);
    expect(verifyPassword("realpw12", (await getSetting(prisma, passwordHashKey(ADMIN_TG)))!)).toBe(true);
  });

  it("edit requires auth", async () => {
    const res = await post("/api/settings/edit", null, { csrf_token: "x", key: "support_contact", value: "pwned" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("edit rejects bad CSRF", async () => {
    const res = await post("/api/settings/edit", seed.cookie, { csrf_token: "bad", key: "support_contact", value: "pwned" });
    expect(res.statusCode).toBe(403);
  });

  it("settings API includes support_whatsapp in editable fields", async () => {
    const res = await get("/api/settings", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { fields: Array<{ key: string }> };
    expect(data.fields.some((f) => f.key === "support_whatsapp")).toBe(true);
  });

  it("accepts binance_receive_uid (not a secret — exposed via the API)", async () => {
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "binance_receive_uid", value: "123456789",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "binance_receive_uid")).toBe("123456789");
    const page = await get("/api/settings", seed.cookie);
    const apiData = JSON.parse(page.body) as { fields: Array<{ key: string; value: string }> };
    expect(apiData.fields.find((f) => f.key === "binance_receive_uid")?.value).toBe("123456789");
  });

  it("binance_api_key / binance_api_secret are write-only (blank keeps value, never echoed)", async () => {
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "binance_api_key", value: "BINKEYSECRET",
    });
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "binance_api_secret", value: "BINSECRETVALUE",
    });
    expect(await getSetting(prisma, "binance_api_key")).toBe("BINKEYSECRET");
    expect(await getSetting(prisma, "binance_api_secret")).toBe("BINSECRETVALUE");

    // Blank submit keeps the existing value ({ ok: true, unchanged: true }).
    const blank = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "binance_api_key", value: "",
    });
    expect(blank.statusCode).toBe(200);
    expect(JSON.parse(blank.body)).toEqual({ ok: true, unchanged: true });
    expect(await getSetting(prisma, "binance_api_key")).toBe("BINKEYSECRET");

    // The stored secrets are never echoed into the settings API response.
    const page = await get("/api/settings", seed.cookie);
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
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "paydisini_userkey", value: "userkey123",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "paydisini_userkey")).toBe("userkey123");
    const page = await get("/api/settings", seed.cookie);
    const apiData = JSON.parse(page.body) as { fields: Array<{ key: string; value: string }> };
    expect(apiData.fields.find((f) => f.key === "paydisini_userkey")?.value).toBe("userkey123");
  });

  it("paydisini_apikey is write-only (blank keeps value, never echoed)", async () => {
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "paydisini_apikey", value: "PDAPIKEYSECRET",
    });
    expect(await getSetting(prisma, "paydisini_apikey")).toBe("PDAPIKEYSECRET");

    // Blank submit keeps the existing value ({ ok: true, unchanged: true }).
    const blank = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "paydisini_apikey", value: "",
    });
    expect(blank.statusCode).toBe(200);
    expect(JSON.parse(blank.body)).toEqual({ ok: true, unchanged: true });
    expect(await getSetting(prisma, "paydisini_apikey")).toBe("PDAPIKEYSECRET");

    // The stored secret is never echoed into the settings API response.
    const page = await get("/api/settings", seed.cookie);
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("PDAPIKEYSECRET");

    // Audit records "(updated)" without the value (CLAUDE.md: never log secrets).
    const logs = await listAuditLogs(prisma, { limit: 10 });
    const entry = logs.find((l) => l.action === "setting_set" && (l.details ?? "").includes("paydisini_apikey"));
    expect(entry).toBeTruthy();
    expect(entry!.details).not.toContain("PDAPIKEYSECRET");
  });

  it("accepts nowpayments_pay_currency (not a secret — exposed via the API)", async () => {
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_pay_currency", value: "usdttrc20",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "nowpayments_pay_currency")).toBe("usdttrc20");
    const page = await get("/api/settings", seed.cookie);
    const apiData = JSON.parse(page.body) as { fields: Array<{ key: string; value: string }> };
    expect(apiData.fields.find((f) => f.key === "nowpayments_pay_currency")?.value).toBe("usdttrc20");
  });

  it("nowpayments_api_key / nowpayments_ipn_secret are write-only (blank keeps value, never echoed)", async () => {
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_api_key", value: "NOWAPIKEYSECRET",
    });
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_ipn_secret", value: "NOWIPNSECRETVALUE",
    });
    expect(await getSetting(prisma, "nowpayments_api_key")).toBe("NOWAPIKEYSECRET");
    expect(await getSetting(prisma, "nowpayments_ipn_secret")).toBe("NOWIPNSECRETVALUE");

    // Blank submit keeps the existing value ({ ok: true, unchanged: true }).
    const blank = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_api_key", value: "",
    });
    expect(blank.statusCode).toBe(200);
    expect(JSON.parse(blank.body)).toEqual({ ok: true, unchanged: true });
    expect(await getSetting(prisma, "nowpayments_api_key")).toBe("NOWAPIKEYSECRET");

    // The stored secrets are never echoed into the settings API response.
    const page = await get("/api/settings", seed.cookie);
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
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_bsc_deposit_address", value: "0xMERCHANTADDR",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "bybit_bsc_deposit_address")).toBe("0xMERCHANTADDR");
    const page = await get("/api/settings", seed.cookie);
    const apiData = JSON.parse(page.body) as { fields: Array<{ key: string; value: string }> };
    expect(apiData.fields.find((f) => f.key === "bybit_bsc_deposit_address")?.value).toBe("0xMERCHANTADDR");
  });

  it("a positive number is accepted for any *_min_amount key", async () => {
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_bsc_min_amount", value: "10",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "bybit_bsc_min_amount")).toBe("10");
  });

  it("a blank *_min_amount value is accepted (hides the note)", async () => {
    await setSetting(prisma, "tokopay_min_amount", "5000");
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "tokopay_min_amount", value: "",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "tokopay_min_amount")).toBe("");
  });

  it("rejects a non-numeric *_min_amount value, leaving the prior value untouched", async () => {
    await setSetting(prisma, "nowpayments_min_amount", "3.5");
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_min_amount", value: "not-a-number",
    });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "nowpayments_min_amount")).toBe("3.5");
  });

  it("rejects a non-positive *_min_amount value (zero/negative)", async () => {
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_min_amount", value: "0",
    });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "bybit_min_amount")).toBeNull();
  });

  it("accepts a positive whole number for bybit_bsc_required_confirmations", async () => {
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_bsc_required_confirmations", value: "20",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "bybit_bsc_required_confirmations")).toBe("20");
  });

  it("rejects a non-whole-number bybit_bsc_required_confirmations value, leaving the prior value untouched", async () => {
    await setSetting(prisma, "bybit_bsc_required_confirmations", "15");
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_bsc_required_confirmations", value: "12.5",
    });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "bybit_bsc_required_confirmations")).toBe("15");
  });

  it("a blank bybit_bsc_required_confirmations value is accepted (falls back to the default)", async () => {
    await setSetting(prisma, "bybit_bsc_required_confirmations", "20");
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bybit_bsc_required_confirmations", value: "",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "bybit_bsc_required_confirmations")).toBe("");
  });

  it("bscscan_api_key is treated as a write-only secret (never echoed back, audited without the value)", async () => {
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bscscan_api_key", value: "SUPERSECRETBSCSCANKEY",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "bscscan_api_key")).toBe("SUPERSECRETBSCSCANKEY");

    const page = await get("/api/settings", seed.cookie);
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
    const res = await post("/api/settings/fx/refresh", seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16200");
  });

  it("a fetch failure flashes an error and keeps the saved rate", async () => {
    await setSetting(prisma, "usd_idr_rate", "16000");
    setFxRateFetcher(async () => {
      throw new Error("down");
    });
    const res = await post("/api/settings/fx/refresh", seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(503);
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16000");
  });

  it("refresh rejects bad CSRF", async () => {
    const res = await post("/api/settings/fx/refresh", seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
  });
});

// ---- bot credentials in Settings (plan.md §16) -----------------------------

describe("settings: bot tokens (§16)", () => {
  it("saves a Telegram-accepted token and auto-fills bot_username", async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bot_token", value: "123456:goodtokenvalue",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "bot_token")).toBe("123456:goodtokenvalue");
    expect(await getSetting(prisma, "bot_username")).toBe("MyShopBot");
  });

  it("rejects a token Telegram refuses — nothing is stored", async () => {
    setTokenValidator(async () => ({ ok: false }));
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bot_token", value: "123456:badtoken",
    });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });

  it("token edits are owner-only (support role refused)", async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    await setSetting(prisma, webRoleKey(ADMIN_TG), "support");
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bot_token", value: "123456:goodtokenvalue",
    });
    // The generic RBAC gate (support can't mutate /settings) or the explicit
    // owner check — either way: not saved.
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });

  it('a single "-" clears the saved token (recovery path back to env)', async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    await setSetting(prisma, "bot_token", "123456:oldtokenvalue");
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bot_token", value: "-",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "bot_token")).toBeNull();
  });

  it("audit never records the token value", async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "notif_bot_token", value: "999:notifsecrettoken",
    });
    const logs = await listAuditLogs(prisma, { limit: 5 });
    const entry = logs.find((l) => l.action === "setting_set" && (l.details ?? "").includes("notif_bot_token"));
    expect(entry).toBeTruthy();
    expect(entry!.details).not.toContain("notifsecrettoken");
  });

  it("saved tokens stay hidden via the settings API", async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "bot_token", value: "123456:goodtokenvalue",
    });
    const res = await get("/api/settings", seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("123456:goodtokenvalue");
  });

  it("resolves a channel link to its numeric id and saves it", async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    await setSetting(prisma, "bot_token", "123456:goodtokenvalue"); // a token must exist to resolve with
    setChannelValidator(async () => ({ ok: true, id: -1003960444894, title: "TESTIMONI" }));
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "t.me/testiilha",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "public_channel_id")).toBe("-1003960444894");
  });

  it("rejects an unresolvable channel — nothing is stored", async () => {
    await setSetting(prisma, "bot_token", "123456:goodtokenvalue");
    setChannelValidator(async () => ({ ok: false }));
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "@nope",
    });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "public_channel_id")).toBeNull();
  });

  it("rejects when no bot token is configured to resolve with", async () => {
    await deleteSetting(prisma, "bot_token");
    setChannelValidator(async () => ({ ok: true, id: -100123, title: "x" }));
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "@chan",
    });
    expect(res.statusCode).toBe(400);
    expect(await getSetting(prisma, "public_channel_id")).toBeNull();
  });

  it("channel edits are owner-only (support role refused)", async () => {
    await setSetting(prisma, "bot_token", "123456:goodtokenvalue");
    setChannelValidator(async () => ({ ok: true, id: -100123, title: "x" }));
    await setSetting(prisma, webRoleKey(ADMIN_TG), "support");
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "@chan",
    });
    expect(await getSetting(prisma, "public_channel_id")).toBeNull();
  });

  it('a single "-" clears the saved channel id', async () => {
    await setSetting(prisma, "public_channel_id", "-1003960444894");
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "-",
    });
    expect(res.statusCode).toBe(200);
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
    const res = await post(`/api/payments/order/${id}/deliver`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect((await getOrder(prisma, id))!.status).toBe("DELIVERED");
    const audit = await prisma.auditLog.findMany({ where: { action: "underpaid_deliver", targetId: id } });
    expect(audit.length).toBe(1);
  });

  it("refund underpaid → REFUNDED + wallet credit", async () => {
    const before = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    const id = await makeUnderpaidOrder("3.00");
    const res = await post(`/api/payments/order/${id}/refund`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect((await getOrder(prisma, id))!.status).toBe("REFUNDED");
    const after = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    expect(after - before).toBeCloseTo(3);
  });

  it("cancel underpaid → CANCELLED", async () => {
    const id = await makeUnderpaidOrder();
    const res = await post(`/api/payments/order/${id}/cancel`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect((await getOrder(prisma, id))!.status).toBe("CANCELLED");
  });

  it("manual match unmatched tx → delivered + ledger updated", async () => {
    // The testimonial channel post (ORDER_DELIVERED) only gets enqueued when
    // a public channel is configured.
    setBotIdentity({ publicChannelId: -100123456789 });
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { user, productId: seed.productId, quantity: 1 }))!;
    await recordUnmatchedTx(prisma, { binanceTxId: "MTX1", amount: "5.00" });
    const res = await post("/api/payments/match", seed.cookie, {
      csrf_token: seed.csrf,
      binance_tx_id: "MTX1",
      order_code: order.orderCode,
    });
    expect(res.statusCode).toBe(200);
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

    const res = await post("/api/payments/credit", seed.cookie, {
      csrf_token: seed.csrf,
      binance_tx_id: "CRTX1",
      order_code: order.orderCode,
    });
    expect(res.statusCode).toBe(200);

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
    const res = await post("/api/payments/credit", null, {
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
    const res = await post("/api/payments/credit", seed.cookie, {
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

  it("GET /api/payments returns todayCount and honors the q search param", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "SEARCHABLE-1", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "OTHER-2", amount: "1.00" });

    const res = await get("/api/payments", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { todayCount: number };
    expect(data.todayCount).toBeGreaterThanOrEqual(2);

    const filtered = await get("/api/payments?q=SEARCHABLE", seed.cookie);
    const filteredData = JSON.parse(filtered.body) as { ledger: Array<{ binanceTxId: string }> };
    expect(filteredData.ledger.map((tx) => tx.binanceTxId)).toEqual(["SEARCHABLE-1"]);
  });

  it("dismiss unmatched tx → outcome dismissed + audit", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "DTX1", amount: "1.00" });
    const res = await post("/api/payments/dismiss", seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "DTX1" });
    expect(res.statusCode).toBe(200);
    const tx = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "DTX1" } });
    expect(tx!.outcome).toBe("dismissed");
    const logs = await listAuditLogs(prisma, { limit: 5 });
    expect(logs.some((l) => l.action === "tx_dismiss")).toBe(true);
  });

  it("dismiss an already-dismissed (non-unmatched) tx → error, row unchanged", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "DTX3", amount: "1.00" });
    await post("/api/payments/dismiss", seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "DTX3" });
    // second dismiss: the row is no longer "unmatched" → rejected
    const res = await post("/api/payments/dismiss", seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "DTX3" });
    expect(res.statusCode).toBe(422);
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "DTX3" } }))!.outcome).toBe("dismissed");
  });

  it("dismiss requires auth (anon → /login)", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "DTX4", amount: "1.00" });
    const res = await post("/api/payments/dismiss", null, { csrf_token: "x", binance_tx_id: "DTX4" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "DTX4" } }))!.outcome).toBe("unmatched");
  });

  it("dismiss rejects bad CSRF", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "DTX5", amount: "1.00" });
    const res = await post("/api/payments/dismiss", seed.cookie, { csrf_token: "bad", binance_tx_id: "DTX5" });
    expect(res.statusCode).toBe(403);
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "DTX5" } }))!.outcome).toBe("unmatched");
  });

  it("deliver requires auth", async () => {
    const id = await makeUnderpaidOrder();
    const res = await post(`/api/payments/order/${id}/deliver`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await getOrder(prisma, id))!.status).toBe("UNDERPAID");
  });

  it("deliver rejects bad CSRF", async () => {
    const id = await makeUnderpaidOrder();
    const res = await post(`/api/payments/order/${id}/deliver`, seed.cookie, { csrf_token: "bad" });
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

    const res = await post("/api/payments/dismiss", seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "ATOMTX1" });
    // Not a ValidationError, so the route's catch rethrows → Fastify 500,
    // not the usual JSON error response.
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
    const res = await post(`/api/outbox/${id}/retry`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    const row = await prisma.notificationOutbox.findUnique({ where: { id } });
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(0);
    expect(row!.lastError).toBeNull();
    const audit = await prisma.auditLog.findMany({ where: { action: "outbox_retry", targetId: id } });
    expect(audit.length).toBe(1);
  });

  it("retry requires auth", async () => {
    const id = await makeFailedNotif();
    const res = await post(`/api/outbox/${id}/retry`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.notificationOutbox.findUnique({ where: { id } }))!.status).toBe("FAILED");
  });

  it("retry rejects bad CSRF", async () => {
    const id = await makeFailedNotif();
    const res = await post(`/api/outbox/${id}/retry`, seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
    expect((await prisma.notificationOutbox.findUnique({ where: { id } }))!.status).toBe("FAILED");
  });
});

// ---- wallet ledger (Tier 2 §4) --------------------------------------------

describe("wallet ledger", () => {
  it("adjustment requires a reason", async () => {
    const before = Number((await getUser(prisma, seed.customerId))!.walletBalance);
    const res = await post(`/api/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: seed.csrf, delta: "5.00" });
    expect(res.statusCode).toBe(400);
    expect(Number((await getUser(prisma, seed.customerId))!.walletBalance)).toBe(before);
  });

  it("ledger lists a prior adjustment with its reason", async () => {
    await post(`/api/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: seed.csrf, delta: "7.50", note: "promo credit" });
    const res = await get(`/api/users/${seed.customerId}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ledger: Array<{ note: string }> };
    expect(data.ledger.some((e) => e.note === "promo credit")).toBe(true);
  });
});

// ---- reviews moderation (Tier 2 §5) ---------------------------------------

describe("reviews moderation", () => {
  function postJson(url: string, cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

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
    const res = await postJson(`/api/reviews/${id}/hide`, seed.cookie, seed.csrf, { hidden: true });
    expect(res.statusCode).toBe(200);
    expect((await prisma.review.findUnique({ where: { id } }))!.hidden).toBe(true);
    const audit = await prisma.auditLog.findMany({ where: { action: "review_hide", targetId: id } });
    expect(audit.length).toBe(1);
  });

  it("unhide restores the review", async () => {
    const id = await makeReview(true);
    const res = await postJson(`/api/reviews/${id}/hide`, seed.cookie, seed.csrf, { hidden: false });
    expect(res.statusCode).toBe(200);
    expect((await prisma.review.findUnique({ where: { id } }))!.hidden).toBe(false);
  });

  it("hide requires auth", async () => {
    const id = await makeReview();
    const res = await postJson(`/api/reviews/${id}/hide`, null, "x", { hidden: true });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect((await prisma.review.findUnique({ where: { id } }))!.hidden).toBe(false);
  });

  it("hide rejects bad CSRF", async () => {
    const id = await makeReview();
    const res = await postJson(`/api/reviews/${id}/hide`, seed.cookie, "bad", { hidden: true });
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
  // bulk product active-toggle (happy path + empty-selection 400 + auth/CSRF):
  // covered by "catalog JSON API — category update/toggle, product
  // delete/bulk-active, bulk pricing" > "POST /api/catalog/products/bulk-active".
  // Bulk mark-stock-dead happy path: covered by "stock JSON API — bulk-dead,
  // bulk-delete, item note/dead, download" > "POST /api/stock/:productId/bulk-dead".

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
    const apply = await post("/api/catalog/products/import/apply", seed.cookie, { csrf_token: seed.csrf, csv });
    expect(apply.statusCode).toBe(200);
    expect(await prisma.product.count()).toBe(beforeProducts + 2);
    expect(await prisma.denomination.count()).toBe(beforeDenoms + 2);
    const b = await prisma.denomination.findFirst({ where: { name: "12 Months" } });
    expect(b!.type).toBe("PRIVATE");
    expect(Number(b!.costPrice)).toBeCloseTo(15);
    expect(Number(b!.resellerPrice)).toBeCloseTo(60);
    expect(b!.warrantyDays).toBe(30);
    expect(b!.description).toBe("nice");
    const audit = await prisma.auditLog.findMany({ where: { action: "catalog_import" } });
    expect(audit.length).toBe(1);
  });

  it("CSV import: re-uses an existing product by name instead of duplicating it", async () => {
    const cat = (await prisma.category.findUnique({ where: { id: seed.categoryId } }))!;
    const existing = await getCatalogProduct(prisma, seed.catalogProductId);
    const csv = `${cat.name} | ${existing!.name} | 1 Year | shared | 1 Year | 50`;
    const beforeProducts = await prisma.product.count();

    const apply = await post("/api/catalog/products/import/apply", seed.cookie, { csrf_token: seed.csrf, csv });
    expect(apply.statusCode).toBe(200);
    expect(await prisma.product.count()).toBe(beforeProducts); // no new product
    const newDenom = await prisma.denomination.findFirst({ where: { name: "1 Year" } });
    expect(newDenom!.productId).toBe(seed.catalogProductId);
  });

  it("CSV import: all-invalid is rejected on apply", async () => {
    const before = await prisma.denomination.count();
    const res = await post("/api/catalog/products/import/apply", seed.cookie, {
      csrf_token: seed.csrf, csv: "NoSuchCat | X | 1 Month | shared | 1 Month | 5",
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.denomination.count()).toBe(before);
  });

  it("CSV import apply requires auth and rejects bad CSRF", async () => {
    const anon = await post("/api/catalog/products/import/apply", null, { csrf_token: "x", csv: "a|b|c|shared|1 Month|5" });
    expect(anon.statusCode).toBe(303);
    expect(anon.headers.location).toBe("/login");
    const bad = await post("/api/catalog/products/import/apply", seed.cookie, { csrf_token: "bad", csv: "a|b|c|shared|1 Month|5" });
    expect(bad.statusCode).toBe(403);
  });
});

// ---- RBAC / multi-admin (Tier 3 §9) ---------------------------------------

describe("rbac", () => {
  const setRole = (tg: number, role: string) => setSetting(prisma, webRoleKey(tg), role);

  it("canMutate role/area matrix", () => {
    expect(canMutate("super", "/api/settings/edit")).toBe(true);
    expect(canMutate("readonly", "/api/orders/1/approve")).toBe(false);
    expect(canMutate("readonly", "/api/settings/password")).toBe(true); // self-service
    expect(canMutate("support", "/api/orders/1/approve")).toBe(true);
    expect(canMutate("support", "/api/reviews/1/hide")).toBe(true);
    expect(canMutate("support", "/api/catalog/category")).toBe(false);
    expect(canMutate("support", "/api/settings/edit")).toBe(false);
  });

  // Admin-4 (security audit, 2026-06-23): canMutate now strips the query
  // string itself, so callers that pass raw `req.url` (upload.ts, branding.ts,
  // catalog.ts) can't get an exact-match path check wrong.
  it("canMutate strips a query string itself, matching exact-path checks correctly", () => {
    expect(canMutate("readonly", "/api/settings/password?foo=bar")).toBe(true); // self-service, still matches
    expect(canMutate("support", "/api/orders/1/approve?ref=abc")).toBe(true);
    expect(canMutate("support", "/api/catalog/category?x=1")).toBe(false);
    expect(canMutate("readonly", "/api/orders/1/approve?x=1")).toBe(false);
  });

  it("readonly is blocked from mutations (403) but can still view", async () => {
    await setRole(ADMIN_TG, "readonly");
    const cat = await post("/api/catalog/categories", seed.cookie, { csrf_token: seed.csrf, name: "Nope" });
    expect(cat.statusCode).toBe(403);
    const approveAttempt = await post(`/api/payments/match`, seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "x", order_code: "y" });
    expect(approveAttempt.statusCode).toBe(403);
    expect((await get("/api/catalog", seed.cookie)).statusCode).toBe(200); // reads OK
  });

  it("support can mutate ops but not config", async () => {
    await setRole(ADMIN_TG, "support");
    const orderId = await makePendingOrder();
    const approve = await post(`/api/orders/${orderId}/approve`, seed.cookie, { csrf_token: seed.csrf });
    expect(approve.statusCode).toBe(200); // ops allowed
    expect((await getOrder(prisma, orderId))!.status).toBe("DELIVERED");
    const cat = await post("/api/catalog/categories", seed.cookie, { csrf_token: seed.csrf, name: "Denied" });
    expect(cat.statusCode).toBe(403); // config denied
  });

  it("/api/admins is super-only, assigns roles, and blocks self-demotion", async () => {
    expect((await get("/api/admins", seed.cookie)).statusCode).toBe(200); // super sees it

    const set = await post("/api/admins/1000/role", seed.cookie, { csrf_token: seed.csrf, role: "support" });
    expect(set.statusCode).toBe(200);
    expect(await getSetting(prisma, webRoleKey(1000))).toBe("support");

    const self = await post(`/api/admins/${ADMIN_TG}/role`, seed.cookie, { csrf_token: seed.csrf, role: "readonly" });
    expect(self.statusCode).toBe(403); // can't demote yourself
    expect(await getSetting(prisma, webRoleKey(ADMIN_TG))).not.toBe("readonly");

    const notAdmin = await post("/api/admins/424242/role", seed.cookie, { csrf_token: seed.csrf, role: "support" });
    expect(notAdmin.statusCode).toBe(404); // not in ADMIN_IDS

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
    const begin = await post("/api/settings/2fa/begin", seed.cookie, { csrf_token: seed.csrf });
    expect(begin.statusCode).toBe(200);
    const pending = await getSetting(prisma, twoFaPendingKey(ADMIN_TG));
    expect(pending).not.toBeNull();

    const wrong = await post("/api/settings/2fa/enable", seed.cookie, { csrf_token: seed.csrf, totp_code: "000000" });
    expect(wrong.statusCode).toBe(400);
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBeNull();

    const ok = await post("/api/settings/2fa/enable", seed.cookie, { csrf_token: seed.csrf, totp_code: currentTotp(pending!) });
    expect(ok.statusCode).toBe(200);
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

    const badPw = await post("/api/settings/2fa/disable", seed.cookie, { csrf_token: seed.csrf, current_password: "wrong", totp_code: currentTotp(secret) });
    expect(badPw.statusCode).toBe(403);
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBe(secret);

    const ok = await post("/api/settings/2fa/disable", seed.cookie, { csrf_token: seed.csrf, current_password: "pw12345678", totp_code: currentTotp(secret) });
    expect(ok.statusCode).toBe(200);
    expect(await getSetting(prisma, twoFaSecretKey(ADMIN_TG))).toBeNull();
  });

  it("a readonly admin can still manage their own 2FA", async () => {
    await setSetting(prisma, webRoleKey(ADMIN_TG), "readonly");
    const begin = await post("/api/settings/2fa/begin", seed.cookie, { csrf_token: seed.csrf });
    expect(begin.statusCode).toBe(200); // self-service allowed
  });
});

describe("session management", () => {
  it("super can force-logout another admin (rotates their jti); not self", async () => {
    await setSetting(prisma, sessionJtiKey(1000), "jti-1000");
    const res = await post("/api/admins/1000/logout", seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, sessionJtiKey(1000))).not.toBe("jti-1000"); // rotated

    const self = await post(`/api/admins/${ADMIN_TG}/logout`, seed.cookie, { csrf_token: seed.csrf });
    expect(self.statusCode).toBe(403);
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
    const res = await post("/api/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    expect(res.statusCode).toBe(201);
    // Live runtime updated without restart.
    expect(isAdmin(NEW_ADMIN_TG)).toBe(true);
    // API lists the new id.
    const page = await get("/api/admins", seed.cookie);
    expect(page.statusCode).toBe(200);
    const data = JSON.parse(page.body) as { admins: Array<{ telegramId: number }> };
    expect(data.admins.some((a) => a.telegramId === NEW_ADMIN_TG)).toBe(true);
  });

  it("add: rejects a non-integer telegram_id", async () => {
    const res = await post("/api/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: "notanumber" });
    expect(res.statusCode).toBe(400);
    expect(isAdmin(NaN)).toBe(false);
  });

  it("add: requires auth (anon → 303 /login)", async () => {
    const res = await post("/api/admins/add", null, { csrf_token: "x", telegram_id: String(NEW_ADMIN_TG) });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(isAdmin(NEW_ADMIN_TG)).toBe(false);
  });

  it("add: rejects bad CSRF (403)", async () => {
    const res = await post("/api/admins/add", seed.cookie, { csrf_token: "wrong", telegram_id: String(NEW_ADMIN_TG) });
    expect(res.statusCode).toBe(403);
    expect(isAdmin(NEW_ADMIN_TG)).toBe(false);
  });

  it("remove: removes a DB admin from runtime and DB", async () => {
    // First add it.
    await post("/api/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    expect(isAdmin(NEW_ADMIN_TG)).toBe(true);

    const res = await post("/api/admins/remove", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    expect(res.statusCode).toBe(200);
    expect(isAdmin(NEW_ADMIN_TG)).toBe(false);
  });

  it("remove: cannot remove an env-based admin", async () => {
    const envAdmin = config.ADMIN_IDS[0]!;
    const res = await post("/api/admins/remove", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(envAdmin) });
    expect(res.statusCode).toBe(403);
    expect(isAdmin(envAdmin)).toBe(true);
  });

  it("remove: cannot remove self", async () => {
    const res = await post("/api/admins/remove", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(ADMIN_TG) });
    expect(res.statusCode).toBe(403);
  });

  it("add: defaults a new DB admin to readonly, NOT super (no privilege escalation by default)", async () => {
    await post("/api/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    expect(await getSetting(prisma, webRoleKey(NEW_ADMIN_TG))).toBe("readonly");
  });

  it("a DB-added admin's role CAN be set/demoted/promoted via /api/admins/:tgId/role", async () => {
    await post("/api/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    const res = await post(`/api/admins/${NEW_ADMIN_TG}/role`, seed.cookie, { csrf_token: seed.csrf, role: "support" });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, webRoleKey(NEW_ADMIN_TG))).toBe("support");
  });

  it("a DB-added admin CAN be force-logged-out via /api/admins/:tgId/logout", async () => {
    await post("/api/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    await setSetting(prisma, sessionJtiKey(NEW_ADMIN_TG), "jti-db-admin");
    const res = await post(`/api/admins/${NEW_ADMIN_TG}/logout`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
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
    const res = await post("/api/broadcast", seed.cookie, { csrf_token: seed.csrf, message: "New stock!", segment: "ALL" });
    expect(res.statusCode).toBe(201);
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
    expect((await post("/api/broadcast", seed.cookie, { csrf_token: seed.csrf, message: "   ", segment: "ALL" })).statusCode).toBe(400);
    expect((await post("/api/broadcast", seed.cookie, { csrf_token: seed.csrf, message: "hi", segment: "NOPE" })).statusCode).toBe(400);
    expect(await prisma.broadcast.count()).toBe(0);
  });

  it("cancels a PENDING broadcast but not one already sent", async () => {
    await post("/api/broadcast", seed.cookie, { csrf_token: seed.csrf, message: "x", segment: "RESELLERS" });
    const bc = (await prisma.broadcast.findFirst())!;
    const ok = await post(`/api/broadcast/${bc.id}/cancel`, seed.cookie, { csrf_token: seed.csrf });
    expect(ok.statusCode).toBe(200);
    expect((await prisma.broadcast.findUnique({ where: { id: bc.id } }))!.status).toBe("CANCELLED");
    expect((await post(`/api/broadcast/${bc.id}/cancel`, seed.cookie, { csrf_token: seed.csrf })).statusCode).toBe(409);
  });

  it("requires auth and rejects bad CSRF", async () => {
    const anon = await post("/api/broadcast", null, { csrf_token: "x", message: "hi", segment: "ALL" });
    expect(anon.statusCode).toBe(303);
    expect(anon.headers.location).toBe("/login");
    const bad = await post("/api/broadcast", seed.cookie, { csrf_token: "bad", message: "hi", segment: "ALL" });
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
