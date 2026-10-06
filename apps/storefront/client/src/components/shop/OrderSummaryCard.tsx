/**
 * Extracted from CheckoutPage.tsx (Task 6, storefront instant-buy pilot):
 * the voucher-input card plus the `#checkout-summary` totals card (two
 * separate `.card.card-pad` blocks in the original markup, kept as two
 * separate cards here too) so InstantBuyPage.tsx can render the identical
 * totals/voucher/submit UI without duplicating it. Pure move — parameterized
 * on props instead of closing over CheckoutPage's own state.
 *
 * Design-system migration (Fase 7c): the two `.card.card-pad` blocks are now
 * `<Card>`, the voucher control is `<Label>` + `<Input>` + an inline apply
 * `<Button variant="soft">`, and the submit is `<Button variant="primary"
 * fullWidth>`. The summary line rows — which numbers show, and where they
 * come from — are UNCHANGED: money is Decimal, formatted only at this render
 * boundary. Task 5 (multi-currency display): every row here is a
 * catalog/cart/checkout-preview IDR figure (subtotal, discounts, the QRIS
 * admin fee preview), so `formatPriceFor`/`<Price>` — both currency-aware —
 * replace the old unconditional `formatIdr`; `currency` is read off the
 * shared `["context"]` query (`useShopContext`) rather than threaded as a
 * prop, same as `<Price>` itself. The voucher field composes
 * `<Label>` + `<Input>` directly rather than a literal `<FormField>` because
 * the apply `<Button>` sits inline beside the input (FormField clones a single
 * control child and cannot hold the adjacent button).
 *
 * `submitLabel`/`submitIcon` and `backTo` are the only two seams CheckoutPage
 * and InstantBuyPage don't share verbatim: CheckoutPage says "Place order &
 * pay" with a back-to-cart link (there is a cart to go back to); InstantBuyPage
 * is a single-page buy with no separate cart/checkout screens, so it supplies
 * its own label/icon and omits `backTo` entirely.
 */
import type { KeyboardEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ChevronRight } from "lucide-react";
import type { CheckoutData } from "../../api/types";
import { t } from "../../lib/i18n";
import { formatIdr, formatPriceFor, isIdrRail, showsUsdDisplay } from "../../lib/format";
import { useShopContext } from "../../lib/useShopContext";
import FlashBadge, { flashPercentLabel } from "./FlashBadge";
import Price from "./Price";
import Spinner from "./Spinner";
import Card from "../ui/Card";
import Button from "../ui/Button";
import Input from "../ui/Input";
import Label from "../ui/Label";
import { cn } from "../ui/cn";

/**
 * The biggest live flash discount in the cart, plus the last moment any of
 * them is still running — the summary's one modest "this is a sale price"
 * marker. Read from the checkout payload's own `items`, which are priced and
 * flagged against the same instant as the totals beside them, so the marker
 * can never disagree with the figures it annotates.
 */
function cartFlashSummary(data: CheckoutData | undefined): { percent: number; endsAt: string | null } | null {
  let percent: number | null = null;
  let endsAt: string | null = null;
  for (const line of data?.items ?? []) {
    const pct = flashPercentLabel(line.flash?.discount_percent);
    if (pct === null) continue;
    if (percent === null || pct > percent) percent = pct;
    const lineEnd = line.flash?.ends_at ?? null;
    if (lineEnd && (endsAt === null || lineEnd > endsAt)) endsAt = lineEnd;
  }
  return percent === null ? null : { percent, endsAt };
}

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

export interface OrderSummaryCardProps {
  totals: CheckoutData;
  method: string | null;
  fx: string | null | undefined;
  voucherInput: string;
  onVoucherInputChange: (value: string) => void;
  onVoucherApply: () => void;
  onVoucherKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  voucherPending: boolean;
  /** Desktop only: on a phone the caller renders its own sticky bottom bar
   * with the same total + submit control instead (see CheckoutPage.tsx /
   * InstantBuyPage.tsx) — rendering it here too would put two
   * identically-labelled submits on the page. */
  showDesktopSubmit: boolean;
  submitLabel: string;
  /** Defaults to the chevron CheckoutPage has always used. */
  submitIcon?: ReactNode;
  /** The `disabled` attribute — blocked OR a request is in flight. */
  submitDisabled: boolean;
  /** The permanent "not payable yet" state (blocked, but not necessarily
   * in-flight) — dims the button without disabling native click-through
   * semantics differently from `submitDisabled`, matching CheckoutPage's
   * existing split between the two. */
  submitBlocked: boolean;
  onSubmit: () => void;
  submitPending: boolean;
  /** CheckoutPage's "Back to cart" link — omitted entirely by InstantBuyPage,
   * which has no separate cart screen in this flow. */
  backTo?: { label: string; to: string };
}

