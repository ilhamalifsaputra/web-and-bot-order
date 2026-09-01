/**
 * Buy wallet CREDIT itself through the existing payment gateways (Task 5,
 * apps/storefront/src/routes/apiWalletTopup.ts). Structure mirrors
 * CheckoutPage.tsx closely — same enabled-gateway radio list, same
 * humanError() i18n-key convention, same "seed once from the first GET, then
 * let local state drive the form" split — with the parts that don't apply
 * here removed: no cart, no voucher, no wallet-credit radio (topping up WITH
 * wallet credit makes no sense), no manual_with_info info step.
 *
 * currency toggle → amount input (server limits are the real gate;
 * client-side min/max is a UX hint only) → gateway picker → POST
 * /api/v1/wallet/topup → navigate to the pay screen.
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Wallet } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { WalletTopupCreateResponse, WalletTopupData } from "../api/types";
import { t } from "../lib/i18n";
import { formatIdr, formatNativeUsdt } from "../lib/format";
import EmptyState from "../components/shop/EmptyState";
import Skeleton from "../components/shop/Skeleton";
import Spinner from "../components/shop/Spinner";
import { PaymentMethodRow } from "../components/shop/PaymentMethodSelector";

type Currency = "IDR" | "USDT";

/** Same i18n-key-vs-developer-fallback split CheckoutPage.tsx's humanError
 * uses — the server's own failures arrive as i18n keys, everything else
 * (network error, unexpected status) becomes the generic apology. */
function humanError(message: string): string {
  return message.startsWith("web.") || message.startsWith("error.") ? t(message) : t("web.error_message");
}

interface MethodOption {
  value: string;
  titleKey: string;
  subtitleKey: string;
}

const IDR_METHODS: MethodOption[] = [
  { value: "qris", titleKey: "web.pay_idr_title", subtitleKey: "web.pay_idr_sub" },
  { value: "paydisini", titleKey: "web.pay_paydisini_title", subtitleKey: "web.pay_paydisini_sub" },
];
const USDT_METHODS: MethodOption[] = [
  { value: "binance", titleKey: "web.pay_usdt_title", subtitleKey: "web.pay_usdt_sub" },
  { value: "bybit", titleKey: "web.pay_bybit_title", subtitleKey: "web.pay_bybit_sub" },
  { value: "bybit_bsc", titleKey: "web.pay_bybit_bsc_title", subtitleKey: "web.pay_bybit_bsc_sub" },
  { value: "nowpayments", titleKey: "web.pay_nowpayments_title", subtitleKey: "web.pay_nowpayments_sub" },
];

/** Which of a currency's methods the server says are actually configured —
 * mirrors CheckoutPage.tsx's per-flag gating, just table-driven instead of
 * eight near-identical `{page.x_enabled && ...}` blocks (there's no fee-note
 * variance here to justify the longer form; per-method icons are looked up
 * separately via iconFor()). */
function methodsFor(data: WalletTopupData, currency: Currency): MethodOption[] {
  const enabledMap: Record<string, boolean> =
    currency === "IDR"
      ? { qris: data.idr_enabled, paydisini: data.paydisini_enabled }
      : {
          binance: data.binance_enabled,
          bybit: data.bybit_enabled,
          bybit_bsc: data.bybit_bsc_enabled,
          nowpayments: data.nowpayments_enabled,
        };
  const list = currency === "IDR" ? IDR_METHODS : USDT_METHODS;
  return list.filter((m) => enabledMap[m.value]);
}

/** Server-configured min/max for `currency`, formatted for display — a plain
 * "between X and Y" / "at least X" / "up to Y" hint. null when neither bound
 * is set. */
function limitsHint(data: WalletTopupData, currency: Currency): string | null {
  const min = currency === "IDR" ? data.min_idr : data.min_usdt;
  const max = currency === "IDR" ? data.max_idr : data.max_usdt;
  const fmt = (v: string) => (currency === "IDR" ? formatIdr(v) : formatNativeUsdt(v));
  if (min && max) return t("web.wallet_topup_range_hint", { min: fmt(min), max: fmt(max) });
  if (min) return t("web.wallet_topup_min_hint", { min: fmt(min) });
  if (max) return t("web.wallet_topup_max_hint", { max: fmt(max) });
  return null;
}

/** UX convenience only — createWalletTopupOrder (server) is the real gate. */
function amountValid(data: WalletTopupData, currency: Currency, amount: string): boolean {
  const n = Number(amount);
  if (!amount.trim() || Number.isNaN(n) || n <= 0) return false;
  const min = currency === "IDR" ? data.min_idr : data.min_usdt;
  const max = currency === "IDR" ? data.max_idr : data.max_usdt;
  if (min && n < Number(min)) return false;
  if (max && n > Number(max)) return false;
  return true;
}

/** Same gateway → logo mapping PaymentMethodSelector.tsx uses for
 * CheckoutPage/InstantBuyPage, so the top-up picker shows the real QRIS/
 * Binance/Bybit marks instead of a generic wallet glyph for every row. */
