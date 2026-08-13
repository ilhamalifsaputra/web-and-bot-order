/**
 * Amount-based payment matching — shared by the memo-less Binance/Bybit
 * rails (binanceInternal.ts, bybitDeposit.ts, bybitBscDeposit.ts).
 *
 * Task 13 (2026-08-13): extracted out of binanceInternal.ts and converted
 * from IEEE-754 double arithmetic to `Decimal` (`@app/core/money`) end to
 * end. The worst instance of the float risk was the tie-detection in
 * `matchByAmount`: it used exact `===` on doubles produced by
 * `Decimal.toNumber()` to decide whether two candidate orders had the same
 * total. Two DISTINCT decimal totals can collapse onto the identical double
 * (e.g. "4.35" and "4.3499999999999999" both round to the same double), so
 * the old check could see a false tie and refuse a real payment, or (the
 * mirror failure) miss a genuine tie. `binanceInternal.ts` re-exports these
 * so its existing test import path stays valid; both Bybit rails import them
 * from here directly.
 */
import { Decimal } from "@app/core/money";

// Internal transfers are exact off-chain ledger moves (no on-chain
// slippage/fees) — the only error source is Number() float parsing of a
// decimal string, far smaller than this. Tight on purpose: it lets the M-9
// unique-cents offset (see computeUniqueCents) shrink to a much smaller
// surcharge while still disambiguating same-amount orders.
export const AMOUNT_TOLERANCE = 0.001; // USDT

// ── M-14 (backend audit 2026-07-31) overpayment cap ─────────────────────────
// matchByAmount's best-fit selection (see below) has NO ambiguity-guard
// protection left once only one pending order exists — the everyday state for
// a small shop overnight. Without a ceiling, ANY incoming amount (a stray
// transfer, an owner's own unrelated top-up to the same UID/address, a late
// payment for an already-expired order) would auto-match and auto-deliver
// that single order, silently absorbing the difference with no flag. The cap
// below draws the line between "this order, overpaid" (still auto-match) and
// "unrelated money that happens to be enough to cover this order" (falls
// through to unmatched for manual review, same as today).
//
// Chosen so ordinary "buyer rounds up" behavior still passes: a small fixed
// allowance covers trivial rounding on cheap orders (e.g. paying 7 for a
// 5.004 total), while a percentage covers proportionally larger — but still
// plausible — rounding on pricier orders (e.g. paying 600 for a 500 total).
// Whichever is larger wins, so cheap orders aren't over-strict and expensive
// orders aren't trivially bypassed by a flat dollar figure.
const OVERPAYMENT_CAP_FIXED = 2; // USDT
const OVERPAYMENT_CAP_PERCENT = 0.2; // 20% of the order's total

export function overpaymentCap(total: Decimal): Decimal {
  return Decimal.max(OVERPAYMENT_CAP_FIXED, total.times(OVERPAYMENT_CAP_PERCENT));
}

// ── M-14 underpaid floor ─────────────────────────────────────────────────
// matchUnderpaidByAmount (below) has no memo to confirm which order a short
// deposit was meant for — amount alone is the only signal. Without a floor,
// a tiny, wholly unrelated stray deposit (dust, a test transfer, a few cents)
// against the sole pending order would flip it PENDING_PAYMENT -> UNDERPAID,
// which removes it from the matcher's own pending pool — so when the buyer's
// REAL, full payment arrives minutes later it finds no candidate and is
// itself recorded unmatched, orphaning a genuine payment because of an
// unrelated stray deposit. Requiring the deposit to be at least half of what
// was expected keeps "buyer genuinely paid less than they owe" flaggable
// while refusing to attribute obviously-unrelated small amounts to a
// pending order at all (those still fall through to plain "unmatched").
const UNDERPAID_FLOOR_PERCENT = 0.5; // at least 50% of the order's total

// ---------------------------------------------------------------------------
// Matching (pure — unit-tested)
// ---------------------------------------------------------------------------

/** Note equality: case-insensitive, trimmed. */
export function noteMatches(tx: { note: string }, order: { paymentRef: string | null }): boolean {
  if (!order.paymentRef) return false;
  return tx.note.trim().toLowerCase() === order.paymentRef.trim().toLowerCase();
}

/**
 * Classify a transfer against an order:
 *  - "match": note matches AND received >= expected - tolerance (exact, within
 *    tolerance, or overpaid → deliver).
 *  - "underpaid": note matches but received is short beyond tolerance.
 *  - "none": note doesn't match.
 * (The task's rule is |received-expected| <= tolerance for a match; we also
 * deliver on overpayment, since refusing a buyer who paid more is worse.)
 */
