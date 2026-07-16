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

/** STO-007 — shared sort dropdown for the Category/Search product grids. */
export default function SortSelect({ value, onChange }: SortSelectProps) {
  return (
    <label className="text-xs text-ink-soft flex items-center gap-1.5 shrink-0">
      {t("web.sort_label")}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        className="field w-auto! py-1.5! text-sm"
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
