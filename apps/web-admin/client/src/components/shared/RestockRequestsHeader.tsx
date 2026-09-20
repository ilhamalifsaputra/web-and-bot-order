import { RESTOCK_REQUESTS_TIP } from "@/lib/restockRequests";

export function RestockRequestsHeader({ label = "Restock requests" }: { label?: string }) {
  return (
    <span title={RESTOCK_REQUESTS_TIP} className="cursor-help underline decoration-dotted underline-offset-4">
      {label}
    </span>
  );
}
