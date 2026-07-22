import { useQuery } from "@tanstack/react-query";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Download } from "lucide-react";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { EmptyState } from "../components/shared/EmptyState";
import { DataTable } from "../components/shared/DataTable";
import { StatusBadge } from "../components/shared/StatusBadge";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

interface DayRevenue {
  day: string;
  revenue_idr: string;
  revenue_usdt: string;
  orders: number;
}

interface ReportsData {
  daily: DayRevenue[];
  totalIdr: string;
  totalUsdt: string | null;
  products: { productId: number; name: string; qty: number; revenue: string }[];
  funnel: { status: string; count: number }[];
  vouchers: { id: number; code: string; usedCount: number; usageLimit: number | null; isActive: boolean }[];
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
      <PageHeader
        title="Reports"
        actions={
          <a href="/api/reports/export">
            <Button variant="outline" size="sm">
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
          </a>
        }
      />

      <div className="flex flex-col gap-6">
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Failed to load reports.</p>}

        {data && (
          <>
            {/* Revenue totals */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Card>
                <CardContent>
                  <p className="text-xs font-medium uppercase tracking-wider text-ink-soft">30-day Revenue (IDR)</p>
                  <p className="mt-1 font-display text-2xl font-semibold text-ink">
                    {formatCurrencyDisplay(data.totalIdr, "IDR")}
                  </p>
                </CardContent>
              </Card>
              {data.totalUsdt && (
                <Card>
                  <CardContent>
                    <p className="text-xs font-medium uppercase tracking-wider text-ink-soft">30-day Revenue (USDT)</p>
                    <p className="mt-1 font-display text-2xl font-semibold text-ink">
                      {formatCurrencyDisplay(data.totalUsdt, "USDT")}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Daily revenue chart */}
            {data.daily.length > 0 ? (
              <Card>
                <CardHeader><CardTitle>Daily Revenue (IDR) — Last {data.days} days</CardTitle></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={180}>
                    <AreaChart data={data.daily}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                      <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Area type="monotone" dataKey="revenue_idr" stroke="var(--color-grass)" fill="var(--color-grass-tint)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            ) : (
              <EmptyState title="No revenue data yet." />
            )}

            {/* Order funnel */}
            <Card>
              <CardHeader><CardTitle>Orders by Status</CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {data.funnel.map(({ status, count }) => (
                    <div key={status} className="flex items-center gap-2 rounded bg-sand px-3 py-1.5 text-sm">
                      <StatusBadge status={status} />
                      <strong className="text-ink">{count}</strong>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Top products */}
            {data.products.length > 0 && (
              <Card>
                <CardHeader><CardTitle>Top Products</CardTitle></CardHeader>
                <CardContent>
                  <DataTable
                    columns={[
                      { key: "product", header: "Product", render: (p) => <span className="text-ink">{p.name}</span> },
                      { key: "sold", header: "Sold", render: (p) => <span className="text-ink-soft">{p.qty}</span> },
                      { key: "revenue", header: "Revenue (IDR)", render: (p) => <span className="text-ink">{formatCurrencyDisplay(p.revenue, "IDR")}</span> },
                    ]}
                    data={data.products}
                    keyExtractor={(p) => p.productId}
                    empty={<EmptyState title="No product sales yet." />}
                  />
                </CardContent>
              </Card>
            )}

            {/* Voucher usage */}
            {data.vouchers.length > 0 && (
              <Card>
                <CardHeader><CardTitle>Voucher Usage</CardTitle></CardHeader>
                <CardContent>
                  <DataTable
                    columns={[
                      { key: "code", header: "Code", render: (v) => <span className="font-mono text-xs text-ink">{v.code}</span> },
                      { key: "uses", header: "Uses", render: (v) => <span className="text-ink-soft">{v.usedCount}{v.usageLimit != null ? ` / ${v.usageLimit}` : ""}</span> },
                      { key: "active", header: "Active", render: (v) => <span className="text-ink-soft">{v.isActive ? "Yes" : "No"}</span> },
                    ]}
                    data={data.vouchers}
                    keyExtractor={(v) => v.code}
                    empty={<EmptyState title="No voucher usage yet." />}
                  />
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </PageLayout>
  );
}
