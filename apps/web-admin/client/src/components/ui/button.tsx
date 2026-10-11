import { type VariantProps } from "class-variance-authority";
import * as m from "motion/react-m";
import { Slot } from "radix-ui";
import * as React from "react";
import { buttonVariants } from "./button.helpers";

import { pressable } from "@/lib/motion";
import { cn } from "@/lib/utils";

const MotionButton = m.create("button")
const MotionSlot = m.create(Slot.Root)

const Button = React.forwardRef<
  HTMLButtonElement,
  Omit<
    React.ComponentProps<"button">,
    "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart"
  > &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }
>(function Button(
  { className, variant = "default", size = "default", asChild = false, ...props },
  ref
) {
  const Comp = asChild ? MotionSlot : MotionButton

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...pressable}
      {...props}
    />
  )
})

export { Button };
