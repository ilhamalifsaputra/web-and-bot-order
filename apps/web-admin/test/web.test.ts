import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { ProductType, UserRole } from "@app/core/enums";
import {
  prisma,
  initDb,
  upsertUser,
  createCategory,
  createProduct,
  bulkAddStock,
  getUser,
  getUserByTelegramId,
  getOrder,
  createOrderDirect,
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
import { setTokenValidator } from "../src/routes/settings";
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
import { isAdmin, adminIds, setAdminIds } from "@app/core/runtime";

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
const CUSTOMER_TG = 42;

let app: FastifyInstance;

interface Seed {
  adminId: number;
  customerId: number;
  productId: number;
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
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const customer = await upsertUser(prisma, { telegramId: CUSTOMER_TG, username: "cust", fullName: "Customer" });
  const cat = await createCategory(prisma, `Cat${counter++}`);
  const product = await createProduct(prisma, {
    categoryId: cat.id,
    name: `Prod${counter}`,
    description: "x",
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price: "5.00",
  });
  await bulkAddStock(prisma, product.id, Array.from({ length: 4 }, (_, i) => `a${counter}_${i}@e.com:p`));

  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);

  seed = { adminId: admin.id, customerId: customer.id, productId: product.id, cookie: raw, csrf: data.csrf };
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
});

// ---- catalog (acceptance #5) ----------------------------------------------

