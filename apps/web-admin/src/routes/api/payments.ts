import type { FastifyInstance } from "fastify";
import { OrderStatus, OrderKind } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { evaluatePollHealth } from "@app/core/payments/pollHealth";
import {
  prisma,
  resolveBinanceInternalConfig,
  countProcessedBinanceTxToday,
  processedTxOutcomeCounts,
  getBinancePollHealth,
  TX_OUTCOMES,
  deliverUnderpaidOrder,
  refundUnderpaidOrder,
  manualMatchTx,
  dismissUnmatchedTx,
  creditOrderToBalance,
  listOrders,
  listPendingInternalOrders,
  getOrderByCode,
  cancelOrder,
  logAdminAction,
  listCombinedLedger,
  findIdempotentResponse,
  saveIdempotentResponse,
  hashIdempotentRequest,
  IdempotencyKeyReuseError,
  type IdempotentReplay,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { paymentsMutationRateLimited } from "../../auth";
import { displayDateTime } from "../../dateDisplay";

const PAGE_SIZE = 50;

/** The order kinds the ledger's "Type" filter accepts — the Payments page
 *  needs to separate wallet top-up money from product-sale money. Sent to the
 *  client so its dropdown is driven by the same list the server validates
 *  against, exactly like `TX_OUTCOMES` drives the outcome dropdown. */
const ORDER_KINDS = [OrderKind.PRODUCT, OrderKind.WALLET_TOPUP] as const;

class NotFoundError extends Error {}

/** Stable name for the underpaid-order refund route's idempotency ledger row
 * (packages/db/src/crud/idempotency.ts) — not the literal URL, so it stays
 * correct if the route is ever remounted. */
const REFUND_IDEMPOTENCY_ENDPOINT = "web-admin.payments.refundUnderpaid";
const DELIVER_IDEMPOTENCY_ENDPOINT = "web-admin.payments.deliverUnderpaid";
const CANCEL_IDEMPOTENCY_ENDPOINT = "web-admin.payments.cancelUnderpaid";
const MATCH_IDEMPOTENCY_ENDPOINT = "web-admin.payments.manualMatch";
const CREDIT_IDEMPOTENCY_ENDPOINT = "web-admin.payments.creditBalance";
const DISMISS_IDEMPOTENCY_ENDPOINT = "web-admin.payments.dismissTx";

/** An `Idempotency-Key` header, trimmed and length-capped — a repeat header
 * takes the first value. Empty/oversized values are treated as "no key"
 * (opt out) rather than rejected, since this is additive and must never turn
 * a missing/malformed header into a hard failure. */
function normalizeIdempotencyKey(header: string | string[] | undefined): string | null {
  const raw = (Array.isArray(header) ? header[0] : header) ?? "";
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 255 ? trimmed : null;
}

export default async function paymentsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/payments", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const outcome = q.outcome && (TX_OUTCOMES as readonly string[]).includes(q.outcome) ? q.outcome : null;
    const search = q.q?.trim() || null;
    // Unrecognized values fall back to "no kind filter" rather than an empty
    // ledger, matching how `outcome` above ignores anything not in TX_OUTCOMES.
    const kind = q.kind && (ORDER_KINDS as readonly string[]).includes(q.kind) ? q.kind : null;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    // `listCombinedLedger` returns rows AND their total together: the `kind`
    // filter is applied to the cross-gateway merged set, so no per-table
    // count() could produce a total that agrees with it (see its doc comment).
    const [ledgerPage, todayCount, counts, health, underpaid, pendingInternal] = await Promise.all([
      listCombinedLedger(prisma, { outcome, q: search, kind, limit: PAGE_SIZE, offset }),
      countProcessedBinanceTxToday(prisma),
      processedTxOutcomeCounts(prisma),
      getBinancePollHealth(prisma),
      listOrders(prisma, { status: OrderStatus.UNDERPAID, limit: 50 }),
      listPendingInternalOrders(prisma, new Date()),
    ]);
    const binanceEnabled = (await resolveBinanceInternalConfig(prisma)).enabled;
    // The single shared rule (packages/core/src/payments/pollHealth.ts) —
    // the client renders this verdict as-is instead of re-deriving its own
    // pill from the raw heartbeat fields (that divergence was Task 7's bug).
    const healthVerdict = evaluatePollHealth(health, { enabled: binanceEnabled });

    // Ledger rows are named createdAt in the DB/crud layer, but the client
    // reads `processedAt` (an existing "invalid date" bug — the field never
    // actually existed before, so `new Date(tx.processedAt)` always produced
    // Invalid Date client-side). Add it here alongside the pre-formatted
    // display string, fixing that bug in the same pass.
    const { rows: ledger, total } = ledgerPage;
    const ledgerWithDisplay = ledger.map((r) => ({
      ...r,
      processedAt: r.createdAt.toISOString(),
      processedAtDisplay: displayDateTime(r.createdAt),
    }));
    const underpaidWithDisplay = underpaid.map((o) => ({ ...o, createdAtDisplay: displayDateTime(o.createdAt) }));
    const pendingInternalWithDisplay = pendingInternal.map((o) => ({ ...o, expiresAtDisplay: displayDateTime(o.expiresAt) }));

    return reply.send({
      enabled: binanceEnabled,
      ledger: ledgerWithDisplay,
      total,
      todayCount,
      page,
      pageSize: PAGE_SIZE,
      hasNext: offset + ledger.length < total,
      outcomes: TX_OUTCOMES,
      kinds: ORDER_KINDS,
      counts,
      health: {
        ...health,
        status: healthVerdict.status,
        detail: healthVerdict.detail,
        staleMs: healthVerdict.staleMs,
      },
      underpaid: underpaidWithDisplay,
      pendingInternal: pendingInternalWithDisplay,
    });
  });

  app.post("/api/payments/order/:orderId/deliver", { preHandler: csrfProtect }, async (req, reply) => {
    if (paymentsMutationRateLimited(req.admin!.userId)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const orderId = Number((req.params as { orderId: string }).orderId);

    const idempotencyKeyHeader = normalizeIdempotencyKey(req.headers["idempotency-key"]);
    const idem = idempotencyKeyHeader ? { key: idempotencyKeyHeader, requestHash: hashIdempotentRequest({ orderId }) } : null;

    if (idem) {
      let replay: IdempotentReplay | null;
      try {
        replay = await findIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: DELIVER_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await saveIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: DELIVER_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
          statusCode,
          responseBody: JSON.stringify(body),
        });
      }
      return reply.code(statusCode).send(body);
    };

    try {
      const { order } = await deliverUnderpaidOrder(prisma, { orderId, adminId: req.admin!.userId });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "underpaid_deliver",
        targetType: "order",
        targetId: orderId,
        details: `Delivered underpaid order ${order.orderCode} anyway.`,
      });
    } catch (e) {
      if (e instanceof ValidationError) return respond(422, { error: e.message });
      throw e;
    }
    logger.info(`Admin ${req.admin!.userId} delivered underpaid order ${orderId} anyway via the web panel`);
    return respond(200, { ok: true });
  });

  app.post("/api/payments/order/:orderId/refund", { preHandler: csrfProtect }, async (req, reply) => {
    if (paymentsMutationRateLimited(req.admin!.userId)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const orderId = Number((req.params as { orderId: string }).orderId);

    // Idempotency (Task 1): a double-clicked "Refund" button (or a retried
    // request after the admin's browser never saw the first response) would
    // otherwise hit refundUnderpaidOrder's own state guard on the SECOND
    // click and show the admin a confusing "order not underpaid" 422, even
    // though the first click already succeeded. An `Idempotency-Key` header
    // lets that retry replay the exact first response instead. Opt-in — a
    // request with no header behaves exactly as before.
    // `idem` bundles the key with its request hash into one nullable value
    // so every use below narrows together — no `!` assertions needed.
    const idempotencyKeyHeader = normalizeIdempotencyKey(req.headers["idempotency-key"]);
    const idem = idempotencyKeyHeader ? { key: idempotencyKeyHeader, requestHash: hashIdempotentRequest({ orderId }) } : null;

    if (idem) {
      let replay: IdempotentReplay | null;
      try {
        replay = await findIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: REFUND_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await saveIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: REFUND_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
          statusCode,
          responseBody: JSON.stringify(body),
        });
      }
      return reply.code(statusCode).send(body);
    };

    try {
      const { refunded } = await refundUnderpaidOrder(prisma, { orderId, adminId: req.admin!.userId });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "underpaid_refund",
        targetType: "order",
        targetId: orderId,
        details: `Refunded ${refunded.toString()} to the buyer's wallet for an underpaid order.`,
      });
    } catch (e) {
      if (e instanceof ValidationError) return respond(422, { error: e.message });
      throw e;
    }
    return respond(200, { ok: true });
  });

  app.post("/api/payments/order/:orderId/cancel", { preHandler: csrfProtect }, async (req, reply) => {
    if (paymentsMutationRateLimited(req.admin!.userId)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const orderId = Number((req.params as { orderId: string }).orderId);

    const idempotencyKeyHeader = normalizeIdempotencyKey(req.headers["idempotency-key"]);
    const idem = idempotencyKeyHeader ? { key: idempotencyKeyHeader, requestHash: hashIdempotentRequest({ orderId }) } : null;

    if (idem) {
      let replay: IdempotentReplay | null;
      try {
        replay = await findIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: CANCEL_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await saveIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: CANCEL_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
          statusCode,
          responseBody: JSON.stringify(body),
        });
      }
      return reply.code(statusCode).send(body);
    };

    try {
      await prisma.$transaction(async (tx) => {
        const order = await cancelOrder(tx, orderId, `underpaid_cancelled by admin_id=${req.admin!.userId}`);
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "underpaid_cancel",
          targetType: "order",
          targetId: orderId,
          details: `Cancelled underpaid order ${order?.orderCode ?? orderId}.`,
        });
      });
    } catch (e) {
      if (e instanceof ValidationError) return respond(422, { error: e.message });
      throw e;
    }
    return respond(200, { ok: true });
  });

  app.post("/api/payments/match", { preHandler: csrfProtect }, async (req, reply) => {
    if (paymentsMutationRateLimited(req.admin!.userId)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const body = req.body as Record<string, string>;
    const binanceTxId = (body.binance_tx_id ?? "").trim();
    const orderCode = (body.order_code ?? "").trim();

    const idempotencyKeyHeader = normalizeIdempotencyKey(req.headers["idempotency-key"]);
    const idem = idempotencyKeyHeader
      ? { key: idempotencyKeyHeader, requestHash: hashIdempotentRequest({ binanceTxId, orderCode }) }
      : null;

    if (idem) {
      let replay: IdempotentReplay | null;
      try {
        replay = await findIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: MATCH_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await saveIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: MATCH_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
          statusCode,
          responseBody: JSON.stringify(body),
        });
      }
      return reply.code(statusCode).send(body);
    };

    if (!binanceTxId || !orderCode) {
      return respond(400, { error: "Both a transfer id and an order code are required." });
    }
    try {
      const target = await getOrderByCode(prisma, orderCode);
      if (!target) return respond(404, { error: `Order ${orderCode} not found.` });
      const result = await manualMatchTx(prisma, {
        binanceTxId,
        orderId: target.id,
        adminId: req.admin!.userId,
      });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "tx_manual_match",
        targetType: "order",
        targetId: result.order.id,
        details:
          result.kind === "delivered"
            ? `Matched transfer ${binanceTxId} to order ${result.order.orderCode}.`
            : `Matched transfer ${binanceTxId} to order ${result.order.orderCode}; queued for manual fulfilment.`,
      });
      logger.info(`Admin ${req.admin!.userId} manually matched Binance transfer ${binanceTxId} to order ${orderCode} via the web panel`);
      return respond(200, { ok: true });
    } catch (e) {
      if (e instanceof ValidationError) return respond(422, { error: e.message });
      throw e;
    }
  });

  app.post("/api/payments/credit", { preHandler: csrfProtect }, async (req, reply) => {
    if (paymentsMutationRateLimited(req.admin!.userId)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const body = req.body as Record<string, string>;
    const binanceTxId = (body.binance_tx_id ?? "").trim();
    const orderCode = (body.order_code ?? "").trim();

    const idempotencyKeyHeader = normalizeIdempotencyKey(req.headers["idempotency-key"]);
    const idem = idempotencyKeyHeader
      ? { key: idempotencyKeyHeader, requestHash: hashIdempotentRequest({ binanceTxId, orderCode }) }
      : null;

    if (idem) {
      let replay: IdempotentReplay | null;
      try {
        replay = await findIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: CREDIT_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await saveIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: CREDIT_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
          statusCode,
          responseBody: JSON.stringify(body),
        });
      }
      return reply.code(statusCode).send(body);
    };

    if (!binanceTxId || !orderCode) {
      return respond(400, { error: "Both a transfer id and an order code are required." });
    }
    try {
      await prisma.$transaction(async (tx) => {
        const target = await getOrderByCode(tx, orderCode);
        if (!target) throw new NotFoundError(`Order ${orderCode} not found.`);
        const ledger = await tx.processedBinanceTx.findUnique({ where: { binanceTxId } });
        if (!ledger) throw new NotFoundError("Transfer not found.");
        const { credited, currency } = await creditOrderToBalance(tx, {
          orderId: target.id,
          amount: ledger.amount ?? undefined,
          adminId: req.admin!.userId,
          binanceTxId,
        });
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "tx_credit_balance",
          targetType: "order",
          targetId: target.id,
          details: `Credited transfer ${binanceTxId} (${credited.toString()} ${currency}) to order ${target.orderCode}'s buyer balance.`,
        });
      });
      logger.info(`Admin ${req.admin!.userId} credited Binance transfer ${binanceTxId} to order ${orderCode}'s buyer balance via the web panel`);
      return respond(200, { ok: true });
    } catch (e) {
      if (e instanceof NotFoundError) return respond(404, { error: e.message });
      if (e instanceof ValidationError) return respond(422, { error: e.message });
      throw e;
    }
  });

  app.post("/api/payments/dismiss", { preHandler: csrfProtect }, async (req, reply) => {
    if (paymentsMutationRateLimited(req.admin!.userId)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const binanceTxId = ((req.body as Record<string, string>).binance_tx_id ?? "").trim();

    const idempotencyKeyHeader = normalizeIdempotencyKey(req.headers["idempotency-key"]);
    const idem = idempotencyKeyHeader ? { key: idempotencyKeyHeader, requestHash: hashIdempotentRequest({ binanceTxId }) } : null;

    if (idem) {
      let replay: IdempotentReplay | null;
      try {
        replay = await findIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: DISMISS_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await saveIdempotentResponse(prisma, {
          key: idem.key,
          endpoint: DISMISS_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
          statusCode,
          responseBody: JSON.stringify(body),
        });
      }
      return reply.code(statusCode).send(body);
    };

    if (!binanceTxId) return respond(400, { error: "A payment reference is required." });
    try {
      await prisma.$transaction(async (tx) => {
        await dismissUnmatchedTx(tx, binanceTxId);
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "tx_dismiss",
          targetType: "payment",
          details: `Dismissed unmatched transfer ${binanceTxId}.`,
        });
      });
      logger.info(`Admin ${req.admin!.userId} dismissed unmatched Binance transfer ${binanceTxId} via the web panel`);
      return respond(200, { ok: true });
    } catch (e) {
      if (e instanceof ValidationError) return respond(422, { error: e.message });
      throw e;
    }
  });
}
