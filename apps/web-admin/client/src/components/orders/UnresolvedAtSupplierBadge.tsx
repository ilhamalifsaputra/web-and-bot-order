import { Hourglass } from "lucide-react";

/**
 * Amber marker for a paid Digiflazz order unresolved at the supplier: no
 * final answer after its first 24 hours of checks, so an admin has to
 * reconcile it with Digiflazz. Shown beside the order's own status badge (the
 * order stays PROCESSING), in the same pill shape and amber tokens as
 * `OrderStatusBadge`'s awaiting buckets, with its own icon.
 */
export function UnresolvedAtSupplierBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amberx-tint px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-amberx">
      <Hourglass className="h-3 w-3" aria-hidden="true" />
      Unresolved at supplier
    </span>
  );
}
