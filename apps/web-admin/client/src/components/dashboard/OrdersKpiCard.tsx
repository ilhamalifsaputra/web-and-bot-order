import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { KpiSkeleton } from "../shared/LoadingRegion";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";

export function OrdersKpiCard() {
  const { data, isLoading, isError } = useDashboardKpis();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Orders Today</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <KpiSkeleton label="Loading orders" />}
        {isError && <p className="text-sm text-rust">Couldn't load orders.</p>}
        {data && (
          <>
            <p className="font-display text-3xl font-semibold text-ink">{data.orders.total}</p>
            <p className="mt-1 text-xs text-ink-soft">
              {data.orders.delivered} delivered · {data.orders.pending} pending · {data.orders.failed} failed ·{" "}
              {data.orders.other} processing / other
            </p>
            <p className="mt-1 text-xs text-ink-soft">Product orders created today (wallet top-ups excluded).</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
