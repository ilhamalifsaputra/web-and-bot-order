import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { CurrencyStack, type CurrencyAmount } from "../shared/CurrencyAmount";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";

/**
 * Refunds actually paid out today, per currency (Financial Ledger M6, Task 6b) —
 * the first place on this dashboard that reflects a refund at all. Every figure
 * comes from a real COMPLETED `RefundExecution` row via `refundTotalsSince`, so
 * a shop that has never refunded anything gets the empty state, never a
 * placeholder number.
 *
 * No trend line: a vs-yesterday comparison for refunds is deliberately deferred
 * (the backend computes no `trendPct` for this field yet).
 */
export function RefundsKpiCard() {
  const { data, isLoading, isError } = useDashboardKpis();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Refunds Today</CardTitle>
        </CardHeader>
        <CardContent>Loading…</CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Refunds Today</CardTitle>
        </CardHeader>
        <CardContent>Couldn't load refunds.</CardContent>
      </Card>
    );
  }

  const amounts: CurrencyAmount[] = [];
  if (data.refunds.idr) amounts.push({ currency: "IDR", value: data.refunds.idr });
  if (data.refunds.usdt) amounts.push({ currency: "USDT", value: data.refunds.usdt });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Refunds Today</CardTitle>
      </CardHeader>
      <CardContent>
        {amounts.length > 0 ? (
          <CurrencyStack amounts={amounts} />
        ) : (
          <p className="text-sm text-ink-soft">No refunds yet today.</p>
        )}
      </CardContent>
    </Card>
  );
}
