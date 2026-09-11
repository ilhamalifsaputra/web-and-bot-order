/**
 * Button — the canonical storefront button primitive.
 *
 * Composes the hand-authored `.btn` / `.btn-<variant>` / `.btn-sm` classes in
 * `apps/storefront/static/app.css` (which already encode the design-system
 * "Button" table values verbatim) plus token utilities for the `fullWidth`
 * delta. Business-agnostic: no domain types, no routing, no i18n — callers
 * pass label text as children.
 *
 * Variants map 1:1 to components.md "Button":
 *   primary → `.btn-primary` (pine fill, white, shadow-soft)
 *   soft    → `.btn-soft`    (pine-tint fill, pine-dark text)
 *   ghost   → `.btn-ghost`   (transparent, ink-soft; sand fill on hover)
 *   danger  → `.btn-danger`  (rust fill, white)
 * The "Icon button" row is the sibling <IconButton>; the "Disabled" row is the
 * `.btn:disabled` rule added to app.css alongside this component.
 */
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "soft" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container width — auth flow + mobile sticky purchase bar. */
  fullWidth?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", fullWidth = false, type, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // Default to "button" so a Button inside a <form> is inert unless the
      // caller explicitly opts into type="submit".
      type={type ?? "button"}
      className={cn(
        "btn",
        `btn-${variant}`,
        size === "sm" && "btn-sm",
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    />
  );
});

export default Button;
