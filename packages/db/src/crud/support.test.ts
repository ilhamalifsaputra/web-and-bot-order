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
  reopenTicketAdmin,
  replyToTicket,
  resolveTicket,
  classifyTicket,
  TICKET_REOPEN_WINDOW_DAYS,
  listTicketsPaged,
  countTickets,
  getTicketStats,
  bulkAssignTickets,
  bulkSetTicketPriority,
  bulkCloseTickets,
} from "./support";
import { TicketStatus, TicketPriority, TicketCategory, SenderType } from "@app/core/enums";
import { addMinutes, addDays } from "@app/core/datetime";

let db: TestDb;
let prisma: PrismaClient;

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
});

async function makeUser(
  telegramId: bigint | null,
  extra: { fullName?: string; username?: string } = {},
) {
  return prisma.user.create({
    data: { telegramId, referralCode: `r${Math.random()}`, ...extra },
  });
}

async function makeAdmin() {
  return prisma.user.create({
    data: { referralCode: `a${Math.random()}`, role: "ADMIN" },
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
    // M-29: closeTicketByUser must stamp lastStatusChangeAt too.
    expect(fresh!.lastStatusChangeAt.getTime()).toBe(fresh!.closedAt!.getTime());
  });

  it("a second call on an already-CLOSED ticket returns false (no-op)", async () => {
    const user = await makeUser(911n);
    const ticket = await createTicket(prisma, user.id, "help");
    expect(await closeTicketByUser(prisma, ticket.id)).toBe(true);
    expect(await closeTicketByUser(prisma, ticket.id)).toBe(false);
  });
});

describe("reopenTicket", () => {
  it("reopens a ticket closed within the window, clearing closedAt and stamping lastStatusChangeAt", async () => {
    const user = await makeUser(920n);
    const ticket = await createTicket(prisma, user.id, "help");
    await closeTicket(prisma, ticket.id);
    const closed = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });

    const result = await reopenTicket(prisma, ticket.id);
    expect(result).toEqual({ ok: true });
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.OPEN);
    expect(fresh!.closedAt).toBeNull();
    // M-29: reopenTicket must stamp lastStatusChangeAt (the admin queue's
    // "Waiting since" column reads this), not just leave the stale value
    // from the earlier close.
    expect(fresh!.lastStatusChangeAt.getTime()).toBeGreaterThan(closed!.lastStatusChangeAt.getTime());
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

// M-29: replyToTicket (the bot's admin-reply path) was silently leaving
// lastStatusChangeAt/firstResponseAt stale — only addTicketMessage stamped
// them. These assert replyToTicket is correct standalone, independent of
// whichever caller also happens to call addTicketMessage afterward.
describe("replyToTicket", () => {
  it("stamps lastStatusChangeAt and sets firstResponseAt on the first reply", async () => {
    const user = await makeUser(930n);
    const admin = await makeAdmin();
    const ticket = await createTicket(prisma, user.id, "help");
    expect(ticket.firstResponseAt).toBeNull();

    const tgId = await replyToTicket(prisma, { ticketId: ticket.id, reply: "on it", adminDbId: admin.id });

    expect(tgId).toBe(930n);
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.REPLIED);
    expect(fresh!.repliedAt).not.toBeNull();
    expect(fresh!.lastStatusChangeAt.getTime()).toBeGreaterThan(ticket.lastStatusChangeAt.getTime());
    expect(fresh!.firstResponseAt).not.toBeNull();
    expect(fresh!.firstResponseAt!.getTime()).toBe(fresh!.repliedAt!.getTime());
  });

  it("does NOT overwrite firstResponseAt on a second reply, but still bumps lastStatusChangeAt", async () => {
    const user = await makeUser(931n);
    const admin = await makeAdmin();
    const ticket = await createTicket(prisma, user.id, "help");

    await replyToTicket(prisma, { ticketId: ticket.id, reply: "first reply", adminDbId: admin.id });
    const afterFirst = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });

    await replyToTicket(prisma, { ticketId: ticket.id, reply: "second reply", adminDbId: admin.id });
    const afterSecond = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });

    expect(afterSecond!.firstResponseAt!.getTime()).toBe(afterFirst!.firstResponseAt!.getTime());
    expect(afterSecond!.lastStatusChangeAt.getTime()).toBeGreaterThan(afterFirst!.lastStatusChangeAt.getTime());
    expect(afterSecond!.repliedAt!.getTime()).toBeGreaterThan(afterFirst!.repliedAt!.getTime());
  });

  it("returns null for a non-existent ticket", async () => {
    const admin = await makeAdmin();
    expect(await replyToTicket(prisma, { ticketId: 999999, reply: "x", adminDbId: admin.id })).toBeNull();
  });
});

