import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { CurrencyStack, type CurrencyAmount } from "../shared/CurrencyAmount";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";
import type { CurrencyProfit } from "../../api/types";

function marginLine(label: string, p: CurrencyProfit) {
  const parts: string[] = [];
  if (p.marginPct !== null) parts.push(`${p.marginPct}% margin`);
  if (p.excludedItemCount > 0)
    parts.push(`${p.excludedItemCount} item${p.excludedItemCount === 1 ? "" : "s"} without a cost price`);
  return parts.length ? `${label}: ${parts.join(" · ")}` : null;
}

export function ProfitKpiCard() {
  const { data, isLoading, isError } = useDashboardKpis();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profit Today</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {(isError || (data && !data.profit.idr && !data.profit.usdt)) && (
          <p className="text-sm text-ink-soft">No profit yet today.</p>
        )}
        {data && (data.profit.idr || data.profit.usdt) && (
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
