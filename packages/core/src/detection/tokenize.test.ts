import { describe, it, expect } from "vitest";
import { tokenize, despace } from "./tokenize";

describe("tokenize", () => {
  it("returns an empty array for an empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("returns a single-element array for a single word", () => {
    expect(tokenize("pubg")).toEqual(["pubg"]);
  });

  it("splits multiple words on whitespace", () => {
    expect(tokenize("pubg mobile uc")).toEqual(["pubg", "mobile", "uc"]);
  });

  it("operates on already-normalized input (no leading/trailing whitespace)", () => {
    // normalize() is responsible for trimming/collapsing; tokenize() just
    // splits on whatever whitespace is present in its input.
    expect(tokenize("pubg mobile")).toEqual(["pubg", "mobile"]);
  });

  it("coerces non-string input to an empty array without throwing", () => {
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });
});

describe("despace", () => {
  it("removes all whitespace from a normalized string", () => {
    expect(despace("pubg mobile")).toBe("pubgmobile");
  });

  it("removes multiple internal spaces", () => {
    expect(despace("mobile legends 5")).toBe("mobilelegends5");
  });

  it("returns an empty string for an empty string", () => {
    expect(despace("")).toBe("");
  });

  it("coerces non-string input to an empty string without throwing", () => {
    expect(despace(null)).toBe("");
    expect(despace(undefined)).toBe("");
  });
});
