import { describe, it, expect, vi, afterEach } from "vitest";
import { peekWarmUser, primeWarmUser, invalidateWarmUser, pruneWarmUserCache, cacheSize } from "./warmUserCache";

function sampleSnap(overrides: Partial<Parameters<typeof primeWarmUser>[1]> = {}) {
  return {
    id: 1,
    username: "alice",
    fullName: "Alice A",
    role: "CUSTOMER",
    language: "EN",
    referralCode: "ABC123",
    walletBalance: "0",
    banned: false,
    bannedReason: null,
    preferredCurrency: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("warmUserCache", () => {
  it("returns undefined on a miss", () => {
    expect(peekWarmUser("no-such-user")).toBeUndefined();
  });

  it("returns the primed snapshot on a hit", () => {
    primeWarmUser("111", sampleSnap({ id: 111 }));
    const snap = peekWarmUser("111");
    expect(snap?.id).toBe(111);
    expect(snap?.username).toBe("alice");
    expect(snap?.telegramId).toBe("111");
  });

  it("expires after the TTL window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    primeWarmUser("222", sampleSnap({ id: 222 }));
    expect(peekWarmUser("222")).toBeDefined();

    vi.setSystemTime(6 * 60 * 1000); // past the 5-minute TTL
    expect(peekWarmUser("222")).toBeUndefined();
  });

  it("invalidateWarmUser evicts the entry by DB id, not by telegramId", () => {
    primeWarmUser("333", sampleSnap({ id: 333 }));
    expect(peekWarmUser("333")).toBeDefined();

    invalidateWarmUser(333);
    expect(peekWarmUser("333")).toBeUndefined();
  });

  it("invalidateWarmUser on an unrelated id is a no-op", () => {
    primeWarmUser("444", sampleSnap({ id: 444 }));
    invalidateWarmUser(999);
    expect(peekWarmUser("444")).toBeDefined();
  });

  it("pruneWarmUserCache reclaims an entry whose TTL elapsed without it ever being read again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    primeWarmUser("555", sampleSnap({ id: 555 }));
    const sizeBefore = cacheSize();

    // Past the 5-minute TTL, but never read via peekWarmUser (which would
    // have lazily evicted it itself) — only pruneWarmUserCache touches it.
    vi.setSystemTime(6 * 60 * 1000);
    pruneWarmUserCache();

    expect(cacheSize()).toBe(sizeBefore - 1);
    expect(peekWarmUser("555")).toBeUndefined();
  });

  it("pruneWarmUserCache leaves an unexpired entry alone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    primeWarmUser("666", sampleSnap({ id: 666 }));

    pruneWarmUserCache(); // runs immediately, well within the TTL

    expect(peekWarmUser("666")).toBeDefined();
  });
});
