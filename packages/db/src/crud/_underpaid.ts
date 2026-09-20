/**
 * How much actually arrived for an order a rail flagged UNDERPAID — a leaf
 * module, so both the code that RESOLVES an underpayment and the code that BOOKS
 * one can read the same answer.
 *
 * It lives here rather than in `crud/orders.ts` (where it used to, and from where
 * it is still re-exported so every existing importer is untouched) purely to
 * break an import cycle: `ledgerPostings.ts` needs this figure to split an
 * underpaid-but-delivered order's posting between the receivable and the
 * shortfall the shop absorbed, and `orders.ts` already imports `ledgerPostings.ts`.
 * A copy of the three-table lookup inside the posting map would be a second
 * answer to "how much arrived", and the two would drift the moment a seventh rail
 * records its shortfall somewhere new. Same reasoning, and same leading-underscore
 * naming convention, as `_minAmount.ts`.
 */
import { Decimal } from "@app/core/money";
import type { Db } from "./_types";

/**
 * The amount actually received for an UNDERPAID order, regardless of which
 * amount-matching rail flagged it, or `null` when no rail recorded one.
 *
 * Binance Internal writes its ledger row to `processedBinanceTx`; Bybit AND Bybit
 * BSC share `processedBybitTx` (one table serves both sub-rails — see reports.ts's
 * LedgerGateway doc comment); the three QRIS/IDR gateways (TokoPay, PayDisini,
 * NOWPayments) share `qrisUnderpaidTx`, written by `markOrderUnderpaid`
 * (crud/orderStatus.ts). Checks all three; at most one will ever have a matching
 * row for a given order. Each candidate is tested on its own nullable amount
 * column rather than falling through on the row as a whole, so a row that exists
 * but records no amount cannot mask a later table that does record one.
 */
export async function findUnderpaidReceived(db: Db, orderId: number): Promise<Decimal | null> {
  const [binance, bybit, qris] = await Promise.all([
    db.processedBinanceTx.findFirst({ where: { orderId, outcome: "underpaid" }, orderBy: { createdAt: "desc" } }),
    db.processedBybitTx.findFirst({ where: { orderId, outcome: "underpaid" }, orderBy: { createdAt: "desc" } }),
    db.qrisUnderpaidTx.findFirst({ where: { orderId } }),
  ]);
  if (binance?.amount != null) return new Decimal(binance.amount);
  if (bybit?.amount != null) return new Decimal(bybit.amount);
  if (qris?.receivedAmount != null) return new Decimal(qris.receivedAmount);
  return null;
}
