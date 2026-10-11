import { lazy, Suspense } from "react";
type ChartProps = { chartData: { day: string; value: number | null }[]; yUnit: string };
const Chart = lazy(async () => {
  const { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } = await import("recharts");
  return {
    default: function SalesChart({ chartData, yUnit }: ChartProps) {
      return (<ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 8, left: 12 }}>
          <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="var(--color-ink-faint)" />
          <YAxis
            tick={{ fontSize: 11 }}
            stroke="var(--color-ink-faint)"
            width={72}
            label={{ value: yUnit, angle: -90, position: "insideLeft", style: { fontSize: 11, textAnchor: "middle" } }}
          />
          <Tooltip />
          <Line type="monotone" dataKey="value" stroke="var(--color-pine)" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>);
    }
  };
});
export function SalesLineChart(props: ChartProps) {
  return <Suspense fallback={<p role="status">Loading chart...</p>}><Chart {...props} /></Suspense>;
}
