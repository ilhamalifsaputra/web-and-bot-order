import { describe, it, expect, beforeEach } from "vitest";
import { rememberCodeEmailed, readCodeEmailed } from "./orderCodeEmailed";

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * jsdom under this repo's Vitest config exposes no `window.sessionStorage` at
 * all — itself one of the shapes this module has to survive — so the tests
 * install a minimal in-memory one, and can swap in a version that throws to
 * stand in for a browser that refuses storage (Safari private mode, a
 * cookie-blocking extension).
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
  Object.defineProperty(window, "sessionStorage", { value: storage, configurable: true });
}

function uninstallStorage(): void {
  Object.defineProperty(window, "sessionStorage", { value: undefined, configurable: true });
}

describe("orderCodeEmailed handoff", () => {
  beforeEach(() => {
    installStorage();
  });

  it("hands the address back to the page that asks for the same order code", () => {
    rememberCodeEmailed("ORD900", "guest@example.com");
    expect(readCodeEmailed("ORD900")).toBe("guest@example.com");
  });

  it("answers the same way every time within one page load", () => {
    // React StrictMode double-invokes render-phase initializers in dev, and a
    // buyer may simply refresh the pay page — neither may turn the notice off.
    rememberCodeEmailed("ORD900", "guest@example.com");
    expect(readCodeEmailed("ORD900")).toBe("guest@example.com");
    expect(readCodeEmailed("ORD900")).toBe("guest@example.com");
  });

  it("refuses to hand the address to a DIFFERENT order's page", () => {
    // Opening some other order in the same tab must never inherit a notice
    // that was written about the order just placed.
    rememberCodeEmailed("ORD900", "guest@example.com");
    expect(readCodeEmailed("ORD901")).toBeNull();
  });

  it("returns null when nothing was ever handed over", () => {
    expect(readCodeEmailed("ORD900")).toBeNull();
  });

  it("survives a browser that refuses storage entirely", () => {
    uninstallStorage();
    expect(() => rememberCodeEmailed("ORD900", "guest@example.com")).not.toThrow();
    expect(readCodeEmailed("ORD900")).toBeNull();
  });

  it("survives a storage that throws on write and on read", () => {
    installStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(() => rememberCodeEmailed("ORD900", "guest@example.com")).not.toThrow();
    expect(readCodeEmailed("ORD900")).toBeNull();
  });

  it("ignores a corrupted entry rather than rendering junk at the buyer", () => {
    window.sessionStorage.setItem("storefront.order_code_emailed", "not json");
    expect(readCodeEmailed("ORD900")).toBeNull();
  });

  it("ignores an entry with no address in it", () => {
    window.sessionStorage.setItem("storefront.order_code_emailed", JSON.stringify({ code: "ORD900" }));
    expect(readCodeEmailed("ORD900")).toBeNull();
  });
});
