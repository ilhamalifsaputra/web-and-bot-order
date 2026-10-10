import { afterEach, describe, expect, it, vi } from "vitest";
import { preferredScrollBehavior } from "./scrollBehavior";

afterEach(() => vi.unstubAllGlobals());

describe("preferredScrollBehavior", () => {
  it("reads the current preference on every scroll, including a mid-session change", () => {
    let reduced = false;
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced })));
    expect(preferredScrollBehavior()).toBe("smooth");
    reduced = true;
    expect(preferredScrollBehavior()).toBe("auto");
  });

  it("supports environments without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(preferredScrollBehavior()).toBe("smooth");
  });
});
