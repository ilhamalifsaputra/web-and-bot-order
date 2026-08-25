/**
 * `cart_kind` — the named cart-composition rule (Trustance Phase 1, Task 3).
 *
 * ## What this replaces
 *
 * Three places used to hand-roll the same two-line check, each phrased slightly
 * differently and each able to drift from the others:
 *
 * - `apps/storefront/src/routes/api.ts` (`POST /cart`) — the `mixedDelivery`
 *   local, deciding whether a new line may join the cart.
 * - `apps/storefront/src/routes/checkout.ts` (`performCheckout`) — a
 *   `length > 1 && some(non-AUTO)` re-assertion at the money-moving choke point.
 * - `packages/db/src/crud/wallet_checkout.ts` — a verbatim copy of the checkout
 *   one, for the pay-from-balance rail.
 *
 * All three now call into this module. The rule they enforce is UNCHANGED; it
 * just has a name and one implementation.
 *
 * ## What a "kind" is, and why it is NOT deliveryType
 *
 * `TOPUP` means the line is fulfilled by the Digiflazz supplier rail, i.e.
 * `Denomination.autoDeliverySource === "digiflazz"`. That is the only correct
 * signal, verified against the three places that actually route a top-up
 * (`POST /cart`'s own single-unit guard, `dispatchPendingDigiflazzOrders`, and
 * `resolveSingleDigiflazzItem`):
 *
 * - NOT `deliveryType`: the Digiflazz catalog sync
 *   (`packages/db/src/crud/digiflazz.ts`) creates every top-up SKU as
 *   `MANUAL_WITH_INFO`, the same value a premium SKU that collects buyer info
 *   at checkout carries. The two are indistinguishable by deliveryType alone.
 * - NOT `Category.group` (`GAME_TOPUP`/`PREMIUM_APPS`): admin-set and
 *   display-only — it drives the bot's browse entry point, nothing fulfils
 *   against it.
 * - NOT `checkoutFlow`: a storefront UX hint (which page renders the SKU),
 *   also with no fulfilment meaning.
 *
 * ## The rule (deliberately NOT loosened by this task)
 *
 * 1. **Homogeneity, exactly as before.** A cart holding any non-AUTO line may
 *    hold EXACTLY that one line, at any quantity. This is stricter than a plain
 *    auto-vs-manual split because `Order.customerData` and
 *    `Order.deliveredContent` are order-level columns whose readers assume
 *    `items[0]`'s denomination speaks for the whole order.
 * 2. **One kind per cart.** A cart may not mix TOPUP and PREMIUM lines.
 *
 * Rule 1 is checked FIRST, on purpose. For every SKU shape the system actually
 * creates, a TOPUP line is non-AUTO, so rule 1 already forbids it sharing a
 * cart with anything and rule 2 can never be the reason an add is refused —
 * the error key a buyer sees is byte-identical to today's
 * `error.cart_mixed_delivery`. `cartComposition.test.ts` proves this case by
 * case; it is the "zero behavior change" guarantee this task is built on.
 *
 * ## The one input that does reach rule 2
 *
 * An admin hand-editing a Digiflazz SKU's `deliveryType` to `auto` produces a
 * line that is TOPUP-kinded but AUTO-typed, which rule 1 lets through and rule
 * 2 then rejects with `error.cart_kind_conflict`. Today that add succeeds, so
 * this is the single intentional behavior delta in this task — and it closes a
 * latent money bug rather than opening one: `dispatchPendingDigiflazzOrders`
 * places exactly ONE supplier top-up per order and then marks the WHOLE order
 * DELIVERED, so a buyer who got a Digiflazz line into a multi-line cart would
 * pay for every line and receive one. That is the same failure the
 * single-unit guard in `POST /cart` already exists to prevent; this closes the
 * remaining door to it.
 */
import { DeliveryType } from "./enums";

/**
 * Which fulfilment world a cart line belongs to. Stored nowhere — derived from
 * the denomination on every read, so it can never go stale against the SKU.
 */
export const CartKind = {
  /** Fulfilled by the Digiflazz supplier rail. */
  TOPUP: "TOPUP",
  /** Everything else: stock-backed instant SKUs and hand-fulfilled accounts. */
  PREMIUM: "PREMIUM",
} as const;
export type CartKind = (typeof CartKind)[keyof typeof CartKind];

/** The `Denomination.autoDeliverySource` value that marks a top-up. */
export const DIGIFLAZZ_SOURCE = "digiflazz";

/** Pre-existing key: the cart mixes delivery types (or holds a non-AUTO line
 * alongside anything else). Unchanged wording, unchanged trigger. */
export const CART_MIXED_DELIVERY = "error.cart_mixed_delivery";
/** New key: the cart would hold both a TOPUP and a PREMIUM line. */
export const CART_KIND_CONFLICT = "error.cart_kind_conflict";

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

  // Rule 1 first — see the doc comment: this ordering is what keeps every
  // rejection a buyer can actually trigger on its pre-existing error key.
  const anyNonAuto =
    incoming.deliveryType !== DeliveryType.AUTO || existing.some((l) => l.deliveryType !== DeliveryType.AUTO);
  if (anyNonAuto) return CART_MIXED_DELIVERY;

  // Rule 2.
  const incomingKind = cartKindOf(incoming);
  if (existing.some((l) => cartKindOf(l) !== incomingKind)) return CART_KIND_CONFLICT;

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

  // Rule 1 first, same reason as above.
  if (lines.some((l) => l.deliveryType !== DeliveryType.AUTO)) return CART_MIXED_DELIVERY;

  // Rule 2.
  const firstKind = cartKindOf(lines[0]!);
  if (lines.some((l) => cartKindOf(l) !== firstKind)) return CART_KIND_CONFLICT;

  return null;
}
