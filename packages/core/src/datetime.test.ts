import { describe, it, expect } from "vitest";
import { startOfDayUtc, parseShopLocal, dayKeyInZone, recentDayWindow } from "./datetime";

describe("startOfDayUtc", () => {
  it("returns local midnight in the given zone, converted to UTC", () => {
    // 2026-06-25T10:00:00Z is 2026-06-25T17:00:00 in Asia/Jakarta (+7) —
    // local midnight that day is 2026-06-24T17:00:00Z.
    const from = new Date("2026-06-25T10:00:00.000Z");
    const result = startOfDayUtc(from, "Asia/Jakarta");
    expect(result.toISOString()).toBe("2026-06-24T17:00:00.000Z");
  });

  it("defaults to config.TIMEZONE (Asia/Jakarta) when no zone is given", () => {
    const from = new Date("2026-06-25T10:00:00.000Z");
    expect(startOfDayUtc(from).toISOString()).toBe("2026-06-24T17:00:00.000Z");
  });
});

describe("dayKeyInZone", () => {
  it("buckets a late-evening UTC instant into the next shop-local day", () => {
    // 2026-03-14T18:30:00Z is 2026-03-15T01:30 in Asia/Jakarta (+7): a WIB
    // shop banked that sale on the 15th, so the daily series must say so.
    // Bucketing on toISOString().slice(0, 10) would have called it the 14th.
    expect(dayKeyInZone(new Date("2026-03-14T18:30:00.000Z"), "Asia/Jakarta")).toBe("2026-03-15");
  });

  it("keeps a late-afternoon UTC instant on the same shop-local day", () => {
    // 2026-03-14T16:30:00Z is 2026-03-14T23:30 in Asia/Jakarta — still the 14th.
    expect(dayKeyInZone(new Date("2026-03-14T16:30:00.000Z"), "Asia/Jakarta")).toBe("2026-03-14");
  });

  it("defaults to config.TIMEZONE (Asia/Jakarta) when no zone is given", () => {
    expect(dayKeyInZone(new Date("2026-03-14T18:30:00.000Z"))).toBe("2026-03-15");
  });

  it("uses the zone's offset on that date rather than a fixed one", () => {
    // Same wall-clock UTC time, either side of the 2026-03-08 US DST switch:
    // 04:30Z is 23:30 on the 6th under EST (-5) but 00:30 on the 21st under
    // EDT (-4), so a hardcoded offset would misfile one of the two.
    expect(dayKeyInZone(new Date("2026-03-07T04:30:00.000Z"), "America/New_York")).toBe("2026-03-06");
    expect(dayKeyInZone(new Date("2026-03-21T04:30:00.000Z"), "America/New_York")).toBe("2026-03-21");
  });
});

