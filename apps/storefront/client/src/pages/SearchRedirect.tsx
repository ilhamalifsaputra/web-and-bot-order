/**
 * `/search` is no longer a page — search is the `SearchOverlay` (§10, user
 * decision #2). This thin element keeps the route resolving so previously
 * shared `/search?q=…` links still work: it reads `?q=`, opens the overlay
 * pre-filled, and replaces the history entry with `/` so there is no dead
 * results route to land on or navigate back to.
 *
 * Opening the overlay happens in a `useLayoutEffect` — before the browser
 * paints — so a cold shared-link load paints the search panel straight away
 * instead of flashing an empty `<main>` for a frame while a passive effect
 * catches up. `useLayoutEffect` is safe here: pure client SPA, no SSR.
 *
 * The `/` redirect is a rendered `<Navigate replace>` rather than an
 * imperative `navigate()` call: React Router no-ops (and warns) on a
 * `navigate()` fired from a layout effect on the first render, before the
 * router marks itself active — `<Navigate>` carries react-router's own guard
 * for exactly this. `<Layout>` owns both this route and `/` (plus the overlay
 * provider), so it stays mounted across the swap and the overlay survives it.
 */
import { useLayoutEffect } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useSearchOverlay } from "../components/shop/SearchOverlay";

export default function SearchRedirect() {
  const [params] = useSearchParams();
  const { open } = useSearchOverlay();

  useLayoutEffect(() => {
    open(params.get("q") ?? "");
    // Mount-only: this element unmounts as soon as the <Navigate> lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Navigate to="/" replace />;
}
