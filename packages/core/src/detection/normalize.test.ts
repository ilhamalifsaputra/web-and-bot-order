import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { normalize } from "./normalize";
import { tokenize } from "./tokenize";

describe("normalize", () => {
  it("lowercases", () => {
    expect(normalize("PUBG Mobile")).toBe("pubg mobile");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalize("  pubg mobile  ")).toBe("pubg mobile");
  });

  it("collapses runs of internal whitespace to a single space", () => {
    expect(normalize("pubg    mobile")).toBe("pubg mobile");
    expect(normalize("pubg\t\tmobile\n\nuc")).toBe("pubg mobile uc");
  });

  it("maps each separator type to a space", () => {
    expect(normalize("pubg-mobile")).toBe("pubg mobile");
    expect(normalize("pubg_mobile")).toBe("pubg mobile");
    expect(normalize("pubg.mobile")).toBe("pubg mobile");
    expect(normalize("pubg:mobile")).toBe("pubg mobile");
  });

  it("collapses adjacent separators to a single space, not one per separator", () => {
    expect(normalize("pubg--__..::mobile")).toBe("pubg mobile");
  });

  it("folds diacritics (NFKD + strip combining marks)", () => {
    expect(normalize("É")).toBe("e");
    expect(normalize("café")).toBe("cafe");
  });

  it("maps full-width characters to half-width (NFKC)", () => {
    expect(normalize("ＡＢＣ")).toBe("abc");
  });

  it("never strips digits", () => {
    expect(normalize("mobile legends 5")).toBe("mobile legends 5");
    expect(normalize("100-diamond_top.up:2024")).toBe("100 diamond top up 2024");
  });

  it("coerces non-string input to an empty string without throwing", () => {
    expect(normalize(null)).toBe("");
    expect(normalize(undefined)).toBe("");
    expect(normalize(42)).toBe("");
    expect(normalize({})).toBe("");
    expect(normalize([])).toBe("");
  });

  describe("property: INV-2 non-destructive normalization", () => {
    it("never removes a digit character that appeared in the input (100+ runs)", () => {
      fc.assert(
        fc.property(fc.string(), (input) => {
          const digitsInInput = new Set(input.match(/[0-9]/g) ?? []);
          const normalized = normalize(input);
          for (const digit of digitsInInput) {
            expect(normalized.includes(digit)).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    });

    it(
      "token count of tokenize(normalize(s)) is monotonic non-decreasing " +
        "as separator noise is added around an existing token, and the " +
        "token itself still appears (100+ runs)",
      () => {
        // A "word": characters that survive normalization intact and contain
        // no separator/whitespace, so it is guaranteed to normalize+tokenize
        // to exactly one token.
        const wordChar = fc.constantFrom(
          ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        );
        const word = fc
          .array(wordChar, { minLength: 1, maxLength: 12 })
          .map((chars) => chars.join(""));

        // "Noise": separator characters plus whitespace characters, i.e.
        // exactly the characters normalize() collapses/maps to spaces.
        const noiseChar = fc.constantFrom(..."-_.: \t\n\r");
        const noise = fc
          .array(noiseChar, { minLength: 0, maxLength: 6 })
          .map((chars) => chars.join(""));

        fc.assert(
          fc.property(word, noise, noise, (w, before, after) => {
            const normalizedWord = normalize(w);
            const baseTokens = tokenize(normalizedWord);
            expect(baseTokens.length).toBe(1);

            const noisyTokens = tokenize(normalize(before + w + after));
            expect(noisyTokens.length).toBeGreaterThanOrEqual(baseTokens.length);
            expect(noisyTokens).toContain(normalizedWord);
          }),
          { numRuns: 100 },
        );
      },
    );
  });
});
