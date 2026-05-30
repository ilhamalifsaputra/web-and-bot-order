// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, createOrderDirect, attachPaymentProof, getOrder, getUser } from "@app/db";
import { OrderStatus, StockStatus, UserRole, TicketStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import * as customer from "../src/handlers/customer";
import * as checkout from "../src/handlers/checkout";
import * as verification from "../src/handlers/verification";
import { handleAdminCallback, adminCommand } from "../src/handlers/admin";
import { routeCallback } from "../src/handlers/callbacks";
import { upsertUser } from "@app/db";

let sample: SampleData;
let adminDbId: number;

beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  const adminUser = await upsertUser(prisma, { telegramId: 999, username: "boss", fullName: "Admin Boss" });
  adminDbId = adminUser.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// --- ctx builders ----------------------------------------------------------

function userSession(): Partial<SessionData> {
  return {
    lang: "en",
    scratch: {},
    dbUser: {
      id: sample.user.id,
      telegramId: String(sample.user.telegramId),
      role: sample.user.role,
      language: sample.user.language,
      referralCode: sample.user.referralCode,
      walletBalance: String(sample.user.walletBalance),
    },
  };
}

function customerCtx(opts: Parameters<typeof makeCtx>[0] = {}) {
  return makeCtx({ from: { id: 42, username: "tester" }, session: userSession(), ...opts });
}

function adminCtx(opts: Parameters<typeof makeCtx>[0] = {}) {
  return makeCtx({
    from: { id: 999, username: "boss" },
    session: {
      lang: "en",
      scratch: {},
      dbUser: {
        id: adminDbId,
        telegramId: "999",
        role: UserRole.ADMIN,
        language: "EN",
        referralCode: "ADMINREF",
        walletBalance: "0",
      },
    },
    ...opts,
  });
}

/** Create a PENDING_PAYMENT order for the sample user. */
async function makeOrder(qty = 1) {
  return prisma.$transaction((tx) =>
    createOrderDirect(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: qty }),
  );
}

// ===========================================================================
// Customer navigation
// ===========================================================================

describe("customer handlers", () => {
  it("browseProductsFlat lists active products and records the page slice", async () => {
    const { ctx, sink } = customerCtx();
    await customer.browseProductsFlat(ctx);
    expect(sink.length).toBeGreaterThan(0);
    expect((ctx.session.scratch as { browseProductIds?: number[] }).browseProductIds).toEqual([sample.product.id]);
  });

  it("browseProduct shows detail and sets the viewing breadcrumb", async () => {
    const { ctx, sink } = customerCtx();
    await customer.browseProduct(ctx, sample.product.id);
    expect((ctx.session.scratch as { viewingProductId?: number }).viewingProductId).toBe(sample.product.id);
    expect(JSON.stringify(sink)).toContain("Netflix");
  });

  it("handleProductNumber resolves a digit to the page-local product", async () => {
    const { ctx } = customerCtx({ text: "1", session: { ...userSession(), scratch: { browsePage: 0 } } });
    await customer.handleProductNumber(ctx);
    expect((ctx.session.scratch as { viewingProductId?: number }).viewingProductId).toBe(sample.product.id);
  });

  it("setLanguage persists the choice and updates the session", async () => {
    const { ctx } = customerCtx({ callbackData: "v1:lang:set:id" });
    await customer.setLanguage(ctx, "id");
    expect(ctx.session.lang).toBe("id");
    const u = await getUser(prisma, sample.user.id);
    expect(u?.language).toBe("ID");
  });

  it("subscribeRestock creates a subscription once (idempotent)", async () => {
    const { ctx } = customerCtx({ callbackData: "v1:restock:sub:1" });
    await customer.subscribeRestock(ctx, sample.product.id);
    await customer.subscribeRestock(ctx, sample.product.id);
    const subs = await prisma.restockSubscription.count({ where: { userId: sample.user.id, productId: sample.product.id } });
    expect(subs).toBe(1);
  });

  it("viewWallet and viewReferral render without touching the DB", async () => {
    const w = customerCtx();
    await customer.viewWallet(w.ctx);
    expect(w.sink.length).toBeGreaterThan(0);
    const r = customerCtx();
    await customer.viewReferral(r.ctx);
    expect(JSON.stringify(r.sink)).toContain(sample.user.referralCode);
  });

  it("viewOrder shows an order the user owns; rejects others'", async () => {
    const order = await makeOrder();
    const ok = customerCtx();
    await customer.viewOrder(ok.ctx, order!.id);
    expect(JSON.stringify(ok.sink)).toContain(order!.orderCode);

    const stranger = makeCtx({
      from: { id: 777 },
      session: { lang: "en", scratch: {}, dbUser: { id: 99999, telegramId: "777", role: "CUSTOMER", language: "EN", referralCode: "X", walletBalance: "0" } },
    });
    await customer.viewOrder(stranger.ctx, order!.id);
    // not_found path → still sends something, but never leaks the code
    expect(JSON.stringify(stranger.sink)).not.toContain(order!.orderCode);
  });
});

