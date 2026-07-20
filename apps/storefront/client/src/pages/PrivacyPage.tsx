import StaticPage from "../components/shop/StaticPage";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";

export default function PrivacyPage() {
  const { data: ctx } = useShopContext();
  return (
    <StaticPage prefix="privacy" blocks={5} args={{ shop: ctx?.shop_name ?? "" }}>
      {/* Only shown when this shop actually has `web_analytics_id` set —
          a privacy policy that claims tracking a shop doesn't do is as wrong
          as one that hides tracking it does. */}
      {ctx?.analytics_enabled && (
        <section>
          <h2 className="font-display text-xl font-bold text-ink">{t("web.privacy_analytics_h")}</h2>
          <p className="mt-2 leading-relaxed text-ink-soft">{t("web.privacy_analytics_p")}</p>
        </section>
      )}
    </StaticPage>
  );
}
