import { describe, it, expect } from "vitest";
import { describeError } from "./errorMessages";

describe("describeError", () => {
  it("maps error.cannot_deliver_out_of_stock to a readable sentence (Finding #12)", () => {
    expect(describeError("error.cannot_deliver_out_of_stock")).toBe(
      "This item has no stock reserved and can't be delivered automatically — refund or credit the buyer instead.",
    );
  });

  it("maps error.order_not_processing to a readable sentence (Finding #13)", () => {
    expect(describeError("error.order_not_processing")).toBe(
      "This order is no longer awaiting fulfilment — it may have already been processed.",
    );
  });

  it("falls back to the raw string for an unknown key, so it's always safe to wrap any e.message", () => {
    expect(describeError("error.some_unmapped_key")).toBe("error.some_unmapped_key");
    expect(describeError("Failed to load")).toBe("Failed to load");
  });
});
