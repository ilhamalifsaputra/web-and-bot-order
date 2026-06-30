import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { EmptyState } from "../shared/EmptyState";
import { useExpirations } from "../../hooks/useExpirations";

export function ExpirationsTable() {
  const { data, isLoading, isError } = useExpirations();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Upcoming Expirations</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load expirations.</p>}
        {data && data.length === 0 && <EmptyState message="No upcoming expirations." />}
        {data && data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-soft">
                  <th className="py-1.5 pr-3 font-semibold">Product</th>
                  <th className="py-1.5 pr-3 font-semibold">Customer</th>
                  <th className="py-1.5 pr-3 font-semibold">Remaining</th>
                  <th className="py-1.5 font-semibold">Order</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.map((r) => (
                  <tr key={r.orderId}>
                    <td className="py-2 pr-3 text-ink">{r.productName}</td>
                    <td className="py-2 pr-3 text-ink-soft">{r.customerLabel}</td>
                    <td className="py-2 pr-3">
                      <span className={r.remainingDays <= 1 ? "font-semibold text-rust" : "text-amberx"}>
                        {r.remainingDays} day{r.remainingDays === 1 ? "" : "s"}
                      </span>
                    </td>
                    <td className="py-2">
                      <a href={`/orders/${r.orderId}`} className="font-mono text-xs text-pine hover:underline">
                        {r.orderCode}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
