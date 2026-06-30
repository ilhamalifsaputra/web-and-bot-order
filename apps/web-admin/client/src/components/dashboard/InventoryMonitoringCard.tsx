import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { EmptyState } from "../shared/EmptyState";
import { useInventory } from "../../hooks/useInventory";

export function InventoryMonitoringCard() {
  const { data, isLoading, isError } = useInventory();
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Critical Stock</CardTitle>
        <a href="/stock" className="text-xs font-semibold text-pine hover:underline">
          View inventory
        </a>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load inventory.</p>}
        {data && data.length === 0 && <EmptyState message="Stock levels are healthy." />}
        {data && data.length > 0 && (
          <ul className="flex flex-col divide-y divide-line">
            {data.map((r) => (
              <li key={r.denominationId} className="flex items-center justify-between py-2">
                <span className="text-sm text-ink">{r.productName}</span>
                <span className={`text-sm font-semibold ${r.available === 0 ? "text-rust" : "text-amberx"}`}>
                  {r.available} left
                  <span className="ml-1 text-xs font-normal text-ink-soft">/ {r.threshold}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
