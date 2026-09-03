import StaticPage from "../components/shop/StaticPage";
import { useShopContext } from "../components/Layout";

export default function TermsPage() {
  const { data: ctx } = useShopContext();
  return (
    <StaticPage
      prefix="terms"
      blocks={5}
      args={{ shop: ctx?.shop_name ?? "" }}
      // Block 3 (no chargebacks / abuse) reads as the critical warning of the
      // policy, so its paragraph is wrapped in a warning Callout — unchanged
      // from the timeline layout, just no longer inside a numbered badge.
      steps={[{}, {}, { callout: "warning" }, {}, {}]}
    />
  );
}
