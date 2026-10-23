/**
 * Storefront wording of volume ("bulk") tier pricing — JSON shapes only.
 *
 * Every figure here is a field of the ONE engine every order path prices with
 * (`priceLineWithTiers` / `quoteBulkForLines`, @app/db crud/bulkTiers.ts): this
 * module never does price arithmetic of its own beyond expressing an engine
 * result as a percentage for a badge. The client renders these strings and
 * never recomputes a price, so a product page, a cart line and the checkout
 * summary cannot quote three different figures.
 */
import type { PricingTier, TierDiscountType } from "@app/core/bulk";
import type { PricedDenomination } from "@app/core/flash";
import { Decimal } from "@app/core/money";
import { legacyViewOfTiers, priceLineWithTiers, type PricedLineWithTiers } from "@app/db";

/** One tier as the client sees it. */
export interface TierRuleView {
  min_quantity: number;
  discount_type: TierDiscountType;
  /** Percent (PERCENTAGE) or IDR amount (the two fixed types), as a Decimal string. */
  discount_value: string;
}

/** One rung of the product page's tier ladder: the unit price from `min_quantity` up. */
export interface TierLadderStep extends TierRuleView {
  /** The engine's final unit price at exactly `min_quantity` units (display only). */
  unit_price: string;
}

/** One priced line: what a buyer pays per unit and in total at `quantity`. */
export interface LinePricingView {
  quantity: number;
  /** The unit before tiers (reseller/flash already applied). */
  base_unit_price: string;
  /** `final_subtotal / quantity` — display only. */
  final_unit_price: string;
  original_subtotal: string;
  final_subtotal: string;
  /** The tier discount on this line (0 when none applies). */
  savings: string;
  /** The tier that took money off this line, or null. */
  applied_tier: TierRuleView | null;
}

export function tierRuleView(tier: PricingTier): TierRuleView {
  return {
    min_quantity: tier.minQuantity,
    discount_type: tier.discountType,
    discount_value: new Decimal(tier.discountValue).toString(),
  };
}

/** An engine result as JSON. A tier that matched but took nothing off (a fixed price above the unit) is not "applied". */
export function linePricingView(priced: PricedLineWithTiers): LinePricingView {
  const applies = priced.appliedTier !== null && priced.totalDiscount.greaterThan(0);
  return {
    quantity: priced.quantity,
    base_unit_price: priced.baseUnitPrice.toString(),
    final_unit_price: priced.finalUnitPrice.toString(),
    original_subtotal: priced.originalSubtotal.toString(),
    final_subtotal: priced.finalSubtotal.toString(),
    savings: priced.totalDiscount.toString(),
    applied_tier: applies ? tierRuleView(priced.appliedTier!) : null,
  };
}

function enabledAscending(tiers: readonly PricingTier[]): PricingTier[] {
  return tiers.filter((t) => t.isEnabled).sort((a, b) => a.minQuantity - b.minQuantity);
}

/**
 * The ladder the product page shows: each enabled tier with the unit price the
 * engine charges at its threshold. A rung that would not lower the unit price
 * (a fixed price at or above the buyer's effective unit — the engine never
 * raises a price) is left out, so the ladder never advertises a "deal" that
 * costs the same.
 */
export function tierLadder(
  denomination: PricedDenomination,
  tiers: readonly PricingTier[],
  isReseller: boolean,
  now: Date,
): TierLadderStep[] {
  const steps: TierLadderStep[] = [];
  for (const tier of enabledAscending(tiers)) {
    const priced = priceLineWithTiers({ denomination, quantity: tier.minQuantity, isReseller, now, tiers });
    if (!priced.totalDiscount.greaterThan(0)) continue;
    steps.push({ ...tierRuleView(tier), unit_price: priced.finalUnitPrice.toString() });
  }
  return steps;
}

/** The single best saving a denomination's tiers offer, as a badge states it. */
export interface TierBadge {
  /** Percent off as a Decimal string (exact for a percent tier, whole and rounded down otherwise). */
  percent: Decimal;
  minQuantity: number;
  /** True when the percent was derived from a fixed-amount tier — the badge says "up to". */
  upTo: boolean;
}

/**
 * The best saving across `tiers`, expressed truthfully:
 *   - a PERCENTAGE tier is its own percent;
 *   - a fixed-amount or fixed-price tier is the share it takes off the buyer's
 *     effective unit at its threshold (engine-priced), rounded DOWN to a whole
 *     percent so a badge never claims more than checkout gives — and flagged
 *     `upTo`, since the rupiah amount is what is fixed, not the percent.
 * Null when no tier saves anything.
 */
export function bestTierBadge(
  denomination: PricedDenomination,
  tiers: readonly PricingTier[],
  isReseller: boolean,
  now: Date,
): TierBadge | null {
  let best: TierBadge | null = null;
  for (const tier of enabledAscending(tiers)) {
    let candidate: TierBadge | null = null;
    if (tier.discountType === "PERCENTAGE") {
      candidate = { percent: new Decimal(tier.discountValue), minQuantity: tier.minQuantity, upTo: false };
    } else {
      const priced = priceLineWithTiers({ denomination, quantity: tier.minQuantity, isReseller, now, tiers: [tier] });
      if (priced.originalSubtotal.greaterThan(0)) {
        const percent = priced.totalDiscount.times(100).div(priced.originalSubtotal).toDecimalPlaces(0, Decimal.ROUND_DOWN);
        if (percent.greaterThan(0)) candidate = { percent, minQuantity: tier.minQuantity, upTo: true };
      }
    }
    if (candidate && candidate.percent.greaterThan(0) && (best === null || candidate.percent.greaterThan(best.percent))) {
      best = candidate;
    }
  }
  return best;
}

/** The legacy `bulk` field ({min_quantity, discount_percent}) derived from the tiers, for older clients. */
export function legacyBulkView(tiers: readonly PricingTier[]): { min_quantity: number; discount_percent: string } | null {
  const view = legacyViewOfTiers(true, tiers);
  return view ? { min_quantity: view.minQuantity, discount_percent: view.discountPercent.toString() } : null;
}
