import type { FastifyInstance } from "fastify";
import { NotificationStatus } from "@app/core/enums";
import { prisma, listNotifications, countNotifications, outboxStatusCounts } from "@app/db";
import { currentAdmin } from "../../plugins/auth";

const PAGE_SIZE = 50;
const STATUS_VALUES = Object.values(NotificationStatus) as string[];

export default async function outboxApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/outbox", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const status = q.status && STATUS_VALUES.includes(q.status) ? q.status : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const [rows, total, counts] = await Promise.all([
      listNotifications(prisma, { status, limit: PAGE_SIZE, offset }),
      countNotifications(prisma, { status }),
      outboxStatusCounts(prisma),
    ]);

    return reply.send({ rows, total, page, hasNext: offset + rows.length < total, counts });
  });
}
