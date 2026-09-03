/**
 * `/search` is no longer a page — search is the `SearchOverlay` (§10, user
 * decision #2). This thin element keeps the route resolving so previously
 * shared `/search?q=…` links still work: it reads `?q=`, opens the overlay
 * pre-filled, and replaces the history entry with `/` so there is no dead
 * results route to land on or navigate back to.
 *
 * Renders nothing — the redirect happens in an effect on mount, and `<Layout>`
 * (which owns both this route and `/`, and the overlay provider) stays mounted
 * across the swap, so the overlay it just opened survives the navigation.
 */
import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSearchOverlay } from "../components/shop/SearchOverlay";

export default function SearchRedirect() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { open } = useSearchOverlay();

  useEffect(() => {
    open(params.get("q") ?? "");
    navigate("/", { replace: true });
    // Mount-only: this element unmounts as soon as the navigate lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
