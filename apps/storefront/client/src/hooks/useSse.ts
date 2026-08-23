import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Subscribes to a Server-Sent Events endpoint and writes each received
 * frame's parsed JSON into react-query's cache at `queryKey` via
 * `setQueryData` — the rest of the app keeps reading that key through a
 * normal `useQuery`, unaware whether its last update came from a push or
 * an ordinary fetch. Native `EventSource` auto-reconnects on drop with its
 * own backoff, so no custom reconnect logic is needed here.
 *
 * `merge`, when given, lets the caller fold a PARTIAL push payload into
 * the existing cached value instead of replacing it outright. Without
 * `merge`, the pushed payload replaces the cached value wholesale.
 *
 * `url === null` skips connecting entirely (for a caller whose URL
 * depends on data that might not be ready yet, or that only wants a
 * live connection open under some condition — see OrderDetailPage's own
 * usage, which only connects while the order is still PROCESSING) — this
 * is a normal, expected state, not an error.
 */
export function useSse<T>(
  url: string | null,
  queryKey: unknown[],
  merge?: (prev: T | undefined, next: unknown) => T,
): void {
  const queryClient = useQueryClient();
  const queryKeySerialized = JSON.stringify(queryKey);

  useEffect(() => {
    if (url === null) return;
    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      queryClient.setQueryData<T>(queryKey, (prev) => (merge ? merge(prev, parsed) : (parsed as T)));
    };
    return () => es.close();
  }, [url, queryKeySerialized, queryClient]);
}
