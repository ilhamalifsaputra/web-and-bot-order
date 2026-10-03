import type { CanonicalProduct } from "@app/core/canonicalProduct";
import { logger } from "@app/core/logger";
import { isKnownUnit } from "@app/core/unitDisplay";

/** Units already reported by this process, so a busy catalog warns once per unit instead of once per render. */
const reported = new Set<string>();

/**
 * Report, once per unit, a quantity unit that is not in the unit dictionary. Such a unit still works (its buttons spell
 * it out exactly as the SKU states it), but nobody would otherwise learn that it could have an icon or a short form.
 * Returns the units reported by THIS call. Lives in the order-bot layer: the presenter in packages/core stays pure.
 */
export function noteUnknownUnits(products: readonly CanonicalProduct[]): string[] {
  const fresh: string[] = [];
  for (const product of products) {
    const variant = product.variant;
    if (variant.type !== "amount") continue;
    for (const unit of [variant.unit, variant.bonus?.unit]) {
      if (!unit || isKnownUnit(unit)) continue;
      const key = unit.trim().replace(/\s+/g, " ").toLowerCase();
      if (reported.has(key)) continue;
      reported.add(key);
      fresh.push(unit);
      logger.warn(
        { unit, productId: product.product.id },
        `A catalog quantity unit is not in the unit dictionary, so its Telegram buttons spell it out in full (for example "100 ${unit}"). If it deserves an icon or a short form, add it to packages/core/src/unitDictionary.ts.`,
      );
    }
  }
  return fresh;
}

export function resetUnknownUnitsForTests(): void {
  reported.clear();
}
