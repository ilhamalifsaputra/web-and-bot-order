import { RevenueKpiCard } from "./RevenueKpiCard";
import { RefundsKpiCard } from "./RefundsKpiCard";
import { NetSalesKpiCard } from "./NetSalesKpiCard";
import { ProfitKpiCard } from "./ProfitKpiCard";
import { OrdersKpiCard } from "./OrdersKpiCard";
import { PendingActionsKpiCard } from "./PendingActionsKpiCard";

/**
 * Refunds and Net Sales sit immediately after Revenue on purpose (Financial
 * Ledger M6, Task 6b): the three read left-to-right as one arithmetic
 * statement — gross, minus what was handed back, equals net — so the card that
 * explains the drop is never separated from the two figures it relates.
 *
 * Three columns rather than six at the widest breakpoint: six cards divide
 * evenly into 1/2/3 at every step, so no breakpoint leaves an orphan card on a
 * row of its own, and a money figure like "Rp1.234.567" stacked over a USDT line
 * still has room to render without wrapping.
 */
export function KpiRow() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <RevenueKpiCard />
      <RefundsKpiCard />
      <NetSalesKpiCard />
      <ProfitKpiCard />
      <OrdersKpiCard />
      <PendingActionsKpiCard />
    </div>
  );
}
