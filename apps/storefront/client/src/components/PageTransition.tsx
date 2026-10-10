import { Suspense, useEffect, useRef, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useLocation } from "react-router-dom";
import { DURATION, EASE } from "../lib/motion";
import RouteFallback from "./shop/RouteFallback";

/** Keep route content available immediately; lazy chunks preserve the shell. */
export function PageTransition({ children }: { children: ReactNode }): JSX.Element {
  const location = useLocation();
  const reduced = useReducedMotion();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  return (
    <Suspense fallback={<RouteFallback />}>
      <motion.div
        key={location.pathname}
        initial={reduced || !mounted.current ? false : { y: 4, opacity: 1 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: reduced ? 0 : DURATION.base, ease: EASE }}
      >
        {children}
      </motion.div>
    </Suspense>
  );
}
