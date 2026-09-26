import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";
import type { DashboardKpis } from "../../api/types";

type PendingKey = keyof DashboardKpis["pendingActions"];

// The two payments links carry `actionable=1` so the Payments list hides rows
// whose order is already delivered/refunded/cancelled — the same rule the
// counters use (actionableManualMatchQueueCounts), so the count on a row
// equals the rows its link opens with.
const ROWS: { key: PendingKey; label: string; href: string }[] = [
  { key: "toReview", label: "Payments to review", href: "/orders?status=PENDING_VERIFICATION" },
  { key: "refundDecisions", label: "Underpaid orders", href: "/orders?status=UNDERPAID" },
  { key: "failedDeliveries", label: "Failed deliveries", href: "/payments?outcome=delivery_failed&actionable=1" },
  { key: "manualApprovals", label: "Unmatched payments", href: "/payments?outcome=unmatched&actionable=1" },
];

export function PendingActionsKpiCard() {
  const { data, isLoading, isError } = useDashboardKpis();
  const pa = data?.pendingActions;
  const total = pa ? pa.toReview + pa.refundDecisions + pa.failedDeliveries + pa.manualApprovals : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending Actions</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load pending actions.</p>}
        {pa && (
          <>
            <p className="font-display text-3xl font-semibold text-ink">{total}</p>
            {total === 0 && <p className="text-sm text-ink-soft">All caught up.</p>}
            <ul className="mt-2 space-y-0.5">
              {ROWS.map((r) => {
                const count = pa[r.key];
                return (
                  <li key={r.key}>
                    <Link
                      to={r.href}
                      className={`-mx-2 flex items-center justify-between rounded-md px-2 py-1 text-sm transition-colors duration-150 hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine ${
                        count === 0 ? "text-ink-soft" : "text-ink"
                      }`}
                    >
                      <span>{r.label}</span>
                      <span className="font-medium tabular-nums">{count}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
