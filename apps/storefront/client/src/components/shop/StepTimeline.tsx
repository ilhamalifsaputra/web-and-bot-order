/**
 * Numbered step list with a connecting timeline — generalized from the
 * hand-rolled "Cara pesan" block that used to live only in HomePage.tsx (the
 * 4-step teaser there and the policy pages under `StaticPage` now share this
 * one implementation instead of two near-identical hand-rolled loops).
 *
 * `layout="grid"` is the homepage teaser shape: short label steps, a
 * responsive 2/4-column grid, horizontal connector once every step sits on
 * one row (`lg`). `layout="stacked"` is for paragraph-length bodies (the
 * policy pages): a single column with a continuous vertical connector.
 *
 * The step number is carried by the wrapping `<ol>`'s semantics for
 * assistive tech; the numeral badge itself is decorative (`aria-hidden`),
 * same treatment `Stepper.tsx` uses for its own numerals.
 */
import type { LucideIcon } from "lucide-react";

export interface StepItem {
  icon: LucideIcon;
  /** Omitted only when `description` is a fully custom node that renders its
   *  own heading(s) (How-to-Order's merged QRIS/USDT step). */
  title?: string;
  /** Plain text, a `Callout`, or any custom node — StepTimeline only owns the
   *  numbered badge and connector; the slot content is the caller's. */
  description?: React.ReactNode;
}

export interface StepTimelineProps {
  steps: StepItem[];
  layout?: "grid" | "stacked";
}

function StepBadge({ icon: Icon, n }: { icon: LucideIcon; n: number }) {
  return (
    <span
      aria-hidden="true"
      className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-pine text-white"
    >
      <Icon className="h-5 w-5" />
      <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-card text-[11px] font-bold text-pine ring-2 ring-pine">
        {n}
      </span>
    </span>
  );
}

function GridTimeline({ steps }: { steps: StepItem[] }) {
  return (
    <ol className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4 lg:gap-y-8">
      {steps.map((step, idx) => (
        <li key={idx} className="relative flex gap-4 lg:block">
          {idx < steps.length - 1 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-12 right-0 top-5 hidden h-px bg-line lg:block"
            />
          )}
          <StepBadge icon={step.icon} n={idx + 1} />
          <div className="min-w-0 lg:mt-4">
            {step.title && <h3 className="font-semibold text-ink">{step.title}</h3>}
            {step.description && <p className="mt-1 text-sm text-ink-soft">{step.description}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StackedTimeline({ steps }: { steps: StepItem[] }) {
  return (
    <ol>
      {steps.map((step, idx) => (
        <li key={idx} className={`relative flex gap-4 ${idx < steps.length - 1 ? "pb-8" : ""}`}>
          {idx < steps.length - 1 && (
            <span aria-hidden="true" className="absolute left-5 top-10 bottom-0 w-px bg-line" />
          )}
          <StepBadge icon={step.icon} n={idx + 1} />
          <div className="min-w-0 flex-1 pt-1.5">
            {step.title && <h3 className="font-display text-xl font-bold text-ink">{step.title}</h3>}
            {step.description && <div className={step.title ? "mt-2" : undefined}>{step.description}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function StepTimeline({ steps, layout = "stacked" }: StepTimelineProps) {
  return layout === "grid" ? <GridTimeline steps={steps} /> : <StackedTimeline steps={steps} />;
}
