import { RevenueKpiCard } from "./RevenueKpiCard";
import { ProfitKpiCard } from "./ProfitKpiCard";
import { OrdersKpiCard } from "./OrdersKpiCard";
import { PendingActionsKpiCard } from "./PendingActionsKpiCard";

export function KpiRow() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <RevenueKpiCard />
      <ProfitKpiCard />
      <OrdersKpiCard />
      <PendingActionsKpiCard />
    </div>
  );
}
