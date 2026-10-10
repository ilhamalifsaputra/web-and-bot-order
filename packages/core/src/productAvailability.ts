/**
 * The single definition of where a denomination (SKU) is fulfilled from and
 * whether it can be bought right now.
 *
 * Before this module the "does this SKU draw from local stock" rule was
 * re-written at every call site with two different criteria: the order side
 * (`packages/db/src/crud/orders.ts`) bypassed stock for
 * `deliveryType !== "auto" || autoDeliverySource === "digiflazz"`, while the
 * display side only checked `deliveryType !== "auto"` — so an `auto` +
 * `digiflazz` SKU showed "Out of stock" although the server accepted it.
 *
 * Pure: no DB, no network. Callers supply the stock count they already have.
 */
import { DIGIFLAZZ_SOURCE } from "./cartComposition";
import { DeliveryType } from "./enums";

export type FulfillmentSource = "INTERNAL_INVENTORY" | "PROVIDER_API" | "MANUAL";

export interface FulfillmentSourceFields {
  deliveryType: string;
  autoDeliverySource: string | null;
}

/** A provider source wins over deliveryType; otherwise `auto` means local stock. */
export function fulfillmentSourceOf(d: FulfillmentSourceFields): FulfillmentSource {
  if (d.autoDeliverySource === DIGIFLAZZ_SOURCE) return "PROVIDER_API";
  if (d.deliveryType === DeliveryType.AUTO) return "INTERNAL_INVENTORY";
  return "MANUAL";
}

/** True when the SKU is fulfilled by reserving a row of local stock. */
export function usesLocalInventory(d: FulfillmentSourceFields): boolean {
  return fulfillmentSourceOf(d) === "INTERNAL_INVENTORY";
}

export type AvailabilityState = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
export type AvailabilityReason = "admin_inactive" | "out_of_inventory" | "inventory_unknown";

export interface DenominationAvailabilityInput {
  denom: FulfillmentSourceFields & { isActive: boolean };
  productActive: boolean;
  productArchived?: boolean;
  categoryActive: boolean;
  /** Count of AVAILABLE local stock rows; `null` when it was not loaded. */
  availableStock: number | null;
}

export interface DenominationAvailability {
  state: AvailabilityState;
  reason: AvailabilityReason | null;
  source: FulfillmentSource;
}

/**
 * Admin deactivation (denomination, product, category, or an archived
 * product) always wins, even for provider SKUs. Only INTERNAL_INVENTORY
 * looks at `availableStock`; an unloaded count is UNKNOWN, never a false
 * "out of stock". PROVIDER_API and MANUAL SKUs are always AVAILABLE here.
 */
export function resolveDenominationAvailability(input: DenominationAvailabilityInput): DenominationAvailability {
  const source = fulfillmentSourceOf(input.denom);
  if (!input.denom.isActive || !input.productActive || input.productArchived === true || !input.categoryActive) {
    return { state: "UNAVAILABLE", reason: "admin_inactive", source };
  }
  if (source !== "INTERNAL_INVENTORY") return { state: "AVAILABLE", reason: null, source };
  if (input.availableStock == null) return { state: "UNKNOWN", reason: "inventory_unknown", source };
  if (input.availableStock > 0) return { state: "AVAILABLE", reason: null, source };
  return { state: "UNAVAILABLE", reason: "out_of_inventory", source };
}
