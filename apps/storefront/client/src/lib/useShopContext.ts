/**
 * Header context, shared by every page under the shop chrome — moved out of
 * Layout.tsx (Task 5) so a small, currency-only consumer (Price.tsx,
 * FlashBadge.tsx's FlashWasPrice, OrderSummaryCard.tsx) can read `ctx` without
 * pulling in Layout.tsx's own import graph (Navbar/Footer/MobileDrawer/
 * MobileTabBar/SearchOverlay and everything THEY import) — that chain is
 * harmless at runtime (bundlers dedupe it), but it made
 * `tsc -p tsconfig.test.json` type-check MobileDrawer.tsx (reached only for
 * its `import.meta.env.VITE_APP_VERSION` line, which that particular tsconfig
 * has no `vite/client` types for) merely because a `.test.ts` file elsewhere
 * type-imports `FlashInfo` from FlashBadge.tsx.
 *
 * Layout.tsx re-exports this same function so its existing 25+ importers
 * (`import { useShopContext } from "../components/Layout"`) keep working
 * unchanged — this is the one implementation, not a fork.
 *
 * staleTime doesn't poll — it just permits TanStack to refetch on
 * refocus/remount once 30s have passed, so the cart badge (and now the
 * currency preference) catch up across tabs without hammering the API on
 * every render.
 */
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { ShopContext } from "../api/types";

export function useShopContext() {
  return useQuery({
    queryKey: ["context"],
    queryFn: () => apiGet<ShopContext>("/api/v1/pages/context"),
    staleTime: 30_000,
  });
}
