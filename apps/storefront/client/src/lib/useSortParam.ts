/**
 * The grid pages' `?sort=` wiring (Category, Group, Products, Flash) in one
 * place. `bestseller` is the default and never appears in the URL; changing
 * the sort keeps every other query param (a group page's `?category=`).
 *
 * `allowCheapest` is undefined while the page does not know yet whether this
 * grid offers "cheapest" (it comes with the payload). Until then the value is
 * read as typed so the request carries it and the server decides. Once it is
 * known, a `?sort=` the page does not honour (cheapest on Game Top Up, a legacy
 * `default`/`rating`, garbage) is replaced in the URL — replace, not push, so
 * Back does not return to the URL that showed something else.
 */
import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { parseSortKey, type SortKey } from "../api/types";

export function useSortParam({ allowCheapest }: { allowCheapest: boolean | undefined }): [SortKey, (next: SortKey) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("sort");
  const sort = parseSortKey(raw, { allowCheapest: allowCheapest ?? true });
  const canonical = sort === "bestseller" ? null : sort;
  const needsReplace = allowCheapest !== undefined && raw !== canonical;

  useEffect(() => {
    if (!needsReplace) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (canonical === null) next.delete("sort");
        else next.set("sort", canonical);
        return next;
      },
      { replace: true },
    );
  }, [needsReplace, canonical, setParams]);

  const setSort = useCallback(
    (next: SortKey) => {
      setParams((prev) => {
        const updated = new URLSearchParams(prev);
        if (next === "bestseller") updated.delete("sort");
        else updated.set("sort", next);
        return updated;
      });
    },
    [setParams],
  );

  return [sort, setSort];
}
