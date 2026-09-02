/**
 * Badge — the small label/chip vocabulary from components.md "Badge & chip".
 *
 *   discount / savings → soft `grass-tint` fill, `grass-dark` text, 6px radius,
 *                        bold (a soft tint, not a solid fill)
 *   hot               → flame icon + muted `ink-soft` text, no fill
 *   category          → tiny lowercase `pine-tint` / `pine-dark` pill
 *   neutral           → `sand` / `ink-soft` pill
 *   success / pending / failed → status chip: tint bg + dark text, full radius
 *                               (`grass` / `amberx` / `rust`)
 *
 * The pill variants compose `.chip` (app.css). Any icon is passed in via the
 * `icon` prop — nothing is hardcoded, so this stays business-agnostic.
 *
 * Note: components.md asks for ~10px text on discount/savings; the storefront
 * has no sub-12px type token and the ESLint gate bans `text-[10px]`, so these
 * render at `text-xs` (12px) like every other chip until a token exists.
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
  | "failed";

const VARIANTS: Record<BadgeVariant, string> = {
  discount:
    "inline-flex items-center gap-1 rounded-md bg-grass-tint px-1.5 py-0.5 text-xs font-bold text-grass-dark",
  savings:
    "inline-flex items-center gap-1 rounded-md bg-grass-tint px-1.5 py-0.5 text-xs font-bold text-grass-dark",
  hot: "inline-flex items-center gap-1 text-xs font-semibold text-ink-soft",
  category:
    "inline-flex items-center rounded-full bg-pine-tint px-2 py-0.5 text-xs font-semibold lowercase text-pine-dark",
  neutral: "chip bg-sand text-ink-soft",
  success: "chip bg-grass-tint text-grass-dark",
  pending: "chip bg-amberx-tint text-amberx",
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
