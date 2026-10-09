import StaticPage from "../components/shop/StaticPage";
import Callout from "../components/shop/Callout";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { companyName } from "../lib/company";

export default function PrivacyPage() {
  const { data: ctx } = useShopContext();
  return (
    <StaticPage
      prefix="privacy"
      blocks={7}
      args={{ shop: ctx?.shop_name ?? "", company: companyName(ctx) }}
      // Block 6 (your order credentials) stays a warning Callout — same
      // wrapper as the timeline layout, just no numbered badge.
      steps={[{}, {}, {}, {}, {}, { callout: "warning" }, {}]}
    >
      {/* Only shown when this shop actually has `web_analytics_id` set —
          a privacy policy that claims tracking a shop doesn't do is as wrong
          as one that hides tracking it does. Rendered as a plain prose block
          (h2 + Callout), matching the crawler shell in spaShell.ts. */}
      {ctx?.analytics_enabled && (
        <section>
          <h2 className="font-display text-xl font-semibold text-ink sm:text-2xl">
            {t("web.privacy_analytics_h")}
          </h2>
          <div className="mt-3">
            <Callout variant="info">{t("web.privacy_analytics_p")}</Callout>
          </div>
        </section>
      )}
    </StaticPage>
  );
}
