/**
 * Badge — the small label/chip vocabulary from components.md "Badge & chip".
 *
 *   discount / savings → soft `grass-tint` fill, `grass-dark` text, 6px radius,
 *                        bold (a soft tint, not a solid fill)
 *   hot               → flame icon + muted `ink-soft` text, no fill
 *   category          → tiny lowercase `pine-tint` / `pine-dark` pill
 *   neutral           → `sand` / `ink-soft` pill
 *   success / pending / info / failed → status chip: tint bg + dark text,
 *                               full radius (`grass` / `amberx` / `pine` / `rust`)
 *
 * `info` (pine chip) was added in Task 14 for PayPage's `StatusStrip` —
 * pine is not a new color (it's the same token `category` already tints
 * with), just a chip-shaped (not pill-shaped) pairing that didn't exist yet.
 *
 * The pill variants compose `.chip` (app.css). Any icon is passed in via the
 * `icon` prop — nothing is hardcoded, so this stays business-agnostic.
 *
 * Note: components.md asks for ~10px text on discount/savings. The design-system
 * type scale bottoms out at 12px (`--gg-text-xs`) and the ESLint gate bans
 * `text-[10px]`, so these use `text-2xs` — the §26.2 extension token
 * `--gg-text-2xs` (0.625rem), mirrored as `--text-2xs` in index.css's `@theme`.
 * That hits the 10px spec; scoped to these two variants only.
 */
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

export type BadgeVariant =
  | "discount"
  | "savings"
  | "hot"
  | "category"
  | "neutral"
  | "success"
  | "pending"
  | "info"
  | "attention"
  | "failed";

const VARIANTS: Record<BadgeVariant, string> = {
  discount:
    "inline-flex items-center gap-1 rounded-md bg-grass-tint px-1.5 py-0.5 text-2xs font-bold text-grass-dark",
  savings:
    "inline-flex items-center gap-1 rounded-md bg-grass-tint px-1.5 py-0.5 text-2xs font-bold text-grass-dark",
  hot: "inline-flex items-center gap-1 text-xs font-semibold text-ink-soft",
  category:
    "inline-flex items-center rounded-full bg-pine-tint px-2 py-0.5 text-xs font-semibold lowercase text-pine-dark",
  neutral: "chip bg-sand text-ink-soft",
  success: "chip bg-grass-tint text-grass-dark",
  pending: "chip bg-amberx-tint text-amberx",
  info: "chip bg-pine-tint text-pine-dark",
  attention: "chip bg-plum-tint text-plum",
  failed: "chip bg-rust-tint text-rust-dark",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Optional leading icon (e.g. a flame for `hot`). */
  icon?: ReactNode;
}

const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = "neutral", icon, className, children, ...rest },
  ref,
) {
  return (
    <span ref={ref} className={cn(VARIANTS[variant], className)} {...rest}>
      {icon}
      {children}
    </span>
  );
});

export default Badge;
