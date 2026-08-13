/**
 * Everything a real page load gives a route "for free" that React Router
 * alone does not — mounted once in App.tsx (a sibling of <Routes>, not inside
 * <Layout/>) so it runs for every route, including the four auth screens
 * that sit outside <Layout/> (App.tsx:61-64).
 *
 *  - T2 (document title): mirrors spaShell.ts's per-route <title> via
 *    routeTitle.ts, using the same locale keys the server uses. /p/:slug and
 *    /c/:slug are left alone here (routeTitle returns undefined) — those
 *    pages set their own title once the product/category name has loaded.
 *  - T3 (scroll position): a *new* navigation (PUSH/REPLACE) starts at the
 *    top, like a real page load would. A *back/forward* (POP) is left
 *    alone — history.scrollRestoration defaults to "auto", so the browser
 *    already restores the scroll position that history entry had, and
 *    fighting that here would just replace a good restoration with a jump to
 *    the top.
 *  - T15 (focus): moves focus to the page's <main> landmark so it isn't
 *    stranded on whatever link/button was clicked. Deferred one frame so it
 *    always runs after Layout's own drawer-close focus management
 *    (Layout.tsx's Esc/close-button effect, which returns focus to the
 *    hamburger trigger) — clicking a drawer link both closes the drawer and
 *    navigates, and the page landmark should win that race, not the trigger
 *    button. Skipped entirely on the first render: initial load must not
 *    steal focus from wherever the browser already put it.
 *
 * <main> itself is a stable target for the focus move even though
 * PageTransition's <AnimatePresence mode="wait"> unmounts/remounts the
 * *Outlet content* on every route change (Layout.tsx:495) — <main> is
 * Layout's own JSX, not the Outlet's, so it never unmounts and is always
 * present to receive focus without racing that animation.
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { useShopContext } from "./Layout";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { routeTitle } from "../lib/routeTitle";

export default function RouteEffects(): null {
  const location = useLocation();
  const navigationType = useNavigationType();
  const { data: ctx } = useShopContext();
  const isFirstRender = useRef(true);

  useDocumentTitle(
    ctx?.shop_name ? routeTitle(location.pathname, location.search, ctx.shop_name) : undefined,
  );

  useEffect(() => {
    if (navigationType !== "POP") {
      window.scrollTo(0, 0);
    }
  }, [location.pathname, navigationType]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.pathname]);

  return null;
}
