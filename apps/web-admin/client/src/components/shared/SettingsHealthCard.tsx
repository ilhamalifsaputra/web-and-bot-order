import { Card, CardContent } from "@/components/ui/card";
import { ProgressBar } from "@/components/shared/ProgressBar";
import { StatusBadge } from "@/components/shared/StatusBadge";

export interface HealthSection {
  label: string;
  /** One of StatusBadge's configuration-status tone keys — see
   * components/shared/StatusBadge.tsx. */
  status: "CONFIGURED" | "NOT_CONFIGURED" | "OPTIONAL" | "ERROR";
}

interface SettingsHealthCardProps {
  sections: HealthSection[];
}

/**
 * Compact configuration-completeness summary (Settings refinement §5) —
 * deliberately small (`Card size="sm"`, one progress bar, one row of
 * badges): a glance, not a dashboard. Sits above the search+nav+content grid.
 */
export function SettingsHealthCard({ sections }: SettingsHealthCardProps): JSX.Element {
  const total = sections.length;
  const configured = sections.filter((s) => s.status === "CONFIGURED").length;
  const pct = total > 0 ? Math.round((configured / total) * 100) : 0;
  const tone = pct < 20 ? "rust" : pct < 50 ? "amberx" : "grass";

  return (
    <Card size="sm" className="mb-6">
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <div className="flex min-w-[7rem] items-baseline gap-2 sm:flex-col sm:items-start sm:gap-1">
          <span className="font-display text-2xl font-semibold text-ink">{pct}%</span>
          <span className="text-xs text-ink-soft">Configuration complete</span>
        </div>
        <div className="flex-1">
          <ProgressBar value={pct} tone={tone} className="mb-2" />
          <div className="flex flex-wrap gap-2">
            {sections.map((s) => (
              <span key={s.label} className="flex items-center gap-1.5 text-xs text-ink-soft">
                {s.label}
                <StatusBadge status={s.status} />
              </span>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
