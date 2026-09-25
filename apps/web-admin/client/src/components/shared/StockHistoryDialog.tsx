import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { apiGet } from "../../api/client";
import { describeError } from "../../lib/errorMessages";

/** Mirrors StockEventType in @app/core/enums (the client doesn't import @app/core). */
const EVENT_LABELS: Record<string, string> = {
  IMPORTED: "Imported",
  RESERVED: "Reserved for an order",
  RESERVATION_RELEASED: "Reservation released",
  SOLD: "Sold",
  SUBSTITUTED_OUT: "Replaced (retired)",
  SUBSTITUTED_IN: "Issued as replacement",
  MARKED_DEAD: "Marked dead",
  CREDENTIAL_REVEALED: "Credentials revealed",
  REENCRYPTED: "Re-encrypted",
  SOFT_DELETED: "Deleted",
  WARRANTY_REPLACED: "Replaced under warranty",
};

/** Mirrors DeadReason in @app/core/enums. */
const REASON_LABELS: Record<string, string> = {
  PASSWORD_CHANGED: "Password changed",
  REGION_LOCK: "Region lock",
  SUPPLIER_REVOKED: "Supplier revoked",
  EXPIRED: "Expired",
  DUPLICATE: "Duplicate",
  TEST: "Test",
  OTHER: "Other",
};

const ACTOR_FALLBACK: Record<string, string> = { ADMIN: "An admin", CUSTOMER: "A customer", SYSTEM: "System" };

export interface StockHistoryEvent {
  id: number;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  reasonCode: string | null;
  actorType: string;
  actorName: string | null;
  orderId: number | null;
  orderCode: string | null;
  occurredAtDisplay: string | null;
}

interface StockHistoryDialogProps {
  stockItemId: number;
  onClose: () => void;
}

/** Real ledger events only (GET /api/stock/item/:id/history); never credentials. */
export function StockHistoryDialog({ stockItemId, onClose }: StockHistoryDialogProps): JSX.Element {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["stock-history", stockItemId],
    queryFn: () => apiGet<{ events: StockHistoryEvent[] }>(`/api/stock/item/${stockItemId}/history`),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>History of stock item #{stockItemId}</DialogTitle>
          <DialogDescription>Every recorded change to this account, oldest first. Times are shown in the shop timezone.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          {isLoading ? (
            <p className="text-sm text-ink-soft">Loading history…</p>
          ) : isError ? (
            <p role="alert" className="text-sm text-destructive">{describeError(error as Error)}</p>
          ) : !data || data.events.length === 0 ? (
            <p className="text-sm text-ink-soft">No recorded history yet.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {data.events.map((e) => (
                <li key={e.id} className="flex flex-col gap-1 border-l-2 border-line pl-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{EVENT_LABELS[e.eventType] ?? e.eventType}</span>
                    {e.fromStatus !== e.toStatus && (e.fromStatus || e.toStatus) && (
                      <Badge variant="outline">{e.fromStatus ?? "—"} → {e.toStatus ?? "—"}</Badge>
                    )}
                  </div>
                  <span className="text-xs text-ink-soft">
                    {e.occurredAtDisplay ?? "—"} · {e.actorName ?? ACTOR_FALLBACK[e.actorType] ?? e.actorType}
                    {e.reasonCode && ` · ${REASON_LABELS[e.reasonCode] ?? e.reasonCode}`}
                  </span>
                  {e.orderId !== null && (
                    <Link to={`/orders/${e.orderId}`} onClick={onClose} className="font-mono text-xs text-pine hover:underline">
                      {e.orderCode ?? `Order #${e.orderId}`}
                    </Link>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
