import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { localize } from "@app/core/datetime";
import { ProductType, UserRole, DeliveryType, OrderStatus, PaymentMethod, NotificationEvent, StockActorType, StockEventType } from "@app/core/enums";
import {
  prisma,
  countUnderpaid,
  initDb,
  upsertUser,
  createCategory,
  createCatalogProduct,
  getCatalogProduct,
  updateCatalogProduct,
  getCatalogProductWithDenominations,
  getDenomination,
  createDenomination,
  updateDenomination,
  bulkAddStock,
  SEARCH_RESULT_CAP,
  getUser,
  getUserByTelegramId,
  getOrder,
  cancelOrder,
  createOrderDirect,
  createInternalOrder,
  finalizeOrderPayment,
  createWebUser,
  attachPaymentProof,
  settlePaidOrder,
  createTicket,
  assignTicket,
  listTicketMessages,
  setSetting,
  MIN_ORDER_AMOUNT_IDR_KEY,
  getSetting,
  getDecryptedSetting,
  deleteSetting,
  getVoucherByCode,
  countAvailableStock,
  markUnderpaid,
  recordUnmatchedTx,
  listAuditLogs,
  USD_IDR_RATE_UPDATED_AT_KEY,
  setUserRole,
  setUserBanned,
  setUserPreferredCurrency,
  BINANCE_UID_KEY,
  BINANCE_API_KEY_KEY,
  BINANCE_API_SECRET_KEY,
  BINANCE_POLL_HEALTH_KEY,
  BYBIT_UID_KEY,
  BYBIT_API_KEY_KEY,
  BYBIT_API_SECRET_KEY,
  __clearSettingsCacheForTests,
} from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import { UPLOADS_DIR } from "../src/paths";
import { setTokenValidator, setChannelValidator } from "../src/lib/telegramCheck";
import { setTokenValidator as setSetupTokenValidator } from "../src/routes/setup";
import { Decimal } from "@app/core/money";
import { formatIdr, formatUsdt, usdtFromIdr } from "@app/core/formatters";
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
  paymentsMutationRateLimited,
  resetPaymentsMutationRateLimit,
  PAYMENTS_MUTATION_RATE_LIMIT_MAX,
} from "../src/auth";
import { registerOutboxNudge } from "@app/core/nudge";
import { decryptCredentials, encryptDeliveredContent, isEncryptedCredentialEnvelope } from "@app/core/credentialCrypto";
import { canMutate } from "../src/plugins/auth";
import { SETUP_INCOMPLETE_MESSAGE } from "../src/plugins/setupGate";
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
  resetPaymentsMutationRateLimit(admin.id);
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
  // This seed's SKU costs Rp5.00, two orders of magnitude under
  // `min_order_amount_idr`'s real default of Rp1.000 (packages/db/src/crud/
  // orderMinimums.ts, M11), so leaving that default in force would make every
  // order built here unfinalizable on every gateway — for a reason none of
  // these tests are about. Written as an explicit "0" rather than left unset,
  // because unset is what SELECTS the default: this seed declares a shop with
  // no minimum, it does not bypass one. Same choice as the shared fixture in
  // tests/helpers/sampleData.ts; the guard has its own coverage in
  // packages/db/src/crud/orderMinimums.test.ts.
  await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
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

/** True if `key` appears anywhere in `value` (object or array), at any
 * depth — the H-4 regression tests below use this to prove a JSON response
 * never carries a raw User row's `passwordHash`/`email`, however deeply
 * nested (e.g. under `orders[].user`, not just top-level `user`). */
function containsKeyDeep(value: unknown, key: string): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => containsKeyDeep(v, key));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === key) return true;
    if (containsKeyDeep(v, key)) return true;
  }
  return false;
}

async function makePendingOrder(): Promise<number> {
  const user = (await getUser(prisma, seed.customerId))!;
  const order = (await createOrderDirect(prisma, { channel: "web", user, productId: seed.productId, quantity: 1 }))!;
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
  const order = (await createOrderDirect(prisma, { channel: "web", user, productId: manualDenom.id, quantity: 1 }))!;
  await attachPaymentProof(prisma, order.id, { fileId: "proof123", txid: "TX1234567890" });
  await settlePaidOrder(prisma, order.id, { adminId: seed.adminId });
  return order.id;
}

/** A DELIVERED WALLET_TOPUP order (Task 4) — zero OrderItem rows by design
 * (it credits the buyer's wallet balance rather than delivering a SKU).
 * Created directly via prisma.order.create, same as orders.test.ts's own
 * makeOrder helper, since there's no createOrderDirect-style constructor for
 * this kind yet (Tasks 1-3 build settlement via the payment-gateway webhook
 * path, not an admin-facing order-builder). Owned by seed.customerId, who
 * has a Telegram id — the exact shape that would otherwise pass the
 * Resend/bulk-resend Telegram-buyer eligibility check. */
async function makeDeliveredWalletTopupOrder(): Promise<number> {
  const order = await prisma.order.create({
    data: {
      orderCode: `TOPUP-${Math.random()}`,
      userId: seed.customerId,
      subtotalAmount: "50000",
      totalAmount: "50000",
      status: "DELIVERED",
      kind: "WALLET_TOPUP",
    },
  });
  return order.id;
}

// ---- auth (acceptance #4) -------------------------------------------------

