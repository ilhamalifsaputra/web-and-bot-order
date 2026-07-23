import { Users, UserPlus, Activity, Repeat, Wallet } from "lucide-react";
import { StatCard } from "../../components/shared/StatCard";
import { CurrencyStack, type CurrencyAmount } from "../../components/shared/CurrencyAmount";
import { useCustomersKpis } from "../../hooks/useCustomersKpis";

export function CustomersKpiRow(): JSX.Element {
  const { data, isLoading } = useCustomersKpis();

  const revenueAmounts: CurrencyAmount[] = [
    data?.totalRevenue.idr != null ? ({ currency: "IDR", value: data.totalRevenue.idr } as CurrencyAmount) : null,
    data?.totalRevenue.usdt != null ? ({ currency: "USDT", value: data.totalRevenue.usdt } as CurrencyAmount) : null,
  ].filter((a): a is CurrencyAmount => a !== null);

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard label="Total Customers" value={data?.totalCustomers ?? 0} icon={Users} isLoading={isLoading} />
      <StatCard label="New Today" value={data?.newToday ?? 0} icon={UserPlus} isLoading={isLoading} />
      <StatCard label="Active Today" value={data?.activeToday ?? 0} icon={Activity} isLoading={isLoading} />
      <StatCard label="Returning Customers" value={data?.returningCustomers ?? 0} icon={Repeat} tone="success" isLoading={isLoading} />
      <StatCard
        label="Total Revenue"
        value={revenueAmounts.length > 0 ? <CurrencyStack amounts={revenueAmounts} /> : "—"}
        icon={Wallet}
        isLoading={isLoading}
      />
    </div>
  );
}
