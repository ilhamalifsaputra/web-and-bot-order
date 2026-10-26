/**
 * Volume-tier lines on the denomination detail bubble.
 *
 * The bubble is priced for the quantity the buyer has selected, by the one
 * engine every order path uses (`priceLineWithTiers`, @app/db crud/bulkTiers):
 * the caller hands in the already-priced line, this module only words it.
 * Nothing here computes money of its own; every amount shown is a field of the
 * engine's result, formatted through the buyer's language-aware formatter.
 *
 * Wording follows the product family (AGENTS.md): Game Top Up says
 * "top-ups", Premium Apps (every non-GAME_TOPUP group) say "plans".
 */
import type { PricingTier } from "@app/core/bulk";
import { Decimal } from "@app/core/money";
import type { PricedLineWithTiers } from "@app/db";
import type { UserPriceFormatter } from "./format";

export type Translate = (key: string, args?: Record<string, string | number>) => string;

/** True when the engine actually took money off this line. */
export function tierDiscountApplies(priced: PricedLineWithTiers): boolean {
  return priced.appliedTier !== null && priced.totalDiscount.greaterThan(0);
}

/** "20% off" / "Rp1,000 off each" / "Rp6,000 each" for one tier, as priced at `unitAtTier`. */
function discountText(tier: PricingTier, unitAtTier: Decimal, prices: UserPriceFormatter, tr: Translate): string {
  const value = new Decimal(tier.discountValue);
  if (tier.discountType === "PERCENTAGE") return tr("browse.tier_discount_percent", { percent: value.toString() });
  if (tier.discountType === "FIXED_AMOUNT_OFF_PER_UNIT") return tr("browse.tier_discount_amount", { amount: prices.price(value) });
  return tr("browse.tier_discount_fixed", { price: prices.price(unitAtTier) });
}

export interface TierSections {
  /** Quantity, active tier, savings and total — shown when qty > 1 or a tier applies, else "". */
  summary: string;
  /** `summary` without the savings line (what the caption keeps when space runs out). */
  summaryCompact: string;
  /** The next threshold above the current qty that is cheaper per unit, or "". */
  nextTier: string;
}

/**
 * The tier sections for the detail bubble. `priceAt` re-prices the same SKU at
 * another quantity through the engine (used for the next-tier hint), and
 * `maxQty` is the most this buyer can order right now: a threshold above it is
 * never advertised.
 */
export function tierSections(args: {
  priced: PricedLineWithTiers;
  tiers: readonly PricingTier[];
  isGame: boolean;
  maxQty: number;
  prices: UserPriceFormatter;
  tr: Translate;
  priceAt: (quantity: number) => PricedLineWithTiers;
}): TierSections {
  const { priced, tiers, isGame, maxQty, prices, tr } = args;
  const applies = tierDiscountApplies(priced);
  const head: string[] = [];
  let savings = "";
  let total = "";
  if (priced.quantity > 1 || applies) {
    head.push(tr("browse.tier_quantity", { qty: priced.quantity }));
    if (applies) {
      const tier = priced.appliedTier!;
      head.push(
        tr(isGame ? "browse.tier_active_game" : "browse.tier_active_plan", {
          min_qty: tier.minQuantity,
          discount: discountText(tier, priced.finalUnitPrice, prices, tr),
        }),
      );
      savings = tr("browse.tier_savings", { amount: prices.price(priced.totalDiscount) });
    }
    total = tr("browse.tier_total", { total: prices.price(priced.finalSubtotal) });
  }
  const summary = [...head, savings, total].filter(Boolean).join("\n");
  const summaryCompact = [...head, total].filter(Boolean).join("\n");

  let nextTier = "";
  const upcoming = [...tiers]
    .filter((t) => t.isEnabled && t.minQuantity > priced.quantity && t.minQuantity <= maxQty)
    .sort((a, b) => a.minQuantity - b.minQuantity);
  for (const t of upcoming) {
    const atThreshold = args.priceAt(t.minQuantity);
    if (atThreshold.finalUnitPrice.lessThan(priced.finalUnitPrice)) {
      nextTier = tr(isGame ? "browse.tier_next_game" : "browse.tier_next_plan", {
        min_qty: t.minQuantity,
        price: prices.price(atThreshold.finalUnitPrice),
      });
      break;
    }
  }
  return { summary, summaryCompact, nextTier };
}

/** One optional block of the detail bubble, with how it may give way to the caption limit. */
export interface CaptionSection {
  text: string;
  /** Lower drops first; undefined never drops. */
  dropRank?: number;
  /**
   * The shorter form this section gives way to (given the characters left for
   * it), or null to drop it outright. A shrunk section is kept as returned.
   */
  shrink?: (budget: number) => string | null;
}

/**
 * Join `sections` with blank lines and, when the result is longer than
 * `limit`, give way in a fixed order: each droppable section by ascending
 * `dropRank` — shrunk when it can be, dropped otherwise — until it fits.
 * Sections without a rank are always kept, so the caller decides what is
 * essential. Returns the joined text even when it still does not fit (the
 * renderer then falls back to a text bubble).
 */
export function fitSections(sections: readonly CaptionSection[], limit: number): string {
  const live = sections.filter((s) => s.text !== "").map((s) => ({ ...s }));
  const join = () => live.filter((s) => s.text !== "").map((s) => s.text).join("\n\n");
  let text = join();
  if (text.length <= limit) return text;
  const order = live.filter((s) => s.dropRank !== undefined).sort((a, b) => a.dropRank! - b.dropRank!);
  for (const section of order) {
    // Characters the rest of the text uses without this section and its separator.
    const without = text.length - section.text.length - (live.filter((s) => s.text !== "").length > 1 ? 2 : 0);
    section.text = section.shrink?.(limit - without - 2) ?? "";
    text = join();
    if (text.length <= limit) return text;
  }
  return text;
}
