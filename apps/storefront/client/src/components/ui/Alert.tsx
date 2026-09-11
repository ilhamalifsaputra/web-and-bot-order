/**
 * Alert — the canonical inline message component. It unifies the two
 * overlapping predecessors:
 *
 *   - `variant="banner"` = the flat bordered row of `components/shop/Flash.tsx`
 *     (form-error banner, keeps its `mb-5`);
 *   - `variant="panel"` = the icon-well card of `components/shop/Callout.tsx`
 *     (content aside, keeps its `rounded-2xl` + 36px icon well).
 *
 * `Flash` and `Callout` are now thin shims over this component and render
 * byte-identical DOM to before (they pass `role={false}` to suppress the ARIA
 * role, matching their historical output — their call sites pick up the spec
 * role when they migrate to `<Alert>` directly in Fase 7).
 *
 * ARIA role (new callers): `role="alert"` (assertive) ONLY for `error` /
 * `warning` on `variant="banner"` — a form submission that just failed should
 * interrupt the screen reader. Everything else is `role="status"` (polite):
 * panels are ambient context, and info/success/tip are never urgent. Pass
 * `role={false}` for no role at all.
 *
 * Business-agnostic: `tone` / `variant` are props, all copy is `children` /
 * `title`, and any icon override is passed in.
 */
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Info,
  Lightbulb,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "./cn";

export type AlertTone = "info" | "success" | "warning" | "error" | "tip";
export type AlertVariant = "banner" | "panel";

/** banner = ex-Flash. info/success/error are Flash's originals verbatim;
 * warning/tip complete the tone set for new callers. */
const BANNER_TONE: Record<AlertTone, string> = {
  info: "bg-sand text-ink border-line",
  success: "bg-grass-tint text-grass-dark border-grass/30",
  warning: "bg-amberx-tint text-amberx border-amberx/30",
  error: "bg-rust-tint text-rust-dark border-rust/30",
  tip: "bg-grass-tint text-grass-dark border-grass/30",
};
const BANNER_ICON: Record<AlertTone, LucideIcon> = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: AlertTriangle,
  tip: Lightbulb,
};

/** panel = ex-Callout. info/tip/warning are Callout's originals verbatim
 * (info→pine, tip→grass, warning→rust); success/error added for new callers. */
const PANEL_TONE: Record<AlertTone, { tint: string; fg: string }> = {
  info: { tint: "bg-pine-tint", fg: "text-pine" },
  tip: { tint: "bg-grass-tint", fg: "text-grass-dark" },
  warning: { tint: "bg-rust-tint", fg: "text-rust-dark" },
  success: { tint: "bg-grass-tint", fg: "text-grass-dark" },
  error: { tint: "bg-rust-tint", fg: "text-rust-dark" },
};
const PANEL_ICON: Record<AlertTone, LucideIcon> = {
  info: Info,
  tip: Lightbulb,
  warning: TriangleAlert,
  success: CheckCircle,
  error: TriangleAlert,
};

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "role"> {
  tone: AlertTone;
  variant: AlertVariant;
  /** Replace the default tone icon. */
  icon?: ReactNode;
  /** Optional bold lead line above the message. */
  title?: ReactNode;
  children?: ReactNode;
  /** ARIA role override. Default: "alert" for error/warning banner, else "status". `false` = none. */
  role?: "alert" | "status" | false;
}

const Alert = forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { tone, variant, icon, title, children, role, className, ...rest },
  ref,
) {
  const resolvedRole =
    role === false
      ? undefined
      : (role ??
        (variant === "banner" && (tone === "error" || tone === "warning") ? "alert" : "status"));

  if (variant === "banner") {
    const Icon = BANNER_ICON[tone];
    return (
      <div
        ref={ref}
        role={resolvedRole}
        className={cn(
          "flex items-start gap-2 rounded-xl px-4 py-3 mb-5 text-sm border",
          BANNER_TONE[tone],
          className,
        )}
        {...rest}
      >
        {icon ?? <Icon className="w-4 h-4 shrink-0 mt-px" />}
        {title != null ? (
          <div className="min-w-0">
            <p className="font-semibold">{title}</p>
            {children != null && <span>{children}</span>}
          </div>
        ) : (
          <span>{children}</span>
        )}
      </div>
    );
  }

  const { tint, fg } = PANEL_TONE[tone];
  const Icon = PANEL_ICON[tone];
  return (
    <div
      ref={ref}
      role={resolvedRole}
      className={cn("flex items-start gap-3 rounded-2xl border border-line", tint, "p-4 sm:p-5", className)}
      {...rest}
    >
      <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl", tint, fg)}>
        {icon ?? <Icon className="h-5 w-5" aria-hidden="true" />}
      </span>
      <div className="min-w-0 text-sm leading-relaxed text-ink-soft">
        {title != null && <p className="mb-1 font-semibold text-ink">{title}</p>}
        {children}
      </div>
    </div>
  );
});

export default Alert;
