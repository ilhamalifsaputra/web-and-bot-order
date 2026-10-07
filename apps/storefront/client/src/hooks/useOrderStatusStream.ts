import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { OrderDetailData, OrderFulfillment } from "../api/types";

interface OrderSnapshot {
  orderStatus: string;
  digiflazzStatus?: "pending" | "reviewing" | null;
  fulfillment?: OrderFulfillment;
}

/** Fulfillment statuses after which the order cannot change any more — the
 * same set the server's stream closes on (apiOrderDigiflazzStream.ts). */
const FINAL_FULFILLMENT_STATUSES: ReadonlySet<string> = new Set(["SUCCESS", "CANCELLED", "FAILED"]);

/** SSE invalidates full detail so status, answers, credentials and flags agree. */
export function useOrderStatusStream(code: string, live: boolean): { disconnected: boolean; retry: () => void } {
  const client = useQueryClient();
  const [disconnected, setDisconnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!live) {
      setDisconnected(false);
      return;
    }
    const queryKey = ["account-order", code];
    const source = new EventSource(`/api/v1/account/orders/${code}/digiflazz/stream`, { withCredentials: true });
    // EventSource reconnects by itself; onerror only means "currently not
    // connected", so the next open/message clears the flag again.
    let finished = false;
    source.onopen = () => setDisconnected(false);
    source.onerror = () => {
      if (!finished) setDisconnected(true);
    };
    source.onmessage = (event) => {
      setDisconnected(false);
      let snapshot: OrderSnapshot;
      try {
        snapshot = JSON.parse(event.data) as OrderSnapshot;
      } catch {
        return;
      }
      if (!snapshot || typeof snapshot.orderStatus !== "string") return;
      const current = client.getQueryData<OrderDetailData>(queryKey)?.order;
      const changed = !current || current.status.toUpperCase() !== snapshot.orderStatus.toUpperCase()
        || (snapshot.digiflazzStatus !== undefined && (current.digiflazz_status ?? null) !== snapshot.digiflazzStatus)
        || (snapshot.fulfillment !== undefined && JSON.stringify(current.fulfillment) !== JSON.stringify(snapshot.fulfillment));
      if (changed) void client.invalidateQueries({ queryKey, exact: true });
      // The server ends the stream after a final snapshot. Close it here
      // first so the browser does not auto-reconnect to a stream that would
      // only close again, and do not report that end as a disconnect.
      if (snapshot.fulfillment && FINAL_FULFILLMENT_STATUSES.has(snapshot.fulfillment.status)) {
        finished = true;
        source.close();
        setDisconnected(false);
      }
    };
    return () => source.close();
  }, [client, code, live, attempt]);
  return { disconnected, retry };
}
