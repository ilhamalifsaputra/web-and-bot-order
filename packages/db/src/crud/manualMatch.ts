/**
 * Manual match / dismiss of an "unmatched" payment ledger row on every
 * gateway — the admin Payments page's recovery tools for money that arrived
 * but could not be attributed to an order automatically.
 *
 * Binance keeps its own long-standing implementation (`manualMatchTx` /
 * `dismissUnmatchedTx` in ./binance_internal) and is delegated to unchanged.
 * The other four ledgers are handled here:
 *
 *  - TokoPay / PayDisini: settled by the gateway's own deliver function in
 *    its opt-in manual mode (`deliverPaidTokopayOrder` /
 *    `deliverPaidPaydisiniOrder` with `manual`), which claims only an
 *    "unmatched" row and puts it back if the order turns out not payable or
 *    delivery throws.
 *  - Bybit (one ledger shared by BYBIT and BYBIT_BSC): "unmatched" is
 *    deliberately not reclaimable by the poller on this amount-matched rail
 *    (AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES, ./binance_internal), so the manual
 *    path claims the row itself — one short `$transaction` with a guarded
 *    `updateMany`, mirroring `manualMatchTx` — and settles through the very
 *    helper the poller uses after its own claim (`settleClaimedBybitDeposit`
 *    / `settleClaimedBybitBscDeposit`), picked by the order's payment method.
 *  - NOWPayments: refused. Its ledger amount is the IPN's `actually_paid`, in
 *    whatever coin the buyer paid with, and the row does not record which —
 *    so it cannot be checked against the order total (see
 *    LEDGER_GATEWAY_CURRENCY in ./reports). Dismiss still works.
 *
 * Every guard reads, then the claim re-checks atomically: a guard passing is
 * never what stops one payment settling two orders — the outcome-gated
 * `updateMany` is.
 *
 * The display-only `suggestedOrderId` column is never evidence of payment:
 * nothing here settles, credits or reclaims because of it. It is read only to
 * REFUSE — a short QRIS payment already owned by the underpaid flow
 * (`assertNotUnderpaidShortPayment`), and a dismiss the gateway could still
 * overtake (`dismissUnmatchedLedgerTx`).
 */
