import { describe, it, expect } from "vitest";
import { formatRestockRequests } from "./restockRequests";

describe("formatRestockRequests", () => {
  it("shows the count only when requests exist and the SKU has no stock", () => {
    expect(formatRestockRequests(3, 0)).toBe("3");
    expect(formatRestockRequests(3, undefined)).toBe("3");
  });
  it("shows an em dash for zero/unknown requests or a SKU that currently has stock", () => {
    expect(formatRestockRequests(0, 0)).toBe("—");
    expect(formatRestockRequests(undefined, 0)).toBe("—");
    expect(formatRestockRequests(3, 5)).toBe("—");
  });
});
