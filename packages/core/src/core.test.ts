import { describe, it, expect } from "vitest";
import { money, fmtMoney, moneyEq, Decimal } from "./money";
import { t } from "./i18n";
import { roundRateToStep, validateUsdIdrRate, applyUsdtSpread } from "./fx";
import { OrderStatus, UserRole, NotificationEvent, langCode } from "./enums";
import { computeUniqueCents, usdtFromIdr } from "./formatters";

describe("money", () => {
  it("quantizes to 4 dp", () => {
    expect(fmtMoney(money("5.00071"))).toBe("5.0007");
    expect(fmtMoney(money("5.00075"))).toBe("5.0008"); // round half up
  });
  it("keeps Decimal precision (no float)", () => {
    expect(money("0.1").plus(money("0.2")).equals(new Decimal("0.3"))).toBe(true);
  });
  it("moneyEq compares quantized", () => {
    expect(moneyEq("1.00000", "1")).toBe(true);
  });
  it("null renders em dash", () => {
    expect(fmtMoney(null)).toBe("—");
  });
});

describe("computeUniqueCents (M-9 disambiguation offset)", () => {
  it("is deterministic per order id and within 0.002–0.098", () => {
    for (const id of [1, 2, 48, 49, 50, 100, 1234]) {
      const c = computeUniqueCents(id);
      expect(c.equals(computeUniqueCents(id))).toBe(true); // deterministic
      expect(c.gte(new Decimal("0.002"))).toBe(true);
      expect(c.lte(new Decimal("0.098"))).toBe(true);
      expect(c.decimalPlaces()).toBeLessThanOrEqual(4);
    }
  });

  it("formula = ((id % 49) + 1) / 500", () => {
    expect(computeUniqueCents(1).equals(new Decimal("0.004"))).toBe(true); // (1%49)+1=2 → 2/500
    expect(computeUniqueCents(2).equals(new Decimal("0.006"))).toBe(true); // 3/500
    expect(computeUniqueCents(48).equals(new Decimal("0.098"))).toBe(true); // (48%49)+1=49 → 49/500
    expect(computeUniqueCents(49).equals(new Decimal("0.002"))).toBe(true); // wraps: (49%49)+1=1 → 1/500
  });

  it("CLOSES THE GAP: adjacent offsets are > AMOUNT_TOLERANCE (0.001) so equal-base orders disambiguate", () => {
    // Two consecutive order ids must produce totals more than 0.001 apart, so the
    // payment matchers (|received − total| <= 0.001) see only ONE candidate and
    // auto-confirm the right order instead of refusing on a phantom collision.
    for (const id of [1, 2, 10, 47, 100]) {
      const spread = computeUniqueCents(id + 1).minus(computeUniqueCents(id)).abs();
      expect(spread.gt(new Decimal("0.001"))).toBe(true); // > AMOUNT_TOLERANCE
    }
  });

  // M13 / P2-1 required regression. The test above only compares two offsets on
  // the SAME base; `usdtFromIdr`'s step is what decides whether two DIFFERENT
  // bases can collapse into each other's offset range, and that step just moved
  // from 0.1 half-up to 0.01 ceil. The offset range (0.002 … 0.098) is now
  // WIDER than the gap between adjacent bases, which it never was before — so
  // the margin has to be argued from the totals, not from the offsets.
  //
  // The argument: a base is k/100 and an offset is 2m/1000, so every producible
  // total is (10k + 2m)/1000 — always an EVEN multiple of 0.001. Two distinct
  // totals are therefore at least 0.002 apart, which is still strictly greater
  // than AMOUNT_TOLERANCE (0.001, apps/order-bot/src/payments/
  // amountMatching.ts), so the matchers' `|received − total| <= 0.001` window
  // can never contain two candidates. Hard-coded here rather than imported,
  // matching the sibling test above — core must not import from apps/.
  it("CLOSES THE GAP AT THE NEW 0.01 STEP: every producible total is > AMOUNT_TOLERANCE from every other", () => {
    const AMOUNT_TOLERANCE = new Decimal("0.001"); // apps/order-bot/.../amountMatching.ts
    const rate = new Decimal("16000");
    const totals: Decimal[] = [];
    // A sweep of real Rupiah totals whose conversions land on adjacent cents,
    // each with every one of the 49 offset buckets on top.
    for (const idr of ["44500", "44600", "44700", "8900", "9000", "700", "800"]) {
      for (let id = 0; id < 49; id++) {
        totals.push(usdtFromIdr(idr, rate).plus(computeUniqueCents(id)));
      }
    }
    const sorted = [...totals].sort((a, b) => a.comparedTo(b));
    let minDistinctGap: Decimal | null = null;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]!.minus(sorted[i - 1]!);
      if (gap.isZero()) continue; // the same total produced twice — see below
      if (!minDistinctGap || gap.lessThan(minDistinctGap)) minDistinctGap = gap;
    }
    expect(minDistinctGap).not.toBeNull();
    expect(minDistinctGap!.greaterThan(AMOUNT_TOLERANCE)).toBe(true);
    expect(minDistinctGap!.equals(new Decimal("0.002"))).toBe(true);
  });

  // The other half of the same change, stated so it is not mistaken for a bug.
  // Two DIFFERENT Rupiah totals CAN now produce the identical USDT total (base
  // 2.79 + 0.012 equals base 2.80 + 0.002), which the old 0.1 step made
  // impossible because the whole offset range fitted inside one step. Exact
  // collisions are not what AMOUNT_TOLERANCE guards — `finalizeOrderPayment`'s
  // own Bybit/Bybit-BSC loop re-rolls the offset until no OTHER pending order
  // on the same rail shares the total, comparing the final totals themselves.
  // This only makes that loop work a little harder, never wrong.
  it("documents that two different bases can now share a total, which the collision loop is what handles", () => {
    const rate = new Decimal("16000");
    const lower = usdtFromIdr("44500", rate); // 2.78125 → 2.79
    const upper = usdtFromIdr("44600", rate); // 2.7875  → 2.79
    expect(lower.toString()).toBe("2.79");
    expect(upper.toString()).toBe("2.79");
    // Bases one cent apart, with the offset range spanning ~0.096, overlap.
    const stepApart = usdtFromIdr("44700", rate); // 2.79375 → 2.80
    expect(stepApart.minus(lower).equals(new Decimal("0.01"))).toBe(true);
    expect(computeUniqueCents(5).greaterThan(stepApart.minus(lower))).toBe(true);
  });
});

