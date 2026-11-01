import { describe, it, expect, afterEach, vi } from "vitest";
import { randomUuid } from "./randomId";

describe("randomUuid (H6)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("works without crypto.randomUUID (plain http is not a secure context)", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    const a = randomUuid();
    const b = randomUuid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b).not.toBe(a);
  });
});
