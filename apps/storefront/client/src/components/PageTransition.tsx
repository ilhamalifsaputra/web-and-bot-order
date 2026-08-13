import { Suspense, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useLocation } from "react-router-dom";
import { fadeUp } from "../lib/motion";
import RouteFallback from "./shop/RouteFallback";

/**
 * `children` is Layout's `<Outlet/>`, which — for a lazy-loaded route
 * (App.tsx's per-route `React.lazy`) — can suspend while its chunk
 * downloads. `Suspense` sits *inside* the keyed `motion.div`, not around
 * `AnimatePresence` itself, and that placement is load-bearing:
 *
 *  - Wrapping `AnimatePresence` (or higher) instead would mean a suspending
 *    Outlet unmounts the whole animated tree — both the entering *and* any
 *    still-exiting page — and replaces it with the fallback, which blanks
 *    the transition rather than playing it, and on first mount would also
 *    take the header/footer chrome down with it if Suspense sat above
 *    Layout entirely (as it used to, in App.tsx).
 *  - Suspense *inside* the motion.div means the animated container has
 *    already committed and is free to run its enter transition; only the
 *    content within it swaps from fallback to the real page once the chunk
 *    resolves, with no second animation cycle (the `key` — and therefore
 *    AnimatePresence's identity for this element — never changes).
 *  - `mode="wait"` still fully exits the *previous* page (already-loaded,
 *    never suspends) before this one mounts, so the two never overlap.
 *
 * In practice this fallback almost never appears for an in-app click: React
 * Router v7 wraps every navigation's state update in `React.startTransition`
 * (see e.g. `react-router/dist/development/chunk-*.js`'s
 * `React.startTransition(() => setStateImpl(newState))`), and suspending
 * inside a transition does not show the nearest fallback — React just keeps
 * the *current* page on screen until the suspended chunk is ready, then
 * commits straight to the resolved result. So a click into a route whose
 * chunk hasn't arrived yet doesn't blank anything or double-fire the
 * transition either: it looks like the click "took a moment," then the
 * normal exit/enter plays once, directly to the real page (Layout.test.tsx
 * exercises this). The fallback is for the one path that ISN'T a transition:
 * a hard load / deep link / refresh landing straight on a lazy route, where
 * the very first commit suspends with nothing already on screen to keep
 * showing.
 */
export function PageTransition({ children }: { children: ReactNode }): JSX.Element {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        variants={fadeUp}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        <Suspense fallback={<RouteFallback />}>{children}</Suspense>
      </motion.div>
    </AnimatePresence>
  );
}
