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
 * the existing cached value instead of replacing it outright (e.g. an
 * SSE frame carrying only four digiflazz* fields that must be merged
 * into a much larger cached order-detail object, not overwrite it).
 * Without `merge`, the pushed payload replaces the cached value wholesale
 * — the right default for a query whose SSE stream IS its only shape
 * (e.g. the catalog-sync status).
 *
 * `url === null` skips connecting entirely (for a caller whose URL
 * depends on data that might not be ready yet, e.g. a still-unresolved
 * route param) — this is a normal, expected state, not an error.
 */
export function useSse<T>(
  url: string | null,
  queryKey: unknown[],
  merge?: (prev: T | undefined, next: unknown) => T,
): void {
  const queryClient = useQueryClient();
  // queryKey is very often a fresh array literal on every render at the
  // call site (e.g. ["order", orderId]) — serialize it for the effect's
  // dependency so the connection doesn't churn on every render.
  const queryKeySerialized = JSON.stringify(queryKey);

  useEffect(() => {
    if (url === null) return;
    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return; // ignore a malformed push rather than crashing the tab
      }
      queryClient.setQueryData<T>(queryKey, (prev) => (merge ? merge(prev, parsed) : (parsed as T)));
    };
    return () => es.close();
    // queryKey is covered via queryKeySerialized above; merge is expected to
    // be referentially stable enough not to need re-subscribing on every
    // render (same convention as passing a queryFn to useQuery).
  }, [url, queryKeySerialized, queryClient]);
}
