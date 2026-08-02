import { ReviewSentiment } from "./enums";

/**
 * Classify review sentiment based on rating only (no keyword/NLP scan of comment text).
 * Rating bucket classification is deterministic and stable — what KPI aggregates need.
 */
export function classifyReviewSentiment(rating: number): ReviewSentiment {
  if (rating >= 4) return ReviewSentiment.POSITIVE;
  if (rating <= 2) return ReviewSentiment.NEGATIVE;
  return ReviewSentiment.NEUTRAL;
}
