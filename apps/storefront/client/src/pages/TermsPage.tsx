import StaticPage from "../components/shop/StaticPage";
import { useShopContext } from "../components/Layout";

export default function TermsPage() {
  const { data: ctx } = useShopContext();
  return <StaticPage prefix="terms" blocks={5} args={{ shop: ctx?.shop_name ?? "" }} />;
}
