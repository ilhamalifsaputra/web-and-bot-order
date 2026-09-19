/**
 * Payment domain (Trustance Phase A Task A2a) — a multi-attempt payment
 * ledger that coexists with (does not replace) the payment fields directly on
 * `Order` (`paymentMethod`, `paymentRef`, `binanceTxid`, `bybitTxid`, ...).
 * Those Order fields stay the "current/latest attempt" cache the six existing
 * payment-rail webhook/poller handlers (binance_internal.ts, bybit_deposit.ts,
 * bybit_bsc_deposit.ts, nowpaymentsReconcile.ts, tokopayReconcile.ts,
 * paydisiniReconcile.ts) read directly — wiring those six handlers to also
 * write to THIS table is a separate follow-up task, out of scope here.
 *
 * Pattern mirrors `packages/db/src/crud/refunds.ts` deliberately: an explicit
 * legal-transition table (`PAYMENT_LEGAL_TRANSITIONS`), atomic
 * `updateMany`-with-guard claims for every status transition (so a concurrent
 * double-expire/double-confirm can't race), and `logAdminAction` on every
 * transition (CLAUDE.md: "Audit every state change").
 *
 * CONCURRENCY — the one-PENDING-payment-per-order invariant: unlike a
 * transition on an already-existing row (which `updateMany`-with-guard
 * handles fine, same as `claimGatewaySlot` in orders.ts), "at most one
 * PENDING Payment row per order" is an invariant over INSERTING a new
 * sibling row conditioned on the absence of another. Under Postgres' default
 * READ COMMITTED isolation, two concurrent transactions can each observe "no
 * PENDING row exists yet" and both insert — a read-then-insert check alone
 * cannot close that race, no matter how it's phrased.
 *
 * Enforced instead by `Payment.pendingOrderId` (see that column's own doc
 * comment in schema.prisma for the full reasoning, including why a Postgres
 * PARTIAL unique index was tried first and abandoned): it mirrors `orderId`
 * only while `status` is PENDING and is `null` otherwise, with a plain FULL
 * `@unique` index on it — ordinary Prisma DSL, created by `db push` in every
 * environment. `createPaymentAttempt` below sets `pendingOrderId: orderId` on
 * insert and translates the resulting P2002 unique-violation into a clean
 * `ValidationError`; `expirePaymentAttempt`/`confirmPaymentAttempt` clear it
 * back to `null` in the same atomic `updateMany`-with-guard call that moves
 * `status` off PENDING, so the claim is released the instant the row stops
 * being the order's live pending attempt.
 */
import { PaymentStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { Decimal, money } from "@app/core/money";
import type { Payment } from "@prisma/client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { logAdminAction } from "./audit";

/**
 * Legal Payment.status transitions. Every payment attempt starts PENDING (the
 * schema default) and can only leave that state once, to one of three
 * terminal statuses — CONFIRMED, EXPIRED, or FAILED, none of which has any
 * outgoing edge. Only PENDING -> EXPIRED (`expirePaymentAttempt`) and
 * PENDING -> CONFIRMED (`confirmPaymentAttempt`) have a crud function today;
 * PENDING -> FAILED is reserved in the shape for a future caller (e.g. a
 * webhook reporting a declined/failed gateway attempt) without needing to
 * touch this table again.
 */
export const PAYMENT_LEGAL_TRANSITIONS: Record<string, readonly string[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.CONFIRMED, PaymentStatus.EXPIRED, PaymentStatus.FAILED],
  [PaymentStatus.CONFIRMED]: [],
  [PaymentStatus.EXPIRED]: [],
  [PaymentStatus.FAILED]: [],
};

/**
 * Parse+validate a `Decimal.Value` payment amount: must be well-formed,
 * finite, and strictly positive — same discipline and same clean-error
 * conversion as `parseRefundAmount` (packages/db/src/crud/refunds.ts), for
 * the same reason: this is money actually being recorded on a Payment row,
 * not a free-text display-only setting, and a raw `[DecimalError] Invalid
 * argument` must never escape to a caller as an unhandled 500.
 */
