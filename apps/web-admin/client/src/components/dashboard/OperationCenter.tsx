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

const CARDS: OpCardDef[] = [
  { key: "pendingPayments", label: "Pending Payments", href: "/orders?status=PENDING_PAYMENT" },
  { key: "manualReviews", label: "Manual Reviews", href: "/orders?status=PENDING_VERIFICATION" },
  { key: "failedDeliveries", label: "Failed Deliveries", href: "/payments?outcome=delivery_failed", critical: true },
  { key: "ordersProcessing", label: "Orders Processing", href: "/orders?status=PAID" },
  // No orders-page filter isolates expired payments, so this card is a non-clickable counter.
  { key: "expiredPayments", label: "Expired Payments", href: null },
];

function level(count: number, critical?: boolean): "ok" | "warn" | "critical" | "idle" {
  if (count === 0) return "idle";
  return critical ? "critical" : "warn";
}

export function OperationCenter() {
  const { data, isLoading, isError } = useOperations();

  return (
    <section>
      <h2 className="mb-2 font-display text-lg font-semibold text-ink">Operation Center</h2>
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
              <a key={c.key} href={c.href} className="block transition-transform hover:-translate-y-0.5">
                {inner}
              </a>
            );
          })}
      </div>
    </section>
  );
}
