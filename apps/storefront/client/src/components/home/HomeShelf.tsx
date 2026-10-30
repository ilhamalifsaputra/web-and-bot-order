/**
 * One home (sub-)section's grid: the first page of cards from the home
 * payload, "Show more" (10 more from the group endpoint, at most twice), then
 * "See all" when products still remain.
 *
 * The extra pages live in a TanStack infinite query keyed by group and
 * section only. It never fetches on its own (`enabled: false`; only the button
 * pages it), so returning to the home page within the cache window renders
 * the expanded grid at full height straight from the cache and the browser's
 * own scroll restoration lands where the visitor left.
 *
 * The ranking version is deliberately NOT in the key: the server bumps it
 * every few minutes and the home query refetches on mount and focus, so a
 * keyed version would collapse the expanded section on Back. Instead the
 * version travels in the page param: the first expansion pins the version the
 * home payload was ranked with, and every later page reuses the version the
 * first expansion actually got, so one expansion run pages one order. Cards
 * the refreshed first page already shows are dropped (appendUnique).
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { apiGet } from "../../api/client";
import type { GroupPageData, HomeGroup, HomeSection } from "../../api/types";
import { appendUnique, groupPageUrl } from "../../lib/groupPageUrl";
import { t } from "../../lib/i18n";
import ProductCard from "../shop/ProductCard";
import Button from "../ui/Button";
import { gridClass } from "./homeLayout";

const PAGE_SIZE = 10;
const MAX_EXPANSIONS = 2;

/** Where "See all" goes: the category page for a category sub-section or a
 * group that has only one category, otherwise the group page. */
function seeAllHref(group: HomeGroup, section: HomeSection): string {
  if (section.kind === "category" && section.category_slugs[0]) return `/c/${section.category_slugs[0]}`;
  if (group.single_category_slug) return `/c/${group.single_category_slug}`;
  return `/g/${group.slug}`;
}

export interface HomeShelfProps {
  group: HomeGroup;
  section: HomeSection;
  rankingVersion: number;
  fx: string | null | undefined;
  lowThreshold: number;
}

export default function HomeShelf({ group, section, rankingVersion, fx, lowThreshold }: HomeShelfProps) {
  const { data, fetchNextPage, isFetching, isError } = useInfiniteQuery({
    queryKey: ["group-section", group.slug, section.key],
    queryFn: ({ pageParam }) =>
      apiGet<GroupPageData>(
        groupPageUrl(group.slug, { categories: section.category_slugs, offset: pageParam.offset, limit: PAGE_SIZE, v: pageParam.v }),
      ),
    // The server may trim sold-out cards off the first page, so paging goes
    // on from the number of cards actually shown.
    initialPageParam: { offset: section.products.length, v: rankingVersion },
    getNextPageParam: (last, all) =>
      last.next_offset === null ? undefined : { offset: last.next_offset, v: all[0]!.ranking_version },
    enabled: false,
  });

  const pages = data?.pages ?? [];
  const products = pages.reduce((shown, page) => appendUnique(shown, page.products), section.products);
  const lastPage = pages.at(-1);
  const moreRemain = lastPage ? lastPage.next_offset !== null : section.products.length < section.total;
  const canExpand = moreRemain && pages.length < MAX_EXPANSIONS;

  return (
    <>
      {section.all_sold_out && <p className="mb-3 text-sm text-ink-soft">{t("web.home_all_sold_out")}</p>}
      <div className={gridClass(products.length)}>
        {products.map((p) => (
          <div key={p.slug} className="h-full">
            <ProductCard p={p} fx={fx} lowThreshold={lowThreshold} />
          </div>
        ))}
      </div>
      {moreRemain && (
        <div className="mt-6 flex flex-col items-center gap-2">
          {canExpand ? (
            <Button variant="soft" onClick={() => void fetchNextPage()} disabled={isFetching} aria-busy={isFetching}>
              {t("web.home_show_more")}
            </Button>
          ) : (
            <Link to={seeAllHref(group, section)} className="btn btn-soft">
              {t("web.home_see_all")}
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          )}
          {isError && (
            <p role="alert" className="text-sm text-rust-dark">
              {t("web.error_message")}
            </p>
          )}
        </div>
      )}
    </>
  );
}