function parsePaymentAmount(raw: Decimal.Value): Decimal {
  let amount: Decimal;
  try {
    amount = new Decimal(raw);
  } catch {
    throw new ValidationError("error.payment_amount_invalid");
  }
  if (!amount.isFinite() || !amount.greaterThan(0)) {
    throw new ValidationError("error.payment_amount_invalid");
  }
  return amount;
}

/**
 * Parse+validate one of the two settlement figures a rail can capture onto a
 * confirmed Payment row (`fee`, `netAmount` — Financial Ledger M3), quantized
 * to this repo's 4 decimal places (`money`, @app/core/money).
 *
 * Same clean-error discipline as `parsePaymentAmount` above, with one
 * deliberate difference: **zero is accepted**. `Payment.fee`'s own doc comment
 * (prisma/schema.prisma) draws the distinction this rests on — `null` means "no
 * figure is known", while `0` is a real statement that this payment cost the
 * shop nothing — so rejecting zero would force a genuinely free payment to be
 * recorded as unknown instead. Negative and non-finite values are still
 * refused: a gateway that kept a negative cut, or a net receipt of Infinity, is
 * not a figure this shop should store and later reconcile a settlement report
 * against.
 *
 * The quantizing is not cosmetic, for the same reason `ledger.ts`'s
 * `parseEntryAmount` quantizes: `payments.fee`/`payments.net_amount` are
 * DECIMAL(65,30) columns and would happily store more precision than this
 * repo's money type recognises, leaving a stored figure that `moneyEq` (which
 * compares at 4 places) can never reproduce.
 */
function parseSettlementFigure(raw: Decimal.Value): Decimal {
  let figure: Decimal;
  try {
    figure = money(raw);
  } catch {
    throw new ValidationError("error.payment_fee_invalid");
  }
  if (!figure.isFinite() || figure.isNegative()) {
    throw new ValidationError("error.payment_fee_invalid");
  }
  return figure;
}

/**
 * Create a new Payment attempt for an Order, starting PENDING (the schema
 * default). Validates that `currency` matches the referenced Order's own
 * currency — same snapshot-pinning reasoning as `createRefund`'s identical
 * check (packages/db/src/crud/refunds.ts) — and that `amount` is finite/
 * positive (`parsePaymentAmount`).
 *
 * Enforces "an Order may have at most one PENDING Payment row at a time" by
 * setting `pendingOrderId: orderId` on the insert and translating the
 * resulting P2002 unique-violation (raised by `Payment.pendingOrderId`'s
 * `@unique` index — see this file's module comment and that column's own doc
 * comment in schema.prisma) into a clean `ValidationError` — no read-then-
 * insert check is needed or would even be safe under concurrent callers, see
 * the module comment for why.
 *
 * Audits the creation via `logAdminAction` (`payment_attempt_created`), same
 * pattern `refunds.ts` uses for every Refund-domain state change. `adminId`
 * is nullable (unlike `refunds.ts`, which always has an acting admin) because
 * a payment attempt is most often created by the BUYER's own action through
 * the bot (picking/switching a payment rail at checkout) — `logAdminAction`
 * already accepts `adminId: number | null` for exactly this "system/customer,
 * not an admin" case (see its own signature, packages/db/src/crud/audit.ts).
 */
