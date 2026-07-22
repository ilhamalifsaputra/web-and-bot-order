import type { Variants } from "framer-motion";

/** House easing/timing — matches the `rise`/`alert-in` CSS keyframes in app.css/admin-theme.css. */
export const EASE = [0.22, 1, 0.36, 1] as const;

export const DURATION = {
  fast: 0.15,
  base: 0.22,
  slow: 0.35,
};

export const fadeUp: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE } },
  exit: { opacity: 0, y: -8, transition: { duration: DURATION.fast, ease: EASE } },
};

export const fadeIn: Variants = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1, transition: { duration: DURATION.fast, ease: EASE } },
  exit: { opacity: 0, scale: 0.98, transition: { duration: DURATION.fast, ease: EASE } },
};

export const staggerContainer: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
};

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: DURATION.fast, ease: EASE } },
};

export const pressable = {
  whileTap: { scale: 0.97 },
};
