/**
 * The money lines shared by the two "paid order queued for manual
 * fulfilment" notifications: the admin Telegram DM (ADMIN_MANUAL_ORDER_QUEUED,
 * templates.ts) and the owner email (OWNER_EMAIL_MANUAL_ORDER_QUEUED,
 * emailTemplates.ts). Both payloads are built by settlePaidOrder from
 * `reconciledOrderMoneyRows(order)` in the order's own settlement currency.
 *
 * Why not just print `total`. `total` is the amount still charged after wallet
 * credit, so an order paid entirely from wallet credit has a total of 0 — and
 * "Total: 0" read as the order being worth nothing. The headline is therefore
 * the ORDER VALUE (items total minus discounts); wallet credit and the amount
 * due appear as their own lines whenever wallet credit was used.
 *
 * A row enqueued before `order_value` existed carries only `total`/`currency`;
 * it still renders (as a formatted "Total" line), so a deploy never strands a
 * pending outbox row.
 *
 * Amounts arrive as decimal strings written by `Decimal.toString()` at enqueue
 * time — never typed input — so reading them back with `new Decimal` is exact.
 */
import { Decimal } from "@app/core/money";
import { formatMoney, formatUsdt } from "@app/core/formatters";

export type ManualQueueMoneyKey =
  | "items_total"
  | "bulk_discount"
  | "voucher_discount"
  | "order_value"
  | "wallet_credit"
  | "amount_due"
  | "amount_paid"
  | "total";

export interface ManualQueueMoneyLine {
  key: ManualQueueMoneyKey;
  /** Formatted amount, sign included for deductions (e.g. "-Rp50.000"). */
  amount: string;
}

export interface ManualQueueMoneyPayload {
  currency?: unknown;
  order_value?: unknown;
  subtotal?: unknown;
  bulk_discount?: unknown;
  discount?: unknown;
  wallet_credit?: unknown;
  unique_cents?: unknown;
  total?: unknown;
}

/** USDT keeps its full stored precision (a 0.028 unique-cents marker must not
 * round away), IDR goes through the Rupiah formatter — same rule as the owner
 * paid-order email. */
function money(amount: Decimal, currency: string): string {
  return currency === "USDT" ? formatUsdt(amount) : formatMoney(amount, currency);
}

function decimal(value: unknown): Decimal {
  return new Decimal(String(value ?? "0"));
}

export function manualQueueMoneyLines(payload: ManualQueueMoneyPayload): ManualQueueMoneyLine[] {
  const currency = String(payload.currency ?? "");
  const total = decimal(payload.total);
  if (payload.order_value == null) {
    return [{ key: "total", amount: money(total, currency) }];
  }
  const orderValue = decimal(payload.order_value);
  const bulk = decimal(payload.bulk_discount);
  const voucher = decimal(payload.discount);
  const wallet = decimal(payload.wallet_credit);
  const lines: ManualQueueMoneyLine[] = [];
  if (!bulk.isZero() || !voucher.isZero()) {
    lines.push({ key: "items_total", amount: money(decimal(payload.subtotal), currency) });
    if (!bulk.isZero()) lines.push({ key: "bulk_discount", amount: `-${money(bulk, currency)}` });
    if (!voucher.isZero()) lines.push({ key: "voucher_discount", amount: `-${money(voucher, currency)}` });
  }
  lines.push({ key: "order_value", amount: money(orderValue, currency) });
  if (!wallet.isZero()) {
    lines.push({ key: "wallet_credit", amount: `-${money(wallet, currency)}` });
    lines.push({ key: "amount_due", amount: money(total, currency) });
  } else if (!total.equals(orderValue)) {
    lines.push({ key: "amount_paid", amount: money(total, currency) });
  }
  return lines;
}
