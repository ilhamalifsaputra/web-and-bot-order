/**
 * A segmented filter: one option is always selected and choosing another
 * filters the content below in place (`aria-pressed` toggle buttons inside a
 * labelled group). Deliberately NOT the rounded pine-tint pill used by the
 * home page's group nav and the category pills — those are links that jump or
 * navigate; this one filters, so it sits in a sand track with the selected
 * segment raised on a card surface.
 *
 * Scrolls sideways on a narrow screen instead of wrapping, with the scrollbar
 * hidden (same inline trio as TicketStatusFilterPills).
 */
import type { ReactNode } from "react";

export interface SegmentedFilterOption {
  value: string;
  label: ReactNode;
}

export interface SegmentedFilterProps {
  label: string;
  options: readonly SegmentedFilterOption[];
  value: string;
  onChange: (value: string) => void;
}

export default function SegmentedFilter({ label, options, value, onChange }: SegmentedFilterProps) {
  return (
    <div className="max-w-full overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div role="group" aria-label={label} className="inline-flex gap-1 rounded-xl bg-sand p-1">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(opt.value)}
              className={`inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors ${
                active ? "bg-card text-ink shadow-soft" : "text-ink-soft hover:bg-card/60 hover:text-ink"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
