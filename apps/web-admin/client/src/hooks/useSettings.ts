import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export interface SettingsField {
  key: string;
  label: string;
  secret: boolean;
  hasValue: boolean;
  value: string;
  needsRestart: boolean;
}

export interface PayMethodState {
  enabled: boolean;
  configured: boolean;
}

export interface BybitPollHealth {
  lastRun: string | null;
  lastSuccessAt: string | null;
  lastTxCount: number | null;
  backoffUntil: string | null;
  consecutiveRateLimitHits: number | null;
  lastRateLimitAt: string | null;
  consecutiveFailures: number | null;
  lastError: string | null;
}

export interface SettingsData {
  fields: SettingsField[];
  payMethodState: Record<string, PayMethodState>;
  bybitHealth: BybitPollHealth;
  bybitBscHealth: BybitPollHealth;
  isOwner: boolean;
  twoFaEnabled: boolean;
  twoFaPending: { secret: string; uri: string } | null;
}

/** Per-field save status a `FieldRow`/`GatewayCard` reports upward, purely so
 * the page-header `SettingsSaveStatus` pill (Settings refinement §10) can
 * derive one combined label. Not persisted, not server state — a small piece
 * of page-owned UI state (09_CODE_STYLE.md §4: local state lives with the
 * component that owns it; `SettingsPage` is the only consumer). */
export type FieldSaveStatus = "editing" | "saving";

export function useSettings() {
  const qc = useQueryClient();
  const query = useQuery<SettingsData>({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
      return res.json() as Promise<SettingsData>;
    },
  });

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["settings"] });
  }, [qc]);

  // fieldStatus is intentionally a ref-backed Map, not useState<Map>, so a
  // status update from a FieldRow doesn't re-render every other FieldRow on
  // the page (Settings refinement §15 "avoid unnecessary re-renders") — only
  // SettingsSaveStatus (the one consumer) re-renders, via the bumped tick.
  const fieldStatusRef = useRef<Map<string, FieldSaveStatus>>(new Map());
  const [, bumpTick] = useState(0);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  const setFieldStatus = useCallback((key: string, status: FieldSaveStatus | null) => {
    if (status === null) fieldStatusRef.current.delete(key);
    else fieldStatusRef.current.set(key, status);
    bumpTick((n) => n + 1);
  }, []);

  const markSaved = useCallback(() => {
    setLastSavedAt(Date.now());
  }, []);

  return {
    ...query,
    invalidate,
    fieldStatuses: fieldStatusRef.current,
    setFieldStatus,
    lastSavedAt,
    markSaved,
  };
}
