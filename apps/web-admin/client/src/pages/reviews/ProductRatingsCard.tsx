import { useState } from "react";
import { Star } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

export interface ProductRatingSummary {
  productId: number;
  productName: string;
  /** Null when every review for this product is hidden (see
   *  `productRatingSummaries` in `packages/db/src/crud/reviews.ts`) — a
   *  product can appear in `summaries` with a review count but no visible
   *  average. */
  avg: number | null;
  count: number;
}

type SortMode = "most_reviewed" | "highest_rated" | "lowest_rated";

const SORT_LABEL: Record<SortMode, string> = {
  most_reviewed: "Most Reviewed",
  highest_rated: "Highest Rated",
  lowest_rated: "Lowest Rated",
};

/** Products with no visible average (`avg === null`) always sort to the end,
 *  regardless of direction — null isn't a real "highest" or "lowest" rating,
 *  just an absence of one, so it must never outrank a product with a real
 *  average in either sort mode. */
function compareByAvg(a: ProductRatingSummary, b: ProductRatingSummary, direction: "desc" | "asc"): number {
  if (a.avg == null && b.avg == null) return 0;
  if (a.avg == null) return 1;
  if (b.avg == null) return -1;
  return direction === "desc" ? b.avg - a.avg : a.avg - b.avg;
}

const SORTERS: Record<SortMode, (a: ProductRatingSummary, b: ProductRatingSummary) => number> = {
  most_reviewed: (a, b) => b.count - a.count,
  highest_rated: (a, b) => compareByAvg(a, b, "desc"),
  lowest_rated: (a, b) => compareByAvg(a, b, "asc"),
};

interface ProductRatingsCardProps {
  /** The `summaries` array `GET /api/reviews` already returns — fed in by the
   *  assembling page rather than fetched again here, so this widget shares
   *  the page's one query instead of issuing a second network call for data
   *  that already arrived in the reviews list response. */
  summaries: ProductRatingSummary[];
  isLoading?: boolean;
}

/**
 * Top-5 product analytics widget. "Needing Attention" (a trend/recency
 * aggregate) is explicitly deferred — not built in Phase A, see task brief.
 */
export function ProductRatingsCard({ summaries, isLoading }: ProductRatingsCardProps): JSX.Element {
  const [sort, setSort] = useState<SortMode>("most_reviewed");
  const top5 = [...summaries].sort(SORTERS[sort]).slice(0, 5);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle as="h2">Product Ratings</CardTitle>
        <Select value={sort} onValueChange={(v) => setSort(v as SortMode)}>
          <SelectTrigger size="sm" className="w-40" aria-label="Sort product ratings">
            <SelectValue>{SORT_LABEL[sort]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABEL) as SortMode[]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {SORT_LABEL[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-line">
        {isLoading && <p className="py-2 text-sm text-ink-soft">Loading…</p>}
        {!isLoading && top5.length === 0 && (
          <p className="py-2 text-sm text-ink-soft">No rated products yet.</p>
        )}
        {!isLoading &&
          top5.map((s) => (
            <div key={s.productId} className="flex items-center justify-between gap-2 py-2">
              <span className="truncate text-sm text-ink">{s.productName}</span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-ink-soft">
                <Star className="h-4 w-4 fill-amberx text-amberx" />
                {s.avg != null ? s.avg.toFixed(1) : "—"} · {s.count}
              </span>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
