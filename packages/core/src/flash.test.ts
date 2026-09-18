import { describe, it, expect } from "vitest";
import { activeFlashPercent, isFlashActive, flashPrice, effectiveUnitPrice } from "./flash";
import { Decimal } from "./money";

const START = new Date("2026-07-20T10:00:00Z");
const END = new Date("2026-07-20T22:00:00Z");
const DURING = new Date("2026-07-20T15:00:00Z");

/** A 20%-off flash sale on a Rp10.000 SKU, no reseller price unless given. */
const sku = (over: Partial<Parameters<typeof effectiveUnitPrice>[0]> = {}) => ({
  price: "10000",
  resellerPrice: null,
  flashDiscountPercent: "20",
  flashStartsAt: START,
  flashEndsAt: END,
  ...over,
});

describe("activeFlashPercent", () => {
  it("is null before the window opens and after it closes", () => {
    expect(activeFlashPercent(sku(), new Date("2026-07-20T09:59:59Z"))).toBeNull();
    expect(activeFlashPercent(sku(), new Date("2026-07-20T22:00:01Z"))).toBeNull();
  });

  it("treats the window as half-open — live at the start instant, over at the end instant", () => {
    expect(activeFlashPercent(sku(), START)?.toString()).toBe("20");
    expect(activeFlashPercent(sku(), END)).toBeNull();
  });

  it("is null unless all three columns are set", () => {
    expect(activeFlashPercent(sku({ flashDiscountPercent: null }), DURING)).toBeNull();
    expect(activeFlashPercent(sku({ flashStartsAt: null }), DURING)).toBeNull();
    expect(activeFlashPercent(sku({ flashEndsAt: null }), DURING)).toBeNull();
  });

  it("rejects a percent outside (0,100] so a bad row can never zero out a price", () => {
    expect(activeFlashPercent(sku({ flashDiscountPercent: "0" }), DURING)).toBeNull();
    expect(activeFlashPercent(sku({ flashDiscountPercent: "-5" }), DURING)).toBeNull();
    expect(activeFlashPercent(sku({ flashDiscountPercent: "100.01" }), DURING)).toBeNull();
    expect(activeFlashPercent(sku({ flashDiscountPercent: "not a number" }), DURING)).toBeNull();
    // 100% off is a legitimate giveaway, so it stays allowed.
    expect(activeFlashPercent(sku({ flashDiscountPercent: "100" }), DURING)?.toString()).toBe("100");
  });

  it("isFlashActive mirrors it as a boolean", () => {
    expect(isFlashActive(sku(), DURING)).toBe(true);
    expect(isFlashActive(sku(), END)).toBe(false);
  });
});

describe("flashPrice", () => {
  it("applies the percent to the base price, rounded to whole rupiah", () => {
    expect(flashPrice(sku(), DURING)!.toString()).toBe("8000");
    expect(flashPrice(sku({ flashDiscountPercent: "33" }), DURING)!.toString()).toBe("6700");
    // 10001 × 67% = 6700.67 — quantized to whole rupiah (half-up), because
    // prices are central-IDR and the IDR rail charges whole rupiah. Sub-rupiah
    // cents here made per-line figures and the charged total disagree.
    expect(flashPrice(sku({ price: "10001", flashDiscountPercent: "33" }), DURING)!.toString()).toBe("6701");
    expect(flashPrice(sku({ price: "10000", flashDiscountPercent: "33.33" }), DURING)!.toString()).toBe("6667");
  });

  it("ignores resellerPrice — it is the everyone price the UI strikes through", () => {
    expect(flashPrice(sku({ resellerPrice: "5000" }), DURING)!.toString()).toBe("8000");
  });

  it("is null with no live sale", () => {
    expect(flashPrice(sku(), END)).toBeNull();
  });
});

/**
 * Run `body` with the process timezone set to `tz`, restoring whatever the
 * box was running under afterwards (undefined included — deleting the key is
 * not the same as setting it to the string "undefined").
 *
 * There is no global TZ convention in this suite to reuse (tests/helpers has
 * none, and vitest.config.ts sets no TZ), so the switch is scoped to the
 * cases that need it rather than imposed on the whole file. Node honours a
 * mid-process `process.env.TZ` assignment for every Date created afterwards,
 * which is what makes this observable at all.
 */
