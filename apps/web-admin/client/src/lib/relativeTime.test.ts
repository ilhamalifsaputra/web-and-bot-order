import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "./relativeTime";

describe("formatRelativeTime", () => {
  const baseTime = new Date("2024-01-15T12:00:00Z");
  const display = "January 15, 2024";

  it("returns 'Just now' for timestamps less than 60 seconds ago", () => {
    const iso = new Date(baseTime.getTime() - 30_000).toISOString();
    expect(formatRelativeTime(iso, display, baseTime)).toBe("Just now");
  });

  it("returns minutes ago format for timestamps between 1 and 59 minutes ago", () => {
    const iso = new Date(baseTime.getTime() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(iso, display, baseTime)).toBe("5 minutes ago");
  });

  it("returns singular minute for 1 minute ago", () => {
    const iso = new Date(baseTime.getTime() - 60_000).toISOString();
    expect(formatRelativeTime(iso, display, baseTime)).toBe("1 minute ago");
  });

  it("returns hours ago format for timestamps between 1 and 23 hours ago", () => {
    const iso = new Date(baseTime.getTime() - 2 * 3_600_000).toISOString();
    expect(formatRelativeTime(iso, display, baseTime)).toBe("2 hours ago");
  });

  it("returns singular hour for 1 hour ago", () => {
    const iso = new Date(baseTime.getTime() - 3_600_000).toISOString();
    expect(formatRelativeTime(iso, display, baseTime)).toBe("1 hour ago");
  });

  it("returns 'Yesterday' for exactly 1 day ago", () => {
    const iso = new Date(baseTime.getTime() - 86_400_000).toISOString();
    expect(formatRelativeTime(iso, display, baseTime)).toBe("Yesterday");
  });

  it("returns days ago format for timestamps between 2 and 29 days ago", () => {
    const iso = new Date(baseTime.getTime() - 5 * 86_400_000).toISOString();
    expect(formatRelativeTime(iso, display, baseTime)).toBe("5 days ago");
  });

  it("returns display string for 31 days ago", () => {
    const iso = new Date(baseTime.getTime() - 31 * 86_400_000).toISOString();
    expect(formatRelativeTime(iso, display, baseTime)).toBe(display);
  });

  it("clamps future timestamps to 'Just now'", () => {
    const iso = new Date(baseTime.getTime() + 10_000).toISOString();
    expect(formatRelativeTime(iso, display, baseTime)).toBe("Just now");
  });

  it("returns display string for invalid ISO timestamps", () => {
    expect(formatRelativeTime("invalid-date", display, baseTime)).toBe(display);
  });
});
