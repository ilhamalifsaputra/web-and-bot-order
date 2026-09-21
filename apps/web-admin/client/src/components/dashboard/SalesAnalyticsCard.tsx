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

const RANGE_OPTIONS: Array<{ value: AnalyticsRange; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  // Calendar rollups (Task 6c) — kept alongside the two rolling day windows
  // rather than replacing them: "the last 30 days" and "this month" are
  // different questions, and operators use both.
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

const METRIC_OPTIONS: Array<{ value: AnalyticsMetric; label: string }> = [
  { value: "revenue", label: "Revenue" },
  { value: "orders", label: "Orders" },
  { value: "profit", label: "Profit" },
];

/** Short unit for the y-axis itself. Profit is reported per currency from
 *  catalog-central IDR figures, so it carries the same unit revenue does. */
function axisUnit(metric: AnalyticsMetric, currency: AnalyticsCurrency): string {
  if (metric === "orders") return "Orders";
  return currency === "combined" ? "IDR equiv." : currency.toUpperCase();
}

/** What the plotted value is, so the series never reads as a bare number. */
function seriesLabel(metric: AnalyticsMetric, currency: AnalyticsCurrency): string {
  const ccy = currency.toUpperCase();
  if (metric === "orders") {
    if (currency === "combined") return "Delivered orders (all currencies)";
    return `Delivered orders (paid in ${ccy})`;
  }
  if (metric === "profit") {
    // The route falls back to the IDR series when Combined is asked for, so say
    // IDR rather than promise a blend that does not exist.
    return currency === "usdt" ? "Net profit (USDT)" : "Net profit (IDR)";
  }
  if (currency === "combined") return "Delivered revenue (IDR equivalent)";
  return `Delivered revenue (${ccy})`;
}

/** What one point on the x-axis covers. Every bucketed series is cut on UTC
 *  calendar boundaries (the metrics contract's "UTC everywhere" policy), NOT on
 *  the shop-local midnight the "Today" KPI cards use, so say so. */
function bucketLabel(range: AnalyticsRange): string {
  if (range === "week") return "per ISO week (Monday start, UTC)";
  if (range === "month") return "per calendar month (UTC)";
  if (range === "year") return "per calendar year (UTC)";
  return "per delivery day (UTC)";
}

export function SalesAnalyticsCard() {
  const [range, setRange] = useState<AnalyticsRange>("7d");
  const [currency, setCurrency] = useState<AnalyticsCurrency>("idr");
  const [metric, setMetric] = useState<AnalyticsMetric>("revenue");
  const { data, isLoading, isError } = useAnalytics(range, currency, metric);

  // Only revenue has a currency blend (built on Order.totalAmount, which
  // follows the order's own currency). Profit is derived from catalog-central
  // IDR prices and costs, so there is no honest combined-profit figure —
  // Combined is dropped from the options entirely while Profit is selected, and
  // an already-selected Combined falls back to IDR on the way in, so the chart
  // never sits on a filter combination the API can't answer as asked.
  const currencyOptions: Array<{ value: AnalyticsCurrency; label: string }> = [
    { value: "idr", label: "IDR" },
    { value: "usdt", label: "USDT" },
    ...(metric === "profit" ? [] : [{ value: "combined" as AnalyticsCurrency, label: "Combined" }]),
  ];
  const changeMetric = (next: AnalyticsMetric) => {
    setMetric(next);
    if (next === "profit" && currency === "combined") setCurrency("idr");
  };

  // Recharts needs numeric y-values; the money series arrives as strings. A
  // null profit bucket stays null (Number(null) would be a fabricated 0) —
  // Recharts leaves a gap in the line for it.
  const chartData = (data ?? []).map((p) => ({ day: p.day, value: p.value === null ? null : Number(p.value) }));
  // An all-null series (e.g. a profit range where no sold item has a known
  // cost) carries no plottable point, so it reads as "no data" rather than as a
  // chart with an invisible line.
  const hasPlottableValue = chartData.some((p) => p.value !== null);
  const yLabel = seriesLabel(metric, currency);
  const yUnit = axisUnit(metric, currency);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {/* F-010: real heading, same level as "Operation Center" (<h2>). */}
        <CardTitle as="h2">Sales Analytics</CardTitle>
        <div className="flex flex-wrap gap-2">
          <FilterGroup options={RANGE_OPTIONS} value={range} onChange={setRange} />
          <FilterGroup options={currencyOptions} value={currency} onChange={setCurrency} />
          <FilterGroup options={METRIC_OPTIONS} value={metric} onChange={changeMetric} />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load analytics.</p>}
        {data && !hasPlottableValue && <EmptyState title="No data for this range." />}
        {data && hasPlottableValue && (
          <>
            <p className="mb-1 text-xs text-ink-soft">{yLabel} · {bucketLabel(range)}</p>
            <div className="h-64 w-full overflow-x-auto">
              <div className="h-full min-w-[480px]">
                <ResponsiveContainer width="100%" height="100%">
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
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
