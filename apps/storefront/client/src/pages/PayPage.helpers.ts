import type { PayState } from "../api/types";

export const IN_FLIGHT_RANK: Partial<Record<PayState, number>> = { waiting: 0, confirming: 1, processing: 2 };

/** Which state the big card shows: the polled one only when it is a LATER
 * in-flight stage than the one the card already shows (waiting < confirming <
 * processing), or when the poll says the order was closed (an admin cancelled
 * or closed it) while the card still shows an in-flight stage — otherwise a
 * cancelled paid order would keep saying "being processed". Never moves
 * backwards; delivered is left to the redirect and expired to the existing
 * handling. */
export function advanceCardState(current: PayState, polled: PayState | undefined): PayState {
  if (polled === "underpaid") return "underpaid";
  const from = IN_FLIGHT_RANK[current];
  if (from !== undefined && polled === "closed") return "closed";
  const to = polled ? IN_FLIGHT_RANK[polled] : undefined;
  return from !== undefined && to !== undefined && to > from ? (polled as PayState) : current;
}
