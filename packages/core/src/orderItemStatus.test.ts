/**
 * The pure half of `recomputeOrderStatus` (Trustance Phase 1, Task 3).
 *
 * `deriveOrderStatusFromItems` is where PARTIALLY_DELIVERED is *representable*.
 * The DB-level proof that no current code path ever feeds it an input that
 * produces one lives in packages/db/src/crud/orderItemStatus.test.ts; this
 * suite covers the function's own contract, including the null/legacy and
 * empty-items cases that must derive nothing at all.
 */
import { describe, it, expect } from "vitest";
import { OrderStatus, OrderItemStatus } from "./enums";
import { deriveOrderStatusFromItems } from "./orderItemStatus";

const IN_FLIGHT = OrderStatus.PROCESSING;

describe("deriveOrderStatusFromItems — terminal outcomes", () => {
  it("all DELIVERED derives DELIVERED", () => {
    expect(deriveOrderStatusFromItems([OrderItemStatus.DELIVERED], IN_FLIGHT)).toBe(OrderStatus.DELIVERED);
    expect(
      deriveOrderStatusFromItems([OrderItemStatus.DELIVERED, OrderItemStatus.DELIVERED], IN_FLIGHT),
    ).toBe(OrderStatus.DELIVERED);
  });

  it("all FAILED derives FAILED", () => {
    expect(deriveOrderStatusFromItems([OrderItemStatus.FAILED, OrderItemStatus.FAILED], IN_FLIGHT)).toBe(
      OrderStatus.FAILED,
    );
  });

  it("all CANCELLED derives CANCELLED", () => {
    expect(deriveOrderStatusFromItems([OrderItemStatus.CANCELLED, OrderItemStatus.CANCELLED], IN_FLIGHT)).toBe(
      OrderStatus.CANCELLED,
    );
  });
});

describe("deriveOrderStatusFromItems — PARTIALLY_DELIVERED", () => {
  it("some DELIVERED and some FAILED, nothing in flight, derives PARTIALLY_DELIVERED", () => {
    expect(deriveOrderStatusFromItems([OrderItemStatus.DELIVERED, OrderItemStatus.FAILED], IN_FLIGHT)).toBe(
      OrderStatus.PARTIALLY_DELIVERED,
    );
  });

  it("some DELIVERED and some CANCELLED derives PARTIALLY_DELIVERED", () => {
    expect(deriveOrderStatusFromItems([OrderItemStatus.DELIVERED, OrderItemStatus.CANCELLED], IN_FLIGHT)).toBe(
      OrderStatus.PARTIALLY_DELIVERED,
    );
  });

  it("DELIVERED plus both FAILED and CANCELLED derives PARTIALLY_DELIVERED", () => {
    expect(
      deriveOrderStatusFromItems(
        [OrderItemStatus.DELIVERED, OrderItemStatus.FAILED, OrderItemStatus.CANCELLED],
        IN_FLIGHT,
      ),
    ).toBe(OrderStatus.PARTIALLY_DELIVERED);
  });

  // Requires a deliberate call, which is the point: it is representable but
  // no production input produces it (see the db-level suite).
  it("needs at least one DELIVERED — a FAILED/CANCELLED mix with none derives nothing", () => {
    expect(deriveOrderStatusFromItems([OrderItemStatus.FAILED, OrderItemStatus.CANCELLED], IN_FLIGHT)).toBeNull();
  });
});

describe("deriveOrderStatusFromItems — refuses to derive", () => {
  it.each([
    OrderItemStatus.PENDING,
    OrderItemStatus.WAITING_FOR_INFO,
    OrderItemStatus.INFO_SUBMITTED,
    OrderItemStatus.QUEUED,
    OrderItemStatus.PROCESSING,
  ])("derives nothing while any item is still %s", (inFlight) => {
    expect(deriveOrderStatusFromItems([OrderItemStatus.DELIVERED, inFlight], IN_FLIGHT)).toBeNull();
    expect(deriveOrderStatusFromItems([inFlight], IN_FLIGHT)).toBeNull();
  });

  // The db-push deploy boundary: an OrderItem written before this column
  // existed has status null. Deriving from "unknown" would be a guess, and a
  // wrong guess would rewrite a real order's status.
  it("derives nothing when ANY item's status is null (a row predating the column)", () => {
    expect(deriveOrderStatusFromItems([OrderItemStatus.DELIVERED, null], IN_FLIGHT)).toBeNull();
    expect(deriveOrderStatusFromItems([null], IN_FLIGHT)).toBeNull();
    expect(deriveOrderStatusFromItems([null, null], IN_FLIGHT)).toBeNull();
  });

  // Wallet top-ups have no OrderItems at all.
  it("derives nothing for an order with no items", () => {
    expect(deriveOrderStatusFromItems([], IN_FLIGHT)).toBeNull();
  });

  it("derives nothing from an unrecognized status string", () => {
    expect(deriveOrderStatusFromItems([OrderItemStatus.DELIVERED, "WAT"], IN_FLIGHT)).toBeNull();
  });

  it("derives nothing when the derived status equals the order's current status", () => {
    // Already DELIVERED: there is nothing to change, so the caller must not
    // write. Expressed as null so `recomputeOrderStatus` has exactly one
    // "do nothing" signal to check.
    expect(deriveOrderStatusFromItems([OrderItemStatus.DELIVERED], OrderStatus.DELIVERED)).toBeNull();
  });
});
