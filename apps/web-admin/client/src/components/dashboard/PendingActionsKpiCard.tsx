import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { useDashboardKpis } from "../../hooks/useDashboardKpis";

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
        {pa && total === 0 && <p className="text-sm text-ink-faint">All caught up.</p>}
        {pa && total > 0 && (
          <>
            <p className="font-display text-3xl font-semibold text-ink">{total}</p>
            <p className="mt-1 text-xs text-ink-soft">
              {pa.toReview} to review · {pa.refundDecisions} refund decisions · {pa.failedDeliveries} failed
              deliveries · {pa.manualApprovals} manual approvals
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
