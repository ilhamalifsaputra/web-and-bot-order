import { paymentMethodLabel } from "@/lib/paymentMethod"

type RailFamily = "crypto" | "gateway" | "wallet" | "unknown";

const RAIL_FAMILY: Record<string, RailFamily> = {
  BINANCE_PAY: "crypto",
  BINANCE_INTERNAL: "crypto",
  BYBIT: "crypto",
  BYBIT_BSC: "crypto",
  TOKOPAY: "gateway",
  PAYDISINI: "gateway",
  NOWPAYMENTS: "gateway",
  WALLET: "wallet",
};

/** Same visual family as `StatusBadge` (pill shape/padding/type scale) —
 *  kept text-only since `StatusBadge`, its sibling, doesn't use icons
 *  either. Tint groups by rail family rather than per-method, since there
 *  isn't a distinct hue per payment method in the token set. */
const FAMILY_CLASS: Record<RailFamily, string> = {
  crypto: "bg-pine-tint text-pine-dark",
  gateway: "bg-grass-tint text-grass-dark",
  wallet: "bg-sand text-ink-soft",
  unknown: "bg-sand text-ink-soft",
};

interface PaymentMethodBadgeProps {
  method: string;
}

export function PaymentMethodBadge({ method }: PaymentMethodBadgeProps): JSX.Element {
  const family = RAIL_FAMILY[method] ?? "unknown";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${FAMILY_CLASS[family]}`}>
      {paymentMethodLabel(method)}
    </span>
  )
}
