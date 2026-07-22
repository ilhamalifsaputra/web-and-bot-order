import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIsDesktop, useMediaQuery } from "./useMediaQuery";

type Listener = (event: MediaQueryListEvent) => void;

/** Minimal matchMedia stand-in — jsdom ships none. */
function installMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const list = {
    matches: initial,
    addEventListener: (_: string, fn: Listener) => void listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => void listeners.delete(fn),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => list),
  );
  return {
    emit(matches: boolean) {
      list.matches = matches;
      listeners.forEach((fn) => fn({ matches } as MediaQueryListEvent));
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useMediaQuery", () => {
  // The whole point of the mobile-first default: jsdom, and any other host
  // without matchMedia, must render the layout that has to work everywhere
  // rather than the desktop one.
  it("reports no match when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(false);
  });

  it("reads the initial match and follows later changes", () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(result.current).toBe(true);

    act(() => media.emit(false));
    expect(result.current).toBe(false);
  });

  it("unsubscribes on unmount so a removed list stops updating state", () => {
    const media = installMatchMedia(false);
    const { unmount } = renderHook(() => useIsDesktop());
    expect(media.listenerCount()).toBe(1);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });
});
