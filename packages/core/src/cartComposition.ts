/**
 * Shared cart composition for add-to-cart, guest merges and checkout.
 *
 * Ordinary AUTO stock SKUs may share a cart. A manual SKU or an explicit
 * Digiflazz supplier SKU must be the sole line, because buyer input and
 * delivered content are order-wide. Digiflazz routes by autoDeliverySource
 * even when an administrator selects deliveryType AUTO.
 *
 * Use explicit supplier metadata to classify top-ups, never the category
 * or checkout presentation.
 */
import { DeliveryType } from "./enums";

/**
 * Which fulfilment world a cart line belongs to. Stored nowhere — derived from
 * the denomination on every read, so it can never go stale against the SKU.
 *
 * Explicit supplier metadata determines the top-up fulfillment boundary.
 */
export const CartKind = {
  /** Fulfilled by the Digiflazz supplier rail. */
  TOPUP: "TOPUP",
  /** Everything else: stock-backed instant SKUs and hand-fulfilled accounts. */
  PREMIUM: "PREMIUM",
} as const;
export type CartKind = (typeof CartKind)[keyof typeof CartKind];

/** The `Denomination.autoDeliverySource` value that marks a top-up.
 *
 * COUPLING WARNING: this treats `autoDeliverySource` as a boolean
 * "is-Digiflazz" flag, but `packages/db/src/crud/productProviderMappings.ts`'s
 * `resolveDenominationProvider` can write any arbitrary provider string into
 * that same column (its mapping-table tests create "providerB"/"providerC").
 * The moment a non-"digiflazz" value lands there, `cartKindOf` below silently
 * reclassifies that SKU as PREMIUM instead of TOPUP. See that resolver's own
 * comment for the other two affected call sites
 * (apps/storefront/src/routes/api.ts's single-unit guard and
 * packages/db/src/crud/digiflazz.ts's dispatchPendingDigiflazzOrders) — not
 * reachable today (no production caller of resolveDenominationProvider yet),
 * but must be fixed before a second transaction provider is onboarded. */
export const DIGIFLAZZ_SOURCE = "digiflazz";

/** Existing buyer-facing key for incompatible fulfillment lines. */
export const CART_MIXED_DELIVERY = "error.cart_mixed_delivery";

/** The minimum a caller must know about a cart line to classify it. Callers
 * pass their own row shape's fields, so this module never depends on Prisma. */
export interface CartCompositionLine {
  /** The Denomination id. Used only to spot a re-add of the same SKU. */
  denominationId: number;
  /** `Denomination.deliveryType` — "auto" | "manual" | "manual_with_info". */
  deliveryType: string;
  /** `Denomination.autoDeliverySource` — "digiflazz" or null. */
  autoDeliverySource: string | null;
}

/** Classify one line. See this module's doc comment for why the test is on
 * autoDeliverySource and nothing else. */
export function cartKindOf(line: CartCompositionLine): CartKind {
  return line.autoDeliverySource === DIGIFLAZZ_SOURCE ? CartKind.TOPUP : CartKind.PREMIUM;
}

/**
 * May `incoming` join a cart that already holds `existing`?
 *
 * Returns `null` when the addition is allowed, or the i18n error key to reject
 * with. Callers decide the transport (a 400 body in `POST /cart`, a skipped
 * line in the guest-cart merge).
 *
 * Re-adding the denomination that is already the cart's SOLE line is exempt
 * from both rules: it increments a quantity rather than creating a new line, so
 * the resulting cart's composition is the one it already had.
 */
export function cartAdditionError(
  existing: readonly CartCompositionLine[],
  incoming: CartCompositionLine,
): string | null {
  if (existing.length === 0) return null;

  const isSameSingleLine = existing.length === 1 && existing[0]!.denominationId === incoming.denominationId;
  if (isSameSingleLine) return null;

  if (incoming.autoDeliverySource === DIGIFLAZZ_SOURCE || existing.some(l => l.autoDeliverySource === DIGIFLAZZ_SOURCE)) return CART_MIXED_DELIVERY;

  const anyNonAuto =
    incoming.deliveryType !== DeliveryType.AUTO || existing.some((l) => l.deliveryType !== DeliveryType.AUTO);
  if (anyNonAuto) return CART_MIXED_DELIVERY;

  return null;
}

/**
 * Is this whole cart a legal composition? The defense-in-depth re-assertion
 * used at the money-moving choke points, where the cart may have reached its
 * current shape without passing `cartAdditionError` (the guest-cart merge on
 * login, or a two-tab add race).
 *
 * Returns `null` when the cart may proceed, or the i18n error key to fail with.
 * Callers must pass only the lines that will actually become order items
 * (i.e. already filtered to active denominations), matching what they do today.
 */
export function cartCompositionError(lines: readonly CartCompositionLine[]): string | null {
  if (lines.length <= 1) return null;

  if (lines.some(l => l.autoDeliverySource === DIGIFLAZZ_SOURCE)) return CART_MIXED_DELIVERY;

  if (lines.some((l) => l.deliveryType !== DeliveryType.AUTO)) return CART_MIXED_DELIVERY;

  return null;
}
