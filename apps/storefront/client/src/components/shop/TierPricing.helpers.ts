import type { LinePricing } from "../../api/types";

/** True when the server's volume-tier engine actually took money off this line
 * (it sends `applied_tier: null` for a tier that matched but saved nothing). */
export function tierApplies(pricing: LinePricing | null | undefined): pricing is LinePricing {
  return Boolean(pricing?.applied_tier);
}
