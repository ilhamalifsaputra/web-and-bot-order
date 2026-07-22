import { Coins, CreditCard, ListChecks, PackageCheck, QrCode, ShoppingCart } from "lucide-react";
import StaticPage from "../components/shop/StaticPage";
import Callout from "../components/shop/Callout";
import { t } from "../lib/i18n";

// Blocks 3 (QRIS/e-wallet) and 4 (USDT) collapse into one visual step —
// two side-by-side payment cards — instead of two sequential timeline
// entries, per the redesign brief. Both bodies already read as the critical
// warning for their method (exact amount / correct network), so each is
// wrapped whole in a warning Callout rather than split into new sentences.
const paymentStep = (
  <div className="grid gap-4 sm:grid-cols-2">
    <div className="rounded-2xl border border-line bg-card p-5 shadow-xs">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-pine-tint text-pine">
        <QrCode className="h-5 w-5" />
      </span>
      <h4 className="mt-3 font-semibold text-ink">{t("web.hto_h3")}</h4>
      <div className="mt-2">
        <Callout variant="warning">{t("web.hto_p3")}</Callout>
      </div>
    </div>
    <div className="rounded-2xl border border-line bg-card p-5 shadow-xs">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-amberx-tint text-amberx">
        <Coins className="h-5 w-5" />
      </span>
      <h4 className="mt-3 font-semibold text-ink">{t("web.hto_h4")}</h4>
      <div className="mt-2">
        <Callout variant="warning">{t("web.hto_p4")}</Callout>
      </div>
    </div>
  </div>
);

export default function HowToOrderPage() {
  return (
    <StaticPage
      prefix="hto"
      blocks={5}
      steps={[
        { icon: ListChecks },
        { icon: ShoppingCart },
        { icon: CreditCard, render: paymentStep },
        { icon: PackageCheck, block: 5 },
      ]}
    />
  );
}
