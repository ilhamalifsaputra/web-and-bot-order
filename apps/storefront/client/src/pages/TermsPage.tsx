import StaticPage from "../components/shop/StaticPage";
import { useShopContext } from "../components/Layout";
import { companyName } from "../lib/company";

export default function TermsPage() {
  const { data: ctx } = useShopContext();
  return (
    <StaticPage
      prefix="terms"
      blocks={10}
      args={{ shop: ctx?.shop_name ?? "", company: companyName(ctx) }}
      // Block 4 (what voids the warranty) reads as the critical warning of the
      // policy, so its paragraph is wrapped in a warning Callout.
      steps={[{}, {}, {}, { callout: "warning" }, {}, {}, {}, {}, {}, {}]}
    />
  );
}
