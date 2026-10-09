import StaticPage from "../components/shop/StaticPage";
import { useShopContext } from "../components/Layout";
import { companyName } from "../lib/company";

// Five informational blocks (what we sell / how orders process / support /
// who operates the shop / how to reach us), not an ordered sequence — so this
// gets the §7 plain-prose treatment, same as the legal pages, rather than a
// numbered StepTimeline.
export default function AboutPage() {
  const { data: ctx } = useShopContext();
  return (
    <StaticPage
      prefix="about"
      blocks={5}
      args={{ shop: ctx?.shop_name ?? "", company: companyName(ctx) }}
    />
  );
}
