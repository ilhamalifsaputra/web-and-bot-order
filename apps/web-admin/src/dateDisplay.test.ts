import { describe, it, expect } from "vitest";
import { displayDateTime, displayDate } from "./dateDisplay";

describe("displayDateTime", () => {
  it("returns null for null", () => {
    expect(displayDateTime(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(displayDateTime(undefined)).toBeNull();
  });

  it("formats a real Date as 'yyyy-LL-dd HH:mm' in config.TIMEZONE (Asia/Jakarta, +7)", () => {
    const d = new Date("2026-06-25T10:00:00.000Z");
    expect(displayDateTime(d)).toBe("2026-06-25 17:00");
  });
});

describe("displayDate", () => {
  it("returns null for null", () => {
    expect(displayDate(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(displayDate(undefined)).toBeNull();
  });

  it("formats a real Date as 'yyyy-LL-dd' in config.TIMEZONE (Asia/Jakarta, +7)", () => {
    const d = new Date("2026-06-25T10:00:00.000Z");
    expect(displayDate(d)).toBe("2026-06-25");
  });
});
