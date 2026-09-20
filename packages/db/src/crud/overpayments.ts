/**
 * Overpayment credits (task F2) — the missing caller for
 * `postOverpaymentCreditPosting`.
 *
 * ## The problem this closes
 *
 * When a buyer pays more than an order asked for, every rail does the same three
 * things: it delivers the order anyway, stamps `outcome: "overpaid"` on its own
 * processed-transaction row, and enqueues an `ADMIN_OVERPAID` DM naming the
 * excess. **None of them credits it.** Until now an admin handed the excess back
 * through the generic wallet-adjustment form, which knows nothing about orders and
 * therefore books `Dr adjustment.<ccy>` (EQUITY) — a claim that the shop funded
 * the credit out of its own equity. For an overpayment that is false twice over:
 * the money DID arrive, so the asset side is understated by every excess ever
 * credited, and the shop's equity is consumed by a payment a buyer made (decision
 * D3, and `postOverpaymentCreditPosting`'s own doc comment).
 *
 * `creditOverpaymentToBalance` credits the excess and posts it as
 * `Dr provider_clearing / Cr wallet_liability` instead — cash a gateway really
 * collected becoming credit the shop owes the buyer.
 *
 * ## The excess is DERIVED, never accepted
 *
 * The amount is computed here from the rail's own record, and no caller may pass
 * one in. That is not defensiveness about types: an amount typed by an admin (or
 * posted by a browser) is an amount that can be wrong in the buyer's favour with
 * no record contradicting it, and this route's whole justification is that the
 * figure has an external source. `findOverpaidExcess` reads the processed row the
 * rail wrote and subtracts what the order actually billed.
 *
 * **What the order billed is not the same expression on every rail.** Five of the
 * six compare against `order.totalAmount`. TokoPay does not: its QRIS admin fee is
 * a buyer-side surcharge, so the buyer is billed `qrisChargeAmount(total)` and its
 * own overpayment check uses that figure. Deriving a TokoPay credit from the bare
 * total would invent an excess equal to the shop's own fee and hand it to the
 * buyer on every single QRIS order. Each rail's expectation is therefore taken
 * from the TABLE the row came from, not from `Order.paymentMethod` — the row is
 * the evidence, and a mis-stamped payment method should not change what a rail is
 * known to have billed.
 *
 * ## One order, one credit — guarded twice
 *
 * A read-then-refuse gives a clean 422 for the ordinary double click, and
 * `wallet_transactions`' own `UNIQUE (orderId, reason)` sits underneath it for two
 * requests that race past the read. The unique index is the one that actually
 * holds: `adjustWallet` writes its ledger row BEFORE the balance for exactly this
 * reason, so a rejected duplicate aborts before any money moves rather than
 * relying on a rollback to undo it. `overpaid_credit` is a reason code of its own
 * (not `admin_adjust`) precisely so that constraint applies to it.
 */
import { OrderCurrency } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { quantizeMoney } from "@app/core/formatters";
import { logger } from "@app/core/logger";
import { Decimal, ZERO } from "@app/core/money";
import { qrisChargeAmount } from "@app/core/payments/tokopay";
import { PaymentMethod } from "@app/core/enums";
import { isUniqueViolation, type Db } from "./_types";
import { logAdminAction } from "./audit";
import { postOverpaymentCreditPosting } from "./ledgerPostings";
import { adjustWallet } from "./users";

const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

/**
 * The `wallet_transactions.reason` this credit is written under.
 *
 * Deliberately NOT `admin_adjust`, which the generic wallet form uses. Two
 * reasons, and both matter: `admin_adjust` rows carry a null `orderId`, so the
 * `UNIQUE (orderId, reason)` index that stops a second credit would not apply;
 * and the reason code is what a later reader (the Wallet Ledger page, a support
 * investigation, a report) uses to tell "the buyer overpaid and we gave it back"
 * apart from "we credited them out of goodwill". Sharing a reason code is sharing
 * a claim about where the money came from.
 */
export const OVERPAID_CREDIT_REASON = "overpaid_credit";

/** What a rail recorded about an overpayment, and what is still owed to the buyer. */
export interface OverpaidExcess {
  /** The `PaymentMethod` whose processed-transaction table holds the record. */
  gateway: string;
  /** The amount the rail recorded as having arrived. */
  receivedAmount: Decimal;
  /** What the order actually billed the buyer — `qrisChargeAmount(total)` on
   *  TokoPay, the bare `totalAmount` everywhere else. */
  expectedAmount: Decimal;
  /** `received − expected`, floored at zero so a stale row recording too LITTLE
   *  can never read as a negative "excess" and be credited backwards. */
  excess: Decimal;
  currency: string;
  /** The `WalletTransaction` that already handed this excess back, or null while
   *  it is still uncredited. This is what the order detail page reads to decide
   *  whether to offer the button at all. */
  creditedWalletTransactionId: number | null;
}

