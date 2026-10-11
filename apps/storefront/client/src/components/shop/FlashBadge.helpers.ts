

/** Whole-percent display value, or null when the payload isn't a usable
 * percent (mirrors activeFlashPercent's (0,100] guard client-side, so a bad
 * row can never render a "−0%"/"−250%" badge). */
export function flashPercentLabel(percent: string | number | null | undefined): number | null {
  if (percent === null || percent === undefined || percent === "") return null;
  const n = Number(percent);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return Math.round(n);
}