// ===========================================================================
// Checkout
// ===========================================================================

describe("checkout handlers", () => {
  it("showOrderConfirmation renders a summary and creates no order", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:buy:1:2" });
    await checkout.showOrderConfirmation(ctx, sample.product.id, 2);
    expect(sink.length).toBeGreaterThan(0);
    expect(await prisma.order.count()).toBe(0);
  });

  it("buyNow creates a PENDING_PAYMENT order and shows payment instructions", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:pay:1:1" });
    await checkout.buyNow(ctx, sample.product.id, 1);
    const orders = await prisma.order.findMany();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe(OrderStatus.PENDING_PAYMENT);
    // payment instructions now EDIT the confirm bubble (callback path) rather
    // than posting a new message.
    expect(
      calls(sink, "editMessageText").length + calls(sink, "sendMessage").length + calls(sink, "reply").length,
    ).toBeGreaterThan(0);
    checkout.cancelPaymentJobs(orders[0]!.id); // clear the countdown timer
  });

  it("buyNow refuses past the pending-order limit", async () => {
    for (let i = 0; i < 10; i++) await makeOrder();
    const before = await prisma.order.count();
    const { ctx } = customerCtx({ callbackData: "v1:pay:1:1" });
    await checkout.buyNow(ctx, sample.product.id, 1);
    expect(await prisma.order.count()).toBe(before); // no new order
  });

  it("cancelPendingOrder cancels the order", async () => {
    const order = await makeOrder();
    const { ctx } = customerCtx({ callbackData: `v1:checkout:cancel:${order!.id}` });
    await checkout.cancelPendingOrder(ctx, order!.id);
    const after = await getOrder(prisma, order!.id);
    expect(after!.status).toBe(OrderStatus.CANCELLED);
  });
});

// ===========================================================================
// Verification (admin approve / resend)
// ===========================================================================

describe("verification handlers", () => {
  async function pendingVerificationOrder() {
    const order = await makeOrder();
    await attachPaymentProof(prisma, order!.id, { fileId: "proof-file", txid: "TX1234567890" });
    return order!;
  }

  it("showQueue lists orders awaiting verification", async () => {
    const order = await pendingVerificationOrder();
    const { ctx, sink } = adminCtx({ callbackData: "v1:adm:verif:list" });
    await verification.showQueue(ctx);
    expect(JSON.stringify(sink)).toContain(order.orderCode);
  });

  it("approve delivers the order, marks stock SOLD, enqueues outbox + audit, DMs the buyer", async () => {
    const order = await pendingVerificationOrder();
    const { ctx, sink } = adminCtx({ callbackData: `v1:adm:verif:approve:${order.id}` });
    await verification.approve(ctx, order.id);

    const after = await getOrder(prisma, order.id);
    expect(after!.status).toBe(OrderStatus.DELIVERED);
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
    expect(await prisma.notificationOutbox.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "approve_order" } })).toBe(1);
    // credentials DM goes to the buyer's telegram id (42)
    const dm = calls(sink, "sendMessage").find((c) => c.args[0] === 42);
    expect(dm).toBeTruthy();
  });

  it("resendCredentials re-sends for an already-delivered order", async () => {
    const order = await pendingVerificationOrder();
    await adminCtx().ctx; // noop
    await verification.approve(adminCtx({ callbackData: `v1:adm:verif:approve:${order.id}` }).ctx, order.id);
    const { ctx, sink } = adminCtx({ callbackData: `v1:adm:verif:resend:${order.id}` });
    await verification.resendCredentials(ctx, order.id);
    expect(calls(sink, "sendMessage").some((c) => c.args[0] === 42)).toBe(true);
  });
});

