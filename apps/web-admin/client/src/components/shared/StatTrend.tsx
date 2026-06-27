import { TrendingDown, TrendingUp } from "lucide-react";

export function StatTrend({ pct }: { pct: string | null }) {
  if (pct === null) return null;
  const n = Number(pct);
  const up = n >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${up ? "text-grass" : "text-rust"}`}>
      <Icon className="h-3.5 w-3.5" />
      {pct}% vs yesterday
    </span>
  );
}
