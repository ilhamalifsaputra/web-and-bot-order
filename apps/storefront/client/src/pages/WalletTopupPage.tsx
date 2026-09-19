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
 *
 * Design-system migration (Task 14): mirrors CheckoutPage.tsx's card/field/
 * button treatment — `<Card>`, `<FormField>`+`<Input>` for the amount,
 * `<Alert variant="banner" tone="error">` for the submit-error banner,
 * `<Button>` for the currency toggle + submit. `PaymentMethodRow` (from
 * `PaymentMethodSelector.tsx`) is unchanged — already migrated in Task 13,
 * re-verified here, not re-migrated. See deviations.md
 * §14-pay-topup-track. No mutation payload, endpoint, or gating logic
 * changed.
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Wallet } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { WalletTopupCreateResponse, WalletTopupData } from "../api/types";
import { t } from "../lib/i18n";
import { humanError } from "../lib/errors";
import { formatIdr, formatNativeUsdt } from "../lib/format";
import EmptyState from "../components/shop/EmptyState";
import Skeleton from "../components/shop/Skeleton";
import Spinner from "../components/shop/Spinner";
import { PaymentMethodRow } from "../components/shop/PaymentMethodSelector";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import FormField from "../components/ui/FormField";
import Input from "../components/ui/Input";
import Label from "../components/ui/Label";
import { cn } from "../components/ui/cn";

type Currency = "IDR" | "USDT";

