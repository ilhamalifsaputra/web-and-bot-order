// packages/core/src/payments/tokopayCharge.test.ts
import { describe, it, expect } from "vitest";
import { Decimal } from "../money";
import { readTokopayCharge, expectedTokopayCharge } from "./tokopayCharge";

describe("readTokopayCharge", () => {
  it("accepts a whole-rupiah total at or above the order total", () => {
    expect(readTokopayCharge("50000", "50025")).toEqual({ kind: "ok", charge: new Decimal("50025") });
    expect(readTokopayCharge("50000", "50000")).toEqual({ kind: "ok", charge: new Decimal("50000") });
    expect(readTokopayCharge("50000", " 50450 ")).toEqual({ kind: "ok", charge: new Decimal("50450") });
  });

  it("reports a null or blank total as missing", () => {
    expect(readTokopayCharge("50000", null)).toEqual({ kind: "missing" });
    expect(readTokopayCharge("50000", undefined)).toEqual({ kind: "missing" });
    expect(readTokopayCharge("50000", "  ")).toEqual({ kind: "missing" });
  });

  it("rejects anything that is not plain digits", () => {
    for (const bad of ["abc", "50025.5", "5e4", "0x1F", "-50025", "50 025", "50.025"]) {
      expect(readTokopayCharge("50000", bad), bad).toEqual({ kind: "implausible" });
    }
  });

  it("rejects a total below the nominal sent to TokoPay", () => {
    expect(readTokopayCharge("50000", "49999")).toEqual({ kind: "implausible" });
  });

  it("compares against the rounded nominal (toFixed(0) of the order total)", () => {
    expect(readTokopayCharge("50000.4", "50025").kind).toBe("ok");
    expect(readTokopayCharge("50000.5", "50000").kind).toBe("implausible"); // nominal sent is 50001
  });

  it("caps the implied fee at 50% of the total plus Rp10.000", () => {
    expect(readTokopayCharge("50000", "85000").kind).toBe("ok");
    expect(readTokopayCharge("50000", "85001").kind).toBe("implausible");
  });
});

describe("expectedTokopayCharge", () => {
  it("returns the stored gateway charge when there is one", () => {
    expect(expectedTokopayCharge({ totalAmount: "50000", gatewayChargeAmount: "50025" }).toString()).toBe("50025");
    expect(expectedTokopayCharge({ totalAmount: "50000", gatewayChargeAmount: new Decimal("50450") }).toString()).toBe("50450");
  });

  it("returns the order total when no gateway charge was stored", () => {
    expect(expectedTokopayCharge({ totalAmount: "50000", gatewayChargeAmount: null }).toString()).toBe("50000");
    expect(expectedTokopayCharge({ totalAmount: "50000" }).toString()).toBe("50000");
  });
});
