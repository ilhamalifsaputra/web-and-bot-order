/**
 * Shared flash-sale UI — the ⚡ percent badge, the live countdown to the end
 * of the sale, and the struck-through pre-sale price. Used by the product
 * grids (ProductCard), the product detail page (DenominationCard + the live
 * summary), the cart lines and the checkout summary.
 *
 * Contract with the server payloads (apps/storefront/src/cards.ts,
 * pageData.ts, routes/cart.ts): **every price field already carries the
 * discount**. `flash.base_price` exists only so the UI can strike through the
 * pre-sale figure — never to compute anything.
 *
 * The countdown reuses PayPage.tsx's `useCountdown` pattern (a setInterval
 * that clamps at zero and stops ticking once it gets there) rather than
 * inventing a second timer style; the difference is the formatting, since a
 * flash window can be days long, not the minutes a payment window lasts.
 * Once the window closes the badge, the countdown and the strike-through all
 * disappear on their own — the page still shows the (now stale) sale price
 * until the next fetch, and quietly dropping the "on sale" framing is the
 * honest failure mode, not striking a price through that is no longer beaten.
 *
 * Accessibility: the percent is always rendered as text (never conveyed by
 * the ⚡ icon or the rust colour alone), and the struck-through figure carries
 * an sr-only "Was Rp…" label because `line-through` is not announced.
 */
import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { t } from "../../lib/i18n";
import { formatIdr } from "../../lib/format";

/** JSON twin of FlashLineView (apps/storefront/src/routes/cart.ts) and of the
 * `flash` object on a product-page denomination (pageData.ts). */
export interface FlashInfo {
  discount_percent: string;
  /** The pre-sale price, for the strike-through — NOT what the buyer pays. */
  base_price: string;
  ends_at: string;
}

/** Whole-percent display value, or null when the payload isn't a usable
 * percent (mirrors activeFlashPercent's (0,100] guard client-side, so a bad
 * row can never render a "−0%"/"−250%" badge). */
export function flashPercentLabel(percent: string | number | null | undefined): number | null {
  if (percent === null || percent === undefined || percent === "") return null;
  const n = Number(percent);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return Math.round(n);
}

// A struck-through "was" price is a factual claim about what this plan used to
// cost, so every surface takes it from the server verbatim (`flash.base_price`
// on the product/cart payloads, `from_base_price` on the grid cards). Deriving
// it from the sale price and the percent is deliberately not offered here: on
// a grid card the two can describe different plans, which prints an original
// price the shop never charged.

/** Seconds until `endsAt`, clamped at zero; null when there's no end time to
 * count down to (the caller then renders no countdown and never auto-hides). */
function secondsLeft(endsAt: string | null | undefined): number | null {
  if (!endsAt) return null;
  const end = new Date(endsAt).getTime();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - Date.now()) / 1000));
}

/** "2d 3h" / "3h 12m" / "9m 05s" — a flash window is routinely hours or days
 * long, so a bare mm:ss (PayPage's payment countdown) would be unreadable. */
function formatRemaining(left: number): string {
  const days = Math.floor(left / 86400);
  const hours = Math.floor((left % 86400) / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const seconds = left % 60;
  if (days > 0) return t("web.flash_left_days", { days, hours });
  if (hours > 0) return t("web.flash_left_hours", { hours, minutes });
  return t("web.flash_left_minutes", { minutes, seconds: String(seconds).padStart(2, "0") });
}

/**
 * Live "time left in this sale". `ended` is true only once a real end time
 * has actually passed — a missing/invalid `ends_at` leaves both `text` empty
 * and `ended` false, so a payload quirk can never blank out a running sale.
 */
export function useFlashCountdown(endsAt: string | null | undefined): { text: string; ended: boolean } {
  const [left, setLeft] = useState<number | null>(() => secondsLeft(endsAt));
  useEffect(() => {
    const tick = (): number | null => {
      const next = secondsLeft(endsAt);
      setLeft(next);
      return next;
    };
    const first = tick();
    if (first === null || first <= 0) return undefined;
    const id = window.setInterval(() => {
      const next = tick();
      if (next === null || next <= 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [endsAt]);
  return { text: left === null || left <= 0 ? "" : formatRemaining(left), ended: left !== null && left <= 0 };
}

export interface FlashBadgeProps {
  /** `flash_discount` / `flash.discount_percent` — a percent, not a price. */
  percent: string | number | null | undefined;
  /** ISO end of the sale; drives the auto-hide (and the countdown, if asked). */
  endsAt?: string | null;
  /** `solid` for the dark image overlay on a grid card, `tint` everywhere the
   * badge sits on a card surface. */
  tone?: "tint" | "solid";
  /** Append the live countdown inside the badge (product detail only — the
   * grid cards and the checkout summary stay quiet). */
  withCountdown?: boolean;
  className?: string;
}

export default function FlashBadge({
  percent,
  endsAt = null,
  tone = "tint",
  withCountdown = false,
  className = "",
}: FlashBadgeProps) {
  const { text, ended } = useFlashCountdown(endsAt);
  const pct = flashPercentLabel(percent);
  if (pct === null || ended) return null;
  const toneClass = tone === "solid" ? "bg-rust/90 text-white backdrop-blur-sm" : "bg-rust-tint text-rust-dark";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium shadow-xs ${toneClass} ${className}`}
    >
      <Zap className="w-3 h-3 shrink-0" aria-hidden="true" />
      <span>{t("web.flash_badge", { percent: pct })}</span>
      {withCountdown && text && <span className="font-mono">· {text}</span>}
    </span>
  );
}

export interface FlashCountdownProps {
  endsAt: string | null | undefined;
  className?: string;
}

/** Stand-alone "Ends in 2d 3h" line — the product page's own countdown, kept
 * out of `aria-live` on purpose: a per-second announcement would drown out
 * everything else on the page. */
export function FlashCountdown({ endsAt, className = "" }: FlashCountdownProps) {
  const { text, ended } = useFlashCountdown(endsAt);
  if (ended || !text) return null;
  return (
    <span className={`text-xs text-rust-dark font-medium ${className}`}>
      {t("web.flash_ends_in", { remaining: text })}
    </span>
  );
}

export interface FlashWasPriceProps {
  /** IDR amount, already the PRE-sale figure. */
  value: string | number | null | undefined;
  /** When given, the strike-through disappears with the sale it belongs to. */
  endsAt?: string | null;
  className?: string;
}

/** The struck-through pre-sale price. `line-through` alone says nothing to a
 * screen reader, so the visible figure is aria-hidden and paired with an
 * sr-only "Was Rp…". */
export function FlashWasPrice({ value, endsAt = null, className = "" }: FlashWasPriceProps) {
  const { ended } = useFlashCountdown(endsAt);
  if (ended || value === null || value === undefined || value === "") return null;
  const formatted = formatIdr(value);
  return (
    <span className={`text-xs text-ink-faint ${className}`}>
      <span className="sr-only">{t("web.flash_was", { price: formatted })}</span>
      <span aria-hidden="true" className="line-through">
        {formatted}
      </span>
    </span>
  );
}
