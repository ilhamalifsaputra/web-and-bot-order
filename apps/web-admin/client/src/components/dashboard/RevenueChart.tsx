import { lazy, Suspense } from "react";
type ChartProps = { daily: { day: string; revenue_idr: string }[] };
const Chart = lazy(async () => {
  const { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } = await import("recharts");
  return {
    default: function DailyRevenue({ daily }: ChartProps) {
      return (<ResponsiveContainer width="100%" height={180}>
        <AreaChart data={daily}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
          <XAxis dataKey="day" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Area type="monotone" dataKey="revenue_idr" stroke="var(--color-grass)" fill="var(--color-grass-tint)" />
        </AreaChart>
      </ResponsiveContainer>);
    }
  };
});
export function RevenueChart(props: ChartProps) {
  return <Suspense fallback={<p role="status">Loading chart...</p>}><Chart {...props} /></Suspense>;
}
