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
import { Children, Fragment, forwardRef, isValidElement, useCallback, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type RefObject } from "react";
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
   * leading icon (or before the label; a trailing icon stays), the label kept, the button disabled
   * and `aria-busy`, its idle width held as a minimum so it doesn't jump. */
  pending?: boolean;
}

/** Holds the idle width as `min-width` while pending, applied before paint.
 * The idle width comes from a ResizeObserver, which reports it after layout
 * without forcing one (reading `getBoundingClientRect()` on every commit of
 * every button made each re-render a synchronous layout). Reports that arrive
 * while pending are ignored: they describe the spinner swap, not the idle
 * button. Without ResizeObserver (jsdom, very old browsers) it falls back to
 * measuring on each idle commit. */
function usePendingWidth(pending: boolean): RefObject<HTMLButtonElement | null> {
  const elRef = useRef<HTMLButtonElement | null>(null);
  const idleWidth = useRef(0);
  const applied = useRef(false);
  const pendingNow = useRef(pending);
  const observed = typeof ResizeObserver !== "undefined";
  useLayoutEffect(() => {
    pendingNow.current = pending;
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
    if (!observed) idleWidth.current = el.getBoundingClientRect().width;
  });
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!observed || !el) return;
    const observer = new ResizeObserver((entries) => {
      if (pendingNow.current) return;
      const entry = entries[entries.length - 1];
      idleWidth.current = entry?.borderBoxSize?.[0]?.inlineSize ?? el.getBoundingClientRect().width;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [observed]);
  return elRef;
}

/** Whether an element is an icon rather than a label: a bare `<svg>`, a Lucide
 * icon (a `forwardRef` component that takes no children), or a function
 * component named `…Icon`. A leading `<Trans/>` or `<CurrencyAmount/>` is
 * label text and must stay. */
function isIconElement(node: ReactNode): boolean {
  if (!isValidElement(node) || node.type === Fragment) return false;
  const type: unknown = node.type;
  if (type === "svg") return true;
  if (typeof type === "function") return /Icon$/.test(type.name);
  if (typeof type === "object" && type !== null && "render" in type) {
    return (node.props as { children?: ReactNode }).children === undefined;
  }
  return false;
}

/** While pending, the spinner takes the leading icon's place: drop the first
 * child when it is an icon (see `isIconElement`). Done on the children, not
 * with a CSS sibling selector, because `+` skips text nodes and would hide a
 * trailing icon in `Label <Icon/>`. */
function withoutLeadingIcon(children: ReactNode): ReactNode {
  const items = Children.toArray(children);
  return isIconElement(items[0]) ? items.slice(1) : children;
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
        className,
      )}
      disabled={pending || disabled}
      aria-busy={pending ? true : undefined}
      data-pending={pending ? "true" : undefined}
      {...rest}
    >
      {pending && <Spinner />}
      {pending ? withoutLeadingIcon(children) : children}
    </button>
  );
});

export default Button;