/**
 * The overpayment a rail recorded against this order, or null when none did.
 *
 * Reads all five processed-transaction tables (Bybit's two sub-rails share one —
 * see `reports.ts`'s `LedgerGateway` doc comment), the same shape and reasoning as
 * `findUnderpaidReceived` in `_underpaid.ts`. At most one will ever hold a
 * matching row for an order. Each candidate is tested on its own nullable `amount`
 * column rather than on the row as a whole, so a row that exists but records no
 * figure cannot mask a later table that does — and a null amount yields null here
 * rather than a guessed excess, because a rail that flagged an overpayment without
 * recording what arrived has given nothing to derive from.
 */
export async function findOverpaidExcess(db: Db, orderId: number): Promise<OverpaidExcess | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, currency: true, totalAmount: true },
  });
  if (!order) return null;

  const flagged = { outcome: "overpaid" } as const;
  const newestFirst = { createdAt: "desc" } as const;
  const [binance, bybit, tokopay, paydisini, nowpayments] = await Promise.all([
    db.processedBinanceTx.findFirst({ where: { orderId, ...flagged }, orderBy: newestFirst }),
    db.processedBybitTx.findFirst({ where: { orderId, ...flagged }, orderBy: newestFirst }),
    db.processedTokopayTx.findFirst({ where: { orderId, ...flagged }, orderBy: newestFirst }),
    db.processedPaydisiniTx.findFirst({ where: { orderId, ...flagged }, orderBy: newestFirst }),
    db.processedNowpaymentsTx.findFirst({ where: { orderId, ...flagged }, orderBy: newestFirst }),
  ]);

  const total = q4(new Decimal(order.totalAmount));
  /**
   * Each rail paired with the figure IT billed the buyer. TokoPay is the one
   * exception and the reason this is a table rather than a single subtraction:
   * its admin fee is a buyer-side surcharge, so `qrisChargeAmount(total)` is what
   * the buyer was asked for and `total` would understate it by the fee.
   * `BYBIT` names the shared `processed_bybit_tx` row, which both the
   * internal-transfer and the BSC sub-rail write; both compare against the bare
   * total, so one entry covers them.
   */
  const candidates: { gateway: string; amount: Decimal.Value | null; expected: Decimal }[] = [
    { gateway: PaymentMethod.BINANCE_INTERNAL, amount: binance?.amount ?? null, expected: total },
    { gateway: PaymentMethod.BYBIT, amount: bybit?.amount ?? null, expected: total },
    { gateway: PaymentMethod.TOKOPAY, amount: tokopay?.amount ?? null, expected: q4(qrisChargeAmount(total)) },
    { gateway: PaymentMethod.PAYDISINI, amount: paydisini?.amount ?? null, expected: total },
    { gateway: PaymentMethod.NOWPAYMENTS, amount: nowpayments?.amount ?? null, expected: total },
  ];
  const hit = candidates.find((candidate) => candidate.amount !== null);
  if (!hit) return null;

  const received = q4(new Decimal(hit.amount!));
  // Floored at zero: a stale or mis-written row recording LESS than the order
  // billed is not an overpayment, and a negative "excess" credited to a buyer
  // would be a silent debit dressed up as a refund.
  const excess = Decimal.max(ZERO, q4(received.minus(hit.expected)));

  const alreadyCredited = await db.walletTransaction.findFirst({
    where: { orderId, reason: OVERPAID_CREDIT_REASON },
    select: { id: true },
  });

  return {
    gateway: hit.gateway,
    receivedAmount: received,
    expectedAmount: hit.expected,
    excess,
    currency: order.currency,
    creditedWalletTransactionId: alreadyCredited?.id ?? null,
  };
}

export interface CreditOverpaymentResult {
  credited: Decimal;
  currency: "IDR" | "USDT";
  /** The movement the ledger posting is keyed on (`wallet:{id}`). */
  walletTransactionId: number;
}

