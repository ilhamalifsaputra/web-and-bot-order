import type { CheckoutData } from "../../api/types";

/** All-or-nothing wallet-credit gates: only "sufficient" when the balance
 * covers the live total outright — never offered as a partial discount.
 * `wallet_*_enabled` comes first because it answers a different question: may
 * this shop offer a balance payment to THIS visitor at all (it is false for a
 * guest, who has no wallet behind the number). Reading the server's flag
 * rather than `is_guest` keeps that decision on the server side. */
export function isIdrWalletSufficient(data: CheckoutData): boolean {
  return data.wallet_idr_enabled && Number(data.total) > 0 && Number(data.wallet_idr) >= Number(data.total);
}

export function isUsdtWalletSufficient(data: CheckoutData): boolean {
  return (
    data.wallet_usdt_enabled && data.total_usdt != null && Number(data.wallet_usdt) >= Number(data.total_usdt)
  );
}

/** checkout.njk's default-selection cascade: the first enabled method wins,
 * in file/priority order (qris → paydisini → binance → bybit → bybit_bsc →
 * nowpayments), falling back to wallet credit only when no gateway is
 * configured at all — a buyer with both a gateway and wallet credit
 * available shouldn't have their credit silently pre-selected for them.
 * Returns null when nothing is payable. */
export function defaultMethod(data: CheckoutData): string | null {
  if (data.idr_enabled) return "qris";
  if (data.paydisini_enabled) return "paydisini";
  if (data.binance_enabled) return "binance";
  if (data.bybit_enabled) return "bybit";
  if (data.bybit_bsc_enabled) return "bybit_bsc";
  if (data.nowpayments_enabled) return "nowpayments";
  if (isIdrWalletSufficient(data)) return "wallet_idr";
  if (isUsdtWalletSufficient(data)) return "wallet_usdt";
  return null;
}

export function anyMethodEnabled(data: CheckoutData): boolean {
  return (
    data.idr_enabled ||
    data.paydisini_enabled ||
    data.binance_enabled ||
    data.bybit_enabled ||
    data.bybit_bsc_enabled ||
    data.nowpayments_enabled
  );
}

/**
 * Whether `method` is still one of the rows this component would actually
 * render for `data` — i.e. the single source of truth this file already
 * has for "which methods are offered", reused instead of re-deriving it at
 * each call site. Exists for InstantBuyPage.tsx's re-pricing case (Task 6
 * review, I-3): picking a pricier denomination can re-price the order past a
 * wallet-credit balance that covered the cheaper one, and `method` itself
 * doesn't auto-clear just because the totals changed under it — callers use
 * this to notice and reset the selection instead of leaving `method` pointed
 * at a row that no longer renders.
 */
export function isMethodValid(data: CheckoutData, method: string | null): boolean {
  switch (method) {
    case "qris":
      return data.idr_enabled;
    case "paydisini":
      return data.paydisini_enabled;
    case "binance":
      return data.binance_enabled;
    case "bybit":
      return data.bybit_enabled;
    case "bybit_bsc":
      return data.bybit_bsc_enabled;
    case "nowpayments":
      return data.nowpayments_enabled;
    case "wallet_idr":
      return isIdrWalletSufficient(data);
    case "wallet_usdt":
      return isUsdtWalletSufficient(data);
    default:
      return false;
  }
}
