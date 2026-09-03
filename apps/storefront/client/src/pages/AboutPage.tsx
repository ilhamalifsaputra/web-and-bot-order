import StaticPage from "../components/shop/StaticPage";
import { useShopContext } from "../components/Layout";

// Four informational blocks (what we sell / how orders process / hours / how
// to reach us), not an ordered sequence — so this gets the §7 plain-prose
// treatment, same as the legal pages, rather than a numbered StepTimeline.
export default function AboutPage() {
  const { data: ctx } = useShopContext();
  return <StaticPage prefix="about" blocks={4} args={{ shop: ctx?.shop_name ?? "" }} />;
}
