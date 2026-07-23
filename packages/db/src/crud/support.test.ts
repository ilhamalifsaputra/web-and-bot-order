/**
 * closeTicket atomic guard — Bot-3 fix (security audit, 2026-06-23). Was a
 * read-then-write with no conditional guard, so a double-tap "Close" could
 * fire the buyer-notification DM twice. Now an atomic updateMany — only the
 * call that actually flips CLOSED gets a non-null return.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  closeTicket,
  createTicket,
  addTicketMessage,
  getTicketWithOrder,
  closeTicketByUser,
  reopenTicket,
  TICKET_REOPEN_WINDOW_DAYS,
  listTickets,
  countTickets,
  ticketKpis,
  isTicketOverdue,
  overdueCutoff,
  OVERDUE_THRESHOLD_HOURS,
  resolveTicket,
  reopenTicketAdmin,
  classifyTicket,
} from "./support";
import { TicketStatus, TicketPriority, TicketCategory, SenderType } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;
let userId: number;
let adminId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.ticketMessage.deleteMany();
  await prisma.supportTicket.deleteMany();
  // The order-linkage tests below create Order/OrderItem/Denomination/
  // Product/Category/Voucher rows — clean them up in FK-dependency order
  // (children before parents) so a leftover Order referencing a User
  // doesn't block the next test's user.deleteMany() with an FK violation.
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.denomination.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.user.deleteMany();
  const user = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
  userId = user.id;
  const admin = await prisma.user.create({
    data: {
      telegramId: BigInt(Math.floor(Math.random() * 1e15)),
      referralCode: `r${Math.random()}`,
      role: "ADMIN",
    },
  });
  adminId = admin.id;
});

async function makeUser(telegramId: bigint | null) {
  return prisma.user.create({ data: { telegramId, referralCode: `r${Math.random()}` } });
}

/** Local factory for the new operational-queue tests below — creates a
 * ticket owned by the shared `userId`, with whatever fields a given test
 * needs (status/priority/category/timestamps) via `prisma.supportTicket.create`
 * directly, matching orders.test.ts's makeOrder(extra) pattern. */
function makeTicket(extra: Record<string, unknown> = {}) {
  return prisma.supportTicket.create({
    data: { userId, message: "help please", ...extra },
  });
}

describe("closeTicket atomic guard", () => {
  it("closes an OPEN ticket and returns the owner's telegramId", async () => {
    const user = await makeUser(555n);
    const ticket = await createTicket(prisma, user.id, "help me");

    const tgId = await closeTicket(prisma, ticket.id);

    expect(tgId).toBe(555n);
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.CLOSED);
    // Storage-efficiency cleanup keys off this timestamp to age out evidence files.
    expect(fresh!.closedAt).not.toBeNull();
  });

  it("a SECOND close call on an already-CLOSED ticket returns null — no second DM", async () => {
    const user = await makeUser(556n);
    const ticket = await createTicket(prisma, user.id, "help me");

    const first = await closeTicket(prisma, ticket.id);
    const second = await closeTicket(prisma, ticket.id);

    expect(first).toBe(556n);
    expect(second).toBeNull(); // double-tap: no second notification
  });

  it("returns null for a non-existent ticket id", async () => {
    expect(await closeTicket(prisma, 999999)).toBeNull();
  });

  it("returns null when the owner has no telegramId (web-only buyer) even though the ticket DID close", async () => {
    const user = await makeUser(null);
    const ticket = await createTicket(prisma, user.id, "help me");

    const tgId = await closeTicket(prisma, ticket.id);

    expect(tgId).toBeNull();
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.CLOSED); // still closed — just nobody to DM
  });

  // Task 0: closeTicket now also stamps lastStatusChangeAt — the operational
  // queue's overdue/waiting-time calc reads this, not closedAt, so a closed
  // ticket must never be left with a stale lastStatusChangeAt from before it
  // closed.
  it("stamps lastStatusChangeAt when it closes the ticket", async () => {
    const user = await makeUser(559n);
    const ticket = await createTicket(prisma, user.id, "help me");
    // Backdate so the post-close value is unambiguously later, not just
    // equal-by-millisecond-luck.
    const stale = new Date(Date.now() - 60_000);
    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { lastStatusChangeAt: stale } });

    await closeTicket(prisma, ticket.id);

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.lastStatusChangeAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("does not re-stamp lastStatusChangeAt on a double-tap close that no-ops", async () => {
    const user = await makeUser(560n);
    const ticket = await createTicket(prisma, user.id, "help me");

    await closeTicket(prisma, ticket.id);
    const afterFirst = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });

    await closeTicket(prisma, ticket.id); // no-op, already CLOSED
    const afterSecond = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(afterSecond!.lastStatusChangeAt.getTime()).toBe(afterFirst!.lastStatusChangeAt.getTime());
  });
});

