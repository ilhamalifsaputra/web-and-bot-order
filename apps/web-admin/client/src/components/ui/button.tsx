import { type VariantProps } from "class-variance-authority";
import * as m from "motion/react-m";
import { Slot } from "radix-ui";
import * as React from "react";
import { buttonVariants } from "./button.helpers";
import { Spinner } from "./spinner";

import { pressable } from "@/lib/motion";
import { cn } from "@/lib/utils";

const MotionButton = m.create("button")
const MotionSlot = m.create(Slot.Root)

type ButtonProps = Omit<
  React.ComponentProps<"button">,
  "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart"
> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** The admin's one pending-button pattern: a spinner in place of the
     * leading icon (or before the label; a trailing icon stays), the label kept (callers may pass a
     * "Saving…" label), the button disabled and `aria-busy`, and its width
     * held at least at its idle width so the row doesn't jump. Ignored with
     * `asChild` (a Slot can't take the extra spinner child). */
    pending?: boolean
  }

/** Holds the button's idle width as a `min-width` while it is pending, so a
 * spinner/label swap never shrinks it, applied before paint.
 *
 * The idle width comes from a ResizeObserver, which reports it after layout
 * without forcing one: reading `getBoundingClientRect()` on every commit of
 * every button made each re-render a synchronous layout. Reports that arrive
 * while the button is pending are ignored (they describe the spinner swap, not
 * the idle button). Without ResizeObserver (jsdom, very old browsers) it falls
 * back to measuring on each idle commit. */
function usePendingWidth(pending: boolean): React.RefObject<HTMLElement | null> {
  const elRef = React.useRef<HTMLElement | null>(null)
  const idleWidth = React.useRef(0)
  const applied = React.useRef(false)
  const pendingNow = React.useRef(pending)
  const observed = typeof ResizeObserver !== "undefined"
  React.useLayoutEffect(() => {
    pendingNow.current = pending
    const el = elRef.current
    if (!el) return
    if (pending) {
      if (idleWidth.current > 0) {
        el.style.minWidth = `${idleWidth.current}px`
        applied.current = true
      }
      return
    }
    if (applied.current) {
      el.style.minWidth = ""
      applied.current = false
    }
    if (!observed) idleWidth.current = el.getBoundingClientRect().width
  })
  React.useLayoutEffect(() => {
    const el = elRef.current
    if (!observed || !el) return
    const observer = new ResizeObserver((entries) => {
      if (pendingNow.current) return
      const entry = entries[entries.length - 1]
      idleWidth.current = entry?.borderBoxSize?.[0]?.inlineSize ?? el.getBoundingClientRect().width
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [observed])
  return elRef
}

/** Whether an element is an icon rather than a label: a bare `<svg>`, a Lucide
 * icon (a `forwardRef` component that takes no children), or a function
 * component named `…Icon`. A leading `<Trans/>` or `<CurrencyAmount/>` is
 * label text and must stay. */
function isIconElement(node: React.ReactNode): boolean {
  if (!React.isValidElement(node) || node.type === React.Fragment) return false
  const type: unknown = node.type
  if (type === "svg") return true
  if (typeof type === "function") return /Icon$/.test(type.name)
  if (typeof type === "object" && type !== null && "render" in type) {
    return (node.props as { children?: React.ReactNode }).children === undefined
  }
  return false
}

/** While pending, the spinner takes the leading icon's place: drop the first
 * child when it is an icon (see `isIconElement`). Done on the children, not
 * with a CSS sibling selector, because `+` skips text nodes and would hide a
 * trailing icon in `Label <Icon/>`. */
function withoutLeadingIcon(children: React.ReactNode): React.ReactNode {
  const items = React.Children.toArray(children)
  return isIconElement(items[0]) ? items.slice(1) : children
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "default", asChild = false, pending = false, disabled, children, ...props },
  ref
) {
  const Comp = asChild ? MotionSlot : MotionButton
  const showPending = pending && !asChild
  const widthRef = usePendingWidth(showPending)
  const setRefs = React.useCallback(
    (node: HTMLButtonElement | null) => {
      widthRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref, widthRef]
  )

  return (
    <Comp
      ref={setRefs}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-pending={showPending ? "true" : undefined}
      aria-busy={showPending ? true : undefined}
      disabled={showPending || disabled}
      className={cn(
        buttonVariants({ variant, size, className })
      )}
      {...pressable}
      {...props}
    >
      {showPending ? (
        <>
          <Spinner />
          {withoutLeadingIcon(children)}
        </>
      ) : (
        children
      )}
    </Comp>
  )
})

export { Button };
