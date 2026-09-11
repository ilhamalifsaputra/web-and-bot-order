/**
 * Digiflazz catalog re-sync outcome storage.
 *
 * Follows the same "JSON blob under one Settings key" pattern as
 * `poll_health.ts`, but unlike that module this is NOT keyed by rail — there
 * is only ever one Digiflazz catalog sync, so it's a single fixed key. This
 * store only ever holds the MOST RECENT run's outcome (no sticky fields, no
 * merge on write) — it complements the `digiflazzCatalogSync` poll_health
 * rail, which tracks staleness/heartbeat only; this module holds the rich
 * "what actually happened" result (updated/deactivated counts, abort
 * reason).
 */
import type { Db } from "./_types";
import { getSetting, setSetting } from "./settings";

export const DIGIFLAZZ_SYNC_STATUS_KEY = "digiflazz_catalog_sync_status";

export interface DigiflazzSyncStatus {
  status: "success" | "aborted" | "error";
  updated: number;
  deactivated: number;
  abortReason: "sharp_change" | "no_usable_rows" | null;
  finishedAt: string; // ISO 8601
}

/** Read the last hourly catalog re-sync's outcome. Returns null when the
 * sync has never run (no Settings row yet), the stored blob fails to parse,
 * or the parsed blob is missing a required field — a corrupt/incomplete
 * blob degrades to "never run" rather than throwing or inventing per-field
 * defaults (unlike `poll_health.ts`'s all-nullable shape, every field here
 * is required whenever `status` is present). */
export async function getDigiflazzSyncStatus(db: Db): Promise<DigiflazzSyncStatus | null> {
  const raw = await getSetting(db, DIGIFLAZZ_SYNC_STATUS_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<DigiflazzSyncStatus>;
    if (p.status !== "success" && p.status !== "aborted" && p.status !== "error") return null;
    if (typeof p.updated !== "number") return null;
    if (typeof p.deactivated !== "number") return null;
    if (p.abortReason !== "sharp_change" && p.abortReason !== "no_usable_rows" && p.abortReason !== null) return null;
    if (typeof p.finishedAt !== "string") return null;
    return {
      status: p.status,
      updated: p.updated,
      deactivated: p.deactivated,
      abortReason: p.abortReason,
      finishedAt: p.finishedAt,
    };
  } catch {
    return null;
  }
}

/** Record one hourly catalog re-sync's outcome — called once per cron tick
 * from `resyncDigiflazzCatalog` (a later task), at every return point (both
 * abort branches and normal completion, including a no-op tick that changed
 * nothing). Overwrites the previous status entirely — no merge, since this
 * store only ever needs to know about the MOST RECENT run. */
export async function recordDigiflazzSyncStatus(db: Db, status: DigiflazzSyncStatus): Promise<void> {
  await setSetting(db, DIGIFLAZZ_SYNC_STATUS_KEY, JSON.stringify(status));
}
