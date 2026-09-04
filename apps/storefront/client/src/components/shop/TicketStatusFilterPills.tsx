/**
 * The status-filter pill row above the /help "My tickets" list.
 *
 * Controlled: the parent (HelpPage) owns the active filter and the counts; this
 * component only renders the six pills and reports clicks. On a narrow screen
 * the row scrolls sideways rather than wrapping into three ragged lines — the
 * scrollbar itself is hidden (there is no shared utility for that in this app,
 * so the vendor-prefixed trio is inlined here).
 */
import { t } from "../../lib/i18n";
import type { SupportTicketStats } from "../../api/types";

export type TicketStatusFilterKey =
  | "all"
  | "waiting_for_you"
  | "waiting_for_support"
  | "in_progress"
  | "resolved"
  | "closed";

export interface TicketStatusFilterPillsProps {
  active: TicketStatusFilterKey;
  counts: SupportTicketStats;
  onChange: (key: TicketStatusFilterKey) => void;
}

// The i18n suffix does not fall out of the key by a plain string rule
// ("waiting_for_you" -> "waiting_you"), so the mapping is explicit.
const PILLS: { key: TicketStatusFilterKey; labelKey: string }[] = [
  { key: "all", labelKey: "web.help_filter_all" },
  { key: "waiting_for_you", labelKey: "web.help_filter_waiting_you" },
  { key: "waiting_for_support", labelKey: "web.help_filter_waiting_support" },
  { key: "in_progress", labelKey: "web.help_filter_in_progress" },
  { key: "resolved", labelKey: "web.help_filter_resolved" },
  { key: "closed", labelKey: "web.help_filter_closed" },
];

export default function TicketStatusFilterPills({ active, counts, onChange }: TicketStatusFilterPillsProps) {
  return (
    <div className="flex flex-nowrap gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {PILLS.map(({ key, labelKey }) => {
        const isActive = key === active;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(key)}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              isActive
                ? "bg-pine text-white"
                : "border border-line bg-card text-ink-soft hover:bg-sand"
            }`}
          >
            {t(labelKey)} ({counts[key]})
          </button>
        );
      })}
    </div>
  );
}
