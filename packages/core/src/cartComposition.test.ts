/**
 * Cart composition rule (Trustance Phase 1, Task 3).
 *
 * The headline requirement for this task is ZERO behavior change: `cart_kind`
 * names and centralizes a rule the storefront already enforced ad hoc, it does
 * not loosen or tighten it. So the bulk of this suite is a characterization
 * suite — every case below that is marked "(today's behavior)" asserts what the
 * hand-rolled `mixedDelivery` check in apps/storefront/src/routes/api.ts and the
 * `length > 1 && some(non-AUTO)` check in routes/checkout.ts already did.
 */
import { describe, it, expect } from "vitest";
import { DeliveryType } from "./enums";
import {
  CartKind,
  cartKindOf,
  cartAdditionError,
  cartCompositionError,
  CART_MIXED_DELIVERY,
  type CartCompositionLine,
} from "./cartComposition";

/** An ordinary auto-delivered premium SKU (stock-backed, instant). */
const auto = (denominationId: number): CartCompositionLine => ({
  denominationId,
  deliveryType: DeliveryType.AUTO,
  autoDeliverySource: null,
});
/** A hand-fulfilled premium SKU. */
const manual = (denominationId: number): CartCompositionLine => ({
  denominationId,
  deliveryType: DeliveryType.MANUAL,
  autoDeliverySource: null,
});
/** A premium SKU that collects buyer info at checkout. */
const manualWithInfo = (denominationId: number): CartCompositionLine => ({
  denominationId,
  deliveryType: DeliveryType.MANUAL_WITH_INFO,
  autoDeliverySource: null,
});
/** A Digiflazz game top-up EXACTLY as packages/db/src/crud/digiflazz.ts
 * creates it: autoDeliverySource "digiflazz" AND deliveryType
 * MANUAL_WITH_INFO. The catalog sync never writes any other shape — see
 * cartComposition.ts's own doc comment. */
const topup = (denominationId: number): CartCompositionLine => ({
  denominationId,
  deliveryType: DeliveryType.MANUAL_WITH_INFO,
  autoDeliverySource: "digiflazz",
});

describe("cartKindOf", () => {
  it("classifies a Digiflazz-sourced line as TOPUP", () => {
    expect(cartKindOf(topup(1))).toBe(CartKind.TOPUP);
  });

  it("classifies every non-Digiflazz line as PREMIUM, whatever its deliveryType", () => {
    expect(cartKindOf(auto(1))).toBe(CartKind.PREMIUM);
    expect(cartKindOf(manual(1))).toBe(CartKind.PREMIUM);
    expect(cartKindOf(manualWithInfo(1))).toBe(CartKind.PREMIUM);
  });

  // The prior investigation's verified correction: top-ups are NOT identified
  // by deliveryType (they share MANUAL_WITH_INFO with premium info-collecting
  // SKUs) and NOT by Category.group (display-only) — only by
  // autoDeliverySource.
  it("does not confuse a premium manual_with_info SKU with a top-up (they share a deliveryType)", () => {
    expect(manualWithInfo(1).deliveryType).toBe(topup(2).deliveryType);
    expect(cartKindOf(manualWithInfo(1))).not.toBe(cartKindOf(topup(2)));
  });

  it("treats a non-digiflazz autoDeliverySource as PREMIUM (only 'digiflazz' means TOPUP)", () => {
    expect(cartKindOf({ denominationId: 1, deliveryType: DeliveryType.AUTO, autoDeliverySource: "someday" })).toBe(
      CartKind.PREMIUM,
    );
  });
});

describe("cartAdditionError — today's add-to-cart behavior, unchanged", () => {
  it("(today's behavior) allows the first line into an empty cart, whatever it is", () => {
    expect(cartAdditionError([], auto(1))).toBeNull();
    expect(cartAdditionError([], manual(1))).toBeNull();
    expect(cartAdditionError([], manualWithInfo(1))).toBeNull();
    expect(cartAdditionError([], topup(1))).toBeNull();
  });

  it("(today's behavior) allows any number of different AUTO premium lines", () => {
    expect(cartAdditionError([auto(1)], auto(2))).toBeNull();
    expect(cartAdditionError([auto(1), auto(2)], auto(3))).toBeNull();
  });

  it("(today's behavior) rejects a manual line joining an auto cart with error.cart_mixed_delivery", () => {
    expect(cartAdditionError([auto(1)], manual(2))).toBe(CART_MIXED_DELIVERY);
  });

  it("(today's behavior) rejects an auto line joining a manual cart with error.cart_mixed_delivery", () => {
    expect(cartAdditionError([manual(1)], auto(2))).toBe(CART_MIXED_DELIVERY);
  });

  it("(today's behavior) rejects a second, different manual line with error.cart_mixed_delivery", () => {
    expect(cartAdditionError([manual(1)], manualWithInfo(2))).toBe(CART_MIXED_DELIVERY);
  });

  it("(today's behavior) exempts re-adding the SAME denomination that is already the cart's sole line", () => {
    expect(cartAdditionError([manual(1)], manual(1))).toBeNull();
    expect(cartAdditionError([manualWithInfo(1)], manualWithInfo(1))).toBeNull();
    expect(cartAdditionError([topup(1)], topup(1))).toBeNull();
  });

  it("(today's behavior) does NOT exempt re-adding a denomination when the cart has other lines too", () => {
    expect(cartAdditionError([auto(1), auto(2)], manual(1))).toBe(CART_MIXED_DELIVERY);
  });
});

