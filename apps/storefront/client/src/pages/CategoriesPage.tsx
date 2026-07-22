/**
 * The category index — the drawer's "Categories" entry lands here rather than
 * expanding a category tree inside the panel. Tiles reuse the homepage's
 * category-card treatment so the two surfaces read as the same shop.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Box, ChevronRight, PackageSearch } from "lucide-react";
import { apiGet } from "../api/client";
import type { CategoriesPageData } from "../api/types";
import { t } from "../lib/i18n";
import { staggerContainer, staggerItem } from "../lib/motion";
import Skeleton from "../components/shop/Skeleton";
import EmptyState from "../components/shop/EmptyState";

const SKELETON_TILES = Array.from({ length: 6 }, (_, i) => i);

export default function CategoriesPage() {
  const { data } = useQuery({
    queryKey: ["categories"],
    queryFn: () => apiGet<CategoriesPageData>("/api/v1/pages/categories"),
  });

  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <div className="mb-6">
          <Skeleton className="h-8 w-40" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SKELETON_TILES.map((i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const { categories } = data;

  return (
    <>
      <div className="mb-6">
        <h1 className="page-title">{t("web.categories_page_title")}</h1>
      </div>

      {categories.length > 0 ? (
        <motion.div
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          variants={staggerContainer}
          initial="initial"
          animate="animate"
        >
          {categories.map((c) => (
            <motion.div key={c.slug} variants={staggerItem}>
              <Link
                to={`/c/${c.slug}`}
                className="group flex h-full items-center gap-4 rounded-2xl border border-line bg-card p-5 shadow-xs transition hover:border-pine-tint hover:shadow"
              >
                <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-pine-tint text-2xl transition-transform group-hover:scale-105">
                  {c.emoji ? c.emoji : <Box className="h-6 w-6 text-pine" />}
                </span>
                <div className="min-w-0">
                  <h2 className="truncate font-semibold text-ink">{c.name}</h2>
                  {c.description && <p className="truncate text-sm text-ink-soft">{c.description}</p>}
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-pine">
                    {t("web.view_products")}
                    <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </Link>
            </motion.div>
          ))}
        </motion.div>
      ) : (
        <EmptyState
          icon={PackageSearch}
          title={t("web.categories_empty")}
          description={t("web.catalog_empty_desc")}
          action={{ label: t("web.back_home"), to: "/" }}
        />
      )}
    </>
  );
}