describe("listTicketsPaged / countTickets — filtering + pagination", () => {
  it("filters by status (single and array)", async () => {
    const user = await makeUser(1001n);
    const open = await createTicket(prisma, user.id, "open ticket");
    const replied = await createTicket(prisma, user.id, "replied ticket");
    await prisma.supportTicket.update({ where: { id: replied.id }, data: { status: TicketStatus.REPLIED } });
    const closed = await createTicket(prisma, user.id, "closed ticket");
    await closeTicket(prisma, closed.id);

    const openOnly = await listTicketsPaged(prisma, { status: TicketStatus.OPEN });
    expect(openOnly.map((t) => t.id)).toEqual([open.id]);

    const openOrReplied = await listTicketsPaged(prisma, {
      status: [TicketStatus.OPEN, TicketStatus.REPLIED],
    });
    expect(new Set(openOrReplied.map((t) => t.id))).toEqual(new Set([open.id, replied.id]));

    expect(await countTickets(prisma, { status: TicketStatus.CLOSED })).toBe(1);
  });

  it("filters by priority (single and array)", async () => {
    const user = await makeUser(1002n);
    const low = await createTicket(prisma, user.id, "low prio");
    await prisma.supportTicket.update({ where: { id: low.id }, data: { priority: TicketPriority.LOW } });
    const high = await createTicket(prisma, user.id, "high prio");
    await prisma.supportTicket.update({ where: { id: high.id }, data: { priority: TicketPriority.HIGH } });
    const urgent = await createTicket(prisma, user.id, "urgent prio");
    await prisma.supportTicket.update({ where: { id: urgent.id }, data: { priority: TicketPriority.URGENT } });

    const highOnly = await listTicketsPaged(prisma, { priority: TicketPriority.HIGH });
    expect(highOnly.map((t) => t.id)).toEqual([high.id]);

    const highOrUrgent = await listTicketsPaged(prisma, {
      priority: [TicketPriority.HIGH, TicketPriority.URGENT],
    });
    expect(new Set(highOrUrgent.map((t) => t.id))).toEqual(new Set([high.id, urgent.id]));

    expect(await countTickets(prisma, { priority: TicketPriority.LOW })).toBe(1);
  });

  it("filters by assigned/unassigned", async () => {
    const user = await makeUser(1003n);
    const admin = await makeAdmin();
    const assigned = await createTicket(prisma, user.id, "assigned ticket");
    await prisma.supportTicket.update({ where: { id: assigned.id }, data: { adminId: admin.id } });
    const unassigned = await createTicket(prisma, user.id, "unassigned ticket");

    expect((await listTicketsPaged(prisma, { assigned: "assigned" })).map((t) => t.id)).toEqual([assigned.id]);
    expect((await listTicketsPaged(prisma, { assigned: "unassigned" })).map((t) => t.id)).toEqual([
      unassigned.id,
    ]);
  });

  it("filters by adminId (a specific assignee)", async () => {
    const user = await makeUser(1004n);
    const adminA = await makeAdmin();
    const adminB = await makeAdmin();
    const ticketA = await createTicket(prisma, user.id, "for admin A");
    await prisma.supportTicket.update({ where: { id: ticketA.id }, data: { adminId: adminA.id } });
    const ticketB = await createTicket(prisma, user.id, "for admin B");
    await prisma.supportTicket.update({ where: { id: ticketB.id }, data: { adminId: adminB.id } });

    expect((await listTicketsPaged(prisma, { adminId: adminA.id })).map((t) => t.id)).toEqual([ticketA.id]);
  });

  it("filters by overdue (OPEN, lastStatusChangeAt older than 4h)", async () => {
    const user = await makeUser(1005n);
    const overdue = await createTicket(prisma, user.id, "old open ticket");
    await prisma.supportTicket.update({
      where: { id: overdue.id },
      data: { lastStatusChangeAt: addMinutes(new Date(), -300) }, // 5h since its wait-clock reset
    });
    const fresh = await createTicket(prisma, user.id, "fresh open ticket"); // just created
    const repliedOld = await createTicket(prisma, user.id, "old but replied");
    await prisma.supportTicket.update({
      where: { id: repliedOld.id },
      data: {
        status: TicketStatus.REPLIED,
        repliedAt: new Date(),
        lastStatusChangeAt: new Date(), // replying resets the wait-clock — not overdue
      },
    });

    const overdueList = await listTicketsPaged(prisma, { overdue: true });
    expect(overdueList.map((t) => t.id)).toEqual([overdue.id]);
    void fresh;
  });

  it("M-31: a customer follow-up on an already-answered ticket (status flips back to OPEN, repliedAt NOT cleared) becomes overdue once its wait-clock passes the cutoff — invisible under the old repliedAt-IS-NULL predicate", async () => {
    const user = await makeUser(1051n);
    const admin = await makeAdmin();

    // Ticket created, then answered by an admin — repliedAt gets set.
    const ticket = await createTicket(prisma, user.id, "still broken?");
    await replyToTicket(prisma, { ticketId: ticket.id, reply: "try again", adminDbId: admin.id });
    const afterReply = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(afterReply!.status).toBe(TicketStatus.REPLIED);
    expect(afterReply!.repliedAt).not.toBeNull();

    // Customer follows up ("still not fixed") — addTicketMessage flips status
    // back to OPEN and resets lastStatusChangeAt (Task 38), but deliberately
    // does NOT clear repliedAt.
    await addTicketMessage(prisma, {
      ticketId: ticket.id,
      senderType: SenderType.USER,
      senderId: user.id,
      content: "still not fixed",
    });
    const afterFollowUp = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(afterFollowUp!.status).toBe(TicketStatus.OPEN);
    expect(afterFollowUp!.repliedAt).not.toBeNull(); // NOT cleared — this is the bug's precondition

    // Age it past the overdue cutoff relative to lastStatusChangeAt (the
    // follow-up's reset point), not createdAt.
    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { lastStatusChangeAt: addMinutes(new Date(), -241) }, // 1 minute past the 240-minute cutoff
    });

    // Prisma path (ticketWhere, via countTickets/listTicketsPaged default sort).
    expect(await countTickets(prisma, { overdue: true })).toBe(1);
    const viaPrisma = await listTicketsPaged(prisma, { overdue: true });
    expect(viaPrisma.map((t) => t.id)).toEqual([ticket.id]);

    // Raw-SQL path (ticketWhereRaw, only reachable via sort: "priority").
    const viaRawSql = await listTicketsPaged(prisma, { overdue: true, sort: "priority" });
    expect(viaRawSql.map((t) => t.id)).toEqual([ticket.id]);

    // Companion case: a ticket that's genuinely still just "answered, no
    // follow-up yet" (REPLIED, repliedAt old) must stay excluded — replying
    // resets the wait-clock, so it's not overdue even though repliedAt itself
    // is old. Proves the fix isn't simply "always OPEN-or-REPLIED".
    const answeredNoFollowUp = await createTicket(prisma, user.id, "answered, no reply from customer yet");
    await replyToTicket(prisma, { ticketId: answeredNoFollowUp.id, reply: "here's the fix", adminDbId: admin.id });
    await prisma.supportTicket.update({
      where: { id: answeredNoFollowUp.id },
      data: { repliedAt: addMinutes(new Date(), -300), lastStatusChangeAt: addMinutes(new Date(), -300) },
    });
    const stillExcluded = await prisma.supportTicket.findUnique({ where: { id: answeredNoFollowUp.id } });
    expect(stillExcluded!.status).toBe(TicketStatus.REPLIED); // not OPEN → excluded regardless of age

    const finalOverdue = await listTicketsPaged(prisma, { overdue: true });
    expect(finalOverdue.map((t) => t.id)).toEqual([ticket.id]);
    expect(finalOverdue.map((t) => t.id)).not.toContain(answeredNoFollowUp.id);
  });

  it("q searches message content and the related user's fullName/username", async () => {
    const user = await makeUser(1006n, { fullName: "Alice Wonderland", username: "alicew" });
    const other = await makeUser(1007n, { fullName: "Bob Builder" });
    const byMessage = await createTicket(prisma, other.id, "my payment is broken");
    const byName = await createTicket(prisma, user.id, "unrelated text");

    const found = await listTicketsPaged(prisma, { q: "broken" });
    expect(found.map((t) => t.id)).toEqual([byMessage.id]);

    const foundByName = await listTicketsPaged(prisma, { q: "Wonderland" });
    expect(foundByName.map((t) => t.id)).toEqual([byName.id]);

    const foundByUsername = await listTicketsPaged(prisma, { q: "alicew" });
    expect(foundByUsername.map((t) => t.id)).toEqual([byName.id]);
  });

  it("paginates with limit/offset and sorts newest/oldest", async () => {
    const user = await makeUser(1008n);
    const t1 = await createTicket(prisma, user.id, "first");
    await new Promise((r) => setTimeout(r, 5));
    const t2 = await createTicket(prisma, user.id, "second");
    await new Promise((r) => setTimeout(r, 5));
    const t3 = await createTicket(prisma, user.id, "third");

    const newestFirst = await listTicketsPaged(prisma, { sort: "newest" });
    expect(newestFirst.map((t) => t.id)).toEqual([t3.id, t2.id, t1.id]);

    const oldestFirst = await listTicketsPaged(prisma, { sort: "oldest" });
    expect(oldestFirst.map((t) => t.id)).toEqual([t1.id, t2.id, t3.id]);

    const page1 = await listTicketsPaged(prisma, { sort: "newest", limit: 2, offset: 0 });
    const page2 = await listTicketsPaged(prisma, { sort: "newest", limit: 2, offset: 2 });
    expect(page1.map((t) => t.id)).toEqual([t3.id, t2.id]);
    expect(page2.map((t) => t.id)).toEqual([t1.id]);

    expect(await countTickets(prisma)).toBe(3);
  });

  it("sorts by priority (URGENT > HIGH > MEDIUM > LOW), stable within a page", async () => {
    const user = await makeUser(1009n);
    const low = await createTicket(prisma, user.id, "low");
    const urgent = await createTicket(prisma, user.id, "urgent");
    await prisma.supportTicket.update({ where: { id: urgent.id }, data: { priority: TicketPriority.URGENT } });
    const medium = await createTicket(prisma, user.id, "medium"); // default MEDIUM

    const sorted = await listTicketsPaged(prisma, { sort: "priority" });
    expect(sorted.map((t) => t.id)).toEqual([urgent.id, medium.id, low.id]);
  });

  it("sort:priority is a TRUE global ORDER BY — surfaces an URGENT ticket that is NOT among the newest page's rows (not the old fetch-page-then-sort-in-memory shortcut)", async () => {
    const user = await makeUser(1050n);
    const pageSize = 20;

    // The very first ticket created (so it's the OLDEST — dead last in any
    // newest-first fetch) is URGENT. Everything created after it is MEDIUM,
    // and there are more than `pageSize` of them, so a "fetch page 1
    // newest-first, then sort just that page" implementation would never
    // even see this ticket on page 1 — it fixes the exact regression this
    // test guards against.
    const urgent = await createTicket(prisma, user.id, "urgent but ancient");
    await prisma.supportTicket.update({ where: { id: urgent.id }, data: { priority: TicketPriority.URGENT } });
    for (let i = 0; i < pageSize + 5; i++) {
      await createTicket(prisma, user.id, `newer medium ${i}`);
    }

    // Sanity check: confirm the urgent ticket genuinely is NOT among the
    // newest `pageSize` rows by creation time — otherwise this test would
    // pass even against the old buggy implementation.
    const newestPage = await listTicketsPaged(prisma, { sort: "newest", limit: pageSize, offset: 0 });
    expect(newestPage.map((t) => t.id)).not.toContain(urgent.id);

    const page1ByPriority = await listTicketsPaged(prisma, { sort: "priority", limit: pageSize, offset: 0 });
    expect(page1ByPriority[0]!.id).toBe(urgent.id);
    expect(page1ByPriority.map((t) => t.id)).toContain(urgent.id);
  });

  it("populates the related user (the bug fix listOpenTickets doesn't have)", async () => {
    const user = await makeUser(1010n, { fullName: "Populated User" });
    await createTicket(prisma, user.id, "hi");

    const rows = await listTicketsPaged(prisma, {});
    expect(rows[0]!.user).toBeDefined();
    expect(rows[0]!.user.fullName).toBe("Populated User");
  });
});

