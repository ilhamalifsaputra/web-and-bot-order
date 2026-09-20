/**
 * Live USD→IDR market rate (closes plan.md §15.8's "auto-update FX" question):
 * the `usd_idr_rate` setting now tracks the REAL market rate, rounded to a
 * clean step (default Rp100) so buyers see tidy numbers.
 *
 * Source: open.er-api.com — free, keyless, refreshed daily. One source is
 * enough here: a fetch failure simply keeps the previously saved rate (every
 * USDT order snapshots its own fxRate, so a slightly stale rate is harmless),
 * and the admin can still type a rate by hand with auto-update turned off.
 */
import { Decimal } from "./money";

export const FX_SOURCE_URL = "https://open.er-api.com/v6/latest/USD";

/** Fetch the current market Rupiah-per-USD rate. Throws on any failure. */
export async function fetchUsdIdrMarketRate(fetchImpl: typeof fetch = fetch): Promise<Decimal> {
  const res = await fetchImpl(FX_SOURCE_URL);
  if (!res.ok) throw new Error(`FX source answered HTTP ${res.status}`);
  const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
  const idr = data?.rates?.IDR;
  if (data?.result !== "success" || typeof idr !== "number" || !Number.isFinite(idr) || idr <= 0) {
    throw new Error("FX source returned no usable IDR rate");
  }
  return new Decimal(idr);
}

/**
 * Round a rate to the nearest multiple of `step` rupiah:
 * 16243.7 @ step 100 → 16200; 16250 @ step 100 → 16300 (half-up).
 * A missing/zero/invalid step returns the rate unrounded.
 */
export function roundRateToStep(rate: Decimal, step: Decimal.Value): Decimal {
  let s: Decimal;
  try {
    s = new Decimal(step);
  } catch {
    return rate;
  }
  if (!s.isFinite() || s.lessThanOrEqualTo(0)) return rate;
  return rate.dividedBy(s).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(s);
}

/**
 * Why a candidate USD→IDR rate must not be trusted (M13 / audit P0-3).
 *
 * Discriminated on `reason`, and every variant carries the figure it actually
 * failed against — same shape as `RailMinimumFailure` in
 * packages/db/src/crud/orderMinimums.ts, and for the same reason: the caller
 * has to be able to log, and DM an admin, WHICH check failed and by how much.
 * "The rate was rejected" tells whoever reads that DM nothing they can act on;
 * "17500 is 8.02% away from the saved 16200, past the 5% cap" tells them
 * whether to trust the source or widen the cap.
 */
export type FxRateRejection =
  /** Not a usable number at all — NaN or ±Infinity. */
  | { reason: "not_a_number" }
  /** Zero or negative. Dividing a Rupiah total by this cannot produce a price. */
  | { reason: "not_positive" }
  | { reason: "below_min"; min: Decimal }
  | { reason: "above_max"; max: Decimal }
  | {
      reason: "delta_too_large";
      /** The figure whose move was measured — see `deltaOf` below. */
      subject: Decimal;
      lastKnown: Decimal;
      deltaPct: Decimal;
      maxDeltaPct: Decimal;
    };

/**
 * The configured sanity band. Each field is null when its own setting is
 * absent, blank or unusable, which means "this check is not configured" and
 * never "reject everything" — the same free-text-setting convention
 * `parseMinAmount` and `fx_quote_ttl_minutes` already follow in this repo. A
 * typo in an admin field must not become a shop-wide pricing outage.
 */
export interface FxRateBounds {
  /** Lowest plausible Rupiah-per-USDT figure. */
  min: Decimal | null;
  /** Highest plausible Rupiah-per-USDT figure. */
  max: Decimal | null;
  /** Largest tolerated move away from `lastKnown`, in percent. */
  maxDeltaPct: Decimal | null;
}