describe("auth", () => {
  it("anon is redirected to /login", async () => {
    const res = await get("/", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  // fetch() follows a 303 automatically and lands on the 200 OK HTML /login
  // page, so an /api/* JSON caller would see res.ok === true and crash on
  // res.json() with a raw SyntaxError (the exact bug this task fixes) —
  // /api/* must get a JSON 401 instead of a redirect, while a real page
  // navigation (like GET / above) still gets the 303.
  it("anon /api/* call gets a JSON 401, not a redirect", async () => {
    const res = await get("/api/dashboard/kpis", null);
    expect(res.statusCode).toBe(401);
    expect(res.headers.location).toBeUndefined();
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  // The export/download links on ReportsPage/SupportPage/UsersPage/StockPage/
  // StockProductPage are real `<a href="/api/...">` navigations, not fetch()
  // calls — a browser tab has no way to recover from a raw JSON error body,
  // so those still need the 303 like any other page load. `Sec-Fetch-Mode:
  // navigate` is how real browsers tag this kind of request.
  it("anon /api/* real browser navigation (Sec-Fetch-Mode: navigate) still gets the 303, not JSON", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stock/export",
      headers: { "sec-fetch-mode": "navigate" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  // Older browsers that omit Sec-Fetch-Mode entirely still send an
  // HTML-accepting Accept header on a real navigation — the fallback signal.
  it("anon /api/* navigation-like Accept header (no Sec-Fetch-Mode) also gets the 303", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stock/export",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  // A fetch()/XHR call is never tagged Sec-Fetch-Mode: navigate, even if it
  // happens to hit the same /api/* export path some other way — it must keep
  // getting the JSON 401, not a redirect fetch() would silently follow.
  it("anon /api/* call with Sec-Fetch-Mode: cors (a fetch, not a navigation) still gets JSON 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stock/export",
      headers: { "sec-fetch-mode": "cors" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("serves the dashboard SPA shell with the real CSRF token baked in, not the build-time placeholder", async () => {
    const res = await get("/", seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain(`name="csrf-token" content="${seed.csrf}"`);
    expect(res.body).not.toContain("__CSRF_TOKEN__");
  });

  it("SPA shell sends Cache-Control: no-store so a reverse proxy never caches a session's CSRF token (M-20)", async () => {
    const res = await get("/", seed.cookie);
    expect(res.headers["cache-control"]).toBe("no-store");
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

describe("payments mutation rate limit", () => {
  it("allows up to the cap for one admin, trips on the next call, leaves other admins unaffected, and clears on reset", () => {
    const adminId = 8888881; // dedicated id, untouched elsewhere
    const otherAdminId = 8888882;
    resetPaymentsMutationRateLimit(adminId);
    resetPaymentsMutationRateLimit(otherAdminId);
    for (let i = 0; i < PAYMENTS_MUTATION_RATE_LIMIT_MAX; i++) {
      expect(paymentsMutationRateLimited(adminId)).toBe(false);
    }
    expect(paymentsMutationRateLimited(adminId)).toBe(true);
    // A different admin id shares no budget with the one above.
    expect(paymentsMutationRateLimited(otherAdminId)).toBe(false);
    resetPaymentsMutationRateLimit(adminId);
    expect(paymentsMutationRateLimited(adminId)).toBe(false);
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
    const order = (await createOrderDirect(prisma, { channel: "web", user, productId: seed.productId, quantity: 2 }))!;
    await attachPaymentProof(prisma, order.id, { fileId: "proof123", txid: "TX1234567890" });
    const orderId = order.id;

    const items = await prisma.orderItem.findMany({ where: { orderId }, orderBy: { id: "asc" } });
    expect(items.length).toBe(2);
    const [item1, item2] = items;

    // Item #2's reserved row vanishes (onDelete: SetNull clears stockItemId).
    await prisma.stockItemEvent.deleteMany({ where: { stockItemId: item2!.stockItemId! } });
    await prisma.stockItem.delete({ where: { id: item2!.stockItemId! } });
    // Drain the rest of the AVAILABLE pool so item #2's replacement allocation
    // attempt has nothing to grab.
    await prisma.stockItemEvent.deleteMany({
      where: { stockItem: { productId: seed.productId, status: "AVAILABLE" } },
    });
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
    // Simulates a pre-existing web buyer registered before fullName became a
    // required registration field (Customers module upgrade Task 7) — such
    // accounts are intentionally left with a null fullName, never backfilled.
    // The API must expose loginUsername so the client can show it instead.
    const web = await createWebUser(prisma, {
      loginUsername: "weshopper",
      email: "we@shop.test",
      passwordHash: "x",
      fullName: "placeholder",
    });
    await prisma.user.update({ where: { id: web.id }, data: { fullName: null } });
    await createOrderDirect(prisma, { channel: "web", user: web, productId: seed.productId, quantity: 1 });

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
        await createOrderDirect(prisma, { channel: "web", user, productId: seed.productId, quantity: 1 });
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
      await createOrderDirect(prisma, { channel: "web", user: commaUser, productId: seed.productId, quantity: 1 });

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
  //
  // H-2 (backend audit, 2026-07-31): that "legal" reject turned out to strand
  // the buyer's already-paid money — a PROCESSING order is always paid
  // (settlePaidOrder stamps paidAt on the same transition), and REJECTED is
  // terminal, so creditOrderToBalance could never touch it again afterward.
  // rejectOrder now refuses a paid order outright; credit-balance (now
  // canCredit-eligible for PROCESSING too) is the way to actually recover it.
  it("reject refuses a paid PROCESSING order — credit-balance is the recovery path instead (H-2)", async () => {
    const orderId = await makeProcessingOrder();
    const res = await post(`/api/orders/${orderId}/reject`, seed.cookie, {
      csrf_token: seed.csrf,
      reason: "out of stock, can't source",
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("error.order_paid_needs_credit");
    expect((await getOrder(prisma, orderId))!.status).toBe("PROCESSING");
    const audit = await prisma.auditLog.findMany({ where: { action: "reject_order", targetId: orderId } });
    expect(audit.length).toBe(0);

    const creditRes = await post(`/api/orders/${orderId}/credit-balance`, seed.cookie, { csrf_token: seed.csrf });
    expect(creditRes.statusCode).toBe(200);
    expect((await getOrder(prisma, orderId))!.status).toBe("CANCELLED");
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
    // H-2 (backend audit, 2026-07-31): canCredit now covers PROCESSING too —
    // reject alone can no longer recover a paid PROCESSING order's money.
    expect(processingRes.json().canCredit).toBe(true);
  });

  // Regression guard for the Critical finding: an order cancelled without ever
  // being paid has nothing to hand back, so neither the flag nor the route may
  // credit it (that would mint wallet balance out of nothing).
  it("GET order detail: a CANCELLED order that was never paid is not canCreditCancelled, and the credit is refused", async () => {
    const orderId = await makePendingOrder();
    await cancelOrder(prisma, orderId, "expired", { type: StockActorType.SYSTEM });
    const res = await app.inject({ method: "GET", url: `/api/orders/${orderId}`, cookies: { [COOKIE]: seed.cookie } });
    expect(res.json().canCreditCancelled).toBe(false);

    const creditRes = await post(`/api/orders/${orderId}/credit-balance`, seed.cookie, { csrf_token: seed.csrf });
    expect(creditRes.statusCode).toBe(422);
    expect(JSON.parse(creditRes.body).error).toBe("error.order_never_paid");
    expect(await prisma.walletTransaction.count({ where: { orderId, reason: "unfulfilled_credit" } })).toBe(0);
  });

  it("GET order detail: a paid CANCELLED order is canCreditCancelled until its payment is credited, then not", async () => {
    const orderId = await makePendingOrder();
    // A gateway payment claimed for this order whose delivery then threw: the
    // ledger row keeps its orderId (flagged delivery_failed) and the order is
    // later cancelled by the expiry sweep.
    await prisma.processedTokopayTx.create({
      data: { trxId: `TP-WEB-${orderId}`, orderId, amount: "5", outcome: "delivery_failed" },
    });
    await cancelOrder(prisma, orderId, "expired", { type: StockActorType.SYSTEM });
    const detail = () => app.inject({ method: "GET", url: `/api/orders/${orderId}`, cookies: { [COOKIE]: seed.cookie } });

    const before = (await detail()).json();
    expect(before.canCreditCancelled).toBe(true);
    expect(before.canCredit).toBe(false);

    const creditRes = await post(`/api/orders/${orderId}/credit-balance`, seed.cookie, { csrf_token: seed.csrf });
    expect(creditRes.statusCode).toBe(200);
    expect((await getOrder(prisma, orderId))!.status).toBe("CANCELLED");
    // The audit sentence names the cancelled-order recovery path.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "order_credit_balance", targetId: orderId } });
    expect(audit.details).toContain("already-cancelled order");
    expect(audit.details).not.toContain("gateway payment records");

    expect((await detail()).json().canCreditCancelled).toBe(false);
    // A second tap is refused with the key the admin client maps to a sentence.
    const again = await post(`/api/orders/${orderId}/credit-balance`, seed.cookie, { csrf_token: seed.csrf });
    expect(again.statusCode).toBe(422);
    expect(JSON.parse(again.body).error).toBe("error.already_credited");
  });

  it("approve requires auth (anon → 401)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/approve`, null, { csrf_token: "anything" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("approve rejects bad CSRF (403)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/approve`, seed.cookie, { csrf_token: "wrong-token" });
    expect(res.statusCode).toBe(403);
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  // Task 12: Origin/Referer defense-in-depth, additive alongside the token
  // check above — same 403 "CSRF check failed" response either way, so an
  // attacker can't distinguish "bad token" from "bad origin".
  it("approve rejects a valid CSRF token when Origin is present but mismatched (403)", async () => {
    const orderId = await makePendingOrder();
    const res = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/approve`,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      cookies: { [COOKIE]: seed.cookie },
      payload: form({ csrf_token: seed.csrf }),
    });
    expect(res.statusCode).toBe(403);
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("approve accepts a valid CSRF token with no Origin/Referer header at all (most legitimate requests omit both)", async () => {
    const orderId = await makePendingOrder();
    setBotIdentity({ publicChannelId: -100123456789 });
    const res = await post(`/api/orders/${orderId}/approve`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
  });

  it("approve accepts a valid CSRF token with an Origin header matching this request's own host", async () => {
    const orderId = await makePendingOrder();
    setBotIdentity({ publicChannelId: -100123456789 });
    const res = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/approve`,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      cookies: { [COOKIE]: seed.cookie },
      payload: form({ csrf_token: seed.csrf }),
    });
    expect(res.statusCode).toBe(200);
  });

  // Whole-branch review finding I-3: when ADMIN_PUBLIC_URL IS configured,
  // the Origin check must prefer it over req.hostname — this is the
  // deploy-time availability gap the fix closes: a reverse proxy that
  // mangles the Host header must not 403 every mutation as long as the
  // admin's browser really is on the configured public origin. setup-env.ts
  // leaves ADMIN_PUBLIC_URL unset by default, so it's set here just for this
  // one case and restored afterwards.
  it("approve accepts a valid CSRF token with an Origin header matching the configured ADMIN_PUBLIC_URL, even though it does not match req.hostname", async () => {
    const original = config.ADMIN_PUBLIC_URL;
    config.ADMIN_PUBLIC_URL = "https://admin.test.invalid";
    try {
      const orderId = await makePendingOrder();
      setBotIdentity({ publicChannelId: -100123456789 });
      const res = await app.inject({
        method: "POST",
        url: `/api/orders/${orderId}/approve`,
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://admin.test.invalid" },
        cookies: { [COOKIE]: seed.cookie },
        payload: form({ csrf_token: seed.csrf }),
      });
      expect(res.statusCode).toBe(200);
    } finally {
      config.ADMIN_PUBLIC_URL = original;
    }
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
    expect(audit[0]!.details).toBe(
      `Credited order ${orderId}'s paid amount (${new Decimal(order.totalAmount).toString()} IDR) to the buyer's balance.`,
    );
  });

  it("credit-balance on a cancelled order with two linked gateway records says both were closed out", async () => {
    const orderId = await makePendingOrder();
    await prisma.processedTokopayTx.create({
      data: { trxId: `TP-WEB2-${orderId}`, orderId, amount: "5", outcome: "delivery_failed" },
    });
    await prisma.processedBybitTx.create({
      data: { bybitTxId: `BY-WEB2-${orderId}`, orderId, amount: "5", outcome: "unmatched" },
    });
    await cancelOrder(prisma, orderId, "expired", { type: StockActorType.SYSTEM });

    const res = await post(`/api/orders/${orderId}/credit-balance`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "order_credit_balance", targetId: orderId } });
    expect(audit.details).toContain("already-cancelled order");
    expect(audit.details).toContain("2 gateway payment records linked to this order were closed out by this credit.");
  });

  it("credit-balance requires auth (anon → 401)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/credit-balance`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });

  it("credit-balance rejects bad CSRF (403)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/credit-balance`, seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
    expect((await getOrder(prisma, orderId))!.status).toBe("PENDING_VERIFICATION");
  });
});

// ---- delivered secrets never ride along in list/summary responses (Fase 6c follow-up) ----

describe("order lists never carry deliveredContent", () => {
  const SECRET = "user:list-leak pass:Hunter-LIST-9";

  async function seedDeliveredOrder(status: string = "DELIVERED"): Promise<number> {
    const orderId = await makeProcessingOrder();
    await prisma.order.update({
      where: { id: orderId },
      data: { status, deliveredContent: encryptDeliveredContent(SECRET, orderId) },
    });
    return orderId;
  }

  function assertNoDeliveredContent(body: string) {
    expect(body).not.toContain("Hunter-LIST-9");
    expect(body).not.toContain("deliveredContent");
  }

  it("GET /api/orders", async () => {
    await seedDeliveredOrder();
    const res = await get("/api/orders", seed.cookie);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { orders: unknown[] }).orders.length).toBeGreaterThan(0);
    assertNoDeliveredContent(res.body);
  });

  it("GET /api/payments (underpaid list)", async () => {
    await seedDeliveredOrder("UNDERPAID");
    const res = await get("/api/payments", seed.cookie);
    expect(res.statusCode).toBe(200);
    assertNoDeliveredContent(res.body);
  });

  it("GET /api/users/:userId (the user's orders)", async () => {
    await seedDeliveredOrder();
    const res = await get(`/api/users/${seed.customerId}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { orders: unknown[] }).orders.length).toBeGreaterThan(0);
    assertNoDeliveredContent(res.body);
  });

  it("GET /api/support/:ticketId (linked order and the buyer's recent orders)", async () => {
    const orderId = await seedDeliveredOrder();
    const ticket = await createTicket(prisma, seed.customerId, "about my order", null, null, orderId);
    const res = await get(`/api/support/${ticket.id}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = res.json() as { ticket: { order: unknown }; customer: { recentOrders: unknown[] } };
    expect(data.ticket.order).not.toBeNull();
    expect(data.customer.recentOrders.length).toBeGreaterThan(0);
    assertNoDeliveredContent(res.body);
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

  it("fulfill requires auth (anon → 401)", async () => {
    const orderId = await makeProcessingOrder();
    const res = await post(`/api/orders/${orderId}/fulfill`, null, { csrf_token: "anything", content: "x" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
    // Simulates a pre-existing web buyer registered before fullName became a
    // required field (Customers module upgrade Task 7) — left null, never backfilled.
    const web = await createWebUser(prisma, {
      loginUsername,
      email: `${loginUsername}@shop.test`,
      passwordHash: "x",
      fullName: "placeholder",
    });
    await prisma.user.update({ where: { id: web.id }, data: { fullName: null } });
    const order = (await createOrderDirect(prisma, { channel: "web", user: web, productId: seed.productId, quantity: 1 }))!;
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

  // Task 4: a WALLET_TOPUP order has zero OrderItem rows, so without a
  // kind-aware guard the resend route's manual-vs-auto branch would
  // misclassify it as AUTO and enqueue a bogus, credential-less
  // ORDER_DELIVERED_DM. It has a Telegram buyer and is DELIVERED, so it
  // would otherwise pass every other resend precondition.
  it("resend rejects a WALLET_TOPUP order (422) and enqueues no DM", async () => {
    const orderId = await makeDeliveredWalletTopupOrder();
    const res = await postJson(`/api/orders/${orderId}/resend`, seed.cookie, seed.csrf);
    expect(res.statusCode).toBe(422);
    expect(
      await prisma.notificationOutbox.count({ where: { orderId } }),
    ).toBe(0);
  });

  it("resend requires auth (anon → 401)", async () => {
    const orderId = await makePendingOrder();
    await postJson(`/api/orders/${orderId}/approve`, seed.cookie, seed.csrf);
    const res = await postJson(`/api/orders/${orderId}/resend`, null, "anything");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

// ---- orders API: masked credentials on detail + audited reveal ------------

describe("orders API — credential masking and audited reveal", () => {
  const MASK = "••••••••";

  async function makeAutoDeliveredOrder(): Promise<{ orderId: number; orderCode: string; secret: string }> {
    const orderId = await makePendingOrder();
    return approveAndReadSecret(orderId);
  }

  async function approveAndReadSecret(orderId: number): Promise<{ orderId: number; orderCode: string; secret: string }> {
    const approve = await post(`/api/orders/${orderId}/approve`, seed.cookie, { csrf_token: seed.csrf });
    expect(approve.statusCode).toBe(200);
    const order = (await getOrder(prisma, orderId))!;
    const secret = order.items[0]!.stockItem!.credentials; // getOrder decrypts
    expect(secret).toBeTruthy();
    return { orderId, orderCode: order.orderCode, secret };
  }

  async function makeManualDeliveredOrder(content: string): Promise<{ orderId: number; orderCode: string }> {
    const orderId = await makeProcessingOrder();
    const fulfil = await post(`/api/orders/${orderId}/fulfill`, seed.cookie, { csrf_token: seed.csrf, content });
    expect(fulfil.statusCode).toBe(200);
    return { orderId, orderCode: (await getOrder(prisma, orderId))!.orderCode };
  }

  it("GET detail masks an auto order's stock credentials and never carries the plaintext", async () => {
    const { orderId, secret } = await makeAutoDeliveredOrder();
    const res = await get(`/api/orders/${orderId}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(secret);
    const data = res.json() as {
      order: { items: { stockItem: { credentials: string } | null }[]; deliveredContent: string | null };
      hasDeliveredContent: boolean;
    };
    expect(data.order.items[0]!.stockItem!.credentials).toBe(MASK);
    expect(data.order.deliveredContent).toBeNull();
    expect(data.hasDeliveredContent).toBe(false);
  });

  it("GET detail masks a manual order's deliveredContent and flags that it exists", async () => {
    const { orderId } = await makeManualDeliveredOrder("user:x pass:secret-y");
    const res = await get(`/api/orders/${orderId}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("secret-y");
    const data = res.json() as { order: { deliveredContent: string | null }; hasDeliveredContent: boolean };
    expect(data.order.deliveredContent).toBe(MASK);
    expect(data.hasDeliveredContent).toBe(true);
  });

  it("GET detail does not write an audit row (only the reveal route does)", async () => {
    const { orderId } = await makeAutoDeliveredOrder();
    await get(`/api/orders/${orderId}`, seed.cookie);
    expect(await prisma.auditLog.count({ where: { action: "order_credentials_revealed" } })).toBe(0);
  });

  it("POST reveal returns an auto order's plaintext credentials per item and audits exactly once without the secret", async () => {
    const { orderId, orderCode, secret } = await makeAutoDeliveredOrder();
    const itemId = (await getOrder(prisma, orderId))!.items[0]!.id;

    const res = await post(`/api/orders/${orderId}/reveal`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ credentials: [{ id: itemId, text: secret }], deliveredContent: null });

    const audit = await prisma.auditLog.findMany({ where: { action: "order_credentials_revealed" } });
    expect(audit.length).toBe(1);
    expect(audit[0]!.adminId).toBe(seed.adminId);
    expect(audit[0]!.targetType).toBe("order");
    expect(audit[0]!.targetId).toBe(orderId);
    expect(audit[0]!.details).toBe(`Revealed the delivered credentials for order ${orderCode}.`);
    expect(audit[0]!.details).not.toContain(secret);
  });

  it("POST reveal returns a manual order's deliveredContent and audits without the content", async () => {
    const { orderId } = await makeManualDeliveredOrder("user:x pass:secret-y");
    const res = await post(`/api/orders/${orderId}/reveal`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ credentials: [], deliveredContent: "user:x pass:secret-y" });

    const audit = await prisma.auditLog.findMany({ where: { action: "order_credentials_revealed", targetId: orderId } });
    expect(audit.length).toBe(1);
    expect(audit[0]!.details).not.toContain("secret-y");
  });

  // Only a DELIVERED order has actually handed its credentials over — a
  // pending/cancelled order can still carry a reserved (or stale) stock pointer.
  it("POST reveal refuses a not-yet-delivered order (422), reveals nothing and writes no audit row", async () => {
    const orderId = await makePendingOrder(); // PENDING_VERIFICATION with reserved stock
    const secret = (await getOrder(prisma, orderId))!.items[0]!.stockItem!.credentials;
    const res = await post(`/api/orders/${orderId}/reveal`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/delivered/i);
    expect(res.body).not.toContain(secret);
    expect(await prisma.auditLog.count({ where: { action: "order_credentials_revealed" } })).toBe(0);
  });

  it("POST reveal refuses a CANCELLED order even when its item still points at a stock row", async () => {
    const orderId = await makePendingOrder();
    const secret = (await getOrder(prisma, orderId))!.items[0]!.stockItem!.credentials;
    await prisma.order.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
    const res = await post(`/api/orders/${orderId}/reveal`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(secret);
    expect(await prisma.auditLog.count({ where: { action: "order_credentials_revealed" } })).toBe(0);
  });

  it("POST reveal omits an item whose stock row now belongs to another order, but reveals the rest", async () => {
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { channel: "web", user, productId: seed.productId, quantity: 2 }))!;
    await attachPaymentProof(prisma, order.id, { fileId: "proof123", txid: "TX1234567890" });
    const { secret: firstSecret } = await approveAndReadSecret(order.id);
    const items = (await getOrder(prisma, order.id))!.items;
    expect(items.length).toBe(2);
    const [keep, stale] = items;
    const otherOrderId = await makePendingOrder();
    // The stale item's stock row was released and re-sold to another buyer.
    await prisma.stockItem.update({ where: { id: stale!.stockItem!.id }, data: { orderId: otherOrderId } });

    const res = await post(`/api/orders/${order.id}/reveal`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { credentials: { id: number; text: string }[] };
    expect(body.credentials).toEqual([{ id: keep!.id, text: keep!.stockItem!.credentials }]);
    expect(res.body).not.toContain(stale!.stockItem!.credentials);
    expect(firstSecret).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { action: "order_credentials_revealed", targetId: order.id } })).toBe(1);
  });

  it("POST reveal writes no audit row when nothing is left to reveal", async () => {
    const { orderId } = await makeAutoDeliveredOrder();
    const item = (await getOrder(prisma, orderId))!.items[0]!;
    await prisma.stockItem.update({ where: { id: item.stockItem!.id }, data: { orderId: null } });
    const res = await post(`/api/orders/${orderId}/reveal`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ credentials: [], deliveredContent: null });
    expect(await prisma.auditLog.count({ where: { action: "order_credentials_revealed" } })).toBe(0);
  });

  it("POST reveal audits every call, including repeat reveals of the same order", async () => {
    const { orderId } = await makeAutoDeliveredOrder();
    await post(`/api/orders/${orderId}/reveal`, seed.cookie, { csrf_token: seed.csrf });
    await post(`/api/orders/${orderId}/reveal`, seed.cookie, { csrf_token: seed.csrf });
    expect(await prisma.auditLog.count({ where: { action: "order_credentials_revealed", targetId: orderId } })).toBe(2);
  });

  it("POST reveal returns 404 for an unknown order and writes no audit row", async () => {
    const res = await post(`/api/orders/999999/reveal`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: "order_credentials_revealed" } })).toBe(0);
  });

  it("POST reveal surfaces a malformed CREDENTIAL_ENCRYPTION_KEY as a JSON 500 and writes no audit row", async () => {
    const { orderId } = await makeAutoDeliveredOrder();
    const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = "tooshort";
    try {
      const res = await post(`/api/orders/${orderId}/reveal`, seed.cookie, { csrf_token: seed.csrf });
      expect(res.statusCode).toBe(500);
      expect(res.headers["content-type"]).toContain("application/json");
      expect((res.json() as { error: string }).error).toMatch(/CREDENTIAL_ENCRYPTION_KEY/);
    } finally {
      if (originalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
    }
    expect(await prisma.auditLog.count({ where: { action: "order_credentials_revealed" } })).toBe(0);
  });

  it("POST reveal rejects bad CSRF (403) and writes no audit row", async () => {
    const { orderId } = await makeAutoDeliveredOrder();
    const res = await post(`/api/orders/${orderId}/reveal`, seed.cookie, { csrf_token: "wrong-token" });
    expect(res.statusCode).toBe(403);
    expect(await prisma.auditLog.count({ where: { action: "order_credentials_revealed" } })).toBe(0);
  });

  it("POST reveal requires auth (anon → 401)", async () => {
    const { orderId } = await makeAutoDeliveredOrder();
    const res = await post(`/api/orders/${orderId}/reveal`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(401);
  });

  it("POST reveal refuses a read-only admin (403) and writes no audit row", async () => {
    const { orderId } = await makeAutoDeliveredOrder();
    await setSetting(prisma, webRoleKey(ADMIN_TG), "readonly");
    try {
      const res = await post(`/api/orders/${orderId}/reveal`, seed.cookie, { csrf_token: seed.csrf });
      expect(res.statusCode).toBe(403);
      expect(await prisma.auditLog.count({ where: { action: "order_credentials_revealed" } })).toBe(0);
    } finally {
      await setSetting(prisma, webRoleKey(ADMIN_TG), "support");
    }
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

  // Task 4: the admin order list/detail routes legitimately need to show
  // WALLET_TOPUP orders (zero OrderItem rows) for support purposes — they
  // must render without crashing rather than excluding them, unlike the
  // buyer-facing listUserOrders/countUserOrders.
  it("a WALLET_TOPUP order renders in the list with kind + zero items, no crash", async () => {
    const topupId = await makeDeliveredWalletTopupOrder();
    const res = await get("/api/orders", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { orders: Array<{ id: number; kind: string; items: unknown[] }> };
    const row = data.orders.find((o) => o.id === topupId);
    expect(row).toBeDefined();
    expect(row!.kind).toBe("WALLET_TOPUP");
    expect(row!.items).toEqual([]);
  });

  it("GET /api/orders/:orderId renders a WALLET_TOPUP order's kind and empty items, no crash", async () => {
    const topupId = await makeDeliveredWalletTopupOrder();
    const res = await get(`/api/orders/${topupId}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { order: { kind: string; items: unknown[] }; customerDataFields: unknown[] };
    expect(data.order.kind).toBe("WALLET_TOPUP");
    expect(data.order.items).toEqual([]);
    expect(data.customerDataFields).toEqual([]);
  });
});

describe("CSV export — q multi-field search + ids filter", () => {
  it("q now matches customer identity fields too, not just orderCode", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 314159, username: "csvsearchuser", fullName: "CSV Search" });
    await createOrderDirect(prisma, { channel: "web", user: buyer, productId: seed.productId, quantity: 1 });
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
    // assert the two real keys are present, not truthy, and that no fabricated
    // USD duplicate of the USDT figure is shipped.
    expect(Object.keys(body.revenueToday).sort()).toEqual(["idr", "usdt"]);
    expect(body.delivered).toBeGreaterThanOrEqual(1);
    expect(body.totalOrders).toBeGreaterThanOrEqual(2);
  });

  it("requires auth (anon → 401)", async () => {
    const res = await get("/api/orders/kpis", null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

  it("requires auth (anon → 401)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/cancel`, null, { csrf_token: "anything", reason: "x" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("rejects bad CSRF (403)", async () => {
    const orderId = await makePendingOrder();
    const res = await post(`/api/orders/${orderId}/cancel`, seed.cookie, { csrf_token: "wrong-token", reason: "x" });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/orders/bulk-action", () => {
  it("bulk cancel still cancels an order whose reserved credential can't be decrypted (final review F2)", async () => {
    const orderId = await makePendingOrder();
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId } });
    const row = await prisma.stockItem.findUniqueOrThrow({ where: { id: item.stockItemId! } });
    const tampered = { ...(JSON.parse(row.credentials) as Record<string, unknown>), authTag: Buffer.alloc(16).toString("base64") };
    await prisma.stockItem.update({ where: { id: row.id }, data: { credentials: JSON.stringify(tampered) } });
    await prisma.order.update({ where: { id: orderId }, data: { status: "PENDING_PAYMENT" } });

    const res = await postJsonOrders("/api/orders/bulk-action", seed.cookie, seed.csrf, {
      ids: [orderId],
      action: "cancel",
      reason: "unreadable stock cleanup",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ succeeded: [orderId], failed: [] });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("CANCELLED");
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("AVAILABLE");
  });

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

  // Task 4: same wallet-top-up guard as the single-order resend route — a
  // DELIVERED WALLET_TOPUP order with a Telegram buyer passes
  // eligibility.canResend (it doesn't know about kind), so the route itself
  // must reject it rather than enqueueing a bogus credentials DM.
  it("bulk resend rejects a WALLET_TOPUP order and enqueues no DM", async () => {
    const topup = await makeDeliveredWalletTopupOrder();
    const res = await postJsonOrders("/api/orders/bulk-action", seed.cookie, seed.csrf, {
      ids: [topup],
      action: "resend",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { succeeded: number[]; failed: { id: number; error: string }[] };
    expect(body.succeeded).toEqual([]);
    expect(body.failed).toEqual([{ id: topup, error: "error.not_eligible" }]);
    expect(await prisma.notificationOutbox.count({ where: { orderId: topup } })).toBe(0);
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

  it("requires auth (anon → 401)", async () => {
    const orderId = await makePendingOrder();
    const res = await postJsonOrders("/api/orders/bulk-action", null, null, {
      ids: [orderId],
      action: "cancel",
      reason: "x",
    });
    expect(res.statusCode).toBe(401);
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

  // Task 14: gameVariant/gameVariantEmoji/gameRegion — the admin-authored
  // game-navigation classification Tasks 11-13's bot navigation and
  // denomination labeling consume. Independent of every other field.
  it("persists gameVariant, gameVariantEmoji and gameRegion", async () => {
    const res = await postProductJson(seed.cookie, seed.csrf, {
      name: "Mobile Legends",
      categoryId: seed.categoryId,
      gameVariant: "Diamonds",
      gameVariantEmoji: "💎",
      gameRegion: "Global",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const product = await getCatalogProduct(prisma, body.id);
    expect(product!.gameVariant).toBe("Diamonds");
    expect(product!.gameVariantEmoji).toBe("💎");
    expect(product!.gameRegion).toBe("Global");
  });

  it("defaults gameVariant, gameVariantEmoji and gameRegion to null when omitted", async () => {
    const res = await postProductJson(seed.cookie, seed.csrf, {
      name: "Plain Product",
      categoryId: seed.categoryId,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const product = await getCatalogProduct(prisma, body.id);
    expect(product!.gameVariant).toBeNull();
    expect(product!.gameVariantEmoji).toBeNull();
    expect(product!.gameRegion).toBeNull();
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

  it("rejects missing auth (anon → 401)", async () => {
    const res = await postProductJson(null, "x", { name: "X", categoryId: seed.categoryId });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

  it("persists emoji, description and sortOrder", async () => {
    const res = await postCategoryJson(seed.cookie, seed.csrf, {
      name: "Streaming",
      emoji: "🎬",
      description: "Video streaming subscriptions",
      sortOrder: 3,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { category: { id: number } };
    const cat = await prisma.category.findUnique({ where: { id: body.category.id } });
    expect(cat!.emoji).toBe("🎬");
    expect(cat!.description).toBe("Video streaming subscriptions");
    expect(cat!.sortOrder).toBe(3);
  });

  it("defaults checkoutFlow to \"catalog\" when omitted", async () => {
    const res = await postCategoryJson(seed.cookie, seed.csrf, { name: "Streaming" });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { category: { id: number } };
    const cat = await prisma.category.findUnique({ where: { id: body.category.id } });
    expect(cat!.checkoutFlow).toBe("catalog");
  });

  it("persists checkoutFlow \"instant\" when given", async () => {
    const res = await postCategoryJson(seed.cookie, seed.csrf, { name: "Top-ups", checkoutFlow: "instant" });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { category: { id: number } };
    const cat = await prisma.category.findUnique({ where: { id: body.category.id } });
    expect(cat!.checkoutFlow).toBe("instant");
  });

  it("silently falls back to \"catalog\" for an invalid checkoutFlow instead of rejecting the request", async () => {
    const res = await postCategoryJson(seed.cookie, seed.csrf, { name: "Bogus Flow", checkoutFlow: "bogus" });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { category: { id: number } };
    const cat = await prisma.category.findUnique({ where: { id: body.category.id } });
    expect(cat!.checkoutFlow).toBe("catalog");
  });

  it("persists a valid group", async () => {
    const res = await postCategoryJson(seed.cookie, seed.csrf, { name: "Mobile Legends", group: "GAME_TOPUP" });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { category: { id: number } };
    const cat = await prisma.category.findUnique({ where: { id: body.category.id } });
    expect(cat!.group).toBe("GAME_TOPUP");
  });

  it("defaults group to null when omitted", async () => {
    const res = await postCategoryJson(seed.cookie, seed.csrf, { name: "No Group" });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { category: { id: number } };
    const cat = await prisma.category.findUnique({ where: { id: body.category.id } });
    expect(cat!.group).toBeNull();
  });

  it("rejects an invalid group with 400 and creates nothing", async () => {
    const before = await prisma.category.count();
    const res = await postCategoryJson(seed.cookie, seed.csrf, { name: "Bogus Group", group: "NOT_A_GROUP" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
    expect(await prisma.category.count()).toBe(before);
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

  it("rejects missing auth (anon → 401)", async () => {
    const res = await postCategoryJson(null, "x", { name: "Streaming" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

  it("rejects missing auth (anon → 401)", async () => {
    const res = await postDenominationJson(seed.catalogProductId, null, "x", {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

  const IGN_FIELD = { key: "ign", label: { id: "IGN", en: "IGN" }, type: "text", required: true, options: [], placeholder: "" };

  it("ignores a stray additionalFields payload when deliveryType is plain manual", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "manual",
      additionalFields: [IGN_FIELD],
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.additionalFields).toBeNull();
  });

  it("keeps explicitly configured additionalFields on an auto SKU (buyer input is no longer tied to manual_with_info)", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "auto",
      additionalFields: [IGN_FIELD],
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(JSON.parse(row!.additionalFields!).map((f: { key: string }) => f.key)).toEqual(["ign"]);
  });

  const DIGIFLAZZ_FIELDS = [
    { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
  ];

  it("creates a denomination with autoDeliverySource digiflazz and a supplierSku, persisting both fields, alongside manual_with_info", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "manual_with_info",
      additionalFields: DIGIFLAZZ_FIELDS,
      autoDeliverySource: "digiflazz",
      supplierSku: "mlbb86",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.autoDeliverySource).toBe("digiflazz");
    expect(row!.supplierSku).toBe("mlbb86");
  });

  it("rejects autoDeliverySource digiflazz with an empty supplierSku (400) and writes nothing", async () => {
    const before = await prisma.denomination.count();
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "manual_with_info",
      additionalFields: DIGIFLAZZ_FIELDS,
      autoDeliverySource: "digiflazz",
      supplierSku: "   ",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
    expect(await prisma.denomination.count()).toBe(before);
  });

  it("defaults autoDeliverySource and supplierSku to null when omitted", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.autoDeliverySource).toBeNull();
    expect(row!.supplierSku).toBeNull();
  });

  // Regression test for the review finding: autoDeliverySource/supplierSku
  // must be coupled to deliveryType === manual_with_info the same way
  // additionalFields already is above ("ignores a stray additionalFields
  // payload when deliveryType is not manual_with_info") — a denomination
  // outside Manual + Info has no buyer-submitted Game ID/Server info for a
  // supplier to fulfill against, so it can't carry a live Digiflazz link.
  it("ignores autoDeliverySource/supplierSku when deliveryType is not manual_with_info", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "auto",
      autoDeliverySource: "digiflazz",
      supplierSku: "mlbb86",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.deliveryType).toBe("auto");
    expect(row!.autoDeliverySource).toBeNull();
    expect(row!.supplierSku).toBeNull();
  });

  // Task 7: nicknameCheckGameCode is independent of autoDeliverySource — a
  // manual_with_info denomination with no Digiflazz link can still offer a
  // live nickname check, so it needs none of the digiflazz-only coupling
  // tested above.
  it("creates a denomination with nicknameCheckGameCode, with no autoDeliverySource required", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
      deliveryType: "manual_with_info",
      additionalFields: DIGIFLAZZ_FIELDS,
      nicknameCheckGameCode: "mobile-legends",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.nicknameCheckGameCode).toBe("mobile-legends");
    expect(row!.autoDeliverySource).toBeNull();
  });

  it("defaults nicknameCheckGameCode to null when omitted", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.nicknameCheckGameCode).toBeNull();
  });

  // Task 14: qtyValue/qtyUnit — the compact-button quantity ("86 Diamonds")
  // Tasks 11-13's bot labeling logic consumes. Independent of every other
  // field on the row.
  it("creates a denomination with qtyValue and qtyUnit", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "86 Diamonds",
      type: "SHARED",
      durationLabel: "One-time",
      price: "15000",
      qtyValue: 86,
      qtyUnit: "Diamonds",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.qtyValue).toBe(86);
    expect(row!.qtyUnit).toBe("Diamonds");
  });

  it("defaults qtyValue and qtyUnit to null when omitted", async () => {
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "15000",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: number };
    const row = await getDenomination(prisma, body.id);
    expect(row!.qtyValue).toBeNull();
    expect(row!.qtyUnit).toBeNull();
  });

  it("rejects a negative qtyValue with 400 and creates nothing", async () => {
    const before = await prisma.denomination.count();
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "86 Diamonds",
      type: "SHARED",
      durationLabel: "One-time",
      price: "15000",
      qtyValue: -1,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
    expect(await prisma.denomination.count()).toBe(before);
  });

  it("rejects a non-integer qtyValue with 400 and creates nothing", async () => {
    const before = await prisma.denomination.count();
    const res = await postDenominationJson(seed.catalogProductId, seed.cookie, seed.csrf, {
      name: "86 Diamonds",
      type: "SHARED",
      durationLabel: "One-time",
      price: "15000",
      qtyValue: 4.5,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
    expect(await prisma.denomination.count()).toBe(before);
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

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/active`, null, "x", { active: false });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson(`/api/catalog/denominations/${seed.productId}/active`, null, "x", { active: false });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

    it("persists checkoutFlow \"instant\"", async () => {
      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, seed.csrf, {
        checkoutFlow: "instant",
      });
      expect(res.statusCode).toBe(200);
      const cat = await prisma.category.findUnique({ where: { id: seed.categoryId } });
      expect(cat!.checkoutFlow).toBe("instant");
    });

    it("rejects an invalid checkoutFlow with 400 and writes nothing", async () => {
      const before = await prisma.category.findUnique({ where: { id: seed.categoryId } });
      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, seed.csrf, {
        checkoutFlow: "bogus",
      });
      expect(res.statusCode).toBe(400);
      const after = await prisma.category.findUnique({ where: { id: seed.categoryId } });
      expect(after!.checkoutFlow).toBe(before!.checkoutFlow);
    });

    it("persists a valid group", async () => {
      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, seed.csrf, {
        group: "PREMIUM_APPS",
      });
      expect(res.statusCode).toBe(200);
      const cat = await prisma.category.findUnique({ where: { id: seed.categoryId } });
      expect(cat!.group).toBe("PREMIUM_APPS");
    });

    it("clears the group back to null when explicitly sent null", async () => {
      await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, seed.csrf, {
        group: "GAME_TOPUP",
      });
      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, seed.csrf, {
        group: null,
      });
      expect(res.statusCode).toBe(200);
      const cat = await prisma.category.findUnique({ where: { id: seed.categoryId } });
      expect(cat!.group).toBeNull();
    });

    it("rejects an invalid group with 400 and writes nothing", async () => {
      const before = await prisma.category.findUnique({ where: { id: seed.categoryId } });
      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, seed.csrf, {
        group: "NOT_A_GROUP",
      });
      expect(res.statusCode).toBe(400);
      const after = await prisma.category.findUnique({ where: { id: seed.categoryId } });
      expect(after!.group).toBe(before!.group);
    });

    it("rejects a non-existent category id with 404", async () => {
      const res = await patchJson(`/api/catalog/categories/99999`, seed.cookie, seed.csrf, { name: "X" });
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon → 401)", async () => {
      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, null, "x", { name: "X" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, "bad-token", { name: "X" });
      expect(res.statusCode).toBe(403);
    });

    it("regression: a partial patch with only { name } leaves emoji, description and sortOrder untouched", async () => {
      const full = await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, seed.csrf, {
        name: "Base Cat",
        emoji: "🎮",
        description: "Games category",
        sortOrder: 5,
      });
      expect(full.statusCode).toBe(200);
      const beforeSlug = (await prisma.category.findUnique({ where: { id: seed.categoryId } }))!.slug;

      const res = await patchJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, seed.csrf, {
        name: "Renamed Only",
      });
      expect(res.statusCode).toBe(200);
      const cat = await prisma.category.findUnique({ where: { id: seed.categoryId } });
      expect(cat!.name).toBe("Renamed Only");
      expect(cat!.emoji).toBe("🎮");
      expect(cat!.description).toBe("Games category");
      expect(cat!.sortOrder).toBe(5);
      expect(cat!.slug).toBe(beforeSlug); // slug is frozen, never rewritten
    });
  });

  describe("DELETE /api/catalog/categories/:id", () => {
    it("happy path: deletes an empty category and audits", async () => {
      const cat = await createCategory(prisma, "Empty Cat");
      const res = await deleteJson(`/api/catalog/categories/${cat.id}`, seed.cookie, seed.csrf);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      expect(await prisma.category.findUnique({ where: { id: cat.id } })).toBeNull();
      const audit = await prisma.auditLog.findFirst({ where: { action: "category_delete", targetId: cat.id } });
      expect(audit?.details).toBe(`Deleted category "Empty Cat".`);
    });

    it("refuses with 409 and the product count while the category still has products; category survives", async () => {
      const res = await deleteJson(`/api/catalog/categories/${seed.categoryId}`, seed.cookie, seed.csrf);
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body) as { error: string; productCount: number };
      expect(body.productCount).toBe(1);
      expect(body.error).toBeTruthy();
      expect(await prisma.category.findUnique({ where: { id: seed.categoryId } })).not.toBeNull();
    });

    it("rejects a non-integer id with 400", async () => {
      const res = await deleteJson(`/api/catalog/categories/abc`, seed.cookie, seed.csrf);
      expect(res.statusCode).toBe(400);
    });

    it("rejects a non-existent category id with 404", async () => {
      const res = await deleteJson(`/api/catalog/categories/99999`, seed.cookie, seed.csrf);
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon → 401)", async () => {
      const cat = await createCategory(prisma, "Empty Cat 2");
      const res = await deleteJson(`/api/catalog/categories/${cat.id}`, null, "x");
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const cat = await createCategory(prisma, "Empty Cat 3");
      const res = await deleteJson(`/api/catalog/categories/${cat.id}`, seed.cookie, "bad-token");
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/catalog/categories/reorder", () => {
    it("happy path: changes the order returned by GET /api/catalog and audits", async () => {
      const catB = await createCategory(prisma, "Cat B");
      const catC = await createCategory(prisma, "Cat C");
      const res = await postJson(`/api/catalog/categories/reorder`, seed.cookie, seed.csrf, {
        ids: [catC.id, seed.categoryId, catB.id],
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });

      const listed = await app.inject({ method: "GET", url: "/api/catalog", cookies: { [COOKIE]: seed.cookie } });
      const { categories } = JSON.parse(listed.body) as { categories: Array<{ id: number }> };
      const orderedIds = categories.map((c) => c.id).filter((id) => [catC.id, seed.categoryId, catB.id].includes(id));
      expect(orderedIds).toEqual([catC.id, seed.categoryId, catB.id]);

      const audit = await prisma.auditLog.findFirst({ where: { action: "category_reorder" } });
      expect(audit?.details).toBe("Reordered categories.");
    });

    it("accepts a partial list without requiring every category id", async () => {
      const catB = await createCategory(prisma, "Cat B2");
      const res = await postJson(`/api/catalog/categories/reorder`, seed.cookie, seed.csrf, { ids: [catB.id] });
      expect(res.statusCode).toBe(200);
      expect((await prisma.category.findUnique({ where: { id: catB.id } }))!.sortOrder).toBe(0);
    });

    it("rejects non-array ids with 400", async () => {
      const res = await postJson(`/api/catalog/categories/reorder`, seed.cookie, seed.csrf, { ids: "nope" });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a list containing a non-integer with 400", async () => {
      const res = await postJson(`/api/catalog/categories/reorder`, seed.cookie, seed.csrf, {
        ids: [seed.categoryId, "x"],
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an unknown category id with 400", async () => {
      const res = await postJson(`/api/catalog/categories/reorder`, seed.cookie, seed.csrf, {
        ids: [seed.categoryId, 99999],
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson(`/api/catalog/categories/reorder`, null, "x", { ids: [seed.categoryId] });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/catalog/categories/reorder`, seed.cookie, "bad-token", { ids: [seed.categoryId] });
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

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson(`/api/catalog/categories/${seed.categoryId}/active`, null, "x", { active: false });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/catalog/categories/${seed.categoryId}/active`, seed.cookie, "bad-token", { active: false });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("DELETE /api/catalog/products/:id", () => {
    it("happy path: deletes an empty product and audits", async () => {
      // StockItem.productId holds a DENOMINATION id, so reach the rows through
      // the denominations of this catalog product (matching on the catalog
      // product id itself only worked when the two serial ids happened to agree).
      const ofThisProduct = { product: { productId: seed.catalogProductId } };
      await prisma.stockItemEvent.deleteMany({ where: { stockItem: ofThisProduct } });
      await prisma.stockItem.deleteMany({ where: ofThisProduct });
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

    it("rejects missing auth (anon → 401)", async () => {
      const res = await deleteJson(`/api/catalog/products/${seed.catalogProductId}`, null, "x");
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await deleteJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, "bad-token");
      expect(res.statusCode).toBe(403);
    });
  });

  describe("DELETE /api/catalog/denominations/:id", () => {
    it("refuses with 409 and the stock-history key when the denomination has stock", async () => {
      const res = await deleteJson(`/api/catalog/denominations/${seed.productId}`, seed.cookie, seed.csrf);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "error.denomination_has_stock_history" });
      expect(await prisma.denomination.findUnique({ where: { id: seed.productId } })).not.toBeNull();
    });

    it("deletes a denomination that never held stock and audits", async () => {
      const d = await createDenomination(prisma, {
        productId: seed.catalogProductId,
        name: "Blank",
        type: ProductType.SHARED,
        durationLabel: "1 Month",
        price: "1.00",
      });
      const res = await deleteJson(`/api/catalog/denominations/${d.id}`, seed.cookie, seed.csrf);
      expect(res.statusCode).toBe(200);
      expect(await prisma.denomination.findUnique({ where: { id: d.id } })).toBeNull();
      expect(await prisma.auditLog.findFirst({ where: { action: "denomination_delete", targetId: d.id } })).toBeTruthy();
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

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson(`/api/catalog/products/bulk-active`, null, "x", { ids: [seed.catalogProductId], active: false });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/catalog/products/bulk-active`, seed.cookie, "bad-token", { ids: [seed.catalogProductId], active: false });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/catalog/denominations/bulk-active", () => {
    it("happy path: activates multiple denominations and audits with a count", async () => {
      await prisma.denomination.update({ where: { id: seed.productId }, data: { isActive: false } });
      const other = await createDenomination(prisma, {
        productId: seed.catalogProductId,
        name: "Other Denom",
        type: ProductType.SHARED,
        durationLabel: "3 Months",
        price: "15.00",
        isActive: false,
      });
      const res = await postJson(`/api/catalog/denominations/bulk-active`, seed.cookie, seed.csrf, {
        ids: [seed.productId, other.id],
        active: true,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, count: 2 });
      expect((await getDenomination(prisma, seed.productId))!.isActive).toBe(true);
      expect((await getDenomination(prisma, other.id))!.isActive).toBe(true);
      const audit = await prisma.auditLog.findFirst({ where: { action: "denomination_bulk_active" } });
      expect(audit?.details).toBe("Activated 2 denominations.");
    });

    it("rejects an empty ids array with 400", async () => {
      const res = await postJson(`/api/catalog/denominations/bulk-active`, seed.cookie, seed.csrf, { ids: [], active: false });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a non-boolean active with 400", async () => {
      const res = await postJson(`/api/catalog/denominations/bulk-active`, seed.cookie, seed.csrf, {
        ids: [seed.productId],
        active: "yes",
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson(`/api/catalog/denominations/bulk-active`, null, "x", { ids: [seed.productId], active: false });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await postJson(`/api/catalog/denominations/bulk-active`, seed.cookie, "bad-token", { ids: [seed.productId], active: false });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("PATCH /api/catalog/products/:id", () => {
    it("happy path: updates name without changing category", async () => {
      const res = await patchJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, seed.csrf, {
        name: "Renamed Product",
      });
      expect(res.statusCode).toBe(200);
      expect((await getCatalogProduct(prisma, seed.catalogProductId))!.name).toBe("Renamed Product");
      const audit = await prisma.auditLog.findFirst({ where: { action: "product_update", targetId: seed.catalogProductId } });
      expect(audit?.details).toBe(`Updated product "Renamed Product".`);
    });

    it("moves a product to another category and audits naming both ends", async () => {
      const target = await createCategory(prisma, "E-Wallet");
      const product = (await getCatalogProduct(prisma, seed.catalogProductId))!;
      const originalCategory = await prisma.category.findUnique({ where: { id: product.categoryId } });
      const res = await patchJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, seed.csrf, {
        name: product.name,
        categoryId: target.id,
      });
      expect(res.statusCode).toBe(200);
      expect((await getCatalogProduct(prisma, seed.catalogProductId))!.categoryId).toBe(target.id);
      const audit = await prisma.auditLog.findFirst({ where: { action: "product_update", targetId: seed.catalogProductId } });
      expect(audit?.details).toBe(`Moved product "${product.name}" from "${originalCategory!.name}" to "E-Wallet".`);
    });

    it("moving to the category it is already in keeps the ordinary update wording", async () => {
      const product = (await getCatalogProduct(prisma, seed.catalogProductId))!;
      const res = await patchJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, seed.csrf, {
        name: product.name,
        categoryId: product.categoryId,
      });
      expect(res.statusCode).toBe(200);
      const audit = await prisma.auditLog.findFirst({ where: { action: "product_update", targetId: seed.catalogProductId } });
      expect(audit?.details).toBe(`Updated product "${product.name}".`);
    });

    // Task 14: gameVariant/gameVariantEmoji/gameRegion round-trip on update,
    // same "trim, blank means null" rule as storefrontDetailFields.
    it("persists gameVariant, gameVariantEmoji and gameRegion", async () => {
      const product = (await getCatalogProduct(prisma, seed.catalogProductId))!;
      const res = await patchJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, seed.csrf, {
        name: product.name,
        gameVariant: "UC",
        gameVariantEmoji: "🔫",
        gameRegion: "Indonesia",
      });
      expect(res.statusCode).toBe(200);
      const updated = await getCatalogProduct(prisma, seed.catalogProductId);
      expect(updated!.gameVariant).toBe("UC");
      expect(updated!.gameVariantEmoji).toBe("🔫");
      expect(updated!.gameRegion).toBe("Indonesia");
    });

    it("clears gameVariant, gameVariantEmoji and gameRegion when omitted", async () => {
      await updateCatalogProduct(prisma, seed.catalogProductId, {
        gameVariant: "UC",
        gameVariantEmoji: "🔫",
        gameRegion: "Indonesia",
      });
      const product = (await getCatalogProduct(prisma, seed.catalogProductId))!;
      const res = await patchJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, seed.csrf, {
        name: product.name,
      });
      expect(res.statusCode).toBe(200);
      const updated = await getCatalogProduct(prisma, seed.catalogProductId);
      expect(updated!.gameVariant).toBeNull();
      expect(updated!.gameVariantEmoji).toBeNull();
      expect(updated!.gameRegion).toBeNull();
    });

    it("rejects an unknown categoryId with 400", async () => {
      const res = await patchJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, seed.csrf, {
        name: "X",
        categoryId: 99999,
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a non-integer categoryId with 400", async () => {
      const res = await patchJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, seed.csrf, {
        name: "X",
        categoryId: "abc",
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects empty name with 400", async () => {
      const res = await patchJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, seed.csrf, { name: "" });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a non-existent product id with 404", async () => {
      const res = await patchJson(`/api/catalog/products/99999`, seed.cookie, seed.csrf, { name: "X" });
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon → 401)", async () => {
      const res = await patchJson(`/api/catalog/products/${seed.catalogProductId}`, null, "x", { name: "X" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const res = await patchJson(`/api/catalog/products/${seed.catalogProductId}`, seed.cookie, "bad-token", { name: "X" });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/catalog/products/bulk-category", () => {
    it("happy path: moves every listed product, returns the count, and audits once", async () => {
      const target = await createCategory(prisma, "Games");
      const other = await createCatalogProduct(prisma, { categoryId: seed.categoryId, name: "Other" });
      const res = await postJson(`/api/catalog/products/bulk-category`, seed.cookie, seed.csrf, {
        ids: [seed.catalogProductId, other.id],
        categoryId: target.id,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, count: 2 });
      expect((await getCatalogProduct(prisma, seed.catalogProductId))!.categoryId).toBe(target.id);
      expect((await getCatalogProduct(prisma, other.id))!.categoryId).toBe(target.id);
      const audit = await prisma.auditLog.findMany({ where: { action: "product_bulk_category" } });
      expect(audit.length).toBe(1);
      expect(audit[0]?.details).toBe(`Moved 2 products to category "Games".`);
    });

    it("rejects an empty ids array with 400", async () => {
      const target = await createCategory(prisma, "Games");
      const res = await postJson(`/api/catalog/products/bulk-category`, seed.cookie, seed.csrf, {
        ids: [],
        categoryId: target.id,
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an unknown categoryId with 400", async () => {
      const res = await postJson(`/api/catalog/products/bulk-category`, seed.cookie, seed.csrf, {
        ids: [seed.catalogProductId],
        categoryId: 99999,
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon → 401)", async () => {
      const target = await createCategory(prisma, "Games");
      const res = await postJson(`/api/catalog/products/bulk-category`, null, "x", {
        ids: [seed.catalogProductId],
        categoryId: target.id,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const target = await createCategory(prisma, "Games");
      const res = await postJson(`/api/catalog/products/bulk-category`, seed.cookie, "bad-token", {
        ids: [seed.catalogProductId],
        categoryId: target.id,
      });
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

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson(`/api/catalog/products/${seed.catalogProductId}/archive`, null, "x", { archived: true });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson(`/api/catalog/products/bulk-archive`, null, "x", { ids: [seed.catalogProductId], archived: true });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson(`/api/catalog/denominations/${seed.productId}/bulk-pricing`, null, "x", {
        minQuantity: 5,
        discountPercent: "10",
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

    it("rejects missing auth (anon → 401)", async () => {
      const res = await getJson("/api/flash-sales/denominations", null);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson("/api/flash-sales/bulk-apply", null, "x", {
        denominationIds: [seed.productId],
        discountPercent: "20",
        startsAt: shopLocal(HOUR),
        endsAt: shopLocal(5 * HOUR),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson("/api/flash-sales/bulk-end", null, "x", { denominationIds: [seed.productId] });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

  // Task 14: qtyValue/qtyUnit round-trip on update, same always-set
  // convention as nicknameCheckGameCode above.
  it("persists qtyValue and qtyUnit on update", async () => {
    const res = await patchForm(`/api/catalog/denominations/${seed.productId}`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Renamed Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "7.00",
      qtyValue: "86",
      qtyUnit: "Diamonds",
    });
    expect(res.statusCode).toBe(200);
    const d = await getDenomination(prisma, seed.productId);
    expect(d!.qtyValue).toBe(86);
    expect(d!.qtyUnit).toBe("Diamonds");
  });

  it("clears qtyValue and qtyUnit when omitted on update", async () => {
    await updateDenomination(prisma, seed.productId, { qtyValue: 86, qtyUnit: "Diamonds" });
    const res = await patchForm(`/api/catalog/denominations/${seed.productId}`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Renamed Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "7.00",
    });
    expect(res.statusCode).toBe(200);
    const d = await getDenomination(prisma, seed.productId);
    expect(d!.qtyValue).toBeNull();
    expect(d!.qtyUnit).toBeNull();
  });

  it("rejects a negative qtyValue on update with 400", async () => {
    const res = await patchForm(`/api/catalog/denominations/${seed.productId}`, seed.cookie, {
      csrf_token: seed.csrf,
      name: "Renamed Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "7.00",
      qtyValue: "-1",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });

  it("update denomination requires auth", async () => {
    const res = await patchForm(`/api/catalog/denominations/${seed.productId}`, null, { name: "Hax", type: "SHARED", durationLabel: "x", price: "1" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
    await createOrderDirect(prisma, { channel: "web", user, productId: seed.productId, quantity: 1 });
    const blocked = await deleteForm(`/api/catalog/denominations/${seed.productId}`, seed.cookie, { csrf_token: seed.csrf });
    expect(blocked.statusCode).toBe(409);
    expect(await getDenomination(prisma, seed.productId)).not.toBeNull();
  });

  it("delete denomination requires auth", async () => {
    const res = await deleteForm(`/api/catalog/denominations/${seed.productId}`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

  it("bulk add reports the import batch and duplicate counts", async () => {
    const res = await post(`/api/stock/${seed.productId}/bulk-add`, seed.cookie, {
      csrf_token: seed.csrf,
      credentials: `batchdup${counter}@e.com:p\nbatchdup${counter}@e.com:p\nBATCHDUP${counter}@e.com:other`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, added: 2, skipped: 1, duplicateInBatch: 1, duplicateExisting: 0, identityWarnings: 2 });
    const batch = await prisma.stockImportBatch.findUniqueOrThrow({ where: { id: body.batchId } });
    expect(batch).toMatchObject({ productId: seed.productId, rowsSubmitted: 3, rowsInserted: 2, rowsDuplicate: 1 });
    expect(body.message).toContain(`import batch #${body.batchId}`);
    expect(body.message).not.toContain("@");
  });

  it("bulk add requires auth", async () => {
    const res = await post(`/api/stock/${seed.productId}/bulk-add`, null, { csrf_token: "x", credentials: "leak@e.com:p" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("bulk add rejects bad CSRF", async () => {
    const res = await post(`/api/stock/${seed.productId}/bulk-add`, seed.cookie, { csrf_token: "nope", credentials: "x@e.com:p" });
    expect(res.statusCode).toBe(403);
  });

  // Final whole-branch review finding — see the matching reveal-route test's
  // comment above for the full rationale; bulkAddStock is the other named
  // call site (it decrypts existing rows to dedupe, then encrypts new ones).
  it("a malformed CREDENTIAL_ENCRYPTION_KEY surfaces as a JSON 500, not an HTML error page", async () => {
    const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = "tooshort";
    try {
      const res = await post(`/api/stock/${seed.productId}/bulk-add`, seed.cookie, {
        csrf_token: seed.csrf,
        credentials: `keyerr${counter}@e.com:p`,
      });
      expect(res.statusCode).toBe(500);
      expect(res.headers["content-type"]).toContain("application/json");
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toMatch(/CREDENTIAL_ENCRYPTION_KEY/);
    } finally {
      if (originalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
    }
  });

  // Data-1: two concurrent uploads of the SAME fresh credential must not both
  // pass the "not already present" check and both insert. Postgres runs the
  // two transactions in parallel, so what serializes them is bulkAddStock's own
  // per-denomination advisory lock (crud/stock.ts); the second upload then sees
  // the first one's committed row and skips it as a duplicate. The repeated,
  // deterministic version of this race lives in crud/stock_concurrency.test.ts.
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
    // Credentials are encrypted at rest (fresh IV per row) — decrypt to find
    // the one row that actually holds dupCred instead of matching the column
    // literally.
    const allRows = await prisma.stockItem.findMany({ where: { productId: seed.productId } });
    const matching = allRows.filter((r) => decryptCredentials(r.credentials) === dupCred);
    expect(matching.length).toBe(1);
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

  it("a web upload notifies restock subscribers through the outbox and consumes their subscriptions", async () => {
    const cat = await createCategory(prisma, `SubCat${counter++}`);
    const parentProduct = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Spotify", description: "x" });
    const denom = await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "3 Months",
      type: ProductType.SHARED,
      durationLabel: "3 Months",
      price: "5.00",
      description: "x",
    });
    const tgId = BigInt(900_000_000 + counter++);
    const sub = await prisma.user.create({ data: { telegramId: tgId, referralCode: `sub${counter}`, language: "ID" } });
    await prisma.restockSubscription.create({ data: { userId: sub.id, productId: denom.id } });

    const res = await post(`/api/stock/${denom.id}/bulk-add`, seed.cookie, {
      csrf_token: seed.csrf,
      credentials: `sub${counter}@e.com:p`,
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.notificationOutbox.findMany({ where: { event: "RESTOCK_SUBSCRIBER_NOTIFIED" } });
    const mine = rows.filter((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id === Number(tgId));
    expect(mine).toHaveLength(1);
    expect(JSON.parse(mine[0]!.payloadJson)).toMatchObject({ product_name: "Spotify - 3 Months", buyer_language: "id" });
    expect(await prisma.restockSubscription.count({ where: { productId: denom.id } })).toBe(0);
  });

  // bulk delete / download happy paths: covered by "stock JSON API —
  // bulk-dead, bulk-delete, item note/dead, download" below.

  it("download requires auth", async () => {
    const res = await get(`/api/stock/${seed.productId}/download`, null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  // The Stock Items table shows the account credential masked by default,
  // with an explicit per-row reveal (Task 2: StockItem.credentials is
  // encrypted at rest) — the list payload must never carry a decrypted
  // value, and nothing more of the raw row than the page actually renders.
  it("detail returns each item's credential MASKED (never the decrypted value) and no order linkage", async () => {
    const res = await get(`/api/stock/${seed.productId}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { items: Record<string, unknown>[] };
    expect(data.items.length).toBeGreaterThan(0);
    const item = data.items[0]!;
    expect(Object.keys(item).sort()).toEqual(
      ["createdAtDisplay", "credentials", "deadReason", "id", "note", "status"],
    );
    expect(item.credentials).toBe("••••••••");
    expect(item).not.toHaveProperty("orderId");
  });

  describe("GET /api/stock/item/:stockId/history", () => {
    it("returns the item's events in order with no credentials and writes no audit row", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const secret = decryptCredentials(item.credentials);
      await prisma.stockItemEvent.deleteMany({ where: { stockItemId: item.id } });
      await prisma.stockItemEvent.createMany({
        data: [
          { stockItemId: item.id, eventType: "MARKED_DEAD", fromStatus: "AVAILABLE", toStatus: "DEAD", actorType: "ADMIN", actorAdminId: seed.adminId, reasonCode: "EXPIRED", occurredAt: new Date("2026-01-02T00:00:00Z") },
          { stockItemId: item.id, eventType: "IMPORTED", toStatus: "AVAILABLE", actorType: "ADMIN", actorAdminId: seed.adminId, occurredAt: new Date("2026-01-01T00:00:00Z") },
        ],
      });
      const auditsBefore = await prisma.auditLog.count();

      const res = await get(`/api/stock/item/${item.id}/history`, seed.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(secret);
      const body = res.json() as { events: { eventType: string; reasonCode: string | null; occurredAtDisplay: string; actorName: string | null }[] };
      expect(body.events.map((e) => e.eventType)).toEqual(["IMPORTED", "MARKED_DEAD"]);
      expect(body.events[1]!.reasonCode).toBe("EXPIRED");
      expect(typeof body.events[0]!.occurredAtDisplay).toBe("string");
      expect(JSON.stringify(body)).not.toMatch(/credentials|meta/);
      expect(await prisma.auditLog.count()).toBe(auditsBefore);
    });

    it("returns an empty list for an item with no recorded events", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      await prisma.stockItemEvent.deleteMany({ where: { stockItemId: item.id } });
      const res = await get(`/api/stock/item/${item.id}/history`, seed.cookie);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { events: unknown[] }).events).toEqual([]);
    });

    it("404s for an unknown stock item", async () => {
      const res = await get(`/api/stock/item/999999/history`, seed.cookie);
      expect(res.statusCode).toBe(404);
    });

    it("rejects anonymous callers with 401", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await get(`/api/stock/item/${item.id}/history`, null);
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/stock/item/:stockId/reveal", () => {
    it("returns the decrypted credential and audits credential_revealed", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const expected = decryptCredentials(item.credentials);

      const res = await post(`/api/stock/item/${item.id}/reveal`, seed.cookie, { csrf_token: seed.csrf });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { ok: boolean; credentials: string };
      expect(body.credentials).toBe(expected);

      const audit = await prisma.auditLog.findFirst({
        where: { action: "credential_revealed", targetId: item.id },
        orderBy: { id: "desc" },
      });
      expect(audit).toBeTruthy();
      expect(audit!.adminId).toBe(seed.adminId);
      expect(audit!.details ?? "").not.toContain(expected); // never the credential itself
    });

    it("audits every reveal, not just the first", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      await post(`/api/stock/item/${item.id}/reveal`, seed.cookie, { csrf_token: seed.csrf });
      await post(`/api/stock/item/${item.id}/reveal`, seed.cookie, { csrf_token: seed.csrf });

      const audits = await prisma.auditLog.findMany({
        where: { action: "credential_revealed", targetId: item.id },
      });
      expect(audits.length).toBe(2);
    });

    it("rejects a non-existent stock item id with 404", async () => {
      const res = await post(`/api/stock/item/999999/reveal`, seed.cookie, { csrf_token: seed.csrf });
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon → 401)", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await post(`/api/stock/item/${item.id}/reveal`, null, { csrf_token: "x" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await post(`/api/stock/item/${item.id}/reveal`, seed.cookie, { csrf_token: "bad-token" });
      expect(res.statusCode).toBe(403);
    });

    // Final whole-branch review finding: a missing/malformed
    // CREDENTIAL_ENCRYPTION_KEY used to surface as server.ts's generic
    // text/html 500 page, which broke the admin client's apiPost (it expects
    // JSON and gets an HTML parse error instead of a readable message). The
    // route now catches CredentialKeyConfigError specifically and returns a
    // clear JSON error. CREDENTIAL_ENCRYPTION_KEY is read straight from
    // process.env at call time (see credentialCrypto.ts's own comment on
    // why), so mutating it here takes effect immediately — same technique
    // credentialCrypto.test.ts uses to test the unconfigured/malformed cases.
    it("a malformed CREDENTIAL_ENCRYPTION_KEY surfaces as a JSON 500, not an HTML error page", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
      process.env.CREDENTIAL_ENCRYPTION_KEY = "tooshort";
      try {
        const res = await post(`/api/stock/item/${item.id}/reveal`, seed.cookie, { csrf_token: seed.csrf });
        expect(res.statusCode).toBe(500);
        expect(res.headers["content-type"]).toContain("application/json");
        const body = JSON.parse(res.body) as { error: string };
        expect(body.error).toMatch(/CREDENTIAL_ENCRYPTION_KEY/);
      } finally {
        if (originalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
        else process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
      }
    });
  });

  it("statusCounts stays accurate past one page, and keeps climbing as stock is added (regression for the stuck-at-500 bug)", async () => {
    // seed.productId already has 4 AVAILABLE rows from the global beforeEach.
    await bulkAddStock(prisma, seed.productId, Array.from({ length: 60 }, (_, i) => `page${i}@e.com:p`));
    // Now 64 AVAILABLE rows total.

    const page1 = await get(`/api/stock/${seed.productId}?tab=available&page=1`, seed.cookie);
    expect(page1.statusCode).toBe(200);
    const page1Data = JSON.parse(page1.body) as {
      items: unknown[];
      statusCounts: { available: number };
      total: number;
    };
    expect(page1Data.statusCounts.available).toBe(64);
    expect(page1Data.total).toBe(64);
    expect(page1Data.items.length).toBe(50); // PAGE_SIZE — must match apps/web-admin/src/routes/api/stock.ts's PAGE_SIZE

    const page2 = await get(`/api/stock/${seed.productId}?tab=available&page=2`, seed.cookie);
    const page2Data = JSON.parse(page2.body) as { items: unknown[]; statusCounts: { available: number } };
    expect(page2Data.items.length).toBe(14); // the remaining 64 - 50
    expect(page2Data.statusCounts.available).toBe(64); // same aggregate regardless of page

    // The literal "stuck" case: add one more row and confirm the count actually moves.
    await bulkAddStock(prisma, seed.productId, ["one-more@e.com:p"]);
    const after = await get(`/api/stock/${seed.productId}?tab=available&page=1`, seed.cookie);
    const afterData = JSON.parse(after.body) as { statusCounts: { available: number } };
    expect(afterData.statusCounts.available).toBe(65);
  });

  it("search finds a stock item by credential substring, still masked in the response", async () => {
    await bulkAddStock(prisma, seed.productId, ["findme-unique@example.com:Secret1"]);

    const res = await get(`/api/stock/${seed.productId}?tab=available&q=findme-unique`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { items: { credentials: string }[]; total: number; capped: boolean };
    expect(data.total).toBeGreaterThan(0);
    expect(data.items.length).toBeGreaterThan(0);
    // Well under SEARCH_RESULT_CAP, so the cap must not be flagged.
    expect(data.capped).toBe(false);
    // Never the decrypted value in the list payload — same invariant as the
    // existing masked-credentials test at web.test.ts:3597.
    for (const item of data.items) {
      expect(item.credentials).toBe("••••••••");
    }
  });

  it("search finds nothing for a substring that doesn't match any credential or note", async () => {
    const res = await get(`/api/stock/${seed.productId}?tab=available&q=definitely-not-present-xyz`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { items: unknown[]; total: number };
    expect(data.items.length).toBe(0);
    expect(data.total).toBe(0);
  });

  // Final whole-branch review finding: searchStockCredentials silently
  // truncated matches to 200 while the route reported `total = items.length`
  // as if it were the real match count — the same "silently capped number
  // presented as exact" shape as the original stuck-at-500 bug this branch
  // fixes, just one layer up. The route now also reports `capped` so the
  // admin can tell "200 results" from "at least 200, narrow your search".
  it("search exposes capped:true and total:SEARCH_RESULT_CAP once matches exceed the cap, instead of silently presenting the cap as an exact count", async () => {
    const tag = `capseek${counter++}`;
    await bulkAddStock(
      prisma,
      seed.productId,
      Array.from({ length: SEARCH_RESULT_CAP + 1 }, (_, i) => `${tag}-${i}@example.com:Secret1`),
    );

    const res = await get(`/api/stock/${seed.productId}?tab=available&q=${tag}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { total: number; capped: boolean; items: unknown[] };
    expect(data.total).toBe(SEARCH_RESULT_CAP);
    expect(data.items.length).toBe(SEARCH_RESULT_CAP);
    expect(data.capped).toBe(true);
  });

  // Final whole-branch review finding: a misconfigured CREDENTIAL_ENCRYPTION_KEY
  // used to make the search path throw straight into server.ts's generic
  // text/html 500 page (the route's bulk-add and reveal handlers already
  // catch CredentialKeyConfigError specifically — see their tests above —
  // but the search branch didn't). CREDENTIAL_ENCRYPTION_KEY is read straight
  // from process.env at call time, so mutating it here takes effect
  // immediately (same technique as the bulk-add/reveal tests above).
  it("a malformed CREDENTIAL_ENCRYPTION_KEY surfaces as a JSON 500 on the search path, not an HTML error page", async () => {
    const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = "tooshort";
    try {
      const res = await get(`/api/stock/${seed.productId}?tab=available&q=anything`, seed.cookie);
      expect(res.statusCode).toBe(500);
      expect(res.headers["content-type"]).toContain("application/json");
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toMatch(/CREDENTIAL_ENCRYPTION_KEY/);
    } finally {
      if (originalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
    }
  });

  // Final whole-branch review finding: one corrupted/tampered credential row
  // anywhere in the scanned status group used to abort the ENTIRE search for
  // every other row, since decryptCredentials's thrown error wasn't caught
  // per-row. A structurally-valid envelope with a wrong auth tag decrypts to
  // neither a CredentialKeyConfigError (that's the "unconfigured" case) nor a
  // clean plaintext — decipher.final() throws a plain integrity error, which
  // the fix now treats as "this row doesn't match" instead of failing the
  // whole scan. Written directly via prisma.stockItem.create (not
  // encryptCredentials) so it's deliberately undecryptable while still
  // parsing as a valid envelope shape.
  it("a single corrupted/tampered credential row doesn't abort the whole search scan for other rows", async () => {
    const tag = `scanok${counter++}`;
    await bulkAddStock(prisma, seed.productId, [`${tag}-good@example.com:Secret1`]);
    const badEnvelope = JSON.stringify({
      keyVersion: 1,
      iv: Buffer.alloc(12, 1).toString("base64"),
      ciphertext: Buffer.from(`${tag}-corrupted`, "utf8").toString("base64"),
      authTag: Buffer.alloc(16, 2).toString("base64"),
    });
    const corrupted = await prisma.stockItem.create({
      data: { productId: seed.productId, credentials: badEnvelope, status: "AVAILABLE" },
    });

    const res = await get(`/api/stock/${seed.productId}?tab=available&q=${tag}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { total: number; items: { id: number }[] };
    // The still-decryptable "good" row is found; the scan wasn't aborted by
    // the corrupted row, which itself is treated as a non-match rather than
    // surfacing as a 500.
    expect(data.total).toBe(1);
    expect(data.items.some((i) => i.id === corrupted.id)).toBe(false);
  });

  it("sold tab groups SOLD + RESERVED items together and statusCounts shows individual counts", async () => {
    // Start with 4 AVAILABLE rows from beforeEach.
    // Change 2 of them: mark one SOLD, one RESERVED.
    const allItems = await prisma.stockItem.findMany({ where: { productId: seed.productId } });
    if (allItems.length >= 2) {
      await prisma.stockItem.update({
        where: { id: allItems[0]!.id },
        data: { status: "SOLD", soldAt: new Date() },
      });
      await prisma.stockItem.update({ where: { id: allItems[1]!.id }, data: { status: "RESERVED" } });
    }

    const res = await get(`/api/stock/${seed.productId}?tab=sold`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as {
      items: { status: string }[];
      statusCounts: { available: number; reserved: number; sold: number; dead: number };
      total: number;
    };
    // The tab=sold endpoint returns both SOLD and RESERVED items combined.
    expect(data.total).toBe(2);
    expect(data.items.length).toBe(2);
    // statusCounts shows individual counts for all statuses, not combined.
    expect(data.statusCounts.sold).toBe(1);
    expect(data.statusCounts.reserved).toBe(1);
    expect(data.statusCounts.available).toBe(2); // the remaining 4 - 2
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

    it("audits a count sentence and never echoes the admin-typed note (which may hold a pasted credential)", async () => {
      const items = await prisma.stockItem.findMany({ where: { productId: seed.productId, status: "AVAILABLE" } });
      const ids = items.slice(0, 2).map((i) => i.id);
      const res = await postJson(`/api/stock/${seed.productId}/bulk-dead`, seed.cookie, seed.csrf, { ids, note: "user@example.com:hunter2" });
      expect(res.statusCode).toBe(200);
      const audit = await prisma.auditLog.findFirst({ where: { action: "stock_bulk_dead", targetId: seed.productId } });
      expect(audit!.details).toBe("Marked 2 stock items dead.");
      expect(audit!.details).not.toContain("hunter2");
      expect(audit!.details).not.toContain("user@example.com");
    });

    it("stores the chosen reason on rows and events, names it in the audit sentence, and rejects an unknown one", async () => {
      const items = await prisma.stockItem.findMany({ where: { productId: seed.productId, status: "AVAILABLE" } });
      const ids = items.slice(0, 2).map((i) => i.id);
      const bad = await postJson(`/api/stock/${seed.productId}/bulk-dead`, seed.cookie, seed.csrf, { ids, reason: "BOGUS" });
      expect(bad.statusCode).toBe(400);
      expect(await prisma.stockItem.count({ where: { id: { in: ids }, status: "DEAD" } })).toBe(0);

      const res = await postJson(`/api/stock/${seed.productId}/bulk-dead`, seed.cookie, seed.csrf, { ids, reason: "PASSWORD_CHANGED" });
      expect(res.statusCode).toBe(200);
      for (const id of ids) {
        expect((await prisma.stockItem.findUnique({ where: { id } }))!.deadReason).toBe("PASSWORD_CHANGED");
        expect((await prisma.stockItemEvent.findFirst({ where: { stockItemId: id, eventType: StockEventType.MARKED_DEAD } }))!.reasonCode).toBe("PASSWORD_CHANGED");
      }
      const audit = await prisma.auditLog.findFirst({ where: { action: "stock_bulk_dead", targetId: seed.productId } });
      expect(audit!.details).toBe("Marked 2 stock items dead (password changed).");
    });

    it("defaults the reason to OTHER when omitted", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId, status: "AVAILABLE" } }))!;
      const res = await postJson(`/api/stock/${seed.productId}/bulk-dead`, seed.cookie, seed.csrf, { ids: [item.id] });
      expect(res.statusCode).toBe(200);
      expect((await prisma.stockItem.findUnique({ where: { id: item.id } }))!.deadReason).toBe("OTHER");
    });

    it("rejects an empty ids array with 400", async () => {
      const res = await postJson(`/api/stock/${seed.productId}/bulk-dead`, seed.cookie, seed.csrf, { ids: [] });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson(`/api/stock/${seed.productId}/bulk-dead`, null, "x", { ids: [1] });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
      const softDeleted = (await prisma.stockItem.findUnique({ where: { id: delId } }))!;
      expect(softDeleted.deletedAt).not.toBeNull();
      expect(softDeleted.deletedByAdminId).toBe(seed.adminId);
      expect((await prisma.stockItem.findUnique({ where: { id: sold.id } }))!.deletedAt).toBeNull();
      const audit = await prisma.auditLog.findMany({ where: { action: "stock_bulk_delete", targetId: seed.productId } });
      expect(audit.length).toBe(1);
      expect(audit.every((a) => !(a.details ?? "").includes("@"))).toBe(true);
    });

    it("rejects an empty ids array with 400", async () => {
      const res = await postJson(`/api/stock/${seed.productId}/bulk-delete`, seed.cookie, seed.csrf, { ids: [] });
      expect(res.statusCode).toBe(400);
    });

    it("rejects missing auth (anon → 401)", async () => {
      const res = await postJson(`/api/stock/${seed.productId}/bulk-delete`, null, "x", { ids: [1] });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

    it("stores the chosen reason on the row and event and rejects an unknown one with 400", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId, status: "AVAILABLE" } }))!;
      const bad = await postJson(`/api/stock/item/${item.id}/dead`, seed.cookie, seed.csrf, { reason: "nope" });
      expect(bad.statusCode).toBe(400);
      expect((await prisma.stockItem.findUnique({ where: { id: item.id } }))!.status).toBe("AVAILABLE");

      const res = await postJson(`/api/stock/item/${item.id}/dead`, seed.cookie, seed.csrf, { reason: "REGION_LOCK" });
      expect(res.statusCode).toBe(200);
      expect((await prisma.stockItem.findUnique({ where: { id: item.id } }))!.deadReason).toBe("REGION_LOCK");
      expect((await prisma.stockItemEvent.findFirst({ where: { stockItemId: item.id, eventType: StockEventType.MARKED_DEAD } }))!.reasonCode).toBe("REGION_LOCK");
      const audit = await prisma.auditLog.findFirst({ where: { action: "stock_mark_dead", targetId: item.id } });
      expect(audit!.details).toBe(`Marked stock item #${item.id} dead (region lock).`);
    });

    it("lists the stored reason on dead rows in the product payload", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId, status: "AVAILABLE" } }))!;
      await postJson(`/api/stock/item/${item.id}/dead`, seed.cookie, seed.csrf, { reason: "EXPIRED" });
      const res = await app.inject({ method: "GET", url: `/api/stock/${seed.productId}?tab=dead`, cookies: { [COOKIE]: seed.cookie } });
      const row = JSON.parse(res.body).items.find((i: { id: number }) => i.id === item.id);
      expect(row.deadReason).toBe("EXPIRED");
    });

    it("audits a sentence naming the item and never echoes the admin-typed note", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId, status: "AVAILABLE" } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/dead`, seed.cookie, seed.csrf, { note: "user@example.com:hunter2" });
      expect(res.statusCode).toBe(200);
      const audit = await prisma.auditLog.findFirst({ where: { action: "stock_mark_dead", targetId: item.id } });
      expect(audit!.details).toBe(`Marked stock item #${item.id} dead.`);
      expect(audit!.details).not.toContain("hunter2");
      expect(audit!.details).not.toContain("user@example.com");
    });

    it("rejects a non-existent stock item id with 404", async () => {
      const res = await postJson(`/api/stock/item/999999/dead`, seed.cookie, seed.csrf, {});
      expect(res.statusCode).toBe(404);
    });

    // M-8 fix, backend audit 2026-07-31: bulkMarkStockDead already refused to
    // touch SOLD rows; the single-item route had no such guard, so a mis-tap
    // on a delivered credential in the list view could flip it to DEAD.
    it("refuses to mark a SOLD (delivered) item dead — 409, status unchanged, no audit row", async () => {
      const item = await prisma.stockItem.update({
        where: { id: (await prisma.stockItem.findFirst({ where: { productId: seed.productId, status: "AVAILABLE" } }))!.id },
        data: { status: "SOLD", soldAt: new Date() },
      });
      const res = await postJson(`/api/stock/item/${item.id}/dead`, seed.cookie, seed.csrf, { note: "mis-tap" });
      expect(res.statusCode).toBe(409);
      expect((await prisma.stockItem.findUnique({ where: { id: item.id } }))!.status).toBe("SOLD");
      const audit = await prisma.auditLog.findFirst({ where: { action: "stock_mark_dead", targetId: item.id } });
      expect(audit).toBeNull();
    });

    it("rejects missing auth (anon → 401)", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/dead`, null, "x", {});
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/dead`, seed.cookie, "bad-token", {});
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/stock/item/:stockId/delete", () => {
    it("happy path deletes a single item and audits without leaking credentials", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId, status: "AVAILABLE" } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/delete`, seed.cookie, seed.csrf, {});
      expect(res.statusCode).toBe(200);
      const softDeleted = (await prisma.stockItem.findUnique({ where: { id: item.id } }))!;
      expect(softDeleted.deletedAt).not.toBeNull();
      expect(softDeleted.deletedByAdminId).toBe(seed.adminId);
      const audit = await prisma.auditLog.findFirst({ where: { action: "stock_item_delete", targetId: item.id } });
      expect(audit).toBeTruthy();
      expect((audit!.details ?? "").includes("@")).toBe(false);
    });

    it("rejects a non-existent stock item id with 404", async () => {
      const res = await postJson(`/api/stock/item/999999/delete`, seed.cookie, seed.csrf, {});
      expect(res.statusCode).toBe(404);
    });

    it("refuses to delete a SOLD (delivered) item — 409, row unchanged, no audit row", async () => {
      const item = await prisma.stockItem.update({
        where: { id: (await prisma.stockItem.findFirst({ where: { productId: seed.productId, status: "AVAILABLE" } }))!.id },
        data: { status: "SOLD", soldAt: new Date() },
      });
      const res = await postJson(`/api/stock/item/${item.id}/delete`, seed.cookie, seed.csrf, {});
      expect(res.statusCode).toBe(409);
      expect((await prisma.stockItem.findUnique({ where: { id: item.id } }))!.deletedAt).toBeNull();
      const audit = await prisma.auditLog.findFirst({ where: { action: "stock_item_delete", targetId: item.id } });
      expect(audit).toBeNull();
    });

    it("rejects missing auth (anon → 401)", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/delete`, null, "x", {});
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/delete`, seed.cookie, "bad-token", {});
      expect(res.statusCode).toBe(403);
    });
  });

  describe("soft-deleted stock item", () => {
    it("is not found for dead, delete, note and reveal (404)", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId, status: "AVAILABLE" } }))!;
      await prisma.stockItem.update({ where: { id: item.id }, data: { deletedAt: new Date() } });
      for (const action of ["dead", "delete", "note", "reveal"]) {
        const res = await postJson(`/api/stock/item/${item.id}/${action}`, seed.cookie, seed.csrf, { note: "x", csrf_token: seed.csrf });
        expect(res.statusCode, action).toBe(404);
      }
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

    it("audits a sentence naming the item and never echoes the note text", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/note`, seed.cookie, seed.csrf, { note: "user@example.com:hunter2" });
      expect(res.statusCode).toBe(200);
      const audit = await prisma.auditLog.findFirst({ where: { action: "stock_edit_note", targetId: item.id } });
      expect(audit!.details).toBe(`Updated the note on stock item #${item.id}.`);
      expect(audit!.details).not.toContain("hunter2");
      expect(audit!.details).not.toContain("user@example.com");
    });

    it("rejects a non-existent stock item id with 404", async () => {
      const res = await postJson(`/api/stock/item/999999/note`, seed.cookie, seed.csrf, { note: "x" });
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon → 401)", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/note`, null, "x", { note: "x" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const item = (await prisma.stockItem.findFirst({ where: { productId: seed.productId } }))!;
      const res = await postJson(`/api/stock/item/${item.id}/note`, seed.cookie, "bad-token", { note: "x" });
      expect(res.statusCode).toBe(403);
    });
  });

  // Fase 3c: each admin stock mutation writes its StockItemEvent in the SAME
  // transaction as the status change and the audit row. The rollback cases make
  // the audit insert fail (a Postgres trigger in the per-file test schema) and
  // check the change and the event vanished with it.
  describe("stock events written by the admin routes", () => {
    const eventsOfType = (stockItemId: number, eventType: string) =>
      prisma.stockItemEvent.findMany({ where: { stockItemId, eventType } });
    const available = (n: number) =>
      prisma.stockItem.findMany({
        where: { productId: seed.productId, status: "AVAILABLE" },
        orderBy: { id: "asc" },
        take: n,
      });

    async function failAuditInsertsFor(action: string) {
      await prisma.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger AS $$ BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_fail_audit()`,
      );
    }
    async function restoreAuditInserts() {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_audit ON audit_logs`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_fail_audit()`);
    }

    it("records one CREDENTIAL_REVEALED event per exported row, attributed to the admin and carrying no credential", async () => {
      const avail = await prisma.stockItem.findMany({ where: { productId: seed.productId, status: "AVAILABLE", deletedAt: null } });
      expect(avail.length).toBeGreaterThan(0);
      const before = await prisma.stockItemEvent.count({ where: { eventType: StockEventType.CREDENTIAL_REVEALED } });
      const res = await get(`/api/stock/${seed.productId}/download`, seed.cookie);
      expect(res.statusCode).toBe(200);

      for (const item of avail) {
        const events = await eventsOfType(item.id, StockEventType.CREDENTIAL_REVEALED);
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events.at(-1)).toMatchObject({ actorType: StockActorType.ADMIN, actorAdminId: seed.adminId });
        expect(JSON.stringify(events.at(-1)!.meta ?? null)).not.toContain(decryptCredentials(item.credentials));
      }
      const after = await prisma.stockItemEvent.count({ where: { eventType: StockEventType.CREDENTIAL_REVEALED } });
      expect(after - before).toBe(avail.length);
    });

    it("the plaintext download writes nothing when its audit row fails: no event, no file", async () => {
      const avail = await prisma.stockItem.findMany({ where: { productId: seed.productId, status: "AVAILABLE", deletedAt: null } });
      const before = await prisma.stockItemEvent.count({ where: { eventType: StockEventType.CREDENTIAL_REVEALED } });
      await failAuditInsertsFor("stock_download");
      try {
        const res = await get(`/api/stock/${seed.productId}/download`, seed.cookie);
        expect(res.statusCode).toBe(500);
        for (const item of avail) expect(res.body).not.toContain(decryptCredentials(item.credentials));
      } finally {
        await restoreAuditInserts();
      }
      expect(await prisma.stockItemEvent.count({ where: { eventType: StockEventType.CREDENTIAL_REVEALED } })).toBe(before);
    });

    it("bulk-add writes an IMPORTED event per new row, attributed to the logged-in admin", async () => {
      const res = await post(`/api/stock/${seed.productId}/bulk-add`, seed.cookie, {
        csrf_token: seed.csrf,
        credentials: "ev1@e.com:p\nev2@e.com:p",
      });
      expect(res.statusCode).toBe(200);

      const events = await prisma.stockItemEvent.findMany({
        where: { eventType: StockEventType.IMPORTED, actorAdminId: seed.adminId },
      });
      expect(events).toHaveLength(2);
      for (const e of events) {
        expect(e).toMatchObject({ actorType: StockActorType.ADMIN, fromStatus: null, toStatus: "AVAILABLE" });
      }
    });

    it("a failing audit insert rolls a bulk-add back: no rows, no events", async () => {
      const rowsBefore = await prisma.stockItem.count({ where: { productId: seed.productId } });
      const eventsBefore = await prisma.stockItemEvent.count();
      await failAuditInsertsFor("stock_upload");
      try {
        const res = await post(`/api/stock/${seed.productId}/bulk-add`, seed.cookie, {
          csrf_token: seed.csrf,
          credentials: "rb1@e.com:p\nrb2@e.com:p",
        });
        expect(res.statusCode).toBe(500);
      } finally {
        await restoreAuditInserts();
      }
      expect(await prisma.stockItem.count({ where: { productId: seed.productId } })).toBe(rowsBefore);
      expect(await prisma.stockItemEvent.count()).toBe(eventsBefore);
    });

    it("dead: writes MARKED_DEAD for the admin with no note in it; a refused (SOLD) item writes no event", async () => {
      const [item, soldItem] = await available(2);
      await prisma.stockItem.update({ where: { id: soldItem!.id }, data: { status: "SOLD", soldAt: new Date() } });

      const res = await postJson(`/api/stock/item/${item!.id}/dead`, seed.cookie, seed.csrf, { note: "user@example.com:hunter2" });
      expect(res.statusCode).toBe(200);
      const refused = await postJson(`/api/stock/item/${soldItem!.id}/dead`, seed.cookie, seed.csrf, { note: "mis-tap" });
      expect(refused.statusCode).toBe(409);

      const events = await eventsOfType(item!.id, StockEventType.MARKED_DEAD);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        fromStatus: "AVAILABLE",
        toStatus: "DEAD",
        actorType: StockActorType.ADMIN,
        actorAdminId: seed.adminId,
      });
      expect(JSON.stringify(events)).not.toContain("hunter2");
      expect(await eventsOfType(soldItem!.id, StockEventType.MARKED_DEAD)).toHaveLength(0);
    });

    it("dead: a failing audit insert rolls the status change and its event back", async () => {
      const [item] = await available(1);
      await failAuditInsertsFor("stock_mark_dead");
      try {
        const res = await postJson(`/api/stock/item/${item!.id}/dead`, seed.cookie, seed.csrf, { note: "x" });
        expect(res.statusCode).toBe(500);
      } finally {
        await restoreAuditInserts();
      }
      expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: item!.id } })).status).toBe("AVAILABLE");
      expect(await eventsOfType(item!.id, StockEventType.MARKED_DEAD)).toHaveLength(0);
    });

    it("bulk-dead: writes MARKED_DEAD only for the ids that actually changed", async () => {
      const [a, b, sold] = await available(3);
      await prisma.stockItem.update({ where: { id: sold!.id }, data: { status: "SOLD", soldAt: new Date() } });

      const res = await postJson(`/api/stock/${seed.productId}/bulk-dead`, seed.cookie, seed.csrf, {
        ids: [a!.id, b!.id, sold!.id],
        note: "batch",
      });
      expect(JSON.parse(res.body)).toEqual({ ok: true, count: 2 });

      const events = await prisma.stockItemEvent.findMany({
        where: { eventType: StockEventType.MARKED_DEAD },
        orderBy: { stockItemId: "asc" },
      });
      expect(events.map((e) => e.stockItemId)).toEqual([a!.id, b!.id]);
      expect(events.every((e) => e.actorAdminId === seed.adminId)).toBe(true);
    });

    it("bulk-dead: a failing audit insert rolls every status change and event back", async () => {
      const [a, b] = await available(2);
      await failAuditInsertsFor("stock_bulk_dead");
      try {
        const res = await postJson(`/api/stock/${seed.productId}/bulk-dead`, seed.cookie, seed.csrf, { ids: [a!.id, b!.id] });
        expect(res.statusCode).toBe(500);
      } finally {
        await restoreAuditInserts();
      }
      expect(await prisma.stockItem.count({ where: { id: { in: [a!.id, b!.id] }, status: "AVAILABLE" } })).toBe(2);
      expect(await prisma.stockItemEvent.count({ where: { eventType: StockEventType.MARKED_DEAD } })).toBe(0);
    });

    it("delete: writes SOFT_DELETED for the admin; a refused (SOLD) item writes no event", async () => {
      const [item, soldItem] = await available(2);
      await prisma.stockItem.update({ where: { id: soldItem!.id }, data: { status: "SOLD", soldAt: new Date() } });

      expect((await postJson(`/api/stock/item/${item!.id}/delete`, seed.cookie, seed.csrf, {})).statusCode).toBe(200);
      expect((await postJson(`/api/stock/item/${soldItem!.id}/delete`, seed.cookie, seed.csrf, {})).statusCode).toBe(409);

      const events = await eventsOfType(item!.id, StockEventType.SOFT_DELETED);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorType: StockActorType.ADMIN, actorAdminId: seed.adminId });
      expect(await eventsOfType(soldItem!.id, StockEventType.SOFT_DELETED)).toHaveLength(0);
    });

    it("delete: a failing audit insert rolls the soft delete and its event back", async () => {
      const [item] = await available(1);
      await failAuditInsertsFor("stock_item_delete");
      try {
        const res = await postJson(`/api/stock/item/${item!.id}/delete`, seed.cookie, seed.csrf, {});
        expect(res.statusCode).toBe(500);
      } finally {
        await restoreAuditInserts();
      }
      expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: item!.id } })).deletedAt).toBeNull();
      expect(await eventsOfType(item!.id, StockEventType.SOFT_DELETED)).toHaveLength(0);
    });

    it("bulk-delete: writes SOFT_DELETED only for the ids actually deleted, and rolls back with a failing audit insert", async () => {
      const [a, b, sold] = await available(3);
      await prisma.stockItem.update({ where: { id: sold!.id }, data: { status: "SOLD", soldAt: new Date() } });

      await failAuditInsertsFor("stock_bulk_delete");
      try {
        const res = await postJson(`/api/stock/${seed.productId}/bulk-delete`, seed.cookie, seed.csrf, { ids: [a!.id, b!.id, sold!.id] });
        expect(res.statusCode).toBe(500);
      } finally {
        await restoreAuditInserts();
      }
      expect(await prisma.stockItem.count({ where: { id: { in: [a!.id, b!.id] }, deletedAt: null } })).toBe(2);
      expect(await prisma.stockItemEvent.count({ where: { eventType: StockEventType.SOFT_DELETED } })).toBe(0);

      const res = await postJson(`/api/stock/${seed.productId}/bulk-delete`, seed.cookie, seed.csrf, { ids: [a!.id, b!.id, sold!.id] });
      expect(JSON.parse(res.body)).toEqual({ ok: true, count: 2, skipped: 1 });
      const events = await prisma.stockItemEvent.findMany({
        where: { eventType: StockEventType.SOFT_DELETED },
        orderBy: { stockItemId: "asc" },
      });
      expect(events.map((e) => e.stockItemId)).toEqual([a!.id, b!.id]);
    });

    it("note: audits the edit and writes no stock event", async () => {
      const [item] = await available(1);
      const before = await prisma.stockItemEvent.count({ where: { stockItemId: item!.id } });

      const res = await postJson(`/api/stock/item/${item!.id}/note`, seed.cookie, seed.csrf, { note: "rotated" });
      expect(res.statusCode).toBe(200);

      expect(await prisma.auditLog.count({ where: { action: "stock_edit_note", targetId: item!.id } })).toBe(1);
      expect(await prisma.stockItemEvent.count({ where: { stockItemId: item!.id } })).toBe(before);
    });

    it("note: a failing audit insert rolls the note back", async () => {
      const [item] = await available(1);
      await prisma.stockItem.update({ where: { id: item!.id }, data: { note: "original" } });
      await failAuditInsertsFor("stock_edit_note");
      try {
        const res = await postJson(`/api/stock/item/${item!.id}/note`, seed.cookie, seed.csrf, { note: "changed" });
        expect(res.statusCode).toBe(500);
      } finally {
        await restoreAuditInserts();
      }
      expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: item!.id } })).note).toBe("original");
    });

    it("reveal: writes CREDENTIAL_REVEALED next to the audit row, and a 404 writes neither", async () => {
      const [item] = await available(1);
      const plain = decryptCredentials(item!.credentials);

      const res = await post(`/api/stock/item/${item!.id}/reveal`, seed.cookie, { csrf_token: seed.csrf });
      expect(res.statusCode).toBe(200);
      const missing = await post(`/api/stock/item/999999/reveal`, seed.cookie, { csrf_token: seed.csrf });
      expect(missing.statusCode).toBe(404);

      const events = await eventsOfType(item!.id, StockEventType.CREDENTIAL_REVEALED);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorType: StockActorType.ADMIN, actorAdminId: seed.adminId });
      expect(JSON.stringify(events)).not.toContain(plain);
      expect(await prisma.auditLog.count({ where: { action: "credential_revealed", targetId: item!.id } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: "credential_revealed", targetId: 999999 } })).toBe(0);
    });

    it("reveal: a failing audit insert withholds the credential and rolls the event back", async () => {
      const [item] = await available(1);
      await failAuditInsertsFor("credential_revealed");
      try {
        const res = await post(`/api/stock/item/${item!.id}/reveal`, seed.cookie, { csrf_token: seed.csrf });
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain(decryptCredentials(item!.credentials));
      } finally {
        await restoreAuditInserts();
      }
      expect(await eventsOfType(item!.id, StockEventType.CREDENTIAL_REVEALED)).toHaveLength(0);
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
      // Credentials are encrypted at rest — the download body is the
      // decrypted plaintext, so compare against the decrypted DB value, not
      // the raw (encrypted) column.
      for (const it of avail) expect(res.body).toContain(decryptCredentials(it.credentials));

      const audit = await prisma.auditLog.findMany({ where: { action: "stock_download", targetId: seed.productId } });
      expect(audit.length).toBeGreaterThanOrEqual(1);
      expect(audit.every((a) => !(a.details ?? "").includes("@"))).toBe(true);
    });

    it("rejects a non-existent product id with 404", async () => {
      const res = await get(`/api/stock/999999/download`, seed.cookie);
      expect(res.statusCode).toBe(404);
    });

    it("rejects missing auth (anon → 401)", async () => {
      const res = await get(`/api/stock/${seed.productId}/download`, null);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
        "Denomination,Product,Category,Catalog Price (IDR),Catalog Price (USD),Available,Reserved,Sold,Restock Requests,Status",
      );
      expect(res.body).toContain(denom!.name);
    });

    it("blanks the Restock Requests cell unless the SKU is out of stock and has requests", async () => {
      const cat = await createCategory(prisma, `CsvReqCat${counter++}`);
      const parent = await createCatalogProduct(prisma, { categoryId: cat.id, name: "CsvReqProd", description: "x" });
      const mk = (name: string) =>
        createDenomination(prisma, {
          productId: parent.id,
          name,
          type: ProductType.SHARED,
          durationLabel: name,
          price: "5.00",
          description: "x",
        });
      const outWith = await mk("OutWithReq");
      const inWith = await mk("InWithReq");
      await prisma.stockItem.create({ data: { productId: inWith.id, credentials: "x@e.com:p", status: "AVAILABLE" } });
      for (const d of [outWith, inWith]) {
        const u = await prisma.user.create({
          data: { telegramId: BigInt(920_000_000 + counter++), referralCode: `csvreq${counter}` },
        });
        await prisma.restockSubscription.create({ data: { userId: u.id, productId: d.id } });
      }

      const res = await get("/api/stock/export", seed.cookie);
      const rows = res.body.split("\r\n");
      const cells = (name: string) => rows.find((r) => r.startsWith(`${name},`))!.split(",");
      // Header order: ..., Sold(7), Restock Requests(8), Status(9)
      expect(cells("OutWithReq")[8]).toBe("1");
      expect(cells("InWithReq")[8]).toBe("");
    });

    it("includes the catalog price in rupiah and dollars when a rate is set", async () => {
      await setSetting(prisma, "usd_idr_rate", "16000");
      const denom = await createDenomination(prisma, {
        productId: seed.catalogProductId,
        name: `PricedDenom${Math.random()}`,
        type: ProductType.SHARED,
        durationLabel: "1 Month",
        price: "40000",
        description: "x",
      });
      const res = await get("/api/stock/export", seed.cookie);
      expect(res.statusCode).toBe(200);
      const row = res.body.split("\r\n").find((l: string) => l.startsWith(`${denom.name},`));
      expect(row).toBeDefined();
      expect(res.body).toContain(formatIdr("40000")); // "Rp40.000"
      expect(res.body).toContain(formatUsdt(usdtFromIdr("40000", "16000"))); // "2.5 USDT"
    });

    it("rejects missing auth (anon → 401)", async () => {
      const res = await get("/api/stock/export", null);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });
  });
});

// ---- users (acceptance #5) ------------------------------------------------

describe("users", () => {
  it("GET /api/users with no query returns the recent-customers list", async () => {
    const res = await get("/api/users", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { users: Array<{ username?: string; totalOrders?: unknown }> };
    const cust = data.users.find((u) => u.username === "cust");
    expect(cust).toBeTruthy();
    expect(typeof cust!.totalOrders).toBe("number");
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
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("wallet rejects bad CSRF", async () => {
    const res = await post(`/api/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: "bad", delta: "1000" });
    expect(res.statusCode).toBe(403);
  });

  describe("CSV export", () => {
    it("returns CSV headers, Content-Disposition, and the matching row for a seeded customer", async () => {
      setBotIdentity({ publicChannelId: -100123456789 });
      const exportUser = await upsertUser(prisma, {
        telegramId: 777001,
        username: "exportcust",
        fullName: "Export Customer",
      });
      await setUserRole(prisma, exportUser.id, UserRole.RESELLER);
      await setUserBanned(prisma, exportUser.id, true, "test ban");

      const order = (await createOrderDirect(prisma, { channel: "web", user: exportUser, productId: seed.productId, quantity: 1 }))!;
      await attachPaymentProof(prisma, order.id, { fileId: "proof123", txid: "TX1234567890" });
      const approveRes = await post(`/api/orders/${order.id}/approve`, seed.cookie, { csrf_token: seed.csrf });
      expect(approveRes.statusCode).toBe(200);

      const res = await get("/api/users/export", seed.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(res.headers["content-disposition"]).toBe('attachment; filename="customers.csv"');

      const lines = res.body.trim().split("\r\n");
      expect(lines[0]).toBe(
        [
          "Telegram ID",
          "Full Name",
          "Username",
          "Role",
          "Status",
          "Joined",
          "Last Seen",
          "Total Spent (IDR)",
          "Total Spent (USDT)",
          "Orders",
          "Last Order",
        ].join(","),
      );

      const row = lines.find((l) => l.startsWith("777001,"));
      expect(row).toBeDefined();
      const cols = row!.split(",");
      expect(cols[1]).toBe("Export Customer"); // Full Name
      expect(cols[2]).toBe("exportcust"); // Username
      expect(cols[3]).toBe("RESELLER"); // Role
      expect(cols[4]).toBe("Banned"); // Status
      expect(cols[7]).not.toBe("0"); // Total Spent (IDR) — the DELIVERED order made it non-trivial
      expect(cols[9]).toBe("1"); // Orders
      expect(cols[10]).not.toBe(""); // Last Order — a raw ISO timestamp, not blank
    });

    // Finding 1 (final-review fix): a public, unauthenticated storefront
    // registrant can set fullName to anything, including a string Excel/Sheets
    // interpret as a formula on open — csvField must neutralize a leading
    // =, +, -, or @ before this row reaches an admin's spreadsheet.
    it("neutralizes a fullName starting with '=' so it can't run as a spreadsheet formula", async () => {
      await upsertUser(prisma, {
        telegramId: 777002,
        username: "injector",
        fullName: "=1+1",
      });

      const res = await get("/api/users/export", seed.cookie);
      expect(res.statusCode).toBe(200);
      const lines = res.body.trim().split("\r\n");
      const row = lines.find((l) => l.startsWith("777002,"));
      expect(row).toBeDefined();
      expect(row).not.toContain(",=1+1,");
      expect(row).toContain(",'=1+1,");
    });
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
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("delete voucher rejects bad CSRF", async () => {
    const res = await post("/api/vouchers/99999/delete", seed.cookie, { csrf_token: "bad" });
    expect(res.statusCode).toBe(403);
  });

  it("update voucher happy path (value + scope + products)", async () => {
    const category = await createCategory(prisma, "Streaming", "🎬");
    const p1 = await createCatalogProduct(prisma, { categoryId: category.id, name: "Product A" });
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "upd1", type: "percent", value: "10" });
    const v = (await getVoucherByCode(prisma, "UPD1"))!;

    const res = await postJsonOrders(`/api/vouchers/${v.id}/update`, seed.cookie, seed.csrf, {
      value: "15",
      scope: "SELECTED",
      product_ids: [p1.id],
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { voucher: { value: string; scope: string } };
    expect(Number(body.voucher.value)).toBe(15);
    expect(body.voucher.scope).toBe("SELECTED");

    const updated = await prisma.voucher.findUnique({ where: { id: v.id } });
    expect(Number(updated!.value)).toBe(15);
    const links = await prisma.voucherProduct.findMany({ where: { voucherId: v.id } });
    expect(links.map((l) => l.productId)).toEqual([p1.id]);

    const audit = await prisma.auditLog.findMany({ where: { action: "voucher_update", targetId: v.id } });
    expect(audit.length).toBe(1);
    expect(audit[0]!.details).toContain("UPD1");
  });

  it("update voucher 404s for a nonexistent id", async () => {
    const res = await postJsonOrders("/api/vouchers/999999/update", seed.cookie, seed.csrf, { value: "20" });
    expect(res.statusCode).toBe(404);
  });

  it("update voucher rejects an out-of-range PERCENT value (422, JSON error, not 500)", async () => {
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "upd5", type: "percent", value: "10" });
    const v = (await getVoucherByCode(prisma, "UPD5"))!;

    const res = await postJsonOrders(`/api/vouchers/${v.id}/update`, seed.cookie, seed.csrf, { value: "150" });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("error.invalid_discount_percent");
    expect(Number((await prisma.voucher.findUnique({ where: { id: v.id } }))!.value)).toBe(10);
  });

  it("create voucher rejects an out-of-range PERCENT value (422, JSON error, not 500)", async () => {
    const res = await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "bad150", type: "percent", value: "150" });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("error.invalid_discount_percent");
    expect(await getVoucherByCode(prisma, "BAD150")).toBeNull();
  });

  it("update voucher refuses a code change once the voucher has been used (409)", async () => {
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "upd2", type: "percent", value: "5" });
    const v = (await getVoucherByCode(prisma, "UPD2"))!;
    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 1 } });

    const res = await postJsonOrders(`/api/vouchers/${v.id}/update`, seed.cookie, seed.csrf, { code: "upd2new" });
    expect(res.statusCode).toBe(409);
    expect((await prisma.voucher.findUnique({ where: { id: v.id } }))!.code).toBe("UPD2");
  });

  it("update voucher rejects a code that collides with a different existing voucher (409, JSON error, not 500)", async () => {
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "upd4a", type: "percent", value: "5" });
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "upd4b", type: "percent", value: "5" });
    const v = (await getVoucherByCode(prisma, "UPD4B"))!;

    const res = await postJsonOrders(`/api/vouchers/${v.id}/update`, seed.cookie, seed.csrf, { code: "upd4a" });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toContain("UPD4A");
    expect((await prisma.voucher.findUnique({ where: { id: v.id } }))!.code).toBe("UPD4B");
  });

  it("update voucher allows re-submitting a voucher's own unchanged code (no false collision)", async () => {
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "upd4c", type: "percent", value: "5" });
    const v = (await getVoucherByCode(prisma, "UPD4C"))!;

    const res = await postJsonOrders(`/api/vouchers/${v.id}/update`, seed.cookie, seed.csrf, { code: "upd4c", value: "9" });
    expect(res.statusCode).toBe(200);
  });

  it("update voucher without product_ids in the body leaves an existing SELECTED voucher's products untouched", async () => {
    const category = await createCategory(prisma, "Streaming", "🎬");
    const p1 = await createCatalogProduct(prisma, { categoryId: category.id, name: "Product B" });
    await post("/api/vouchers", seed.cookie, { csrf_token: seed.csrf, code: "upd3", type: "percent", value: "10" });
    const v = (await getVoucherByCode(prisma, "UPD3"))!;
    await postJsonOrders(`/api/vouchers/${v.id}/update`, seed.cookie, seed.csrf, { scope: "SELECTED", product_ids: [p1.id] });

    const res = await postJsonOrders(`/api/vouchers/${v.id}/update`, seed.cookie, seed.csrf, { value: "20" });
    expect(res.statusCode).toBe(200);
    const links = await prisma.voucherProduct.findMany({ where: { voucherId: v.id } });
    expect(links.map((l) => l.productId)).toEqual([p1.id]);
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
      // getVoucherStats' shape (Task 2, voucher scope refactor):
      // { active, scheduled, expired, totalRedemptions } — "total" (all
      // vouchers) was dropped in favor of these more actionable buckets.
      stats: { active: number; scheduled: number; expired: number; totalRedemptions: number };
    };
    expect(data.vouchers.map((v) => v.code)).toEqual(["SEARCHABLE1"]);
    expect(data.total).toBe(1);
    expect(data.page).toBe(1);
    expect(typeof data.pageSize).toBe("number");
    expect(data.stats.active).toBeGreaterThanOrEqual(2);
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

  it("POST /api/vouchers/bulk-action requires auth (anon → 401)", async () => {
    const res = await postJsonOrders("/api/vouchers/bulk-action", null, null, {
      ids: [1],
      action: "deactivate",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
    const data = JSON.parse(res.body) as {
      ticket: {
        id: number;
        subject: string;
        waitingSince: string | null;
        isOverdue: boolean;
        firstResponseAtDisplay: string | null;
        resolvedAtDisplay: string | null;
      };
    };
    expect(data.ticket.id).toBe(tid);
    // "help me" (makeTicket's fixed message) is short enough to pass through unchanged.
    expect(data.ticket.subject).toBe("help me");
    expect(data.ticket.waitingSince).toBeTruthy();
    expect(data.ticket.isOverdue).toBe(false);
    expect(data.ticket.firstResponseAtDisplay).toBeNull();
    expect(data.ticket.resolvedAtDisplay).toBeNull();
  });

  it("ticket detail (Task 3): includes ticketNumber, assignedAtDisplay, and surfaces internal notes in the messages array", async () => {
    const tid = await makeTicket();
    // A minted ticketNumber (Task 1's createTicket) should already be present.
    let res = await get(`/api/support/${tid}`, seed.cookie);
    let data = JSON.parse(res.body) as {
      ticket: { ticketNumber: string | null; assignedAtDisplay: string | null };
      messages: { content: string; internal: boolean }[];
    };
    expect(data.ticket.ticketNumber).toMatch(/^TCK-\d{8}-\d{5}$/);
    expect(data.ticket.assignedAtDisplay).toBeNull();

    // This is the route-level proof that Task 1's includeInternal opt-in is
    // actually wired here — packages/db/src/crud/support.ts's own tests
    // cover the crud function directly, but this admin-facing route is what
    // makes an internal note reachable in the UI at all.
    await postJson(`/api/support/${tid}/reply`, seed.cookie, seed.csrf, {
      content: "Internal-only note.",
      internal: true,
    });
    res = await get(`/api/support/${tid}`, seed.cookie);
    data = JSON.parse(res.body) as typeof data;
    const note = data.messages.find((m) => m.content === "Internal-only note.");
    expect(note).toBeTruthy();
    expect(note?.internal).toBe(true);
  });

  it("ticket detail: subject is truncated to the last full word past ~60 chars, with an ellipsis", async () => {
    const longMessage =
      "This is a very long support message that definitely exceeds sixty characters in total length easily";
    const t = await createTicket(prisma, seed.customerId, longMessage);
    const res = await get(`/api/support/${t.id}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ticket: { subject: string } };
    expect(data.ticket.subject.endsWith("…")).toBe(true);
    expect(data.ticket.subject.length).toBeLessThanOrEqual(61);
    expect(longMessage.startsWith(data.ticket.subject.slice(0, -1))).toBe(true);
  });

  // Final whole-branch review finding: listTickets/getTicket used to
  // `include: { user: true, admin: true }` with no field selection, and this
  // route used to spread a raw `getUser(...)` result — both leaked every
  // User column (passwordHash, email, wallet balances, bannedReason, …) into
  // the admin's browser. Regression: assert those never appear in the list
  // or detail JSON for either the ticket owner or the assigned admin.
  it("never leaks passwordHash or email off the ticket's user/admin in the list or detail JSON", async () => {
    const buyer = await createWebUser(prisma, {
      loginUsername: "leakcheckbuyer",
      email: "buyer-secret@shop.test",
      passwordHash: "buyer-hash-should-not-leak",
      fullName: "Leak Check Buyer",
    });
    const assignee = await createWebUser(prisma, {
      loginUsername: "leakcheckadmin",
      email: "admin-secret@shop.test",
      passwordHash: "admin-hash-should-not-leak",
      fullName: "Leak Check Admin",
    });
    const ticket = await createTicket(prisma, buyer.id, "help me");
    await assignTicket(prisma, ticket.id, assignee.id);

    const listRes = await get("/api/support", seed.cookie);
    expect(listRes.statusCode).toBe(200);
    for (const needle of [
      "buyer-hash-should-not-leak",
      "admin-hash-should-not-leak",
      "buyer-secret@shop.test",
      "admin-secret@shop.test",
      "passwordHash",
      "walletBalance",
      "bannedReason",
      '"email"',
    ]) {
      expect(listRes.body, `GET /api/support body must not contain "${needle}"`).not.toContain(needle);
    }

    const detailRes = await get(`/api/support/${ticket.id}`, seed.cookie);
    expect(detailRes.statusCode).toBe(200);
    for (const needle of [
      "buyer-hash-should-not-leak",
      "admin-hash-should-not-leak",
      "buyer-secret@shop.test",
      "admin-secret@shop.test",
      "passwordHash",
      "walletBalance",
      "bannedReason",
      '"email"',
    ]) {
      expect(detailRes.body, `GET /api/support/:ticketId body must not contain "${needle}"`).not.toContain(needle);
    }
  });

  it("ticket detail requires auth (anon → 401)", async () => {
    const tid = await makeTicket();
    const res = await get(`/api/support/${tid}`, null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("reply records a message (never sent to Telegram)", async () => {
    const tid = await makeTicket();
    const res = await post(`/api/support/${tid}/reply`, seed.cookie, { csrf_token: seed.csrf, content: "Looking into it." });
    expect(res.statusCode).toBe(200);
    const msgs = await listTicketMessages(prisma, tid, 10);
    const adminMsgs = msgs.filter((m) => m.senderType === "ADMIN");
    expect(adminMsgs.some((m) => m.content === "Looking into it.")).toBe(true);
  });

  it("internal note (Task 3): stored with internal: true, excluded from the default message list, audited as ticket_internal_note (not ticket_reply), and does not flip ticket status", async () => {
    const tid = await makeTicket();
    const res = await postJson(`/api/support/${tid}/reply`, seed.cookie, seed.csrf, {
      content: "Checking with the courier before replying.",
      internal: true,
    });
    expect(res.statusCode).toBe(200);

    const customerSafeMsgs = await listTicketMessages(prisma, tid, 10);
    expect(customerSafeMsgs.some((m) => m.content === "Checking with the courier before replying.")).toBe(false);

    const allMsgs = await listTicketMessages(prisma, tid, 10, { includeInternal: true });
    const note = allMsgs.find((m) => m.content === "Checking with the courier before replying.");
    expect(note).toBeTruthy();
    expect(note?.internal).toBe(true);
    expect(note?.senderType).toBe("ADMIN");

    // Doesn't flip the ticket's customer-visible status (still OPEN, not
    // WAITING_CUSTOMER) — an internal note isn't a reply the customer sees.
    expect((await prisma.supportTicket.findUnique({ where: { id: tid } }))!.status).toBe("OPEN");

    const internalAudit = await prisma.auditLog.findFirst({
      where: { action: "ticket_internal_note", targetId: tid },
    });
    expect(internalAudit).toBeTruthy();
    expect(internalAudit?.details).toBe(`Added an internal note to ticket #${tid} (not visible to the customer).`);
    // The route must not ALSO log a "ticket_reply" row for an internal note —
    // that would double-audit the same action under a misleading sentence.
    const replyAudit = await prisma.auditLog.findFirst({ where: { action: "ticket_reply", targetId: tid } });
    expect(replyAudit).toBeNull();
  });

  it("a normal (non-internal) reply is unaffected by the internal-note field: audited as ticket_reply, visible in the default message list", async () => {
    const tid = await makeTicket();
    const res = await postJson(`/api/support/${tid}/reply`, seed.cookie, seed.csrf, {
      content: "We're checking your order.",
    });
    expect(res.statusCode).toBe(200);

    const msgs = await listTicketMessages(prisma, tid, 10);
    expect(msgs.some((m) => m.content === "We're checking your order." && m.internal === false)).toBe(true);

    const replyAudit = await prisma.auditLog.findFirst({ where: { action: "ticket_reply", targetId: tid } });
    expect(replyAudit).toBeTruthy();
    const internalAudit = await prisma.auditLog.findFirst({
      where: { action: "ticket_internal_note", targetId: tid },
    });
    expect(internalAudit).toBeNull();
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
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

    it("happy path: assigns a ticket to an admin, audits, and stamps assignedAt/assignedBy (Task 3)", async () => {
      const tid = await makeTicket();
      const second = await makeSecondAdmin();
      const res = await postJson(`/api/support/${tid}/assign`, seed.cookie, seed.csrf, { adminId: second.id });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      const row = await prisma.supportTicket.findUnique({ where: { id: tid } });
      expect(row!.adminId).toBe(second.id);
      // Task 3: this route now calls assignTicketWithAudit (packages/db/src/
      // crud/support.ts), migrated from the old un-audited assignTicket — the
      // whole point of the admin panel's new assignment picker is that these
      // two columns actually get populated, not just adminId.
      expect(row!.assignedBy).toBe(seed.adminId);
      expect(row!.assignedAt).toBeInstanceOf(Date);

      const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_assign", targetId: tid } });
      expect(audit).toBeTruthy();
      expect(audit?.targetType).toBe("ticket");
      expect(audit?.adminId).toBe(seed.adminId);
      // Task 3 review fix: assignTicketWithAudit now accepts the caller's
      // already-resolved display name, so this keeps the same friendly
      // wording the old route-local logAdminAction call used.
      expect(audit?.details).toBe(`Assigned ticket #${tid} to "Second Admin".`);
    });

    it("unassign (adminId: null) clears the assignment (incl. assignedAt/assignedBy) and audits", async () => {
      const tid = await makeTicket();
      const second = await makeSecondAdmin();
      await postJson(`/api/support/${tid}/assign`, seed.cookie, seed.csrf, { adminId: second.id });

      const res = await postJson(`/api/support/${tid}/assign`, seed.cookie, seed.csrf, { adminId: null });
      expect(res.statusCode).toBe(200);
      const row = await prisma.supportTicket.findUnique({ where: { id: tid } });
      expect(row!.adminId).toBeNull();
      expect(row!.assignedBy).toBeNull();
      expect(row!.assignedAt).toBeNull();

      const audit = await prisma.auditLog.findFirst({
        where: { action: "ticket_assign", targetId: tid },
        orderBy: { id: "desc" },
      });
      expect(audit?.details).toBe(`Assigned ticket #${tid} to nobody (unassigned).`);
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

    it("requires auth (anon → 401)", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/assign`, null, "x", { adminId: null });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/assign`, seed.cookie, "bad-token", { adminId: null });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("GET /api/support — operational queue list", () => {
    it("happy path: returns pagination/stats shape plus per-ticket subject/waitingSince/isOverdue", async () => {
      const tid = await makeTicket();
      const res = await get("/api/support", seed.cookie);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        items: Array<{ id: number; subject: string; createdAtDisplay: string | null; waitingSince: string | null; isOverdue: boolean }>;
        total: number;
        page: number;
        pageSize: number;
        stats: { open: number; waitingCustomer: number; overdue: number; unassigned: number; resolvedToday: number };
      };
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
      expect(body.stats).toMatchObject({
        open: expect.any(Number),
        waitingCustomer: expect.any(Number),
        overdue: expect.any(Number),
        unassigned: expect.any(Number),
        resolvedToday: expect.any(Number),
      });
      expect(body.stats.open).toBeGreaterThanOrEqual(1);
      const found = body.items.find((t) => t.id === tid);
      expect(found).toBeTruthy();
      expect(found!.subject).toBe("help me");
      expect(found!.waitingSince).toBeTruthy();
      expect(found!.isOverdue).toBe(false);
    });

    it("filters by status", async () => {
      const openId = await makeTicket();
      const resolvedId = await makeTicket();
      const resolveRes = await postJson(`/api/support/${resolvedId}/resolve`, seed.cookie, seed.csrf, {});
      expect(resolveRes.statusCode).toBe(200);

      const res = await get("/api/support?status=RESOLVED", seed.cookie);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { items: Array<{ id: number }>; total: number };
      expect(body.items.map((t) => t.id)).toEqual([resolvedId]);
      expect(body.items.some((t) => t.id === openId)).toBe(false);
    });

    it("requires auth (anon → 401)", async () => {
      const res = await get("/api/support", null);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });
  });

  describe("GET /api/support/export", () => {
    it("returns CSV headers, Content-Disposition, and the matching row", async () => {
      await makeTicket();
      const res = await get("/api/support/export", seed.cookie);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toBe('attachment; filename="support-tickets.csv"');
      const lines = res.body.trim().split("\r\n");
      expect(lines[0]).toBe("Ticket ID,Subject,Customer,Status,Priority,Category,Assigned To,Created At");
      expect(lines.length).toBe(2); // header + the one seeded ticket
    });

    it("respects the status filter", async () => {
      const openId = await makeTicket();
      const resolvedId = await makeTicket();
      await postJson(`/api/support/${resolvedId}/resolve`, seed.cookie, seed.csrf, {});

      const res = await get("/api/support/export?status=RESOLVED", seed.cookie);
      expect(res.statusCode).toBe(200);
      const lines = res.body.trim().split("\r\n");
      expect(lines.length - 1).toBe(1);
      expect(lines[1]).toContain(`${resolvedId},`);
      expect(lines[1]).not.toContain(`${openId},`);
    });

    it("ids restricts the export to exactly the selected rows", async () => {
      const ticketA = await makeTicket();
      await makeTicket(); // not selected, must be excluded

      const res = await get(`/api/support/export?ids=${ticketA}`, seed.cookie);
      expect(res.statusCode).toBe(200);
      const lines = res.body.trim().split("\r\n");
      expect(lines.length - 1).toBe(1);
      expect(lines[1]).toContain(`${ticketA},`);
    });

    it("requires auth (anon → 401)", async () => {
      const res = await get("/api/support/export", null);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });
  });

  describe("POST /api/support/:ticketId/resolve", () => {
    it("happy path: marks a ticket RESOLVED and audits", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/resolve`, seed.cookie, seed.csrf, {});
      expect(res.statusCode).toBe(200);
      expect((await prisma.supportTicket.findUnique({ where: { id: tid } }))!.status).toBe("RESOLVED");
      const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_resolve", targetId: tid } });
      expect(audit).toBeTruthy();
      expect(audit?.details).toBe(`Marked ticket #${tid} resolved.`);
    });

    it("422s when the ticket is already resolved", async () => {
      const tid = await makeTicket();
      await postJson(`/api/support/${tid}/resolve`, seed.cookie, seed.csrf, {});
      const res = await postJson(`/api/support/${tid}/resolve`, seed.cookie, seed.csrf, {});
      expect(res.statusCode).toBe(422);
    });

    it("404s for a non-existent ticket", async () => {
      const res = await postJson("/api/support/999999/resolve", seed.cookie, seed.csrf, {});
      expect(res.statusCode).toBe(404);
    });

    it("requires auth (anon → 401)", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/resolve`, null, "x", {});
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/resolve`, seed.cookie, "bad-token", {});
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/support/:ticketId/reopen", () => {
    it("happy path: reopens a CLOSED ticket back to OPEN and audits", async () => {
      const tid = await makeTicket();
      await postJson(`/api/support/${tid}/close`, seed.cookie, seed.csrf, {});
      const res = await postJson(`/api/support/${tid}/reopen`, seed.cookie, seed.csrf, {});
      expect(res.statusCode).toBe(200);
      expect((await prisma.supportTicket.findUnique({ where: { id: tid } }))!.status).toBe("OPEN");
      const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_reopen", targetId: tid } });
      expect(audit).toBeTruthy();
      expect(audit?.details).toBe(`Reopened ticket #${tid}.`);
    });

    it("422s when the ticket isn't closed", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/reopen`, seed.cookie, seed.csrf, {});
      expect(res.statusCode).toBe(422);
    });

    it("404s for a non-existent ticket", async () => {
      const res = await postJson("/api/support/999999/reopen", seed.cookie, seed.csrf, {});
      expect(res.statusCode).toBe(404);
    });

    it("requires auth (anon → 401)", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/reopen`, null, "x", {});
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/reopen`, seed.cookie, "bad-token", {});
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/support/:ticketId/classify", () => {
    it("happy path: sets priority and category and audits with a natural-language sentence", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/classify`, seed.cookie, seed.csrf, {
        priority: "HIGH",
        category: "PAYMENT",
      });
      expect(res.statusCode).toBe(200);
      const ticket = await prisma.supportTicket.findUnique({ where: { id: tid } });
      expect(ticket?.priority).toBe("HIGH");
      expect(ticket?.category).toBe("PAYMENT");
      const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_classify", targetId: tid } });
      expect(audit?.details).toBe("Set priority to High and category to Payment.");
    });

    it("applies only the field present in the body, leaving the other untouched", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/classify`, seed.cookie, seed.csrf, { priority: "URGENT" });
      expect(res.statusCode).toBe(200);
      const ticket = await prisma.supportTicket.findUnique({ where: { id: tid } });
      expect(ticket?.priority).toBe("URGENT");
      expect(ticket?.category).toBeNull();
      const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_classify", targetId: tid } });
      expect(audit?.details).toBe("Set priority to Urgent.");
    });

    it("rejects an invalid priority with 400", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/classify`, seed.cookie, seed.csrf, { priority: "SUPER_URGENT" });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an invalid category with 400", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/classify`, seed.cookie, seed.csrf, { category: "SPAM" });
      expect(res.statusCode).toBe(400);
    });

    it("404s for a non-existent ticket", async () => {
      const res = await postJson("/api/support/999999/classify", seed.cookie, seed.csrf, { priority: "LOW" });
      expect(res.statusCode).toBe(404);
    });

    it("requires auth (anon → 401)", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/classify`, null, "x", { priority: "LOW" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const tid = await makeTicket();
      const res = await postJson(`/api/support/${tid}/classify`, seed.cookie, "bad-token", { priority: "LOW" });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/support/bulk-action", () => {
    async function makeSecondAdmin() {
      return upsertUser(prisma, { telegramId: 1000, username: "second", fullName: "Second Admin" });
    }

    it("bulk assign: assigns every selected ticket to the given admin and audits once", async () => {
      const tid1 = await makeTicket();
      const tid2 = await makeTicket();
      const second = await makeSecondAdmin();

      const res = await postJson("/api/support/bulk-action", seed.cookie, seed.csrf, {
        ids: [tid1, tid2],
        action: "assign",
        adminId: second.id,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { succeeded: number[]; failed: { id: number; error: string }[] };
      expect(body.succeeded.slice().sort((a, b) => a - b)).toEqual([tid1, tid2].sort((a, b) => a - b));
      expect(body.failed).toEqual([]);
      expect((await prisma.supportTicket.findUnique({ where: { id: tid1 } }))!.adminId).toBe(second.id);
      expect((await prisma.supportTicket.findUnique({ where: { id: tid2 } }))!.adminId).toBe(second.id);

      // One summary audit row plus one per-ticket row for each succeeded id
      // (so a bulk-assigned ticket's own timeline isn't empty).
      const audit = await prisma.auditLog.findMany({ where: { action: "ticket_bulk_assign" } });
      expect(audit.length).toBe(3);
      const summary = audit.find((a) => a.targetId === null);
      expect(summary?.details).toBe('Assigned 2 tickets to "Second Admin".');
    });

    it("bulk assign requires adminId (400)", async () => {
      const tid = await makeTicket();
      const res = await postJson("/api/support/bulk-action", seed.cookie, seed.csrf, {
        ids: [tid],
        action: "assign",
      });
      expect(res.statusCode).toBe(400);
    });

    it("bulk resolve: resolves eligible tickets, skips an already-closed one", async () => {
      const resolvable = await makeTicket();
      const closed = await makeTicket();
      await postJson(`/api/support/${closed}/close`, seed.cookie, seed.csrf, {});

      const res = await postJson("/api/support/bulk-action", seed.cookie, seed.csrf, {
        ids: [resolvable, closed],
        action: "resolve",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { succeeded: number[]; failed: { id: number; error: string }[] };
      expect(body.succeeded).toEqual([resolvable]);
      expect(body.failed).toEqual([{ id: closed, error: "already resolved or closed" }]);
      expect((await prisma.supportTicket.findUnique({ where: { id: resolvable } }))!.status).toBe("RESOLVED");

      // One summary row plus one per-ticket row for the succeeded ticket.
      const audit = await prisma.auditLog.findMany({ where: { action: "ticket_bulk_resolve" } });
      expect(audit.length).toBe(2);
      const summary = audit.find((a) => a.targetId === null);
      expect(summary?.details).toBe("Resolved 1 ticket; skipped 1 not eligible.");
    });

    it("bulk close: closes eligible tickets", async () => {
      const tid = await makeTicket();
      const res = await postJson("/api/support/bulk-action", seed.cookie, seed.csrf, {
        ids: [tid],
        action: "close",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { succeeded: number[]; failed: { id: number; error: string }[] };
      expect(body.succeeded).toEqual([tid]);
      expect((await prisma.supportTicket.findUnique({ where: { id: tid } }))!.status).toBe("CLOSED");

      // One summary row plus one per-ticket row for the succeeded ticket.
      const audit = await prisma.auditLog.findMany({ where: { action: "ticket_bulk_close" } });
      expect(audit.length).toBe(2);
    });

    it("bulk close: a ticket owned by a telegramId-less (web-only) customer still counts as succeeded", async () => {
      // closeTicket returns null both when a ticket was already CLOSED and
      // when it DID close but the owner has no telegramId to notify — the
      // route must not conflate the two (regression for that ambiguity).
      const web = await createWebUser(prisma, {
        loginUsername: "webonlybuyer",
        email: "webonly@shop.test",
        passwordHash: "x",
        fullName: "Web Only Buyer",
      });
      const webTicket = await createTicket(prisma, web.id, "help me");
      const normal = await makeTicket();

      const res = await postJson("/api/support/bulk-action", seed.cookie, seed.csrf, {
        ids: [webTicket.id, normal],
        action: "close",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { succeeded: number[]; failed: { id: number; error: string }[] };
      expect(body.succeeded.slice().sort((a, b) => a - b)).toEqual([webTicket.id, normal].sort((a, b) => a - b));
      expect(body.failed).toEqual([]);
      expect((await prisma.supportTicket.findUnique({ where: { id: webTicket.id } }))!.status).toBe("CLOSED");

      // One summary row plus one per-ticket row for each succeeded ticket.
      const audit = await prisma.auditLog.findMany({ where: { action: "ticket_bulk_close" } });
      expect(audit.length).toBe(3);
      const summary = audit.find((a) => a.targetId === null);
      expect(summary?.details).toBe("Closed 2 tickets.");
    });

    it("an unknown ticket id lands in failed with a plain-English error, not a hard error for the whole batch", async () => {
      const res = await postJson("/api/support/bulk-action", seed.cookie, seed.csrf, {
        ids: [999999],
        action: "close",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { succeeded: number[]; failed: { id: number; error: string }[] };
      expect(body.succeeded).toEqual([]);
      expect(body.failed).toEqual([{ id: 999999, error: "ticket not found" }]);
    });

    it("caps a batch at 50 ids (400)", async () => {
      const ids = Array.from({ length: 51 }, (_, i) => i + 1);
      const res = await postJson("/api/support/bulk-action", seed.cookie, seed.csrf, { ids, action: "close" });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an unknown action (400)", async () => {
      const tid = await makeTicket();
      const res = await postJson("/api/support/bulk-action", seed.cookie, seed.csrf, { ids: [tid], action: "explode" });
      expect(res.statusCode).toBe(400);
    });

    it("requires auth (anon → 401)", async () => {
      const tid = await makeTicket();
      const res = await postJson("/api/support/bulk-action", null, "x", { ids: [tid], action: "close" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    });

    it("rejects bad CSRF with 403", async () => {
      const tid = await makeTicket();
      const res = await postJson("/api/support/bulk-action", seed.cookie, "wrong-token", { ids: [tid], action: "close" });
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

  it("password change rotates the session jti — old cookie stops authenticating, re-issued cookie keeps this device logged in", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("oldpassword"));

    // Sanity: the pre-change cookie authenticates before the password change.
    expect((await get("/api/settings", seed.cookie)).statusCode).toBe(200);

    const res = await post("/api/settings/password", seed.cookie, {
      csrf_token: seed.csrf, current_password: "oldpassword", new_password: "newpassword1", confirm_password: "newpassword1",
    });
    expect(res.statusCode).toBe(200);

    // The old cookie (minted before the change) must no longer authenticate.
    const stale = await get("/api/settings", seed.cookie);
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });

    // The response's own re-issued cookie must still authenticate this device.
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const rawHeader = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    const value = decodeURIComponent(rawHeader.split(";")[0]!.split("=").slice(1).join("="));
    const fresh = await get("/api/settings", value);
    expect(fresh.statusCode).toBe(200);
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
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
    expect(await getDecryptedSetting(prisma, "binance_api_key")).toBe("BINKEYSECRET");
    expect(await getDecryptedSetting(prisma, "binance_api_secret")).toBe("BINSECRETVALUE");

    // Task 13: the row is encrypted at rest, not stored as the plaintext.
    const rawKey = await getSetting(prisma, "binance_api_key");
    expect(rawKey).not.toBe("BINKEYSECRET");
    expect(isEncryptedCredentialEnvelope(rawKey!)).toBe(true);
    const rawSecret = await getSetting(prisma, "binance_api_secret");
    expect(rawSecret).not.toBe("BINSECRETVALUE");
    expect(isEncryptedCredentialEnvelope(rawSecret!)).toBe(true);

    // Blank submit keeps the existing value ({ ok: true, unchanged: true }).
    const blank = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "binance_api_key", value: "",
    });
    expect(blank.statusCode).toBe(200);
    expect(JSON.parse(blank.body)).toEqual({ ok: true, unchanged: true });
    expect(await getDecryptedSetting(prisma, "binance_api_key")).toBe("BINKEYSECRET");

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

  it("accepts paydisini_userkey but never echoes it back (semi-secret since backend audit Task C4)", async () => {
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "paydisini_userkey", value: "userkey123",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "paydisini_userkey")).toBe("userkey123");
    const page = await get("/api/settings", seed.cookie);
    const apiData = JSON.parse(page.body) as { fields: Array<{ key: string; value: string; secret: boolean; hasValue: boolean }> };
    const field = apiData.fields.find((f) => f.key === "paydisini_userkey")!;
    expect(field.value).toBe("");
    expect(field.secret).toBe(true);
    expect(field.hasValue).toBe(true);
    expect(page.body).not.toContain("userkey123");
  });

  it("paydisini_apikey is write-only (blank keeps value, never echoed)", async () => {
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "paydisini_apikey", value: "PDAPIKEYSECRET",
    });
    expect(await getDecryptedSetting(prisma, "paydisini_apikey")).toBe("PDAPIKEYSECRET");

    // Task 13: the row is encrypted at rest, not stored as the plaintext.
    const rawApiKey = await getSetting(prisma, "paydisini_apikey");
    expect(rawApiKey).not.toBe("PDAPIKEYSECRET");
    expect(isEncryptedCredentialEnvelope(rawApiKey!)).toBe(true);

    // Blank submit keeps the existing value ({ ok: true, unchanged: true }).
    const blank = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "paydisini_apikey", value: "",
    });
    expect(blank.statusCode).toBe(200);
    expect(JSON.parse(blank.body)).toEqual({ ok: true, unchanged: true });
    expect(await getDecryptedSetting(prisma, "paydisini_apikey")).toBe("PDAPIKEYSECRET");

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

  // The behavior change in Task 8 is server-side: settings.ts maps both Bybit
  // heartbeats through evaluatePollHealth using the rail's REAL config state.
  // The SettingsPage test stubs this endpoint's JSON, so it cannot catch a
  // regression here (a hardcoded `enabled: true`, or the two configs swapped).
  // These two cases pin the distinction the truthful `enabled` exists to make.
  it("GET /api/settings reports an unconfigured Bybit rail as unmonitored", async () => {
    const page = await get("/api/settings", seed.cookie);
    expect(page.statusCode).toBe(200);
    const data = JSON.parse(page.body) as { bybitHealth: { status: string; detail: string } };
    expect(data.bybitHealth.status).toBe("unmonitored");
  });

  it("GET /api/settings reports a configured but never-polled Bybit rail as red", async () => {
    await setSetting(prisma, BYBIT_UID_KEY, "bybit-uid");
    await setSetting(prisma, BYBIT_API_KEY_KEY, "bybit-key");
    await setSetting(prisma, BYBIT_API_SECRET_KEY, "bybit-secret");

    const page = await get("/api/settings", seed.cookie);
    expect(page.statusCode).toBe(200);
    const data = JSON.parse(page.body) as { bybitHealth: { status: string; detail: string } };
    expect(data.bybitHealth.status).toBe("red");
    // Credentials must never be echoed back in the health payload.
    expect(JSON.stringify(data.bybitHealth)).not.toContain("bybit-secret");
  });

  it("nowpayments_api_key / nowpayments_ipn_secret are write-only (blank keeps value, never echoed)", async () => {
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_api_key", value: "NOWAPIKEYSECRET",
    });
    await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_ipn_secret", value: "NOWIPNSECRETVALUE",
    });
    expect(await getDecryptedSetting(prisma, "nowpayments_api_key")).toBe("NOWAPIKEYSECRET");
    expect(await getDecryptedSetting(prisma, "nowpayments_ipn_secret")).toBe("NOWIPNSECRETVALUE");

    // Task 13: the rows are encrypted at rest, not stored as the plaintext.
    const rawApiKey = await getSetting(prisma, "nowpayments_api_key");
    expect(rawApiKey).not.toBe("NOWAPIKEYSECRET");
    expect(isEncryptedCredentialEnvelope(rawApiKey!)).toBe(true);
    const rawIpnSecret = await getSetting(prisma, "nowpayments_ipn_secret");
    expect(rawIpnSecret).not.toBe("NOWIPNSECRETVALUE");
    expect(isEncryptedCredentialEnvelope(rawIpnSecret!)).toBe(true);

    // Blank submit keeps the existing value ({ ok: true, unchanged: true }).
    const blank = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "nowpayments_api_key", value: "",
    });
    expect(blank.statusCode).toBe(200);
    expect(JSON.parse(blank.body)).toEqual({ ok: true, unchanged: true });
    expect(await getDecryptedSetting(prisma, "nowpayments_api_key")).toBe("NOWAPIKEYSECRET");

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
    expect(await getDecryptedSetting(prisma, "bscscan_api_key")).toBe("SUPERSECRETBSCSCANKEY");

    // Task 13: the row is encrypted at rest, not stored as the plaintext.
    const raw = await getSetting(prisma, "bscscan_api_key");
    expect(raw).not.toBe("SUPERSECRETBSCSCANKEY");
    expect(isEncryptedCredentialEnvelope(raw!)).toBe(true);

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

  // M12 / audit P0-2: a hand-typed rate is just as much a re-confirmation of
  // the rate's freshness as a market refresh is, so it must stamp the same key
  // — otherwise a shop running on a manually-set rate would have every USDT
  // order refused once the TTL elapsed after its last automatic refresh.
  it("a manual rate edit stamps usd_idr_rate_updated_at and still audits the change", async () => {
    await setSetting(prisma, "usd_idr_rate_updated_at", new Date(Date.now() - 86_400_000).toISOString());
    const before = Date.now();

    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "usd_idr_rate", value: "16750",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16750");

    const stamp = await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY);
    expect(Date.parse(stamp!)).toBeGreaterThanOrEqual(before - 1_000);

    // The audit trail for this field must read exactly as it did before the
    // stamping branch existed — a shop admin still sees what was changed.
    const logs = await listAuditLogs(prisma, { limit: 10 });
    const entry = logs.find((l) => l.action === "setting_set" && (l.details ?? "").includes("usd_idr_rate"));
    expect(entry).toBeTruthy();
    expect(entry!.details).toBe('Changed setting "usd_idr_rate" to "16750".');
  });

  it("clearing the rate by hand does not claim the (now absent) rate was just confirmed", async () => {
    const stale = new Date(Date.now() - 86_400_000).toISOString();
    await setSetting(prisma, "usd_idr_rate_updated_at", stale);
    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "usd_idr_rate", value: "",
    });
    expect(res.statusCode).toBe(200);
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("");
    expect(await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY)).toBe(stale);
  });

  // M13 / audit P0-3. The manual button deliberately gets NO admin DM on a
  // rejection — the admin who pressed it is reading the answer on screen, and
  // DMing every admin about a failure one of them triggered on purpose is
  // exactly how an alert channel becomes noise. What it does get: a specific,
  // actionable error naming the check that failed, and an audit entry, because
  // "I pressed update and the rate did not move" is a real support question.
  it("a rate outside the sanity band is refused with a specific reason, the old rate stands, and no admin is DMed", async () => {
    await setSetting(prisma, "usd_idr_rate", "16000");
    await setSetting(prisma, "usd_idr_rate_updated_at", new Date().toISOString());
    // The deviation cap is measured market-to-market since D10, against
    // `usd_idr_market_rate` — the last PRE-spread figure a refresh accepted — and
    // an ABSENT reference deliberately skips the cap for one refresh (the same
    // deploy grace the freshness stamp gives a missing stamp). So this test has to
    // establish a reference, or it exercises the grace path rather than the band
    // and the refresh it expects to be refused is accepted.
    await setSetting(prisma, "usd_idr_market_rate", "16000");
    setFxRateFetcher(async () => new Decimal("17500")); // +9.4%, past the 5% default

    const res = await post("/api/settings/fx/refresh", seed.cookie, { csrf_token: seed.csrf });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { status: string; error: string };
    expect(body.status).toBe("rejected");
    expect(body.error).toContain("%");
    expect(body.error).toContain("16000");
    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16000");

    expect(
      await prisma.notificationOutbox.count({ where: { event: NotificationEvent.ADMIN_FX_RATE_REJECTED } }),
    ).toBe(0);

    const logs = await listAuditLogs(prisma, { limit: 10 });
    const entry = logs.find((l) => (l.details ?? "").includes("refused as implausible"));
    expect(entry).toBeTruthy();
  });

  // Whole-branch review A4. Typing the rate in is the documented remedy for a
  // refresh the sanity band keeps refusing (the rejection DM says so), so it has
  // to end the episode: otherwise the streak counter the next DM quotes keeps
  // climbing from a run that is over, and the dedupe marker keeps suppressing a
  // genuinely new failure.
  it("typing the rate in by hand ends the refusal streak and re-arms the rejection alert", async () => {
    await setSetting(prisma, "fx_refresh_failures", "7");
    await setSetting(prisma, "fx_rejected_alerted_for", "delta_too_large");
    await setSetting(prisma, "fx_stale_alerted_for", new Date().toISOString());

    const res = await post("/api/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "usd_idr_rate", value: "16500",
    });
    expect(res.statusCode).toBe(200);

    expect(await getSetting(prisma, "usd_idr_rate")).toBe("16500");
    expect(await getSetting(prisma, "fx_refresh_failures")).toBe("0");
    expect(await getSetting(prisma, "fx_rejected_alerted_for")).toBe("");
    expect(await getSetting(prisma, "fx_stale_alerted_for")).toBe("");
  });

  // Money audit A1. The hand-typed rate used to be saved as raw text: an
  // Indonesian admin typing "16.000" (sixteen thousand) stored "16.000", which
  // every reader parses as 16 — a ~1000x USDT overcharge — and "16,000" stored
  // text no reader could parse, silently hiding the USDT rail. The field is now
  // read by its shape (IDR rules) and judged against fx_rate_min/fx_rate_max.
  describe("hand-typed rate is read by shape and judged by the sanity band", () => {
    const editRate = (value: string) =>
      post("/api/settings/edit", seed.cookie, { csrf_token: seed.csrf, key: "usd_idr_rate", value });

    it.each([
      ["16.000", "16000"],
      ["16,000", "16000"],
      ["16000", "16000"],
      ["16.250,50", "16250.5"],
    ])("%s is stored as the canonical %s", async (typed, stored) => {
      const res = await editRate(typed);
      expect(res.statusCode).toBe(200);
      expect(await getSetting(prisma, "usd_idr_rate")).toBe(stored);
    });

    it("the audit entry names the rate that was actually saved", async () => {
      const res = await editRate("16.000");
      expect(res.statusCode).toBe(200);
      const logs = await listAuditLogs(prisma, { limit: 10 });
      const entry = logs.find((l) => l.action === "setting_set" && (l.details ?? "").includes("usd_idr_rate"));
      expect(entry!.details).toBe('Changed setting "usd_idr_rate" to "16000".');
    });

    it.each(["abc", "-5", "0", "1.2.3", "16 000", "Rp16000"])(
      "%s is refused with 400 and the saved rate stands",
      async (typed) => {
        await setSetting(prisma, "usd_idr_rate", "16200");
        const res = await editRate(typed);
        expect(res.statusCode).toBe(400);
        expect((JSON.parse(res.body) as { error: string }).error).toMatch(/rate/i);
        expect(await getSetting(prisma, "usd_idr_rate")).toBe("16200");
      },
    );

    it("a rate below fx_rate_min is refused, naming the floor", async () => {
      await setSetting(prisma, "usd_idr_rate", "16200");
      await setSetting(prisma, "fx_rate_min", "9000");
      const res = await editRate("8.500");
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { error: string }).error).toContain("9000");
      expect(await getSetting(prisma, "usd_idr_rate")).toBe("16200");
    });

    it("the default floor applies when fx_rate_min was never set: 16 is refused", async () => {
      const res = await editRate("16");
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { error: string }).error).toContain("8000");
    });

    it("a rate above fx_rate_max is refused, naming the ceiling", async () => {
      await setSetting(prisma, "usd_idr_rate", "16200");
      await setSetting(prisma, "fx_rate_max", "30000");
      const res = await editRate("31.000");
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { error: string }).error).toContain("30000");
      expect(await getSetting(prisma, "usd_idr_rate")).toBe("16200");
    });

    it("the deviation cap does not apply to a typed rate (typing it is the remedy for a refused refresh)", async () => {
      await setSetting(prisma, "usd_idr_rate", "16000");
      await setSetting(prisma, "usd_idr_market_rate", "16000");
      const res = await editRate("17.500"); // +9.4%, past the 5% default cap
      expect(res.statusCode).toBe(200);
      expect(await getSetting(prisma, "usd_idr_rate")).toBe("17500");
    });

    it("an empty value still clears the rate", async () => {
      await setSetting(prisma, "usd_idr_rate", "16200");
      const res = await editRate("");
      expect(res.statusCode).toBe(200);
      expect(await getSetting(prisma, "usd_idr_rate")).toBe("");
    });
  });

  it("the sanity-band fields are editable from the settings page", async () => {
    for (const [key, value] of [
      ["fx_rate_min", "9000"],
      ["fx_rate_max", "30000"],
      ["fx_rate_max_delta_pct", "8"],
      ["fx_rate_max_age_hours", "24"],
      ["usdt_spread_bps", "150"],
    ] as const) {
      const res = await post("/api/settings/edit", seed.cookie, { csrf_token: seed.csrf, key, value });
      expect(res.statusCode, `${key} should be editable`).toBe(200);
      expect(await getSetting(prisma, key)).toBe(value);
    }
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
    const order = (await createOrderDirect(prisma, { channel: "web", user, productId: seed.productId, quantity: 1 }))!;
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

  it("cancel underpaid → CANCELLED + audit", async () => {
    const id = await makeUnderpaidOrder();
    const orderCode = (await getOrder(prisma, id))!.orderCode;
    const res = await post(`/api/payments/order/${id}/cancel`, seed.cookie, { csrf_token: seed.csrf });
    expect(res.statusCode).toBe(200);
    expect((await getOrder(prisma, id))!.status).toBe("CANCELLED");
    const audit = await prisma.auditLog.findFirst({ where: { action: "underpaid_cancel", targetId: id } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain(orderCode);
  });

  it("manual match unmatched tx → delivered + ledger updated", async () => {
    // The testimonial channel post (ORDER_DELIVERED) only gets enqueued when
    // a public channel is configured.
    setBotIdentity({ publicChannelId: -100123456789 });
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { channel: "web", user, productId: seed.productId, quantity: 1 }))!;
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
    // A Binance transfer is USDT, so only a USDT order can take it.
    const order = (await prisma.$transaction((tx) =>
      createInternalOrder(tx, { channel: "web", user, productId: seed.productId, quantity: 1, rate: 1 }),
    ))!;
    const before = Number((await getUser(prisma, seed.customerId))!.walletBalanceUsdt);
    await recordUnmatchedTx(prisma, { binanceTxId: "CRTX1", amount: "5.00" });

    const res = await post("/api/payments/credit", seed.cookie, {
      csrf_token: seed.csrf,
      binance_tx_id: "CRTX1",
      order_code: order.orderCode,
    });
    expect(res.statusCode).toBe(200);

    expect((await getOrder(prisma, order.id))!.status).toBe("CANCELLED");
    const after = Number((await getUser(prisma, seed.customerId))!.walletBalanceUsdt);
    expect(after - before).toBeCloseTo(5);

    const tx = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "CRTX1" } });
    expect(tx!.outcome).toBe("credited_to_balance");
    expect(tx!.orderId).toBe(order.id);

    const logs = await listAuditLogs(prisma, { limit: 5 });
    expect(logs.some((l) => l.action === "tx_credit_balance")).toBe(true);
  });

  // Final-review I1: a transfer that already paid for another order is not
  // evidence for this one — the route must refuse, not silently re-link it.
  it("credit refuses a transfer already matched to another order (422 error.transfer_already_used)", async () => {
    const user = (await getUser(prisma, seed.customerId))!;
    const mk = () =>
      prisma.$transaction((tx) => createInternalOrder(tx, { channel: "web", user, productId: seed.productId, quantity: 1, rate: 1 }));
    const owner = (await mk())!;
    const target = (await mk())!;
    await prisma.processedBinanceTx.create({
      data: { binanceTxId: "CRTX-USED", orderId: owner.id, amount: "5.00", outcome: "matched" },
    });
    const before = Number((await getUser(prisma, seed.customerId))!.walletBalanceUsdt);

    const res = await post("/api/payments/credit", seed.cookie, {
      csrf_token: seed.csrf,
      binance_tx_id: "CRTX-USED",
      order_code: target.orderCode,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("error.transfer_already_used");
    expect(Number((await getUser(prisma, seed.customerId))!.walletBalanceUsdt)).toBeCloseTo(before);
    const row = await prisma.processedBinanceTx.findUniqueOrThrow({ where: { binanceTxId: "CRTX-USED" } });
    expect(row.orderId).toBe(owner.id);
    expect(row.outcome).toBe("matched");
  });

  it("credit requires auth (anon → 401)", async () => {
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { channel: "web", user, productId: seed.productId, quantity: 1 }))!;
    await recordUnmatchedTx(prisma, { binanceTxId: "CRTX2", amount: "5.00" });
    const res = await post("/api/payments/credit", null, {
      csrf_token: "x",
      binance_tx_id: "CRTX2",
      order_code: order.orderCode,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
    expect((await getOrder(prisma, order.id))!.status).toBe("PENDING_PAYMENT");
  });

  it("credit rejects bad CSRF (403)", async () => {
    const user = (await getUser(prisma, seed.customerId))!;
    const order = (await createOrderDirect(prisma, { channel: "web", user, productId: seed.productId, quantity: 1 }))!;
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
    const data = JSON.parse(res.body) as { ledger: Array<{ reference: string }> };
    expect(data.ledger.some((tx) => tx.reference === "RENDTX")).toBe(true);
  });

  // Route-level counterpart to dashboard-api.test.ts's staleness case. The
  // PaymentsPage pill now renders whatever `health.status`/`health.detail` the
  // server sends, so the client test can only prove the client renders what it
  // is given — the wiring from the stored heartbeat through evaluatePollHealth
  // into the response is pinned here or nowhere.
  //
  // lastRun is two hours old and consecutiveFailures is 0, which is exactly the
  // shape the deleted client-side rule mis-read as "Synced 2h ago" at level ok.
  it("GET /api/payments reports a poller whose last cycle is two hours old as red", async () => {
    await setSetting(prisma, BINANCE_UID_KEY, "test-uid");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "test-key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "test-secret");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await setSetting(
      prisma,
      BINANCE_POLL_HEALTH_KEY,
      JSON.stringify({ lastRun: twoHoursAgo, consecutiveFailures: 0 }),
    );

    const res = await get("/api/payments", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { health: { status: string; detail: string } };
    expect(data.health.status).toBe("red");
    expect(data.health.detail).toMatch(/No cycle has completed/);
  });

  it("GET /api/payments returns todayCount and honors the q search param", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "SEARCHABLE-1", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "OTHER-2", amount: "1.00" });

    const res = await get("/api/payments", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { todayCount: number };
    expect(data.todayCount).toBeGreaterThanOrEqual(2);

    const filtered = await get("/api/payments?q=SEARCHABLE", seed.cookie);
    const filteredData = JSON.parse(filtered.body) as { ledger: Array<{ reference: string }> };
    expect(filteredData.ledger.map((tx) => tx.reference)).toEqual(["SEARCHABLE-1"]);
  });

  // Task 47 (backend audit follow-up): the ledger used to come exclusively
  // from listProcessedBinanceTx, so a delivery_failed row on any other
  // gateway was structurally invisible on this page even though the
  // Operation Center's "Failed Deliveries" card links straight to
  // /payments?outcome=delivery_failed. Pre-fix, this test's TokoPay row
  // would be silently missing from `ledger`.
  it("GET /api/payments?outcome=delivery_failed returns rows from every gateway, not just Binance", async () => {
    await prisma.processedBinanceTx.create({ data: { binanceTxId: "BN-FAIL-1", amount: "1.00", outcome: "delivery_failed" } });
    await prisma.processedTokopayTx.create({ data: { trxId: "TP-FAIL-1", amount: "50000", outcome: "delivery_failed" } });
    // A matched TokoPay row (wrong outcome) must NOT show up under the filter.
    await prisma.processedTokopayTx.create({ data: { trxId: "TP-OK-1", amount: "50000", outcome: "matched" } });

    const res = await get("/api/payments?outcome=delivery_failed", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ledger: Array<{ reference: string; gateway: string; outcome: string }>; total: number };

    const references = data.ledger.map((tx) => tx.reference);
    expect(references).toContain("BN-FAIL-1");
    expect(references).toContain("TP-FAIL-1");
    expect(references).not.toContain("TP-OK-1");

    const tokopayRow = data.ledger.find((tx) => tx.reference === "TP-FAIL-1");
    expect(tokopayRow?.gateway).toBe("tokopay");
    const binanceRow = data.ledger.find((tx) => tx.reference === "BN-FAIL-1");
    expect(binanceRow?.gateway).toBe("binance");
  });

  // T2c: the tiles used to read only the Binance ledger while the ledger table
  // below them spans every gateway, so "Failed 0" could sit above failed
  // TokoPay rows. Deltas against a baseline read, because this file's DB is
  // shared by every test in it.
  it("GET /api/payments tiles count today's rows, unmatched rows and failed rows across every gateway", async () => {
    const tiles = async () => {
      const res = await get("/api/payments", seed.cookie);
      expect(res.statusCode).toBe(200);
      const d = JSON.parse(res.body) as { todayCount: number; counts: Record<string, number> };
      return { today: d.todayCount, unmatched: d.counts["unmatched"] ?? 0, failed: d.counts["delivery_failed"] ?? 0 };
    };
    const before = await tiles();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000);

    await prisma.processedBinanceTx.create({ data: { binanceTxId: "T2C-BN-OK", amount: "1.00", outcome: "matched" } });
    await prisma.processedBybitTx.create({ data: { bybitTxId: "T2C-BY-UN", amount: "1.00", outcome: "unmatched" } });
    await prisma.processedTokopayTx.create({ data: { trxId: "T2C-TP-FAIL", amount: "50000", outcome: "delivery_failed" } });
    await prisma.processedPaydisiniTx.create({ data: { trxId: "T2C-PD-FAIL", amount: "50000", outcome: "delivery_failed" } });
    await prisma.processedNowpaymentsTx.create({ data: { trxId: "T2C-NP-UN", amount: "5", outcome: "unmatched" } });
    // Recorded on an earlier day: still counts as unmatched/failed (an open
    // queue has no expiry) but is not one of today's transactions.
    await prisma.processedTokopayTx.create({ data: { trxId: "T2C-TP-OLD-FAIL", amount: "50000", outcome: "delivery_failed", createdAt: threeDaysAgo } });

    const after = await tiles();
    expect(after.today - before.today).toBe(5);
    expect(after.unmatched - before.unmatched).toBe(2);
    expect(after.failed - before.failed).toBe(3);
  });

  // T2c: the "Underpaid Orders" badge was `underpaid.length` of a list capped
  // at 50, so it disagreed with the dashboard's countUnderpaid above 50.
  it("GET /api/payments reports the true underpaid count next to the capped list", async () => {
    const user = (await getUser(prisma, seed.customerId))!;
    const now = Date.now();
    await prisma.order.createMany({
      data: Array.from({ length: 52 }, (_, i) => ({
        orderCode: `ORD-T2C-UP-${i}`,
        userId: user.id,
        subtotalAmount: "10000",
        totalAmount: "10000",
        currency: "IDR",
        status: "UNDERPAID",
        createdAt: new Date(now - i * 1000),
      })),
    });

    const res = await get("/api/payments", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { underpaid: unknown[]; underpaidCount: number };
    expect(data.underpaid).toHaveLength(50);
    expect(data.underpaidCount).toBe(await countUnderpaid(prisma));
    expect(data.underpaidCount).toBeGreaterThanOrEqual(52);
  });

  // T5: wallet top-ups already wrote ledger rows here, but the rows carried
  // only a numeric orderId — nothing told the shop owner that a given payment
  // was a wallet top-up rather than a product sale.
  it("GET /api/payments tags each ledger row with its order code and kind", async () => {
    const sale = await prisma.order.create({
      data: { orderCode: "ORD-KIND-SALE", userId: seed.customerId, subtotalAmount: "1", totalAmount: "50000", status: "DELIVERED", kind: "PRODUCT" },
    });
    const topup = await prisma.order.create({
      data: { orderCode: "ORD-KIND-TOPUP", userId: seed.customerId, subtotalAmount: "1", totalAmount: "100000", status: "DELIVERED", kind: "WALLET_TOPUP" },
    });
    await prisma.processedTokopayTx.create({ data: { trxId: "TP-KIND-SALE", amount: "50000", outcome: "matched", orderId: sale.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "TP-KIND-TOPUP", amount: "100000", outcome: "matched", orderId: topup.id } });

    const res = await get("/api/payments", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ledger: Array<{ reference: string; orderCode: string | null; orderKind: string | null }> };
    expect(data.ledger.find((tx) => tx.reference === "TP-KIND-SALE")).toMatchObject({ orderCode: "ORD-KIND-SALE", orderKind: "PRODUCT" });
    expect(data.ledger.find((tx) => tx.reference === "TP-KIND-TOPUP")).toMatchObject({ orderCode: "ORD-KIND-TOPUP", orderKind: "WALLET_TOPUP" });
  });

  it("GET /api/payments carries each ledger row's order status, null when the row has no order", async () => {
    const cancelled = await prisma.order.create({
      data: { orderCode: "ORD-STATUS-CXL", userId: seed.customerId, subtotalAmount: "1", totalAmount: "1", status: "CANCELLED" },
    });
    await prisma.processedTokopayTx.create({ data: { trxId: "TP-STATUS-CXL", amount: "1", outcome: "delivery_failed", orderId: cancelled.id } });
    await prisma.processedTokopayTx.create({ data: { trxId: "TP-STATUS-NONE", amount: "1", outcome: "unmatched" } });

    const res = await get("/api/payments", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ledger: Array<{ reference: string; orderId: number | null; orderStatus: string | null }> };
    expect(data.ledger.find((tx) => tx.reference === "TP-STATUS-CXL")).toMatchObject({ orderId: cancelled.id, orderStatus: "CANCELLED" });
    expect(data.ledger.find((tx) => tx.reference === "TP-STATUS-NONE")).toMatchObject({ orderId: null, orderStatus: null });
  });

  it("GET /api/payments?kind=WALLET_TOPUP narrows the ledger to top-ups and reports a matching total", async () => {
    const topup = await prisma.order.create({
      data: { orderCode: "ORD-FILT-TOPUP", userId: seed.customerId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", kind: "WALLET_TOPUP" },
    });
    const sale = await prisma.order.create({
      data: { orderCode: "ORD-FILT-SALE", userId: seed.customerId, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", kind: "PRODUCT" },
    });
    await prisma.processedPaydisiniTx.create({ data: { trxId: "PD-FILT-TOPUP", amount: "1", outcome: "matched", orderId: topup.id } });
    await prisma.processedPaydisiniTx.create({ data: { trxId: "PD-FILT-SALE", amount: "1", outcome: "matched", orderId: sale.id } });

    const res = await get("/api/payments?kind=WALLET_TOPUP", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ledger: Array<{ reference: string; orderKind: string | null }>; total: number };
    expect(data.ledger.map((tx) => tx.reference)).toContain("PD-FILT-TOPUP");
    expect(data.ledger.map((tx) => tx.reference)).not.toContain("PD-FILT-SALE");
    expect(data.ledger.every((tx) => tx.orderKind === "WALLET_TOPUP")).toBe(true);
    // `total` has to follow the filter, not the table. Comparing it to
    // `ledger.length` proves nothing here — every row this test writes fits on
    // one page, so the two agree even if the filter were ignored entirely.
    // The same request without `kind` must therefore see strictly more rows
    // (the sale row above guarantees at least one). The stronger guard, that
    // `total` still agrees with the rows once they span several pages, lives
    // with the query itself in packages/db/src/crud/reports.test.ts.
    const unfiltered = JSON.parse((await get("/api/payments", seed.cookie)).body) as { total: number };
    expect(data.total).toBeLessThan(unfiltered.total);
  });

  it("GET /api/payments ignores an unknown kind value rather than returning an empty ledger", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "KIND-BOGUS-1", amount: "1.00" });
    const res = await get("/api/payments?kind=NOT_A_KIND", seed.cookie);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { ledger: Array<{ reference: string }> };
    expect(data.ledger.map((tx) => tx.reference)).toContain("KIND-BOGUS-1");
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

  it("dismiss requires auth (anon → 401)", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "DTX4", amount: "1.00" });
    const res = await post("/api/payments/dismiss", null, { csrf_token: "x", binance_tx_id: "DTX4" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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

  it("dismiss trips 429 after PAYMENTS_MUTATION_RATE_LIMIT_MAX calls in one window and recovers after a reset", async () => {
    for (let i = 0; i < PAYMENTS_MUTATION_RATE_LIMIT_MAX; i++) {
      await recordUnmatchedTx(prisma, { binanceTxId: `RLTX${i}`, amount: "1.00" });
      const res = await post("/api/payments/dismiss", seed.cookie, { csrf_token: seed.csrf, binance_tx_id: `RLTX${i}` });
      expect(res.statusCode).toBe(200);
    }
    // The (max+1)th call in the same window is rejected before it ever
    // touches the ledger row — dismissUnmatchedTx never runs.
    await recordUnmatchedTx(prisma, { binanceTxId: "RLTX-OVER", amount: "1.00" });
    const limited = await post("/api/payments/dismiss", seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "RLTX-OVER" });
    expect(limited.statusCode).toBe(429);
    expect(JSON.parse(limited.body)).toEqual({ error: "error.rate_limited" });
    expect((await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "RLTX-OVER" } }))!.outcome).toBe("unmatched");

    resetPaymentsMutationRateLimit(seed.adminId);
    const recovered = await post("/api/payments/dismiss", seed.cookie, { csrf_token: seed.csrf, binance_tx_id: "RLTX-OVER" });
    expect(recovered.statusCode).toBe(200);
  });
});

// ---- H-4 (backend audit 2026-07-31): the Users/Orders/Payments JSON APIs
// used to spread whole Prisma User rows (`...u`, `...user`, an order's
// `user: true` include) straight into the response body — reachable by the
// lowest-privilege `readonly` admin role. getUser/listUsers and
// fullInclude/listOrders now project a fixed field set that never includes
// passwordHash or email, so these prove the leak is actually closed rather
// than just "the endpoint still works." Distinctive passwordHash AND email
// values make a false negative (e.g. either landing under some other key)
// visible too, not just a key-name check — every assertion pair below covers
// both leaked-value classes, not just passwordHash.
describe("H-4 — passwordHash never leaks into admin JSON responses", () => {
  const LEAK_HASH = "hash-must-never-leave-the-server-h4";
  const LEAK_EMAIL = "h4-leak-check@shop.test";

  function expectNoLeak(res: { body: string }) {
    const parsed = JSON.parse(res.body);
    expect(res.body).not.toContain(LEAK_HASH);
    expect(containsKeyDeep(parsed, "passwordHash")).toBe(false);
    expect(res.body).not.toContain(LEAK_EMAIL);
    expect(containsKeyDeep(parsed, "email")).toBe(false);
  }

  async function makeWebBuyer(loginUsername: string) {
    return createWebUser(prisma, {
      loginUsername,
      email: LEAK_EMAIL,
      passwordHash: LEAK_HASH,
      fullName: "H4 Leak Check",
    });
  }

  it("GET /api/users never exposes passwordHash or email", async () => {
    await makeWebBuyer("h4users1");
    const res = await get("/api/users", seed.cookie);
    expect(res.statusCode).toBe(200);
    expectNoLeak(res);
  });

  it("GET /api/users/:userId never exposes passwordHash or email", async () => {
    const web = await makeWebBuyer("h4users2");
    const res = await get(`/api/users/${web.id}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    expectNoLeak(res);
  });

  it("GET /api/users/:userId sends real totals (T3) alongside the capped Orders/Tickets/Wallet Ledger lists", async () => {
    const web = await makeWebBuyer("h4users3");
    await createOrderDirect(prisma, { channel: "web", user: web, productId: seed.productId, quantity: 1 });
    await createTicket(prisma, web.id, "first ticket");
    await createTicket(prisma, web.id, "second ticket");
    await post(`/api/users/${web.id}/wallet`, seed.cookie, { csrf_token: seed.csrf, delta: "5.00", note: "one" });
    await post(`/api/users/${web.id}/wallet`, seed.cookie, { csrf_token: seed.csrf, delta: "2.00", note: "two" });

    const res = await get(`/api/users/${web.id}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      orders: unknown[];
      ordersTotal: number;
      tickets: unknown[];
      ticketsTotal: number;
      ledger: unknown[];
      ledgerTotal: number;
    };
    expect(body.ordersTotal).toBe(1);
    expect(body.orders.length).toBe(1);
    expect(body.ticketsTotal).toBe(2);
    expect(body.tickets.length).toBe(2);
    expect(body.ledgerTotal).toBe(2);
    expect(body.ledger.length).toBe(2);
  });

  // Task 6: read-only display-currency badge on the user-detail page — the
  // detail endpoint must surface the same preferredCurrency column the list
  // endpoint does, for all three states (USD, IDR, unset).
  it("GET /api/users/:userId includes preferredCurrency (USD, IDR, or null when unset)", async () => {
    const web = await makeWebBuyer("h4users4");
    await setUserPreferredCurrency(prisma, web.id, "USD");

    const usd = await get(`/api/users/${web.id}`, seed.cookie);
    expect(usd.statusCode).toBe(200);
    expect((usd.json() as { user: { preferredCurrency: string | null } }).user.preferredCurrency).toBe("USD");

    await setUserPreferredCurrency(prisma, web.id, "IDR");
    const idr = await get(`/api/users/${web.id}`, seed.cookie);
    expect((idr.json() as { user: { preferredCurrency: string | null } }).user.preferredCurrency).toBe("IDR");

    const unsetRes = await get(`/api/users/${seed.customerId}`, seed.cookie);
    expect((unsetRes.json() as { user: { preferredCurrency: string | null } }).user.preferredCurrency).toBeNull();
  });

  it("GET /api/orders never exposes the buyer's passwordHash or email", async () => {
    const web = await makeWebBuyer("h4orders1");
    await createOrderDirect(prisma, { channel: "web", user: web, productId: seed.productId, quantity: 1 });
    const res = await get("/api/orders", seed.cookie);
    expect(res.statusCode).toBe(200);
    expectNoLeak(res);
  });

  it("GET /api/orders/:orderId never exposes the buyer's passwordHash or email", async () => {
    const web = await makeWebBuyer("h4orders2");
    const order = (await createOrderDirect(prisma, { channel: "web", user: web, productId: seed.productId, quantity: 1 }))!;
    const res = await get(`/api/orders/${order.id}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    expectNoLeak(res);
  });

  it("GET /api/payments never exposes an underpaid buyer's passwordHash or email", async () => {
    const web = await makeWebBuyer("h4pay1");
    const order = (await createOrderDirect(prisma, { channel: "web", user: web, productId: seed.productId, quantity: 1 }))!;
    await markUnderpaid(prisma, { orderId: order.id, binanceTxId: `H4TX-${order.id}`, amount: "1.00" });
    const res = await get("/api/payments", seed.cookie);
    expect(res.statusCode).toBe(200);
    expectNoLeak(res);
  });

  // Covers payments.ts's OTHER raw order list — pendingInternal, sourced from
  // binance_internal.ts's listPendingInternalOrders, not listOrders — so this
  // exercises a different crud query than the "underpaid" test above.
  it("GET /api/payments never exposes a pending-internal-transfer buyer's passwordHash or email", async () => {
    const web = await makeWebBuyer("h4pay2");
    const order = (await createOrderDirect(prisma, { channel: "web", user: web, productId: seed.productId, quantity: 1 }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.PENDING_PAYMENT,
        paymentMethod: PaymentMethod.BINANCE_INTERNAL,
        paymentRef: `H4REF-${order.id}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const res = await get("/api/payments", seed.cookie);
    expect(res.statusCode).toBe(200);
    expectNoLeak(res);
  });

  // Follow-up leaks flagged (but not actioned) by Task 6's own report: the
  // Reviews moderation list spreads `listReviews`'s joined `user` straight
  // into JSON (reviews.ts:23), and global search returns raw `searchUsers`
  // rows with no projection at all (search.ts:32) — both reachable by the
  // lowest-privilege `readonly` admin role, same as the leaks above.
  it("GET /api/reviews never exposes the reviewer's passwordHash or email", async () => {
    const web = await makeWebBuyer("h4reviews1");
    const order = (await createOrderDirect(prisma, { channel: "web", user: web, productId: seed.productId, quantity: 1 }))!;
    await prisma.review.create({
      data: { userId: web.id, orderId: order.id, productId: seed.productId, rating: 5, comment: "great" },
    });
    const res = await get("/api/reviews", seed.cookie);
    expect(res.statusCode).toBe(200);
    expectNoLeak(res);
  });

  // Search intentionally keeps `email` (SearchModal.tsx's userLabel() uses it
  // as an identity fallback for storefront-only customers with no display
  // name) — so this checks passwordHash absence specifically, and proves the
  // email assertion below isn't vacuous by confirming the email IS present.
  it("GET /api/search never exposes a user hit's passwordHash, but keeps email as an identity fallback", async () => {
    await makeWebBuyer("h4search1");
    const res = await get(`/api/search?q=${encodeURIComponent("h4search1")}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { users: Array<{ email: string | null }> };
    expect(res.body).not.toContain(LEAK_HASH);
    expect(containsKeyDeep(parsed, "passwordHash")).toBe(false);
    expect(res.body).toContain(LEAK_EMAIL);
    expect(parsed.users.some((u) => u.email === LEAK_EMAIL)).toBe(true);
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
    expect(audit[0]!.details).toContain("ORDER_DELIVERED");
  });

  it("retry requires auth", async () => {
    const id = await makeFailedNotif();
    const res = await post(`/api/outbox/${id}/retry`, null, { csrf_token: "x" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
    const adjustment = await post(`/api/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: seed.csrf, delta: "7", note: "promo credit" });
    expect(adjustment.statusCode, adjustment.body).toBe(200);
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
    const order = (await createOrderDirect(prisma, { channel: "web", user, productId: seed.productId, quantity: 1 }))!;
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
    const product = await prisma.denomination.findUnique({ where: { id: seed.productId } });
    expect(audit[0]!.details).toContain(product!.name);
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
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
  it("stock API surfaces the waiting count for actionable subscribers only", async () => {
    const webOnly = await prisma.user.create({ data: { telegramId: null, referralCode: `wo${counter++}` } });
    await prisma.restockSubscription.create({ data: { userId: webOnly.id, productId: seed.productId } });
    const before = (JSON.parse((await get(`/api/stock/${seed.productId}`, seed.cookie)).body) as { waiting: number }).waiting;

    const linked = await prisma.user.create({
      data: { telegramId: BigInt(910_000_000 + counter++), referralCode: `ln${counter}` },
    });
    await prisma.restockSubscription.create({ data: { userId: linked.id, productId: seed.productId } });

    const list = await get("/api/stock", seed.cookie);
    expect(list.statusCode).toBe(200);
    expect((JSON.parse(list.body) as { waiting: Record<string, number> }).waiting[seed.productId]).toBe(before + 1);
    const detail = await get(`/api/stock/${seed.productId}`, seed.cookie);
    expect(detail.statusCode).toBe(200);
    expect((JSON.parse(detail.body) as { waiting: number }).waiting).toBe(before + 1);
  });
});

// ---- shared low-stock threshold (T3) --------------------------------------

describe("shared low-stock threshold", () => {
  it("GET /api/stock sends the shared config threshold for the client to use", async () => {
    const res = await get("/api/stock", seed.cookie);
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { lowStockThreshold: number }).lowStockThreshold).toBe(
      config.LOW_STOCK_THRESHOLD,
    );
  });

  it("GET /api/stock/export's Status column is Low Stock at exactly the threshold (<=, not <5)", async () => {
    // Deliberate behavior change from the old hard-coded `<5`: with the
    // shared config default of 3, a denomination sitting at exactly 3
    // available is Low Stock (3 <= 3), and one at 4 is already back to In
    // Stock (4 > 3) — neither would have been true under the old `<5` rule.
    const cat = await createCategory(prisma, `ThresholdCat${counter++}`);
    const parent = await createCatalogProduct(prisma, { categoryId: cat.id, name: "ThresholdProd", description: "x" });
    const atThreshold = await createDenomination(prisma, {
      productId: parent.id,
      name: "AtThreshold",
      type: ProductType.SHARED,
      durationLabel: "AtThreshold",
      price: "5.00",
      description: "x",
    });
    const aboveThreshold = await createDenomination(prisma, {
      productId: parent.id,
      name: "AboveThreshold",
      type: ProductType.SHARED,
      durationLabel: "AboveThreshold",
      price: "5.00",
      description: "x",
    });
    expect(config.LOW_STOCK_THRESHOLD).toBe(3);
    for (let i = 0; i < config.LOW_STOCK_THRESHOLD; i++) {
      await prisma.stockItem.create({ data: { productId: atThreshold.id, credentials: `at-${i}@e.com:p`, status: "AVAILABLE" } });
    }
    for (let i = 0; i < config.LOW_STOCK_THRESHOLD + 1; i++) {
      await prisma.stockItem.create({ data: { productId: aboveThreshold.id, credentials: `above-${i}@e.com:p`, status: "AVAILABLE" } });
    }

    const res = await get("/api/stock/export", seed.cookie);
    const rows = res.body.split("\r\n");
    const statusOf = (name: string) => rows.find((r) => r.startsWith(`${name},`))!.split(",").pop();
    expect(statusOf("AtThreshold")).toBe("Low Stock");
    expect(statusOf("AboveThreshold")).toBe("In Stock");
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

  it("numeric order id or leading '#' returns exact order id via the API", async () => {
    const orderId = await makePendingOrder();
    const order = (await getOrder(prisma, orderId))!;

    const resById = await get(`/api/search?q=${orderId}`, seed.cookie);
    expect(resById.statusCode).toBe(200);
    expect((JSON.parse(resById.body) as { exactOrderId: number }).exactOrderId).toBe(orderId);

    const resByHashId = await get(`/api/search?q=%23${orderId}`, seed.cookie);
    expect(resByHashId.statusCode).toBe(200);
    expect((JSON.parse(resByHashId.body) as { exactOrderId: number }).exactOrderId).toBe(orderId);

    const resByHashCode = await get(`/api/search?q=%23${encodeURIComponent(order.orderCode)}`, seed.cookie);
    expect(resByHashCode.statusCode).toBe(200);
    expect((JSON.parse(resByHashCode.body) as { exactOrderId: number }).exactOrderId).toBe(orderId);
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
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
      `${cat.name} | Imported Product B | 12 Months | private | 12 Months | 79 | 15 | 60 | 30 | nice`; // reseller (60) at or below the price (79)
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
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
    expect(canMutate("support", "/api/admin-tasks/1/assign")).toBe(true);
    expect(canMutate("readonly", "/api/admin-tasks/1/assign")).toBe(false);
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

  it("support is blocked from the new category/product-move endpoints (403), like their neighbours", async () => {
    await setRole(ADMIN_TG, "support");
    const jsonPost = (url: string, body: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json", "x-csrf-token": seed.csrf },
        cookies: { [COOKIE]: seed.cookie },
        payload: JSON.stringify(body),
      });
    const jsonPatch = (url: string, body: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url,
        headers: { "content-type": "application/json", "x-csrf-token": seed.csrf },
        cookies: { [COOKIE]: seed.cookie },
        payload: JSON.stringify(body),
      });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/catalog/categories/${seed.categoryId}`,
      headers: { "x-csrf-token": seed.csrf },
      cookies: { [COOKIE]: seed.cookie },
    });
    expect(del.statusCode).toBe(403);

    const reorder = await jsonPost("/api/catalog/categories/reorder", { ids: [seed.categoryId] });
    expect(reorder.statusCode).toBe(403);

    const bulkMove = await jsonPost("/api/catalog/products/bulk-category", {
      ids: [seed.catalogProductId],
      categoryId: seed.categoryId,
    });
    expect(bulkMove.statusCode).toBe(403);

    const patchCategoryId = await jsonPatch(`/api/catalog/products/${seed.catalogProductId}`, {
      name: "X",
      categoryId: seed.categoryId,
    });
    expect(patchCategoryId.statusCode).toBe(403);
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

// ---- Read-side role gate on credential/export routes (C-1, backend audit
// 2026-08-21) — `roleGate`/`canMutate` above only ever ran on mutations;
// these five GET routes returned account credentials or full CSV/JSON
// exports to every authenticated admin, including `readonly` (the default
// role for every newly-created admin). Fix: `blockReadonlyReads` in
// src/plugins/auth.ts, applied only to these five routes. -----------------

describe("read-side role gate — credential/export routes (C-1)", () => {
  const setRole = (tg: number, role: string) => setSetting(prisma, webRoleKey(tg), role);

  // Minor 6 (final whole-branch review, 2026-08-21): this block's last test
  // ("GET /api/stock/export stays open to readonly") leaves ADMIN_TG's role
  // set to "readonly" and never resets it, so a later describe block would
  // implicitly run under that leftover role instead of whatever was in
  // effect before this block ran (here, "support" — the role the preceding
  // "admin management" describe block's last test left it as). Currently
  // harmless because this file's global `beforeEach` (resetDb) wipes the
  // Setting table before every single test, but that makes this block's own
  // cleanup accidentally load-bearing on an implementation detail of a hook
  // it doesn't own — reset explicitly instead of relying on that.
  afterAll(async () => {
    await setRole(ADMIN_TG, "support");
  });

  it("GET /api/stock/:productId (credentials): readonly is blocked, support and super keep read access", async () => {
    await setRole(ADMIN_TG, "readonly");
    const denied = await get(`/api/stock/${seed.productId}`, seed.cookie);
    expect(denied.statusCode).toBe(403);

    await setRole(ADMIN_TG, "support");
    const asSupport = await get(`/api/stock/${seed.productId}`, seed.cookie);
    expect(asSupport.statusCode).toBe(200);
    expect(JSON.parse(asSupport.body)).toHaveProperty("items");

    await setRole(ADMIN_TG, "super");
    const asSuper = await get(`/api/stock/${seed.productId}`, seed.cookie);
    expect(asSuper.statusCode).toBe(200);
    expect(JSON.parse(asSuper.body)).toHaveProperty("items");
  });

  it("GET /api/stock/:productId/download (plaintext credentials): readonly is blocked, support and super keep read access", async () => {
    await setRole(ADMIN_TG, "readonly");
    const denied = await get(`/api/stock/${seed.productId}/download`, seed.cookie);
    expect(denied.statusCode).toBe(403);

    await setRole(ADMIN_TG, "support");
    const asSupport = await get(`/api/stock/${seed.productId}/download`, seed.cookie);
    expect(asSupport.statusCode).toBe(200);
    expect(asSupport.headers["content-type"]).toContain("text/plain");

    await setRole(ADMIN_TG, "super");
    const asSuper = await get(`/api/stock/${seed.productId}/download`, seed.cookie);
    expect(asSuper.statusCode).toBe(200);
    expect(asSuper.headers["content-type"]).toContain("text/plain");
  });

  it("GET /api/orders/export: readonly is blocked, support and super keep read access", async () => {
    await setRole(ADMIN_TG, "readonly");
    const denied = await get("/api/orders/export", seed.cookie);
    expect(denied.statusCode).toBe(403);

    await setRole(ADMIN_TG, "support");
    const asSupport = await get("/api/orders/export", seed.cookie);
    expect(asSupport.statusCode).toBe(200);
    expect(asSupport.headers["content-type"]).toContain("text/csv");

    await setRole(ADMIN_TG, "super");
    const asSuper = await get("/api/orders/export", seed.cookie);
    expect(asSuper.statusCode).toBe(200);
    expect(asSuper.headers["content-type"]).toContain("text/csv");
  });

  // Important #3 (final whole-branch review, 2026-08-21): readonly could
  // still read one delivered order's credentials at a time via this route —
  // it wasn't one of the five routes gated when C-1 first shipped.
  it("GET /api/orders/:orderId (delivered order credentials): readonly is blocked, support and super keep read access", async () => {
    setBotIdentity({ publicChannelId: -100123456789 });
    const orderId = await makePendingOrder();
    await setRole(ADMIN_TG, "support");
    const approveRes = await post(`/api/orders/${orderId}/approve`, seed.cookie, { csrf_token: seed.csrf });
    expect(approveRes.statusCode).toBe(200);

    await setRole(ADMIN_TG, "readonly");
    const denied = await get(`/api/orders/${orderId}`, seed.cookie);
    expect(denied.statusCode).toBe(403);

    await setRole(ADMIN_TG, "support");
    const asSupport = await get(`/api/orders/${orderId}`, seed.cookie);
    expect(asSupport.statusCode).toBe(200);
    expect(JSON.parse(asSupport.body)).toHaveProperty("order");

    await setRole(ADMIN_TG, "super");
    const asSuper = await get(`/api/orders/${orderId}`, seed.cookie);
    expect(asSuper.statusCode).toBe(200);
    expect(JSON.parse(asSuper.body)).toHaveProperty("order");
    resetBotIdentity();
  });

  it("GET /api/users/export: readonly is blocked, support and super keep read access", async () => {
    await setRole(ADMIN_TG, "readonly");
    const denied = await get("/api/users/export", seed.cookie);
    expect(denied.statusCode).toBe(403);

    await setRole(ADMIN_TG, "support");
    const asSupport = await get("/api/users/export", seed.cookie);
    expect(asSupport.statusCode).toBe(200);
    expect(asSupport.headers["content-type"]).toBe("text/csv; charset=utf-8");

    await setRole(ADMIN_TG, "super");
    const asSuper = await get("/api/users/export", seed.cookie);
    expect(asSuper.statusCode).toBe(200);
    expect(asSuper.headers["content-type"]).toBe("text/csv; charset=utf-8");
  });

  it("GET /api/settings/export: readonly is blocked, support and super keep read access", async () => {
    await setRole(ADMIN_TG, "readonly");
    const denied = await get("/api/settings/export", seed.cookie);
    expect(denied.statusCode).toBe(403);

    await setRole(ADMIN_TG, "support");
    const asSupport = await get("/api/settings/export", seed.cookie);
    expect(asSupport.statusCode).toBe(200);
    expect(JSON.parse(asSupport.body)).toHaveProperty("fields");

    await setRole(ADMIN_TG, "super");
    const asSuper = await get("/api/settings/export", seed.cookie);
    expect(asSuper.statusCode).toBe(200);
    expect(JSON.parse(asSuper.body)).toHaveProperty("fields");
  });

  // Explicitly out of scope (brief, C-1): the aggregate stock-health CSV
  // carries no credentials and must stay open to readonly.
  it("GET /api/stock/export stays open to readonly (out of scope for C-1)", async () => {
    await setRole(ADMIN_TG, "readonly");
    const res = await get("/api/stock/export", seed.cookie);
    expect(res.statusCode).toBe(200);
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

  it("add: requires auth (anon → 401)", async () => {
    const res = await post("/api/admins/add", null, { csrf_token: "x", telegram_id: String(NEW_ADMIN_TG) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
    const audit = await prisma.auditLog.findFirst({ where: { action: "broadcast_cancel", targetId: bc.id } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("RESELLERS");
    expect((await post(`/api/broadcast/${bc.id}/cancel`, seed.cookie, { csrf_token: seed.csrf })).statusCode).toBe(409);
  });

  it("requires auth and rejects bad CSRF", async () => {
    const anon = await post("/api/broadcast", null, { csrf_token: "x", message: "hi", segment: "ALL" });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
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
    const order = (await createOrderDirect(prisma, { channel: "web", user, productId: seed.productId, quantity: 1 }))!;
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

  // fetch() follows a 303 automatically and lands on the 200 OK HTML /setup
  // page, so an /api/* JSON caller would see res.ok === true and crash on
  // res.json() (the exact bug this task fixes) — /api/* must get a JSON
  // error instead of a redirect, while a real page navigation still redirects.
  it("answers /api/* with a JSON 409 instead of redirecting, while a page route still gets the 303", async () => {
    await deleteSetting(prisma, "setup_completed"); // seeded admin has no password
    const apiRes = await app.inject({ method: "GET", url: "/api/dashboard/kpis" });
    expect(apiRes.statusCode).toBe(409);
    expect(apiRes.json()).toEqual({ error: SETUP_INCOMPLETE_MESSAGE });

    const pageRes = await app.inject({ method: "GET", url: "/" });
    expect(pageRes.statusCode).toBe(303);
    expect(pageRes.headers.location).toBe("/setup");
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
  it("rejects a POST from an unauthenticated caller (H-5: no more anonymous reboot loop)", async () => {
    // Modeled as a fully configured deploy (setup_completed=true) — the real
    // scenario the H-5 finding described: an anonymous caller looping this
    // route to reboot the process. currentAdmin rejects it with a 303 to
    // /login before the handler body (and the restart-file write) ever runs,
    // same as every other currentAdmin-gated route in this app.
    await setSetting(prisma, "setup_completed", "true");
    await setSetting(prisma, "bot_token", "123:test-token");
    const target = join(tmpdir(), `restart-${Date.now()}.txt`);
    process.env.RESTART_TRIGGER_FILE = target;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/setup/restart",
        payload: form({}),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        // No session cookie attached — this is the anonymous caller case.
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/login");
      expect(existsSync(target)).toBe(false);
    } finally {
      if (existsSync(target)) rmSync(target);
      delete process.env.RESTART_TRIGGER_FILE;
    }
  });

  it("succeeds for the real caller: the owner's session right after finishing the wizard", async () => {
    // Reproduces the ONLY real production path to this route: SetupDonePage's
    // "Restart server" button fires POST /setup/restart from the Done screen,
    // which is only reachable after /setup/shop's finish handler has already
    // called markSetupComplete() and auto-logged the owner in with a real
    // session cookie (setup.ts's step-3 handler, ~lines 168-187). So by the
    // time this button is legitimately clicked, setup_completed is already
    // true and a valid admin session already exists — exactly what this test
    // sets up before calling /setup/restart.
    const RESTART_OWNER_TG = 7000999;
    await deleteSetting(prisma, "setup_completed");
    await deleteSetting(prisma, "setup_owner_tg");
    resetAccountFailures(RESTART_OWNER_TG);
    setAdminIds([...config.ADMIN_IDS]);

    await app.inject({
      method: "POST",
      url: "/setup/owner",
      payload: form({
        telegram_id: String(RESTART_OWNER_TG),
        username: "restart-owner",
        password: "supersecret",
        password_confirm: "supersecret",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    const finishRes = await app.inject({
      method: "POST",
      url: "/setup/shop",
      payload: form({ shop_name: "Toko Demo" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(finishRes.statusCode).toBe(303);
    expect(finishRes.headers.location).toBe("/setup/done");
    const setCookie = finishRes.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    const ownerCookie = decodeURIComponent(raw.split(";")[0]!.split("=").slice(1).join("="));

    await setSetting(prisma, "bot_token", "123:test-token");
    // The Done screen's shell now carries this session's CSRF token, which
    // the SPA sends back with the restart POST (Task C3).
    const done = await get("/setup/done", ownerCookie);
    const csrf = /name="csrf-token" content="([^"]*)"/.exec(done.body)?.[1] ?? "";
    expect(csrf).not.toBe("");
    const target = join(tmpdir(), `restart-${Date.now()}.txt`);
    process.env.RESTART_TRIGGER_FILE = target;
    try {
      const noToken = await post("/setup/restart", ownerCookie, {});
      expect(noToken.statusCode).toBe(403);
      expect(existsSync(target)).toBe(false);

      const res = await post("/setup/restart", ownerCookie, { csrf_token: csrf });
      expect(res.statusCode).toBe(200);
      const audit = await prisma.auditLog.findMany({ where: { action: "bot_restart" } });
      expect(audit).toHaveLength(1);
      expect(audit[0]!.details).toMatch(/^Restarted the app from the setup wizard/);
      expect(existsSync(target)).toBe(true);
      const data = JSON.parse(res.body) as { ok: boolean; restarted: boolean; bot_configured: boolean };
      expect(data.ok).toBe(true);
      expect(data.restarted).toBe(true);
      expect(data.bot_configured).toBe(true);
    } finally {
      if (existsSync(target)) rmSync(target);
      delete process.env.RESTART_TRIGGER_FILE;
      await setSetting(prisma, "setup_completed", "true"); // restore suite default
    }
  });
});

describe("setup wizard — restart trigger is owner-only (Task C3)", () => {
  it("refuses a support admin with a valid session and CSRF token, and writes nothing", async () => {
    await setSetting(prisma, webRoleKey(ADMIN_TG), "support");
    const target = join(tmpdir(), `restart-support-${Date.now()}.txt`);
    process.env.RESTART_TRIGGER_FILE = target;
    try {
      const res = await post("/setup/restart", seed.cookie, { csrf_token: seed.csrf });
      expect(res.statusCode).toBe(403);
      expect(existsSync(target)).toBe(false);
      expect(await prisma.auditLog.count({ where: { action: "bot_restart" } })).toBe(0);
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

  it("expires an abandoned OWNER_TG_KEY after the setup window (M-30): a second, attacker-supplied telegram_id is refused", async () => {
    // Simulate the real abandonment scenario: step 2 succeeds (owner password
    // hashed + OWNER_TG_KEY written), then the operator's browser/deploy is
    // interrupted before step 3 ever runs — setup_completed stays unset.
    const ownerRes = await createOwner();
    expect(ownerRes.statusCode).toBe(303); // step 2 succeeded, owner exists
    expect(isAdmin(OWNER_TG)).toBe(true);

    // Simulate time passing well past the 30-minute window by backdating the
    // OWNER_TG_KEY timestamp directly (no need to fake global Date/timers —
    // the expiry check reads this setting, not the wall clock at write time).
    await setSetting(prisma, "setup_owner_tg_at", String(Date.now() - 31 * 60 * 1000));

    // An attacker now hits the still-reachable, pre-auth, no-CSRF POST
    // /setup/owner with their OWN telegram_id, trying to mint a second
    // super-admin account.
    const ATTACKER_TG = 6660001;
    const attackerRes = await app.inject({
      method: "POST",
      url: "/setup/owner",
      payload: form({ telegram_id: String(ATTACKER_TG), username: "attacker", password: "attackerpw", password_confirm: "attackerpw" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    // Locked out — redirected to /login instead of processing the body.
    expect(attackerRes.statusCode).toBe(303);
    expect(attackerRes.headers.location).toBe("/login");
    // The escalation itself is what must be prevented, not just the response
    // shape: the attacker's telegram_id must NOT have become an admin.
    expect(isAdmin(ATTACKER_TG)).toBe(false);
    expect(adminIds()).not.toContain(ATTACKER_TG);
    // The window's expiry self-heals setup_completed (same mechanism as the
    // bootstrap-takeover case below), permanently closing the wizard.
    expect(await getSetting(prisma, "setup_completed")).toBe("true");
    // The legitimate owner from step 2 is unaffected.
    expect(isAdmin(OWNER_TG)).toBe(true);
  });

  it("does NOT expire OWNER_TG_KEY inside the setup window (legitimate mid-wizard continue still works)", async () => {
    await createOwner();
    // Backdate, but stay just inside the 30-minute window.
    await setSetting(prisma, "setup_owner_tg_at", String(Date.now() - 29 * 60 * 1000));
    const shopPage = await app.inject({ method: "GET", url: "/setup/shop" });
    expect(shopPage.statusCode).toBe(200); // still open — not locked
  });

  it("does NOT extend the expiry window on a re-POST inside it (anti sliding-window), and replaces the mistyped owner instead of minting a second admin", async () => {
    // Round 1: operator completes step 2, but (say) fat-fingered the Telegram
    // ID. OWNER_TG_KEY's timestamp starts the clock.
    const firstRes = await createOwner();
    expect(firstRes.statusCode).toBe(303);
    expect(isAdmin(OWNER_TG)).toBe(true);
    const originalSetAt = await getSetting(prisma, "setup_owner_tg_at");
    expect(originalSetAt).not.toBeNull();

    // 25 minutes pass (still inside the 30-minute window) before the operator
    // notices the typo and retries with the corrected Telegram ID.
    const backdated = String(Date.now() - 25 * 60 * 1000);
    await setSetting(prisma, "setup_owner_tg_at", backdated);
    const CORRECTED_TG = 7000456;
    resetAccountFailures(CORRECTED_TG);
    const retryRes = await app.inject({
      method: "POST",
      url: "/setup/owner",
      payload: form({ telegram_id: String(CORRECTED_TG), username: "owner", password: "supersecret2", password_confirm: "supersecret2" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(retryRes.statusCode).toBe(303);
    expect(retryRes.headers.location).toBe("/setup/shop");

    // The corrected id replaced the mistyped one — exactly one wizard-granted
    // admin exists at a time, not two.
    expect(isAdmin(CORRECTED_TG)).toBe(true);
    expect(isAdmin(OWNER_TG)).toBe(false);
    expect(adminIds()).toContain(CORRECTED_TG);
    expect(adminIds()).not.toContain(OWNER_TG);
    expect(await getSetting(prisma, "setup_owner_tg")).toBe(String(CORRECTED_TG));
    expect(await getSetting(prisma, passwordHashKey(OWNER_TG))).toBeNull(); // old credential retracted

    // The critical assertion: the retry did NOT reset the clock. The
    // timestamp is still the backdated value from round 1, not "now".
    expect(await getSetting(prisma, "setup_owner_tg_at")).toBe(backdated);

    // Push past the ORIGINAL 30-minute window (from round 1's real start) —
    // regardless of the intervening retry, the wizard must now lock for
    // good. A further attacker-supplied id must be refused.
    await setSetting(prisma, "setup_owner_tg_at", String(Date.now() - 31 * 60 * 1000));
    const ATTACKER_TG = 6660003;
    const attackerRes = await app.inject({
      method: "POST",
      url: "/setup/owner",
      payload: form({ telegram_id: String(ATTACKER_TG), username: "attacker", password: "attackerpw", password_confirm: "attackerpw" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(attackerRes.statusCode).toBe(303);
    expect(attackerRes.headers.location).toBe("/login");
    expect(isAdmin(ATTACKER_TG)).toBe(false);
    expect(await getSetting(prisma, "setup_completed")).toBe("true");
    // The corrected owner from the retry is unaffected by the later lock.
    expect(isAdmin(CORRECTED_TG)).toBe(true);
  });

  it("legitimate retry: re-POSTing /setup/owner with the SAME Telegram ID (mistyped password fixed) updates the owner in place without minting a second admin", async () => {
    await createOwner(); // password "supersecret"
    expect(isAdmin(OWNER_TG)).toBe(true);
    const originalSetAt = await getSetting(prisma, "setup_owner_tg_at");

    const retryRes = await app.inject({
      method: "POST",
      url: "/setup/owner",
      payload: form({ telegram_id: String(OWNER_TG), username: "owner", password: "correctedpassword1", password_confirm: "correctedpassword1" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(retryRes.statusCode).toBe(303);
    expect(retryRes.headers.location).toBe("/setup/shop");

    // The retry wrote the new password hash inside a $transaction — a Db
    // object distinct from `prisma` per settings.ts's cache-scoping comment
    // — so a `prisma`-scoped getSetting moments later can still see the
    // pre-retry cached value for up to its 30s TTL. Clear it (same escape
    // hatch tests/helpers/sampleData.ts's resetDb uses) so this assertion
    // reads real persisted state, not a stale in-process cache entry.
    __clearSettingsCacheForTests(prisma);

    // Still exactly one admin (the same id) — and the corrected password now
    // verifies while the original mistyped one no longer does.
    expect(isAdmin(OWNER_TG)).toBe(true);
    expect(await getSetting(prisma, "setup_owner_tg")).toBe(String(OWNER_TG));
    const storedHash = await getSetting(prisma, passwordHashKey(OWNER_TG));
    expect(storedHash).not.toBeNull();
    expect(verifyPassword("correctedpassword1", storedHash!)).toBe(true);
    expect(verifyPassword("supersecret", storedHash!)).toBe(false);
    // Recovery works, and the window is untouched by the correction.
    expect(await getSetting(prisma, "setup_owner_tg_at")).toBe(originalSetAt);
  });

  it("fails CLOSED on a future/skewed OWNER_TG_SET_AT_KEY timestamp instead of treating it as fresh forever", async () => {
    await createOwner();
    // A clock correction, restored backup, or hand-edited row could leave
    // this timestamp in the future — must not be read as "just created".
    await setSetting(prisma, "setup_owner_tg_at", String(Date.now() + 60 * 60 * 1000));
    const ATTACKER_TG = 6660004;
    const res = await app.inject({
      method: "POST",
      url: "/setup/owner",
      payload: form({ telegram_id: String(ATTACKER_TG), username: "attacker", password: "attackerpw", password_confirm: "attackerpw" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
    expect(isAdmin(ATTACKER_TG)).toBe(false);
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

describe("static assets — compression", () => {
  // @fastify/compress only engages above its default 1024-byte threshold, so
  // this hits static/app.css (a real committed file, well above that floor —
  // not the content-hashed dashboard-app/assets/* whose filenames change every
  // build). Mirrors apps/storefront/test/storefront.test.ts's equivalent case.
  it("compresses a large static response when the client sends Accept-Encoding: gzip", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/static/app.css",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });
});