export function classifyTx(
  tx: { note: string; amount: Decimal.Value },
  order: { paymentRef: string | null; totalAmount: Decimal.Value },
  tolerance = AMOUNT_TOLERANCE,
): "match" | "underpaid" | "none" {
  if (!noteMatches(tx, order)) return "none";
  const expected = new Decimal(order.totalAmount);
  const received = new Decimal(tx.amount);
  if (received.minus(expected).gte(-tolerance)) return "match";
  return "underpaid";
}

/**
 * Amount fallback for when the note is missing/garbled (the live probe showed
 * `/sapi/v1/pay/transactions` returns an empty `note` for C2C transfers, so we
 * cannot rely on the memo alone).
 *
 * BEST FIT, not "any candidate below the amount": M-14 (backend audit
 * 2026-07-31) fixed an earlier version of this function that rejected any
 * overpayment outright (a buyer rounding up matched nothing). The first
 * attempt at that fix made EVERY order priced at or below the received
 * amount a "candidate" and refused whenever ≥2 qualified — but with
 * unique-cents enabled (every order's total distinct by design, see
 * computeUniqueCents), a payment for any order except the cheapest pending
 * one would also clear every cheaper order's threshold and get refused as
 * "ambiguous", which defeats the entire point of unique-cents disambiguation.
 *
 * Correct approach: among orders whose total the payment covers (within
 * `tolerance`), pick the one with the LARGEST total — the closest match to
 * what was actually paid. Only refuse when ≥2 candidates TIE at that same
 * largest qualifying total (which is essentially never, since unique-cents
 * makes totals distinct) — a real ambiguity safeguard again, not one that
 * fires on every multi-order state.
 *
 * Overpayment is still accepted (not rejected outright) but is now CAPPED
 * (`overpaymentCap`): once the best-fit candidate is chosen, an amount that
 * exceeds its total by more than the cap is treated as unrelated money, not
 * this order overpaid, and the whole call refuses (falls through to
 * "unmatched") rather than auto-delivering on a guess — see the cap's own
 * doc-comment above for why an unbounded ceiling is unsafe with just one
 * pending order.
 *
 * Returns the sole in-range, uncapped, untied candidate or null. A tx that's
 * short of EVERY candidate beyond tolerance yields no hits here — see
 * `matchUnderpaidByAmount` for the mirrored short-side search memo-less rails
 * use to flag underpaid instead of silently leaving it unmatched.
 */
export function matchByAmount<T extends { totalAmount: Decimal.Value }>(
  tx: { amount: Decimal.Value },
  orders: readonly T[],
  tolerance = AMOUNT_TOLERANCE,
): T | null {
  const received = new Decimal(tx.amount);
  const candidates = orders
    .map((order) => ({ order, total: new Decimal(order.totalAmount) }))
    .filter(({ total }) => total.minus(received).lte(tolerance));
  if (candidates.length === 0) return null;

  const maxTotal = Decimal.max(...candidates.map((c) => c.total));
  const atMax = candidates.filter((c) => c.total.equals(maxTotal));
  if (atMax.length !== 1) return null; // tie at the best-fit total — genuinely ambiguous

  const best = atMax[0]!;
  if (received.minus(best.total).gt(overpaymentCap(best.total))) return null; // too different — likely unrelated money

  return best.order;
}

/**
 * Mirror of `matchByAmount` for the short side, used by the memo-less Bybit
 * rails (Internal Transfer, BSC) once `matchByAmount` itself finds no clean
 * match: a transfer maps to a "genuinely short" candidate ONLY when exactly
 * one pending order both (a) exceeds the received amount by MORE than
 * `tolerance` (a plain float-noise short-fall already matched above and never
 * reaches this function) and (b) the received amount is still at least
 * `UNDERPAID_FLOOR_PERCENT` of that order's total — a floor, not just an
 * upper bound, so a wholly unrelated tiny stray deposit against a large
 * pending order never gets attributed to it (see the floor's own
 * doc-comment above for why: flipping an order to UNDERPAID removes it from
 * the matcher's own pending pool, which would orphan the buyer's real
 * payment when it lands later). Same ambiguity guard as `matchByAmount` — ≥2
 * qualifying candidates refuses rather than guessing which order the buyer
 * meant to pay. Returns the sole candidate or null; the caller routes a hit
 * to that rail's `markUnderpaid` equivalent instead of recording the deposit
 * as unmatched.
 */
export function matchUnderpaidByAmount<T extends { totalAmount: Decimal.Value }>(
  tx: { amount: Decimal.Value },
  orders: readonly T[],
  tolerance = AMOUNT_TOLERANCE,
): T | null {
  const received = new Decimal(tx.amount);
  const hits = orders.filter((o) => {
    const total = new Decimal(o.totalAmount);
    const shortfall = total.minus(received);
    return shortfall.gt(tolerance) && received.gte(total.times(UNDERPAID_FLOOR_PERCENT));
  });
  return hits.length === 1 ? hits[0]! : null;
}
