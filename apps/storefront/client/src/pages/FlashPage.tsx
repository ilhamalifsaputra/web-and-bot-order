/**
 * "Flash sale" — the products whose sale window is open right now. The nav
 * drawer only links here when `flash_active` says a sale is running, but the
 * URL is reachable directly (and a sale can end mid-visit), so the empty state
 * is a normal outcome rather than an error.
 *
 * Which products qualify is decided server-side by listFlashSaleProducts()
 * (packages/db/src/crud/catalog.ts) via activeFlashPercent — the same rule
 * checkout prices against. ProductCard already renders the sale badge and the
 * struck-through base price from each card's `flash` field.
 */
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
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

const SKELETON_CARDS = Array.from({ length: 4 }, (_, i) => i);

export default function FlashPage() {
  const { data: ctx } = useShopContext();
  const [params, setParams] = useSearchParams();
  const rawSort = params.get("sort");
  const sort: SortKey = SORT_KEYS.includes(rawSort as SortKey) ? (rawSort as SortKey) : "default";
  const { data } = useQuery({
    queryKey: ["flash", sort],
    queryFn: () => apiGet<ShelfPageData>(`/api/v1/pages/flash?sort=${sort}`),
  });

  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <div className="mb-6">
          <Skeleton className="h-8 w-40" />
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
        <h1 className="page-title flex items-center gap-2">
          <Zap className="w-5 h-5 shrink-0 text-amberx" />
          {t("web.flash_title")}
        </h1>
      </div>

      {products.length > 0 ? (
        <>
          {products.length > 1 && (
            <div className="flex justify-end mb-4">
              <SortSelect value={sort} onChange={(next) => setParams(next === "default" ? {} : { sort: next })} />
            </div>
          )}
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
          icon={Zap}
          title={t("web.flash_empty")}
          description={t("web.flash_empty_desc")}
          action={{ label: t("web.nav_products"), to: "/products" }}
        />
      )}
    </>
  );
}
