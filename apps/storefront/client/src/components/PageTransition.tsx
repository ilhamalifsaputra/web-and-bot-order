import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { Suspense, useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { DURATION, EASE } from "../lib/motion";
import ErrorBoundary from "./ErrorBoundary";
import RouteFallback from "./shop/RouteFallback";

/** Keep route content available immediately; lazy chunks preserve the shell. */
export function PageTransition({ children }: { children: ReactNode }): ReactElement {
  const location = useLocation();
  const reduced = useReducedMotion();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  // The boundary keeps the shop chrome when a page (or its lazy chunk) fails,
  // and clears itself on the next navigation.
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Suspense fallback={<RouteFallback />}>
        <m.div
          key={location.pathname}
          initial={reduced || !mounted.current ? false : { y: 4, opacity: 1 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: reduced ? 0 : DURATION.base, ease: EASE }}
        >
          {children}
        </m.div>
      </Suspense>
    </ErrorBoundary>
  );
}