function withTz<T>(tz: string, body: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/** +14: the earliest local calendar day on earth. */
const TZ_AHEAD = "Pacific/Kiritimati";
/** -12: the latest. Paired with TZ_AHEAD these straddle the date line, so any
 * comparison that leaked into local calendar fields would disagree between
 * them for at least one of the instants below. */
const TZ_BEHIND = "Etc/GMT+12";

describe("flash windows are timezone-independent", () => {
  // Guard for the guard: if the TZ switch ever stopped taking effect (a Node
  // change, a bundler freezing the zone at load, a stray global TZ), every
  // assertion below would keep passing while proving nothing. This case fails
  // loudly in that situation.
  it("the TZ switch really does move the local clock across the date line", () => {
    const ahead = withTz(TZ_AHEAD, () => new Date("2026-07-20T15:00:00Z").toString());
    const behind = withTz(TZ_BEHIND, () => new Date("2026-07-20T15:00:00Z").toString());
    expect(ahead).not.toBe(behind);
    // Not just a different hour — a different local calendar date (21st vs 20th).
    expect(withTz(TZ_AHEAD, () => new Date("2026-07-20T15:00:00Z").getDate())).toBe(21);
    expect(withTz(TZ_BEHIND, () => new Date("2026-07-20T15:00:00Z").getDate())).toBe(20);
  });

  it("gives the same verdict for the same instant under either extreme", () => {
    // `now < flashStartsAt || now >= flashEndsAt` compares two Date objects,
    // which JS resolves through valueOf() — the UTC epoch millisecond. TZ only
    // reaches Date FORMATTING (toString/getHours/getDate, as above), never
    // relational comparison, so the window verdict cannot depend on where the
    // server thinks it is.
    for (const tz of [TZ_AHEAD, TZ_BEHIND]) {
      withTz(tz, () => {
        expect(activeFlashPercent(sku(), DURING)?.toString()).toBe("20");
        expect(activeFlashPercent(sku(), START)?.toString()).toBe("20");
        expect(activeFlashPercent(sku(), new Date("2026-07-20T09:59:59Z"))).toBeNull();
        expect(activeFlashPercent(sku(), END)).toBeNull();
        expect(isFlashActive(sku(), DURING)).toBe(true);
        expect(isFlashActive(sku(), END)).toBe(false);
      });
    }
  });

  it("holds for a window that straddles midnight UTC, where the two zones disagree about the day", () => {
    // 22:00Z–02:00Z: under +14 the whole sale sits on the NEXT local day, under
    // -12 on the PREVIOUS one. A comparison done on local calendar fields would
    // place `now` outside the window in at least one of them.
    const overnight = sku({
      flashStartsAt: new Date("2026-07-20T22:00:00Z"),
      flashEndsAt: new Date("2026-07-21T02:00:00Z"),
    });
    const inside = new Date("2026-07-21T00:30:00Z");
    const before = new Date("2026-07-20T21:59:59Z");
    const after = new Date("2026-07-21T02:00:00Z");
    for (const tz of [TZ_AHEAD, TZ_BEHIND]) {
      withTz(tz, () => {
        expect(isFlashActive(overnight, inside)).toBe(true);
        expect(isFlashActive(overnight, before)).toBe(false);
        expect(isFlashActive(overnight, after)).toBe(false);
      });
    }
  });

  it("prices a live sale identically under either extreme", () => {
    for (const tz of [TZ_AHEAD, TZ_BEHIND]) {
      withTz(tz, () => {
        expect(flashPrice(sku(), DURING)!.toString()).toBe("8000");
        expect(flashPrice(sku(), END)).toBeNull();
        expect(effectiveUnitPrice(sku(), false, DURING).toString()).toBe("8000");
        expect(effectiveUnitPrice(sku(), false, END).toString()).toBe("10000");
      });
    }
  });
});

describe("effectiveUnitPrice", () => {
  it("without a flash sale, behaves exactly like the old inline rule", () => {
    const plain = sku({ flashDiscountPercent: null, resellerPrice: "7000" });
    expect(effectiveUnitPrice(plain, false, DURING).toString()).toBe("10000");
    expect(effectiveUnitPrice(plain, true, DURING).toString()).toBe("7000");
    expect(effectiveUnitPrice({ ...plain, resellerPrice: null }, true, DURING).toString()).toBe("10000");
  });

  it("charges a regular buyer the flash price while the sale runs", () => {
    expect(effectiveUnitPrice(sku(), false, DURING).toString()).toBe("8000");
    expect(effectiveUnitPrice(sku(), false, END).toString()).toBe("10000");
  });

  it("gives a reseller whichever of resellerPrice and the flash price is cheaper", () => {
    // Reseller price already beats the sale — keep it.
    expect(effectiveUnitPrice(sku({ resellerPrice: "7000" }), true, DURING).toString()).toBe("7000");
    // The sale beats the reseller price — the reseller gets the sale.
    expect(effectiveUnitPrice(sku({ resellerPrice: "9000" }), true, DURING).toString()).toBe("8000");
  });

  it("never compounds the two discounts", () => {
    const price = effectiveUnitPrice(sku({ resellerPrice: "9000" }), true, DURING);
    expect(price.greaterThanOrEqualTo(new Decimal("8000"))).toBe(true);
  });
});
