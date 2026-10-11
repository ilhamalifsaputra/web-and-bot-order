import { Decimal } from "@app/core/money";
import { grossMarginPct, grossProfit, resolveDenominationPrice, type MarkupRule } from "@app/core/pricingRule";
import type { PricingPolicy } from "@app/db";

/** Admin-only metadata. Stored retail remains effective until sync/Apply now. */
export function catalogPricing(
  denomination: { price: Decimal; costPrice: Decimal | null; priceOverridden: boolean; autoDeliverySource: string | null; supplierSku: string | null },
  group: string | null, policy: PricingPolicy, categoryRule: MarkupRule | null,
) {
  const cost = denomination.costPrice;
  const automaticAvailable = group === "GAME_TOPUP" && denomination.autoDeliverySource === "digiflazz" && !!denomination.supplierSku;
  const usable = policy.globalRule !== null && policy.roundingReadable;
  const resolution = resolveDenominationPrice({ cost, currentPrice: denomination.price,
    priceOverridden: !automaticAvailable || denomination.priceOverridden,
    categoryRule, globalRule: policy.globalRule ?? { type: null, value: new Decimal(0) },
    rounding: policy.rounding, lowMarginWarnPct: policy.lowMarginWarnPct });
  const margin = grossMarginPct(denomination.price, cost);
  const warnings: string[] = [];
  if (cost === null) warnings.push("missing_cost");
  if (cost !== null && denomination.price.lt(cost)) warnings.push("below_cost");
  if (margin !== null && policy.lowMarginWarnPct !== null && margin.lt(policy.lowMarginWarnPct)) warnings.push("low_margin");
  if (automaticAvailable && !usable) warnings.push("unreadable_policy");
  const calculatedPrice = automaticAvailable && usable ? resolution.calculatedPrice : null;
  return { automaticAvailable, source: resolution.source, calculatedPrice, effectivePrice: denomination.price,
    costPrice: cost, grossProfit: grossProfit(denomination.price, cost), grossMarginPct: margin, warnings,
    pendingReprice: automaticAvailable && !denomination.priceOverridden && calculatedPrice !== null && !calculatedPrice.equals(denomination.price) };
}
