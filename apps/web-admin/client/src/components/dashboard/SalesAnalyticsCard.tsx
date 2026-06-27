import { useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { EmptyState } from "../shared/EmptyState";
import { useAnalytics } from "../../hooks/useAnalytics";
import type { AnalyticsCurrency, AnalyticsMetric, AnalyticsRange } from "../../api/types";

function FilterGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2 py-1 text-xs font-medium ${
            value === o.value ? "bg-pine text-white" : "text-ink-soft hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SalesAnalyticsCard() {
  const [range, setRange] = useState<AnalyticsRange>("7d");
  const [currency, setCurrency] = useState<AnalyticsCurrency>("idr");
  const [metric, setMetric] = useState<AnalyticsMetric>("revenue");
  const { data, isLoading, isError } = useAnalytics(range, currency, metric);

  // Recharts needs numeric y-values; the money series arrives as strings.
  const chartData = (data ?? []).map((p) => ({ day: p.day, value: Number(p.value) }));

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>Sales Analytics</CardTitle>
        <div className="flex flex-wrap gap-2">
          <FilterGroup
            options={[
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
            ]}
            value={range}
            onChange={setRange}
          />
          <FilterGroup
            options={[
              { value: "idr", label: "IDR" },
              { value: "usdt", label: "USDT" },
              { value: "combined", label: "Combined" },
            ]}
            value={currency}
            onChange={setCurrency}
          />
          <FilterGroup
            options={[
              { value: "revenue", label: "Revenue" },
              { value: "orders", label: "Orders" },
            ]}
            value={metric}
            onChange={setMetric}
          />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load analytics.</p>}
        {data && chartData.length === 0 && <EmptyState message="No data for this range." />}
        {data && chartData.length > 0 && (
          <div className="h-64 w-full overflow-x-auto">
            <div className="h-full min-w-[480px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 8, left: 12 }}>
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="#97a1b1" />
                  <YAxis tick={{ fontSize: 11 }} stroke="#97a1b1" width={56} />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
