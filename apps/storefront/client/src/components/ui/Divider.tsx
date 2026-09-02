/**
 * Divider — a 1px `line` rule. `<hr>` carries the implicit `separator` role;
 * `aria-orientation` is set explicitly so a vertical divider announces
 * correctly. The caller controls length (width for horizontal, height for
 * vertical) via `className`.
 */
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "./cn";

export interface DividerProps extends HTMLAttributes<HTMLHRElement> {
  orientation?: "horizontal" | "vertical";
}

const Divider = forwardRef<HTMLHRElement, DividerProps>(function Divider(
  { orientation = "horizontal", className, ...rest },
  ref,
) {
  return (
    <hr
      ref={ref}
      aria-orientation={orientation}
      className={cn(
        "border-0 border-line",
        orientation === "vertical" ? "h-auto self-stretch border-l" : "w-full border-t",
        className,
      )}
      {...rest}
    />
  );
});

export default Divider;
