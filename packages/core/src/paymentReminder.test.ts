import { describe, expect, it } from "vitest";
import { PAYMENT_REMINDER_MIN_REMAINING_MS, orderExpiredDedupeKey, paymentReminderDedupeKey, paymentReminderMinutesLeft } from "./paymentReminder";

describe("payment reminder timing", () => {
  const now = new Date("2026-10-24T07:00:00.000Z");
  const at = (ms: number) => new Date(now.getTime() + ms);

  it("rounds the minutes left down, so the buyer is never told they have more time than they do", () => {
    expect(paymentReminderMinutesLeft(at(5 * 60_000), now)).toBe(5);
    expect(paymentReminderMinutesLeft(at(4 * 60_000 + 59_000), now)).toBe(4);
    expect(paymentReminderMinutesLeft(at(90_000), now)).toBe(1);
  });

  it("never reports fewer than one minute", () => {
    expect(paymentReminderMinutesLeft(at(10_000), now)).toBe(1);
    expect(paymentReminderMinutesLeft(at(-10_000), now)).toBe(1);
  });

  it("keeps a full minute of margin before the window closes", () => {
    expect(PAYMENT_REMINDER_MIN_REMAINING_MS).toBe(60_000);
  });

  it("keys the outbox row by order so a reminder is queued at most once per order", () => {
    expect(paymentReminderDedupeKey(42)).toBe("payment_reminder:42");
  });

  it("keys the expiry push by order too, in a namespace of its own", () => {
    expect(orderExpiredDedupeKey(42)).toBe("order_expired:42");
    expect(orderExpiredDedupeKey(42)).not.toBe(paymentReminderDedupeKey(42));
  });
});
