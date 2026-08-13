import type { HealthLevel } from "../api/types";

/**
 * Maps a health verdict's `status` (`HealthLevel`, computed server-side by
 * `evaluatePollHealth` — packages/core/src/payments/pollHealth.ts) to
 * `UrgencyDot`'s level prop. Shared by every page that renders a health
 * verdict — `BusinessHealthGrid`, `PaymentsPage`, and `SettingsPage` — so the
 * mapping can't drift between copies (each of the first two had its own
 * verbatim copy before this file existed; SettingsPage is a third consumer,
 * not a fourth copy).
 */
export const HEALTH_DOT: Record<HealthLevel, "ok" | "warn" | "critical" | "idle"> = {
  green: "ok",
  yellow: "warn",
  red: "critical",
  unmonitored: "idle",
};
