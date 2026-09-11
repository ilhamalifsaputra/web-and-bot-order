import * as React from "react"

import { cn } from "@/lib/utils"

function Card({
  className,
  size = "default",
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  size?: "default" | "sm"
  /**
   * `nested` renders this Card as a recessed containment-depth panel for use
   * *inside* another Card, instead of stacking a second raised white card on
   * a white one. Depth capped at 2 — do not nest `variant="nested"` inside
   * `variant="nested"`.
   */
  variant?: "default" | "nested"
}) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-variant={variant}
      className={cn(
        "group/card flex min-w-0 flex-col gap-(--card-spacing) overflow-hidden border border-border py-(--card-spacing) text-sm text-card-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0",
        variant === "nested"
          ? "rounded-lg bg-sand shadow-none *:[img:first-child]:rounded-t-lg *:[img:last-child]:rounded-b-lg"
          : "rounded-xl bg-card shadow-soft *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing) group-data-[variant=nested]/card:rounded-t-lg",
        className
      )}
      {...props}
    />
  )
}

/**
 * F-010: `as` lets a caller render this as a real heading element
 * (`<h2>`/`<h3>`) instead of the default `<div>`, without touching any of
 * the 20+ other `CardTitle` call sites across the app that intentionally
 * aren't page-structure headings (dialog/section titles inside a single
 * page that already has its own heading, etc). Visual styling (className)
 * is identical either way — only the rendered tag changes.
 */
function CardTitle({
  className,
  as: Comp = "div",
  ...props
}: React.ComponentProps<"div"> & { as?: "div" | "h2" | "h3" | "h4" }) {
  return (
    <Comp
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing) group-data-[variant=nested]/card:rounded-b-lg",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
