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
 * **Homogeneity, exactly as before.** A cart holding any non-AUTO line may hold
 * EXACTLY that one line, at any quantity. This is stricter than a plain
 * auto-vs-manual split because `Order.customerData` and
 * `Order.deliveredContent` are order-level columns whose readers assume
 * `items[0]`'s denomination speaks for the whole order.
 *
 * That is the whole rule. There is deliberately NO second "one kind per cart"
 * check, because a separate check would have nothing left to reject:
 *
 * - Every top-up the Digiflazz catalog sync creates is `MANUAL_WITH_INFO`, i.e.
 *   non-AUTO, so the homogeneity rule already forbids it sharing a cart with
 *   anything at all. A mixed-kind cart is, for every SKU shape the system
 *   creates, already a mixed-delivery cart.
 * - The only shape that would slip past homogeneity is an all-AUTO cart holding
 *   a Digiflazz-sourced SKU an admin hand-edited to `deliveryType: auto`. An
 *   earlier revision of this file rejected that, on the belief it would
 *   otherwise reach `dispatchPendingDigiflazzOrders` and have one supplier
 *   top-up delivered for a multi-line order. **That belief was wrong** and the
 *   check was reverted (Task 3 review): that poller selects only
 *   `status: PROCESSING` orders (`packages/db/src/crud/digiflazz.ts`), and an
 *   all-AUTO order goes `PENDING_VERIFICATION -> DELIVERED` through
 *   `approveOrder` without ever passing through PROCESSING. The poller is never
 *   involved in that shape. Such a SKU also carries no stock, so
 *   `createOrderFromCart`'s pre-check already fails it closed with
 *   `error.out_of_stock` before any money moves; and an admin who genuinely
 *   migrated a Digiflazz SKU onto local stock has a working configuration that
 *   a kind check would have broken. Do not reintroduce that check without
 *   re-verifying both code paths.
 *
 * `CartKind`/`cartKindOf` below therefore name and classify, but do not gate.
 * They are the piece a later plan needs: once premium mixing is loosened, the
 * homogeneity rule stops subsuming the kind distinction and a real "one kind
 * per cart" check becomes load-bearing. Keeping the classifier here — tested,
 * and keyed on the one field that is actually correct — means that plan starts
 * from a verified answer rather than re-deriving it.
 */
import { DeliveryType } from "./enums";

/**
 * Which fulfilment world a cart line belongs to. Stored nowhere — derived from
 * the denomination on every read, so it can never go stale against the SKU.
 *
 * Classification only: nothing in this module gates on it today, because the
 * homogeneity rule already subsumes it. See the module doc comment.
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
 * alongside anything else). Unchanged wording, unchanged trigger, and — since
 * the kind check was reverted — the only key this module can return. */
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

  if (lines.some((l) => l.deliveryType !== DeliveryType.AUTO)) return CART_MIXED_DELIVERY;

  return null;
}
