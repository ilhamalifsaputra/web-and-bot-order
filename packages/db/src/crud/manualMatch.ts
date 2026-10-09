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
 * The display-only `suggestedOrderId` column is never read here: it is a hint
 * for the admin, not evidence of anything.
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
}

const ALL_GATEWAYS: readonly LedgerGateway[] = ["binance", "bybit", "tokopay", "paydisini", "nowpayments"];

async function findRowOn(db: Db, gateway: LedgerGateway, reference: string): Promise<LedgerRowSummary | null> {
  const pick = (r: { outcome: string; amount: Decimal | null; orderId: number | null } | null) =>
    r ? { reference, outcome: r.outcome, amount: r.amount, orderId: r.orderId } : null;
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

  if (row.outcome !== "unmatched") throw new ValidationError("error.tx_not_unmatched");
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
    result = await manualMatchBybit(db, { bybitTxId: args.reference, orderId: args.orderId, adminId: args.adminId });
  } else {
    const deliver = gateway === "tokopay" ? deliverPaidTokopayOrder : deliverPaidPaydisiniOrder;
    const r = await deliver(db, {
      orderId: args.orderId,
      trxId: args.reference,
      amount: received,
      shopUrl: args.shopUrl ?? null,
      manual: { adminId: args.adminId },
    });
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
    });
    return r.status === "delivered"
      ? { kind: "delivered" as const, order: r.order, credentials: r.credentials }
      : { kind: "processing" as const, order: r.order, credentials: [] as [] };
  }, { timeout: 15000 });
}

/**
 * Acknowledge an UNMATCHED ledger row that belongs to no order, on any
 * gateway: unmatched → dismissed. The row is kept (auditable, listable under
 * the "dismissed" filter). Binance delegates to `dismissUnmatchedTx`.
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
