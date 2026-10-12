import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../tests/helpers/testdb";
import { backfillTicketNumbers } from "./backfill-ticket-numbers";
let db: TestDb;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db.cleanup(); });
it("backfills missing references repeatably while preserving history and issued numbers", async () => {
  const user = await db.prisma.user.create({ data: { referralCode: randomUUID() } });
  const createdAt = new Date("2025-01-03T12:30:00Z");
  const historic = await db.prisma.supportTicket.create({ data: { userId: user.id, message: "Historical support request", createdAt, status: "RESOLVED" } });
  const issued = await db.prisma.supportTicket.create({ data: { userId: user.id, message: "Already issued", ticketNumber: "TCK-EXISTING-123", createdAt } });
  const reply = await db.prisma.ticketMessage.create({ data: { ticketId: historic.id, senderType: "USER", senderId: user.id, content: "Historical reply", createdAt } });
  expect(await backfillTicketNumbers(db.prisma)).toBe(1);
  expect(await backfillTicketNumbers(db.prisma)).toBe(0);
  expect(await db.prisma.supportTicket.findUnique({ where: { id: historic.id } })).toMatchObject({ ticketNumber: expect.stringMatching(/^TKT-20250103-[A-F0-9]{6}$/), createdAt, status: "RESOLVED", message: historic.message });
  expect(await db.prisma.supportTicket.findUnique({ where: { id: issued.id } })).toMatchObject({ ticketNumber: issued.ticketNumber, createdAt });
  expect(await db.prisma.ticketMessage.findUnique({ where: { id: reply.id } })).toMatchObject(reply);
});
