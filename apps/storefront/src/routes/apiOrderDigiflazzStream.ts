/**
 * GET /api/v1/account/orders/:code/digiflazz/stream — the storefront (buyer)
 * twin of web-admin's order-detail Digiflazz SSE stream (Task 10), built on
 * the same `streamSse` helper (Task 9) and `onDigiflazzOrderStatusChanged`
 * pub/sub (Task 4).
 *
 * Unlike the admin route, this one is reachable by an ordinary logged-in
 * customer, so two things matter more here than anywhere else in this
 * feature:
 *
 * 1. Ownership: mirrors GET /account/orders/:code in apiAccount.ts exactly —
 *    a mismatch (wrong owner, nonexistent code, or a WALLET_TOPUP-kind order)
 *    is always a 404, never a 401/403, so a buyer can never learn "this order
 *    code exists but isn't yours" by probing (see apiAccount.ts's module doc
 *    comment for the repo-wide convention this follows).
 * 2. No internal vocabulary on the wire: the internal `digiflazzStatus`
 *    values (`pending_at_supplier`, `failed`, ...) are never sent as-is.
 *    `toBuyerDigiflazzStatus` maps them to a buyer-safe subset before this route ever
 *    touches the wire, so a future UI change that forgets to re-translate
 *    still can't leak the word "failed" (which would read to a buyer as
 *    fully-dead, when it's often just an automatic retry in progress).
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma, getOrderByCode, getOrderDigiflazzSnapshot } from "@app/db";
import { OrderKind } from "@app/core/enums";
import { onDigiflazzOrderStatusChanged } from "@app/core/realtime/digiflazzEvents";
import { streamSse } from "@app/core/realtime/sseRoute";
import { getOrderFulfillment, toBuyerDigiflazzStatus, type OrderFulfillment } from "@app/core/orderFulfillment";
import { optionalCustomer } from "../plugins/auth";

/** Buyer-safe mapping of the internal digiflazzStatus values — the wire
 * shape itself must not be able to leak "failed" (or any future internal
 * value) even if a later UI change forgets to re-translate it. */
type BuyerDigiflazzStatus = "pending" | "reviewing" | null;

interface BuyerOrderDigiflazzSnapshot {
  orderStatus: string;
  digiflazzStatus: BuyerDigiflazzStatus;
  fulfillment: OrderFulfillment;
}

/** getOrderFulfillment statuses after which the order can no longer change. */
const TERMINAL_FULFILLMENT_STATUSES: ReadonlySet<OrderFulfillment["status"]> = new Set(["SUCCESS", "CANCELLED", "FAILED"]);

async function readBuyerSnapshot(orderId: number): Promise<BuyerOrderDigiflazzSnapshot | null> {
  const order = await getOrderDigiflazzSnapshot(prisma, orderId);
  if (!order) return null;
  return {
    orderStatus: order.status,
    digiflazzStatus: toBuyerDigiflazzStatus(order.digiflazzStatus),
    fulfillment: getOrderFulfillment(order),
  };
}

const apiOrderDigiflazzStreamRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { code: string } }>("/account/orders/:code/digiflazz/stream", async (req, reply) => {
    const customer = await optionalCustomer(req);
    if (!customer) return reply.code(401).send({ error: "unauthorized" });

    // Ownership check happens on the ORDER lookup, BEFORE reply.hijack()
    // (inside streamSse) — a 404 after hijack would be broken/ignored.
    // Same "always 404, never 401/403 on a mismatch" rule as every other
    // buyer-facing order route in apiAccount.ts (read its module doc
    // comment) — never reveal via status code whether a code exists.
    const order = await getOrderByCode(prisma, req.params.code);
    if (!order || order.userId !== customer.userId || order.kind !== OrderKind.PRODUCT) {
      return reply.code(404).send({ error: "not_found" });
    }

    const initialSnapshot = await readBuyerSnapshot(order.id);
    if (!initialSnapshot) {
      // Should be unreachable (we just fetched this same order above) —
      // defensive only.
      return reply.code(404).send({ error: "not_found" });
    }

    await streamSse<BuyerOrderDigiflazzSnapshot>(reply, req, {
      initial: async () => initialSnapshot,
      poll: async () => (await readBuyerSnapshot(order.id)) ?? initialSnapshot,
      subscribe: (onChange) =>
        onDigiflazzOrderStatusChanged((changedOrderId) => {
          if (changedOrderId === order.id) onChange();
        }),
      changed: (prev, next) => JSON.stringify(prev) !== JSON.stringify(next),
      pollIntervalMs: 5_000,
      // Delivered, cancelled/expired/refunded or failed: nothing left to
      // stream, so the server ends the response after that frame. NEEDS_REVIEW
      // is not final — an admin can still finish the order.
      isTerminal: (snapshot) => TERMINAL_FULFILLMENT_STATUSES.has(snapshot.fulfillment.status),
    });
  });
};

export default apiOrderDigiflazzStreamRoutes;
