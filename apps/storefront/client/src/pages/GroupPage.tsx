/**
 * /g/:slug — every product of one product group (Premium Apps, Top Up Games,
 * …): a segmented category filter (`?category=`), the sort (`?sort=`), the
 * grid, and "Load more". The group decides which sorts exist (no "cheapest" on
 * Game Top Up), so the page reads `allow_cheapest` off the payload rather than
 * guessing from the slug.
 *
 * Server: groupPageData() in apps/storefront/src/pageData.ts. Later pages pass
 * the first page's `ranking_version` so the order holds while paging, and any
 * product a moved ranking repeats is dropped.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { PackageSearch, Store } from "lucide-react";
import { useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { parseSortKey, type GroupPageData } from "../api/types";
import { useShopContext } from "../components/Layout";
import Breadcrumb from "../components/shop/Breadcrumb";
import EmptyState from "../components/shop/EmptyState";
import ErrorState from "../components/shop/ErrorState";
import ProductCard, { type ProductCardData } from "../components/shop/ProductCard";
import ProductCardSkeleton from "../components/shop/ProductCardSkeleton";
import SegmentedFilter from "../components/shop/SegmentedFilter";
import Skeleton from "../components/shop/Skeleton";
import SortSelect from "../components/shop/SortSelect";
import Button from "../components/ui/Button";
import { appendUnique, groupPageUrl } from "../lib/groupPageUrl";
import { t } from "../lib/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useSortParam } from "../lib/useSortParam";
import ErrorPage from "./ErrorPage";

const PAGE_SIZE = 20;
const SKELETON_CARDS = Array.from({ length: 10 }, (_, i) => i);
const ALL = "";

export default function GroupPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: ctx } = useShopContext();
  const [params, setParams] = useSearchParams();
  const category = params.get("category") ?? ALL;
  // Sent as typed; the server falls back to bestseller where a sort is not
  // offered, and useSortParam then corrects the URL.
  const requestedSort = parseSortKey(params.get("sort"), { allowCheapest: true });

  const { data, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["group", slug, category, requestedSort],
    queryFn: ({ pageParam }) =>
      apiGet<GroupPageData>(
        groupPageUrl(slug, {
          categories: category ? [category] : [],
          sort: requestedSort,
          offset: pageParam.offset,
          limit: PAGE_SIZE,
          v: pageParam.v,
        }),
      ),
    initialPageParam: { offset: 0, v: null as number | null },
    getNextPageParam: (last, pages) =>
      last.next_offset === null ? undefined : { offset: last.next_offset, v: pages[0]!.ranking_version },
    retry: false,
    // Filter/sort changes within this group keep the grid up while the next
    // one loads; another group starts from its own skeleton.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === slug ? previous : undefined),
  });
  const first = data?.pages[0];
  const [sort, setSort] = useSortParam({ allowCheapest: first?.group.allow_cheapest });

  useDocumentTitle(first && ctx?.shop_name ? `${t(first.group.label_key)} — ${ctx.shop_name}` : undefined);

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    if (!data) return <ErrorState onRetry={() => void refetch()} />;
  }
  if (!data || !first) return <GroupPageSkeleton />;

  const { group, categories, low_threshold, unavailable } = first;
  const label = t(group.label_key);
  const products = data.pages.reduce<ProductCardData[]>((shown, page) => appendUnique(shown, page.products), []);
  const activeCategory = categories.some((c) => c.slug === category) ? category : ALL;

  const selectCategory = (next: string) =>
    setParams((prev) => {
      const updated = new URLSearchParams(prev);
      if (next === ALL) updated.delete("category");
      else updated.set("category", next);
      return updated;
    });

  return (
    <>
      <Breadcrumb items={[{ label: t("web.nav_home"), href: "/" }, { label }]} />
      <div className="mb-6">
        <h1 className="page-title">{`${group.emoji} ${label}`}</h1>
      </div>

      {unavailable ? (
        <EmptyState
          icon={Store}
          title={t("web.group_unavailable")}
          description={t("web.group_unavailable_desc")}
          action={{ label: t("web.back_home"), to: "/" }}
        />
      ) : (
        <>
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {categories.length > 1 ? (
              <SegmentedFilter
                label={t("web.categories")}
                value={activeCategory}
                onChange={selectCategory}
                options={[
                  { value: ALL, label: t("web.group_all_categories") },
                  ...categories.map((c) => ({ value: c.slug, label: c.emoji ? `${c.emoji} ${c.name}` : c.name })),
                ]}
              />
            ) : (
              <span />
            )}
            {first.total > 1 && <SortSelect value={sort} allowCheapest={group.allow_cheapest} onChange={setSort} />}
          </div>

          {products.length > 0 ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {products.map((p) => (
                <div key={p.slug} className="h-full">
                  <ProductCard p={p} fx={ctx?.fx} lowThreshold={low_threshold} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={PackageSearch}
              title={t("web.catalog_empty")}
              description={t("web.catalog_empty_desc")}
              action={{ label: t("web.back_home"), to: "/" }}
            />
          )}

          {hasNextPage && (
            <div className="mt-8 flex justify-center">
              <Button
                variant="soft"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                aria-busy={isFetchingNextPage}
              >
                {t("web.group_load_more")}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function GroupPageSkeleton() {
  return (
    <div aria-busy="true" aria-label={t("web.loading")}>
      <Skeleton className="mb-3 h-4 w-40" />
      <div className="mb-6">
        <Skeleton className="h-8 w-48" />
      </div>
      <Skeleton className="mb-6 h-12 w-72 max-w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {SKELETON_CARDS.map((i) => (
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
