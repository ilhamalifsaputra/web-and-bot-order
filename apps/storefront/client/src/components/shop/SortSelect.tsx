import { ArrowUpDown } from "lucide-react";
import type { SortKey } from "../../api/types";
import { t } from "../../lib/i18n";

const SORT_OPTIONS: { value: SortKey; labelKey: string }[] = [
  { value: "default", labelKey: "web.sort_default" },
  { value: "cheapest", labelKey: "web.sort_cheapest" },
  { value: "newest", labelKey: "web.sort_newest" },
  { value: "rating", labelKey: "web.sort_rating" },
];

export interface SortSelectProps {
  value: SortKey;
  onChange: (value: SortKey) => void;
}

/**
 * STO-007 — shared sort dropdown for the Category/Search/Products/Flash grids.
 *
 * On a phone this used to be a 12px word pinned to the right edge above the
 * grid, which reads as page furniture rather than a control, and its
 * `py-1.5!`/`text-sm` overrides cancelled exactly the 44px height and 16px
 * font `.field` exists to guarantee (a sub-16px select also makes iOS Safari
 * zoom the whole page on focus). It now claims the full row on a phone — icon
 * plus label on the left, a full-height select filling the rest — and falls
 * back to its compact inline shape from `sm` up, where the callers' right
 * alignment still makes sense.
 */
export default function SortSelect({ value, onChange }: SortSelectProps) {
  return (
    <label className="flex w-full items-center gap-2 sm:w-auto">
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-ink-soft">
        <ArrowUpDown className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        {t("web.sort_label")}
      </span>
      {/* `min-w-0` so the select may shrink inside the flex row instead of
          pushing the label off a 320px screen. */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        className="field min-w-0 flex-1 sm:w-auto! sm:flex-none"
      >
        {SORT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {t(opt.labelKey)}
          </option>
        ))}
      </select>
    </label>
  );
}
