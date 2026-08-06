/**
 * Handoff of "this order's code was emailed to <address>" across the full page
 * load that ends a guest checkout.
 *
 * WHY IT EXISTS: `POST /api/v1/checkout` answers a guest with
 * `email_sent: boolean`, but CheckoutPage cannot show anything about it — a
 * successful guest checkout leaves the SPA via `window.location.assign`, so
 * the whole app (account menu, cart ownership, CSRF meta) re-renders for the
 * new session. Anything CheckoutPage rendered after the mutation resolved
 * would be torn down before a buyer could read it. The notice therefore
 * belongs on the destination, PayPage, next to the very code that was mailed —
 * and this module is how the one fact PayPage cannot fetch gets there.
 *
 * WHY sessionStorage AND NOT THE URL: the payload is the buyer's email
 * address. A query parameter would put it in the server's access log, in the
 * `Referer` of every asset the pay page loads, in browser history, and in any
 * link the buyer pastes to someone else. sessionStorage is scoped to the one
 * tab and survives exactly the same-tab navigation we need, and no further:
 * close the tab and the address is gone.
 *
 * WHY IT IS KEYED BY ORDER CODE: opening a different order in the same tab
 * must not inherit a notice written about another one.
 *
 * WHY THE READ DOES NOT CONSUME IT: "your code is in your inbox" is a durable
 * fact about the order, not a one-shot toast, so refreshing the pay page
 * should still say it. A consuming read would also be wrong mechanically —
 * React StrictMode double-invokes render-phase initializers in development,
 * so the second invocation would find the entry already gone.
 *
 * Every storage failure is swallowed (private browsing, quota, an extension
 * that blocks storage): this is a courtesy line, never worth breaking a page
 * the buyer is about to pay from.
 */
const KEY = "storefront.order_code_emailed";

export function rememberCodeEmailed(orderCode: string, email: string): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ code: orderCode, email }));
  } catch {
    // see file header comment
  }
}

/** The address this order's code was mailed to, or null if it was not (or if
 * we cannot tell — an unreadable or unrelated entry is never a promise). */
export function readCodeEmailed(orderCode: string): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { code, email } = parsed as { code?: unknown; email?: unknown };
    if (code !== orderCode || typeof email !== "string" || !email) return null;
    return email;
  } catch {
    // see file header comment
    return null;
  }
}
