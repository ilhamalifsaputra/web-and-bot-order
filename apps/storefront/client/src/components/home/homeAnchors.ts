/**
 * In-page jump links of the home page (group nav pills, category chips, hero
 * CTAs) without `#hash` history entries.
 *
 * A native `<a href="#g-…">` click adds a history entry whose URL carries the
 * hash. Going Back to that entry from a product page then makes the browser
 * jump to the anchor instead of restoring where the visitor actually was
 * (the expanded section further down). So a plain click scrolls to the
 * section itself and keeps the URL hashless; the links keep their real
 * `href`, so middle-click, "copy link" and modified clicks still work
 * natively, and Enter on a focused link fires the same click.
 *
 * A typed or shared `/#g-…` URL still lands on its section: once the home
 * data has rendered, the page jumps to it and then drops the hash from the
 * current entry (replaceState, the router's history state kept), so Back to
 * it later restores normally too. Back to a hashless `/` is left entirely to
 * the browser's own scroll restoration.
 */
import { useEffect, type MouseEvent } from "react";
import { useLocation } from "react-router-dom";
import { preferredScrollBehavior } from "../../lib/scrollBehavior";

/** Drop `#…` from the current history entry, keeping the router's state. */
function stripHash(): void {
  if (!window.location.hash) return;
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}

/** Scroll to `id` (its `scroll-mt-*` clears the sticky bars) and keep the URL
 * hashless. False when the target is not on the page. */
export function jumpToHomeAnchor(id: string, behavior: ScrollBehavior): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  target.scrollIntoView({ behavior, block: "start" });
  stripHash();
  return true;
}

/** onClick for a home jump link. Modified clicks (new tab/window) and a
 * missing target fall through to the browser. */
export function onHomeAnchorClick(event: MouseEvent<HTMLAnchorElement>, id: string): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (jumpToHomeAnchor(id, preferredScrollBehavior())) event.preventDefault();
}

/** Honour a `#g-…` in the URL once the page is `ready` (an instant jump: it
 * replaces a page load's own fragment scroll, which ran before the sections
 * existed). */
export function useHomeAnchorOnLoad(ready: boolean): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return;
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    jumpToHomeAnchor(id, "auto");
  }, [ready, hash]);
}
