/**
 * Extracted from CheckoutPage.tsx (Task 6, storefront instant-buy pilot) so
 * InstantBuyPage.tsx can render the exact same payment-method picker without
 * duplicating the eight gated `<PaymentMethodRow>` call sites. Pure move: the
 * JSX, the default-selection cascade and the wallet-sufficiency checks are
 * unchanged from CheckoutPage.tsx — only the closures (`page`/`method`/
 * `setMethod`) became parameters (`data`/`method`/`onSelect`).
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Wallet } from "lucide-react";
import type { CheckoutData } from "../../api/types";
import { t } from "../../lib/i18n";
import { formatIdr, formatNativeUsdt } from "../../lib/format";

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

/**
 * One payment-method radio row (gateway or wallet credit — they are the same
 * radio group). The row has always been a `<label>` wrapping its radio, so the
 * whole rectangle was already tappable; what it lacked was a selected state a
 * thumb-held phone can read. The native radio dot sits at the row's left edge,
 * exactly where the hand covering the screen is, so the buyer could not tell
 * which rail was armed without moving their hand. `has-[:checked]:` tints and
 * outlines the entire row instead, and `focus-within` gives the same row a
 * visible ring when the group is walked with the arrow keys. checkout.njk had
 * neither (that pattern only existed on product.njk's DenominationCard) — a
 * deliberate departure from template parity, not a porting oversight.
 *
 * Extracted from eight near-identical inline labels so the row treatment lives
 * in one place; which rows render, and under what conditions, stays at the
 * call sites untouched.
 */
export function PaymentMethodRow({
  value,
  checked,
  onSelect,
  icon,
  title,
  subtitle,
  feeNote,
}: {
  value: string;
  checked: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  subtitle: string;
  feeNote?: string;
}) {
  return (
    <label className="flex items-start gap-3 p-3 rounded-xl border border-line transition-colors cursor-pointer hover:border-pine focus-within:ring-2 focus-within:ring-pine has-[:checked]:border-pine has-[:checked]:bg-pine-tint">
      <input
        type="radio"
        name="method"
        value={value}
        className="mt-1 size-4 shrink-0 accent-pine"
        checked={checked}
        onChange={onSelect}
      />
      {icon}
      {/* min-w-0 lets a long gateway description wrap rather than push the row
          wider than a 320px viewport. */}
      <span className="min-w-0">
        <span className="font-semibold text-sm block">{title}</span>
        <span className="text-xs text-ink-soft block mt-0.5">{subtitle}</span>
        {feeNote && <span className="text-xs text-ink-faint block mt-0.5">{feeNote}</span>}
      </span>
    </label>
  );
}

/**
 * The `.card.card-pad` payment-method picker — title, the eight conditional
 * `<PaymentMethodRow>` blocks (each gated on a `page.X_enabled` flag) and the
 * "no methods available" fallback. Shared between CheckoutPage.tsx and
 * InstantBuyPage.tsx (Task 6) so the two flows can never drift on which
 * methods are offered or how a row looks/behaves.
 */
