// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  upsertUser,
  createOrderDirect,
  attachPaymentProof,
  getOrder,
  getUser,
  approveOrder,
  getSetting,
  setSetting,
  deleteSetting,
} from "@app/db";
import { OrderStatus, SenderType, TicketStatus, UserRole } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import {
  makeCtx,
  FakeConversation,
  calls,
  sentIncludes,
  offersForwardAction,
  type SentCall,
  type MakeCtxOptions,
} from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { t } from "../src/util/i18n";
import { ticketUserReplyConversation } from "../src/conversations/customer";
import { voucherConversation } from "../src/conversations/checkout";
import { supportConversation } from "../src/conversations/support";
import { rejectConversation } from "../src/conversations/reject";
import {
  stockUploadConversation,
  voucherCreateConversation,
  broadcastConversation,
  userSearchConversation,
  userBanConversation,
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

  it("ticketUserReply: the reply prompt offers a Back action (never strands)", async () => {
    const ticket = await prisma.supportTicket.create({ data: { userId: sample.user.id, message: "x", status: TicketStatus.OPEN } });
    const sink: SentCall[] = [];
    const entry = entryCust(sink, `v1:ticket:reply:${ticket.id}`);
    const conv = new FakeConversation([msg(sink, { text: "hello" })]);
    await ticketUserReplyConversation(conv.asMyConversation(), entry);
    // The very first screen (the ask-reply prompt) must carry an inline keyboard.
    const firstEdit = calls(sink, "editMessageText")[0];
    expect(firstEdit).toBeTruthy();
    const opts = firstEdit!.args[firstEdit!.args.length - 1] as { reply_markup?: { inline_keyboard?: unknown[][] } };
    expect(opts.reply_markup?.inline_keyboard?.length).toBeGreaterThan(0);
  });

  it("ticketUserReply: '🏠 Menu' escapes to the dashboard without saving a reply", async () => {
    const ticket = await prisma.supportTicket.create({ data: { userId: sample.user.id, message: "x", status: TicketStatus.OPEN } });
    const sink: SentCall[] = [];
    const entry = entryCust(sink, `v1:ticket:reply:${ticket.id}`);
    const conv = new FakeConversation([msg(sink, { callbackData: "v1:menu:main" })]);
    await ticketUserReplyConversation(conv.asMyConversation(), entry);
    expect(await prisma.ticketMessage.count({ where: { ticketId: ticket.id, senderType: SenderType.USER } })).toBe(0);
    expect(calls(sink, "answerCallbackQuery").length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Checkout conversations
// ===========================================================================

describe("checkout conversations", () => {
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

  it("support: with an existing order, picking it from the order picker links orderId on the ticket", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-SUPPORTPICK-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "45000",
        totalAmount: "45000",
        status: OrderStatus.DELIVERED,
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: sample.product.id, unitPrice: "45000", warrantyDaysSnapshot: 30 },
    });

    const sink: SentCall[] = [];
    const entry = entryCust(sink, "v1:support:open");
    const conv = new FakeConversation([
      msg(sink, { text: "My account stopped working yesterday" }),
      msg(sink, { callbackData: `v1:support:order:${order.id}` }),
      msg(sink, { callbackData: "v1:support:photos:done" }),
    ]);
    await supportConversation(conv.asMyConversation(), entry);

    const ticket = await prisma.supportTicket.findFirst({ where: { userId: sample.user.id } });
    expect(ticket).toBeTruthy();
    expect(ticket!.orderId).toBe(order.id);
  });

  it("support: skipping the order picker still creates a ticket with orderId: null", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-SUPPORTSKIP-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "45000",
        totalAmount: "45000",
        status: OrderStatus.DELIVERED,
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: sample.product.id, unitPrice: "45000", warrantyDaysSnapshot: 30 },
    });

    const sink: SentCall[] = [];
    const entry = entryCust(sink, "v1:support:open");
    const conv = new FakeConversation([
      msg(sink, { text: "General question, not order-specific" }),
      msg(sink, { callbackData: "v1:support:order:skip" }),
      msg(sink, { callbackData: "v1:support:photos:done" }),
    ]);
    await supportConversation(conv.asMyConversation(), entry);

    const ticket = await prisma.supportTicket.findFirst({ where: { userId: sample.user.id } });
    expect(ticket!.orderId).toBeNull();
  });

  it("support: an unrecognized tap during the order-picker wait answers error.stale_screen and the conversation keeps waiting (M-22 fix)", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-SUPPORTSTALE-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "45000",
        totalAmount: "45000",
        status: OrderStatus.DELIVERED,
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: sample.product.id, unitPrice: "45000", warrantyDaysSnapshot: 30 },
    });

    const sink: SentCall[] = [];
    const entry = entryCust(sink, "v1:support:open");
    const conv = new FakeConversation([
      msg(sink, { text: "My account stopped working yesterday" }),
      msg(sink, { callbackData: "v1:menu:main" }), // unrecognized in this wait loop
      msg(sink, { callbackData: "v1:support:order:skip" }),
      msg(sink, { callbackData: "v1:support:photos:done" }),
    ]);
    await supportConversation(conv.asMyConversation(), entry);

    const answers = calls(sink, "answerCallbackQuery");
    expect(answers.some((c) => (c.args[0] as { text?: string } | undefined)?.text === t(entry, "error.stale_screen"))).toBe(true);
    // Conversation was unaffected — it kept waiting and completed normally.
    const ticket = await prisma.supportTicket.findFirst({ where: { userId: sample.user.id } });
    expect(ticket).toBeTruthy();
    expect(ticket!.orderId).toBeNull(); // the picker was ultimately skipped
  });

  it("support: an unrecognized tap during the photos wait answers error.stale_screen and the conversation keeps waiting (M-22 fix)", async () => {
    const sink: SentCall[] = [];
    const entry = entryCust(sink, "v1:support:open");
    const conv = new FakeConversation([
      msg(sink, { text: "My account stopped working yesterday" }),
      msg(sink, { callbackData: "v1:menu:main" }), // unrecognized in this wait loop
      msg(sink, { callbackData: "v1:support:photos:done" }),
    ]);
    await supportConversation(conv.asMyConversation(), entry);

    const answers = calls(sink, "answerCallbackQuery");
    expect(answers.some((c) => (c.args[0] as { text?: string } | undefined)?.text === t(entry, "error.stale_screen"))).toBe(true);
    const ticket = await prisma.supportTicket.findFirst({ where: { userId: sample.user.id } });
    expect(ticket).toBeTruthy();
  });

  it("support: the order-picker, photo-prompt, and received screens all edit the same anchor bubble instead of leaving stray keyboards (M-23 fix)", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-SUPPORTANCHOR-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "45000",
        totalAmount: "45000",
        status: OrderStatus.DELIVERED,
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: sample.product.id, unitPrice: "45000", warrantyDaysSnapshot: 30 },
    });

    const sink: SentCall[] = [];
    // One chat = ONE session object, shared by the entry update and every
    // resumed turn — that's how grammY + @grammyjs/conversations really
    // behave, and it's the only way this test can observe whether the anchor
    // id survives across waits at all. (Per-update sessions, the harness
    // default, silently swallow every cross-wait anchor write.)
    const shared = { ...custSession(), scratch: {} } as SessionData;
    const chat = { id: 42, type: "private" as const };
    const mk = (o: MakeCtxOptions) =>
      makeCtx({ sink, from: { id: 42, username: "tester" }, sharedSession: shared, ...o }).ctx;

    // Entered via a typed /support command (no callback query yet), so the
    // anchor bubble is established by a fresh ctx.reply() and every later
    // step must reuse it through menuAnchor — this is the strongest exercise
    // of the M-23 fix, since pre-fix each of the three sends below (ask_order,
    // ask_photos, received) used a bare ctx.api.sendMessage that created its
    // own new, never-retired bubble.
    const entry = mk({ text: "/support" });
    // Thunks, not ready-made contexts: the skip/done buttons live ON the
    // anchor bubble, so each tap's callbackQuery.message.message_id has to be
    // the anchor id — which doesn't exist until the intro reply has run.
    const conv = new FakeConversation([
      () => mk({ text: "My account stopped working yesterday" }),
      () => mk({ callbackData: "v1:support:order:skip", cbMessage: { message_id: shared.menuMsgId!, chat, date: 0 } }),
      () => mk({ callbackData: "v1:support:photos:done", cbMessage: { message_id: shared.menuMsgId!, chat, date: 0 } }),
    ]);
    await supportConversation(conv.asMyConversation(), entry);

    // Invariant 1 — exactly one anchor bubble is ever born. The intro screen
    // has no prior anchor and no callback query to edit, so it falls through
    // to a single fresh send; nothing afterwards may add a second bubble.
    // (Deliberately NOT asserting how many edits of which kind happened: a
    // typed-input step renders through editAnchor's api-level edit and a tap
    // renders through smartEdit's ctx-level edit, and which is which is a
    // mechanism detail, not the behavior M-23 is about.)
    expect(calls(sink, "reply").length).toBe(1);

    // Invariant 2 — the anchor never moved. Every api-level edit (the
    // wizard-anchor path; it alone carries an explicit message id) targeted
    // one and the same bubble, and the session still points at it after all
    // three post-wait renders. Since the single reply above is the only thing
    // that can seed menuMsgId, that shared id IS the intro reply's message id.
    const anchorEdits = calls(sink, "editMessageText").filter((c) => typeof c.args[1] === "number");
    expect(anchorEdits.length).toBeGreaterThan(0);
    expect(new Set(anchorEdits.map((c) => c.args[1])).size).toBe(1);
    expect(shared.menuMsgId).toBe(anchorEdits[0]!.args[1]);

    // Invariant 3 — no bubble ever had to have its keyboard retired, because
    // a second live keyboard never existed in the first place.
    expect(calls(sink, "editMessageReplyMarkup").length).toBe(0);

    // None of those three customer-facing screens were ever sent as a fresh
    // message into the user's own chat (the bug this task fixes).
    const strayCustomerSends = calls(sink, "sendMessage").filter((c) => c.args[0] === entry.chat!.id);
    expect(strayCustomerSends.length).toBe(0);

    const ticket = await prisma.supportTicket.findFirst({ where: { userId: sample.user.id } });
    expect(ticket).toBeTruthy();
    expect(ticket!.orderId).toBeNull(); // the picker was skipped
  });

  it("support: when the anchor edit fails, the fresh-send fallback's new anchor id lands in the live session (M-23 fix)", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-SUPPORTFALLBACK-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "45000",
        totalAmount: "45000",
        status: OrderStatus.DELIVERED,
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: sample.product.id, unitPrice: "45000", warrantyDaysSnapshot: 30 },
    });

    const sink: SentCall[] = [];
    const chat = { id: 42, type: "private" as const };
    // The bubble the "🆘 Support" button was tapped on. The intro edits it in
    // place, so it is the anchor when the first wait() returns.
    const ANCHOR = 500_001;

    // The live session — the one grammY actually persists, shared by every
    // resumed turn.
    const live = { ...custSession(), scratch: {}, menuMsgId: ANCHOR } as SessionData;
    // The entry `ctx` parameter's session. @grammyjs/conversations replays the
    // conversation on each resume, and from the second turn onwards that
    // parameter is a reconstruction whose session is a detached clone of the
    // first turn's — writes to it never reach storage. Modeled here as a
    // separate object holding the same first-turn state.
    const entrySnapshot = { ...custSession(), scratch: {}, menuMsgId: ANCHOR } as SessionData;

    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      sharedSession: entrySnapshot,
      callbackData: "v1:support:open",
      cbMessage: { message_id: ANCHOR, chat, date: 0 },
    }).ctx;

    const conv = new FakeConversation([
      // The user deleted the anchor bubble before typing, so the ask_order
      // render's edit of it fails and editAnchor must fall back to a fresh
      // send — the one path where a post-wait render mints a NEW anchor id.
      () =>
        makeCtx({
          sink,
          from: { id: 42, username: "tester" },
          sharedSession: live,
          text: "My account stopped working yesterday",
          deletedMessageIds: [ANCHOR],
        }).ctx,
      () =>
        makeCtx({
          sink,
          from: { id: 42, username: "tester" },
          sharedSession: live,
          callbackData: "v1:support:order:skip",
          cbMessage: { message_id: live.menuMsgId!, chat, date: 0 },
        }).ctx,
      () =>
        makeCtx({
          sink,
          from: { id: 42, username: "tester" },
          sharedSession: live,
          callbackData: "v1:support:photos:done",
          cbMessage: { message_id: live.menuMsgId!, chat, date: 0 },
        }).ctx,
    ]);
    await supportConversation(conv.asMyConversation(), entry);

    // The discriminator: the new anchor id must be written onto the context
    // that actually gets persisted (the freshest waited one), not back onto
    // the replayed entry ctx. If a post-wait render used the entry ctx, `live`
    // would still point at the deleted ANCHOR while a brand-new bubble carried
    // a live, never-retired keyboard — the exact stray-keyboard failure M-23
    // exists to prevent.
    expect(live.menuMsgId).toBeDefined();
    expect(live.menuMsgId).not.toBe(ANCHOR);

    // That new id came from the fallback's fresh send, and the two later taps
    // (which ride on live.menuMsgId) kept landing on it.
    expect(calls(sink, "reply").length).toBe(1);

    const ticket = await prisma.supportTicket.findFirst({ where: { userId: sample.user.id } });
    expect(ticket).toBeTruthy();
  });

  it("reject: admin reason rejects the order, audits, and DMs the buyer", async () => {
    const order = await pendingVerificationOrder();
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:verif:reject:${order.id}`);
    const conv = new FakeConversation([msg(sink, { text: "Proof does not match" })]);
    await rejectConversation(conv.asMyConversation(), entry);

    const after = await getOrder(prisma, order.id);
    expect(after!.status).toBe(OrderStatus.REJECTED);
    const auditLog = await prisma.auditLog.findFirst({ where: { action: "reject_order" } });
    expect(auditLog).toBeDefined();
    expect(auditLog!.details).toBe(`Rejected order ${after!.orderCode}: "Proof does not match".`);
    expect(calls(sink, "sendMessage").some((c) => c.args[0] === 42)).toBe(true); // buyer DM
  });

  it("reject: a non-pending order ends on a screen with a back action (never strands)", async () => {
    // PENDING_PAYMENT (not PENDING_VERIFICATION) → rejectOrder throws a ValidationError.
    const order = await prisma.$transaction((tx) =>
      createOrderDirect(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1 }),
    );
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:verif:reject:${order!.id}`);
    const conv = new FakeConversation([msg(sink, { text: "wrong state reason" })]);
    await rejectConversation(conv.asMyConversation(), entry);

    expect((await getOrder(prisma, order!.id))!.status).toBe(OrderStatus.PENDING_PAYMENT); // unchanged
    expect(offersForwardAction(sink)).toBe(true);
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

  it("stockUpload: restock broadcast names both the product type and the denomination", async () => {
    await prisma.product.update({ where: { id: sample.parentProduct.id }, data: { name: "Netflix Premium" } });
    await prisma.denomination.update({
      where: { id: sample.product.id },
      data: { name: "1 Month", broadcastOnRestock: true },
    });
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:stock:add:${sample.product.id}`);
    const conv = new FakeConversation([msg(sink, { text: "new1@x.com:pw1\nnew2@x.com:pw2" })]);
    await stockUploadConversation(conv.asMyConversation(), entry);

    const broadcast = await prisma.broadcast.findFirst({ orderBy: { id: "desc" } });
    expect(broadcast?.message).toContain("Netflix Premium - 1 Month");
    const audit = await prisma.auditLog.findFirst({ where: { action: "restock_broadcast", targetId: sample.product.id } });
    expect(audit?.details).toContain("Netflix Premium - 1 Month");
  });

  it("stockUpload: restock-subscriber DM also names both the product type and the denomination", async () => {
    await prisma.product.update({ where: { id: sample.parentProduct.id }, data: { name: "Netflix Premium" } });
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { name: "1 Month" } });
    const subscriber = await upsertUser(prisma, { telegramId: 555, username: "waiter", fullName: "Waiter" });
    await prisma.restockSubscription.create({ data: { userId: subscriber.id, productId: sample.product.id } });

    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:stock:add:${sample.product.id}`);
    const conv = new FakeConversation([msg(sink, { text: "new1@x.com:pw1\nnew2@x.com:pw2" })]);
    await stockUploadConversation(conv.asMyConversation(), entry);

    expect(sentIncludes(sink, "Netflix Premium - 1 Month")).toBe(true);
    expect(await prisma.restockSubscription.count({ where: { userId: subscriber.id } })).toBe(0);
  });

  it("stockUpload: an unrecognized tap during the wait answers error.stale_screen and the conversation keeps waiting (M-22 fix)", async () => {
    const before = await prisma.stockItem.count({ where: { productId: sample.product.id } });
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:stock:add:${sample.product.id}`);
    const conv = new FakeConversation([
      msg(sink, { callbackData: "v1:adm:junk" }), // unrecognized — not v1:adm:cancel, no document/text
      msg(sink, { text: "new1@x.com:pw1\nnew2@x.com:pw2" }),
    ]);
    await stockUploadConversation(conv.asMyConversation(), entry);

    const answers = calls(sink, "answerCallbackQuery");
    expect(answers.some((c) => (c.args[0] as { text?: string } | undefined)?.text === t(entry, "error.stale_screen"))).toBe(true);
    // Conversation was unaffected — it kept waiting and completed normally.
    expect(await prisma.stockItem.count({ where: { productId: sample.product.id } })).toBe(before + 2);
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

  // Bot-6 (security audit, 2026-06-23): the send loop is one
  // conversation.external() step with no per-recipient marker — a
  // crash-replay re-running it from scratch would re-send to everyone. A
  // durable lock (outside conversation/session state) closes that gap.
  it("broadcast: releases its lock on a clean finish, so a SECOND broadcast right after still sends", async () => {
    const sink1: SentCall[] = [];
    const entry1 = entryAdmin(sink1, "v1:adm:broadcast:start");
    const conv1 = new FakeConversation([
      msg(sink1, { text: "First blast" }),
      msg(sink1, { callbackData: "v1:adm:broadcast:confirm" }),
    ]);
    await broadcastConversation(conv1.asMyConversation(), entry1);
    expect(calls(sink1, "sendMessage").length).toBeGreaterThan(0);
    expect(await getSetting(prisma, "broadcast_inflight_at")).toBeNull();

    const sink2: SentCall[] = [];
    const entry2 = entryAdmin(sink2, "v1:adm:broadcast:start");
    const conv2 = new FakeConversation([
      msg(sink2, { text: "Second blast" }),
      msg(sink2, { callbackData: "v1:adm:broadcast:confirm" }),
    ]);
    await broadcastConversation(conv2.asMyConversation(), entry2);
    expect(calls(sink2, "sendMessage").length).toBeGreaterThan(0);
  });

  it("broadcast: aborts without sending when a fresh lock is already held (simulates a crash-replay re-entry)", async () => {
    await setSetting(prisma, "broadcast_inflight_at", String(Date.now()));
    try {
      const sink: SentCall[] = [];
      const entry = entryAdmin(sink, "v1:adm:broadcast:start");
      const conv = new FakeConversation([
        msg(sink, { text: "Should not go out" }),
        msg(sink, { callbackData: "v1:adm:broadcast:confirm" }),
      ]);
      await broadcastConversation(conv.asMyConversation(), entry);

      expect(calls(sink, "sendMessage").length).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: "broadcast" } })).toBe(0);
      expect(sentIncludes(sink, "already in progress")).toBe(true);
    } finally {
      await deleteSetting(prisma, "broadcast_inflight_at");
    }
  });

  it("broadcast: a STALE lock (past BROADCAST_LOCK_STALE_MS) self-heals and the broadcast proceeds", async () => {
    await setSetting(prisma, "broadcast_inflight_at", String(Date.now() - 31 * 60_000));
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, "v1:adm:broadcast:start");
    const conv = new FakeConversation([
      msg(sink, { text: "Recovered after stale lock" }),
      msg(sink, { callbackData: "v1:adm:broadcast:confirm" }),
    ]);
    await broadcastConversation(conv.asMyConversation(), entry);

    expect(calls(sink, "sendMessage").length).toBeGreaterThan(0);
    expect(await getSetting(prisma, "broadcast_inflight_at")).toBeNull();
  });

  it("userSearch: a query renders matching users", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, "v1:adm:users:search");
    const conv = new FakeConversation([msg(sink, { text: "tester" })]);
    await userSearchConversation(conv.asMyConversation(), entry);
    expect(sentIncludes(sink, "tester") || sentIncludes(sink, "42")).toBe(true);
  });

  it("userBan: a reason bans the user, records the reason in the audit details, and re-renders the user card", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:users:ban:${sample.user.id}`);
    const conv = new FakeConversation([msg(sink, { text: "Repeated chargebacks" })]);
    await userBanConversation(conv.asMyConversation(), entry);

    const after = await getUser(prisma, sample.user.id);
    expect(after!.banned).toBe(true);
    expect(after!.bannedReason).toBe("Repeated chargebacks");
    const auditLog = await prisma.auditLog.findFirst({ where: { action: "user_ban" } });
    expect(auditLog).toBeDefined();
    expect(auditLog!.details).toBe('Banned the user. Reason: "Repeated chargebacks".');
    // Re-renders the user card (never strands the admin).
    expect(offersForwardAction(sink)).toBe(true);
  });

  it("userBan: unban clears the stored ban reason regardless of what was typed, but the audit details still record it", async () => {
    await prisma.$transaction((tx) => tx.user.update({ where: { id: sample.user.id }, data: { banned: true, bannedReason: "Old reason" } }));
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:users:unban:${sample.user.id}`);
    const conv = new FakeConversation([msg(sink, { text: "Appeal accepted" })]);
    await userBanConversation(conv.asMyConversation(), entry);

    const after = await getUser(prisma, sample.user.id);
    expect(after!.banned).toBe(false);
    expect(after!.bannedReason).toBeNull();
    const auditLog = await prisma.auditLog.findFirst({ where: { action: "user_unban" } });
    expect(auditLog).toBeDefined();
    expect(auditLog!.details).toBe('Unbanned the user. Reason: "Appeal accepted".');
  });

  it("userBan: the inline Cancel button aborts without changing the ban flag or writing an audit row", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:users:ban:${sample.user.id}`);
    // Sent by the same admin (999) who opened the flow — handledEscape's
    // adminGate check requires a real admin id, or it just answers a "not
    // admin" toast instead of actually rendering the panel.
    const cancel = makeCtx({
      sink,
      from: { id: 999, username: "boss" },
      session: { lang: "en", scratch: {}, dbUser: { id: adminDbId, telegramId: "999", role: UserRole.ADMIN, language: "EN", referralCode: "A", walletBalance: "0" } },
      callbackData: "v1:adm:cancel",
    }).ctx;
    const conv = new FakeConversation([cancel]);
    await userBanConversation(conv.asMyConversation(), entry);

    const after = await getUser(prisma, sample.user.id);
    expect(after!.banned).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "user_ban" } })).toBe(0);
    // Lands back on the real admin panel (not just "some keyboard exists"),
    // confirming the escape path actually re-rendered admin.menu.
    expect(sentIncludes(sink, "Admin Panel")).toBe(true);
    expect(offersForwardAction(sink)).toBe(true); // never stranded
  });

  it("userBan: a too-short reason shows a validation error, then a valid retry succeeds", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:users:ban:${sample.user.id}`);
    const conv = new FakeConversation([
      msg(sink, { text: "hi" }), // below the 3-char minimum
      msg(sink, { text: "Fraudulent payment proof" }),
    ]);
    await userBanConversation(conv.asMyConversation(), entry);

    expect((await getUser(prisma, sample.user.id))!.banned).toBe(true);
    const auditLog = await prisma.auditLog.findFirst({ where: { action: "user_ban" } });
    expect(auditLog!.details).toBe('Banned the user. Reason: "Fraudulent payment proof".');
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
    const p = await prisma.denomination.findFirst({ where: { name: "Spotify Premium 1M" } });
    expect(p).toBeTruthy();
    expect(Number(p!.price)).toBe(3.5);
    expect(await prisma.auditLog.count({ where: { action: "product_create" } })).toBe(1);
  });

  it("productEdit: rename updates the product + audit", async () => {
    const sink: SentCall[] = [];
    const entry = entryAdmin(sink, `v1:adm:prod:rename:${sample.product.id}`);
    const conv = new FakeConversation([msg(sink, { text: "Netflix Renamed" })]);
    await productEditConversation(conv.asMyConversation(), entry);
    const p = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
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
