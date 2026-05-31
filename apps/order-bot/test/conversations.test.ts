// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  upsertUser,
  createOrderDirect,
  attachPaymentProof,
  getOrder,
  approveOrder,
  getSetting,
} from "@app/db";
import { OrderStatus, SenderType, TicketStatus, UserRole } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, FakeConversation, calls, sentIncludes, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { reviewConversation, ticketUserReplyConversation } from "../src/conversations/customer";
import { proofConversation, voucherConversation } from "../src/conversations/checkout";
import { supportConversation } from "../src/conversations/support";
import { rejectConversation } from "../src/conversations/reject";
import {
  stockUploadConversation,
  voucherCreateConversation,
  broadcastConversation,
  userSearchConversation,
  settingConversation,
  productCreateConversation,
  productEditConversation,
  bulkPricingConversation,
  ticketReplyConversation,
} from "../src/conversations/admin";

let sample: SampleData;
let adminDbId: number;

beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  adminDbId = (await upsertUser(prisma, { telegramId: 999, username: "boss", fullName: "Admin Boss" })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// --- ctx builders ----------------------------------------------------------

function custSession(): Partial<SessionData> {
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

function entryCust(sink: SentCall[], callbackData: string) {
  return makeCtx({ sink, from: { id: 42, username: "tester" }, session: custSession(), callbackData }).ctx;
}
function entryAdmin(sink: SentCall[], callbackData: string) {
  return makeCtx({
    sink,
    from: { id: 999, username: "boss" },
    session: { lang: "en", scratch: {}, dbUser: { id: adminDbId, telegramId: "999", role: UserRole.ADMIN, language: "EN", referralCode: "A", walletBalance: "0" } },
    callbackData,
  }).ctx;
}
function msg(sink: SentCall[], o: { text?: string; photo?: Array<{ file_id: string }>; callbackData?: string; document?: { file_id: string; file_name?: string; file_size?: number } }) {
  // Every real update is enriched with session.dbUser by the registeredUser
  // middleware before the conversation resumes — mirror that here so handlers
  // resumed mid-conversation (e.g. renderOrderConfirmation) see a user.
  return makeCtx({ sink, from: { id: 42, username: "tester" }, session: custSession(), ...o }).ctx;
}

async function pendingVerificationOrder() {
  const order = await prisma.$transaction((tx) =>
    createOrderDirect(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1 }),
  );
  await attachPaymentProof(prisma, order!.id, { fileId: "pf", txid: "TX1234567890" });
  return order!;
}

// ===========================================================================
// Customer conversations
// ===========================================================================

describe("customer conversations", () => {
  it("review: rating + comment creates a review on a delivered order", async () => {
    const order = await pendingVerificationOrder();
    await approveOrder(prisma, order.id, { adminId: adminDbId }); // → DELIVERED
    const sink: SentCall[] = [];
    const entry = entryCust(sink, `v1:review:rate:${order.id}:${sample.product.id}:5`);
    const conv = new FakeConversation([msg(sink, { text: "Great service" })]);
    await reviewConversation(conv.asMyConversation(), entry);

    const review = await prisma.review.findFirst({ where: { orderId: order.id } });
    expect(review).toBeTruthy();
    expect(review!.rating).toBe(5);
    expect(review!.comment).toBe("Great service");
  });

  it("ticketUserReply: adds a USER message to an open ticket + notifies admins", async () => {
    const ticket = await prisma.supportTicket.create({ data: { userId: sample.user.id, message: "broken", status: TicketStatus.OPEN } });
    const sink: SentCall[] = [];
    const entry = entryCust(sink, `v1:ticket:reply:${ticket.id}`);
    const conv = new FakeConversation([msg(sink, { text: "Still not working" })]);
    await ticketUserReplyConversation(conv.asMyConversation(), entry);

    const msgs = await prisma.ticketMessage.findMany({ where: { ticketId: ticket.id, senderType: SenderType.USER } });
    expect(msgs.some((m) => m.content === "Still not working")).toBe(true);
    expect(calls(sink, "sendMessage").some((c) => c.args[0] === 999)).toBe(true); // admin notified
  });
});

// ===========================================================================
// Checkout conversations
// ===========================================================================

describe("checkout conversations", () => {
  it("proof: screenshot + txid moves the order to PENDING_VERIFICATION and DMs admins", async () => {
    const order = await prisma.$transaction((tx) =>
      createOrderDirect(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1 }),
    );
    const sink: SentCall[] = [];
    const entry = entryCust(sink, `v1:checkout:proof:${order!.id}`);
    const conv = new FakeConversation([
      msg(sink, { photo: [{ file_id: "shot-1" }] }),
      msg(sink, { text: "TXABCDEF1234" }),
    ]);
    await proofConversation(conv.asMyConversation(), entry);

    const after = await getOrder(prisma, order!.id);
    expect(after!.status).toBe(OrderStatus.PENDING_VERIFICATION);
    expect(after!.binanceTxid).toBe("TXABCDEF1234");
    expect(after!.paymentProofFileId).toBe("shot-1");
    expect(calls(sink, "sendMessage").some((c) => c.args[0] === 999)).toBe(true); // admin notified
  });

  it("proof: '🏠 Menu' escapes to the dashboard, answers the callback, leaves the order pending (§8.7)", async () => {
    const order = await prisma.$transaction((tx) =>
      createOrderDirect(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1 }),
    );
    const before = (await getOrder(prisma, order!.id))!.status;
    const sink: SentCall[] = [];
    const entry = entryCust(sink, `v1:checkout:proof:${order!.id}`);
    const conv = new FakeConversation([msg(sink, { callbackData: "v1:menu:main" })]);
    await proofConversation(conv.asMyConversation(), entry);

    // Escaped to the dashboard (a fresh reply carrying the persistent keyboard),
    // and the callback was answered so no loading spinner hangs. Under the bug
    // this fell through to a re-prompt → a 2nd wait() → "queue empty" throw.
    expect(calls(sink, "reply").length).toBeGreaterThan(0);
    expect(calls(sink, "answerCallbackQuery").length).toBeGreaterThan(0);
    // Non-destructive: the order is untouched (still pending, under My Orders).
    expect((await getOrder(prisma, order!.id))!.status).toBe(before);
  });

  it("voucher: a valid code is applied and the confirmation re-renders with it", async () => {
    const sink: SentCall[] = [];
    const entry = entryCust(sink, `v1:voucher:start:${sample.product.id}:2`);
    const conv = new FakeConversation([msg(sink, { text: "save10" })]);
    await voucherConversation(conv.asMyConversation(), entry);
    expect(sentIncludes(sink, "SAVE10")).toBe(true); // confirm_voucher_line shows the code
  });
});

