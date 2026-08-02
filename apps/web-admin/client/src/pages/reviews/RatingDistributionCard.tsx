import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ProgressBar } from "../../components/shared/ProgressBar";
import { useReviewsKpis } from "../../hooks/useReviewsKpis";

type Star = 1 | 2 | 3 | 4 | 5;

// 5/4 stars read as positive (grass), 3 as a caution (amberx), 1/2 as
// negative (rust) — mirrors the same three-tone semantics ReviewSentiment
// uses elsewhere on this dashboard (StatusBadge's POSITIVE/NEUTRAL/NEGATIVE).
const STAR_TONE: Record<Star, "grass" | "amberx" | "rust"> = {
  5: "grass",
  4: "grass",
  3: "amberx",
  2: "rust",
  1: "rust",
};

const STARS: Star[] = [5, 4, 3, 2, 1];

export function RatingDistributionCard(): JSX.Element {
  const { data, isLoading, isError } = useReviewsKpis();
  const dist = data?.ratingDistribution;
  const total = dist ? STARS.reduce((sum, s) => sum + dist[s], 0) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Rating Distribution</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load rating distribution.</p>}
        {!isLoading &&
          !isError &&
          STARS.map((star) => {
            const count = dist?.[star] ?? 0;
            const pct = total > 0 ? (count / total) * 100 : 0;
            return (
              <div key={star} className="flex items-center gap-3">
                <span className="w-8 shrink-0 text-xs text-ink-soft">{star}★</span>
                <ProgressBar value={pct} tone={STAR_TONE[star]} className="flex-1" />
                <span className="w-6 shrink-0 text-right text-xs text-ink-soft">{count}</span>
              </div>
            );
          })}
      </CardContent>
    </Card>
  );
}
