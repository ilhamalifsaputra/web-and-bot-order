/**
 * "Browse products" — the whole catalog on one grid, reached from the nav
 * drawer. Same shelf layout as CategoryPage minus the category pills; the
 * server hands back cards shaped by the same shapeProducts() every other grid
 * uses, so prices here can't drift from the ones checkout charges.
 */
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PackageSearch } from "lucide-react";
import { motion } from "framer-motion";
import { apiGet } from "../api/client";
import { SORT_KEYS, type ShelfPageData, type SortKey } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import { staggerContainer, staggerItem } from "../lib/motion";
import ProductCard from "../components/shop/ProductCard";
import ProductCardSkeleton from "../components/shop/ProductCardSkeleton";
import Skeleton from "../components/shop/Skeleton";
import SortSelect from "../components/shop/SortSelect";
import EmptyState from "../components/shop/EmptyState";

const SKELETON_CARDS = Array.from({ length: 8 }, (_, i) => i);

export default function ProductsPage() {
  const { data: ctx } = useShopContext();
  const [params, setParams] = useSearchParams();
  const rawSort = params.get("sort");
  const sort: SortKey = SORT_KEYS.includes(rawSort as SortKey) ? (rawSort as SortKey) : "default";
  const { data } = useQuery({
    queryKey: ["products", sort],
    queryFn: () => apiGet<ShelfPageData>(`/api/v1/pages/products?sort=${sort}`),
  });

  // Same reasoning as CategoryPage: a skeleton shaped like the loaded layout
  // instead of a blank page on a slow connection.
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <div className="mb-6">
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {SKELETON_CARDS.map((i) => (
            <ProductCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  const { products, low_threshold } = data;

  return (
    <>
      <div className="mb-6">
        <h1 className="page-title">{t("web.products_title")}</h1>
      </div>

      {products.length > 0 ? (
        <>
          {products.length > 1 && (
            <div className="flex justify-end mb-4">
              <SortSelect value={sort} onChange={(next) => setParams(next === "default" ? {} : { sort: next })} />
            </div>
          )}
          {/* STO-018: a lone product clamps to one column instead of leaving
              two-thirds of the row empty. */}
          <motion.div
            className={`grid gap-4 ${products.length === 1 ? "max-w-xs" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"}`}
            variants={staggerContainer}
            initial="initial"
            animate="animate"
          >
            {products.map((p) => (
              <motion.div key={p.slug} variants={staggerItem} className="h-full">
                <ProductCard p={p} fx={ctx?.fx} lowThreshold={low_threshold} />
              </motion.div>
            ))}
          </motion.div>
        </>
      ) : (
        <EmptyState
          icon={PackageSearch}
          title={t("web.catalog_empty")}
          description={t("web.catalog_empty_desc")}
          action={{ label: t("web.back_home"), to: "/" }}
        />
      )}
    </>
  );
}
