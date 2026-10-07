/**
 * StickyPurchaseBar — the mobile bottom-pinned "price + CTA" strip that stands
 * in for the in-page buy controls once they scroll away (`components.md`
 * "Sticky purchase bar (product detail)").
 *
 * The audit found three hand-rolled copies of this strip (ProductPage,
 * InstantBuyPage, CheckoutPage). Task 11 consolidates the first two here; the
 * Fase 7c task wires CheckoutPage onto it. Each page keeps owning WHEN the bar
 * shows (its own `IntersectionObserver` sentinel / `page && totals` gate) — this
 * component is presentation only.
 *
 * Layout per spec: white surface, `shadow-lift` cast upward onto the page,
 * optional `pine-tint` notice ribbon strip above the price row, price rendered
 * in `grass-dark` ~20px/700 with optional savings / secondary chips, a primary
 * CTA and an optional secondary CTA (ProductPage's "Buy Now + Add to Cart"
 * shape). Safe-area inset padding keeps the button clear of the iOS home
 * indicator (the sole reason this file is on the eslint.config.js Group-A
 * `env()` allowlist).
 *
 * Portaled to `document.body`: `apps/storefront/static/app.css` runs
 * `main { animation: rise .5s … both }`, whose `both` fill-mode leaves `<main>`
 * with a non-`none` `transform` after load. A `transform` other than `none`
 * makes an element the containing block for its `position: fixed` descendants,
 * so a bar rendered inside the routed page (a `<main>` descendant) pins to
 * `<main>`'s bottom edge — above the footer, and scrolled away mid-page —
 * instead of the viewport. The hand-rolled bars this component replaces all
 * had that latent bug; portaling out of `<main>` fixes it for every consumer.
 *
 * Business-agnostic: all copy, prices, handlers and pending flags are props.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Spinner from "./Spinner";
import Button, { type ButtonVariant } from "../ui/Button";
import { cn } from "../ui/cn";

export interface StickyPurchaseAction {
  label: ReactNode;
  onClick: () => void;
  /** Leading icon, rendered before the label (after the pending spinner). */
  icon?: ReactNode;
  /** Show a spinner and treat the button as busy. */
  pending?: boolean;
  /** Disable the button (blocks the click). Pending implies busy but not
   * necessarily disabled — pass both when a pending action must not re-fire. */
  disabled?: boolean;
  /** "Can't proceed yet" affordance distinct from `pending`: mutes the button
   * without the spinner. Callers that also want the click blocked pass
   * `disabled` alongside it (see InstantBuyPage's `submitBlocked`). */
  blocked?: boolean;
  variant?: ButtonVariant;
}

export interface StickyPurchaseBarProps {
  /** Small line above the price — a plan name, "Harga", "Total", … */
  priceLabel?: ReactNode;
  /** The formatted price string, shown in `grass-dark` ~20px/700. */
  price: ReactNode;
  /** Optional "Hemat RpX" savings chip (grass). */
  savingsChip?: ReactNode;
  /** Optional secondary hint chip (e.g. a bulk-discount nudge). */
  secondaryChip?: ReactNode;
  /** Optional notice ribbon strip above the price row (`pine-tint` bg /
   * `pine-dark` text). This shop has no "koin cashback", so it is usually
   * omitted; kept for the bulk-discount hint / CheckoutPage reuse. */
  notice?: ReactNode;
  primaryAction: StickyPurchaseAction;
  /** Optional second CTA rendered before the primary one (ProductPage's
   * Buy Now + Add to Cart). */
  secondaryAction?: StickyPurchaseAction;
  /** When set, the strip is exposed as a labelled `region` landmark. */
  ariaLabel?: string;
  className?: string;
  /** Instant checkout reserves the measured bar height after the site footer. */
  reserveFooterSpace?: boolean;
}

function ActionButton({ action }: { action: StickyPurchaseAction }) {
  return (
    <Button
      variant={action.variant ?? "primary"}
      className={cn("shrink-0", action.blocked && "opacity-60")}
      disabled={action.disabled}
      onClick={action.onClick}
    >
      {action.pending && <Spinner />}
      {action.icon}
      {action.label}
    </Button>
  );
}

export default function StickyPurchaseBar({
  priceLabel,
  price,
  savingsChip,
  secondaryChip,
  notice,
  primaryAction,
  secondaryAction,
  ariaLabel,
  className,
  reserveFooterSpace = false,
}: StickyPurchaseBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [clearanceHost, setClearanceHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!reserveFooterSpace || !barRef.current) return;
    setClearanceHost(document.getElementById("purchase-bar-clearance") ?? document.body);
    const element = barRef.current;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [reserveFooterSpace]);
  const bar = (
    <div
      ref={barRef}
      role={ariaLabel ? "region" : undefined}
      aria-label={ariaLabel}
      className={cn(
        "fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 shadow-lift backdrop-blur-sm",
        className,
      )}
      // The iOS home-indicator strip would otherwise eat the bottom of the
      // button — a runtime device measurement, not a design token.
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
    >
      {notice && (
        <div className="bg-pine-tint px-4 py-2 text-center text-xs font-medium text-pine-dark">
          {notice}
        </div>
      )}
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 pt-3">
        <div className="min-w-0 flex-1">
          {priceLabel != null && (
            <div className="truncate text-xs text-ink-soft">{priceLabel}</div>
          )}
          <div className="font-display text-xl font-bold leading-tight text-grass-dark">{price}</div>
          {(savingsChip || secondaryChip) && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {savingsChip}
              {secondaryChip}
            </div>
          )}
        </div>
        {secondaryAction && <ActionButton action={secondaryAction} />}
        <ActionButton action={primaryAction} />
      </div>
    </div>
  );

  // SSR / non-DOM guard — render inline if there is no document to portal into.
  return typeof document === "undefined" ? bar : <>
    {createPortal(bar, document.body)}
    {reserveFooterSpace && clearanceHost && createPortal(<div data-testid="purchase-bar-spacer" aria-hidden="true" style={{ height }} />, clearanceHost)}
  </>;
}
