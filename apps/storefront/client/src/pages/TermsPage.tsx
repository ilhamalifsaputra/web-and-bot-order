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
      steps={[
        { id: "web.terms_h1", block: 1 },
        { id: "web.terms_h2", block: 2 },
        { id: "web.terms_h3", block: 3 },
        { id: "web.terms_h4", block: 4, callout: "warning" },
        { id: "web.terms_h5", block: 5 },
        { id: "web.terms_h6", block: 6 },
        { id: "web.terms_h7", block: 7 },
        { id: "web.terms_h8", block: 8 },
        { id: "web.terms_h9", block: 9 },
        { id: "web.terms_h10", block: 10 },
      ]}
    />
  );
}
