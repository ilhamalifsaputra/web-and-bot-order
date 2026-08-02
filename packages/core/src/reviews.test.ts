import { describe, expect, it } from "vitest";
import { ReviewSentiment } from "./enums";
import { classifyReviewSentiment } from "./reviews";

describe("classifyReviewSentiment", () => {
  it("classifies rating 1 as NEGATIVE", () => {
    expect(classifyReviewSentiment(1)).toBe(ReviewSentiment.NEGATIVE);
  });

  it("classifies rating 2 (boundary) as NEGATIVE", () => {
    expect(classifyReviewSentiment(2)).toBe(ReviewSentiment.NEGATIVE);
  });

  it("classifies rating 3 as NEUTRAL", () => {
    expect(classifyReviewSentiment(3)).toBe(ReviewSentiment.NEUTRAL);
  });

  it("classifies rating 4 (boundary) as POSITIVE", () => {
    expect(classifyReviewSentiment(4)).toBe(ReviewSentiment.POSITIVE);
  });

  it("classifies rating 5 as POSITIVE", () => {
    expect(classifyReviewSentiment(5)).toBe(ReviewSentiment.POSITIVE);
  });
});