// ===========================================================================
// Admin sub-router (handleAdminCallback)
// ===========================================================================

describe("admin handlers", () => {
  it("adminCommand renders the admin menu", async () => {
    const { ctx, sink } = adminCtx();
    await adminCommand(ctx);
    expect(sink.length).toBeGreaterThan(0);
  });

  it("non-admin is denied at the router gate", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:adm:dash" });
    await handleAdminCallback(ctx, "v1:adm:dash".split(":"));
    // answered with an alert, no dashboard content
    expect(calls(sink, "answerCallbackQuery").length).toBe(1);
  });

  it("user ban toggles the flag and writes an audit row", async () => {
    const { ctx } = adminCtx({ callbackData: `v1:adm:users:ban:${sample.user.id}` });
    await handleAdminCallback(ctx, `v1:adm:users:ban:${sample.user.id}`.split(":"));
    expect((await getUser(prisma, sample.user.id))!.banned).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "user_ban" } })).toBe(1);

    const { ctx: ctx2 } = adminCtx({ callbackData: `v1:adm:users:unban:${sample.user.id}` });
    await handleAdminCallback(ctx2, `v1:adm:users:unban:${sample.user.id}`.split(":"));
    expect((await getUser(prisma, sample.user.id))!.banned).toBe(false);
  });

  it("set reseller flips the role", async () => {
    const { ctx } = adminCtx({ callbackData: `v1:adm:users:reseller:${sample.user.id}:1` });
    await handleAdminCallback(ctx, `v1:adm:users:reseller:${sample.user.id}:1`.split(":"));
    expect((await getUser(prisma, sample.user.id))!.role).toBe(UserRole.RESELLER);
  });

  it("toggle product flips is_active + audits", async () => {
    const { ctx } = adminCtx({ callbackData: `v1:adm:prod:toggle:${sample.product.id}` });
    await handleAdminCallback(ctx, `v1:adm:prod:toggle:${sample.product.id}`.split(":"));
    const p = await prisma.product.findUnique({ where: { id: sample.product.id } });
    expect(p!.isActive).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "product_toggle" } })).toBe(1);
  });

  it("ticket close sets the ticket CLOSED", async () => {
    const ticket = await prisma.supportTicket.create({ data: { userId: sample.user.id, message: "help" } });
    const { ctx } = adminCtx({ callbackData: `v1:adm:ticket:close:${ticket.id}` });
    await handleAdminCallback(ctx, `v1:adm:ticket:close:${ticket.id}`.split(":"));
    expect((await prisma.supportTicket.findUnique({ where: { id: ticket.id } }))!.status).toBe(TicketStatus.CLOSED);
  });

  it("dashboard / product / settings menus render", async () => {
    for (const data of ["v1:adm:dash", "v1:adm:prod:menu", "v1:adm:settings:menu", "v1:adm:vouch:menu"]) {
      const { ctx, sink } = adminCtx({ callbackData: data });
      await handleAdminCallback(ctx, data.split(":"));
      expect(sink.length, data).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Callback router (routeCallback)
// ===========================================================================

describe("callback router", () => {
  it("dispatches v1:menu:main to the customer dashboard", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:menu:main" });
    await routeCallback(ctx);
    expect(sink.length).toBeGreaterThan(0);
  });

  it("dispatches v1:order:list", async () => {
    await makeOrder();
    const { ctx, sink } = customerCtx({ callbackData: "v1:order:list" });
    await routeCallback(ctx);
    expect(sink.length).toBeGreaterThan(0);
  });

  it("answers unknown domains without throwing", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:bogus:thing" });
    await routeCallback(ctx);
    expect(calls(sink, "answerCallbackQuery").length).toBeGreaterThan(0);
  });

  it("routes v1:adm:* to the admin sub-router (admin only)", async () => {
    const { ctx, sink } = adminCtx({ callbackData: "v1:adm:dash" });
    await routeCallback(ctx);
    expect(sink.length).toBeGreaterThan(0);
  });

  it("malformed callback data is answered, not thrown", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "garbage" });
    await routeCallback(ctx);
    expect(calls(sink, "answerCallbackQuery").length).toBeGreaterThan(0);
  });
});
