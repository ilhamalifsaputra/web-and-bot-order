import { cn } from "@/lib/utils"

/** Loading placeholder block. Decorative: wrap a group of these in
 * `LoadingRegion` so assistive tech hears one "Loading <what>" instead of a
 * run of empty boxes. Pulses only under `motion-safe`. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("motion-safe:animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
