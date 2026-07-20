import StaticPage from "../components/shop/StaticPage";
import { useShopContext } from "../components/Layout";

export default function AboutPage() {
  const { data: ctx } = useShopContext();
  return <StaticPage prefix="about" blocks={4} args={{ shop: ctx?.shop_name ?? "" }} />;
}
