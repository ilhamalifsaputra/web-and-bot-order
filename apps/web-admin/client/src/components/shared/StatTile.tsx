import { Card, CardContent } from "@/components/ui/card";

interface StatTileProps {
  label: string;
  value: string | number;
}

/** Compact stat card for a quick-stats row above a table — deliberately
 *  smaller/quieter than the Dashboard's `OrdersKpiCard`-style KPI cards. */
export function StatTile({ label, value }: StatTileProps): JSX.Element {
  return (
    <Card size="sm" className="shadow-none border-line">
      <CardContent>
        <p className="text-xs text-ink-soft">{label}</p>
        <p className="font-display text-xl font-semibold text-ink">{value}</p>
      </CardContent>
    </Card>
  );
}
