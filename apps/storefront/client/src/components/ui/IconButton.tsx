/**
 * IconButton — a square, icon-only button for carousel prev/next, dialog
 * close, and similar chrome affordances (components.md "Button" table, the
 * "Icon button" row: transparent, `sand` fill on hover, `ink-soft` icon).
 *
 * Composes <Button variant="ghost"> and forces square sizing: 44px tap target
 * at `md`, 32px at `sm` (which still grows back to 44px under
 * `(pointer: coarse)` via `.btn-sm`'s own media query — only the width stays
 * fixed there, an acceptable edge for a rarely-used size).
 *
 * `aria-label` is TS-required: an icon-only control with no accessible name is
 * invisible to assistive tech.
 */
import { forwardRef } from "react";
import Button, { type ButtonProps } from "./Button";
import { cn } from "./cn";

export interface IconButtonProps extends Omit<ButtonProps, "fullWidth" | "aria-label"> {
  "aria-label": string;
}

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { size = "md", className, children, ...rest },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      size={size}
      className={cn("p-0", size === "sm" ? "w-8" : "w-11", className)}
      {...rest}
    >
      {children}
    </Button>
  );
});

export default IconButton;
