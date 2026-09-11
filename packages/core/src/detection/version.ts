/**
 * Detector version and versioning utilities.
 *
 * Bump DETECTOR_VERSION (semver-ish, manual) whenever engine logic changes
 * in a way that could change a productKey/skuKey for existing input.
 */

export const DETECTOR_VERSION = "1.0.0";

/**
 * Build a detector stamp combining engine version and knowledge revision.
 * @param knowledgeRevision The knowledge base revision identifier
 * @returns A stamp string in format "X.Y.Z+kREVISION"
 */
export function buildDetectorStamp(knowledgeRevision: string): string {
  return `${DETECTOR_VERSION}+k${knowledgeRevision}`;
}