describe("cartAdditionError — a top-up is governed entirely by the homogeneity rule", () => {
  // THE PROOF this task hangs on. A Digiflazz top-up as the catalog sync
  // actually creates it is deliveryType MANUAL_WITH_INFO, i.e. non-AUTO — so
  // the pre-existing homogeneity rule already forbids it sharing a cart with
  // anything. There is nothing left for a separate "one kind per cart" check to
  // reject, which is why this module does not have one. The error key a buyer
  // sees is byte-identical to today's.
  it("a real top-up mixing with premium is rejected as error.cart_mixed_delivery", () => {
    expect(cartAdditionError([auto(1)], topup(2))).toBe(CART_MIXED_DELIVERY);
    expect(cartAdditionError([topup(1)], auto(2))).toBe(CART_MIXED_DELIVERY);
    expect(cartAdditionError([manual(1)], topup(2))).toBe(CART_MIXED_DELIVERY);
    expect(cartAdditionError([topup(1)], manualWithInfo(2))).toBe(CART_MIXED_DELIVERY);
  });

  it("two different real top-ups are rejected as error.cart_mixed_delivery too", () => {
    expect(cartAdditionError([topup(1)], topup(2))).toBe(CART_MIXED_DELIVERY);
  });

  // The one shape homogeneity does NOT catch: a Digiflazz-sourced SKU an admin
  // hand-edited to `auto` (e.g. migrated off the supplier rail onto local
  // stock). A previous revision rejected this as a kind conflict on a premise
  // that turned out to be false — the Digiflazz poller only ever looks at
  // PROCESSING orders and an all-AUTO order never reaches PROCESSING. Pinned
  // as ALLOWED so the check is not reintroduced by reflex; see
  // cartComposition.ts's doc comment for the full trace.
  it("an AUTO-typed Digiflazz SKU is allowed to share an all-AUTO cart (no kind gate)", () => {
    const autoTypedTopup: CartCompositionLine = {
      denominationId: 2,
      deliveryType: DeliveryType.AUTO,
      autoDeliverySource: "digiflazz",
    };
    expect(cartAdditionError([auto(1)], autoTypedTopup)).toBeNull();
    expect(cartAdditionError([autoTypedTopup], auto(1))).toBeNull();
    // ...and it is still classified as a TOPUP, for the future plan's benefit.
    expect(cartKindOf(autoTypedTopup)).toBe(CartKind.TOPUP);
  });

  it("an AUTO-typed top-up is also fine as the cart's only line", () => {
    const autoTypedTopup: CartCompositionLine = {
      denominationId: 2,
      deliveryType: DeliveryType.AUTO,
      autoDeliverySource: "digiflazz",
    };
    expect(cartAdditionError([], autoTypedTopup)).toBeNull();
    expect(cartAdditionError([autoTypedTopup], autoTypedTopup)).toBeNull();
  });
});

describe("cartCompositionError — the checkout re-assertion, unchanged", () => {
  it("(today's behavior) accepts an empty cart and a single line of any kind", () => {
    expect(cartCompositionError([])).toBeNull();
    expect(cartCompositionError([auto(1)])).toBeNull();
    expect(cartCompositionError([manual(1)])).toBeNull();
    expect(cartCompositionError([manualWithInfo(1)])).toBeNull();
    expect(cartCompositionError([topup(1)])).toBeNull();
  });

  it("(today's behavior) accepts many AUTO premium lines", () => {
    expect(cartCompositionError([auto(1), auto(2), auto(3)])).toBeNull();
  });

  it("(today's behavior) rejects >1 line when any is non-AUTO, with error.cart_mixed_delivery", () => {
    expect(cartCompositionError([auto(1), manual(2)])).toBe(CART_MIXED_DELIVERY);
    expect(cartCompositionError([manual(1), manualWithInfo(2)])).toBe(CART_MIXED_DELIVERY);
    expect(cartCompositionError([auto(1), topup(2)])).toBe(CART_MIXED_DELIVERY);
  });

  // Same proof as the add path: for every SKU shape the system creates, a
  // mixed-kind cart is already a mixed-delivery cart, so the error key at
  // checkout never changes.
  it("a real mixed-kind cart reports error.cart_mixed_delivery", () => {
    expect(cartCompositionError([topup(1), auto(2)])).toBe(CART_MIXED_DELIVERY);
  });

  // The pay-button counterpart of the add-path case above. This mattered more
  // than the add path did: rejecting here would have failed an ALREADY BUILT
  // cart at the pay button, with an error key the buyer had never seen.
  it("an all-AUTO cart containing an AUTO-typed Digiflazz SKU passes (no kind gate)", () => {
    const autoTypedTopup: CartCompositionLine = {
      denominationId: 2,
      deliveryType: DeliveryType.AUTO,
      autoDeliverySource: "digiflazz",
    };
    expect(cartCompositionError([auto(1), autoTypedTopup])).toBeNull();
  });
});
