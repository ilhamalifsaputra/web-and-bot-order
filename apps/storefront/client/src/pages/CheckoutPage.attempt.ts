/**
 * What a place-order attempt left behind (H1/H2, UI-states audit), kept out of
 * CheckoutPage so the page reads as layout.
 */
import { useState } from "react";
import { orderFailureOutcome } from "../api/idempotency";
import type { CheckoutData } from "../api/types";

/**
 * What the last attempt says about whether the order exists.
 *  - "unknown": no response, 5xx, still in progress — the order may exist.
 *  - "probablyPlaced": after an unknown attempt the cart came back empty,
 *    which is what a placed order leaves behind.
 *  - "none": the outcome is known.
 * Anything but "none" freezes the form (review I2): no input may change the
 * request and only the same-key Try again may send it.
 */
export type OrderHold = "none" | "unknown" | "probablyPlaced";

export function nextOrderHold(current: OrderHold, err: unknown): OrderHold {
  const outcome = orderFailureOutcome(err);
  if (outcome === "unanswered") return "unknown";
  if (outcome === "inconclusive") return current;
  const message = err instanceof Error ? err.message : "";
  if (current !== "none" && message === "error.cart_empty") return "probablyPlaced";
  return "none";
}

/** Whether this page was rendered for a real signed-in account (an absent
 * `signed_in`, from an older server, keeps the previous reading). */
export function renderedSignedIn(page: CheckoutData): boolean {
  return !page.is_guest && page.signed_in !== false;
}

/**
 * H2: the server took its guest branch for a page rendered signed-in — the only
 * way such a page can earn `web.guest_email_invalid`, since it has no email
 * field. The session ended under it.
 */
export function isSessionEndedRefusal(page: CheckoutData, err: unknown): boolean {
  return renderedSignedIn(page) && err instanceof Error && err.message === "web.guest_email_invalid";
}

/**
 * Remembers which read was on screen when the session ended, and calls
 * `onSignedInAgain` once a LATER read answers for a signed-in account (the
 * buyer logged in again in another tab). Returns the function that marks it.
 */
export function useSessionEndedUntilSignedIn(liveSignedIn: boolean, dataUpdatedAt: number, onSignedInAgain: () => void): () => void {
  const [seenAt, setSeenAt] = useState<number | null>(null);
  if (seenAt !== null && liveSignedIn && dataUpdatedAt !== seenAt) {
    setSeenAt(null);
    onSignedInAgain();
  }
  return () => setSeenAt(dataUpdatedAt);
}
