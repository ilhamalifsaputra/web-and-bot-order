import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

/** One recorded provider payout batch (GET /api/settlements, task F1).
 *  Every amount is the Decimal string the server sent — formatted for display
 *  by `formatCurrencyDisplay`, never re-computed here. */
export interface SettlementRow {
  id: number;
  /** `PaymentMethod` value — which gateway paid this batch out. */
  provider: string;
  /** The provider's own statement/payout id, or null when it gave none. */
  batchReference: string | null;
  /** Pre-formatted in the shop's TIMEZONE by the server, so the browser never
   *  renders a UTC date in its own zone. */
  settlementDateDisplay: string | null;
  currency: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  status: string;
  lineCount: number;
  matchedLineCount: number;
  /** Null when the batch was recorded but never posted to the double-entry
   *  ledger — the one state on this page that needs acting on. */
  postingId: number | null;
  recordedAtDisplay: string | null;
  recordedBy: number;
}

export interface SettlementsResponse {
  settlements: SettlementRow[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  /** Providers that actually have a batch recorded, so the filter cannot offer
   *  one that would always come back empty. */
  providers: string[];
  /** The currencies a batch may be recorded in — the chart of accounts' own
   *  list, so the form's dropdown cannot drift from what the server accepts. */
  currencies: string[];
}

export function useSettlements(params: { page?: number; provider?: string; currency?: string }) {
  const search = new URLSearchParams();
  if (params.page && params.page > 1) search.set("page", String(params.page));
  if (params.provider) search.set("provider", params.provider);
  if (params.currency) search.set("currency", params.currency);

  return useQuery<SettlementsResponse>({
    queryKey: ["settlements", params],
    queryFn: () => apiGet<SettlementsResponse>(`/api/settlements?${search}`),
  });
}
