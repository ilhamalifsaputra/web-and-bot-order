import { useQuery } from "@tanstack/react-query";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { PageLayout } from "../components/shared/PageLayout";
import { EmptyState } from "../components/shared/EmptyState";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";

interface DayRevenue {
  date: string;
  revenue_idr: string;
  revenue_usdt: string;
  orders: number;
}

interface ReportsData {
  daily: DayRevenue[];
  totalIdr: string;
  totalUsdt: string | null;
  products: { productName: string; sold: number; revenue_idr: string }[];
  funnel: Record<string, number>;
  vouchers: { code: string; uses: number; discountIdr: string }[];
  days: number;
}

export function ReportsPage() {
  const { data, isLoading, isError } = useQuery<ReportsData>({
    queryKey: ["reports"],
    queryFn: async () => {
      const res = await fetch("/api/reports", { credentials: "include" });
      if (!res.ok) throw new Error(`/api/reports ${res.status}`);
      return res.json() as Promise<ReportsData>;
    },
    refetchInterval: 5 * 60_000,
  });

  return (
    <PageLayout title="Reports">
      <div className="flex flex-col gap-6">
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Failed to load reports.</p>}

        {data && (
          <>
            {/* Revenue totals */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-line bg-card p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-ink-soft">30-day Revenue (IDR)</p>
                <p className="mt-1 font-display text-2xl font-semibold text-ink">
                  {formatCurrencyDisplay(data.totalIdr, "IDR")}
                </p>
              </div>
              {data.totalUsdt && (
                <div className="rounded-lg border border-line bg-card p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-ink-soft">30-day Revenue (USDT)</p>
                  <p className="mt-1 font-display text-2xl font-semibold text-ink">
                    {formatCurrencyDisplay(data.totalUsdt, "USDT")}
                  </p>
                </div>
              )}
            </div>

            {/* Daily revenue chart */}
            {data.daily.length > 0 ? (
              <div className="rounded-lg border border-line bg-card p-4">
                <h2 className="mb-3 text-sm font-medium text-ink">Daily Revenue (IDR) — Last {data.days} days</h2>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={data.daily}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line, #e5e7eb)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Area type="monotone" dataKey="revenue_idr" stroke="#16a34a" fill="#dcfce7" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState message="No revenue data yet." />
            )}

            {/* Order funnel */}
            <div className="rounded-lg border border-line bg-card p-4">
              <h2 className="mb-3 text-sm font-medium text-ink">Orders by Status</h2>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.funnel).map(([status, count]) => (
                  <span key={status} className="rounded bg-sand px-3 py-1.5 text-sm text-ink">
                    {status}: <strong>{count}</strong>
                  </span>
                ))}
              </div>
            </div>

            {/* Top products */}
            {data.products.length > 0 && (
              <div className="rounded-lg border border-line bg-card">
                <h2 className="border-b border-line px-4 py-3 text-sm font-medium text-ink">Top Products</h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-ink-soft">
                      <th className="px-4 py-2 font-medium">Product</th>
                      <th className="px-4 py-2 font-medium">Sold</th>
                      <th className="px-4 py-2 font-medium">Revenue (IDR)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.products.map((p, i) => (
                      <tr key={i} className="hover:bg-sand/40">
                        <td className="px-4 py-2 text-ink">{p.productName}</td>
                        <td className="px-4 py-2 text-ink-soft">{p.sold}</td>
                        <td className="px-4 py-2 text-ink">
                          {formatCurrencyDisplay(p.revenue_idr, "IDR")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Voucher usage */}
            {data.vouchers.length > 0 && (
              <div className="rounded-lg border border-line bg-card">
                <h2 className="border-b border-line px-4 py-3 text-sm font-medium text-ink">Voucher Usage</h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-ink-soft">
                      <th className="px-4 py-2 font-medium">Code</th>
                      <th className="px-4 py-2 font-medium">Uses</th>
                      <th className="px-4 py-2 font-medium">Discount (IDR)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.vouchers.map((v) => (
                      <tr key={v.code} className="hover:bg-sand/40">
                        <td className="px-4 py-2 font-mono text-xs text-ink">{v.code}</td>
                        <td className="px-4 py-2 text-ink-soft">{v.uses}</td>
                        <td className="px-4 py-2 text-ink">
                          {formatCurrencyDisplay(v.discountIdr, "IDR")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </PageLayout>
  );
}