/**
 * P2-1 (user-confirmed pricing policy). `usdtFromIdr` rounds to the next CENT,
 * always upwards — never half-up to the nearest tenth. Two properties matter
 * and both are money-critical: the shop never undercharges on a conversion,
 * and no positive Rupiah amount converts away to nothing.
 */
describe("usdtFromIdr (step 0.01, always rounded up — P2-1)", () => {
  it("rounds up to the next cent, never to the nearest one", () => {
    // The vectors that make the DIRECTION load-bearing: a remainder under half
    // a cent, which half-up rounds DOWN (undercharging the shop) and ceiling
    // rounds up. Without at least one of these the test passes just as happily
    // against ROUND_HALF_UP and pins nothing.
    expect(usdtFromIdr("44336", "16000").toString()).toBe("2.78"); // 2.771 — half-up: 2.77
    expect(usdtFromIdr("832", "16000").toString()).toBe("0.06"); //   0.052 — half-up: 0.05
    expect(usdtFromIdr("16016", "16000").toString()).toBe("1.01"); // 1.001 — half-up: 1.00
    expect(usdtFromIdr("44504", "16000").toString()).toBe("2.79"); // 2.7815 — half-up: 2.78
    // 44.500/16.000 = 2.78125 — also discriminating (half-up at 2dp is 2.78).
    expect(usdtFromIdr("44500", "16000").toString()).toBe("2.79");
    // The three below land on the SAME figure under either rule — 0.55625,
    // 2.775 and 2.75625 all round UP under half-up too. They are kept because
    // they are the worked examples quoted elsewhere in this repo (Rp8.900 in
    // particular), NOT because they say anything about the rounding direction.
    expect(usdtFromIdr("8900", "16000").toString()).toBe("0.56");
    expect(usdtFromIdr("44400", "16000").toString()).toBe("2.78");
    expect(usdtFromIdr("44100", "16000").toString()).toBe("2.76");
  });

  it("leaves an exact figure exactly as it is — ceiling only bites on a remainder", () => {
    expect(usdtFromIdr("40000", "16000").toString()).toBe("2.5");
    expect(usdtFromIdr("32000", "16000").toString()).toBe("2");
    expect(usdtFromIdr("0", "16000").toString()).toBe("0");
  });

  // The behaviour change with the widest blast radius: under the old 0.1
  // half-up step a small Rupiah total converted to 0.0 USDT, which is why
  // `orderMinimums.ts` exists and why `railMinimumFailure` has a
  // `nothing_to_collect` backstop. Ceiling makes that unreachable for any
  // positive amount — the backstop stays (it still catches a zero or negative
  // total) but it is no longer the case it was written for.
  it("never rounds a positive amount away to nothing", () => {
    expect(usdtFromIdr("700", "16000").toString()).toBe("0.05");
    expect(usdtFromIdr("100", "16000").toString()).toBe("0.01");
    expect(usdtFromIdr("1", "16000").toString()).toBe("0.01");
    expect(usdtFromIdr("5", "16000").greaterThan(0)).toBe(true);
  });
});