describe("getTicketStats", () => {
  it("counts open/waitingCustomer/overdue/unassigned/resolvedToday independently", async () => {
    const user = await makeUser(1101n);
    const admin = await makeAdmin();
    const now = new Date();

    // open, unassigned, not overdue
    await createTicket(prisma, user.id, "fresh open");

    // open, overdue, unassigned
    const overdueTicket = await createTicket(prisma, user.id, "stale open");
    await prisma.supportTicket.update({
      where: { id: overdueTicket.id },
      data: { lastStatusChangeAt: addMinutes(now, -300) },
    });

    // waiting on customer (REPLIED), assigned
    const repliedTicket = await createTicket(prisma, user.id, "replied");
    await prisma.supportTicket.update({
      where: { id: repliedTicket.id },
      data: { status: TicketStatus.REPLIED, repliedAt: now, adminId: admin.id },
    });

    // closed today
    const closedToday = await createTicket(prisma, user.id, "closed today");
    await closeTicket(prisma, closedToday.id);

    // closed yesterday — must NOT count in resolvedToday
    const closedYesterday = await createTicket(prisma, user.id, "closed yesterday");
    await closeTicket(prisma, closedYesterday.id);
    await prisma.supportTicket.update({
      where: { id: closedYesterday.id },
      data: { closedAt: addDays(now, -1) },
    });

    const stats = await getTicketStats(prisma, now);
    expect(stats.open).toBe(2); // fresh open + stale open
    expect(stats.waitingCustomer).toBe(1); // repliedTicket
    expect(stats.overdue).toBe(1); // stale open only
    expect(stats.unassigned).toBe(2); // fresh open + stale open (repliedTicket is assigned, closed ones excluded)
    expect(stats.resolvedToday).toBe(1); // closedToday only
  });

  it("overdue count agrees with countTickets({overdue:true}) on the same data — proves the KPI and the filter share one predicate, not two copies that happen to match", async () => {
    const user = await makeUser(1102n);
    const now = new Date();

    // OPEN + wait-clock old enough → overdue by both routes.
    const overdueTicket = await createTicket(prisma, user.id, "stale");
    await prisma.supportTicket.update({
      where: { id: overdueTicket.id },
      data: { lastStatusChangeAt: addMinutes(now, -241) }, // 1 minute past the 240-minute cutoff
    });
    // OPEN but just inside the window — NOT overdue by either route.
    const freshTicket = await createTicket(prisma, user.id, "fresh");
    await prisma.supportTicket.update({
      where: { id: freshTicket.id },
      data: { lastStatusChangeAt: addMinutes(now, -239) },
    });
    // Old but REPLIED — excluded from overdue by the "status = OPEN" clause
    // (replying is itself a status transition that resets the wait-clock).
    const repliedOld = await createTicket(prisma, user.id, "old but replied");
    await prisma.supportTicket.update({
      where: { id: repliedOld.id },
      data: { status: TicketStatus.REPLIED, repliedAt: now, lastStatusChangeAt: addMinutes(now, -300) },
    });

    const viaFilter = await countTickets(prisma, { overdue: true });
    const viaStats = (await getTicketStats(prisma, now)).overdue;

    expect(viaFilter).toBe(1);
    expect(viaStats).toBe(1);
    expect(viaStats).toBe(viaFilter);
  });
});

