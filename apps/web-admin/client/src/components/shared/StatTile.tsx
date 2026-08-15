import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface StatTileProps {
  label: string;
  value: string | number;
  /** Makes the tile a button — for counts that stand for a place you can go. */
  onClick?: () => void;
}

/** Compact stat card for a quick-stats row above a table — deliberately
 *  smaller/quieter than the Dashboard's `OrdersKpiCard`-style KPI cards. */
export function StatTile({ label, value, onClick }: StatTileProps): JSX.Element {
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
        <p className="font-display text-xl font-semibold text-ink break-words">{value}</p>
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
