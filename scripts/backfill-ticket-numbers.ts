import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { prisma, uniqueTicketNumberCandidate } from "@app/db";

/** Additive, repeatable: issued references and every business timestamp stay intact. */
export async function backfillTicketNumbers(db: PrismaClient = prisma) {
  let count = 0;
  for (;;) {
    const rows = await db.supportTicket.findMany({ where: { ticketNumber: null }, select: { id: true, createdAt: true }, take: 100 });
    if (!rows.length) return count;
    for (const row of rows) {
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          const updated = await db.supportTicket.updateMany({ where: { id: row.id, ticketNumber: null }, data: { ticketNumber: await uniqueTicketNumberCandidate(db, row.createdAt) } });
          count += updated.count; break;
        } catch (err) {
          if (!(err instanceof Error && "code" in err && err.code === "P2002") || attempt === 24) throw err;
        }
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  backfillTicketNumbers().then((count) => console.log(`Assigned public references to ${count} historical tickets.`)).catch(() => {
    console.error("Ticket reference backfill failed. Existing references are preserved; inspect the database before retrying.");
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}
