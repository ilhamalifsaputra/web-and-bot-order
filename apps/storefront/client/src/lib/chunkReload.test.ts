import { describe, it, expect, beforeEach, vi } from "vitest";
import { installStaleChunkReload, isChunkLoadError, reloadOnceForStaleChunk } from "./chunkReload";

function installStorage(overrides: Partial<Storage> = {}): void {
  const entries = new Map<string, string>();
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => entries.get(k) ?? null,
      setItem: (k: string, v: string) => { entries.set(k, v); },
      removeItem: (k: string) => { entries.delete(k); },
      ...overrides,
    },
  });
}

describe("stale chunk recovery (H6)", () => {
  beforeEach(() => installStorage());

  it("recognises the browsers' failed-import errors and nothing else", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /assets/x.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
  });

  it("reloads once, then refuses inside the window, then allows again after it", () => {
    const reload = vi.fn();
    expect(reloadOnceForStaleChunk(reload, 1_000_000)).toBe(true);
    expect(reloadOnceForStaleChunk(reload, 1_000_000 + 60_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOnceForStaleChunk(reload, 1_000_000 + 6 * 60_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never reloads when the guard cannot be stored (no loop without a guard)", () => {
    installStorage({ setItem: () => { throw new Error("blocked"); } });
    const reload = vi.fn();
    expect(reloadOnceForStaleChunk(reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("vite:preloadError takes the one reload and suppresses the error; a repeat is left to the boundary", () => {
    const reload = vi.fn();
    const uninstall = installStaleChunkReload(window, reload);
    const first = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(first);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(first.defaultPrevented).toBe(true);
    const second = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(second);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(false);
    uninstall();
  });
});
