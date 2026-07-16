/**
 * TSX port of apps/storefront/views/account.njk. Markup/classes copied
 * verbatim apart from the mechanical Tailwind v3→v4 renames
 * (docs/REACT_STOREFRONT_MIGRATION.md): `!text-2xl` → `text-2xl!`.
 * account.njk's `<form action="/logout">` becomes a POST to
 * /api/v1/auth/logout followed by a full reload to "/" (clears the CSRF
 * meta + any client cache), same pattern as every other auth mutation.
 */
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, Gift, LifeBuoy, LogOut, Settings, ShoppingBag, Star } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { AccountData } from "../api/types";
import { t } from "../lib/i18n";
import { formatIdr, money4 } from "../lib/format";
import Skeleton from "../components/shop/Skeleton";

/** base.njk's `data-submit-once` double-submit guard, ported: prepended to a
 * submitting button while its mutation is pending (in addition to disabling
 * the button itself). */
function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
  );
}

const MENU = [
  { href: "/account/orders", icon: ShoppingBag, labelKey: "web.account_orders" },
  { href: "/account/referral", icon: Gift, labelKey: "web.account_referral" },
  { href: "/account/reviews", icon: Star, labelKey: "web.account_reviews" },
  { href: "/account/support", icon: LifeBuoy, labelKey: "web.account_support" },
  { href: "/account/settings", icon: Settings, labelKey: "web.account_settings" },
] as const;

export default function AccountPage() {
  const { data, error } = useQuery({
    queryKey: ["account"],
    queryFn: () => apiGet<AccountData>("/api/v1/account"),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent("/account"));
    }
  }, [error]);

  const logoutMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>("/api/v1/auth/logout", {}),
    // Full reload (not navigate()) — clears the CSRF meta along with the session.
    onSuccess: () => window.location.assign("/"),
  });

  // STO-006/performance.md: rendering nothing while the initial query is
  // pending reads as a blank/broken page on a slow connection — show a
  // skeleton shaped like the loaded layout instead.
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-2">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-4 mb-6">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="card card-pad space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-6 w-32" />
            </div>
          ))}
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="card card-pad">
              <Skeleton className="h-5 w-28" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">{t("web.account_title")}</h1>
          <p className="page-lead">
            {t("web.signed_in_as")} <span className="font-semibold text-ink">{data.name}</span>
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={logoutMutation.isPending}
          onClick={() => logoutMutation.mutate()}
        >
          {logoutMutation.isPending && <Spinner />}
          <LogOut className="w-4 h-4" /> {t("web.nav_logout")}
        </button>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mb-6">
        <div className="card card-pad">
          <div className="stat-label">{t("web.account_orders")}</div>
          <div className="stat-value">{data.order_count}</div>
        </div>
        <div className="card card-pad">
          <div className="stat-label">{t("web.account_referral")}</div>
          <div className="stat-value font-mono text-2xl!">{data.referral_code}</div>
        </div>
        <div className="card card-pad">
          <div className="stat-label">{t("web.account_credit_idr")}</div>
          <div className="stat-value tabular">{formatIdr(data.wallet_idr)}</div>
        </div>
        <div className="card card-pad">
          <div className="stat-label">{t("web.account_credit_usdt")}</div>
          <div className="stat-value tabular">{money4(data.wallet_usdt)} USDT</div>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {MENU.map((m) => (
          <Link
            key={m.href}
            to={m.href}
            className="card card-pad flex items-center gap-3 hover:shadow-lift transition-shadow"
          >
            <m.icon className="w-5 h-5 text-pine" />
            <span className="font-semibold text-sm">{t(m.labelKey)}</span>
            <ChevronRight className="w-4 h-4 text-ink-faint ml-auto" />
          </Link>
        ))}
      </div>
    </>
  );
}
