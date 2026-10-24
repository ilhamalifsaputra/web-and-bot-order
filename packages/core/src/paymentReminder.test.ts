import { describe, expect, it } from "vitest";
import {
  PAYMENT_REMINDER_MIN_REMAINING_MS,
  awaitingPaymentNothingObserved,
  orderExpiredDedupeKey,
  paymentReminderDedupeKey,
  paymentReminderHasTimeLeft,
  paymentReminderMinutesLeft,
} from "./paymentReminder";

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

  it("uses one comparator for the floor, so a row queued with exactly a minute left is still sent", () => {
    expect(paymentReminderHasTimeLeft(at(PAYMENT_REMINDER_MIN_REMAINING_MS), now)).toBe(true);
    expect(paymentReminderHasTimeLeft(at(PAYMENT_REMINDER_MIN_REMAINING_MS - 1), now)).toBe(false);
    expect(paymentReminderHasTimeLeft(at(-1), now)).toBe(false);
  });

  it("keys the outbox row by order so a reminder is queued at most once per order", () => {
    expect(paymentReminderDedupeKey(42)).toBe("payment_reminder:42");
  });

  it("keys the expiry push by order too, in a namespace of its own", () => {
    expect(orderExpiredDedupeKey(42)).toBe("order_expired:42");
    expect(orderExpiredDedupeKey(42)).not.toBe(paymentReminderDedupeKey(42));
  });
});

/**
 * Only an order on which no payment has been observed at all may be told
 * "N minutes left to pay". A buyer whose transfer the provider already saw
 * (detected, verifying, short, failed...) and who then reads that the order
 * will be cancelled may pay a second time.
 */
describe("awaitingPaymentNothingObserved", () => {
  const order = (over: Partial<{ paymentState: string | null; paidAt: Date | null; walletCreditState: string | null }> = {}) => ({
    paymentState: null, paidAt: null, walletCreditState: null, ...over,
  });

  it.each([null, "WAITING_PAYMENT"])("treats payment state %s as nothing observed yet", (paymentState) => {
    expect(awaitingPaymentNothingObserved(order({ paymentState }))).toBe(true);
  });

  it.each(["PAYMENT_DETECTED", "VERIFYING", "PAID", "UNDERPAID", "FAILED", "EXPIRED", "REFUNDED", "SOMETHING_NEW"])(
    "treats payment state %s as a payment already seen",
    (paymentState) => {
      expect(awaitingPaymentNothingObserved(order({ paymentState }))).toBe(false);
    },
  );

  it("treats a paid-at stamp or a wallet credit awaiting review as a payment already seen", () => {
    expect(awaitingPaymentNothingObserved(order({ paidAt: new Date() }))).toBe(false);
    expect(awaitingPaymentNothingObserved(order({ paymentState: "WAITING_PAYMENT", walletCreditState: "NEEDS_REVIEW" }))).toBe(false);
    expect(awaitingPaymentNothingObserved(order({ walletCreditState: "PENDING" }))).toBe(true);
  });
});
