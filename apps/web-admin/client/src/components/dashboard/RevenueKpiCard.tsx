import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { CurrencyStack, type CurrencyAmount } from "../shared/CurrencyAmount";
import { StatTrend } from "../shared/StatTrend";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";

export function RevenueKpiCard() {
  const { data, isLoading, isError } = useDashboardKpis();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Revenue Today</CardTitle>
        </CardHeader>
        <CardContent>Loading…</CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Revenue Today</CardTitle>
        </CardHeader>
        <CardContent>Couldn't load revenue.</CardContent>
      </Card>
    );
  }

  const amounts: CurrencyAmount[] = [];
  if (data.revenue.idr) amounts.push({ currency: "IDR", value: data.revenue.idr });
  if (data.revenue.usdt) amounts.push({ currency: "USDT", value: data.revenue.usdt });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue Today</CardTitle>
      </CardHeader>
      <CardContent>
        {amounts.length > 0 ? (
          <>
            <CurrencyStack amounts={amounts} />
            <div className="mt-1.5 flex flex-col gap-0.5">
              {data.revenue.trendPct.idr !== null && <StatTrend pct={data.revenue.trendPct.idr} label="IDR" />}
              {data.revenue.trendPct.usdt !== null && <StatTrend pct={data.revenue.trendPct.usdt} label="USDT" />}
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-soft">No revenue yet today.</p>
        )}
        <p className="mt-1 text-xs text-ink-soft">Delivered today · product orders only.</p>
      </CardContent>
    </Card>
  );
}
