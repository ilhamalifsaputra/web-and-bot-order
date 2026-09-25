import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface StatTileProps {
  label: string;
  value: string | number;
  /** Makes the tile a button — for counts that stand for a place you can go. */
  onClick?: () => void;
  /** Shows a skeleton instead of `value` — pass `!data` (not a table's own
   *  `isLoading`) so the tile never renders a real-looking 0 while the count
   *  it's built from hasn't loaded yet. */
  isLoading?: boolean;
}

/** Compact stat card for a quick-stats row above a table — deliberately
 *  smaller/quieter than the Dashboard's `OrdersKpiCard`-style KPI cards. */
export function StatTile({ label, value, onClick, isLoading }: StatTileProps): JSX.Element {
  const tile = (
    <Card
      size="sm"
      className={cn(
        "shadow-none border-line",
        onClick && "h-full text-left transition-colors hover:border-ink-soft hover:bg-sand",
      )}
    >
      <CardContent>
        <p className="text-xs text-ink-soft truncate" title={label}>{label}</p>
        {isLoading ? (
          <Skeleton className="h-6 w-10" />
        ) : (
          <p className="font-display text-xl font-semibold text-ink break-words">{value}</p>
        )}
      </CardContent>
    </Card>
  );

  if (!onClick) return tile;
  return (
    <button type="button" onClick={onClick} className="block w-full text-left">
      {tile}
    </button>
  );
}
