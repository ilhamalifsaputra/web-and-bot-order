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