/**
 * Hand a buyer the excess they overpaid, as wallet credit.
 *
 * The balance change, the ledger posting and the audit row happen in ONE
 * transaction, so a buyer whose balance moved always has a posting explaining it
 * and an audit row naming who did it. The amount is derived from the rail's record
 * (see `findOverpaidExcess`) and is not a parameter.
 *
 * Refuses, rather than crediting a guess:
 *
 * - **an order that does not exist** (`error.order_not_found`);
 * - **an order no rail flagged, or whose derived excess is zero**
 *   (`error.overpayment_none_recorded`). The zero case is a refusal and not a
 *   silent success: an admin who clicked this expects money to move, and "credited
 *   0.00" reads as done when nothing happened;
 * - **an excess already credited** (`error.overpayment_already_credited`), both
 *   from the read below and from the `UNIQUE (orderId, reason)` violation that
 *   catches a race past it.
 *
 * Note what it does NOT check: the order's status. An overpayment is only ever
 * flagged on an order a rail DELIVERED (every rail's overpaid branch runs after
 * settlement), and the excess is the buyer's money regardless of what happened to
 * the order afterwards — a later cancellation or refund does not make the surplus
 * the shop's. Adding a status gate would only create orders whose flagged excess
 * can never be returned.
 */
export async function creditOverpaymentToBalance(
  db: Db,
  args: { orderId: number; adminId: number },
): Promise<CreditOverpaymentResult> {
  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, orderCode: true, userId: true, currency: true },
  });
  if (!order) throw new ValidationError("error.order_not_found");

  const found = await findOverpaidExcess(db, args.orderId);
  if (!found || !found.excess.greaterThan(0)) {
    throw new ValidationError("error.overpayment_none_recorded");
  }
  if (found.creditedWalletTransactionId !== null) {
    throw new ValidationError("error.overpayment_already_credited");
  }

  const currency: "IDR" | "USDT" = order.currency === OrderCurrency.USDT ? "USDT" : "IDR";
  const amount = found.excess;
  // One timestamp for the movement and its posting, so the two describe the same
  // admin action rather than two clock reads a few milliseconds apart.
  const now = new Date();

  const write = async (tx: Db): Promise<CreditOverpaymentResult> => {
    const { transactionId } = await adjustWallet(tx, order.userId, amount, {
      currency,
      reason: OVERPAID_CREDIT_REASON,
      orderId: order.id,
      adminId: args.adminId,
      note: `Excess paid above the total of order ${order.orderCode}`,
    });
    // `Dr provider_clearing / Cr wallet_liability` — cash the gateway really
    // collected becoming credit the shop owes. Deliberately NOT
    // `postWalletAdjustmentPosting`, whose `adjustment.*` (EQUITY) counter-account
    // would claim the shop funded this itself. This is the whole point of D3.
    await postOverpaymentCreditPosting(tx, {
      walletTransactionId: transactionId,
      orderId: order.id,
      orderCode: order.orderCode,
      adminId: args.adminId,
      occurredAt: now,
    });
    await logAdminAction(tx, {
      adminId: args.adminId,
      action: "overpayment_credit",
      targetType: "order",
      targetId: order.id,
      details: `Gave the buyer back the ${amount.toString()} ${currency} they overpaid on order ${order.orderCode}, as wallet balance. The payment gateway recorded ${found.receivedAmount.toString()} ${currency} arriving against a bill of ${found.expectedAmount.toString()} ${currency}.`,
    });
    return { credited: amount, currency, walletTransactionId: transactionId };
  };

  // A `Tx` has no `$transaction` (Prisma strips it from the interactive
  // transaction client), so its presence is what distinguishes the bare client
  // from a caller-owned transaction — the same test `adjustWallet` uses.
  const ownsTransaction = "$transaction" in db && typeof db.$transaction === "function";
  let result: CreditOverpaymentResult;
  try {
    result = ownsTransaction
      ? await (db as { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> }).$transaction(write)
      : await write(db);
  } catch (e) {
    // The structural guard firing: two requests raced past the read above and
    // `UNIQUE (orderId, reason)` rejected the loser. Reported as the same refusal
    // the read produces, because from the admin's side it IS the same fact — the
    // excess has already been handed back.
    if (isUniqueViolation(e)) {
      logger.info(
        `Refused a second overpayment credit on order ${order.orderCode}: two requests reached the credit at the same moment and the wallet ledger's one-movement-per-order-and-reason constraint rejected the later one, so the buyer was credited exactly once. Nothing needs fixing — this is the guard working.`,
      );
      throw new ValidationError("error.overpayment_already_credited");
    }
    throw e;
  }

  logger.info(
    { orderId: order.id, walletTransactionId: result.walletTransactionId },
    `Admin ${args.adminId} returned the ${amount.toString()} ${currency} overpaid on order ${order.orderCode} to the buyer's wallet balance. The ${found.gateway} rail recorded ${found.receivedAmount.toString()} ${currency} arriving against a bill of ${found.expectedAmount.toString()} ${currency}, and the excess is now booked against the gateway receivable rather than the shop's own equity.`,
  );
  return result;
}