describe("enums match stored DB names (uppercase)", () => {
  it("uses SQLAlchemy member names", () => {
    expect(OrderStatus.DELIVERED).toBe("DELIVERED");
    expect(UserRole.ADMIN).toBe("ADMIN");
    expect(NotificationEvent.ORDER_DELIVERED).toBe("ORDER_DELIVERED");
  });
  it("langCode maps stored language to locale", () => {
    expect(langCode("EN")).toBe("en");
    expect(langCode("ID")).toBe("id");
    expect(langCode(null)).toBe("en");
  });
});

describe("i18n", () => {
  it("falls back to key when missing", () => {
    expect(t("nonexistent.key.xyz", "en")).toBe("nonexistent.key.xyz");
  });
  it("accepts uppercase stored language (lowercased internally)", () => {
    expect(t("start.welcome", "EN")).toBe(t("start.welcome", "en"));
  });
  it("substitutes placeholders", () => {
    expect(t("start.welcome", "en", { name: "Bob" })).toContain("Bob");
  });
});

describe("fx (market USDT rate + rounding)", () => {
  it("rounds to the nearest step (half-up)", () => {
    expect(roundRateToStep(new Decimal("16243.7"), 100).toString()).toBe("16200");
    expect(roundRateToStep(new Decimal("16250"), 100).toString()).toBe("16300");
    expect(roundRateToStep(new Decimal("16249.99"), 100).toString()).toBe("16200");
    expect(roundRateToStep(new Decimal("16243.7"), 500).toString()).toBe("16000");
    expect(roundRateToStep(new Decimal("16251"), 500).toString()).toBe("16500");
  });
  it("invalid/zero step returns the rate unrounded", () => {
    expect(roundRateToStep(new Decimal("16243.7"), 0).toString()).toBe("16243.7");
    expect(roundRateToStep(new Decimal("16243.7"), "abc").toString()).toBe("16243.7");
  });
});

