import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@app/db";
import { onDigiflazzOrderStatusChanged } from "@app/core/realtime/digiflazzEvents";
import { streamSse } from "@app/core/realtime/sseRoute";
import { requireSseAdmin } from "../../plugins/sseAuth";

interface OrderDigiflazzSnapshot {
  orderStatus: string;
  digiflazzStatus: string | null;
  digiflazzAttempts: number;
  digiflazzNextRecheckAt: string | null;
  digiflazzFailureDetail: string | null;
}

async function readOrderDigiflazzSnapshot(orderId: number): Promise<OrderDigiflazzSnapshot | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      digiflazzStatus: true,
      digiflazzAttempts: true,
      digiflazzNextRecheckAt: true,
      digiflazzFailureDetail: true,
    },
  });
  if (!order) return null;
  return {
    orderStatus: order.status,
    digiflazzStatus: order.digiflazzStatus,
    digiflazzAttempts: order.digiflazzAttempts,
    digiflazzNextRecheckAt: order.digiflazzNextRecheckAt?.toISOString() ?? null,
    digiflazzFailureDetail: order.digiflazzFailureDetail,
  };
}

/** Realtime stream of one order's Digiflazz dispatch status — admin-only,
 * mirrors the access level of `GET /api/orders/:orderId` (blockReadonlyReads,
 * see orders.ts) since both expose the same raw internal detail. Task 11's
 * storefront equivalent maps/hides these fields for the buyer-facing case. */
const orderDigiflazzStreamRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { orderId: string } }>("/api/orders/:orderId/digiflazz/stream", async (req, reply) => {
    const admin = await requireSseAdmin(req, reply, { blockReadonly: true });
    if (!admin) return;

    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      reply.code(400).send();
      return;
    }

    // Fetch + validate BEFORE reply.hijack() (inside streamSse) — a 400/404
    // must be a normal Fastify response, not something streamSse's own
    // opts.initial() (which runs AFTER hijack, with no HTTP-status
    // mechanism left) could express.
    const initialSnapshot = await readOrderDigiflazzSnapshot(orderId);
    if (!initialSnapshot) {
      reply.code(404).send();
      return;
    }

    await streamSse<OrderDigiflazzSnapshot>(reply, req, {
      initial: async () => initialSnapshot,
      // Fall back to the last known snapshot in the (should-never-happen)
      // case the order vanishes between connect and a later poll tick —
      // orders are never deleted in this app, this is purely defensive.
      poll: async () => (await readOrderDigiflazzSnapshot(orderId)) ?? initialSnapshot,
      subscribe: (onChange) =>
        onDigiflazzOrderStatusChanged((changedOrderId) => {
          if (changedOrderId === orderId) onChange();
        }),
      changed: (prev, next) => JSON.stringify(prev) !== JSON.stringify(next),
    });
  });
};

export default orderDigiflazzStreamRoutes;
