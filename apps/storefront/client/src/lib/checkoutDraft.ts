/**
 * Checkout answers kept across a forced login (H2, UI-states audit).
 *
 * A signed-in buyer whose session ends mid-checkout is sent to /login and
 * comes back to /checkout on a full page load, which would otherwise lose the
 * info-step answers they typed. The draft holds only what the buyer typed into
 * this checkout (the info-step answers and the voucher code) — never a
 * password, token or session value — and lives in sessionStorage, so it stays
 * in this one tab and dies with it. It is keyed to the cart lines it was typed
 * for, so a changed cart never receives answers meant for something else, and
 * it is cleared once read back.
 *
 * Every storage failure is swallowed (private browsing, quota, blocked
 * storage): losing the draft is the old behaviour, never worth breaking
 * checkout over.
 */
const KEY = "storefront.checkout_draft";

export interface CheckoutDraft {
  /** The cart lines the answers were typed for (see CheckoutPage's form key). */
  lines: string;
  answers: Array<Record<string, string>>;
  voucher: string;
}

export function saveCheckoutDraft(draft: CheckoutDraft): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // see file header comment
  }
}

/** The saved draft for exactly these cart lines, or null. */
export function readCheckoutDraft(lines: string): CheckoutDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { lines: savedLines, answers, voucher } = parsed as Partial<CheckoutDraft>;
    if (savedLines !== lines || !Array.isArray(answers) || typeof voucher !== "string") return null;
    const clean = answers.map((unit) => {
      const out: Record<string, string> = {};
      if (typeof unit === "object" && unit !== null) {
        for (const [k, v] of Object.entries(unit as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
      }
      return out;
    });
    return { lines, answers: clean, voucher };
  } catch {
    // see file header comment
    return null;
  }
}

export function clearCheckoutDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // see file header comment
  }
}
