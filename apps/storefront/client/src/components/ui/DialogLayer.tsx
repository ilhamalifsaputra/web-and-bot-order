import type { HTMLAttributes } from "react";
import { useIsPresent } from "motion/react";

/** Exit is visual only: restored focus and taps must reach the page immediately. */
export default function DialogLayer({ style, ...props }: HTMLAttributes<HTMLDivElement>) {
  const present = useIsPresent();
  return (
    <div
      {...props}
      {...(!present ? { inert: "" } : {})}
      aria-hidden={!present || undefined}
      style={{ ...style, pointerEvents: present ? style?.pointerEvents : "none" }}
    />
  );
}
