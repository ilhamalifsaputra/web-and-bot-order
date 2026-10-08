import type { PrismaClient } from "@prisma/client";

/** URL legacy dipertahankan, tetapi akses harus cocok dengan pemilik row tiket. */
export async function ownsTicketAttachment(db: PrismaClient, userId: number, url: string): Promise<boolean> {
  const OR = [
    { attachmentUrls: url }, { attachmentUrls: { startsWith: `${url},` } },
    { attachmentUrls: { endsWith: `,${url}` } }, { attachmentUrls: { contains: `,${url},` } },
  ];
  const [tickets, messages] = await Promise.all([
    db.supportTicket.findFirst({ where: { userId, OR }, select: { id: true } }),
    db.ticketMessage.findFirst({ where: { ticket: { userId }, OR }, select: { id: true } }),
  ]);
  return tickets !== null || messages !== null;
}
