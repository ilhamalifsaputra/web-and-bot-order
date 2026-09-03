/**
 * TSX port of apps/storefront/views/referral.njk. The copy button reads the
 * link straight from the fetched data (the NJK read it off the readonly
 * input's DOM value — same string, since the field is never edited).
 *
 * Task 16 (design-system migration): panels are `<Card>`, the copy control is
 * `<Button>`, the link field is `<Input readOnly>`. The `text-2xl!` size cap on
 * the referral code and the `text-xs!` cap on the link input (both leftovers of
 * the Tailwind v3→v4 rename pass) are dropped so the code takes the full
 * `.stat-value` role and the field its `.field` default. The two summary tiles
 * keep their `text-xl!` cap, matching AccountPage's SummaryCard tiles.
 *
 * Task 14 (storefront UX eval, T9): added the earnings/referred-count stat
 * row. Previously this page only showed the code/link and told the visitor
 * to "check the bot" for their balance — a dead end for anyone who doesn't
 * use Telegram. Both figures come from GET /account/referral
 * (apps/storefront/src/routes/apiAccount.ts), which reads
 * packages/db/src/crud/referrals.ts's getReferralSummary — the exact same
 * Prisma aggregate the bot's viewReferral handler
 * (apps/order-bot/src/handlers/customer.ts) already uses, so the two
 * surfaces can never disagree about a buyer's commission. `earned_usdt`
 * arrives as a Decimal string and is formatted client-side with
 * formatNativeUsdt, per the money-formatting convention — never
 * pre-formatted on the server.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Gift, Users } from "lucide-react";
import { apiGet } from "../api/client";
import type { ReferralData } from "../api/types";
import { t } from "../lib/i18n";
import { formatNativeUsdt } from "../lib/format";
import Skeleton from "../components/shop/Skeleton";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";

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

  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <Skeleton className="mb-6 h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const link = data.referral_link ?? "";

  return (
    <>
      <h1 className="page-title mb-2">{t("web.account_referral")}</h1>
      <p className="page-lead mb-6">{t("web.referral_hint", { percent: data.commission_percent })}</p>

      {/* Earnings summary — the reason this page removed its old "check the
          bot for your balance" line. Two static cards (no link/button: there
          is no payout or transaction-history destination to send a tap to,
          same reasoning as the wallet balance cards on the account page). */}
      <div className="mb-6 grid max-w-lg grid-cols-2 gap-4">
        <Card className="flex flex-col items-start">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-pine-tint text-pine">
            <Gift className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="stat-label mt-3 block">{t("web.referral_earned")}</span>
          <span className="stat-value tabular text-xl! break-words">{formatNativeUsdt(data.earned_usdt)}</span>
          <span className="stat-sub block">{t("web.referral_earned_helper")}</span>
        </Card>
        <Card className="flex flex-col items-start">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sand text-ink-soft">
            <Users className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="stat-label mt-3 block">{t("web.referral_count")}</span>
          <span className="stat-value tabular text-xl! break-words">{data.referred_count}</span>
          <span className="stat-sub block">{t("web.referral_count_helper")}</span>
        </Card>
      </div>

      <Card className="max-w-lg">
        <div className="stat-label">{t("web.account_referral")}</div>
        <div className="stat-value font-mono select-all break-words">{data.referral_code}</div>

        <div className="field-label mt-6">{t("web.referral_link")}</div>
        <div className="flex items-center gap-2">
          <Input type="text" readOnly value={link} className="font-mono" />
          <Button
            variant="soft"
            size="sm"
            className="whitespace-nowrap"
            onClick={() => navigator.clipboard.writeText(link)}
          >
            <Copy className="w-3.5 h-3.5" /> {t("web.copy")}
          </Button>
        </div>
      </Card>
    </>
  );
}
