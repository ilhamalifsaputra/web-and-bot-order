import { ChartBar, Database, KeyRound, Settings2, Share2, Trash2 } from "lucide-react";
import StaticPage from "../components/shop/StaticPage";
import Callout from "../components/shop/Callout";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";

export default function PrivacyPage() {
  const { data: ctx } = useShopContext();
  return (
    <StaticPage
      prefix="privacy"
      blocks={5}
      args={{ shop: ctx?.shop_name ?? "" }}
      steps={[
        { icon: Database },
        { icon: Settings2 },
        { icon: Share2 },
        { icon: KeyRound, callout: "warning" },
        { icon: Trash2 },
      ]}
    >
      {/* Only shown when this shop actually has `web_analytics_id` set —
          a privacy policy that claims tracking a shop doesn't do is as wrong
          as one that hides tracking it does. */}
      {ctx?.analytics_enabled && (
        <div className="rounded-2xl border border-line bg-card p-5 shadow-xs">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-pine-tint text-pine">
            <ChartBar className="h-5 w-5" />
          </span>
          <h2 className="mt-3 font-display text-xl font-bold text-ink">{t("web.privacy_analytics_h")}</h2>
          <div className="mt-2">
            <Callout variant="info">{t("web.privacy_analytics_p")}</Callout>
          </div>
        </div>
      )}
    </StaticPage>
  );
}
