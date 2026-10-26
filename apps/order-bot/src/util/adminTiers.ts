/**
 * The bot admin's view of a SKU's volume tiers. The bot only edits the legacy
 * single rule ("N+ units, X% off", written through upsertBulkPricing as one
 * PERCENTAGE tier); the web admin owns the full tier editor. Anything the bot
 * cannot express — several tiers, or a fixed-amount tier — is shown read-only
 * so a bot save or delete never overwrites it. Admin-facing, so amounts use
 * the Indonesian formatIdr (AGENTS.md).
 */
import type { PricingTier } from "@app/core/bulk";
import { Decimal } from "@app/core/money";
import { legacyRuleCanReplace } from "@app/db";
import { formatIdr } from "./format";

/** True when the bot's single-rule editor can change this tier set without losing anything. */
export function botCanEditTiers(tiers: readonly PricingTier[]): boolean {
  // The same rule the legacy adapters re-check under their row lock.
  return legacyRuleCanReplace(tiers);
}

/** One line per tier, lowest threshold first. */
export function adminTierLines(
  tiers: readonly PricingTier[],
  tr: (key: string, args?: Record<string, string | number>) => string,
): string {
  return [...tiers]
    .sort((a, b) => a.minQuantity - b.minQuantity)
    .map((tier) => {
      const value = new Decimal(tier.discountValue);
      const disabled = tier.isEnabled ? "" : tr("admin.bulk_tier_disabled");
      if (tier.discountType === "PERCENTAGE") {
        return tr("admin.bulk_tier_line_percent", { min_qty: tier.minQuantity, percent: value.toString(), disabled });
      }
      if (tier.discountType === "FIXED_AMOUNT_OFF_PER_UNIT") {
        return tr("admin.bulk_tier_line_amount", { min_qty: tier.minQuantity, amount: formatIdr(value), disabled });
      }
      return tr("admin.bulk_tier_line_fixed", { min_qty: tier.minQuantity, price: formatIdr(value), disabled });
    })
    .join("\n");
}
