/// <reference lib="dom" />
import { describe, it, expect, afterEach } from "vitest";
import { formatRelativeTime } from "./formatRelativeTime";

afterEach(() => {
  document.documentElement.lang = "";
});

describe("formatRelativeTime", () => {
  it("formats a timestamp ~2h in the past as hours ago (en)", () => {
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const iso = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toContain("2 hours ago");
  });

  it("formats a timestamp ~3 days in the past as days ago (en)", () => {
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const iso = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toContain("3 days ago");
  });

  it("formats a timestamp ~30 seconds in the past as seconds ago (en)", () => {
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const iso = new Date(now - 30 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toContain("30 seconds ago");
  });

  it("returns an empty string for unparseable input", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
  });

  it("respects a fixed now argument (determinism)", () => {
    const fixedNow = Date.parse("2020-01-01T00:00:10.000Z");
    const iso = "2020-01-01T00:00:00.000Z";
    expect(formatRelativeTime(iso, fixedNow)).toContain("10 seconds ago");
  });
});