export default function OrderSummaryCard({
  totals,
  method,
  fx,
  voucherInput,
  onVoucherInputChange,
  onVoucherApply,
  onVoucherKeyDown,
  voucherPending,
  showDesktopSubmit,
  submitLabel,
  submitIcon,
  submitDisabled,
  submitBlocked,
  onSubmit,
  submitPending,
  backTo,
}: OrderSummaryCardProps) {
  const flashSummary = cartFlashSummary(totals);
  const { data: ctx } = useShopContext();
  const currency = ctx?.currency ?? null;
  // Final-review fix: a USD viewer on an IDR-settled method (QRIS/TokoPay,
  // PayDisini, wallet_idr) would otherwise see only "$" figures that don't
  // match what they're charged — see idrRailPriceAndPay above. Non-null gates
  // the Rp fee suffix too.
  const priceAndPay = idrRailPriceAndPay(method, totals, currency, fx);

  return (
    // Keep the coupon and summary together in normal flow after payment.
    <div className="space-y-6">
      <Card>
        <Label htmlFor="voucher_code">{t("web.voucher_label")}</Label>
        <div className="flex gap-2">
          <Input
            id="voucher_code"
            value={voucherInput}
            onChange={(e) => onVoucherInputChange(e.target.value)}
            onKeyDown={onVoucherKeyDown}
            className="min-w-0 uppercase"
            placeholder={t("web.voucher_placeholder")}
            maxLength={32}
            invalid={totals.error_key ? true : undefined}
            aria-describedby={totals.error_key ? "voucher_code_error" : undefined}
          />
          <Button
            id="voucher_apply"
            variant="soft"
            className="shrink-0"
            disabled={voucherPending}
            onClick={onVoucherApply}
          >
            {voucherPending && <Spinner />}
            {t("web.voucher_apply")}
          </Button>
        </div>
        {/* STO-005: the voucher error belongs next to the field it
            validates, on every viewport — it used to render in the
            summary column, a full column gutter away on desktop. */}
        {totals.error_key && (
          <p id="voucher_code_error" role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-rust-dark">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {t(totals.error_key)}
          </p>
        )}
      </Card>

      <div id="checkout-summary">
        <Card>
          <h2 className="section-title mb-3">{t("web.summary")}</h2>
          <div className="text-sm divide-y divide-line">
            <div className="flex justify-between py-2">
              <span className="text-ink-soft">{t("web.subtotal")}</span>
              <span>{formatPriceFor(totals.subtotal, currency, fx)}</span>
            </div>
            {/* Modest marker only: the subtotal above is already the sale
                price, and the full countdown belongs on the product page. */}
            {flashSummary && (
              <div className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-ink-soft">{t("web.flash_applied")}</span>
                <FlashBadge percent={flashSummary.percent} endsAt={flashSummary.endsAt} />
              </div>
            )}
            {totals.bulk_discount !== "0" && (
              <div className="flex justify-between py-2 text-grass-dark">
                <span>{t("web.bulk_discount")}</span>
                <span>−{formatPriceFor(totals.bulk_discount, currency, fx)}</span>
              </div>
            )}
            {totals.voucher_discount !== "0" && (
              <div className="flex justify-between py-2 text-grass-dark">
                <span>{t("web.voucher_discount")}</span>
                <span>−{formatPriceFor(totals.voucher_discount, currency, fx)}</span>
              </div>
            )}
            {method === "qris" && (
              <div className="flex justify-between py-2">
                <span className="text-ink-soft">{t("web.qris_admin_fee")}</span>
                <span>
                  {formatPriceFor(totals.qris_admin_fee, currency, fx)}
                  {priceAndPay && (
                    <span className="text-ink-faint"> · {formatIdr(totals.qris_admin_fee)}</span>
                  )}
                </span>
              </div>
            )}
            <div className="flex items-baseline justify-between py-3">
              <span className="text-base font-semibold text-ink">{t("web.order_total")}</span>
              <Price value={method === "qris" ? totals.qris_grand_total : totals.total} fx={fx} size="text-lg" />
            </div>
          </div>
          {priceAndPay && <p className="mb-2 text-right text-sm text-ink-soft">{priceAndPay}</p>}
          {fx && <p className="text-xs text-ink-faint">{t("web.usdt_note")}</p>}
          {/* Desktop only: on a phone this button lives in the sticky bar
              below instead. Rendering it in both places would put two
              identically-labelled submits in the page for assistive tech to
              disambiguate, so only one exists at a time. */}
          {showDesktopSubmit && (
            <Button
              variant="primary"
              fullWidth
              className={cn("mt-4", submitBlocked && "opacity-50")}
              disabled={submitDisabled}
              onClick={onSubmit}
            >
              {submitPending && <Spinner />}
              {submitLabel} {submitIcon ?? <ChevronRight className="w-4 h-4" />}
            </Button>
          )}
          {backTo && (
            <Link to={backTo.to} className="btn btn-ghost w-full mt-2">
              {backTo.label}
            </Link>
          )}
        </Card>
      </div>
    </div>
  );
}
