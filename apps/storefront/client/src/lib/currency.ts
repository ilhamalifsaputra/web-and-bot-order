/**
 * Display-currency preference (Task 5 client — server side shipped in Task 4:
 * POST /api/v1/preferences/currency, GET /api/v1/pages/context's `currency`
 * field). Switching it POSTs to that endpoint, sets the `shop_currency`
 * cookie (+ the signed-in account's own preference) server-side, then
 * invalidates the shared `["context"]` query (Layout.tsx's `useShopContext`)
 * so every consumer — `<Price/>`, the sweep's `formatPriceFor` call sites —
 * picks up the change on its next render: an XHR + re-render, never a full
 * page reload like the language switch (`/lang`).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPost } from "../api/client";

export type DisplayCurrency = "USD" | "IDR";

export function useCurrencySwitch() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (currency: DisplayCurrency) =>
      apiPost<{ currency: DisplayCurrency }>("/api/v1/preferences/currency", { currency }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["context"] }),
  });
  return { setCurrency: mutation.mutate, isPending: mutation.isPending };
}
