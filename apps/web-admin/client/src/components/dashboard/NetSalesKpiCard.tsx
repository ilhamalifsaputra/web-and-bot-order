import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { CurrencyStack, type CurrencyAmount } from "../shared/CurrencyAmount";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";

/**
 * Today's gross product sales minus today's refund payouts, per currency
 * (Financial Ledger M6, Task 6b). "Revenue Today" next to this card already IS
 * the gross figure — product-only since Task 6a — so this card is what that
 * number becomes once money handed back is taken off it.
 *
 * A negative figure is rendered in full, never clamped or hidden: a refund can
 * legitimately be for an order sold on an earlier day, so "more refunded today
 * than sold today" is a real signal an operator needs. `formatCurrencyDisplay`
 * already prints the minus sign; the caveat line below says why in words and
 * carries the same `text-rust` token `StatTrend` uses for a negative move, so
 * the card reads as explainable rather than broken.
 *
 * The line is keyed off the actual sign rather than colouring the whole
 * CurrencyStack, so an IDR loss sitting beside a USDT gain never mislabels the
 * currency that is fine.
 */
export function NetSalesKpiCard() {
  const { data, isLoading, isError } = useDashboardKpis();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Net Sales Today</CardTitle>
        </CardHeader>
        <CardContent>Loading…</CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Net Sales Today</CardTitle>
        </CardHeader>
        <CardContent>Couldn't load net sales.</CardContent>
      </Card>
    );
  }

  const amounts: CurrencyAmount[] = [];
  if (data.netSales.idr) amounts.push({ currency: "IDR", value: data.netSales.idr });
  if (data.netSales.usdt) amounts.push({ currency: "USDT", value: data.netSales.usdt });
  const negatives = amounts.filter((a) => Number(a.value) < 0).map((a) => a.currency);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Net Sales Today</CardTitle>
      </CardHeader>
      <CardContent>
        {amounts.length > 0 ? (
          <>
            <CurrencyStack amounts={amounts} />
            {negatives.length > 0 && (
              <p className="mt-1.5 text-xs font-medium text-rust">
                {negatives.join(" and ")}: more refunded today than sold today.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-soft">No net sales yet today.</p>
        )}
      </CardContent>
    </Card>
  );
}