// Web-uploaded evidence URLs — kept in a column separate from photo_file_ids
// (Telegram file_ids from the bot's support flow), since a file_id is
// meaningless as a web <img src>.
describe("attachmentUrls", () => {
  it("defaults to null and round-trips a comma-joined URL string on createTicket", async () => {
    const user = await makeUser(777n);
    const bare = await createTicket(prisma, user.id, "no evidence");
    expect(bare.attachmentUrls).toBeNull();

    const withEvidence = await createTicket(
      prisma,
      user.id,
      "evidence attached",
      null,
      "/uploads/tickets/evidence-a.png,/uploads/tickets/evidence-b.mp4",
    );
    expect(withEvidence.attachmentUrls).toBe(
      "/uploads/tickets/evidence-a.png,/uploads/tickets/evidence-b.mp4",
    );
    // photo_file_ids (Telegram-origin) is untouched by the new parameter.
    expect(withEvidence.photoFileIds).toBeNull();
  });

  it("round-trips attachmentUrls on addTicketMessage, independent of photoFileIds", async () => {
    const user = await makeUser(778n);
    const ticket = await createTicket(prisma, user.id, "help me");

    const msg = await addTicketMessage(prisma, {
      ticketId: ticket.id,
      senderType: SenderType.USER,
      senderId: user.id,
      content: "here's a follow-up video",
      attachmentUrls: "/uploads/tickets/evidence-c.webm",
    });

    expect(msg.attachmentUrls).toBe("/uploads/tickets/evidence-c.webm");
    expect(msg.photoFileIds).toBeNull();
  });
});

