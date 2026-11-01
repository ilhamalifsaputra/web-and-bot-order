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
 * spinner/label swap never shrinks it. Measured on every idle commit and
 * applied before paint. */
function usePendingWidth(pending: boolean): React.RefObject<HTMLElement | null> {
  const elRef = React.useRef<HTMLElement | null>(null)
  const idleWidth = React.useRef(0)
  const applied = React.useRef(false)
  React.useLayoutEffect(() => {
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
    idleWidth.current = el.getBoundingClientRect().width
  })
  return elRef
}

/** While pending, the spinner takes the leading icon's place: drop the first
 * child when it is an icon (an `<svg>` or a component element, e.g. a Lucide
 * icon). Done on the children, not with a CSS sibling selector, because `+`
 * skips text nodes and would hide a trailing icon in `Label <Icon/>`. */
function withoutLeadingIcon(children: React.ReactNode): React.ReactNode {
  const items = React.Children.toArray(children)
  const first = items[0]
  const isIcon =
    React.isValidElement(first) &&
    first.type !== React.Fragment &&
    (first.type === "svg" || typeof first.type !== "string")
  return isIcon ? items.slice(1) : children
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
