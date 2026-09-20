import { TrendingDown, TrendingUp } from "lucide-react";

/** `label` names what the percentage is about (e.g. a currency) so two trend
 *  lines on one card are never ambiguous. The comparison basis is the same
 *  clock time yesterday, not yesterday's full total. */
export function StatTrend({ pct, label }: { pct: string | null; label?: string }) {
  if (pct === null) return null;
  const n = Number(pct);
  const up = n >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${up ? "text-grass" : "text-rust"}`}>
      <Icon className="h-3.5 w-3.5" />
      {label ? `${label} ` : ""}
      {pct}% vs same time yesterday
    </span>
  );
}
