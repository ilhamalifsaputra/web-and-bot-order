import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { EmptyState } from "../shared/EmptyState";
import { formatCurrencyDisplay } from "../shared/CurrencyAmount";
import { useTopProducts } from "../../hooks/useTopProducts";

export function TopProductsList() {
  const { data, isLoading, isError } = useTopProducts();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Products · Last 30 Days</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load top products.</p>}
        {data && data.length === 0 && <EmptyState message="No sales in this period." />}
        {data && data.length > 0 && (
          <ol className="flex flex-col divide-y divide-line">
            {data.map((p) => (
              <li key={p.productId} className="flex items-center justify-between py-2">
                <span className="text-sm text-ink">{p.name}</span>
                <span className="text-right text-xs text-ink-soft">
                  {p.unitsSold} sold · {formatCurrencyDisplay(p.revenueIdrEquiv, "IDR")} revenue ·{" "}
                  {p.profitIdrEquiv === null
                    ? "N/A profit"
                    : `${formatCurrencyDisplay(p.profitIdrEquiv, "IDR")} profit`}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
