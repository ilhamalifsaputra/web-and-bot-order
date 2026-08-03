// Task 3 (guest checkout): two per-IP throttles for the guest-facing paths
// that Tasks 1/2 opened up.
//
// 1. Guest checkout creates a brand-new `User` row per order, so the
//    existing MAX_PENDING_ORDERS=10 per-user cap (checkout.ts,
//    countUserPendingOrders) never bites for a guest — every checkout starts
//    a fresh user with zero pending orders. guestCheckoutRateLimited(ip)
//    fills that gap with a per-IP cap instead.
// 2. The (not-yet-built) order-tracking endpoint validates an order code +
//    email pair; without a throttle it's an oracle an attacker can use to
//    brute-force order codes. trackLookupRateLimited(ip) caps that.
//
// Pure unit tests against the rateLimit module — no app/DB wiring needed,
// since these two functions aren't called from any route yet. Uses Vitest
// fake timers (the throttles are time-based sliding windows) instead of real
// sleeps.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTestDb } from "./setup-env";
import {
  guestCheckoutRateLimited,
  trackLookupRateLimited,
  GUEST_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS,
  GUEST_CHECKOUT_RATE_LIMIT_MAX,
  TRACK_LOOKUP_RATE_LIMIT_WINDOW_SECONDS,
  TRACK_LOOKUP_RATE_LIMIT_MAX,
} from "../src/rateLimit";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  cleanupTestDb();
});

describe("guestCheckoutRateLimited", () => {
  it("allows GUEST_CHECKOUT_RATE_LIMIT_MAX calls then blocks the next one", () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < GUEST_CHECKOUT_RATE_LIMIT_MAX; i++) {
      expect(guestCheckoutRateLimited(ip)).toBe(false);
    }
    expect(guestCheckoutRateLimited(ip)).toBe(true);
  });

  it("lets the IP through again once the window has fully elapsed", () => {
    const ip = "1.2.3.5";
    for (let i = 0; i < GUEST_CHECKOUT_RATE_LIMIT_MAX; i++) {
      expect(guestCheckoutRateLimited(ip)).toBe(false);
    }
    expect(guestCheckoutRateLimited(ip)).toBe(true); // now capped

    vi.advanceTimersByTime((GUEST_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS + 1) * 1000);

    expect(guestCheckoutRateLimited(ip)).toBe(false); // window has shifted
  });

  it("gives a second IP its own, unexhausted quota", () => {
    const ipA = "1.2.3.6";
    const ipB = "1.2.3.7";
    for (let i = 0; i < GUEST_CHECKOUT_RATE_LIMIT_MAX; i++) {
      expect(guestCheckoutRateLimited(ipA)).toBe(false);
    }
    expect(guestCheckoutRateLimited(ipA)).toBe(true); // ipA capped
    expect(guestCheckoutRateLimited(ipB)).toBe(false); // ipB untouched
  });
});

describe("trackLookupRateLimited", () => {
  it("allows TRACK_LOOKUP_RATE_LIMIT_MAX calls then blocks the next one", () => {
    const ip = "5.6.7.8";
    for (let i = 0; i < TRACK_LOOKUP_RATE_LIMIT_MAX; i++) {
      expect(trackLookupRateLimited(ip)).toBe(false);
    }
    expect(trackLookupRateLimited(ip)).toBe(true);
  });

  it("lets the IP through again once the window has fully elapsed", () => {
    const ip = "5.6.7.9";
    for (let i = 0; i < TRACK_LOOKUP_RATE_LIMIT_MAX; i++) {
      expect(trackLookupRateLimited(ip)).toBe(false);
    }
    expect(trackLookupRateLimited(ip)).toBe(true); // now capped

    vi.advanceTimersByTime((TRACK_LOOKUP_RATE_LIMIT_WINDOW_SECONDS + 1) * 1000);

    expect(trackLookupRateLimited(ip)).toBe(false); // window has shifted
  });

  it("gives a second IP its own, unexhausted quota", () => {
    const ipA = "5.6.7.10";
    const ipB = "5.6.7.11";
    for (let i = 0; i < TRACK_LOOKUP_RATE_LIMIT_MAX; i++) {
      expect(trackLookupRateLimited(ipA)).toBe(false);
    }
    expect(trackLookupRateLimited(ipA)).toBe(true); // ipA capped
    expect(trackLookupRateLimited(ipB)).toBe(false); // ipB untouched
  });
});

describe("guestCheckoutRateLimited and trackLookupRateLimited are independent", () => {
  it("exhausting the checkout quota for an IP doesn't touch that IP's track-lookup quota", () => {
    const ip = "9.9.9.1";
    for (let i = 0; i < GUEST_CHECKOUT_RATE_LIMIT_MAX; i++) {
      expect(guestCheckoutRateLimited(ip)).toBe(false);
    }
    expect(guestCheckoutRateLimited(ip)).toBe(true); // checkout quota exhausted

    // Track-lookup quota for the SAME ip is untouched.
    expect(trackLookupRateLimited(ip)).toBe(false);
  });

  it("exhausting the track-lookup quota for an IP doesn't touch that IP's checkout quota", () => {
    const ip = "9.9.9.2";
    for (let i = 0; i < TRACK_LOOKUP_RATE_LIMIT_MAX; i++) {
      expect(trackLookupRateLimited(ip)).toBe(false);
    }
    expect(trackLookupRateLimited(ip)).toBe(true); // track-lookup quota exhausted

    // Checkout quota for the SAME ip is untouched.
    expect(guestCheckoutRateLimited(ip)).toBe(false);
  });
});
