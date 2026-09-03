import { describe, it, expect, beforeEach } from "vitest";
import { RECENT_KEY, clearRecent, pushRecent, readRecent } from "./recentSearches";

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * jsdom under this repo's Vitest config exposes no `window.localStorage` at all
 * — itself one of the shapes the helper must survive — so each test installs a
 * minimal in-memory one, or a throwing one to stand in for Safari private mode.
 */
function installStorage(overrides: Partial<FakeStorage> = {}): void {
  const entries = new Map<string, string>();
  const storage: FakeStorage = {
    getItem: (key) => (entries.has(key) ? entries.get(key)! : null),
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    ...overrides,
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

describe("recentSearches", () => {
  beforeEach(() => {
    installStorage();
  });

  it("reads an empty history when nothing is stored", () => {
    expect(readRecent()).toEqual([]);
  });

  it("pushes a term to the front and persists it", () => {
    expect(pushRecent("netflix")).toEqual(["netflix"]);
    expect(JSON.parse(window.localStorage.getItem(RECENT_KEY)!)).toEqual(["netflix"]);
  });

  it("dedupes case-insensitively, moving the existing term to the front", () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["alpha", "beta", "gamma"]));
    expect(pushRecent("BETA")).toEqual(["BETA", "alpha", "gamma"]);
  });

  it("caps the history at five, dropping the oldest", () => {
    window.localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(["alpha", "beta", "gamma", "delta", "epsilon"]),
    );
    expect(pushRecent("zeta")).toEqual(["zeta", "alpha", "beta", "gamma", "delta"]);
  });

  it("ignores a blank term and returns the current list unchanged", () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["alpha"]));
    expect(pushRecent("   ")).toEqual(["alpha"]);
  });

  it("clears both the returned list and storage", () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(["alpha", "beta"]));
    clearRecent();
    expect(window.localStorage.getItem(RECENT_KEY)).toBeNull();
    expect(readRecent()).toEqual([]);
  });

  it("degrades to no-history when storage throws on read and write (Safari private mode)", () => {
    installStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(readRecent()).toEqual([]);
    expect(() => pushRecent("netflix")).not.toThrow();
    expect(() => clearRecent()).not.toThrow();
  });

  it("tolerates a corrupt stored value", () => {
    window.localStorage.setItem(RECENT_KEY, "{not json");
    expect(readRecent()).toEqual([]);
  });
});
