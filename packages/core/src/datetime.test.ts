import { describe, it, expect } from "vitest";
import { startOfDayUtc } from "./datetime";

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
