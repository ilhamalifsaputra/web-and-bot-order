/**
 * Extracted from CheckoutPage.tsx (Task 6, storefront instant-buy pilot):
 * the voucher-input card plus the `#checkout-summary` totals card (two
 * separate `.card.card-pad` blocks in the original markup, kept as two
 * separate cards here too) so InstantBuyPage.tsx can render the identical
 * totals/voucher/submit UI without duplicating it. Pure move — parameterized
 * on props instead of closing over CheckoutPage's own state.
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
import { formatIdr } from "../../lib/format";
import FlashBadge, { flashPercentLabel } from "./FlashBadge";
import Price from "./Price";
import Spinner from "./Spinner";

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

  return (
    // A single grid child (space-y-6 stacks the two cards) rather than a bare
    // Fragment: CheckoutPage.tsx renders this as the third item of its
    // `grid lg:grid-cols-3` form, and a Fragment would hand the grid two
    // separate top-level children instead of one, breaking the column split.
    <div className="space-y-6">
      <div className="card card-pad">
        <label className="field-label" htmlFor="voucher_code">
          {t("web.voucher_label")}
        </label>
        <div className="flex gap-2">
          <input
            id="voucher_code"
            value={voucherInput}
            onChange={(e) => onVoucherInputChange(e.target.value)}
            onKeyDown={onVoucherKeyDown}
            className="field uppercase"
            placeholder={t("web.voucher_placeholder")}
            maxLength={32}
            aria-invalid={totals.error_key ? true : undefined}
            aria-describedby={totals.error_key ? "voucher_code_error" : undefined}
          />
          <button
            type="button"
            id="voucher_apply"
            className="btn btn-soft shrink-0"
            disabled={voucherPending}
            onClick={onVoucherApply}
          >
            {voucherPending && <Spinner />}
            {t("web.voucher_apply")}
          </button>
        </div>
        {/* STO-005: the voucher error belongs next to the field it
            validates, on every viewport — it used to render in the
            summary column, a full column gutter away on desktop. */}
        {totals.error_key && (
          <p id="voucher_code_error" role="alert" className="mt-2 text-sm text-rust-dark flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {t(totals.error_key)}
          </p>
        )}
      </div>

      <div id="checkout-summary">
        <div className="card card-pad">
          <h2 className="section-title mb-3">{t("web.summary")}</h2>
          <div className="text-sm divide-y divide-line">
            <div className="flex justify-between py-2">
              <span className="text-ink-soft">{t("web.subtotal")}</span>
              <span>{formatIdr(totals.subtotal)}</span>
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
                <span>−{formatIdr(totals.bulk_discount)}</span>
              </div>
            )}
            {totals.voucher_discount !== "0" && (
              <div className="flex justify-between py-2 text-grass-dark">
                <span>{t("web.voucher_discount")}</span>
                <span>−{formatIdr(totals.voucher_discount)}</span>
              </div>
            )}
            {method === "qris" && (
              <div className="flex justify-between py-2">
                <span className="text-ink-soft">{t("web.qris_admin_fee")}</span>
                <span>{formatIdr(totals.qris_admin_fee)}</span>
              </div>
            )}
            <div className="flex justify-between py-3 items-baseline">
              <span className="font-semibold">{t("web.order_total")}</span>
              <Price value={method === "qris" ? totals.qris_grand_total : totals.total} fx={fx} size="text-lg" />
            </div>
          </div>
          {fx && <p className="text-xs text-ink-faint">{t("web.usdt_note")}</p>}
          {/* Desktop only: on a phone this button lives in the sticky bar
              below instead. Rendering it in both places would put two
              identically-labelled submits in the page for assistive tech to
              disambiguate, so only one exists at a time. */}
          {showDesktopSubmit && (
            <button
              type="button"
              className="btn btn-primary w-full mt-4"
              disabled={submitDisabled}
              style={submitBlocked ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
              onClick={onSubmit}
            >
              {submitPending && <Spinner />}
              {submitLabel} {submitIcon ?? <ChevronRight className="w-4 h-4" />}
            </button>
          )}
          {backTo && (
            <Link to={backTo.to} className="btn btn-ghost w-full mt-2">
              {backTo.label}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
