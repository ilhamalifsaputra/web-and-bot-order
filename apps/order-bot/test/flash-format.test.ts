/**
 * formatFlashRemaining — the "time left" string on the bot's flash-sale line.
 * A bot message can't tick, so this is deliberately coarse; these lock in that
 * it never renders a negative or a misleading precision.
 */
import { describe, it, expect } from "vitest";
import { formatFlashRemaining } from "../src/util/format";

const NOW = new Date("2026-07-20T10:00:00.000Z");
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

describe("formatFlashRemaining", () => {
  it("renders days and hours for a multi-day sale", () => {
    expect(formatFlashRemaining(inMinutes(2 * 1440 + 5 * 60 + 30), NOW)).toBe("2d 5h");
  });

  it("renders hours and minutes under a day", () => {
    expect(formatFlashRemaining(inMinutes(5 * 60 + 12), NOW)).toBe("5h 12m");
  });

  it("renders bare minutes under an hour", () => {
    expect(formatFlashRemaining(inMinutes(12), NOW)).toBe("12m");
  });

  it("collapses anything under a minute — including an already-passed end — to <1m", () => {
    expect(formatFlashRemaining(inMinutes(0.5), NOW)).toBe("<1m");
    expect(formatFlashRemaining(NOW, NOW)).toBe("<1m");
    expect(formatFlashRemaining(inMinutes(-90), NOW)).toBe("<1m");
  });
});
