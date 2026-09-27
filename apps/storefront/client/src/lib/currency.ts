/**
 * Display-currency preference (Task 5 client — server side shipped in Task 4:
 * POST /api/v1/preferences/currency, GET /api/v1/pages/context's `currency`
 * field). Switching it POSTs to that endpoint, sets the `shop_currency`
 * cookie (+ the signed-in account's own preference) server-side, then
 * invalidates the shared `["context"]` query (Layout.tsx's `useShopContext`)
 * so every consumer — `<Price/>`, the sweep's `formatPriceFor` call sites —
 * picks up the change on its next render: an XHR + re-render, never a full
 * page reload like the language switch (`/lang`).
 *
 * Never optimistic: the displayed currency only changes once the refetched
 * context says so, so a failed POST leaves every price exactly as it was.
 * `onError` lets the caller surface that failure (CurrencyToggle shows an
 * error Toast) instead of the switch silently doing nothing.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPost } from "../api/client";

export type DisplayCurrency = "USD" | "IDR";

export function useCurrencySwitch(options: { onError?: (err: unknown) => void } = {}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (currency: DisplayCurrency) =>
      apiPost<{ currency: DisplayCurrency }>("/api/v1/preferences/currency", { currency }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["context"] }),
    onError: (err) => options.onError?.(err),
  });
  return { setCurrency: mutation.mutate, isPending: mutation.isPending };
}
