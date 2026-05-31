import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { ProductType } from "@app/core/enums";
import {
  prisma,
  initDb,
  upsertUser,
  createCategory,
  createProduct,
  bulkAddStock,
  getUser,
  getOrder,
  createOrderDirect,
  attachPaymentProof,
  createTicket,
  listTicketMessages,
  setSetting,
  getSetting,
  getVoucherByCode,
  countAvailableStock,
  markUnderpaid,
  recordUnmatchedTx,
} from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import {
  makeSession,
  newJti,
  sessionJtiKey,
  passwordHashKey,
  hashPassword,
  verifyPassword,
} from "../src/auth";

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

// ---- smoke: every GET page renders 200 for an admin -----------------------

describe("page smoke tests", () => {
  it("all nav pages render 200", async () => {
    for (const path of ["/", "/stock", "/orders", "/payments", "/outbox", "/catalog", "/vouchers", "/users", "/reviews", "/reports", "/support", "/settings", "/audit"]) {
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