describe("createTicket + getTicketWithOrder — order linkage", () => {
  it("createTicket with no orderId leaves the ticket unlinked, order comes back null", async () => {
    const user = await makeUser(900n);
    const ticket = await createTicket(prisma, user.id, "general question");
    expect(ticket.orderId).toBeNull();

    const withOrder = await getTicketWithOrder(prisma, ticket.id);
    expect(withOrder!.order).toBeNull();
  });

  it("createTicket with an orderId links it, getTicketWithOrder returns the order + items + voucher", async () => {
    const user = await makeUser(901n);
    const voucher = await prisma.voucher.create({
      data: { code: `TICKV${Math.random()}`, type: "PERCENT", value: "10" },
    });
    const category = await prisma.category.create({ data: { name: `Cat${Math.random()}`, slug: `cat-${Math.random()}` } });
    const product = await prisma.product.create({
      data: { categoryId: category.id, name: "Prod", slug: `prod-${Math.random()}` },
    });
    const denom = await prisma.denomination.create({
      data: { productId: product.id, name: "1 Month", slug: `denom-${Math.random()}`, type: "auto", durationLabel: "1 month", price: "10000" },
    });
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-TICKV-${Math.random()}`,
        userId: user.id,
        subtotalAmount: "10000",
        totalAmount: "10000",
        voucherId: voucher.id,
        status: "DELIVERED",
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: denom.id, unitPrice: "10000", warrantyDaysSnapshot: 30 },
    });

    const ticket = await createTicket(prisma, user.id, "issue with this order", null, null, order.id);
    expect(ticket.orderId).toBe(order.id);

    const withOrder = await getTicketWithOrder(prisma, ticket.id);
    expect(withOrder!.order!.orderCode).toBe(order.orderCode);
    expect(withOrder!.order!.voucher!.code).toBe(voucher.code);
    expect(withOrder!.order!.items).toHaveLength(1);
    // OrderItem's `product` relation resolves to the Denomination row (a
    // pre-existing schema naming quirk — see the "Phase 5 cleanup" comment
    // on OrderItem in prisma/schema.prisma), not the Product row, so this
    // asserts the Denomination's own `name`/`durationLabel` — the same
    // fields apiAccount.ts's GET /account/orders/:code route already reads
    // this same way (Task 4 mirrors that exact convention).
    expect(withOrder!.order!.items[0]!.product.name).toBe("1 Month");
    expect(withOrder!.order!.items[0]!.product.durationLabel).toBe("1 month");
    expect(withOrder!.order!.items[0]!.warrantyDaysSnapshot).toBe(30);
  });

  it("getTicketWithOrder returns null for a non-existent ticket", async () => {
    expect(await getTicketWithOrder(prisma, 999999)).toBeNull();
  });
});

describe("closeTicketByUser", () => {
  it("closes an OPEN ticket and returns true", async () => {
    const user = await makeUser(910n);
    const ticket = await createTicket(prisma, user.id, "help");
    expect(await closeTicketByUser(prisma, ticket.id)).toBe(true);
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.CLOSED);
    expect(fresh!.closedAt).not.toBeNull();
  });

  it("a second call on an already-CLOSED ticket returns false (no-op)", async () => {
    const user = await makeUser(911n);
    const ticket = await createTicket(prisma, user.id, "help");
    expect(await closeTicketByUser(prisma, ticket.id)).toBe(true);
    expect(await closeTicketByUser(prisma, ticket.id)).toBe(false);
  });
});

// ---- Operational queue (Task 0: TicketFilter/listTickets/countTickets/
// ticketKpis/isTicketOverdue/resolveTicket/reopenTicket/classifyTicket, plus
// closeTicket/addTicketMessage's lastStatusChangeAt/firstResponseAt stamps) --

describe("listTickets / countTickets — ticketWhere filters", () => {
  it("status filters on a single value", async () => {
    const a = await makeTicket({ status: TicketStatus.OPEN });
    await makeTicket({ status: TicketStatus.CLOSED });

    const results = await listTickets(prisma, { status: TicketStatus.OPEN });
    expect(results.map((t) => t.id)).toEqual([a.id]);
    expect(await countTickets(prisma, { status: TicketStatus.OPEN })).toBe(1);
  });

  it("status filters with an IN clause when given an array", async () => {
    const a = await makeTicket({ status: TicketStatus.OPEN });
    const b = await makeTicket({ status: TicketStatus.REPLIED });
    await makeTicket({ status: TicketStatus.CLOSED });

    const results = await listTickets(prisma, { status: [TicketStatus.OPEN, TicketStatus.REPLIED] });
    expect(results.map((t) => t.id).sort((x, y) => x - y)).toEqual([a.id, b.id].sort((x, y) => x - y));
    expect(await countTickets(prisma, { status: [TicketStatus.OPEN, TicketStatus.REPLIED] })).toBe(2);
  });

  it("priority filters on a single value and an array", async () => {
    const a = await makeTicket({ priority: TicketPriority.URGENT });
    const b = await makeTicket({ priority: TicketPriority.HIGH });
    await makeTicket({ priority: TicketPriority.LOW });

    expect((await listTickets(prisma, { priority: TicketPriority.URGENT })).map((t) => t.id)).toEqual([a.id]);
    const results = await listTickets(prisma, { priority: [TicketPriority.URGENT, TicketPriority.HIGH] });
    expect(results.map((t) => t.id).sort((x, y) => x - y)).toEqual([a.id, b.id].sort((x, y) => x - y));
  });

  it("category filters on a single value and an array", async () => {
    const a = await makeTicket({ category: TicketCategory.PAYMENT });
    const b = await makeTicket({ category: TicketCategory.ORDER });
    await makeTicket({ category: null });

    expect((await listTickets(prisma, { category: TicketCategory.PAYMENT })).map((t) => t.id)).toEqual([a.id]);
    const results = await listTickets(prisma, { category: [TicketCategory.PAYMENT, TicketCategory.ORDER] });
    expect(results.map((t) => t.id).sort((x, y) => x - y)).toEqual([a.id, b.id].sort((x, y) => x - y));
  });

  it("assignedAdminId filters to a specific admin id", async () => {
    const a = await makeTicket({ adminId });
    await makeTicket({ adminId: null });

    const results = await listTickets(prisma, { assignedAdminId: adminId });
    expect(results.map((t) => t.id)).toEqual([a.id]);
    expect(await countTickets(prisma, { assignedAdminId: adminId })).toBe(1);
  });

  it('assignedAdminId: "unassigned" sentinel filters to adminId === null', async () => {
    const a = await makeTicket({ adminId: null });
    await makeTicket({ adminId });

    const results = await listTickets(prisma, { assignedAdminId: "unassigned" });
    expect(results.map((t) => t.id)).toEqual([a.id]);
    expect(await countTickets(prisma, { assignedAdminId: "unassigned" })).toBe(1);
  });

  it("since/until filter on createdAt as an inclusive range", async () => {
    const now = Date.now();
    const old = await makeTicket({ createdAt: new Date(now - 5 * 24 * 60 * 60 * 1000) });
    const recent = await makeTicket({ createdAt: new Date(now - 1 * 24 * 60 * 60 * 1000) });
    await makeTicket({ createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000) }); // too old, excluded by since

    const results = await listTickets(prisma, {
      since: new Date(now - 3 * 24 * 60 * 60 * 1000),
      until: new Date(now),
    });
    expect(results.map((t) => t.id)).toEqual([recent.id]);
    expect(old.id).not.toBe(recent.id); // sanity: `old` really is a distinct row
  });

  it("q matches the ticket message", async () => {
    const a = await makeTicket({ message: "my payment failed to go through" });
    await makeTicket({ message: "unrelated question" });

    const results = await listTickets(prisma, { q: "payment failed" });
    expect(results.map((t) => t.id)).toEqual([a.id]);
    expect(await countTickets(prisma, { q: "payment failed" })).toBe(1);
  });

  it("q matches the customer's username, fullName, or loginUsername", async () => {
    const buyer = await prisma.user.create({
      data: {
        telegramId: BigInt(998877),
        referralCode: `r${Math.random()}`,
        username: "searchuname",
        fullName: "Search Fullname",
        loginUsername: "searchlogin",
      },
    });
    const ticket = await makeTicket({ userId: buyer.id, message: "generic issue" });

    for (const term of ["searchuname", "Search Fullname", "searchlogin"]) {
      const results = await listTickets(prisma, { q: term });
      expect(results.map((t) => t.id), `q="${term}" should match`).toContain(ticket.id);
    }
  });

  it("pagination: limit/offset control the page, ordered newest-first", async () => {
    const now = Date.now();
    const oldest = await makeTicket({ createdAt: new Date(now - 3000) });
    const middle = await makeTicket({ createdAt: new Date(now - 2000) });
    const newest = await makeTicket({ createdAt: new Date(now - 1000) });

    const page1 = await listTickets(prisma, { limit: 2, offset: 0 });
    expect(page1.map((t) => t.id)).toEqual([newest.id, middle.id]);

    const page2 = await listTickets(prisma, { limit: 2, offset: 2 });
    expect(page2.map((t) => t.id)).toEqual([oldest.id]);
  });

  it("defaults to a limit of 50 and offset 0 when unspecified", async () => {
    for (let i = 0; i < 3; i++) await makeTicket();
    const results = await listTickets(prisma);
    expect(results).toHaveLength(3);
  });
});

describe("ticketKpis", () => {
  it("counts open/waitingCustomer/resolved/unassigned/closedToday/overdue independently", async () => {
    const now = new Date();
    const wayPast = new Date(now.getTime() - (OVERDUE_THRESHOLD_HOURS + 1) * 60 * 60 * 1000);

    // open (OPEN status)
    await makeTicket({ status: TicketStatus.OPEN, adminId }); // assigned -> not counted unassigned
    await makeTicket({ status: TicketStatus.OPEN, adminId: null, lastStatusChangeAt: wayPast }); // unassigned + overdue
    // waitingCustomer (REPLIED status) — assigned, so it doesn't also bump
    // `unassigned` (which is scoped to OPEN/REPLIED with adminId null).
    await makeTicket({ status: TicketStatus.REPLIED, adminId });
    // resolved
    await makeTicket({ status: TicketStatus.RESOLVED });
    // closed today
    await makeTicket({ status: TicketStatus.CLOSED, closedAt: now });
    // closed, but not today — must not count toward closedToday
    await makeTicket({
      status: TicketStatus.CLOSED,
      closedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    });
    // A RESOLVED ticket sitting past the threshold must NOT count as overdue —
    // overdue only applies to the active OPEN/REPLIED queue.
    await makeTicket({ status: TicketStatus.RESOLVED, lastStatusChangeAt: wayPast });

    const kpis = await ticketKpis(prisma);
    expect(kpis).toEqual({
      open: 2,
      waitingCustomer: 1,
      resolved: 2,
      unassigned: 1,
      closedToday: 1,
      overdue: 1,
    });
  });
});

describe("isTicketOverdue / overdueCutoff (pure functions, no DB)", () => {
  it("overdueCutoff returns `now` minus OVERDUE_THRESHOLD_HOURS", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const cutoff = overdueCutoff(now);
    expect(cutoff.getTime()).toBe(now.getTime() - OVERDUE_THRESHOLD_HOURS * 60 * 60 * 1000);
  });

  it("an OPEN ticket past the threshold is overdue", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const lastStatusChangeAt = new Date(now.getTime() - (OVERDUE_THRESHOLD_HOURS + 1) * 60 * 60 * 1000);
    expect(isTicketOverdue({ status: TicketStatus.OPEN, lastStatusChangeAt }, now)).toBe(true);
  });

  it("a REPLIED ticket past the threshold is overdue", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const lastStatusChangeAt = new Date(now.getTime() - (OVERDUE_THRESHOLD_HOURS + 1) * 60 * 60 * 1000);
    expect(isTicketOverdue({ status: TicketStatus.REPLIED, lastStatusChangeAt }, now)).toBe(true);
  });

  it("an OPEN ticket within the threshold is not overdue", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const lastStatusChangeAt = new Date(now.getTime() - (OVERDUE_THRESHOLD_HOURS - 1) * 60 * 60 * 1000);
    expect(isTicketOverdue({ status: TicketStatus.OPEN, lastStatusChangeAt }, now)).toBe(false);
  });

  it("a RESOLVED or CLOSED ticket is never overdue, no matter how old", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const ancient = new Date(now.getTime() - 999 * 60 * 60 * 1000);
    expect(isTicketOverdue({ status: TicketStatus.RESOLVED, lastStatusChangeAt: ancient }, now)).toBe(false);
    expect(isTicketOverdue({ status: TicketStatus.CLOSED, lastStatusChangeAt: ancient }, now)).toBe(false);
  });
});

describe("resolveTicket", () => {
  it("transitions OPEN -> RESOLVED, stamping resolvedAt and lastStatusChangeAt", async () => {
    const stale = new Date(Date.now() - 60_000);
    const ticket = await makeTicket({ status: TicketStatus.OPEN, lastStatusChangeAt: stale });

    const result = await resolveTicket(prisma, ticket.id);
    expect(result).toBe(true);

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.RESOLVED);
    expect(fresh!.resolvedAt).not.toBeNull();
    expect(fresh!.lastStatusChangeAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("transitions REPLIED -> RESOLVED", async () => {
    const ticket = await makeTicket({ status: TicketStatus.REPLIED });
    expect(await resolveTicket(prisma, ticket.id)).toBe(true);
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.RESOLVED);
  });

  it("is a double-tap-safe no-op once already RESOLVED", async () => {
    const ticket = await makeTicket({ status: TicketStatus.OPEN });
    expect(await resolveTicket(prisma, ticket.id)).toBe(true);
    const afterFirst = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });

    expect(await resolveTicket(prisma, ticket.id)).toBe(false);
    const afterSecond = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(afterSecond!.resolvedAt!.getTime()).toBe(afterFirst!.resolvedAt!.getTime());
    expect(afterSecond!.lastStatusChangeAt.getTime()).toBe(afterFirst!.lastStatusChangeAt.getTime());
  });

  it("is a no-op once CLOSED — resolving a closed ticket must not resurrect it", async () => {
    const ticket = await makeTicket({ status: TicketStatus.CLOSED });
    expect(await resolveTicket(prisma, ticket.id)).toBe(false);
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.CLOSED);
    expect(fresh!.resolvedAt).toBeNull();
  });
});

describe("reopenTicket", () => {
  it("reopens a ticket closed within the window, clearing closedAt", async () => {
    const user = await makeUser(920n);
    const ticket = await createTicket(prisma, user.id, "help");
    await closeTicket(prisma, ticket.id);

    const result = await reopenTicket(prisma, ticket.id);
    expect(result).toEqual({ ok: true });
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.OPEN);
    expect(fresh!.closedAt).toBeNull();
  });

  it("refuses to reopen a ticket that isn't CLOSED", async () => {
    const user = await makeUser(921n);
    const ticket = await createTicket(prisma, user.id, "help"); // still OPEN
    const result = await reopenTicket(prisma, ticket.id);
    expect(result).toEqual({ ok: false, reason: "not_closed" });
  });

  it("refuses to reopen once the window has expired", async () => {
    const user = await makeUser(922n);
    const ticket = await createTicket(prisma, user.id, "help");
    await closeTicket(prisma, ticket.id);
    // Backdate closedAt past the window — no real clock waiting needed.
    const wayPast = new Date(Date.now() - (TICKET_REOPEN_WINDOW_DAYS + 1) * 86_400_000);
    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { closedAt: wayPast } });

    const result = await reopenTicket(prisma, ticket.id);
    expect(result).toEqual({ ok: false, reason: "window_expired" });
  });

  it("returns not_closed for a non-existent ticket", async () => {
    expect(await reopenTicket(prisma, 999999)).toEqual({ ok: false, reason: "not_closed" });
  });
});

describe("reopenTicketAdmin", () => {
  it("transitions CLOSED -> OPEN and clears closedAt", async () => {
    const stale = new Date(Date.now() - 60_000);
    const ticket = await makeTicket({
      status: TicketStatus.CLOSED,
      closedAt: new Date(),
      lastStatusChangeAt: stale,
    });

    const result = await reopenTicketAdmin(prisma, ticket.id);
    expect(result).toBe(true);

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.OPEN);
    expect(fresh!.closedAt).toBeNull();
    expect(fresh!.lastStatusChangeAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("is a no-op on a non-CLOSED ticket (e.g. OPEN or RESOLVED)", async () => {
    const openTicket = await makeTicket({ status: TicketStatus.OPEN });
    expect(await reopenTicketAdmin(prisma, openTicket.id)).toBe(false);

    const resolvedTicket = await makeTicket({ status: TicketStatus.RESOLVED });
    expect(await reopenTicketAdmin(prisma, resolvedTicket.id)).toBe(false);
    const fresh = await prisma.supportTicket.findUnique({ where: { id: resolvedTicket.id } });
    expect(fresh!.status).toBe(TicketStatus.RESOLVED);
  });
});

describe("classifyTicket", () => {
  it("updates priority independently, leaving category/status untouched", async () => {
    const ticket = await makeTicket({ priority: TicketPriority.MEDIUM, category: null, status: TicketStatus.OPEN });
    const updated = await classifyTicket(prisma, ticket.id, { priority: TicketPriority.URGENT });
    expect(updated.priority).toBe(TicketPriority.URGENT);
    expect(updated.category).toBeNull();
    expect(updated.status).toBe(TicketStatus.OPEN); // no status side effect
  });

  it("updates category independently, leaving priority untouched", async () => {
    const ticket = await makeTicket({ priority: TicketPriority.MEDIUM, category: null });
    const updated = await classifyTicket(prisma, ticket.id, { category: TicketCategory.PAYMENT });
    expect(updated.priority).toBe(TicketPriority.MEDIUM); // untouched
    expect(updated.category).toBe(TicketCategory.PAYMENT);
  });

  it("updates both priority and category together, with no lastStatusChangeAt side effect", async () => {
    const ticket = await makeTicket({ status: TicketStatus.OPEN });
    const before = ticket.lastStatusChangeAt;
    const updated = await classifyTicket(prisma, ticket.id, {
      priority: TicketPriority.HIGH,
      category: TicketCategory.ACCOUNT,
    });
    expect(updated.priority).toBe(TicketPriority.HIGH);
    expect(updated.category).toBe(TicketCategory.ACCOUNT);
    expect(updated.status).toBe(TicketStatus.OPEN);
    expect(updated.lastStatusChangeAt.getTime()).toBe(before.getTime());
  });
});

describe("addTicketMessage — firstResponseAt 'set once' + RESOLVED->OPEN reopen path", () => {
  it("the first admin message sets firstResponseAt", async () => {
    const ticket = await makeTicket({ status: TicketStatus.OPEN });
    expect(ticket.firstResponseAt).toBeNull();

    await addTicketMessage(prisma, {
      ticketId: ticket.id,
      senderType: SenderType.ADMIN,
      senderId: adminId,
      content: "first reply",
    });

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.firstResponseAt).not.toBeNull();
    expect(fresh!.status).toBe(TicketStatus.REPLIED);
  });

  it("a later admin reply after a customer reopens must NOT move firstResponseAt", async () => {
    const ticket = await makeTicket({ status: TicketStatus.OPEN });

    await addTicketMessage(prisma, {
      ticketId: ticket.id,
      senderType: SenderType.ADMIN,
      senderId: adminId,
      content: "first reply",
    });
    const afterFirstReply = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    const firstResponseAt = afterFirstReply!.firstResponseAt!;

    // Customer message reopens the ticket (status -> OPEN).
    await addTicketMessage(prisma, {
      ticketId: ticket.id,
      senderType: SenderType.USER,
      senderId: userId,
      content: "still broken",
    });
    const afterUserReply = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(afterUserReply!.status).toBe(TicketStatus.OPEN);

    // Second admin reply — firstResponseAt must stay exactly what it was.
    await addTicketMessage(prisma, {
      ticketId: ticket.id,
      senderType: SenderType.ADMIN,
      senderId: adminId,
      content: "second reply",
    });
    const afterSecondReply = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(afterSecondReply!.firstResponseAt!.getTime()).toBe(firstResponseAt.getTime());
    expect(afterSecondReply!.status).toBe(TicketStatus.REPLIED);
  });

  it("a USER message stamps lastStatusChangeAt and sets status OPEN, without touching firstResponseAt", async () => {
    const stale = new Date(Date.now() - 60_000);
    const ticket = await makeTicket({ status: TicketStatus.REPLIED, lastStatusChangeAt: stale });
    await addTicketMessage(prisma, {
      ticketId: ticket.id,
      senderType: SenderType.USER,
      senderId: userId,
      content: "one more question",
    });
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.OPEN);
    expect(fresh!.firstResponseAt).toBeNull();
    expect(fresh!.lastStatusChangeAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("RESOLVED -> OPEN reopen path: a customer message on a resolved ticket reopens it", async () => {
    const ticket = await makeTicket({ status: TicketStatus.RESOLVED, resolvedAt: new Date() });
    await addTicketMessage(prisma, {
      ticketId: ticket.id,
      senderType: SenderType.USER,
      senderId: userId,
      content: "actually still broken",
    });
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.OPEN);
  });
});