// ===========================================================================
// Support + reject
// ===========================================================================

describe("support + reject conversations", () => {
  it("support: description + submit creates a ticket, a message, and forwards to admins", async () => {
    const sink: SentCall[] = [];
    const entry = entryCust(sink, "v1:support:open");
    const conv = new FakeConversation([
      msg(sink, { text: "My account stopped working yesterday" }),
      msg(sink, { callbackData: "v1:support:photos:done" }),
    ]);
    await supportConversation(conv.asMyConversation(), entry);

    const ticket = await prisma.supportTicket.findFirst({ where: { userId: sample.user.id } });
    expect(ticket).toBeTruthy();
    expect(await prisma.ticketMessage.count({ where: { ticketId: ticket!.id } })).toBe(1);
    expect(calls(sink, "sendMessage").some((c) => c.args[0] === 999)).toBe(true); // forwarded
  });

  it("reject: admin reason rejects the order, audits, and DMs the buyer", async () => {
    const order = await pendingVerificationOrder();
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:verif:reject:${order.id}`);
    const conv = new FakeConversation([msg(sink, { text: "Proof does not match" })]);
    await rejectConversation(conv.asMyConversation(), entry);

    const after = await getOrder(prisma, order.id);
    expect(after!.status).toBe(OrderStatus.REJECTED);
    expect(await prisma.auditLog.count({ where: { action: "reject_order" } })).toBe(1);
    expect(calls(sink, "sendMessage").some((c) => c.args[0] === 42)).toBe(true); // buyer DM
  });
});

// ===========================================================================
// Admin conversations
// ===========================================================================

describe("admin conversations", () => {
  it("stockUpload: parses pasted creds, adds stock, audits", async () => {
    const before = await prisma.stockItem.count({ where: { productId: sample.product.id } });
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:stock:add:${sample.product.id}`);
    const conv = new FakeConversation([msg(sink, { text: "new1@x.com:pw1\nnew2@x.com:pw2" })]);
    await stockUploadConversation(conv.asMyConversation(), entry);

    expect(await prisma.stockItem.count({ where: { productId: sample.product.id } })).toBe(before + 2);
    expect(await prisma.auditLog.count({ where: { action: "stock_upload" } })).toBe(1);
  });

  it("voucherCreate: 3 steps create a voucher", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, "v1:adm:vouch:new");
    const conv = new FakeConversation([
      msg(sink, { text: "NEWVC" }),
      msg(sink, { text: "percent 15" }),
      msg(sink, { text: "0" }),
    ]);
    await voucherCreateConversation(conv.asMyConversation(), entry);
    const v = await prisma.voucher.findFirst({ where: { code: "NEWVC" } });
    expect(v).toBeTruthy();
    expect(Number(v!.value)).toBe(15);
    expect(v!.usageLimit).toBeNull();
  });

  it("broadcast: message + confirm sends to all non-banned users and audits", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, "v1:adm:broadcast:start");
    const conv = new FakeConversation([
      msg(sink, { text: "Maintenance tonight" }),
      msg(sink, { callbackData: "v1:adm:broadcast:confirm" }),
    ]);
    await broadcastConversation(conv.asMyConversation(), entry);
    // recipients are users 42 + 999
    const targets = calls(sink, "sendMessage").map((c) => c.args[0]);
    expect(targets).toEqual(expect.arrayContaining([42, 999]));
    expect(await prisma.auditLog.count({ where: { action: "broadcast" } })).toBe(1);
  });

  it("userSearch: a query renders matching users", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, "v1:adm:users:search");
    const conv = new FakeConversation([msg(sink, { text: "tester" })]);
    await userSearchConversation(conv.asMyConversation(), entry);
    expect(sentIncludes(sink, "tester") || sentIncludes(sink, "42")).toBe(true);
  });

  it("setting: persists a setting + audits", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, "v1:adm:settings:set:binance_pay_id");
    const conv = new FakeConversation([msg(sink, { text: "999888777" })]);
    await settingConversation(conv.asMyConversation(), entry);
    expect(await getSetting(prisma, "binance_pay_id")).toBe("999888777");
    expect(await prisma.auditLog.count({ where: { action: "setting_set" } })).toBe(1);
  });

  it("productCreate: 6 steps create a product + audit", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, "v1:adm:prod:new");
    const conv = new FakeConversation([
      msg(sink, { text: "Spotify Premium 1M" }),
      msg(sink, { callbackData: "v1:adm:prod:type:shared" }),
      msg(sink, { text: "1 Month" }),
      msg(sink, { text: "3.50" }),
      msg(sink, { text: "-" }),
      msg(sink, { text: "-" }),
    ]);
    await productCreateConversation(conv.asMyConversation(), entry);
    const p = await prisma.product.findFirst({ where: { name: "Spotify Premium 1M" } });
    expect(p).toBeTruthy();
    expect(Number(p!.price)).toBe(3.5);
    expect(await prisma.auditLog.count({ where: { action: "product_create" } })).toBe(1);
  });

  it("productEdit: rename updates the product + audit", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:prod:rename:${sample.product.id}`);
    const conv = new FakeConversation([msg(sink, { text: "Netflix Renamed" })]);
    await productEditConversation(conv.asMyConversation(), entry);
    const p = await prisma.product.findUnique({ where: { id: sample.product.id } });
    expect(p!.name).toBe("Netflix Renamed");
    expect(await prisma.auditLog.count({ where: { action: "product_rename" } })).toBe(1);
  });

  it("bulkPricing: 2 steps upsert a rule + audit", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:bulk:new:${sample.product.id}`);
    const conv = new FakeConversation([msg(sink, { text: "5" }), msg(sink, { text: "10" })]);
    await bulkPricingConversation(conv.asMyConversation(), entry);
    const rule = await prisma.bulkPricing.findUnique({ where: { productId: sample.product.id } });
    expect(rule).toBeTruthy();
    expect(rule!.minQuantity).toBe(5);
    expect(await prisma.auditLog.count({ where: { action: "bulk_pricing_set" } })).toBe(1);
  });

  it("ticketReply: saves an ADMIN reply, flips status, DMs the customer", async () => {
    const ticket = await prisma.supportTicket.create({ data: { userId: sample.user.id, message: "help me", status: TicketStatus.OPEN } });
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:ticket:reply:${ticket.id}`);
    const conv = new FakeConversation([msg(sink, { text: "Here is your fix" })]);
    await ticketReplyConversation(conv.asMyConversation(), entry);

    const after = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(after!.status).toBe(TicketStatus.REPLIED);
    expect(await prisma.ticketMessage.count({ where: { ticketId: ticket.id, senderType: SenderType.ADMIN } })).toBe(1);
    expect(calls(sink, "sendMessage").some((c) => c.args[0] === 42)).toBe(true); // customer DM
  });
});
