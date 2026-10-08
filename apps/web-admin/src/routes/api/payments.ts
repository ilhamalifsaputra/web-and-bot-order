import type { FastifyInstance } from "fastify";
import { parsePositiveId } from "../../lib/params";
import { OrderStatus, OrderKind, StockActorType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { errorBody } from "@app/core/errorBody";
import type { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import { evaluatePollHealth } from "@app/core/payments/pollHealth";
import {
  prisma,
  resolveBinanceInternalConfig,
  countLedgerRowsToday,
  ledgerOutcomeCountsForView,
  countUnderpaid,
  getBinancePollHealth,
  TX_OUTCOMES,
  deliverUnderpaidOrder,
  refundUnderpaidOrderTx,
  logUnderpaidRefundCommitted,
  creditUnderpaidTopupAnyway,
  manualMatchTx,
  dismissUnmatchedTx,
  getProcessedBinanceTx,
  creditOrderToBalance,
  listOrders,
  listPendingInternalOrders,
  getOrderByCode,
  cancelOrder,
  logAdminAction,
  listCombinedLedger,
  IdempotencyClaimTracker,
  hashIdempotentRequest,
  IdempotencyKeyReuseError,
  IdempotencyRequestInProgressError,
  type IdempotentReplay,
  triggerDigiflazzDispatch,
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
const CREDIT_ANYWAY_IDEMPOTENCY_ENDPOINT = "web-admin.payments.creditUnderpaidTopupAnyway";
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
  // Idempotency keys are claimed before each mutation runs (backend audit E2),
  // so a concurrent duplicate waits for the first instead of running twice.
  // A claim whose handler threw is released once the response is out, so the
  // admin's retry with the same key can run again right away.
  const idempotencyClaims = new IdempotencyClaimTracker();
  app.addHook("onResponse", async (req) => {
    try {
      await idempotencyClaims.releaseUnsettled(prisma, req);
    } catch (err) {
      logger.warn(
        { err },
        "Could not release an unfinished idempotency claim after a payments request failed; a retry with the same key will wait until the claim expires.",
      );
    }
  });

  app.get("/api/payments", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const outcome = q.outcome && (TX_OUTCOMES as readonly string[]).includes(q.outcome) ? q.outcome : null;
    const search = q.q?.trim() || null;
    // Unrecognized values fall back to "no kind filter" rather than an empty
    // ledger, matching how `outcome` above ignores anything not in TX_OUTCOMES.
    const kind = q.kind && (ORDER_KINDS as readonly string[]).includes(q.kind) ? q.kind : null;
    // `?actionable=1` (the dashboard "Pending actions" card's link) hides
    // unmatched/delivery_failed rows that no longer need an admin (order
    // DELIVERED or REFUNDED, or CANCELLED with the money credited/refunded), so
    // the list shows exactly what the card counted. It has no effect on any
    // other outcome. Absent, the full ledger history is listed.
    const actionable = q.actionable === "1" || q.actionable === "true";
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    // `listCombinedLedger` returns rows AND their total together: the `kind`
    // filter is applied to the cross-gateway merged set, so no per-table
    // count() could produce a total that agrees with it (see its doc comment).
    //
    // The three tile figures are computed over the SAME five gateway tables as
    // that ledger, so a tile can never read 0 above rows it counts:
    //  - `todayCount` ("Today's Transactions"): rows of any outcome recorded
    //    today, all gateways.
    //  - `counts.unmatched` ("Unmatched"): rows no admin has matched to an
    //    order.
    //  - `counts.delivery_failed` ("Failed Deliveries"): rows whose order could
    //    not be delivered.
    // Both are all-time by default; under `?actionable=1` they count only the
    // rows that still need an admin — the same rule the list filters by, so a
    // tile equals the list total it links to (and the dashboard card's
    // figure). Every other outcome keeps its all-time count either way.
    // `counts` also feeds the outcome dropdown's "(n)" labels.
    const [ledgerPage, todayCount, counts, health, underpaid, underpaidCount, pendingInternal] = await Promise.all([
      listCombinedLedger(prisma, { outcome, q: search, kind, actionable, limit: PAGE_SIZE, offset }),
      countLedgerRowsToday(prisma),
      ledgerOutcomeCountsForView(prisma, actionable),
      getBinancePollHealth(prisma),
      listOrders(prisma, { status: OrderStatus.UNDERPAID, limit: 50 }),
      // The list above is capped at 50; the badge needs the real total, the
      // same `countUnderpaid` the dashboard shows.
      countUnderpaid(prisma),
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
      underpaidCount,
      pendingInternal: pendingInternalWithDisplay,
    });
  });

  app.post("/api/payments/order/:orderId/deliver", { preHandler: csrfProtect }, async (req, reply) => {
    if (paymentsMutationRateLimited(req.admin!.userId)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const orderId = parsePositiveId((req.params as { orderId: string }).orderId);
    if (orderId === null) return reply.code(400).send({ error: "Invalid order id." });
    const rawReason = (req.body as { reason?: unknown } | null)?.reason;
    const reason = typeof rawReason === "string" ? rawReason.trim() : "";
    if (!reason) return reply.code(400).send({ error: "An override reason is required." });

    const idempotencyKeyHeader = normalizeIdempotencyKey(req.headers["idempotency-key"]);
    const idem = idempotencyKeyHeader ? { key: idempotencyKeyHeader, requestHash: hashIdempotentRequest({ orderId, reason }) } : null;

    if (idem) {
      let replay: IdempotentReplay | null;
      try {
        replay = await idempotencyClaims.claim(prisma, req, {
          key: idem.key,
          endpoint: DELIVER_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        if (e instanceof IdempotencyRequestInProgressError) {
          return reply.code(409).send({ error: "idempotency_request_in_progress" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await idempotencyClaims.save(prisma, req, {
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
      await deliverUnderpaidOrder(prisma, { orderId, adminId: req.admin!.userId, reason });
    } catch (e) {
      if (e instanceof ValidationError) return respond(422, errorBody(e));
      throw e;
    }
    logger.info(`Admin ${req.admin!.userId} delivered underpaid order ${orderId} anyway via the web panel`);
    return respond(200, { ok: true });
  });

  app.post("/api/payments/order/:orderId/refund", { preHandler: csrfProtect }, async (req, reply) => {
    if (paymentsMutationRateLimited(req.admin!.userId)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const orderId = parsePositiveId((req.params as { orderId: string }).orderId);
    if (orderId === null) return reply.code(400).send({ error: "Invalid order id." });

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
        replay = await idempotencyClaims.claim(prisma, req, {
          key: idem.key,
          endpoint: REFUND_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        if (e instanceof IdempotencyRequestInProgressError) {
          return reply.code(409).send({ error: "idempotency_request_in_progress" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await idempotencyClaims.save(prisma, req, {
          key: idem.key,
          endpoint: REFUND_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
          statusCode,
          responseBody: JSON.stringify(body),
        });
      }
      return reply.code(statusCode).send(body);
    };

    let result: { refunded: Decimal; refundId: number | null; currency: string; orderCode: string };
    try {
      // One transaction for the refund AND its audit line (backend audit Task
      // C3): previously the audit was written after the refund had already
      // committed, so a failed audit insert left money moved with no record of
      // which admin moved it. Now a failed audit rolls the refund back too.
      result = await prisma.$transaction(async (tx) => {
        const refunded = await refundUnderpaidOrderTx(tx, { orderId, adminId: req.admin!.userId });
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "underpaid_refund",
          targetType: "order",
          targetId: orderId,
          // Two shapes, same reasoning as the credit-anyway route below:
          // "refunded 0" is not a smaller version of the success case — it means
          // the order was marked REFUNDED and the buyer got nothing back, the one
          // outcome a shop admin has to act on by hand. The currency is spelled
          // out because the refund lands in the order's own currency (it used to
          // always default to IDR), so a bare number here would leave the shop
          // admin guessing whether "18500" means rupiah or USDT.
          details: refunded.refunded.greaterThan(0)
            ? `Refunded ${refunded.refunded.toString()} ${refunded.currency} to the buyer's wallet for an underpaid order.`
            : "Marked an underpaid order refunded, but returned nothing to the buyer's wallet because no payment record shows how much they actually sent. Refund them by hand if they really did pay.",
        });
        return refunded;
      });
    } catch (e) {
      if (e instanceof ValidationError) return respond(422, errorBody(e));
      throw e;
    }
    // Committed — only now is it true that money moved.
    logUnderpaidRefundCommitted(result, req.admin!.userId);
    // `refunded`/`currency` go back to the browser so the admin panel can tell
    // the admin whether money actually moved, instead of showing the same green
    // "refunded" toast for an order that was marked REFUNDED with no payout.
    return respond(200, { ok: true, refunded: result.refunded.toString(), currency: result.currency });
  });

  app.post("/api/payments/order/:orderId/credit-anyway", { preHandler: csrfProtect }, async (req, reply) => {
    if (paymentsMutationRateLimited(req.admin!.userId)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const orderId = parsePositiveId((req.params as { orderId: string }).orderId);
    if (orderId === null) return reply.code(400).send({ error: "Invalid order id." });

    const idempotencyKeyHeader = normalizeIdempotencyKey(req.headers["idempotency-key"]);
    const idem = idempotencyKeyHeader ? { key: idempotencyKeyHeader, requestHash: hashIdempotentRequest({ orderId }) } : null;

    if (idem) {
      let replay: IdempotentReplay | null;
      try {
        replay = await idempotencyClaims.claim(prisma, req, {
          key: idem.key,
          endpoint: CREDIT_ANYWAY_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        if (e instanceof IdempotencyRequestInProgressError) {
          return reply.code(409).send({ error: "idempotency_request_in_progress" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await idempotencyClaims.save(prisma, req, {
          key: idem.key,
          endpoint: CREDIT_ANYWAY_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
          statusCode,
          responseBody: JSON.stringify(body),
        });
      }
      return reply.code(statusCode).send(body);
    };

    let result: { credited: Decimal; currency: string };
    try {
      result = await creditUnderpaidTopupAnyway(prisma, { orderId, adminId: req.admin!.userId });
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "underpaid_topup_credit_anyway",
        targetType: "order",
        targetId: orderId,
        // Two shapes, because "credited 0" is not a smaller version of the
        // success case — it means the order was cancelled and the buyer got
        // nothing, which is the one outcome a shop admin has to act on by
        // hand. The currency is named for the same reason as the refund
        // route above: a top-up can be underpaid on an IDR or a USDT rail.
        details: result.credited.greaterThan(0)
          ? `Cancelled underpaid top-up order and credited ${result.credited.toString()} ${result.currency} to the buyer's wallet.`
          : "Cancelled underpaid top-up order, but credited nothing to the buyer's wallet because no payment record shows how much they actually sent. Credit them by hand if they really did pay.",
      });
    } catch (e) {
      if (e instanceof ValidationError) return respond(422, errorBody(e));
      throw e;
    }
    // `credited`/`currency` go back to the browser so the admin panel can tell
    // the admin whether money actually moved, instead of showing the same
    // green "credited" toast for a cancellation that credited nothing.
    return respond(200, { ok: true, credited: result.credited.toString(), currency: result.currency });
  });

  app.post("/api/payments/order/:orderId/cancel", { preHandler: csrfProtect }, async (req, reply) => {
    if (paymentsMutationRateLimited(req.admin!.userId)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const orderId = parsePositiveId((req.params as { orderId: string }).orderId);
    if (orderId === null) return reply.code(400).send({ error: "Invalid order id." });

    const idempotencyKeyHeader = normalizeIdempotencyKey(req.headers["idempotency-key"]);
    const idem = idempotencyKeyHeader ? { key: idempotencyKeyHeader, requestHash: hashIdempotentRequest({ orderId }) } : null;

    if (idem) {
      let replay: IdempotentReplay | null;
      try {
        replay = await idempotencyClaims.claim(prisma, req, {
          key: idem.key,
          endpoint: CANCEL_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        if (e instanceof IdempotencyRequestInProgressError) {
          return reply.code(409).send({ error: "idempotency_request_in_progress" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await idempotencyClaims.save(prisma, req, {
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
        const order = await cancelOrder(tx, orderId, `underpaid_cancelled by admin_id=${req.admin!.userId}`, {
          type: StockActorType.ADMIN,
          adminId: req.admin!.userId,
        });
        await logAdminAction(tx, {
          adminId: req.admin!.userId,
          action: "underpaid_cancel",
          targetType: "order",
          targetId: orderId,
          details: `Cancelled underpaid order ${order?.orderCode ?? orderId}.`,
        });
      });
    } catch (e) {
      if (e instanceof ValidationError) return respond(422, errorBody(e));
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
        replay = await idempotencyClaims.claim(prisma, req, {
          key: idem.key,
          endpoint: MATCH_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        if (e instanceof IdempotencyRequestInProgressError) {
          return reply.code(409).send({ error: "idempotency_request_in_progress" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await idempotencyClaims.save(prisma, req, {
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
      // The match has committed: start a Digiflazz-routed order's supplier
      // request now (fire-and-forget, ignores non-Digiflazz orders, never throws).
      if (result.kind === "processing") triggerDigiflazzDispatch(result.order.id);
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
      if (e instanceof ValidationError) return respond(422, errorBody(e));
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
        replay = await idempotencyClaims.claim(prisma, req, {
          key: idem.key,
          endpoint: CREDIT_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        if (e instanceof IdempotencyRequestInProgressError) {
          return reply.code(409).send({ error: "idempotency_request_in_progress" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await idempotencyClaims.save(prisma, req, {
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
        // Read only for the amount to credit and a clear 404 on a mistyped id.
        // Whether the transfer may still be used (actionable outcome, not
        // linked to another order, USDT order) is decided — and the row
        // consumed atomically — by creditOrderToBalance itself.
        const ledger = await getProcessedBinanceTx(tx, binanceTxId);
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
      // Not an AppError and so not `errorBody`'s business: its message is already
      // a finished English sentence naming the order code, not an i18n key with
      // figures to attach.
      if (e instanceof NotFoundError) return respond(404, { error: e.message });
      if (e instanceof ValidationError) return respond(422, errorBody(e));
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
        replay = await idempotencyClaims.claim(prisma, req, {
          key: idem.key,
          endpoint: DISMISS_IDEMPOTENCY_ENDPOINT,
          requestHash: idem.requestHash,
        });
      } catch (e) {
        if (e instanceof IdempotencyKeyReuseError) {
          return reply.code(409).send({ error: "idempotency_key_reused" });
        }
        if (e instanceof IdempotencyRequestInProgressError) {
          return reply.code(409).send({ error: "idempotency_request_in_progress" });
        }
        throw e;
      }
      if (replay) {
        return reply.code(replay.statusCode).send(JSON.parse(replay.responseBody));
      }
    }

    const respond = async (statusCode: number, body: unknown) => {
      if (idem) {
        await idempotencyClaims.save(prisma, req, {
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
      if (e instanceof ValidationError) return respond(422, errorBody(e));
      throw e;
    }
  });
}
