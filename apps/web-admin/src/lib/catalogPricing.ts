import { Decimal } from "@app/core/money";
import { grossMarginPct, grossProfit, resolveDenominationPrice, type MarkupRule } from "@app/core/pricingRule";
import { UNREADABLE_CATEGORY_RULE, type PricingPolicy, type StoredCategoryRule } from "@app/db";

/** Whether the Digiflazz resync and Apply now reprice this SKU while it is not
 * manually overridden: the same scope as `DIGIFLAZZ_SUPPLIER_SCOPE` plus a
 * supplier SKU (the legacy null source counts as Digiflazz). The category
 * group plays no part on the server, so it plays none here (pricing review I2). */
export function isServerAutoPriced(d: { autoDeliverySource: string | null; supplierSku: string | null }): boolean {
  return (d.autoDeliverySource === "digiflazz" || d.autoDeliverySource === null) && !!d.supplierSku;
}

/** Admin-only metadata. Stored retail remains effective until sync/Apply now. */
export function catalogPricing(
  denomination: { price: Decimal; costPrice: Decimal | null; priceOverridden: boolean; autoDeliverySource: string | null; supplierSku: string | null },
  group: string | null, policy: PricingPolicy, storedCategoryRule: StoredCategoryRule,
) {
  const cost = denomination.costPrice;
  const categoryRuleReadable = storedCategoryRule !== UNREADABLE_CATEGORY_RULE;
  const categoryRule: MarkupRule | null = categoryRuleReadable ? storedCategoryRule : null;
  // Whether the admin may pick Auto/Manual on the edit form (Game Top Up only).
  const automaticAvailable = group === "GAME_TOPUP" && denomination.autoDeliverySource === "digiflazz" && !!denomination.supplierSku;
  // Whether the server prices this SKU from the rules (whatever the group).
  const automaticPricing = isServerAutoPriced(denomination);
  const usable = policy.globalRule !== null && policy.roundingReadable && categoryRuleReadable;
  const resolution = resolveDenominationPrice({ cost, currentPrice: denomination.price,
    priceOverridden: !automaticPricing || denomination.priceOverridden,
    categoryRule, globalRule: policy.globalRule ?? { type: null, value: new Decimal(0) },
    rounding: policy.rounding, lowMarginWarnPct: policy.lowMarginWarnPct });
  const margin = grossMarginPct(denomination.price, cost);
  const warnings: string[] = [];
  if (cost === null) warnings.push("missing_cost");
  if (cost !== null && denomination.price.lt(cost)) warnings.push("below_cost");
  if (margin !== null && policy.lowMarginWarnPct !== null && margin.lt(policy.lowMarginWarnPct)) warnings.push("low_margin");
  if (automaticPricing && !usable) warnings.push("unreadable_policy");
  const calculatedPrice = automaticPricing && usable ? resolution.calculatedPrice : null;
  return { automaticAvailable, automaticPricing, source: resolution.source, calculatedPrice, effectivePrice: denomination.price,
    costPrice: cost, grossProfit: grossProfit(denomination.price, cost), grossMarginPct: margin, warnings,
    pendingReprice: automaticPricing && !denomination.priceOverridden && calculatedPrice !== null && !calculatedPrice.equals(denomination.price) };
}
