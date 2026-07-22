import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { DataTable } from "../shared/DataTable";
import { StatusBadge } from "../shared/StatusBadge";
import { EmptyState } from "../shared/EmptyState";
import { formatCurrencyDisplay } from "../shared/CurrencyAmount";
import { useRecentOrders } from "../../hooks/useRecentOrders";

export function RecentOrdersTable() {
  const { data, isLoading, isError } = useRecentOrders();
  return (
    <Card>
      <CardHeader>
        {/* F-010: real heading, same level as "Operation Center" (<h2>). */}
        <CardTitle as="h2">Recent Orders</CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          <p className="text-sm text-rust">Couldn't load recent orders.</p>
        ) : (
          <DataTable
            columns={[
              {
                key: "order",
                header: "Order",
                render: (o) => (
                  <a href={`/orders/${o.orderId}`} className="font-mono text-xs text-pine hover:underline">
                    {o.orderCode}
                  </a>
                ),
              },
              { key: "product", header: "Product", render: (o) => <span className="text-ink">{o.productLabel}</span> },
              { key: "customer", header: "Customer", render: (o) => <span className="text-ink-soft">{o.customerLabel}</span> },
              { key: "amount", header: "Amount", render: (o) => <span className="font-mono text-ink">{formatCurrencyDisplay(o.amount, o.currency)}</span> },
              { key: "status", header: "Status", render: (o) => <StatusBadge status={o.status} /> },
              { key: "created", header: "Created", render: (o) => <span className="text-xs text-ink-soft">{o.createdAtDisplay ?? "—"}</span> },
            ]}
            data={data ?? []}
            isLoading={isLoading}
            keyExtractor={(o) => o.orderId}
            empty={<EmptyState title="No orders yet." />}
          />
        )}
      </CardContent>
    </Card>
  );
}
