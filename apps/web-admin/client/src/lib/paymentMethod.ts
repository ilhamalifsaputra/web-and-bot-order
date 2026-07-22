/**
 * Human-readable labels for backend payment-method enum values
 * (SCREAMING_SNAKE_CASE, e.g. `BINANCE_PAY`). Shared across any page that
 * needs to render a payment method to an admin — currently the Orders table
 * (`OrdersPage.tsx`) and `PaymentMethodBadge`. Mirrors `lib/orderStatus.ts`'s
 * exact pattern so both enums stay tunable independently of generic
 * title-casing without hunting down every call site.
 */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  BINANCE_PAY: "Binance Pay",
  BINANCE_INTERNAL: "Binance Internal",
  BYBIT: "Bybit",
  BYBIT_BSC: "Bybit (BSC)",
  TOKOPAY: "TokoPay",
  PAYDISINI: "PayDisini",
  NOWPAYMENTS: "NOWPayments",
  WALLET: "Store Credit",
};

/** Human-readable label for a raw payment method; falls back to the raw
 * value for any method not in the map (e.g. an enum value added on the
 * backend before this map is updated), so nothing silently disappears. */
export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method] ?? method;
}