export default function PaymentMethodSelector({
  data,
  method,
  onSelect,
}: {
  data: CheckoutData;
  method: string | null;
  onSelect: (method: string) => void;
}) {
  // Wallet-credit radios — only offered when credit fully covers the live
  // total (post-voucher); hidden (not disabled) otherwise.
  const idrWalletSufficient = isIdrWalletSufficient(data);
  const usdtWalletSufficient = isUsdtWalletSufficient(data);

  return (
    <div className="card card-pad">
      <h2 className="section-title mb-3">{t("web.pay_method")}</h2>
      <div className="space-y-3">
        {data.idr_enabled && (
          <PaymentMethodRow
            value="qris"
            checked={method === "qris"}
            onSelect={() => onSelect("qris")}
            icon={
              <img
                src="/static/pay/qris.png"
                alt="QRIS"
                className="h-7 w-auto max-w-[80px] object-contain shrink-0 mt-0.5"
              />
            }
            title={t("web.pay_idr_title")}
            subtitle={t("web.pay_idr_sub")}
            feeNote={t("web.qris_admin_fee_note")}
          />
        )}
        {data.paydisini_enabled && (
          <PaymentMethodRow
            value="paydisini"
            checked={method === "paydisini"}
            onSelect={() => onSelect("paydisini")}
            icon={
              <img
                src="/static/pay/qris.png"
                alt="PayDisini"
                className="h-7 w-auto max-w-[80px] object-contain shrink-0 mt-0.5"
              />
            }
            title={t("web.pay_paydisini_title")}
            subtitle={t("web.pay_paydisini_sub")}
          />
        )}
        {data.binance_enabled && (
          <PaymentMethodRow
            value="binance"
            checked={method === "binance"}
            onSelect={() => onSelect("binance")}
            icon={
              <img
                src="/static/pay/binance.png"
                alt="Binance"
                className="h-7 w-7 object-contain shrink-0 mt-0.5"
              />
            }
            title={t("web.pay_usdt_title")}
            subtitle={t("web.pay_usdt_sub")}
          />
        )}
        {data.bybit_enabled && (
          <PaymentMethodRow
            value="bybit"
            checked={method === "bybit"}
            onSelect={() => onSelect("bybit")}
            icon={
              <img
                src="/static/pay/bybit.png"
                alt="Bybit"
                className="h-7 w-7 rounded-sm object-contain shrink-0 mt-0.5"
              />
            }
            title={t("web.pay_bybit_title")}
            subtitle={t("web.pay_bybit_sub")}
          />
        )}
        {data.bybit_bsc_enabled && (
          <PaymentMethodRow
            value="bybit_bsc"
            checked={method === "bybit_bsc"}
            onSelect={() => onSelect("bybit_bsc")}
            icon={
              <img
                src="/static/pay/bybit.png"
                alt="Bybit"
                className="h-7 w-7 rounded-sm object-contain shrink-0 mt-0.5"
              />
            }
            title={t("web.pay_bybit_bsc_title")}
            subtitle={t("web.pay_bybit_bsc_sub")}
          />
        )}
        {data.nowpayments_enabled && (
          <PaymentMethodRow
            value="nowpayments"
            checked={method === "nowpayments"}
            onSelect={() => onSelect("nowpayments")}
            icon={
              <img
                src="/static/pay/nowpayments.png"
                alt="NOWPayments"
                className="h-7 w-7 rounded-sm object-contain shrink-0 mt-0.5"
              />
            }
            title={t("web.pay_nowpayments_title")}
            subtitle={t("web.pay_nowpayments_sub")}
          />
        )}
        {idrWalletSufficient && (
          <PaymentMethodRow
            value="wallet_idr"
            checked={method === "wallet_idr"}
            onSelect={() => onSelect("wallet_idr")}
            icon={<Wallet className="h-7 w-7 object-contain shrink-0 mt-0.5 text-pine" />}
            title={t("web.pay_wallet_idr_title")}
            subtitle={t("web.pay_wallet_idr_sub", { amount: formatIdr(data.wallet_idr) })}
          />
        )}
        {usdtWalletSufficient && (
          <PaymentMethodRow
            value="wallet_usdt"
            checked={method === "wallet_usdt"}
            onSelect={() => onSelect("wallet_usdt")}
            icon={<Wallet className="h-7 w-7 object-contain shrink-0 mt-0.5 text-pine" />}
            title={t("web.pay_wallet_usdt_title")}
            subtitle={t("web.pay_wallet_usdt_sub", { amount: formatNativeUsdt(data.wallet_usdt) })}
          />
        )}
        {!anyMethodEnabled(data) && !idrWalletSufficient && !usdtWalletSufficient && (
          <div className="text-center text-sm text-ink-soft border border-dashed border-line rounded-xl py-6 px-3">
            <Wallet className="w-5 h-5 mx-auto mb-1.5 text-ink-faint" />
            <p>
              {t("web.pay_none_available_prefix")}{" "}
              <Link to="/account/support" className="text-pine underline transition-colors hover:text-pine-dark">
                {t("web.pay_none_available_link")}
              </Link>
              {t("web.pay_none_available_suffix")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
