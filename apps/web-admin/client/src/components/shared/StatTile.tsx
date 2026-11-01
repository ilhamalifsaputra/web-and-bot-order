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
  /** The count could not be loaded (a failed first load): shows a dash
   *  with an "Unavailable" label for screen readers, never a made-up 0 or
   *  a skeleton that never resolves. Wins over `isLoading`. */
  unavailable?: boolean;
}

/** Compact stat card for a quick-stats row above a table — deliberately
 *  smaller/quieter than the Dashboard's `OrdersKpiCard`-style KPI cards. */
export function StatTile({ label, value, onClick, isLoading, unavailable }: StatTileProps): React.JSX.Element {
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
        <StatTileValue value={value} isLoading={isLoading} unavailable={unavailable} />
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

function StatTileValue({ value, isLoading, unavailable }: { value: string | number; isLoading?: boolean; unavailable?: boolean }) {
  if (unavailable) {
    return (
      <p className="font-display text-xl font-semibold text-ink-soft">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Unavailable</span>
      </p>
    );
  }
  if (isLoading) return <Skeleton className="h-6 w-10" />;
  return <p className="font-display text-xl font-semibold text-ink break-words">{value}</p>;
}
