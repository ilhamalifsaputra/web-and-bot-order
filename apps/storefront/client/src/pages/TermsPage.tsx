import { FileCheck, Scale, ShieldOff, Tag, UserCog } from "lucide-react";
import StaticPage from "../components/shop/StaticPage";
import { useShopContext } from "../components/Layout";

export default function TermsPage() {
  const { data: ctx } = useShopContext();
  return (
    <StaticPage
      prefix="terms"
      blocks={5}
      args={{ shop: ctx?.shop_name ?? "" }}
      steps={[
        { icon: UserCog },
        { icon: FileCheck },
        { icon: ShieldOff, callout: "warning" },
        { icon: Tag },
        { icon: Scale },
      ]}
    />
  );
}