/* `humanError` now comes from lib/errors.ts and takes the ERROR rather than its
 * message (whole-branch review F4a) — same i18n-key-vs-developer-fallback split
 * as before, plus the `{placeholder}` figures the rejection carried. */

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
function configuredMethodsFor(data: WalletTopupData, currency: Currency): MethodOption[] {
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

/**
 * Which configured rails the typed amount can actually be paid through
 * (whole-branch review F3).
 *
 * `finalizeWalletTopupPayment` refuses a top-up below the chosen rail's floor, so
 * offering such a rail turns a fixable "type a bigger number" into a failed
 * submission on the next screen. The floors come from the server
 * (`data.rail_min`, already in the currency being typed) rather than being
 * re-derived here — see the field's own comment in api/types.ts.
 *
 * An amount that is blank or not a positive number filters NOTHING: there is no
 * figure to judge yet, and emptying the input must not make the whole picker
 * vanish. Same reason `railsClearingTheTotal` (routes/checkout.ts) exempts a zero
 * total. A rail with a null floor has nothing to clear and always survives.
 *
 * Client-side UX only, like every other check on this form: the create call
 * re-runs the real guard.
 */
function offeredMethodsFor(data: WalletTopupData, currency: Currency, amount: string): MethodOption[] {
  const configured = configuredMethodsFor(data, currency);
  const typed = Number(amount);
  if (!amount.trim() || !Number.isFinite(typed) || typed <= 0) return configured;
  return configured.filter((m) => {
    const floor = data.rail_min?.[m.value];
    return !floor || typed >= Number(floor);
  });
}

/** The minimum to advertise and to judge a typed amount by: the server's
 * EFFECTIVE minimum, which already folds the top-up bound together with the
 * floors of the rails on offer (whole-branch review F4b). Reading `min_idr`/
 * `min_usdt` here is what let this form promise a figure the create call then
 * refused. */
function effectiveMin(data: WalletTopupData, currency: Currency): string | null {
  return currency === "IDR" ? data.effective_min_idr : data.effective_min_usdt;
}

/** Server-configured min/max for `currency`, formatted for display — a plain
 * "between X and Y" / "at least X" / "up to Y" hint. null when neither bound
 * is set. */
function limitsHint(data: WalletTopupData, currency: Currency): string | null {
  const min = effectiveMin(data, currency);
  const max = currency === "IDR" ? data.max_idr : data.max_usdt;
  const fmt = (v: string) => (currency === "IDR" ? formatIdr(v) : formatNativeUsdt(v));
  if (min && max) return t("web.wallet_topup_range_hint", { min: fmt(min), max: fmt(max) });
  if (min) return t("web.wallet_topup_min_hint", { min: fmt(min) });
  if (max) return t("web.wallet_topup_max_hint", { max: fmt(max) });
  return null;
}

/** UX convenience only — createWalletTopupOrder (server) is the real gate.
 * Judges the amount by the same EFFECTIVE minimum the hint above advertises, so
 * the sentence the buyer reads and the button's enabled state can never disagree
 * (F4b). */
function amountValid(data: WalletTopupData, currency: Currency, amount: string): boolean {
  const n = Number(amount);
  if (!amount.trim() || Number.isNaN(n) || n <= 0) return false;
  const min = effectiveMin(data, currency);
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
  const [submitError, setSubmitError] = useState<unknown>(null);

  // Re-pick the default method whenever the currency, the enabled-gateway
  // payload, or the amount changes, mirroring CheckoutPage's defaultMethod
  // cascade: first offered option wins, cleared to null when nothing is offered.
  //
  // A selection the buyer made themselves is KEPT while it is still offered
  // (whole-branch review F3): the amount is in this dependency list so a rail
  // that stops accepting the typed figure gets dropped, and resetting to the
  // first row on every keystroke would silently move a deliberate choice back to
  // QRIS as the buyer finished typing.
  useEffect(() => {
    if (!data) return;
    const options = offeredMethodsFor(data, currency, amount);
    setMethod((current) =>
      current && options.some((m) => m.value === current) ? current : (options[0]?.value ?? null),
    );
  }, [data, currency, amount]);

  const submitMutation = useMutation({
    mutationFn: () =>
      apiPost<WalletTopupCreateResponse>("/api/v1/wallet/topup", { currency, amount, method }),
    onSuccess: (resp) => navigate(`/wallet/topup/${resp.orderCode}/pay`),
    onError: (err) => setSubmitError(err),
  });

  if (!data) {
    if (!error) {
      return (
        <div aria-busy="true" aria-label={t("web.loading")}>
          <Skeleton className="mb-5 h-8 w-48" />
          <Card className="space-y-3 max-w-lg">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </Card>
        </div>
      );
    }
    return (
      <>
        <h1 className="page-title text-2xl! mb-5">{t("web.wallet_topup_title")}</h1>
        <EmptyState
          icon={AlertTriangle}
          title={t("web.checkout_unavailable")}
          description={humanError(error)}
          action={{ label: t("web.account_title"), to: "/account" }}
        />
      </>
    );
  }

  const options = offeredMethodsFor(data, currency, amount);
  // The shop HAS a working gateway for this currency and the amount is simply
  // under every one of their floors. Two causes look identical in an empty
  // picker and need opposite messages — the same distinction
  // PaymentMethodSelector.tsx draws with `below_all_minimums` on the product
  // checkout page. "Check back soon" would leave a buyer waiting for something
  // that will never change, when all they have to do is type a larger amount.
  const belowEveryRailMinimum = options.length === 0 && configuredMethodsFor(data, currency).length > 0;
  const hint = limitsHint(data, currency);
  const valid = amountValid(data, currency, amount);
  const submitBlocked = !valid || !method;
  const submitDisabled = submitBlocked || submitMutation.isPending;

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="page-title text-2xl! mb-5">{t("web.wallet_topup_title")}</h1>

      {submitError !== null && (
        <Alert variant="banner" tone="error">
          {humanError(submitError)}
        </Alert>
      )}

      <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
        <Card className="space-y-4">
          {/* Currency toggle */}
          <div>
            <Label className="mb-2 block">{t("web.wallet_topup_currency_label")}</Label>
            <div className="grid grid-cols-2 gap-2">
              {(["IDR", "USDT"] as const).map((cur) => (
                <Button
                  key={cur}
                  variant={cur === currency ? "primary" : "soft"}
                  onClick={() => setCurrency(cur)}
                >
                  {cur === "IDR" ? t("web.wallet_topup_currency_idr") : t("web.wallet_topup_currency_usdt")}
                </Button>
              ))}
            </div>
          </div>

          {/* Amount */}
          <FormField label={t("web.wallet_topup_amount_label")} htmlFor="topup_amount" hint={hint ?? undefined}>
            <Input
              id="topup_amount"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={currency === "IDR" ? "50000" : "10"}
            />
          </FormField>
        </Card>

        <Card>
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
                <p>
                  {belowEveryRailMinimum
                    ? t("web.wallet_topup_below_rail_minimum_all")
                    : t("web.wallet_topup_none_available")}
                </p>
              </div>
            )}
          </div>
        </Card>

        <Button
          variant="primary"
          fullWidth
          className={cn(submitBlocked && "opacity-50")}
          disabled={submitDisabled}
          onClick={() => submitMutation.mutate()}
        >
          {submitMutation.isPending && <Spinner />}
          {t("web.wallet_topup_submit")}
        </Button>
      </form>
    </div>
  );
}
