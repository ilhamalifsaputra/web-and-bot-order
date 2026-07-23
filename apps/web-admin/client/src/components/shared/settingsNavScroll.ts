/** Shape-compatible subsets of `HTMLElement` — kept minimal so this stays a
 * pure function testable with plain objects (no real DOM/layout needed). */
export interface NavScrollLink {
  offsetLeft: number;
  offsetWidth: number;
}
export interface NavScrollContainer {
  scrollLeft: number;
  clientWidth: number;
}

/**
 * Horizontal-only "nearest" scroll math for the mobile settings tab bar.
 *
 * `Element.scrollIntoView({ block: "nearest" })` was previously used for
 * this, but its target sits inside a `position: sticky` nav nested in a
 * scrollable ancestor (`AppShell`'s `<main overflow-y-auto>`) — mobile
 * browsers can misresolve the sticky element's rect for the block axis and
 * scroll that ancestor back to the top. Computing the horizontal delta
 * ourselves and only ever touching `nav.scrollLeft` avoids handing the
 * browser any vertical axis to resolve at all.
 */
export function computeNavScrollLeft(link: NavScrollLink, nav: NavScrollContainer): number | null {
  const linkLeft = link.offsetLeft;
  const linkRight = linkLeft + link.offsetWidth;
  const viewLeft = nav.scrollLeft;
  const viewRight = viewLeft + nav.clientWidth;

  if (linkLeft < viewLeft) return linkLeft;
  if (linkRight > viewRight) return linkRight - nav.clientWidth;
  return null;
}
