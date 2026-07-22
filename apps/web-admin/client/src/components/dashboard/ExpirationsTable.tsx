import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { DataTable } from "../shared/DataTable";
import { EmptyState } from "../shared/EmptyState";
import { useExpirations } from "../../hooks/useExpirations";

export function ExpirationsTable() {
  const { data, isLoading, isError } = useExpirations();
  return (
    <Card>
      <CardHeader>
        {/* F-010: real heading, same level as "Operation Center" (<h2>). */}
        <CardTitle as="h2">Upcoming Expirations</CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          <p className="text-sm text-rust">Couldn't load expirations.</p>
        ) : (
          <DataTable
            columns={[
              { key: "product", header: "Product", render: (r) => <span className="text-ink">{r.productName}</span> },
              { key: "customer", header: "Customer", render: (r) => <span className="text-ink-soft">{r.customerLabel}</span> },
              {
                key: "remaining",
                header: "Remaining",
                render: (r) => (
                  <span className={r.remainingDays <= 1 ? "font-semibold text-rust" : "text-amberx"}>
                    {r.remainingDays} day{r.remainingDays === 1 ? "" : "s"}
                  </span>
                ),
              },
              {
                key: "order",
                header: "Order",
                render: (r) => (
                  <a href={`/orders/${r.orderId}`} className="font-mono text-xs text-pine hover:underline">
                    {r.orderCode}
                  </a>
                ),
              },
            ]}
            data={data ?? []}
            isLoading={isLoading}
            keyExtractor={(r) => r.orderId}
            empty={<EmptyState title="No upcoming expirations." />}
          />
        )}
      </CardContent>
    </Card>
  );
}
