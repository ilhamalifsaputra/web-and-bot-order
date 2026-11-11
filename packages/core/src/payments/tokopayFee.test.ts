// packages/core/src/payments/tokopayFee.test.ts
import { describe, it, expect } from "vitest";
import { Decimal } from "../money";
import {
  TOKOPAY_FEE_TABLE,
  estimateTokopayFee,
  estimatedTokopayCharge,
  readTokopayCharge,
  expectedTokopayCharge,
} from "./tokopayFee";

describe("estimateTokopayFee", () => {
  it("charges QRIS Rp25 below Rp100.000 and Rp100 + 0.70% from Rp100.000", () => {
    expect(estimateTokopayFee("QRIS", "50000")!.toString()).toBe("25");
    expect(estimateTokopayFee("QRIS", "99999")!.toString()).toBe("25");
    expect(estimateTokopayFee("QRIS", "100000")!.toString()).toBe("800");
    expect(estimateTokopayFee("QRIS", "150000")!.toString()).toBe("1150");
  });

  it("charges QRIS_CUSTOM Rp25 below Rp100.000 and Rp250 + 0.70% from Rp100.000", () => {
    expect(estimateTokopayFee("QRIS_CUSTOM", "99999")!.toString()).toBe("25");
    expect(estimateTokopayFee("QRIS_CUSTOM", "100000")!.toString()).toBe("950");
  });

  it("does not apply the Rp25 rule to QRISREALTIME", () => {
    expect(estimateTokopayFee("QRISREALTIME", "50000")!.toString()).toBe("850");
  });

  it("handles flat-only and percent-only channels", () => {
    expect(estimateTokopayFee("BRIVA", "20000")!.toString()).toBe("3000");
    expect(estimateTokopayFee("BCAVA", "20000")!.toString()).toBe("4200");
    expect(estimateTokopayFee("GOPAY", "10000")!.toString()).toBe("300");
    expect(estimateTokopayFee("TELKOMSEL", "10000")!.toString()).toBe("3200");
  });

  it("rounds half up to whole rupiah", () => {
    // 100 + 100.050 * 0.7% = 800.35 -> 800 ; 100 + 100.072 * 0.7% = 800.504 -> 801
    expect(estimateTokopayFee("QRIS", "100050")!.toString()).toBe("800");
    expect(estimateTokopayFee("QRIS", "100072")!.toString()).toBe("801");
  });

  it("trims and upper-cases the channel code, and returns null for an unknown one", () => {
    expect(estimateTokopayFee(" qris ", "50000")!.toString()).toBe("25");
    expect(estimateTokopayFee("NOT_A_CHANNEL", "50000")).toBeNull();
  });

  it("has a well-formed table: ascending bounds and exactly the last tier open-ended", () => {
    for (const [code, tiers] of Object.entries(TOKOPAY_FEE_TABLE)) {
      expect(tiers.length, code).toBeGreaterThan(0);
      tiers.forEach((tier, index) => {
        const last = index === tiers.length - 1;
        expect(tier.upTo === null, `${code} tier ${index}`).toBe(last);
        expect(new Decimal(tier.flat).greaterThanOrEqualTo(0), code).toBe(true);
        expect(new Decimal(tier.percent).greaterThanOrEqualTo(0), code).toBe(true);
        if (index > 0 && tier.upTo !== null) {
          expect(new Decimal(tier.upTo).greaterThan(tiers[index - 1]!.upTo!), code).toBe(true);
        }
      });
    }
  });
});

describe("estimatedTokopayCharge", () => {
  it("adds the estimate to the total, and adds nothing for an unknown channel", () => {
    expect(estimatedTokopayCharge("QRIS", "50000").toString()).toBe("50025");
    expect(estimatedTokopayCharge("NOT_A_CHANNEL", "50000").toString()).toBe("50000");
  });
});

describe("readTokopayCharge", () => {
  it("accepts a whole-rupiah total at or above the order total", () => {
    expect(readTokopayCharge("QRIS", "50000", "50025")).toEqual({ kind: "ok", charge: new Decimal("50025") });
    expect(readTokopayCharge("QRIS", "50000", "50000")).toEqual({ kind: "ok", charge: new Decimal("50000") });
  });

  it("reports a null or blank total as missing", () => {
    expect(readTokopayCharge("QRIS", "50000", null)).toEqual({ kind: "missing" });
    expect(readTokopayCharge("QRIS", "50000", undefined)).toEqual({ kind: "missing" });
    expect(readTokopayCharge("QRIS", "50000", "  ")).toEqual({ kind: "missing" });
  });

  it("rejects a total below the order total, a non-number and a fractional rupiah", () => {
    expect(readTokopayCharge("QRIS", "50000", "49999")).toEqual({ kind: "implausible" });
    expect(readTokopayCharge("QRIS", "50000", "abc")).toEqual({ kind: "implausible" });
    expect(readTokopayCharge("QRIS", "50000", "50025.5")).toEqual({ kind: "implausible" });
  });

  it("caps the fee at 10% of the total plus Rp10.000 for a low-percent channel", () => {
    expect(readTokopayCharge("QRIS", "50000", "65000").kind).toBe("ok");
    expect(readTokopayCharge("QRIS", "50000", "65001").kind).toBe("implausible");
    expect(readTokopayCharge("NOT_A_CHANNEL", "50000", "65001").kind).toBe("implausible");
  });

  it("widens the cap to twice the table percent for a high-percent channel", () => {
    // TELKOMSEL is 32%: cap = 64% of 10.000 + 10.000 = 16.400
    expect(readTokopayCharge("TELKOMSEL", "10000", "13200").kind).toBe("ok");
    expect(readTokopayCharge("TELKOMSEL", "10000", "26400").kind).toBe("ok");
    expect(readTokopayCharge("TELKOMSEL", "10000", "26401").kind).toBe("implausible");
  });

  it("compares against the rounded nominal that is sent to TokoPay", () => {
    expect(readTokopayCharge("QRIS", "50000.4", "50025").kind).toBe("ok");
  });
});

describe("expectedTokopayCharge", () => {
  it("returns the stored snapshot when there is one", () => {
    expect(expectedTokopayCharge({ totalAmount: "50000", gatewayChargeAmount: "50450" }, "QRIS").toString()).toBe("50450");
  });

  it("falls back to the estimate when the snapshot is null or absent", () => {
    expect(expectedTokopayCharge({ totalAmount: "50000", gatewayChargeAmount: null }, "QRIS").toString()).toBe("50025");
    expect(expectedTokopayCharge({ totalAmount: "50000" }, "QRIS").toString()).toBe("50025");
  });
});
