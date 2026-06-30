import { KpiRow } from "../components/dashboard/KpiRow";
import { OperationCenter } from "../components/dashboard/OperationCenter";
import { InventoryMonitoringCard } from "../components/dashboard/InventoryMonitoringCard";
import { ExpirationsTable } from "../components/dashboard/ExpirationsTable";
import { SalesAnalyticsCard } from "../components/dashboard/SalesAnalyticsCard";
import { RecentOrdersTable } from "../components/dashboard/RecentOrdersTable";
import { BusinessHealthGrid } from "../components/dashboard/BusinessHealthGrid";
import { TopProductsList } from "../components/dashboard/TopProductsList";
import { PageHeader } from "../components/shared/PageHeader";

export function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" />
      <KpiRow />
      <OperationCenter />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <InventoryMonitoringCard />
        <ExpirationsTable />
      </div>
      <SalesAnalyticsCard />
      <RecentOrdersTable />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BusinessHealthGrid />
        <TopProductsList />
      </div>
    </div>
  );
}