describe("bulk ticket operations", () => {
  it("bulkAssignTickets assigns/unassigns a batch and reports the succeeded ids", async () => {
    const user = await makeUser(1201n);
    const admin = await makeAdmin();
    const t1 = await createTicket(prisma, user.id, "a");
    const t2 = await createTicket(prisma, user.id, "b");

    const assigned = await bulkAssignTickets(prisma, [t1.id, t2.id], admin.id);
    expect(new Set(assigned.succeeded)).toEqual(new Set([t1.id, t2.id]));
    expect(assigned.failed).toEqual([]);
    const rows = await prisma.supportTicket.findMany({ where: { id: { in: [t1.id, t2.id] } } });
    expect(rows.every((r) => r.adminId === admin.id)).toBe(true);

    const unassigned = await bulkAssignTickets(prisma, [t1.id], null);
    expect(unassigned.succeeded).toEqual([t1.id]);
    expect(unassigned.failed).toEqual([]);
    const fresh = await prisma.supportTicket.findUnique({ where: { id: t1.id } });
    expect(fresh!.adminId).toBeNull();
  });

  it("bulkAssignTickets reports a non-existent id as failed rather than silently dropping it", async () => {
    const user = await makeUser(1206n);
    const admin = await makeAdmin();
    const t1 = await createTicket(prisma, user.id, "a");

    const result = await bulkAssignTickets(prisma, [t1.id, 999999], admin.id);
    expect(result.succeeded).toEqual([t1.id]);
    expect(result.failed).toEqual([{ id: 999999, error: "ticket not found" }]);
    const fresh = await prisma.supportTicket.findUnique({ where: { id: t1.id } });
    expect(fresh!.adminId).toBe(admin.id);
  });

  it("bulkSetTicketPriority sets priority on a batch and reports the succeeded ids", async () => {
    const user = await makeUser(1202n);
    const t1 = await createTicket(prisma, user.id, "a");
    const t2 = await createTicket(prisma, user.id, "b");

    const result = await bulkSetTicketPriority(prisma, [t1.id, t2.id], TicketPriority.URGENT);
    expect(new Set(result.succeeded)).toEqual(new Set([t1.id, t2.id]));
    expect(result.failed).toEqual([]);
    const rows = await prisma.supportTicket.findMany({ where: { id: { in: [t1.id, t2.id] } } });
    expect(rows.every((r) => r.priority === TicketPriority.URGENT)).toBe(true);
  });

  it("bulkSetTicketPriority reports a non-existent id as failed rather than silently dropping it", async () => {
    const user = await makeUser(1207n);
    const t1 = await createTicket(prisma, user.id, "a");

    const result = await bulkSetTicketPriority(prisma, [t1.id, 999999], TicketPriority.URGENT);
    expect(result.succeeded).toEqual([t1.id]);
    expect(result.failed).toEqual([{ id: 999999, error: "ticket not found" }]);
  });

  describe("bulkCloseTickets", () => {
    it("closes a batch of OPEN tickets, all succeeding", async () => {
      const user = await makeUser(1203n);
      const t1 = await createTicket(prisma, user.id, "a");
      const t2 = await createTicket(prisma, user.id, "b");

      const result = await bulkCloseTickets(prisma, [t1.id, t2.id]);
      expect(new Set(result.succeeded)).toEqual(new Set([t1.id, t2.id]));
      expect(result.failed).toEqual([]);
      const rows = await prisma.supportTicket.findMany({ where: { id: { in: [t1.id, t2.id] } } });
      expect(rows.every((r) => r.status === TicketStatus.CLOSED)).toBe(true);
    });

    it("a ticket already CLOSED in the batch is counted as already-done (succeeded), not double-processed", async () => {
      const user = await makeUser(1204n);
      const alreadyClosed = await createTicket(prisma, user.id, "already closed");
      await closeTicket(prisma, alreadyClosed.id);
      const firstClosedAt = (await prisma.supportTicket.findUnique({ where: { id: alreadyClosed.id } }))!
        .closedAt;
      const stillOpen = await createTicket(prisma, user.id, "still open");

      // A real clock tick between the first close and the bulk call below,
      // so an unconditional re-close (i.e. the guard NOT firing) would be
      // caught by the closedAt comparison — same tick margin as the
      // "SECOND close call" test in the closeTicket describe block above.
      await new Promise((r) => setTimeout(r, 5));

      const result = await bulkCloseTickets(prisma, [alreadyClosed.id, stillOpen.id]);
      expect(new Set(result.succeeded)).toEqual(new Set([alreadyClosed.id, stillOpen.id]));
      expect(result.failed).toEqual([]);
      // Confirm the double-tap guard actually fired (not just that the final
      // status happens to be CLOSED, which an unconditional re-close would
      // also produce): closedAt on the already-closed ticket is untouched by
      // bulkCloseTickets' pass over it.
      const after = await prisma.supportTicket.findUnique({ where: { id: alreadyClosed.id } });
      expect(after!.status).toBe(TicketStatus.CLOSED);
      expect(after!.closedAt?.getTime()).toBe(firstClosedAt?.getTime());
    });

    it("reports a non-existent id as failed", async () => {
      const user = await makeUser(1205n);
      const t1 = await createTicket(prisma, user.id, "a");

      const result = await bulkCloseTickets(prisma, [t1.id, 999999]);
      expect(result.succeeded).toEqual([t1.id]);
      expect(result.failed).toEqual([{ id: 999999, error: "ticket not found" }]);
    });
  });
});

