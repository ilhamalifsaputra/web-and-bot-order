/**
 * TSX port of apps/storefront/views/search.njk — query echoed in the title,
 * product grid, empty state. Markup/classes copied verbatim apart from the
 * mechanical Tailwind v3→v4 renames (docs/REACT_STOREFRONT_MIGRATION.md).
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { History, Search, SearchX } from "lucide-react";
import { apiGet } from "../api/client";
import { SORT_KEYS, type SearchPageData, type SortKey } from "../api/types";
import { useShopContext } from "../components/Layout";
import { t } from "../lib/i18n";
import EmptyState from "../components/shop/EmptyState";
import ProductCard from "../components/shop/ProductCard";
import ProductCardSkeleton from "../components/shop/ProductCardSkeleton";
import Skeleton from "../components/shop/Skeleton";
import SortSelect from "../components/shop/SortSelect";

const SKELETON_CARDS = Array.from({ length: 8 }, (_, i) => i);

/** Client-only, never sent anywhere: the last few terms this browser searched
 *  for, so a shopper who mistyped can re-run a query with one tap instead of
 *  retyping it on a phone keyboard. */
const RECENT_KEY = "storefront.recent_searches";
/** Short enough to stay a shortcut rather than a second navigation problem. */
const RECENT_LIMIT = 5;

/**
 * Every localStorage touch is wrapped: Safari in private mode throws on write
 * (and can throw on read), and a value left behind by an older build may not
 * parse. A search page that cannot remember history is a mild loss; one that
 * crashes because the browser refused to store a convenience is not
 * acceptable, so both failures degrade to "no history".
 */
function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "").slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function persistRecent(terms: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(terms));
  } catch {
    // The list still lives in React state for this visit; losing it on reload
    // is the correct trade against failing the search the shopper asked for.
  }
}

function forgetRecent(): void {
  try {
    window.localStorage.removeItem(RECENT_KEY);
  } catch {
    // Same reasoning as persistRecent — nothing here is worth an error screen.
  }
}

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const rawSort = params.get("sort");
  const sort: SortKey = SORT_KEYS.includes(rawSort as SortKey) ? (rawSort as SortKey) : "default";
  const { data: ctx } = useShopContext();
  const { data } = useQuery({
    queryKey: ["search", q, sort],
    queryFn: () => apiGet<SearchPageData>(`/api/v1/pages/search?q=${encodeURIComponent(q)}&sort=${sort}`),
  });

  const [recent, setRecent] = useState<string[]>(readRecent);

  // Record the term, keyed on `q` alone so re-sorting the same results doesn't
  // churn the list. Matching case-insensitively keeps "Netflix" and "netflix"
  // from occupying two of the five slots.
  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    setRecent((prev) => {
      const next = [term, ...prev.filter((v) => v.toLowerCase() !== term.toLowerCase())].slice(0, RECENT_LIMIT);
      persistRecent(next);
      return next;
    });
  }, [q]);

  const clearRecent = useCallback(() => {
    setRecent([]);
    forgetRecent();
  }, []);

  // STO-006/performance.md: same rationale as CategoryPage/AccountPage — show
  // a skeleton shaped like the loaded layout instead of a blank page.
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <div className="mb-6">
          <Skeleton className="h-8 w-full max-w-56" />
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
  const fx = ctx?.fx;
  // Suggesting the query that just failed would be a loop, so it never appears
  // among its own alternatives.
  const suggestions = recent.filter((term) => term.toLowerCase() !== q.trim().toLowerCase());

  return (
    <>
      <div className="mb-6">
        {/* `.page-title` is a flex row, so the echoed query needs its own
            shrinkable box — an unbroken 40-character term would otherwise push
            the heading past the viewport on a 320px screen. */}
        <h1 className="page-title">
          <span className="min-w-0 break-words">{t("web.search_results", { q: data.q })}</span>
          {/* How many results came back — the heading echoed the query but
              never said this. The badge shows the bare number, because
              "Results for X" already supplies the noun and repeating it reads
              as clutter; the aria-label carries the localized phrase so a
              screen reader hears what the digit means. */}
          {products.length > 0 && (
            <span
              className="chip shrink-0 bg-sand text-ink-soft"
              aria-label={t("web.search_result_count", { count: products.length })}
            >
              {products.length}
            </span>
          )}
        </h1>
      </div>

      {products.length > 0 ? (
        <>
          {/* STO-007: cheapest/newest/rating sort — only worth showing once
              there's more than one result to reorder. */}
          {products.length > 1 && (
            <div className="flex justify-end mb-4">
              <SortSelect
                value={sort}
                onChange={(next) =>
                  setParams(next === "default" ? { q } : { q, sort: next })
                }
              />
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {products.map((p) => (
              <ProductCard key={p.slug} p={p} fx={fx} lowThreshold={low_threshold} />
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Above the empty state rather than below it: with nothing to show,
              re-running an earlier query is the shortest way out of the dead
              end, and on a phone the empty-state card alone already fills the
              first screen. */}
          {suggestions.length > 0 && (
            <section aria-labelledby="recent-searches-title" className="card card-pad mb-4">
              <div className="flex items-center justify-between gap-3">
                <h2
                  id="recent-searches-title"
                  className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-ink"
                >
                  <History className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden="true" />
                  {t("web.recent_searches")}
                </h2>
                <button type="button" onClick={clearRecent} className="btn btn-ghost btn-sm shrink-0">
                  {t("web.clear_recent")}
                </button>
              </div>
              {/* Links, not buttons: each one is a real navigation to a search
                  URL, so it stays keyboard-reachable and shareable. */}
              <ul className="mt-3 flex flex-wrap gap-2">
                {suggestions.map((term) => (
                  <li key={term} className="max-w-full">
                    <Link
                      to={`/search?q=${encodeURIComponent(term)}`}
                      className="btn btn-soft btn-sm max-w-full"
                    >
                      <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 truncate">{term}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <EmptyState
            icon={SearchX}
            title={t("web.search_empty")}
            description={t("web.search_empty_desc")}
            action={{ label: t("web.nav_products"), to: "/products" }}
            secondaryAction={{ label: t("web.back_home"), to: "/" }}
          />
        </>
      )}
    </>
  );
}
