/**
 * The home page's flash-sale shelf (`#flash`), shown only while a sale is
 * live. The cards are the server's flash cards (one promo denomination each,
 * linking with `?d=` to preselect it, with their own countdown); "See all"
 * opens /flash, which renders the same cards.
 */
import { ChevronRight, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { t } from "../../lib/i18n";
import ProductCard, { type ProductCardData } from "../shop/ProductCard";
import { SECTION_TITLE_CLASS, gridClass, scrollMarginClass } from "./homeLayout";

export interface HomeFlashSectionProps {
  products: readonly ProductCardData[];
  hasGroupNav: boolean;
  fx: string | null | undefined;
  lowThreshold: number;
}

export default function HomeFlashSection({ products, hasGroupNav, fx, lowThreshold }: HomeFlashSectionProps) {
  return (
    <section id="flash" className={`mt-12 ${scrollMarginClass(hasGroupNav)}`}>
      <div className="flex items-end justify-between gap-4">
        <h2 className={`flex items-center gap-2 ${SECTION_TITLE_CLASS}`}>
          <Zap className="h-6 w-6 shrink-0 text-amberx" aria-hidden="true" />
          {t("web.home_flash_title")}
        </h2>
        <Link to="/flash" className="group inline-flex shrink-0 items-center gap-1 text-sm font-medium text-pine hover:text-pine-dark">
          {t("web.home_see_all")}
          <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </Link>
      </div>
      <div className={`mt-5 ${gridClass(products.length)}`}>
        {products.map((p) => (
          <div key={p.slug} className="h-full">
            <ProductCard p={p} fx={fx} lowThreshold={lowThreshold} />
          </div>
        ))}
      </div>
    </section>
  );
}
