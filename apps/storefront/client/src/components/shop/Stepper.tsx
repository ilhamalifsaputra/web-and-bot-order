/**
 * TSX port of `stepper(step, lang)` in apps/storefront/views/_shop.njk
 * (design.md §4.6) — the checkout progress indicator: 1 Cart → 2 Payment →
 * 3 Done.
 *
 * Design-system migration (Fase 7c): the row was a `.chip` pill trio; it is
 * now a numbered step indicator — a small numbered circle per step joined by a
 * short connector. Done steps go `grass` with a check, the active step `pine`,
 * upcoming steps sit muted on `sand`/`ink-faint`. The connector after a
 * completed step is drawn in `grass` so progress reads at a glance.
 *
 * The row is a single non-wrapping flex line, so at 320px the three labels plus
 * connectors would overflow once the longer Indonesian labels ("Keranjang",
 * "Pembayaran", "Selesai") are in play. Below `sm` only the step the buyer is
 * actually on spells its name out; the other two collapse to their numbered
 * circle, which still carries the position and keeps the row on one line. The
 * full "1 · Cart" text stays in each step's aria-label, so a screen reader
 * hears the same three steps on every viewport, and `aria-current="step"` names
 * the live one without relying on colour alone.
 */
import { Fragment } from "react";
import { Check } from "lucide-react";
import { t } from "../../lib/i18n";

export interface StepperProps {
  step: number;
}

export default function Stepper({ step }: StepperProps) {
  const labels = [t("web.step_cart"), t("web.step_pay"), t("web.step_done")];
  return (
    <ol className="mb-6 flex items-center gap-2 sm:gap-3">
      {labels.map((label, idx) => {
        const n = idx + 1;
        const isLast = n === labels.length;
        const isCurrent = n === step;
        const isDone = n < step;
        return (
          <Fragment key={n}>
            <li
              aria-label={`${n} · ${label}`}
              aria-current={isCurrent ? "step" : undefined}
              className="flex items-center gap-2"
            >
              <span
                aria-hidden="true"
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${
                  isDone
                    ? "bg-grass text-white"
                    : isCurrent
                      ? "bg-pine text-white"
                      : "bg-sand text-ink-faint"
                }`}
              >
                {isDone ? <Check className="h-3.5 w-3.5" /> : n}
              </span>
              <span
                className={`text-xs font-semibold ${
                  isDone ? "text-grass-dark" : isCurrent ? "text-ink" : "text-ink-faint"
                } ${isCurrent ? "" : "hidden sm:inline"}`}
              >
                {label}
              </span>
            </li>
            {!isLast && (
              <span
                aria-hidden="true"
                className={`h-0.5 w-4 shrink-0 rounded-full sm:w-8 ${n < step ? "bg-grass" : "bg-line"}`}
              />
            )}
          </Fragment>
        );
      })}
    </ol>
  );
}
