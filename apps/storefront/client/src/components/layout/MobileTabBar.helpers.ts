import { matchPath } from "react-router-dom";

/**
 * Routes where the bar is HIDDEN: the full-funnel screens that already
 * dock a sticky action bar at the bottom edge (matched exactly, so the wallet
 * top-up amount form at /wallet/topup keeps the bar; only its pay screen
 * hides it). Two fixed bottom elements must
 * never coexist on one screen (docs/archive/FRONTEND_IMPLEMENTATION_PROMPT_v3.md §15).
 * Keep this list in step with business-adaptation.md → Navigation (a).
 */
export const TAB_BAR_HIDDEN_ROUTES = [
  "/p/:slug",
  "/cart",
  "/checkout",
  "/checkout/:code/pay",
  "/wallet/topup/:code/pay",
] as const;

/** True when `pathname` is one of the sticky-action-bar funnel screens. */
export function isTabBarHidden(pathname: string): boolean {
  return TAB_BAR_HIDDEN_ROUTES.some((pattern) => matchPath(pattern, pathname) !== null);
}
