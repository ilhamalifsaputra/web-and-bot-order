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
} from "./support";
import { TicketStatus, SenderType } from "@app/core/enums";

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
  await prisma.user.deleteMany();
});

async function makeUser(telegramId: bigint | null) {
  return prisma.user.create({ data: { telegramId, referralCode: `r${Math.random()}` } });
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
  });

  it("a second call on an already-CLOSED ticket returns false (no-op)", async () => {
    const user = await makeUser(911n);
    const ticket = await createTicket(prisma, user.id, "help");
    expect(await closeTicketByUser(prisma, ticket.id)).toBe(true);
    expect(await closeTicketByUser(prisma, ticket.id)).toBe(false);
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
