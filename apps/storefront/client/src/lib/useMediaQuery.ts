/**
 * Subscribe to a CSS media query from React.
 *
 * Used where mobile and desktop need genuinely different markup rather than
 * different styling — a list of orders reads as cards on a phone and as a
 * table on a desktop, and those are different elements, not one element with
 * two skins. Rendering both and hiding one with `md:hidden` would put every
 * row in the DOM twice, which is wasted work and makes the same text ambiguous
 * to anything reading the page (assistive tech, tests, a find-in-page).
 *
 * Mobile-first when `matchMedia` is unavailable (jsdom, or any non-browser
 * host): an unknown viewport is assumed to be the small one, so the layout
 * that has to work everywhere is the one that renders by default.
 */
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Tailwind's `md` breakpoint — the point where a data table starts to fit. */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 768px)");
}
