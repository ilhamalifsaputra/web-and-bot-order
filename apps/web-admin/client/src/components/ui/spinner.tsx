import { LoaderCircle } from "lucide-react"

import { cn } from "@/lib/utils"

/** Small in-place "working" indicator — a pending button, a refetch hint.
 * Always decorative (`aria-hidden`): the surrounding text or the parent's
 * `aria-busy` carries the meaning. Spins only under `motion-safe`, so a
 * reduced-motion viewer sees a still ring instead of a rotating one. */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <LoaderCircle
      data-slot="spinner"
      aria-hidden="true"
      className={cn("size-4 motion-safe:animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
