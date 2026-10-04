// Backend audit Task C fix round: constantTimeEqual used to return early on a
// length mismatch, leaking the secret's length through timing. It now
// compares fixed-size sha256 digests, so timingSafeEqual always runs on two
// 32-byte buffers whatever the inputs.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({ calls: [] as Array<[number, number]> }));
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return {
    ...real,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      spy.calls.push([a.byteLength, b.byteLength]);
      return real.timingSafeEqual(a, b);
    },
  };
});

const { constantTimeEqual } = await import("../src/auth");

describe("constantTimeEqual (storefront)", () => {
  it("still compares (32-byte digests) when the lengths differ", () => {
    spy.calls.length = 0;
    expect(constantTimeEqual("short", "a-much-longer-secret-value")).toBe(false);
    expect(spy.calls).toEqual([[32, 32]]);
  });

  it("answers correctly", () => {
    expect(constantTimeEqual("same-token", "same-token")).toBe(true);
    expect(constantTimeEqual("same-token", "same-tokeN")).toBe(false);
    expect(constantTimeEqual("same", "same-token")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("é", "é")).toBe(true);
  });
});
