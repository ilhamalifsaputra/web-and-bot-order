// Route-level tests for the /help Help & Support JSON API (Task 11):
//  - GET  /api/v1/account/support        — additive ?status/?q/?sort/?page/?page_size
//                                          + additive per-row fields; unchanged
//                                          shape when NO query param is present.
//  - GET  /api/v1/account/support/new    — form-bootstrap: the Product dropdown.
//  - POST /api/v1/account/support/new    — the /help create form (strict
//                                          subject/category/product_id/description
//                                          validation); a SIBLING of the legacy
//                                          POST /api/v1/account/support, which is
//                                          left byte-identical (regression guard
//                                          at the bottom of this file).
//
// Setup pattern mirrors spa-api.test.ts: `import "./setup-env"` first, one
// shared isolated Postgres schema for the whole file (no per-test reset — each
// test that counts rows uses a FRESH user so its counts stay deterministic),
// app.inject() for every call, and a local loginAs()/makeUser() copied from
// spa-api.test.ts verbatim.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  prisma,
  initDb,
  setSetting,
  createCatalogProduct,
  createTicket,
} from "@app/db";
import { OrderStatus, TicketCategory, TicketStatus } from "@app/core/enums";
import { hashPassword } from "@app/core/password";
import { cleanupTestDb } from "./setup-env";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let productId: number;
let inactiveProductId: number;
let archivedProductId: number;

/** Sign in via the JSON endpoint, then scrape the CSRF token from the SPA
 * shell's <meta name="csrf-token"> — copied verbatim from spa-api.test.ts. */
async function loginAs(identifier: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  expect(res.statusCode).toBe(200);
  const c = res.headers["set-cookie"];
  const cookie = Array.isArray(c) ? c.join("; ") : String(c);
  const shell = await app.inject({ method: "GET", url: "/spa-shell-probe", headers: { cookie } });
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(shell.body)![1]!;
  expect(csrf).not.toBe("");
  return { cookie, csrf };
}

