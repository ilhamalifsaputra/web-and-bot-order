/**
 * The server's price for one plan at the quantity the buyer has typed
 * (GET /api/v1/pricing/quote). The figures are the volume-tier engine's — the
 * same one checkout charges with — and this hook never computes a price.
 *
 * Rapid quantity changes are safe by construction:
 *   - the request waits until the quantity has been still for
 *     QUOTE_DEBOUNCE_MS, so typing "12" asks once, not for 1 and then 12;
 *   - each quantity is its own query key, so React Query aborts the request
 *     for a key nobody watches any more (apiGet honours the signal) and only
 *     ever hands back the answer for the CURRENT key — last request wins;
 *   - a quote is returned only when it is for exactly the plan and quantity on
 *     screen. While the quantity is settling (or its answer is in flight) the
 *     caller gets `quote: null, pending: true` and shows a placeholder — never
 *     the previous quantity's price under the new quantity.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import type { LineQuote } from "../api/types";

export const QUOTE_DEBOUNCE_MS = 250;

/** `value`, once it has stopped changing for `delayMs`. */
function useSettledValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export interface LineQuoteState {
  /** The server's quote for exactly (denominationId, qty), or null. */
  quote: LineQuote | null;
  /** A quote for the current quantity is still on its way. */
  pending: boolean;
  /** The server refused or failed to price the current quantity. */
  failed: boolean;
}

export function useLineQuote(args: {
  denominationId: number | null;
  qty: number;
  enabled: boolean;
  /** Anything else that changes the price (currency, language, reseller session). */
  pricingContext: readonly unknown[];
}): LineQuoteState {
  const { denominationId, qty, enabled, pricingContext } = args;
  const settledQty = useSettledValue(qty, QUOTE_DEBOUNCE_MS);
  const active = enabled && denominationId !== null && Number.isInteger(qty) && qty >= 1;
  const query = useQuery({
    queryKey: ["line-quote", denominationId, settledQty, ...pricingContext],
    queryFn: ({ signal }) =>
      apiGet<LineQuote>(`/api/v1/pricing/quote?denomination_id=${denominationId}&qty=${settledQty}`, { signal }),
    enabled: active && settledQty === qty,
    retry: false,
    staleTime: 30_000,
  });
  if (!active) return { quote: null, pending: false, failed: false };
  const data = query.data;
  const quote = data && data.denomination_id === denominationId && data.quantity === qty ? data : null;
  const failed = settledQty === qty && query.isError;
  return { quote, pending: quote === null && !failed, failed };
}
