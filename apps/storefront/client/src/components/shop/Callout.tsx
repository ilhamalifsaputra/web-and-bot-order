/**
 * A colored, iconed aside for a paragraph that already reads as an important
 * note — never a place to invent new copy. Three fixed tones, matching the
 * grass/pine/rust vocabulary `StatusBadge.tsx` already uses for tone: `tip`
 * (grass) for reassuring/positive notes, `info` (pine) for neutral
 * clarifications, `warning` (rust) for anything the reader could get wrong
 * with a real cost (money, warranty, account access).
 */
import { Info, Lightbulb, TriangleAlert, type LucideIcon } from "lucide-react";

export type CalloutVariant = "info" | "tip" | "warning";

const VARIANTS: Record<CalloutVariant, { icon: LucideIcon; tint: string; fg: string }> = {
  info: { icon: Info, tint: "bg-pine-tint", fg: "text-pine" },
  tip: { icon: Lightbulb, tint: "bg-grass-tint", fg: "text-grass-dark" },
  warning: { icon: TriangleAlert, tint: "bg-rust-tint", fg: "text-rust-dark" },
};

export interface CalloutProps {
  variant: CalloutVariant;
  children: React.ReactNode;
}

export default function Callout({ variant, children }: CalloutProps) {
  const { icon: Icon, tint, fg } = VARIANTS[variant];
  return (
    <div className={`flex items-start gap-3 rounded-2xl border border-line ${tint} p-4 sm:p-5`}>
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${tint} ${fg}`}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 text-sm leading-relaxed text-ink-soft">{children}</div>
    </div>
  );
}
