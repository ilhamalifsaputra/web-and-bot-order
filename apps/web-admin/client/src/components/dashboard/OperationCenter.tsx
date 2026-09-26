import { Link } from "react-router-dom";
import { Card, CardContent } from "../ui/card";
import { UrgencyDot } from "../shared/UrgencyDot";
import { useOperations } from "../../hooks/useOperations";
import type { OperationsSummary } from "../../api/types";

type OpCardDef = {
  key: keyof OperationsSummary;
  label: string;
  href: string | null;
  // money-at-risk queues escalate to red; the rest warn; zero is idle.
  critical?: boolean;
};

// The drill-down links carry the same statuses the counters sum (see
// countPendingPaymentLike / countProcessing in packages/db/src/crud/orders.ts),
// comma-separated, so the number on a card equals the rows the list opens with.
const PENDING_PAYMENT_STATUSES = "PENDING_PAYMENT,PAYMENT_DETECTED,CONFIRMING";
const PROCESSING_STATUSES = "CONFIRMED,PAID";

const CARDS: OpCardDef[] = [
  { key: "pendingPayments", label: "Pending Payments", href: `/orders?status=${PENDING_PAYMENT_STATUSES}` },
  { key: "manualReviews", label: "Manual Reviews", href: "/orders?status=PENDING_VERIFICATION" },
  { key: "failedDeliveries", label: "Failed Deliveries", href: "/payments?outcome=delivery_failed&actionable=1", critical: true },
  { key: "ordersProcessing", label: "Orders Processing", href: `/orders?status=${PROCESSING_STATUSES}` },
  // No orders-page filter isolates expired payments, so this card is a non-clickable counter.
  { key: "expiredPayments", label: "Expired Payments", href: null },
  // Manual/manual_with_info orders paid and waiting on an admin to hand-type
  // and send the account — distinct from "Orders Processing" above (the
  // unrelated legacy CONFIRMED/PAID payment-gateway metric).
  { key: "awaitingFulfillment", label: "Awaiting Fulfillment", href: "/orders?status=PROCESSING" },
];

function level(count: number, critical?: boolean): "ok" | "warn" | "critical" | "idle" {
  if (count === 0) return "idle";
  return critical ? "critical" : "warn";
}

export function OperationCenter() {
  const { data, isLoading, isError } = useOperations();

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-ink">Operation Center</h2>
        {/* The cards below are read-only counters computed live from Order/
            Payment-adjacent tables (GET /api/dashboard/operations) — a
            SEPARATE concept from the AdminTask queue (Task 9b's Tasks page).
            Nothing currently creates AdminTask rows from these same events,
            so none of these counters map onto a task-queue filter yet; this
            is a plain, generic link to the queue rather than a false
            counter-to-task correspondence. */}
        <Link to="/tasks" className="text-sm font-medium text-pine hover:underline">
          Manage Tasks →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {isLoading && <p className="text-sm text-ink-soft">Loading…</p>}
        {isError && <p className="text-sm text-rust">Couldn't load operations.</p>}
        {data &&
          CARDS.map((c) => {
            const inner = (
              <Card>
                <CardContent className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-display text-2xl font-semibold text-ink">{data[c.key]}</p>
                    <p className="text-xs text-ink-soft">{c.label}</p>
                  </div>
                  <UrgencyDot level={level(data[c.key], c.critical)} />
                </CardContent>
              </Card>
            );
            return c.href === null ? (
              <div key={c.key}>{inner}</div>
            ) : (
              <Link key={c.key} to={c.href} className="block transition-transform hover:-translate-y-0.5">
                {inner}
              </Link>
            );
          })}
      </div>
    </section>
  );
}
