import { describe, it, expect } from "vitest";
import { startOfDayUtc, parseShopLocal } from "./datetime";

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
