import { describe, it, expect } from "vitest";
import {
  W_OVERRIDE,
  W_EXTERNAL_ID,
  W_NAME_CORE,
  W_NAME_CORE_DESPACED,
  W_DEFINING_TOKEN,
  DEFINING_TOKEN_CAP,
  W_STRUCTURED_META,
  W_DISTRIBUTION,
  DISTRIBUTION_CAP,
  ACCEPT_THRESHOLD,
  MARGIN,
  computeConfidence,
} from "./scoring";

describe("scoring", () => {
  // AC-02 Enforcement: W_STRUCTURED_META + DISTRIBUTION_CAP must be less than ACCEPT_THRESHOLD
  it("enforces AC-02: W_STRUCTURED_META + DISTRIBUTION_CAP < ACCEPT_THRESHOLD", () => {
    expect(W_STRUCTURED_META + DISTRIBUTION_CAP).toBeLessThan(
      ACCEPT_THRESHOLD,
    );
  });

  // MARGIN must be greater than DISTRIBUTION_CAP
  it("enforces MARGIN > DISTRIBUTION_CAP", () => {
    expect(MARGIN).toBeGreaterThan(DISTRIBUTION_CAP);
  });

  // All exported numeric constants must be integers
  it("enforces all exported numeric constants are integers", () => {
    const numericConstants = [
      W_OVERRIDE,
      W_EXTERNAL_ID,
      W_NAME_CORE,
      W_NAME_CORE_DESPACED,
      W_DEFINING_TOKEN,
      DEFINING_TOKEN_CAP,
      W_STRUCTURED_META,
      W_DISTRIBUTION,
      DISTRIBUTION_CAP,
      ACCEPT_THRESHOLD,
      MARGIN,
    ];

    for (const constant of numericConstants) {
      expect(Number.isInteger(constant)).toBe(true);
    }
  });

  describe("computeConfidence", () => {
    it("returns 0 when maxAttainableScore is 0 (guard against NaN/Infinity)", () => {
      expect(computeConfidence(0, 0)).toBe(0);
    });

    it("computes confidence correctly for various score and maxAttainableScore pairs", () => {
      // score = 40, maxAttainableScore = 100 → 40%
      expect(computeConfidence(40, 100)).toBe(0.4);

      // score = 50, maxAttainableScore = 100 → 50%
      expect(computeConfidence(50, 100)).toBe(0.5);

      // score = 100, maxAttainableScore = 100 → 100% (1.00)
      expect(computeConfidence(100, 100)).toBe(1);

      // score = 33, maxAttainableScore = 100 → 33%
      expect(computeConfidence(33, 100)).toBe(0.33);

      // score = 67, maxAttainableScore = 100 → 67%
      expect(computeConfidence(67, 100)).toBe(0.67);
    });

    it("rounds to 2 decimal places", () => {
      // 1/3 ≈ 0.3333... should round to 0.33
      expect(computeConfidence(1, 3)).toBe(0.33);

      // 2/3 ≈ 0.6666... should round to 0.67
      expect(computeConfidence(2, 3)).toBe(0.67);
    });

    it("returns a value in [0, 1]", () => {
      const testCases: [number, number][] = [
        [0, 100],
        [25, 100],
        [50, 100],
        [75, 100],
        [100, 100],
        [40, 40],
        [1, 3],
        [2, 3],
      ];

      for (const [score, maxAttainableScore] of testCases) {
        const result = computeConfidence(score, maxAttainableScore);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }
    });
  });
});
