/**
 * TSX port of `stepper(step, lang)` in apps/storefront/views/_shop.njk
 * (design.md §4.6) — the checkout progress indicator: 1 Cart → 2 Payment →
 * 3 Done.
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
        return (
          <Fragment key={n}>
            <li
              className={`chip ${
                n < step ? "bg-grass-tint text-grass-dark" : n === step ? "bg-pine text-white" : "bg-sand text-ink-soft"
              }`}
            >
              {n} · {label}
            </li>
            {!isLast && <ChevronRight className="h-3.5 w-3.5 text-ink-faint" />}
          </Fragment>
        );
      })}
    </ol>
  );
}