let userSeq = 0;
/** A fresh password-registered customer. Returns its id + a live session. */
async function freshCustomer(): Promise<{ userId: number; cookie: string; csrf: string }> {
  userSeq += 1;
  const username = `supapi${userSeq}_${Date.now().toString(36)}`;
  const password = "sup-api-pw-1234";
  const u = await prisma.user.create({
    data: {
      loginUsername: username,
      email: `${username}@u.test`,
      passwordHash: hashPassword(password),
      referralCode: `SUPAPI${userSeq}${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
    },
  });
  const session = await loginAs(username, password);
  return { userId: u.id, ...session };
}

/** A minimal DELIVERED order for `userId`, so a ticket can be linked to it. */
async function makeOrder(userId: number): Promise<{ id: number; orderCode: string }> {
  const orderCode = `ORD-SUPAPI-${Math.random().toString(36).slice(2, 10)}`;
  const order = await prisma.order.create({
    data: {
      orderCode,
      userId,
      subtotalAmount: "1000",
      totalAmount: "1000",
      status: OrderStatus.DELIVERED,
    },
  });
  return { id: order.id, orderCode };
}

/** Builds a multipart/form-data payload for app.inject — trimmed-down copy of
 * spa-api.test.ts's helper (text fields + zero or more files). */
function multipart(
  fields: Record<string, string>,
  files: Array<{ field: string; filename: string; contentType: string; content: Buffer }> = [],
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----vitest" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const file of files) {
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

// 1x1 PNG — same constant as spa-api.test.ts / apps/web-admin/test/branding.test.ts.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "Support API Cat", slug: `support-api-cat-${Date.now()}`, sortOrder: 1 },
  });
  const active = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Support API Active Product" });
  productId = active.id;
  const inactive = await createCatalogProduct(prisma, {
    categoryId: cat.id,
    name: "Support API Inactive Product",
    isActive: false,
  });
  inactiveProductId = inactive.id;
  const archived = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Support API Archived Product" });
  await prisma.product.update({ where: { id: archived.id }, data: { isArchived: true } });
  archivedProductId = archived.id;

  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "Support API Test Shop");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

// --------------------------------------------------- GET /account/support (list)
describe("GET /api/v1/account/support", () => {
  it("anonymous → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/account/support" });
    expect(res.statusCode).toBe(401);
  });

  it("no query params: unchanged {tickets:[...]} shape + additive per-row fields", async () => {
    const { userId, cookie } = await freshCustomer();
    await createTicket(prisma, userId, "my plain message", null, null, null, { subject: "Plain subject" });

    const res = await app.inject({ method: "GET", url: "/api/v1/account/support", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The response must NOT gain the paged-only envelope keys here.
    expect(body.total).toBeUndefined();
    expect(body.page).toBeUndefined();
    expect(body.page_size).toBeUndefined();
    expect(body.stats).toBeUndefined();
    expect(Array.isArray(body.tickets)).toBe(true);
    expect(body.tickets).toHaveLength(1);

    const tk = body.tickets[0];
    // Regression: every field the OLD response carried is still present + correct.
    expect(typeof tk.id).toBe("number");
    expect(tk.message).toBe("my plain message");
    expect(typeof tk.status).toBe("string");
    expect(typeof tk.created_at_display).toBe("string");
    expect(tk.admin_reply).toBeNull();
    expect(tk.attachments).toEqual([]);
    // Additive (Task 11): present on both branches.
    expect(tk.subject).toBe("Plain subject");
    // order_code / product_name are always null on the no-param branch.
    expect(tk.order_code).toBeNull();
    expect(tk.product_name).toBeNull();
    expect(typeof tk.updated_at_iso).toBe("string");
    expect(Number.isNaN(Date.parse(tk.updated_at_iso))).toBe(false);
  });

  it("?status=waiting_for_support: paged envelope + stats + only OPEN/WAITING_ADMIN rows", async () => {
    const { userId, cookie } = await freshCustomer();
    const open = await createTicket(prisma, userId, "still open", null, null, null, { subject: "open one" });
    const waitingAdmin = await createTicket(prisma, userId, "bumped", null, null, null, { subject: "waiting admin one" });
    const waitingYou = await createTicket(prisma, userId, "answered", null, null, null, { subject: "waiting you one" });
    const resolved = await createTicket(prisma, userId, "done", null, null, null, { subject: "resolved one" });
    await prisma.supportTicket.update({
      where: { id: waitingAdmin.id },
      data: { status: TicketStatus.WAITING_ADMIN, lastStatusChangeAt: new Date() },
    });
    await prisma.supportTicket.update({
      where: { id: waitingYou.id },
      data: { status: TicketStatus.WAITING_CUSTOMER, lastStatusChangeAt: new Date() },
    });
    await prisma.supportTicket.update({
      where: { id: resolved.id },
      data: { status: TicketStatus.RESOLVED, lastStatusChangeAt: new Date() },
    });
    void open;

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/account/support?status=waiting_for_support",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(10);
    expect(body.stats).toEqual({
      all: 4,
      waiting_for_you: 1,
      waiting_for_support: 2,
      in_progress: 0,
      resolved: 1,
      closed: 0,
    });
    expect(body.tickets).toHaveLength(2);
    for (const tk of body.tickets) {
      expect([TicketStatus.OPEN, TicketStatus.WAITING_ADMIN]).toContain(tk.status);
    }
  });

  it("?q=... matches a ticket by its subject", async () => {
    const { userId, cookie } = await freshCustomer();
    await createTicket(prisma, userId, "body a", null, null, null, { subject: "Refund for my order please" });
    await createTicket(prisma, userId, "body b", null, null, null, { subject: "Cannot log in" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/account/support?q=refund",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tickets).toHaveLength(1);
    expect(body.tickets[0].subject).toBe("Refund for my order please");
    expect(body.total).toBe(1);
  });

  it("?page=2&page_size=1 with 2 tickets: second page holds a different ticket, total is 2", async () => {
    const { userId, cookie } = await freshCustomer();
    await createTicket(prisma, userId, "first", null, null, null, { subject: "pager one" });
    await createTicket(prisma, userId, "second", null, null, null, { subject: "pager two" });

    const p1 = await app.inject({
      method: "GET",
      url: "/api/v1/account/support?page=1&page_size=1&sort=created_asc",
      headers: { cookie },
    });
    const p2 = await app.inject({
      method: "GET",
      url: "/api/v1/account/support?page=2&page_size=1&sort=created_asc",
      headers: { cookie },
    });
    expect(p1.statusCode).toBe(200);
    expect(p2.statusCode).toBe(200);
    const b1 = p1.json();
    const b2 = p2.json();

    expect(b1.total).toBe(2);
    expect(b2.total).toBe(2);
    expect(b2.page).toBe(2);
    expect(b2.page_size).toBe(1);
    expect(b1.tickets).toHaveLength(1);
    expect(b2.tickets).toHaveLength(1);
    expect(b1.tickets[0].id).not.toBe(b2.tickets[0].id);
    // created_asc → page 2 is the later-created ticket.
    expect(b2.tickets[0].subject).toBe("pager two");
  });

  it("an unrecognized ?status / ?sort value falls back to the default instead of erroring", async () => {
    const { userId, cookie } = await freshCustomer();
    await createTicket(prisma, userId, "x", null, null, null, { subject: "fallback one" });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/account/support?status=bogus&sort=nonsense",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1); // status fell back to "all"
    expect(body.tickets).toHaveLength(1);
  });
});

// ---------------------------------------------- GET /account/support/new (bootstrap)
describe("GET /api/v1/account/support/new", () => {
  it("anonymous → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/account/support/new" });
    expect(res.statusCode).toBe(401);
  });

  it("signed-in → { products: [...] } with active/non-archived products only", async () => {
    const { cookie } = await freshCustomer();
    const res = await app.inject({ method: "GET", url: "/api/v1/account/support/new", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.products)).toBe(true);
    const ids = body.products.map((p: { id: number }) => p.id);
    expect(ids).toContain(productId);
    expect(ids).not.toContain(inactiveProductId);
    expect(ids).not.toContain(archivedProductId);
    for (const p of body.products) {
      expect(Object.keys(p).sort()).toEqual(["id", "name"]);
    }
  });
});

// --------------------------------------------- POST /account/support/new (create)
describe("POST /api/v1/account/support/new", () => {
  const validBody = () => ({
    subject: "Payment did not go through",
    category: TicketCategory.PAYMENT,
    product_id: productId,
    description: "I paid but the order still says pending.",
  });

  it("anonymous → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/support/new",
      payload: validBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("missing / wrong x-csrf-token → 403 { error: 'csrf_failed' }", async () => {
    const { cookie } = await freshCustomer();
    const noHeader = await app.inject({
      method: "POST",
      url: "/api/v1/account/support/new",
      headers: { cookie },
      payload: validBody(),
    });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json()).toEqual({ error: "csrf_failed" });

    const badHeader = await app.inject({
      method: "POST",
      url: "/api/v1/account/support/new",
      headers: { cookie, "x-csrf-token": "bad" },
      payload: validBody(),
    });
    expect(badHeader.statusCode).toBe(403);
  });

  it("happy path (JSON, with order_code): 200, persists subject/category/productId/orderId/message", async () => {
    const { userId, cookie, csrf } = await freshCustomer();
    const order = await makeOrder(userId);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/support/new",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { ...validBody(), order_code: order.orderCode },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.ticket_id).toBe("number");

    const row = await prisma.supportTicket.findUnique({ where: { id: body.ticket_id } });
    expect(row).not.toBeNull();
    expect(row!.subject).toBe("Payment did not go through");
    expect(row!.category).toBe(TicketCategory.PAYMENT);
    expect(row!.productId).toBe(productId);
    expect(row!.orderId).toBe(order.id);
    expect(row!.message).toBe("I paid but the order still says pending.");
  });

  it("happy path (multipart, with an attachment): 200, ticket created with the evidence URL", async () => {
    const { cookie, csrf } = await freshCustomer();
    const mp = multipart(
      {
        subject: "Screenshot of the error",
        category: TicketCategory.TECHNICAL,
        product_id: String(productId),
        description: "Here is what I see on the checkout page.",
      },
      [{ field: "attachments", filename: "proof.png", contentType: "image/png", content: PNG }],
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/support/new",
      headers: { cookie, "x-csrf-token": csrf, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    const row = await prisma.supportTicket.findUnique({ where: { id: body.ticket_id } });
    expect(row!.subject).toBe("Screenshot of the error");
    expect(row!.category).toBe(TicketCategory.TECHNICAL);
    expect(row!.attachmentUrls).toMatch(/^\/uploads\/tickets\/evidence-[0-9a-f]+\.png$/);
  });

  it("validation failures each 400 with the right key, and create NO ticket", async () => {
    const { userId, cookie, csrf } = await freshCustomer();
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/v1/account/support/new",
        headers: { cookie, "x-csrf-token": csrf },
        payload,
      });

    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["missing subject", { ...validBody(), subject: "" }, "web.support_subject_required"],
      ["subject too long", { ...validBody(), subject: "x".repeat(101) }, "web.support_subject_required"],
      ["missing category", { ...validBody(), category: "" }, "web.support_category_required"],
      ["invalid category", { ...validBody(), category: "NOT_A_CATEGORY" }, "web.support_category_required"],
      ["missing product_id", { ...validBody(), product_id: undefined }, "web.support_product_invalid"],
      ["non-numeric product_id", { ...validBody(), product_id: "abc" }, "web.support_product_invalid"],
      ["nonexistent product_id", { ...validBody(), product_id: 9_999_999 }, "web.support_product_invalid"],
      ["missing description", { ...validBody(), description: "   " }, "web.support_description_required"],
    ];

    for (const [label, payload, key] of cases) {
      const res = await post(payload);
      expect(res.statusCode, label).toBe(400);
      expect(res.json(), label).toEqual({ error: key });
    }

    expect(await prisma.supportTicket.count({ where: { userId } })).toBe(0);
  });

  it("an order_code belonging to someone else → 400 error.order_not_found, no ticket", async () => {
    const { userId, cookie, csrf } = await freshCustomer();
    const stranger = await freshCustomer();
    const strangerOrder = await makeOrder(stranger.userId);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/support/new",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { ...validBody(), order_code: strangerOrder.orderCode },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "error.order_not_found" });
    expect(await prisma.supportTicket.count({ where: { userId } })).toBe(0);
  });

  it("a second create for an order that already has an open ticket short-circuits as a duplicate", async () => {
    const { userId, cookie, csrf } = await freshCustomer();
    const order = await makeOrder(userId);

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/account/support/new",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { ...validBody(), order_code: order.orderCode },
    });
    expect(first.statusCode).toBe(200);
    const firstId = first.json().ticket_id as number;

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/account/support/new",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { ...validBody(), subject: "different subject", order_code: order.orderCode },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: false, duplicate: true, ticket_id: firstId });
    expect(await prisma.supportTicket.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("a multipart request missing its subject still 400s web.support_subject_required", async () => {
    const { cookie, csrf } = await freshCustomer();
    const mp = multipart({
      category: TicketCategory.OTHER,
      product_id: String(productId),
      description: "no subject here",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/support/new",
      headers: { cookie, "x-csrf-token": csrf, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "web.support_subject_required" });
  });
});

// ------------------------------------- regression: legacy POST /account/support
describe("POST /api/v1/account/support (legacy route — must stay byte-identical)", () => {
  it("still accepts a bare { message } and creates a ticket with null subject/category", async () => {
    const { cookie, csrf } = await freshCustomer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/support",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { message: "old route still works" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.ticket_id).toBe("number");

    const row = await prisma.supportTicket.findUnique({ where: { id: body.ticket_id } });
    expect(row!.message).toBe("old route still works");
    expect(row!.subject).toBeNull();
    expect(row!.category).toBeNull();
  });
});
