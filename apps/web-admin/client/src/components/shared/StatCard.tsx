import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type StatCardTone = "neutral" | "success" | "warning" | "danger"

interface StatCardProps {
  label: string;
  /** Preformatted — caller decides string/number/CurrencyStack/etc. */
  value: React.ReactNode;
  icon?: LucideIcon;
  tone?: StatCardTone;
  isLoading?: boolean;
  /** Optional — lets a card double as a quick filter. */
  onClick?: () => void;
}

const TONE_ICON_CLASS: Record<StatCardTone, string> = {
  neutral: "text-ink-soft",
  success: "text-grass-dark",
  warning: "text-amberx",
  danger: "text-rust-dark",
}

/**
 * A thin left-border accent, not a filled block — colored tone is reserved
 * for genuinely status-derived cards (e.g. Delivered/Cancelled counts), and
 * even then should stay subtle per the plan's "not visually dominant" call.
 * Neutral (the default) gets no accent at all.
 */
const TONE_BORDER_CLASS: Record<StatCardTone, string> = {
  neutral: "",
  success: "border-l-2 border-l-grass",
  warning: "border-l-2 border-l-amberx",
  danger: "border-l-2 border-l-rust",
}

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = "neutral",
  isLoading,
  onClick,
}: StatCardProps): JSX.Element {
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!onClick) return;
    // Space/Enter activation for a div acting as a button, matching native
    // <button> behavior since this isn't rendered as a real button element.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <Card
      size="sm"
      className={cn(
        "h-full min-h-[84px]",
        TONE_BORDER_CLASS[tone],
        onClick && "cursor-pointer transition-colors hover:bg-sand"
      )}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? handleKeyDown : undefined}
    >
      <CardContent className="flex h-full flex-col justify-between gap-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs text-ink-soft">{label}</p>
          {Icon && <Icon className={cn("h-4 w-4 shrink-0", TONE_ICON_CLASS[tone])} />}
        </div>
        {isLoading ? (
          <Skeleton className="h-7 w-16" />
        ) : (
          <div className="font-display text-xl font-semibold text-ink">{value}</div>
        )}
      </CardContent>
    </Card>
  )
}