describe("recentDayWindow", () => {
  it("starts at shop-local midnight of the oldest day and keys every day up to today", () => {
    const window = recentDayWindow(3, new Date("2026-03-15T10:00:00.000Z"), "Asia/Jakarta");
    expect(window.keys).toEqual(["2026-03-13", "2026-03-14", "2026-03-15"]);
    // 2026-03-13T00:00 in Asia/Jakarta (+7) is 2026-03-12T17:00:00Z — NOT
    // 2026-03-13T00:00:00Z, or the first bucket would be missing its first
    // seven local hours.
    expect(window.since.toISOString()).toBe("2026-03-12T17:00:00.000Z");
  });

  it("returns one whole local day for days = 1", () => {
    const window = recentDayWindow(1, new Date("2026-03-15T10:00:00.000Z"), "Asia/Jakarta");
    expect(window.keys).toEqual(["2026-03-15"]);
    expect(window.since.toISOString()).toBe("2026-03-14T17:00:00.000Z");
  });

  it("steps through the zone's own calendar so a DST transition neither duplicates nor skips a day", () => {
    // America/New_York falls back on 2026-11-01. Advancing the oldest day's
    // midnight by a flat 86_400_000 ms per step would emit "2026-11-01" twice
    // and never reach "2026-11-03", because the extra hour shifts every
    // subsequent step an hour earlier in local time.
    const window = recentDayWindow(5, new Date("2026-11-03T16:00:00.000Z"), "America/New_York");
    expect(window.keys).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
    // 2026-10-30T00:00 is still EDT (-4), so midnight there is 04:00:00Z.
    expect(window.since.toISOString()).toBe("2026-10-30T04:00:00.000Z");
  });

  it("truncates a fractional day count so the window still starts on a local midnight", () => {
    const from = new Date("2026-03-15T10:00:00.000Z");
    expect(recentDayWindow(7.5, from, "Asia/Jakarta")).toEqual(recentDayWindow(7, from, "Asia/Jakarta"));
  });

  it("treats zero, negative and non-finite day counts as a single day instead of throwing or looping", () => {
    const from = new Date("2026-03-15T10:00:00.000Z");
    const one = recentDayWindow(1, from, "Asia/Jakarta");
    for (const bad of [0, -3, 0.4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(recentDayWindow(bad, from, "Asia/Jakarta")).toEqual(one);
    }
  });

  it("defaults `from` to now and `zone` to config.TIMEZONE, ending on today's shop-local day", () => {
    const window = recentDayWindow(7);
    expect(window.keys).toHaveLength(7);
    expect(window.keys.at(-1)).toBe(dayKeyInZone(new Date()));
    expect(window.since.getTime()).toBeLessThan(startOfDayUtc().getTime());
  });
});

describe("parseShopLocal", () => {
  it("reads a bare datetime-local value as shop-local wall clock", () => {
    // 21:00 in Asia/Jakarta (+7) is 14:00 UTC — an admin typing 9pm means 9pm
    // in the timezone the whole panel displays.
    expect(parseShopLocal("2026-07-20T21:00")!.toISOString()).toBe("2026-07-20T14:00:00.000Z");
  });

  it("honours an explicit offset or Z instead of re-interpreting it", () => {
    expect(parseShopLocal("2026-07-20T14:00:00Z")!.toISOString()).toBe("2026-07-20T14:00:00.000Z");
    expect(parseShopLocal("2026-07-20T21:00:00+07:00")!.toISOString()).toBe("2026-07-20T14:00:00.000Z");
  });

  it("accepts an explicit zone override", () => {
    expect(parseShopLocal("2026-07-20T21:00", "UTC")!.toISOString()).toBe("2026-07-20T21:00:00.000Z");
  });

  it("returns null for blank or unparseable input", () => {
    expect(parseShopLocal("")).toBeNull();
    expect(parseShopLocal("   ")).toBeNull();
    expect(parseShopLocal("not a date")).toBeNull();
  });

  it("resolves a bare YYYY-MM-DD date to shop-local start of day (voucher start_at convention)", () => {
    // apps/web-admin/src/routes/api/vouchers.ts calls parseShopLocal(raw) directly
    // for start_at: a bare date defaults to midnight in config.TIMEZONE
    // (Asia/Jakarta, +7), i.e. 2026-07-27T17:00:00Z, not UTC midnight.
    expect(parseShopLocal("2026-07-28")!.toISOString()).toBe("2026-07-27T17:00:00.000Z");
  });

  it("resolves a YYYY-MM-DDT23:59:59 date to shop-local end of day (voucher expires_at convention)", () => {
    // apps/web-admin/src/routes/api/vouchers.ts calls parseShopLocal(`${raw}T23:59:59`)
    // for expires_at, so the voucher stays valid through the whole selected
    // shop-local day: 23:59:59 in Asia/Jakarta (+7) is 16:59:59 UTC the same day.
    expect(parseShopLocal("2026-07-28T23:59:59")!.toISOString()).toBe("2026-07-28T16:59:59.000Z");
  });
});