export async function createPaymentAttempt(
  db: Db,
  args: {
    orderId: number;
    method: string;
    amount: Decimal.Value;
    currency: string;
    reference?: string | null;
    adminId?: number | null;
  },
): Promise<Payment> {
  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, currency: true, orderCode: true },
  });
  if (!order) throw new ValidationError("error.order_not_found");
  if (args.currency !== order.currency) {
    throw new ValidationError("error.payment_currency_mismatch", {
      paymentCurrency: args.currency,
      orderCurrency: order.currency,
    });
  }
  const amount = parsePaymentAmount(args.amount);

  let payment: Payment;
  try {
    payment = await db.payment.create({
      data: {
        orderId: args.orderId,
        method: args.method,
        amount,
        currency: args.currency,
        reference: args.reference ?? null,
        // Claims the one-PENDING-per-order slot — see this file's module
        // comment and Payment.pendingOrderId's own doc comment in
        // schema.prisma. A second concurrent call for the SAME order hits
        // this column's unique index and is caught below.
        pendingOrderId: args.orderId,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // No format args: `error.payment_already_pending` has no placeholder in
      // en.json/id.json, and it must not grow one — this string is rendered
      // straight into a buyer-facing toast, so an {orderId} placeholder would
      // leak an internal database id to the buyer. The order id belongs in the
      // logs/structured metadata, not in the copy.
      throw new ValidationError("error.payment_already_pending");
    }
    throw e;
  }

  await logAdminAction(db, {
    adminId: args.adminId ?? null,
    action: "payment_attempt_created",
    targetType: "payment",
    targetId: payment.id,
    details: `Started a ${payment.method} payment attempt of ${amount.toString()} ${payment.currency} for order ${order.orderCode}.`,
  });

  return payment;
}

/** Payment attempts for one order (newest first). */
export function listPaymentAttempts(db: Db, orderId: number) {
  return db.payment.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * The order's live PENDING attempt, or null if it has none. An exact hit on
 * `Payment.pendingOrderId`'s unique index — which mirrors `orderId` for
 * precisely as long as the row is PENDING and is null otherwise (see this
 * file's module comment) — so a caller that only wants the current attempt
 * doesn't have to list every attempt the order ever made and filter them in
 * memory.
 */
export function getPendingPaymentAttempt(db: Db, orderId: number): Promise<Payment | null> {
  return db.payment.findUnique({ where: { pendingOrderId: orderId } });
}

/**
 * Move a Payment attempt PENDING -> EXPIRED: validates the shape against
 * `PAYMENT_LEGAL_TRANSITIONS`, atomically claims the row (`updateMany` with
 * `status: PENDING` in the WHERE clause — same pattern as
 * `transitionRefundStatus`/`claimGatewaySlot`) so a stale/duplicate caller
 * fails safely instead of overwriting an attempt that already moved on,
 * stamps `expiredAt` + `expiryReason`, and audits the move via
 * `logAdminAction`.
 *
 * `reason` is the machine code this attempt expired for — "RAIL_CHANGED"
 * (the new "change payment rail" entry point, apps/order-bot/src/handlers/
 * checkout.ts), "TIMEOUT", or "CANCELLED" (`PaymentExpiryReason`,
 * @app/core/enums) — but accepted as a plain `string` here, same convention
 * as every other free-text-shaped lifecycle column in this schema (e.g.
 * `Refund.reason`), so a future caller isn't hard-blocked from a new reason
 * without a crud-layer change.
 *
 * `reference` lets the caller hand this row the gateway reference the
 * outgoing rail was quoting, on its way out. The rail-change path needs it:
 * `setOrderPaymentRail` (packages/db/src/crud/orders.ts) clears
 * `Order.paymentRef` so the NEW rail can claim its own gateway slot, and
 * `Order.paymentRef` is the reconciliation matching key every rail's
 * webhook/poller reads — dropping it would leave a payment that lands on the
 * old rail moments after the switch with nothing to match against. Written
 * only onto a row whose `reference` is still null, so an attempt that already
 * recorded its own reference at creation keeps that one rather than having it
 * overwritten by whatever `Order` happened to be caching.
 */
export async function expirePaymentAttempt(
  db: Db,
  args: { paymentId: number; reason: string; reference?: string | null; adminId?: number | null },
): Promise<Payment> {
  const { paymentId, reason, reference, adminId } = args;

  // PENDING -> EXPIRED is always legal (PAYMENT_LEGAL_TRANSITIONS above) — no
  // runtime check needed here, unlike transitionRefundStatus, since this
  // function (unlike that one) only ever claims ONE specific transition, not
  // an arbitrary caller-supplied `to`.
  const claim = await db.payment.updateMany({
    where: { id: paymentId, status: PaymentStatus.PENDING },
    // pendingOrderId: null releases this row's claim on the one-PENDING-per-
    // order slot (Payment.pendingOrderId's doc comment, schema.prisma) the
    // instant it stops being PENDING, so a NEW attempt can claim that same
    // order right after.
    data: { status: PaymentStatus.EXPIRED, expiredAt: new Date(), expiryReason: reason, pendingOrderId: null },
  });
  if (claim.count !== 1) {
    // Either the payment doesn't exist, or its actual current status is no
    // longer PENDING (race/staleness/already terminal) — same error either
    // way, mirroring transitionRefundStatus's identical reasoning.
    throw new ValidationError("error.illegal_payment_status_transition", {
      from: PaymentStatus.PENDING,
      to: PaymentStatus.EXPIRED,
    });
  }

  if (reference != null) {
    // Safe as a second statement: the claim above already moved this row out
    // of PENDING and into a terminal status nothing else transitions out of,
    // so no concurrent writer is still competing for it. The `reference: null`
    // predicate is the preserve-don't-clobber rule from this function's doc
    // comment, not a concurrency guard.
    await db.payment.updateMany({ where: { id: paymentId, reference: null }, data: { reference } });
  }

  const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const order = await db.order.findUnique({ where: { id: payment.orderId }, select: { orderCode: true } });

  await logAdminAction(db, {
    adminId: adminId ?? null,
    action: "payment_status_change",
    targetType: "payment",
    targetId: paymentId,
    details: `Payment attempt #${paymentId} for order ${order?.orderCode ?? payment.orderId} expired (${reason}).`,
  });

  return payment;
}

/**
 * Move a Payment attempt PENDING -> CONFIRMED: same atomic claim-guard shape
 * as `expirePaymentAttempt`, stamping `confirmedAt` instead of
 * `expiredAt`/`expiryReason`, and audited the same way.
 *
 * Also the ONE place the three settlement-data columns Task 1 added to
 * `Payment` are populated (Financial Ledger M3). All six payment-rail
 * settlement handlers already call this function at the exact moment they know
 * a payment really arrived, so the gateway's own facts about it are captured
 * here rather than in six near-identical copies:
 *
 * - `providerTransactionId` — the gateway's OWN id for the transaction, as
 *   opposed to the `reference` this shop quoted. Every rail passes it (its
 *   `trxId`/`binanceTxId`/`bybitTxId`), and it is the column a provider
 *   settlement report is later reconciled against, which is why it carries its
 *   own `@@unique([method, providerTransactionId])` index (see that index's
 *   reasoning in prisma/schema.prisma). A unique violation on it is NOT caught
 *   here: two confirmed attempts claiming one gateway transaction is a genuine
 *   data problem, and the rails' own reclaim-on-failed-delivery paths never
 *   produce one (a prior attempt that failed rolled back before reaching this
 *   function, so its column is still null).
 *
 *   What happens to that violation AFTER it leaves this function is worth being
 *   precise about, because the six rails each wrap their call in a `.catch` that
 *   logs and carries on. That `.catch` is there for the benign race — a
 *   concurrent poller or webhook having already confirmed the same row, which
 *   this function reports as a `ValidationError` or a zero-row claim and which
 *   really does leave the settlement intact. It does NOT make a failed SQL
 *   statement survivable. Every rail calls this INSIDE its settlement
 *   `$transaction`, and Postgres puts an interactive transaction into an aborted
 *   state on any failed statement, so once the unique index has rejected the
 *   write, every later statement in that transaction fails too and the whole
 *   settlement rolls back — regardless of the `.catch`. The rails' log lines say
 *   exactly this, and deliberately do not claim the order is unaffected.
 * - `fee` / `netAmount` — what the gateway kept and what the shop therefore
 *   expects to receive, both quantized through `parseSettlementFigure`. Only
 *   TokoPay passes them today; the other five rails report no fee figure at all
 *   and leave both null, which is `Payment.fee`'s documented "not known" and NOT
 *   a claim that those rails are free.
 *
 * These are captured DATA, not a financial event: nothing here posts to the
 * double-entry ledger (`crud/ledgerPostings.ts`). The revenue this payment
 * earned is already recognised by that file's `ORDER_PAYMENT` posting for the
 * order's own `totalAmount`, and TokoPay's `fee` is a LOCAL estimate of the
 * surcharge the buyer pays on top of that total — not a figure TokoPay reports
 * having deducted — so posting it as a `FEE` transaction would either
 * double-count money the order posting already nets out or invent a financial
 * event from an estimate. See `crud/tokopay.ts`'s call site for the full
 * reasoning; it is pinned by a test in crud/tokopay.test.ts.
 *
 * All three are optional, and an omitted (or null) one leaves its column
 * untouched rather than clearing it: nothing in this shop needs to ERASE a
 * captured gateway figure, so a caller holding a null-ish variable must not be
 * able to wipe one, and an ad-hoc admin confirmation with none of this data to
 * hand must not be forced to invent it.
 */
export async function confirmPaymentAttempt(
  db: Db,
  args: {
    paymentId: number;
    adminId?: number | null;
    providerTransactionId?: string | null;
    fee?: Decimal.Value | null;
    netAmount?: Decimal.Value | null;
  },
): Promise<Payment> {
  const { paymentId, adminId, providerTransactionId, fee, netAmount } = args;

  // Parsed BEFORE the claim below, so a malformed figure can never leave a row
  // CONFIRMED without the settlement data it was confirmed for — same
  // validate-then-write order as `postFinancialTransaction` (crud/ledger.ts).
  const parsedFee = fee != null ? parseSettlementFigure(fee) : null;
  const parsedNetAmount = netAmount != null ? parseSettlementFigure(netAmount) : null;

  const claim = await db.payment.updateMany({
    where: { id: paymentId, status: PaymentStatus.PENDING },
    // pendingOrderId: null — same release-the-claim reasoning as
    // expirePaymentAttempt above.
    data: {
      status: PaymentStatus.CONFIRMED,
      confirmedAt: new Date(),
      pendingOrderId: null,
      // Spread in only what the caller actually supplied: Prisma leaves an
      // absent key alone, which is what makes "omitted means don't touch"
      // above true of the stored row and not just of this argument list.
      // An empty string is treated the same as absent, not as a real id:
      // `''` is NOT NULL, so the unique index on (method, providerTransactionId)
      // would treat two confirmed payments both carrying `''` as a genuine
      // collision — the one such collision reachable with no other bug
      // involved, since a NULL is what every rail's not-yet-confirmed row
      // already carries.
      ...(providerTransactionId ? { providerTransactionId } : {}),
      ...(parsedFee != null ? { fee: parsedFee } : {}),
      ...(parsedNetAmount != null ? { netAmount: parsedNetAmount } : {}),
    },
  });
  if (claim.count !== 1) {
    throw new ValidationError("error.illegal_payment_status_transition", {
      from: PaymentStatus.PENDING,
      to: PaymentStatus.CONFIRMED,
    });
  }

  const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const order = await db.order.findUnique({ where: { id: payment.orderId }, select: { orderCode: true } });

  await logAdminAction(db, {
    adminId: adminId ?? null,
    action: "payment_status_change",
    targetType: "payment",
    targetId: paymentId,
    details: `Payment attempt #${paymentId} for order ${order?.orderCode ?? payment.orderId} confirmed.`,
  });

  return payment;
}
