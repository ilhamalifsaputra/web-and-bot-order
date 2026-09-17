import { describe, it, expect } from "vitest";
import { money, fmtMoney, moneyEq, Decimal } from "./money";
import { t } from "./i18n";
import { fetchUsdIdrMarketRate, roundRateToStep, validateUsdIdrRate, applyUsdtSpread } from "./fx";
import { OrderStatus, UserRole, NotificationEvent, langCode } from "./enums";
import { computeUniqueCents } from "./formatters";

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
  it("parses the er-api payload", async () => {
    const fake = (async () => ({
      ok: true,
      json: async () => ({ result: "success", rates: { IDR: 16234.55 } }),
    })) as unknown as typeof fetch;
    expect((await fetchUsdIdrMarketRate(fake)).toString()).toBe("16234.55");
  });
  it("rejects bad payloads and HTTP errors", async () => {
    const bad = (async () => ({ ok: true, json: async () => ({ result: "success", rates: {} }) })) as unknown as typeof fetch;
    await expect(fetchUsdIdrMarketRate(bad)).rejects.toThrow();
    const http500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(fetchUsdIdrMarketRate(http500)).rejects.toThrow();
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
