import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { StatusBadge } from "../shared/StatusBadge";
import { EmptyState } from "../shared/EmptyState";
import { formatCurrencyDisplay } from "../shared/CurrencyAmount";
import { useRecentOrders } from "../../hooks/useRecentOrders";

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function RecentOrdersTable() {
  const { data, isLoading, isError } = useRecentOrders();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Orders</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load recent orders.</p>}
        {data && data.length === 0 && <EmptyState message="No orders yet." />}
        {data && data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-soft">
                  <th className="py-1.5 pr-3 font-semibold">Order</th>
                  <th className="py-1.5 pr-3 font-semibold">Product</th>
                  <th className="py-1.5 pr-3 font-semibold">Customer</th>
                  <th className="py-1.5 pr-3 font-semibold">Amount</th>
                  <th className="py-1.5 pr-3 font-semibold">Status</th>
                  <th className="py-1.5 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.map((o) => (
                  <tr key={o.orderId}>
                    <td className="py-2 pr-3">
                      <a href={`/orders/${o.orderId}`} className="font-mono text-xs text-pine hover:underline">
                        {o.orderCode}
                      </a>
                    </td>
                    <td className="py-2 pr-3 text-ink">{o.productLabel}</td>
                    <td className="py-2 pr-3 text-ink-soft">{o.customerLabel}</td>
                    <td className="py-2 pr-3 font-mono text-ink">{formatCurrencyDisplay(o.amount, o.currency)}</td>
                    <td className="py-2 pr-3"><StatusBadge status={o.status} /></td>
                    <td className="py-2 text-xs text-ink-soft">{shortTime(o.createdAt)}</td>
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
