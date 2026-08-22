import { describe, it, expect } from "vitest";
import {
  emitDigiflazzCatalogSyncChanged,
  onDigiflazzCatalogSyncChanged,
  emitDigiflazzOrderStatusChanged,
  onDigiflazzOrderStatusChanged,
} from "./digiflazzEvents";

describe("digiflazzEvents", () => {
  it("onDigiflazzCatalogSyncChanged subscriber is called when emitDigiflazzCatalogSyncChanged() fires", () => {
    let called = false;
    const unsubscribe = onDigiflazzCatalogSyncChanged(() => {
      called = true;
    });
    expect(called).toBe(false);
    emitDigiflazzCatalogSyncChanged();
    expect(called).toBe(true);
    unsubscribe();
  });

  it("multiple concurrent subscribers to the same event all get called", () => {
    let sub1Called = false;
    let sub2Called = false;
    const unsub1 = onDigiflazzCatalogSyncChanged(() => {
      sub1Called = true;
    });
    const unsub2 = onDigiflazzCatalogSyncChanged(() => {
      sub2Called = true;
    });
    emitDigiflazzCatalogSyncChanged();
    expect(sub1Called).toBe(true);
    expect(sub2Called).toBe(true);
    unsub1();
    unsub2();
  });

  it("the returned unsubscribe function stops future calls", () => {
    let callCount = 0;
    const unsubscribe = onDigiflazzCatalogSyncChanged(() => {
      callCount += 1;
    });
    emitDigiflazzCatalogSyncChanged();
    expect(callCount).toBe(1);
    unsubscribe();
    emitDigiflazzCatalogSyncChanged();
    expect(callCount).toBe(1);
  });

  it("onDigiflazzOrderStatusChanged callback receives the emitted orderId argument correctly", () => {
    let receivedOrderId: number | undefined;
    const unsubscribe = onDigiflazzOrderStatusChanged((orderId) => {
      receivedOrderId = orderId;
    });
    emitDigiflazzOrderStatusChanged(42);
    expect(receivedOrderId).toBe(42);
    unsubscribe();
  });

  it("emitDigiflazzOrderStatusChanged broadcasts to every subscriber regardless of order id filtering", () => {
    const receivedOrderIds: number[] = [];
    const unsub1 = onDigiflazzOrderStatusChanged((orderId) => {
      receivedOrderIds.push(orderId);
    });
    const unsub2 = onDigiflazzOrderStatusChanged((orderId) => {
      receivedOrderIds.push(orderId);
    });
    emitDigiflazzOrderStatusChanged(10);
    emitDigiflazzOrderStatusChanged(20);
    // Both subscribers receive both order ids, not filtered by the module
    expect(receivedOrderIds).toEqual([10, 10, 20, 20]);
    unsub1();
    unsub2();
  });

  it("emitting with zero subscribers registered does not throw", () => {
    expect(() => {
      emitDigiflazzCatalogSyncChanged();
    }).not.toThrow();
    expect(() => {
      emitDigiflazzOrderStatusChanged(1);
    }).not.toThrow();
  });
});
