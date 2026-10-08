import { Link } from "react-router-dom";
import { ChevronDown, RefreshCw } from "lucide-react";
import { CardRow } from "../shared/CardRow";
import { OrderUnitsCard, type OrderUnitsData } from "../orders/OrderUnitsCard";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { summarizeTicketOrder, type TicketOrderInput } from "../../lib/ticketOrderSummary";

export interface TicketOrder extends TicketOrderInput {
  id: number;
  orderCode: string;
  createdAtDisplay: string | null;
  voucher: { code: string; type: string } | null;
}

/** One order audit row, already resolved to display strings by the page. */
export interface OrderActivityEntry {
  id: number;
  time: string;
  timeTitle: string;
  actor: string;
  text: string;
}

/** Where the linked order's per-unit detail stands. `hidden` is the readonly
 *  role's 403 — that route is closed to it, which is expected, not an error. */
export type LinkedUnitsState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error"; onRetry: () => void; retrying: boolean }
  | { kind: "ready"; data: OrderUnitsData };

interface TicketIssueContextProps {
  ticketId: number;
  order: TicketOrder;
  /** Newest first, as the API returns it. */
  orderActivity: OrderActivityEntry[];
  units: LinkedUnitsState;
}

/** "PERCENT" -> "Percent", "fixed_amount" -> "Fixed amount". */
function voucherTypeLabel(type: string): string {
  const words = type.replace(/_/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ActivityLine({ entry }: { entry: OrderActivityEntry }) {
  return (
    <div className="min-w-0 text-sm">
      <div className="text-xs text-ink-soft">
        {entry.time && (
          <>
            <span title={entry.timeTitle}>{entry.time}</span> ·{" "}
          </>
        )}
        {entry.actor}
      </div>
      <div className="break-words text-ink">{entry.text}</div>
    </div>
  );
}

/** "2 of 3 units reported on this ticket" — distinct units with a replacement
 *  request that came in on this ticket, against every unit of the order. */
function reportedUnitsLine(data: OrderUnitsData, ticketId: number): string {
  const reported = new Set(
    data.stockReplacements.filter((r) => r.supportTicketId === ticketId).map((r) => r.orderItemId),
  ).size;
  const total = data.order.items.length;
  return `${reported} of ${total} ${total === 1 ? "unit" : "units"} reported on this ticket`;
}

/**
 * What the complaint is about: the linked order in compact form, and the
 * order's units with their replacement state and actions.
 */
export function TicketIssueContext({ ticketId, order, orderActivity, units }: TicketIssueContextProps) {
  const summary = summarizeTicketOrder(order);
  const [latest, ...older] = orderActivity;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle as="h2">Order</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <Link
              to={`/orders/${order.id}`}
              className="min-w-0 font-mono text-sm break-all text-pine hover:underline"
            >
              {order.orderCode}
            </Link>
            <span className="text-xs text-ink-soft">
              {order.createdAtDisplay ? `Purchased ${order.createdAtDisplay}` : "Purchase date not recorded"}
            </span>
          </div>

          <ul className="flex flex-col divide-y divide-line">
            {summary.lines.map((line) => (
              <li key={`${line.name}|${line.unitPriceText}`} className="flex min-w-0 flex-col py-2 first:pt-0">
                <span className="text-sm break-words text-ink">{line.name}</span>
                <span className="text-xs text-ink-soft">{line.unitPriceText}</span>
              </li>
            ))}
          </ul>

          <div className="flex flex-col divide-y divide-line border-t border-line">
            <CardRow label="Total" value={<span className="font-medium">{summary.totalText}</span>} />
            {order.voucher && (
              <CardRow
                label="Voucher"
                // break-all: a voucher code is one unbroken token.
                value={
                  <span className="font-mono text-xs break-all">
                    {order.voucher.code} ({voucherTypeLabel(order.voucher.type)})
                  </span>
                }
              />
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <div className="text-xs font-medium text-ink-soft">Latest order activity</div>
            {latest ? <ActivityLine entry={latest} /> : <p className="text-sm text-ink-soft">No order activity recorded yet.</p>}
            {older.length > 0 && (
              <details className="group">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-sm text-pine outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  View full order activity
                  <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <ol className="mt-2 flex flex-col gap-2">
                  {older.map((entry) => (
                    <li key={entry.id}>
                      <ActivityLine entry={entry} />
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        </CardContent>
      </Card>

      {units.kind === "ready" && (
        <OrderUnitsCard
          orderId={String(order.id)}
          units={units.data.order.items}
          replacements={units.data.stockReplacements}
          isDelivered={units.data.isDelivered}
          title="Affected units"
          showCredentials={false}
          supportTicketId={ticketId}
          headerAction={<span className="text-xs text-ink-soft">{reportedUnitsLine(units.data, ticketId)}</span>}
        />
      )}
      {units.kind === "loading" && (
        <Card aria-busy="true">
          <CardHeader>
            <CardTitle as="h2">Affected units</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </CardContent>
        </Card>
      )}
      {units.kind === "error" && (
        <Card>
          <CardHeader>
            <CardTitle as="h2">Affected units</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-soft">Order details couldn't be loaded.</p>
            <Button variant="outline" size="sm" onClick={units.onRetry} disabled={units.retrying}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}
    </>
  );
}
