/**
 * TSX port of `stepper(step, lang)` in apps/storefront/views/_shop.njk
 * (design.md §4.6) — the checkout progress indicator: 1 Cart → 2 Payment →
 * 3 Done.
 *
 * The row is a single non-wrapping flex line, so at 320px the three chips plus
 * their separators overflow the viewport once the longer Indonesian labels
 * ("Keranjang", "Pembayaran", "Selesai") are in play. Below `sm` only the step
 * the buyer is actually on spells its name out; the other two shrink to their
 * number, which still carries the position and keeps the row on one line. The
 * full "1 · Cart" text stays in each chip's aria-label, so a screen reader
 * hears the same three steps on every viewport, and `aria-current="step"`
 * names the live one without relying on colour alone.
 */
import { Fragment } from "react";
import { ChevronRight } from "lucide-react";
import { t } from "../../lib/i18n";

export interface StepperProps {
  step: number;
}

export default function Stepper({ step }: StepperProps) {
  const labels = [t("web.step_cart"), t("web.step_pay"), t("web.step_done")];
  return (
    <ol className="flex items-center gap-2 text-xs font-semibold mb-6">
      {labels.map((label, idx) => {
        const n = idx + 1;
        const isLast = n === labels.length;
        const isCurrent = n === step;
        return (
          <Fragment key={n}>
            <li
              aria-label={`${n} · ${label}`}
              aria-current={isCurrent ? "step" : undefined}
              className={`chip ${
                n < step ? "bg-grass-tint text-grass-dark" : isCurrent ? "bg-pine text-white" : "bg-sand text-ink-soft"
              }`}
            >
              {n}
              <span className={isCurrent ? undefined : "hidden sm:inline"}>· {label}</span>
            </li>
            {!isLast && <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-ink-faint" />}
          </Fragment>
        );
      })}
    </ol>
  );
}
