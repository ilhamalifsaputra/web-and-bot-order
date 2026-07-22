import { ShoppingCart, Wallet, PackageSearch, RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import { StatCard } from "../../components/shared/StatCard";
import { CurrencyStack, type CurrencyAmount } from "../../components/shared/CurrencyAmount";
import { useOrdersKpis } from "../../hooks/useOrdersKpis";

export function OrdersKpiRow(): JSX.Element {
  const { data, isLoading } = useOrdersKpis();

  // Never concatenate multiple currencies into one string (the exact bug
  // CurrencyStack exists to prevent) — render whichever of IDR/USDT today's
  // revenue actually has, each on its own line.
  const revenueAmounts: CurrencyAmount[] = [
    data?.revenueToday.idr != null ? ({ currency: "IDR", value: data.revenueToday.idr } as CurrencyAmount) : null,
    data?.revenueToday.usdt != null ? ({ currency: "USDT", value: data.revenueToday.usdt } as CurrencyAmount) : null,
  ].filter((a): a is CurrencyAmount => a !== null);

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard label="Total Orders" value={data?.totalOrders ?? 0} icon={ShoppingCart} isLoading={isLoading} />
      <StatCard
        label="Revenue Today"
        value={revenueAmounts.length > 0 ? <CurrencyStack amounts={revenueAmounts} /> : "—"}
        icon={Wallet}
        isLoading={isLoading}
      />
      <StatCard
        label="Awaiting Fulfillment"
        value={data?.awaitingFulfillment ?? 0}
        icon={PackageSearch}
        tone="warning"
        isLoading={isLoading}
      />
      <StatCard label="Processing" value={data?.processing ?? 0} icon={RefreshCw} isLoading={isLoading} />
      <StatCard label="Delivered" value={data?.delivered ?? 0} icon={CheckCircle2} tone="success" isLoading={isLoading} />
      <StatCard label="Cancelled" value={data?.cancelled ?? 0} icon={XCircle} tone="danger" isLoading={isLoading} />
    </div>
  );
}
