import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * New interface: use `title` (+ optional icon / description / action).
 * Accepts `message` as a deprecated alias for `title` so existing call-sites
 * continue to compile until Phase 3 migrates them.
 */
interface EmptyStateProps {
  icon?: LucideIcon;
  /** Primary text. */
  title?: string;
  /** Deprecated alias for `title` — preserved for backwards compatibility. */
  message?: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({
  icon: Icon,
  title,
  message,
  description,
  action,
}: EmptyStateProps): JSX.Element {
  const displayTitle = title ?? message ?? "";

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      {Icon && <Icon className="w-12 h-12 text-ink-faint" />}
      <p className="font-semibold text-ink">{displayTitle}</p>
      {description && (
        <p className="text-sm text-ink-soft">{description}</p>
      )}
      {action && (
        <Button variant="default" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