describe("validateUsdIdrRate (sanity band + deviation cap — M13 / audit P0-3)", () => {
  const bounds = {
    min: new Decimal("8000"),
    max: new Decimal("40000"),
    maxDeltaPct: new Decimal("5"),
  };

  it("accepts a plausible rate that barely moved", () => {
    expect(validateUsdIdrRate(new Decimal("16300"), new Decimal("16200"), bounds)).toBeNull();
  });

  it("rejects a non-finite rate", () => {
    expect(validateUsdIdrRate(new Decimal(Infinity), null, bounds)).toEqual({ reason: "not_a_number" });
    expect(validateUsdIdrRate(new Decimal(NaN), null, bounds)).toEqual({ reason: "not_a_number" });
  });

  it("rejects zero and negative rates before any band check", () => {
    expect(validateUsdIdrRate(new Decimal("0"), null, bounds)).toEqual({ reason: "not_positive" });
    expect(validateUsdIdrRate(new Decimal("-16200"), null, bounds)).toEqual({ reason: "not_positive" });
  });

  it("rejects a rate below fx_rate_min, naming the bound it failed", () => {
    const failure = validateUsdIdrRate(new Decimal("16.2"), null, bounds);
    expect(failure?.reason).toBe("below_min");
    expect(failure).toMatchObject({ reason: "below_min" });
    expect((failure as { min: Decimal }).min.toString()).toBe("8000");
  });

  it("rejects a rate above fx_rate_max, naming the bound it failed", () => {
    const failure = validateUsdIdrRate(new Decimal("16200000"), null, bounds);
    expect(failure?.reason).toBe("above_max");
    expect((failure as { max: Decimal }).max.toString()).toBe("40000");
  });

  it("accepts the bounds themselves — the band is inclusive", () => {
    expect(validateUsdIdrRate(new Decimal("8000"), null, bounds)).toBeNull();
    expect(validateUsdIdrRate(new Decimal("40000"), null, bounds)).toBeNull();
  });

  it("rejects a move larger than fx_rate_max_delta_pct, reporting the real deviation", () => {
    // 16200 → 17500 is +8.02%, past the 5% cap.
    const failure = validateUsdIdrRate(new Decimal("17500"), new Decimal("16200"), bounds);
    expect(failure?.reason).toBe("delta_too_large");
    const d = failure as { lastKnown: Decimal; deltaPct: Decimal; maxDeltaPct: Decimal };
    expect(d.lastKnown.toString()).toBe("16200");
    expect(d.maxDeltaPct.toString()).toBe("5");
    expect(d.deltaPct.toDecimalPlaces(2).toString()).toBe("8.02");
  });

  // Whole-branch review D10: the band and the deviation cap judge different
  // figures. `refreshUsdIdrRate` bands the post-spread rate it would save but
  // measures the MARKET's move, because a post-spread figure compared against a
  // pre-spread reference measures the spread and deadlocks the refresh.
  it("measures the move of `deltaOf` while banding `rate`", () => {
    // A 10% spread: the saved figure would be 14580, which is 10% off the
    // reference and would trip a 5% cap — but the market did not move at all.
    expect(validateUsdIdrRate(new Decimal("14580"), new Decimal("16200"), bounds, new Decimal("16200"))).toBeNull();
    // The band still judges `rate`, not `deltaOf`: a spread wide enough to push
    // the saved figure under the floor is refused even with a still market.
    expect(
      validateUsdIdrRate(new Decimal("7000"), new Decimal("16200"), bounds, new Decimal("16200"))?.reason,
    ).toBe("below_min");
    // …and a real market move is still caught, reporting the figure that moved.
    const failure = validateUsdIdrRate(
      new Decimal("15750"), // 17500 less a 10% spread — inside the band
      new Decimal("16200"),
      bounds,
      new Decimal("17500"),
    );
    expect(failure?.reason).toBe("delta_too_large");
    const d = failure as { subject: Decimal; deltaPct: Decimal };
    expect(d.subject.toString()).toBe("17500");
    expect(d.deltaPct.toDecimalPlaces(2).toString()).toBe("8.02");
  });

  it("caps a move in EITHER direction, not just upwards", () => {
    expect(validateUsdIdrRate(new Decimal("14000"), new Decimal("16200"), bounds)?.reason).toBe(
      "delta_too_large",
    );
  });

  it("skips the deviation check entirely when there is no last known rate", () => {
    // A first-ever fetch has nothing to deviate FROM — only the band applies.
    expect(validateUsdIdrRate(new Decimal("39000"), null, bounds)).toBeNull();
  });

  it("treats a null/unusable bound as 'that check is not configured', never as a rejection", () => {
    const none = { min: null, max: null, maxDeltaPct: null };
    expect(validateUsdIdrRate(new Decimal("1"), new Decimal("16200"), none)).toBeNull();
    expect(validateUsdIdrRate(new Decimal("99999999"), new Decimal("16200"), none)).toBeNull();
    // …but a non-positive rate is still refused with no bounds at all: that
    // check is arithmetic, not a configurable band.
    expect(validateUsdIdrRate(new Decimal("0"), null, none)).toEqual({ reason: "not_positive" });
  });
});

describe("applyUsdtSpread (protective spread — M13)", () => {
  it("shaves the rate down by the given basis points", () => {
    // 50 bps = 0.5% off 16000 → 15920.
    expect(applyUsdtSpread(new Decimal("16000"), "50").toString()).toBe("15920");
    expect(applyUsdtSpread(new Decimal("16000"), "250").toString()).toBe("15600");
  });

  it("leaves the rate alone for the default zero spread", () => {
    expect(applyUsdtSpread(new Decimal("16243.7"), "0").toString()).toBe("16243.7");
    expect(applyUsdtSpread(new Decimal("16243.7"), "").toString()).toBe("16243.7");
  });

  it("ignores a spread that is negative, unparseable, or large enough to zero the rate", () => {
    expect(applyUsdtSpread(new Decimal("16000"), "-100").toString()).toBe("16000");
    expect(applyUsdtSpread(new Decimal("16000"), "abc").toString()).toBe("16000");
    expect(applyUsdtSpread(new Decimal("16000"), "10000").toString()).toBe("16000");
    expect(applyUsdtSpread(new Decimal("16000"), "12345").toString()).toBe("16000");
  });
});