import { OrderStatus, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import { ValidationError } from "@app/core/errors";
import { AMOUNT_TOLERANCE } from "@app/core/formatters";
import { qrisChargeAmount } from "@app/core/payments/tokopay";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { getOrder, type SettleResult } from "./orders";
import { LEDGER_GATEWAY_CURRENCY, type LedgerGateway } from "./reports";
import { manualMatchTx, dismissUnmatchedTx } from "./binance_internal";
import { deliverPaidTokopayOrder } from "./tokopay";
import { deliverPaidPaydisiniOrder } from "./paydisini";
import { settleClaimedBybitDeposit } from "./bybit_deposit";
import { settleClaimedBybitBscDeposit } from "./bybit_bsc_deposit";

/** One ledger row, whichever of the five tables it came from. */
export interface LedgerRowSummary {
  reference: string;
  outcome: string;
  amount: Decimal | null;
  orderId: number | null;
  /** Display-only hint (see the module comment) — read here only to refuse. */
  suggestedOrderId: number | null;
  createdAt: Date;
}

const ALL_GATEWAYS: readonly LedgerGateway[] = ["binance", "bybit", "tokopay", "paydisini", "nowpayments"];

async function findRowOn(db: Db, gateway: LedgerGateway, reference: string): Promise<LedgerRowSummary | null> {
  const pick = (
    r: { outcome: string; amount: Decimal | null; orderId: number | null; suggestedOrderId: number | null; createdAt: Date } | null,
  ) =>
    r
      ? { reference, outcome: r.outcome, amount: r.amount, orderId: r.orderId, suggestedOrderId: r.suggestedOrderId, createdAt: r.createdAt }
      : null;
  switch (gateway) {
    case "binance":
      return pick(await db.processedBinanceTx.findUnique({ where: { binanceTxId: reference } }));
    case "bybit":
      return pick(await db.processedBybitTx.findUnique({ where: { bybitTxId: reference } }));
    case "tokopay":
      return pick(await db.processedTokopayTx.findUnique({ where: { trxId: reference } }));
    case "paydisini":
      return pick(await db.processedPaydisiniTx.findUnique({ where: { trxId: reference } }));
    case "nowpayments":
      return pick(await db.processedNowpaymentsTx.findUnique({ where: { trxId: reference } }));
  }
}

/**
 * Find a ledger row by its gateway reference, in every ledger table or only
 * `gateway`'s. Does NOT filter by outcome — callers check that, so a used row
 * is reported as "not unmatched" rather than "not found".
 *
 * @throws ValidationError("error.tx_not_found") when no table has it;
 *   ValidationError("error.tx_reference_ambiguous") when more than one does
 *   and no gateway was given.
 */
export async function findUnmatchedLedgerRow(
  db: Db,
  args: { reference: string; gateway?: LedgerGateway | null },
): Promise<{ gateway: LedgerGateway; row: LedgerRowSummary }> {
  const gateways = args.gateway ? [args.gateway] : ALL_GATEWAYS;
  const found: { gateway: LedgerGateway; row: LedgerRowSummary }[] = [];
  for (const gateway of gateways) {
    const row = await findRowOn(db, gateway, args.reference);
    if (row) found.push({ gateway, row });
  }
  if (found.length === 0) throw new ValidationError("error.tx_not_found");
  if (found.length > 1) throw new ValidationError("error.tx_reference_ambiguous");
  return found[0]!;
}

/** The payment methods whose orders a gateway's ledger rows may settle. */
const GATEWAY_METHODS: Record<Exclude<LedgerGateway, "binance" | "nowpayments">, readonly string[]> = {
  tokopay: [PaymentMethod.TOKOPAY],
  paydisini: [PaymentMethod.PAYDISINI],
  bybit: [PaymentMethod.BYBIT, PaymentMethod.BYBIT_BSC],
};

/**
 * The least a ledger row must hold to pay `orderTotal` in full — the same
 * figure each gateway's own automatic path requires before it delivers:
 *  - TokoPay: the QRIS charge (total + surcharge), as the callback checks
 *    (apps/storefront/src/routes/checkout.ts);
 *  - PayDisini: the order total, as its callback checks;
 *  - Bybit (both sub-rails): the total less `AMOUNT_TOLERANCE`, the poller's
 *    own `matchByAmount` rule. The poller's overpayment cap is NOT applied:
 *    it exists to stop unrelated money auto-matching, and here an admin is
 *    saying which order the money is for. An excess is still flagged
 *    "overpaid" and alerted by the shared settle helper.
 */
function requiredAmount(gateway: keyof typeof GATEWAY_METHODS, orderTotal: Decimal.Value): Decimal {
  switch (gateway) {
    case "tokopay":
      return qrisChargeAmount(orderTotal);
    case "paydisini":
      return new Decimal(orderTotal);
    case "bybit":
      return new Decimal(orderTotal).minus(AMOUNT_TOLERANCE);
  }
}

/** How `markOrderUnderpaid` spells each QRIS gateway in `QrisUnderpaidTx.gateway`
 *  (the storefront callbacks and the reconcile pollers pass these literals). */
const UNDERPAID_GATEWAY_NAME = { tokopay: "TokoPay", paydisini: "PayDisini" } as const;

/**
 * How far apart a legacy ledger row and an underpaid record may have been
 * written and still be taken for the same short payment. The storefront
 * callback writes the row and then, in the very next statement, flags the
 * order UNDERPAID — milliseconds apart. Ten minutes is deliberately generous:
 * a false match here only REFUSES a manual match (the admin can still resolve
 * the payment through the underpaid order), while a miss would let one short
 * payment be spent twice.
 */
export const LEGACY_UNDERPAID_ROW_WINDOW_MS = 10 * 60_000;

/**
 * Refuse a TokoPay/PayDisini row that is a SHORT payment for some order A the
 * callback already handed to the underpaid flow. On a short payment the
 * storefront callback writes this row (amount = received, `suggestedOrderId`
 * = A) AND calls `markOrderUnderpaid`, which records the same money in
 * `QrisUnderpaidTx`; the underpaid actions (refund to wallet, credit anyway,
 * deliver anyway) pay that money out without touching this row. Matching the
 * row to another order C as well would spend the same rupiah twice.
 *
 * Refused when:
 *  - the row names A and A has a `QrisUnderpaidTx` on this gateway or is
 *    UNDERPAID (the record is never deleted, so "was underpaid" is covered);
 *  - the row names A, A is still PENDING_PAYMENT on this gateway, and the row
 *    is short for A — the callback writes the row BEFORE flagging A, and a
 *    failed flag is retried by the reconcile poller, so A is about to become
 *    UNDERPAID with this very money;
 *  - the row names no order (written before `suggestedOrderId` existed) and
 *    an underpaid record on this gateway holds exactly the row's amount and
 *    was written within LEGACY_UNDERPAID_ROW_WINDOW_MS of it.
 *
 * Race-free without a lock: `markOrderUnderpaid` only moves an order out of
 * PENDING_PAYMENT, and no order ever returns to PENDING_PAYMENT, so an A seen
 * here as neither pending nor underpaid can never become underpaid later.
 * Called right before the claim, after every other guard.
 */
async function assertNotUnderpaidShortPayment(
  db: Db,
  gateway: "tokopay" | "paydisini",
  row: LedgerRowSummary,
): Promise<void> {
  const gatewayName = UNDERPAID_GATEWAY_NAME[gateway];
  if (row.suggestedOrderId != null) {
    const suggested = await db.order.findUnique({
      where: { id: row.suggestedOrderId },
      select: { id: true, orderCode: true, status: true, totalAmount: true, paymentMethod: true },
    });
    if (!suggested) return;
    const underpaid = await db.qrisUnderpaidTx.findFirst({ where: { orderId: suggested.id, gateway: gatewayName } });
    const shortForSuggested =
      suggested.status === OrderStatus.PENDING_PAYMENT &&
      suggested.paymentMethod != null &&
      GATEWAY_METHODS[gateway].includes(suggested.paymentMethod) &&
      row.amount != null &&
      new Decimal(row.amount).lessThan(requiredAmount(gateway, suggested.totalAmount));
    if (underpaid || suggested.status === OrderStatus.UNDERPAID || shortForSuggested) {
      throw new ValidationError("error.manual_match_underpaid_payment", { orderCode: suggested.orderCode });
    }
    return;
  }
  if (row.amount == null) return;
  const legacy = await db.qrisUnderpaidTx.findFirst({
    where: {
      gateway: gatewayName,
      receivedAmount: new Decimal(row.amount),
      createdAt: {
        gte: new Date(row.createdAt.getTime() - LEGACY_UNDERPAID_ROW_WINDOW_MS),
        lte: new Date(row.createdAt.getTime() + LEGACY_UNDERPAID_ROW_WINDOW_MS),
      },
    },
    select: { orderId: true },
  });
  if (!legacy) return;
  const order = await db.order.findUnique({ where: { id: legacy.orderId }, select: { orderCode: true } });
  throw new ValidationError("error.manual_match_underpaid_payment", { orderCode: order?.orderCode ?? `#${legacy.orderId}` });
}

/** A guarded status transition losing its race means the order stopped
 *  waiting for payment mid-match — say so in the words the admin knows. */
function asOrderNotPending(e: unknown): never {
  if (e instanceof ValidationError && e.key === "error.illegal_status_transition") {
    throw new ValidationError("error.order_not_pending");
  }
  throw e;
}

/**
 * Attach an UNMATCHED ledger row to a PENDING_PAYMENT order and settle it,
 * on any gateway. The order must be on the row's gateway and in its
 * currency, and the row must hold at least what that gateway's automatic
 * path requires — a short row belongs in the underpaid flow instead.
 *
 * The admin id reaches the order's status-transition meta
 * (`manual_match … by admin_id=N`) and `settlePaidOrder`. A WALLET_TOPUP
 * order is credited by `settleWalletTopup`, which writes no status-history
 * row, so for top-ups the admin appears only in the caller's audit line
 * (`logAdminAction`, written by the route).
 */
export async function manualMatchLedgerTx(
  db: PrismaClient,
  args: { reference: string; gateway?: LedgerGateway | null; orderId: number; adminId: number; shopUrl?: string | null },
): Promise<SettleResult & { gateway: LedgerGateway }> {
  const { gateway, row } = await findUnmatchedLedgerRow(db, args);

  if (gateway === "binance") {
    const result = await manualMatchTx(db, { binanceTxId: args.reference, orderId: args.orderId, adminId: args.adminId });
    return { ...result, gateway };
  }

  // One exception to "must be unmatched": a TokoPay/PayDisini row already
  // "matched" to THIS order may be an earlier manual match that crashed
  // between its claim and its delivery. Let it through so the deliver
  // function's guarded stale-claim reclaim decides — it refuses unless the
  // claim is old enough not to be in flight and the order is still unpaid.
  // (Bybit claims and settles in one transaction, so it cannot strand a row.)
  const strandedOwnClaim =
    (gateway === "tokopay" || gateway === "paydisini") && row.outcome === "matched" && row.orderId === args.orderId;
  if (row.outcome !== "unmatched" && !strandedOwnClaim) throw new ValidationError("error.tx_not_unmatched");
  if (gateway === "nowpayments") throw new ValidationError("error.manual_match_nowpayments_unverifiable");

  const order = await getOrder(db, args.orderId);
  if (!order) throw new ValidationError("error.order_not_found");
  if (order.status !== OrderStatus.PENDING_PAYMENT) throw new ValidationError("error.order_not_pending");
  if (!order.paymentMethod || !GATEWAY_METHODS[gateway].includes(order.paymentMethod)) {
    throw new ValidationError("error.payment_method_mismatch");
  }
  const gatewayCurrency = LEDGER_GATEWAY_CURRENCY[gateway];
  if (order.currency !== gatewayCurrency) {
    throw new ValidationError("error.payment_currency_mismatch", {
      paymentCurrency: gatewayCurrency,
      orderCurrency: order.currency,
    });
  }
  if (row.amount == null || !new Decimal(row.amount).greaterThan(0)) {
    throw new ValidationError("error.manual_match_amount_unknown");
  }
  const received = new Decimal(row.amount);
  const required = requiredAmount(gateway, order.totalAmount);
  if (received.lessThan(required)) {
    throw new ValidationError("error.manual_match_amount_short", {
      received: received.toString(),
      required: required.toString(),
      currency: order.currency,
    });
  }

  let result: SettleResult;
  if (gateway === "bybit") {
    result = await manualMatchBybit(db, { bybitTxId: args.reference, orderId: args.orderId, adminId: args.adminId }).catch(
      asOrderNotPending,
    );
  } else {
    await assertNotUnderpaidShortPayment(db, gateway, row);
    const deliver = gateway === "tokopay" ? deliverPaidTokopayOrder : deliverPaidPaydisiniOrder;
    const r = await deliver(db, {
      orderId: args.orderId,
      trxId: args.reference,
      amount: received,
      shopUrl: args.shopUrl ?? null,
      manual: { adminId: args.adminId },
    }).catch(asOrderNotPending);
    if (r.status === "already_processed") throw new ValidationError("error.tx_not_unmatched");
    if (r.status === "stale") throw new ValidationError("error.order_not_pending");
    result =
      r.status === "delivered"
        ? { kind: "delivered", order: r.order, credentials: r.credentials }
        : { kind: "processing", order: r.order, credentials: [] };
  }

  // After commit only: a log inside the transaction could claim money moved
  // for a match that then rolled back.
  logger.info(
    `Manually matched ${gateway} payment ${args.reference} to order ${result.order.orderCode} by admin ${args.adminId}; the order is now ${result.kind === "delivered" ? "delivered" : "queued for fulfilment"}.`,
  );
  return { ...result, gateway };
}

/**
 * Bybit manual match: claim + settle in ONE transaction, like
 * `manualMatchTx`. The claim is gated on `outcome: "unmatched"`, so under
 * READ COMMITTED a second admin matching the same deposit waits for the
 * first to commit, re-checks, matches zero rows and is refused — one
 * deposit can never settle two orders. Anything thrown rolls the claim back
 * with the settlement, leaving the row "unmatched".
 */
async function manualMatchBybit(
  db: PrismaClient,
  args: { bybitTxId: string; orderId: number; adminId: number },
): Promise<SettleResult> {
  return db.$transaction(async (tx: Tx) => {
    const ledger = await tx.processedBybitTx.findUnique({ where: { bybitTxId: args.bybitTxId } });
    if (!ledger) throw new ValidationError("error.tx_not_found");
    const claimed = await tx.processedBybitTx.updateMany({
      where: { bybitTxId: args.bybitTxId, outcome: "unmatched" },
      data: { orderId: args.orderId, outcome: "matched" },
    });
    if (claimed.count === 0) throw new ValidationError("error.tx_not_unmatched");

    // Re-read the order inside the transaction: the guards in
    // manualMatchLedgerTx ran before it, and the transition below is itself
    // guarded on PENDING_PAYMENT, so a concurrent status change still fails
    // the whole match rather than settling a moved-on order.
    const order = await getOrder(tx, args.orderId);
    if (!order) throw new ValidationError("error.order_not_found");
    if (order.status !== OrderStatus.PENDING_PAYMENT) throw new ValidationError("error.order_not_pending");
    if (!order.paymentMethod || !GATEWAY_METHODS.bybit.includes(order.paymentMethod)) {
      throw new ValidationError("error.payment_method_mismatch");
    }
    if (!ledger.amount) throw new ValidationError("error.manual_match_amount_unknown");

    const settle = order.paymentMethod === PaymentMethod.BYBIT_BSC ? settleClaimedBybitBscDeposit : settleClaimedBybitDeposit;
    const r = await settle(tx, {
      order,
      bybitTxId: args.bybitTxId,
      amount: ledger.amount,
      transitionMeta: `manual_match bybitTxId=${args.bybitTxId} by admin_id=${args.adminId}`,
      adminId: args.adminId,
      source: "manual",
    });
    return r.status === "delivered"
      ? { kind: "delivered" as const, order: r.order, credentials: r.credentials }
      : { kind: "processing" as const, order: r.order, credentials: [] as [] };
  }, { timeout: 15000 });
}

/**
 * The gateways whose callbacks and reconcile pollers RECLAIM an "unmatched"
 * row for the order it was parked for (QRIS_RECLAIMABLE_OUTCOMES,
 * ./binance_internal; NOWPayments' value-check parking in the storefront
 * IPN). "dismissed" is not reclaimable, so dismissing such a row while the
 * gateway can still settle it would block the delivery of a real payment.
 * Mirrored by `dismissBlocked` in apps/web-admin/client/src/pages/PaymentsPage.tsx.
 */
const DISMISS_GUARDED_GATEWAYS: ReadonlySet<LedgerGateway> = new Set(["tokopay", "paydisini", "nowpayments"]);

/**
 * Refuse dismissing a row the gateway may still settle: a "paid but no
 * amount" row (parked with amount 0 so a later status carrying the amount
 * can reclaim it and deliver), or a row whose suggested order is still
 * PENDING_PAYMENT. Reading the display-only hint here only refuses; it never
 * moves money. Once the suggested order has closed, the row is dismissable.
 */
async function assertGatewayCannotStillSettle(db: Db, row: LedgerRowSummary): Promise<void> {
  if (row.amount == null || !new Decimal(row.amount).greaterThan(0)) {
    throw new ValidationError("error.dismiss_payment_may_still_settle");
  }
  if (row.suggestedOrderId == null) return;
  const suggested = await db.order.findUnique({ where: { id: row.suggestedOrderId }, select: { status: true } });
  if (suggested?.status === OrderStatus.PENDING_PAYMENT) {
    throw new ValidationError("error.dismiss_payment_may_still_settle");
  }
}

/**
 * Acknowledge an UNMATCHED ledger row that belongs to no order, on any
 * gateway: unmatched → dismissed. The row is kept (auditable, listable under
 * the "dismissed" filter). Binance delegates to `dismissUnmatchedTx`.
 * TokoPay/PayDisini/NOWPayments rows the gateway may still settle are
 * refused (`assertGatewayCannotStillSettle`).
 */
export async function dismissUnmatchedLedgerTx(
  db: Db,
  args: { reference: string; gateway?: LedgerGateway | null },
): Promise<{ gateway: LedgerGateway }> {
  const { gateway, row } = await findUnmatchedLedgerRow(db, args);
  if (gateway === "binance") {
    await dismissUnmatchedTx(db, args.reference);
    return { gateway };
  }
  if (row.outcome !== "unmatched") throw new ValidationError("error.tx_not_unmatched");
  if (DISMISS_GUARDED_GATEWAYS.has(gateway)) await assertGatewayCannotStillSettle(db, row);
  // Gated on the outcome so a concurrent match is never overwritten by a
  // dismiss that read "unmatched" first.
  const data = { outcome: "dismissed" };
  let count: number;
  switch (gateway) {
    case "bybit":
      ({ count } = await db.processedBybitTx.updateMany({ where: { bybitTxId: args.reference, outcome: "unmatched" }, data }));
      break;
    case "tokopay":
      ({ count } = await db.processedTokopayTx.updateMany({ where: { trxId: args.reference, outcome: "unmatched" }, data }));
      break;
    case "paydisini":
      ({ count } = await db.processedPaydisiniTx.updateMany({ where: { trxId: args.reference, outcome: "unmatched" }, data }));
      break;
    case "nowpayments":
      ({ count } = await db.processedNowpaymentsTx.updateMany({ where: { trxId: args.reference, outcome: "unmatched" }, data }));
      break;
  }
  if (count === 0) throw new ValidationError("error.tx_not_unmatched");
  return { gateway };
}
