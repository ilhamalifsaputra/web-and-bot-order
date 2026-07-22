import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { FieldSaveStatus } from "@/hooks/useSettings";

interface SettingsSaveStatusProps {
  fieldStatuses: Map<string, FieldSaveStatus>;
  lastSavedAt: number | null;
}

function relativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

// After this long, "Saved 2 minutes ago" stops being useful information and
// just clutters the header — settle back to the quiet "All changes saved".
const DECAY_MS = 2 * 60 * 1000;

/**
 * Derives one page-header status pill from the many independent field saves
 * on this page (Settings refinement §10) — there is no unified draft/form
 * here, so this is a *summary* of `fieldStatuses` (reported up by each
 * FieldRow/GatewayCard) and the timestamp of the most recent successful
 * mutation, not a real "unsaved form" indicator.
 */
export function SettingsSaveStatus({ fieldStatuses, lastSavedAt }: SettingsSaveStatusProps): JSX.Element | null {
  // Re-render every 15s so "Saved 2 minutes ago" keeps advancing and the
  // decay-to-"All changes saved" threshold actually fires without a save.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const statuses = Array.from(fieldStatuses.values());
  if (statuses.includes("saving")) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-ink-soft" role="status" aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Saving…
      </span>
    );
  }
  if (statuses.includes("editing")) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-amberx" role="status">
        Unsaved changes
      </span>
    );
  }
  if (lastSavedAt === null) return null;
  const decayed = Date.now() - lastSavedAt > DECAY_MS;
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-soft" role="status">
      {decayed ? "All changes saved" : `Saved ${relativeTime(lastSavedAt)}`}
    </span>
  );
}