describe("resolveTicket", () => {
  it("marks an OPEN ticket RESOLVED and stamps resolvedAt/lastStatusChangeAt", async () => {
    const user = await makeUser(1300n);
    const ticket = await createTicket(prisma, user.id, "help");
    const ok = await resolveTicket(prisma, ticket.id);
    expect(ok).toBe(true);
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.RESOLVED);
    expect(fresh!.resolvedAt).not.toBeNull();
    expect(fresh!.lastStatusChangeAt.getTime()).toBe(fresh!.resolvedAt!.getTime());
  });

  it("a second call on an already-RESOLVED ticket returns false (no-op)", async () => {
    const user = await makeUser(1301n);
    const ticket = await createTicket(prisma, user.id, "help");
    expect(await resolveTicket(prisma, ticket.id)).toBe(true);
    expect(await resolveTicket(prisma, ticket.id)).toBe(false);
  });

  it("refuses to resolve an already-CLOSED ticket", async () => {
    const user = await makeUser(1302n);
    const ticket = await createTicket(prisma, user.id, "help");
    await closeTicket(prisma, ticket.id);
    expect(await resolveTicket(prisma, ticket.id)).toBe(false);
  });
});

describe("reopenTicketAdmin", () => {
  it("reopens a CLOSED ticket to OPEN, clearing closedAt, with no time window", async () => {
    const user = await makeUser(1310n);
    const ticket = await createTicket(prisma, user.id, "help");
    await closeTicket(prisma, ticket.id);
    // Backdate closedAt well past TICKET_REOPEN_WINDOW_DAYS — the admin
    // route has no such window, unlike the customer-facing reopenTicket.
    const wayPast = new Date(Date.now() - (TICKET_REOPEN_WINDOW_DAYS + 30) * 86_400_000);
    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { closedAt: wayPast } });

    const ok = await reopenTicketAdmin(prisma, ticket.id);
    expect(ok).toBe(true);
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.OPEN);
    expect(fresh!.closedAt).toBeNull();
  });

  it("refuses to reopen a ticket that isn't CLOSED", async () => {
    const user = await makeUser(1311n);
    const ticket = await createTicket(prisma, user.id, "help"); // still OPEN
    expect(await reopenTicketAdmin(prisma, ticket.id)).toBe(false);
  });
});