function iconFor(value: string): ReactNode {
  switch (value) {
    case "qris":
    case "paydisini":
      return (
        <img
          src="/static/pay/qris.png"
          alt={value === "qris" ? "QRIS" : "PayDisini"}
          className="h-7 w-auto max-w-20 object-contain shrink-0 mt-0.5"
        />
      );
    case "binance":
      return (
        <img src="/static/pay/binance.png" alt="Binance" className="h-7 w-7 object-contain shrink-0 mt-0.5" />
      );
    case "bybit":
    case "bybit_bsc":
      return (
        <img
          src="/static/pay/bybit.png"
          alt="Bybit"
          className="h-7 w-7 rounded-sm object-contain shrink-0 mt-0.5"
        />
      );
    case "nowpayments":
      return (
        <img
          src="/static/pay/nowpayments.png"
          alt="NOWPayments"
          className="h-7 w-7 rounded-sm object-contain shrink-0 mt-0.5"
        />
      );
    default:
      return <Wallet className="h-6 w-6 shrink-0 mt-0.5 text-pine" aria-hidden="true" />;
  }
}

export default function WalletTopupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselect = searchParams.get("currency") === "USDT" ? "USDT" : "IDR";

  const { data, error } = useQuery({
    queryKey: ["wallet-topup"],
    queryFn: () => apiGet<WalletTopupData>("/api/v1/wallet/topup"),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent("/wallet/topup"));
    }
  }, [error]);

  const [currency, setCurrency] = useState<Currency>(preselect);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string | null>(null);
  const [submitErrorKey, setSubmitErrorKey] = useState<string | null>(null);

  // Re-pick the default method whenever the currency (or the enabled-gateway
  // payload) changes, mirroring CheckoutPage's defaultMethod cascade: first
  // enabled option wins, cleared to null when the switch leaves none enabled.
  useEffect(() => {
    if (!data) return;
    const options = methodsFor(data, currency);
    setMethod(options[0]?.value ?? null);
  }, [data, currency]);

  const submitMutation = useMutation({
    mutationFn: () =>
      apiPost<WalletTopupCreateResponse>("/api/v1/wallet/topup", { currency, amount, method }),
    onSuccess: (resp) => navigate(`/wallet/topup/${resp.orderCode}/pay`),
    onError: (err) => setSubmitErrorKey((err as Error).message),
  });

  if (!data) {
    if (!error) {
      return (
        <div aria-busy="true" aria-label={t("web.loading")}>
          <Skeleton className="mb-5 h-8 w-48" />
          <div className="card card-pad space-y-3 max-w-lg">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        </div>
      );
    }
    return (
      <>
        <h1 className="page-title text-2xl! mb-5">{t("web.wallet_topup_title")}</h1>
        <EmptyState
          icon={AlertTriangle}
          title={t("web.checkout_unavailable")}
          description={humanError((error as Error).message)}
          action={{ label: t("web.account_title"), to: "/account" }}
        />
      </>
    );
  }

  const options = methodsFor(data, currency);
  const hint = limitsHint(data, currency);
  const valid = amountValid(data, currency, amount);
  const submitBlocked = !valid || !method;
  const submitDisabled = submitBlocked || submitMutation.isPending;

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="page-title text-2xl! mb-5">{t("web.wallet_topup_title")}</h1>

      {submitErrorKey && (
        <div className="card card-pad border-rust/40 bg-rust-tint text-rust-dark text-sm mb-5 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {humanError(submitErrorKey)}
        </div>
      )}

      <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
        <div className="card card-pad space-y-4">
          {/* Currency toggle */}
          <div>
            <label className="field-label mb-2 block">{t("web.wallet_topup_currency_label")}</label>
            <div className="grid grid-cols-2 gap-2">
              {(["IDR", "USDT"] as const).map((cur) => (
                <button
                  key={cur}
                  type="button"
                  className={
                    cur === currency
                      ? "btn btn-primary"
                      : "btn btn-soft"
                  }
                  onClick={() => setCurrency(cur)}
                >
                  {cur === "IDR" ? t("web.wallet_topup_currency_idr") : t("web.wallet_topup_currency_usdt")}
                </button>
              ))}
            </div>
          </div>

          {/* Amount */}
          <div>
            <label className="field-label" htmlFor="topup_amount">
              {t("web.wallet_topup_amount_label")}
            </label>
            <input
              id="topup_amount"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className="field"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={currency === "IDR" ? "50000" : "10"}
            />
            {hint && <p className="mt-1.5 text-xs text-ink-soft">{hint}</p>}
          </div>
        </div>

        <div className="card card-pad">
          <h2 className="section-title mb-3">{t("web.wallet_topup_method_label")}</h2>
          <div className="space-y-3">
            {options.map((opt) => (
              <PaymentMethodRow
                key={opt.value}
                value={opt.value}
                checked={method === opt.value}
                onSelect={() => setMethod(opt.value)}
                icon={iconFor(opt.value)}
                title={t(opt.titleKey)}
                subtitle={t(opt.subtitleKey)}
              />
            ))}
            {options.length === 0 && (
              <div className="text-center text-sm text-ink-soft border border-dashed border-line rounded-xl py-6 px-3">
                <Wallet className="w-5 h-5 mx-auto mb-1.5 text-ink-faint" />
                <p>{t("web.wallet_topup_none_available")}</p>
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={submitDisabled}
          style={submitBlocked ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          onClick={() => submitMutation.mutate()}
        >
          {submitMutation.isPending && <Spinner />}
          {t("web.wallet_topup_submit")}
        </button>
      </form>
    </div>
  );
}
