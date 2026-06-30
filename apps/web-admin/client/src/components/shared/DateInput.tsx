import * as React from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * Styled wrapper for date inputs that matches the visual language of the
 * shadcn Select trigger. Uses the native OS date picker (better mobile UX
 * than a custom calendar) while inheriting the project's focus ring,
 * border colour, and minimum touch target on small screens.
 */
export function DateInput({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <Input
      type="date"
      className={cn("min-h-[44px] sm:min-h-8 cursor-pointer", className)}
      {...props}
    />
  )
}