describe("classifyTicket", () => {
  it("sets priority and category independently applied — omitting one leaves it as-is", async () => {
    const user = await makeUser(1320n);
    const ticket = await createTicket(prisma, user.id, "help");

    await classifyTicket(prisma, ticket.id, { priority: TicketPriority.URGENT });
    let fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.priority).toBe(TicketPriority.URGENT);
    expect(fresh!.category).toBeNull();

    await classifyTicket(prisma, ticket.id, { category: TicketCategory.PAYMENT });
    fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.priority).toBe(TicketPriority.URGENT);
    expect(fresh!.category).toBe(TicketCategory.PAYMENT);
  });

  it("an explicit null category clears it back to uncategorized", async () => {
    const user = await makeUser(1321n);
    const ticket = await createTicket(prisma, user.id, "help");
    await classifyTicket(prisma, ticket.id, { category: TicketCategory.ORDER });
    await classifyTicket(prisma, ticket.id, { category: null });
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.category).toBeNull();
  });
});

describe("listTicketsPaged / countTickets — category filter", () => {
  it("filters by category on the default (newest/oldest) sort path", async () => {
    const user = await makeUser(1330n);
    const payment = await createTicket(prisma, user.id, "payment issue");
    await classifyTicket(prisma, payment.id, { category: TicketCategory.PAYMENT });
    const order = await createTicket(prisma, user.id, "order issue");
    await classifyTicket(prisma, order.id, { category: TicketCategory.ORDER });

    const rows = await listTicketsPaged(prisma, { category: TicketCategory.PAYMENT });
    expect(rows.map((r) => r.id)).toEqual([payment.id]);
    expect(await countTickets(prisma, { category: TicketCategory.PAYMENT })).toBe(1);
  });

  it("filters by category on the sort:priority raw-SQL path too", async () => {
    const user = await makeUser(1331n);
    const payment = await createTicket(prisma, user.id, "payment issue");
    await classifyTicket(prisma, payment.id, { category: TicketCategory.PAYMENT, priority: TicketPriority.LOW });
    const order = await createTicket(prisma, user.id, "order issue");
    await classifyTicket(prisma, order.id, { category: TicketCategory.ORDER, priority: TicketPriority.URGENT });

    const rows = await listTicketsPaged(prisma, { category: TicketCategory.PAYMENT, sort: "priority" });
    expect(rows.map((r) => r.id)).toEqual([payment.id]);
  });
});

