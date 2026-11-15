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
 * Same two figures the bot uses, so "Price" means one thing on every surface:
 * Price is the order total
 * (`totals.total`) converted once via formatPriceFor; Pay is that same total in
 * Rupiah, formatted with `formatIdr` directly, never re-converted. That holds
 * for every IDR rail before payment: QRIS has no fee-inclusive figure yet —
 * TokoPay sets its admin fee when it creates the QR, and only PayPage.tsx,
 * after the order exists, shows TokoPay's own total. The figure is still
 * canonical IDR in the preview: a Decimal string the server computes in
 * Rupiah (routes/checkout.ts computeTotals) before any rail has touched it.
 * Shared by this card and both pages' sticky bars so the three surfaces
 * cannot drift apart.
 */
export function idrRailPriceAndPay(
  method: string | null,
  totals: Pick<CheckoutData, "total">,
  currency: "USD" | "IDR" | null,
  fx: string | null | undefined,
): string | null {
  if (!isIdrRail(method) || !showsUsdDisplay(currency, fx)) return null;
  return t("checkout.price_and_pay", {
    price: formatPriceFor(totals.total, currency, fx),
    pay: formatIdr(totals.total),
  });
}