/**
 * Is this rate safe to price orders off? Returns the specific reason it is
 * not, or null when it is. A plain validator, deliberately NOT a throwing
 * guard: its caller (`refreshUsdIdrRate`) needs to keep the previously saved
 * rate in effect, count the failure and alert an admin, none of which it could
 * do from inside a catch block without reconstructing the reason from an error
 * message.
 *
 * `lastKnown` null means nothing has ever been saved (a first-ever fetch), so
 * the deviation check is skipped — there is no figure to deviate from, and
 * refusing the very first rate a shop ever fetches would leave it with no rate
 * at all. The band still applies in that case, which is what actually catches
 * a source returning the wrong unit on day one.
 *
 * The band is INCLUSIVE at both ends: `min`/`max` are documented as sanity
 * bounds, not a precise market range, so a rate landing exactly on one is
 * inside the range an admin typed, not outside it.
 *
 * `deltaOf` separates the two questions this function answers. `rate` is the
 * figure that would be SAVED, and the band judges that — a spread big enough to
 * push the saved rate out of the plausible range has to be caught. The
 * DEVIATION check is a different question ("did the market move further than one
 * refresh is allowed to move it?"), so its subject can be a different figure:
 * `refreshUsdIdrRate` passes the raw market rate, measured against the last
 * market rate, because comparing a post-spread figure against a pre-spread
 * reference measures the spread instead of the market — see
 * `FX_RATE_MAX_DELTA_PCT_KEY` (crud/pricing.ts) for what that cost.
 * Defaults to `rate`, which is the same single-figure behaviour this function
 * always had.
 */
export function validateUsdIdrRate(
  rate: Decimal,
  lastKnown: Decimal | null,
  bounds: FxRateBounds,
  deltaOf: Decimal = rate,
): FxRateRejection | null {
  if (!rate.isFinite()) return { reason: "not_a_number" };
  if (rate.lessThanOrEqualTo(0)) return { reason: "not_positive" };

  const { min, max, maxDeltaPct } = bounds;
  if (min && min.isFinite() && min.greaterThan(0) && rate.lessThan(min)) {
    return { reason: "below_min", min };
  }
  if (max && max.isFinite() && max.greaterThan(0) && rate.greaterThan(max)) {
    return { reason: "above_max", max };
  }

  if (
    lastKnown &&
    lastKnown.isFinite() &&
    lastKnown.greaterThan(0) &&
    maxDeltaPct &&
    maxDeltaPct.isFinite() &&
    maxDeltaPct.greaterThan(0)
  ) {
    const deltaPct = deltaOf.minus(lastKnown).abs().dividedBy(lastKnown).times(100);
    if (deltaPct.greaterThan(maxDeltaPct)) {
      return { reason: "delta_too_large", subject: deltaOf, lastKnown, deltaPct, maxDeltaPct };
    }
  }

  return null;
}

/**
 * Apply a protective spread of `bps` basis points to a market rate:
 * `rate × (1 − bps/10000)`.
 *
 * On the SIGN, because it reads backwards at first glance. `rate` is Rupiah
 * per USDT and every USDT figure in this system is `idr / rate`
 * (`usdtFromIdr`), so LOWERING the rate RAISES the USDT a buyer sends for the
 * same Rupiah list price. That is the protective direction: the shop
 * over-collects crypto slightly relative to spot, which is what cushions the
 * conversion/withdrawal loss it takes turning that USDT back into Rupiah. A
 * spread that raised the rate would under-collect and hand the buyer the
 * shop's fx risk.
 *
 * Defaults to a no-op: a blank, zero, negative or unparseable `bps` returns
 * the rate untouched, same free-text-setting convention as `roundRateToStep`'s
 * own invalid-step handling. So does a `bps` of 10000 or more, which would
 * zero or invert the rate — a mistyped spread must not silently make every
 * USDT total infinite.
 */
export function applyUsdtSpread(rate: Decimal, bps: Decimal.Value): Decimal {
  let b: Decimal;
  try {
    b = new Decimal(String(bps).trim() === "" ? "0" : bps);
  } catch {
    return rate;
  }
  if (!b.isFinite() || b.lessThanOrEqualTo(0) || b.greaterThanOrEqualTo(10000)) return rate;
  return rate.times(new Decimal(1).minus(b.dividedBy(10000)));
}
