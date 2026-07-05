/**
 * TSX port of apps/storefront/views/referral.njk. The copy button reads the
 * link straight from the fetched data (the NJK read it off the readonly
 * input's DOM value — same string, since the field is never edited).
 * Markup/classes copied verbatim apart from the mechanical Tailwind v3→v4
 * renames (docs/REACT_STOREFRONT_MIGRATION.md): `!text-2xl` → `text-2xl!`,
 * `!text-xs` → `text-xs!`.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { apiGet } from "../api/client";
import type { ReferralData } from "../api/types";
import { t } from "../lib/i18n";

export default function ReferralPage() {
  const { data, error } = useQuery({
    queryKey: ["account-referral"],
    queryFn: () => apiGet<ReferralData>("/api/v1/account/referral"),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent("/account/referral"));
    }
  }, [error]);

  if (!data) return null;

  const link = data.referral_link ?? "";

  return (
    <>
      <h1 className="page-title mb-2">{t("web.account_referral")}</h1>
      <p className="page-lead mb-6">{t("web.referral_hint")}</p>

      <div className="card card-pad max-w-lg">
        <div className="stat-label">{t("web.account_referral")}</div>
        <div className="stat-value font-mono text-2xl! select-all">{data.referral_code}</div>

        <div className="field-label mt-6">{t("web.referral_link")}</div>
        <div className="flex items-center gap-2">
          <input type="text" readOnly value={link} className="field font-mono text-xs!" />
          <button
            type="button"
            className="btn btn-soft btn-sm whitespace-nowrap"
            onClick={() => navigator.clipboard.writeText(link)}
          >
            <Copy className="w-3.5 h-3.5" /> {t("web.copy")}
          </button>
        </div>
      </div>
    </>
  );
}
