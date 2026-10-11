import type { CheckoutData } from "../../api/types";
import { formatIdr, formatPriceFor, isIdrRail, showsUsdDisplay } from "../../lib/format";
import { t } from "../../lib/i18n";

/**
 * Final-review fix: the "Price $X · Pay RpY" line for a checkout preview — the
 * web twin of the bot's payAlongsidePriceLine, through the same shared
 * `checkout.price_and_pay` locale key. Non-null ONLY when the viewer's display
 * currency renders as "$" (USD preference + usable rate) AND the selected
 * method is IDR-settled (QRIS/TokoPay, PayDisini, or a wallet_idr balance
 * debit) — exactly the case where what the viewer sees differs from what
 * they're actually charged. IDR/null viewers, a missing rate, and USDT rails
 * all get null.
 *
 * Same two figures the bot uses (and PayPage.tsx after the order exists), so
 * "Price" means one thing on every surface: Price is the pre-fee order total
 * (`totals.total`) converted once via formatPriceFor; Pay is the actual IDR
 * charge — `qris_grand_total` on QRIS (fee-inclusive), `total` on PayDisini or
 * wallet_idr (no fee) — formatted with `formatIdr` directly, never re-converted.
 * Both are still canonical IDR in the preview: Decimal strings the server
 * computes in Rupiah (routes/checkout.ts cartTotals) before any rail has
 * touched them. Shared by this card and both pages' sticky bars so the three
 * surfaces cannot drift apart.
 */
export function idrRailPriceAndPay(
  method: string | null,
  totals: Pick<CheckoutData, "total" | "qris_grand_total">,
  currency: "USD" | "IDR" | null,
  fx: string | null | undefined,
): string | null {
  if (!isIdrRail(method) || !showsUsdDisplay(currency, fx)) return null;
  const payableIdr = method === "qris" ? totals.qris_grand_total : totals.total;
  return t("checkout.price_and_pay", {
    price: formatPriceFor(totals.total, currency, fx),
    pay: formatIdr(payableIdr),
  });
}
