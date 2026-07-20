/**
 * closeTicket atomic guard — Bot-3 fix (security audit, 2026-06-23). Was a
 * read-then-write with no conditional guard, so a double-tap "Close" could
 * fire the buyer-notification DM twice. Now an atomic updateMany — only the
 * call that actually flips CLOSED gets a non-null return.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { closeTicket, createTicket, addTicketMessage } from "./support";
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
