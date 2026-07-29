import * as React from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface FilterBarProps {
  children: ReactNode;
  onApply?: () => void;
  onClear?: () => void;
  className?: string;
}

export function FilterBar({
  children,
  onApply,
  onClear,
  className,
}: FilterBarProps): JSX.Element {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onApply?.();
      }}
      className={cn("flex flex-wrap items-end gap-2", className)}
    >
      {children}
      {(onApply || onClear) && (
        <div className="ml-auto flex items-end gap-2">
          {onClear && (
            <Button type="button" variant="ghost" onClick={onClear}>
              Clear
            </Button>
          )}
          {onApply && (
            <Button type="submit" variant="outline" onClick={onApply}>
              Apply
            </Button>
          )}
        </div>
      )}
    </form>
  )
}
