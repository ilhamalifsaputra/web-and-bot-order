/**
 * The small "you might like" shelf EmptyState.tsx renders below its card
 * (Task 10 / E4) — a handful of the shop's newest products, for the pages
 * where the honest fix for "empty" is "here's something to buy". One shared
 * react-query cache entry (`queryKey: ["suggestions"]`) for every page that
 * asks, rather than each page minting its own request for the same handful
 * of products: the second, third, ... caller within the 60s staleTime window
 * gets the already-fetched list for free.
 *
 * `enabled` lets a caller skip the request entirely on the (overwhelmingly
 * common) non-empty render — there's no reason to fetch suggestions for a
 * cart that already has items in it. It is never what the empty state's own
 * render waits on: pages call this alongside their own page query, and the
 * shelf simply appears once this one resolves, after the empty-state card
 * has already painted.
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { ShelfPageData } from "../api/types";

export function useSuggestedProducts(enabled: boolean) {
  return useQuery({
    queryKey: ["suggestions"],
    queryFn: () => apiGet<ShelfPageData>("/api/v1/pages/suggestions"),
    enabled,
    staleTime: 60_000,
  });
}
