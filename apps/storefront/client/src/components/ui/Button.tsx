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
import { forwardRef, useCallback, useLayoutEffect, useRef, type ButtonHTMLAttributes, type RefObject } from "react";
import { cn } from "./cn";
import Spinner from "./Spinner";

export type ButtonVariant = "primary" | "soft" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container width — auth flow + mobile sticky purchase bar. */
  fullWidth?: boolean;
  /** The storefront's one pending-button pattern: a spinner in place of the
   * leading icon (or before the label), the label kept, the button disabled
   * and `aria-busy`, its idle width held as a minimum so it doesn't jump. */
  pending?: boolean;
}

/** Holds the idle width as `min-width` while pending; measured on each idle
 * commit, applied before paint. */
function usePendingWidth(pending: boolean): RefObject<HTMLButtonElement | null> {
  const elRef = useRef<HTMLButtonElement | null>(null);
  const idleWidth = useRef(0);
  const applied = useRef(false);
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (pending) {
      if (idleWidth.current > 0) {
        el.style.minWidth = `${idleWidth.current}px`;
        applied.current = true;
      }
      return;
    }
    if (applied.current) {
      el.style.minWidth = "";
      applied.current = false;
    }
    idleWidth.current = el.getBoundingClientRect().width;
  });
  return elRef;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", fullWidth = false, pending = false, type, className, disabled, children, ...rest },
  ref,
) {
  const widthRef = usePendingWidth(pending);
  const setRefs = useCallback(
    (node: HTMLButtonElement | null) => {
      widthRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref, widthRef],
  );
  return (
    <button
      ref={setRefs}
      // Default to "button" so a Button inside a <form> is inert unless the
      // caller explicitly opts into type="submit".
      type={type ?? "button"}
      className={cn(
        "btn",
        `btn-${variant}`,
        size === "sm" && "btn-sm",
        fullWidth && "w-full",
        pending && "[&>svg]:hidden",
        className,
      )}
      disabled={pending || disabled}
      aria-busy={pending ? true : undefined}
      data-pending={pending ? "true" : undefined}
      {...rest}
    >
      {pending && <Spinner />}
      {children}
    </button>
  );
});

export default Button;
