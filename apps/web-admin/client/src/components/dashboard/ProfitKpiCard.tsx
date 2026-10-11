import type { CurrencyProfit } from "../../api/types";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";
import { CurrencyStack, type CurrencyAmount } from "../shared/CurrencyAmount";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

function marginLine(label: string, p: CurrencyProfit) {
  const parts: string[] = [];
  if (p.marginPct !== null) parts.push(`${p.marginPct}% margin`);
  const missingCost = p.excludedItemCount - (p.excludedFxItemCount ?? 0);
  if (missingCost > 0)
    parts.push(`${missingCost} item${missingCost === 1 ? "" : "s"} without a cost price`);
  if (p.excludedFxItemCount) parts.push(`${p.excludedFxItemCount} items with unknown FX`);
  return parts.length ? `${label}: ${parts.join(" · ")}` : null;
}

export function ProfitKpiCard() {
  const { data, isLoading, isError } = useDashboardKpis();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profit Today</CardTitle>
      </CardHeader>
      <ProfitCardStatus isLoading={isLoading} isError={isError} data={data} />
    </Card>
  );
}

function ProfitCardStatus({ isLoading, isError, data }: {
  isLoading: boolean;
  isError: boolean;
  data: NoInfer<import("../../api/types").DashboardKpis> | undefined;
}) {
  return (<CardContent>
    {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
    {isError && <p className="text-sm text-rust">Couldn't load profit.</p>}
    {!isError && data && !data.profit.idr && !data.profit.usdt && (
      <p className="text-sm text-ink-soft">No profit yet today.</p>
    )}
    <ProfitCurrencySummary isError={isError} data={data} />
  </CardContent>);
}

function ProfitCurrencySummary({ isError, data }: {
  isError: boolean;
  data: NoInfer<import("../../api/types").DashboardKpis> | undefined;
}) {
  return (!isError && data && (data.profit.idr || data.profit.usdt) && (
    <>
      <CurrencyStack
        amounts={
          [
            data.profit.idr ? { currency: "IDR", value: data.profit.idr.netProfit } : null,
            data.profit.usdt ? { currency: "USDT", value: data.profit.usdt.netProfit } : null,
          ].filter(Boolean) as CurrencyAmount[]
        }
      />
      <div className="mt-1.5 flex flex-col gap-0.5">
        {data.profit.idr &&
          marginLine("IDR", data.profit.idr) &&
          <p className="text-xs text-ink-soft">{marginLine("IDR", data.profit.idr)}</p>}
        {data.profit.usdt &&
          marginLine("USDT", data.profit.usdt) &&
          <p className="text-xs text-ink-soft">{marginLine("USDT", data.profit.usdt)}</p>}
      </div>
      <p className="mt-1 text-xs text-ink-soft">Delivered today · product orders only.</p>
    </>
  ));
}