// M-36: ticketWhere (Prisma, used by countTickets and the default sort) and
// ticketWhereRaw (raw SQL, used only by sort:"priority") are now both derived
// from the single buildTicketConditions() list instead of being two
// hand-kept-in-sync predicates, so the header count and the priority-sorted
// page can no longer silently disagree on how many tickets match a filter.
describe("listTicketsPaged / countTickets — unified predicate (M-36)", () => {
  it("agree on the total for a search term containing % and _ (LIKE wildcard characters)", async () => {
    const user = await makeUser(1340n, { fullName: "Al%ce_W", username: "user_%name" });
    const other = await makeUser(1341n);
    // Both % and _ act as SQL LIKE wildcards on both the Prisma `contains`
    // path and the raw-SQL `LIKE` path (neither escapes them) — so as long as
    // the two paths wrap/bind the term identically, they match the same set.
    // This guards that invariant: if a future change (e.g. escaping one side
    // but not the other) breaks it, this test catches it as a count/list
    // mismatch rather than an admin silently seeing inconsistent numbers.
    await createTicket(prisma, other.id, "flash sale: 50%off_code applies");
    await createTicket(prisma, other.id, "50Xoffzcode also matches the wildcard reading");
    await createTicket(prisma, user.id, "totally unrelated message");

    const q = "50%off_";
    const count = await countTickets(prisma, { q });
    const priorityList = await listTicketsPaged(prisma, { q, sort: "priority", limit: 100, offset: 0 });
    const defaultList = await listTicketsPaged(prisma, { q, sort: "newest", limit: 100, offset: 0 });

    expect(count).toBe(2);
    expect(priorityList.map((t) => t.id).sort()).toEqual(defaultList.map((t) => t.id).sort());
    expect(priorityList.length).toBe(count);
  });

  it("agree when a search term matches via the related user's fullName/username, not just message, with % / _ present", async () => {
    const user = await makeUser(1342n, { fullName: "Bud%get_Buyer", username: "plainname" });
    const other = await makeUser(1343n, { fullName: "Someone Else" });
    await createTicket(prisma, user.id, "unrelated body text");
    await createTicket(prisma, other.id, "also unrelated");

    const q = "Bud%get_Buyer";
    const count = await countTickets(prisma, { q });
    const priorityList = await listTicketsPaged(prisma, { q, sort: "priority", limit: 100, offset: 0 });

    expect(count).toBe(1);
    expect(priorityList.length).toBe(1);
  });

  it("an explicit status filter combined with overdue:true agrees between countTickets and sort:priority — the concrete M-36 regression: the old ticketWhere unconditionally OVERWROTE where.status/where.lastStatusChangeAt inside the {overdue:true} branch (silently discarding an explicit status filter), while ticketWhereRaw only ever ADDed an extra AND condition (producing a contradiction — 0 rows — instead), so the two paths disagreed whenever a status filter incompatible with OPEN was combined with overdue:true", async () => {
    const user = await makeUser(1344n);
    // OPEN and overdue (matches the {overdue:true} predicate on its own).
    const overdueOpen = await createTicket(prisma, user.id, "old open ticket");
    await prisma.supportTicket.update({
      where: { id: overdueOpen.id },
      data: { lastStatusChangeAt: addMinutes(new Date(), -300) },
    });
    // REPLIED (not OPEN) — explicitly filtered for below, but incompatible
    // with overdue's implicit status=OPEN, so must NOT appear in the result
    // under either path.
    const repliedTicket = await createTicket(prisma, user.id, "replied ticket");
    await prisma.supportTicket.update({
      where: { id: repliedTicket.id },
      data: { status: TicketStatus.REPLIED },
    });

    const filter = { status: TicketStatus.REPLIED, overdue: true };
    const count = await countTickets(prisma, filter);
    const priorityList = await listTicketsPaged(prisma, { ...filter, sort: "priority", limit: 100, offset: 0 });
    const defaultList = await listTicketsPaged(prisma, { ...filter, sort: "newest", limit: 100, offset: 0 });

    // status=REPLIED (explicit) AND overdue's implicit status=OPEN is a
    // contradiction — correctly zero matches on every path, not "silently
    // ignore the status filter and return the OPEN overdue ticket instead".
    expect(count).toBe(0);
    expect(priorityList).toEqual([]);
    expect(defaultList).toEqual([]);
  });

  it("priority ordering itself is unchanged by the refactor — URGENT/HIGH/MEDIUM/LOW rank, ties newest-first, still comes from the raw SQL CASE expression, not from the (now-shared) predicate", async () => {
    const user = await makeUser(1345n);
    const low = await createTicket(prisma, user.id, "low");
    await prisma.supportTicket.update({ where: { id: low.id }, data: { priority: TicketPriority.LOW } });
    const urgent = await createTicket(prisma, user.id, "urgent");
    await prisma.supportTicket.update({ where: { id: urgent.id }, data: { priority: TicketPriority.URGENT } });
    const high = await createTicket(prisma, user.id, "high");
    await prisma.supportTicket.update({ where: { id: high.id }, data: { priority: TicketPriority.HIGH } });
    const medium = await createTicket(prisma, user.id, "medium");

    const sorted = await listTicketsPaged(prisma, { sort: "priority" });
    expect(sorted.map((t) => t.id)).toEqual([urgent.id, high.id, medium.id, low.id]);
  });
});
