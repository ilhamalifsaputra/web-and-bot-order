import { useQuery } from "@tanstack/react-query";
import { useSse } from "./useSse";
import type { DigiflazzSyncStatus } from "../api/types";

/** No separate REST GET exists for this data — the SSE stream itself
 * (GET /api/dashboard/digiflazz-sync/stream) pushes the current status as
 * its very first frame on connect (streamSse's `initial` behavior,
 * packages/core/src/realtime/sseRoute.ts), typically within one HTTP
 * round-trip. `enabled: false` on this useQuery means queryFn never runs
 * — this is a purely cache-reactive read: useSse below is the only thing
 * that ever calls setQueryData for this key, and this hook's `data`
 * updates whenever that happens because they share the same queryKey. */
export function useDigiflazzSyncStatus() {
  const query = useQuery<DigiflazzSyncStatus | null>({
    queryKey: ["digiflazz-sync-status"],
    queryFn: () => Promise.resolve(null),
    enabled: false,
  });
  useSse<DigiflazzSyncStatus | null>("/api/dashboard/digiflazz-sync/stream", ["digiflazz-sync-status"]);
  return query;
}