describe("catalog", () => {
  it("create category happy + audit", async () => {
    const res = await post("/catalog/category", seed.cookie, { csrf_token: seed.csrf, name: "VPNs", emoji: "🔒", sort_order: "1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const cats = await prisma.category.findMany({ where: { name: "VPNs" } });
    expect(cats.length).toBe(1);
    const audit = await prisma.auditLog.findMany({ where: { action: "category_create" } });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("create product happy (lowercase type accepted)", async () => {
    const product = await prisma.product.findUnique({ where: { id: seed.productId } });
    const res = await post("/catalog/product", seed.cookie, {
      csrf_token: seed.csrf,
      category_id: String(product!.categoryId),
      name: "Netflix 1yr",
      description: "shared",
      type: "shared",
      duration_label: "12 Months",
      price: "19.99",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect((await prisma.product.findMany({ where: { name: "Netflix 1yr" } })).length).toBe(1);
  });

  it("create category requires auth", async () => {
    const res = await post("/catalog/category", null, { csrf_token: "x", name: "Hax" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });

  it("create category rejects bad CSRF", async () => {
    const res = await post("/catalog/category", seed.cookie, { csrf_token: "bad", name: "Hax" });
    expect(res.statusCode).toBe(403);
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
});

// ---- users (acceptance #5) ------------------------------------------------

describe("users", () => {
  it("wallet adjust happy", async () => {
    const before = (await getUser(prisma, seed.customerId))!.walletBalance;
    const res = await post(`/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: seed.csrf, delta: "5.00", note: "goodwill" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    const after = (await getUser(prisma, seed.customerId))!.walletBalance;
    expect(Number(after) - Number(before)).toBeCloseTo(5);
  });

  it("set role happy (lowercase accepted)", async () => {
    const res = await post(`/users/${seed.customerId}/role`, seed.cookie, { csrf_token: seed.csrf, role: "reseller" });
    expect(res.statusCode).toBe(303);
    expect((await getUser(prisma, seed.customerId))!.role).toBe("RESELLER");
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
});

// ---- support (acceptance #5) ----------------------------------------------

describe("support", () => {
  async function makeTicket(): Promise<number> {
    const t = await createTicket(prisma, seed.customerId, "help me");
    return t.id;
  }

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

  it("secret values are redacted on the page", async () => {
    await setSetting(prisma, passwordHashKey(ADMIN_TG), hashPassword("secretpw"));
    const res = await get("/settings", seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("secretpw");
    expect(res.body).toContain("(hidden)");
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
    const res = await get(`/users/${seed.customerId}`, seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("promo credit");
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
  it("stock pages surface the waiting count", async () => {
    await prisma.restockSubscription.create({ data: { userId: seed.customerId, productId: seed.productId } });
    const list = await get("/stock", seed.cookie);
    expect(list.statusCode).toBe(200);
    const detail = await get(`/stock/${seed.productId}`, seed.cookie);
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("waiting on restock");
  });
});

// ---- global search (Tier 3 §13) -------------------------------------------

describe("global search", () => {
  it("exact order code jumps straight to the order detail", async () => {
    const orderId = await makePendingOrder();
    const order = (await getOrder(prisma, orderId))!;
    const res = await get(`/search?q=${encodeURIComponent(order.orderCode)}`, seed.cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/orders/${orderId}`);
  });

  it("a free-text query renders a grouped results page", async () => {
    const res = await get("/search?q=cust", seed.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Users");
    expect(res.body).toContain("Products");
  });

  it("requires auth", async () => {
    const res = await get("/search?q=x", null);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/login");
  });
});

// ---- bulk operations (Tier 2 §8) ------------------------------------------

describe("bulk operations", () => {
  it("bulk deactivate then activate products + audit", async () => {
    const res = await post("/catalog/products/bulk", seed.cookie, { csrf_token: seed.csrf, ids: String(seed.productId), action: "deactivate" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect((await prisma.product.findUnique({ where: { id: seed.productId } }))!.isActive).toBe(false);
    const audit = await prisma.auditLog.findMany({ where: { action: "product_bulk_active" } });
    expect(audit.length).toBeGreaterThanOrEqual(1);

    await post("/catalog/products/bulk", seed.cookie, { csrf_token: seed.csrf, ids: String(seed.productId), action: "activate" });
    expect((await prisma.product.findUnique({ where: { id: seed.productId } }))!.isActive).toBe(true);
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

  it("bulk price: preview is read-only, apply commits the new price", async () => {
    // Step 1 — preview (set to 12.50): renders a page, writes nothing.
    const preview = await post("/catalog/products/bulk-price", seed.cookie, {
      csrf_token: seed.csrf, ids: String(seed.productId), mode: "set", value: "12.50",
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain("Rp13"); // 12.50 rendered as whole-Rupiah (ROUND_HALF_UP)
    expect(Number((await prisma.product.findUnique({ where: { id: seed.productId } }))!.price)).toBe(5);

    // Step 2 — apply the previewed pair.
    const apply = await post("/catalog/products/bulk-price/apply", seed.cookie, {
      csrf_token: seed.csrf, pairs: `${seed.productId}:12.5`,
    });
    expect(apply.statusCode).toBe(303);
    expect(apply.headers.location).toContain("kind=success");
    expect(Number((await prisma.product.findUnique({ where: { id: seed.productId } }))!.price)).toBeCloseTo(12.5);
    const audit = await prisma.auditLog.findMany({ where: { action: "product_bulk_price" } });
    expect(audit.length).toBe(1);
  });

  it("bulk price: percent preview computes new price and skips ≤0", async () => {
    const up = await post("/catalog/products/bulk-price", seed.cookie, {
      csrf_token: seed.csrf, ids: String(seed.productId), mode: "percent", value: "10",
    });
    expect(up.statusCode).toBe(200);
    expect(up.body).toContain("Rp6"); // 5.00 + 10% = 5.5, rendered as whole-Rupiah

    const down = await post("/catalog/products/bulk-price", seed.cookie, {
      csrf_token: seed.csrf, ids: String(seed.productId), mode: "percent", value: "-100",
    });
    expect(down.body).toContain("skipped");
    // Price untouched by either preview.
    expect(Number((await prisma.product.findUnique({ where: { id: seed.productId } }))!.price)).toBe(5);
  });

  it("CSV import: preview is read-only, apply creates the valid rows", async () => {
    const product = (await prisma.product.findUnique({ where: { id: seed.productId } }))!;
    const cat = (await prisma.category.findUnique({ where: { id: product.categoryId } }))!;
    const csv =
      `${cat.name} | Imported A | shared | 1 Month | 9.99\n` +
      `NoSuchCat | Bad Row | shared | 1 Month | 5\n` +
      `${cat.name} | Imported B | private | 12 Months | 19 | 15 | 60 | nice`;
    const before = await prisma.product.count();

    // Step 1 — preview: shows ready + the error, writes nothing.
    const preview = await post("/catalog/products/import", seed.cookie, { csrf_token: seed.csrf, csv });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain("Imported A");
    expect(preview.body).toContain("unknown category");
    expect(await prisma.product.count()).toBe(before);

    // Step 2 — apply: only the 2 valid rows are created.
    const apply = await post("/catalog/products/import/apply", seed.cookie, { csrf_token: seed.csrf, csv });
    expect(apply.statusCode).toBe(303);
    expect(apply.headers.location).toContain("kind=success");
    expect(await prisma.product.count()).toBe(before + 2);
    const b = await prisma.product.findFirst({ where: { name: "Imported B" } });
    expect(b!.type).toBe("PRIVATE");
    expect(Number(b!.resellerPrice)).toBeCloseTo(15);
    expect(b!.warrantyDays).toBe(60);
    const audit = await prisma.auditLog.findMany({ where: { action: "product_csv_import" } });
    expect(audit.length).toBe(1);
  });

  it("CSV import: all-invalid is rejected on apply", async () => {
    const before = await prisma.product.count();
    const res = await post("/catalog/products/import/apply", seed.cookie, {
      csrf_token: seed.csrf, csv: "NoSuchCat | X | shared | 1 Month | 5",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(await prisma.product.count()).toBe(before);
  });

  it("CSV import apply requires auth and rejects bad CSRF", async () => {
    const anon = await post("/catalog/products/import/apply", null, { csrf_token: "x", csv: "a|b|shared|1 Month|5" });
    expect(anon.statusCode).toBe(303);
    expect(anon.headers.location).toBe("/login");
    const bad = await post("/catalog/products/import/apply", seed.cookie, { csrf_token: "bad", csv: "a|b|shared|1 Month|5" });
    expect(bad.statusCode).toBe(403);
  });

  it("bulk price apply requires auth and rejects bad CSRF", async () => {
    const anon = await post("/catalog/products/bulk-price/apply", null, { csrf_token: "x", pairs: `${seed.productId}:1` });
    expect(anon.statusCode).toBe(303);
    expect(anon.headers.location).toBe("/login");
    const bad = await post("/catalog/products/bulk-price/apply", seed.cookie, { csrf_token: "bad", pairs: `${seed.productId}:1` });
    expect(bad.statusCode).toBe(403);
    expect(Number((await prisma.product.findUnique({ where: { id: seed.productId } }))!.price)).toBe(5);
  });

  it("bulk requires auth and rejects bad CSRF", async () => {
    const anon = await post("/catalog/products/bulk", null, { csrf_token: "x", ids: String(seed.productId), action: "deactivate" });
    expect(anon.statusCode).toBe(303);
    expect(anon.headers.location).toBe("/login");
    const bad = await post("/catalog/products/bulk", seed.cookie, { csrf_token: "bad", ids: String(seed.productId), action: "deactivate" });
    expect(bad.statusCode).toBe(403);
    expect((await prisma.product.findUnique({ where: { id: seed.productId } }))!.isActive).toBe(true);
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

  it("/admins is super-only, assigns roles, and blocks self-demotion", async () => {
    expect((await get("/admins", seed.cookie)).statusCode).toBe(200); // super sees it

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
    expect((await get("/admins", seed.cookie)).statusCode).toBe(403); // non-super blocked
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

  it("add: happy path — id appears in adminIds() and GET /admins renders it", async () => {
    const res = await post("/admins/add", seed.cookie, { csrf_token: seed.csrf, telegram_id: String(NEW_ADMIN_TG) });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    // Live runtime updated without restart.
    expect(isAdmin(NEW_ADMIN_TG)).toBe(true);
    // Page lists the new id.
    const page = await get("/admins", seed.cookie);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(String(NEW_ADMIN_TG));
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
});

// ---- broadcast composer (Tier 3 §12) — web ENQUEUES, never sends ----------

describe("broadcast", () => {
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

  it("renders the connect-bot form at GET /setup", async () => {
    const res = await app.inject({ method: "GET", url: "/setup" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Bot token");
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
});
