/**
 * Shared ids and classes of the home page's catalog part (group nav, flash,
 * group sections), so the hero CTAs, the nav pills and the sections agree.
 */

/** The sticky group pill bar; the hero's secondary CTA jumps to it. */
export const GROUP_NAV_ID = "home-group-nav";

/** Anchor of a whole group section, e.g. `g-premium-apps`. */
export const groupAnchor = (groupSlug: string) => `g-${groupSlug}`;

/** Anchor of a byCategory sub-section, e.g. `g-premium-apps-c-netflix`. */
export const sectionAnchor = (groupSlug: string, sectionKey: string) => `g-${groupSlug}-${sectionKey}`;

/**
 * Scroll margin for a jump target: the navbar is `h-16` (64px); with the group
 * pill bar (`min-h-11` pills + `py-2`, about 61px) stuck under it, a target
 * needs 128px to land below both. Without the bar, 80px clears the navbar.
 */
export const scrollMarginClass = (hasGroupNav: boolean) => (hasGroupNav ? "scroll-mt-32" : "scroll-mt-20");

/** Same density as every other grid (CategoryPage, ProductsPage). A lone card
 * is clamped to one capped column instead of leaving the row two-thirds empty
 * (STO-018). */
export const gridClass = (count: number) =>
  `grid gap-4 ${count === 1 ? "max-w-sm" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"}`;

/** Section heading scale shared by every home h2. */
export const SECTION_TITLE_CLASS = "font-display text-2xl font-semibold text-ink sm:text-3xl";

/** Jump-pill look (group nav and category chips) — CategoryPage's pills. */
export const jumpPillClass = (active: boolean) =>
  `inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-sm font-semibold transition-colors ${
    active ? "bg-pine-tint text-pine-dark" : "bg-sand text-ink-soft hover:bg-pine-tint hover:text-pine-dark"
  }`;

/** Horizontal scroller with a hidden scrollbar (TicketStatusFilterPills' inline trio). */
export const HIDDEN_SCROLLBAR_ROW =
  "flex gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
