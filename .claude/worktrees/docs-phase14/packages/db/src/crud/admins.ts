/**
 * Admin allow-list resolution (setup-wizard spec §5).
 *
 * The list of admin Telegram ids is the union of the env ADMIN_IDS and the
 * `admin_ids` Setting (CSV). The composition root resolves this once at boot and
 * stamps it into @app/core/runtime; the wizard / /admins can add ids live.
 */
import { config } from "@app/core/config";
import type { Db } from "./_types";
import { getSetting, setSetting } from "./settings";

export const ADMIN_IDS_KEY = "admin_ids";

function parseCsvIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n));
}

/** Union of env ADMIN_IDS and the DB `admin_ids` Setting (deduped). */
export async function resolveAdminIds(db: Db): Promise<number[]> {
  const dbIds = parseCsvIds(await getSetting(db, ADMIN_IDS_KEY));
  return Array.from(new Set([...config.ADMIN_IDS, ...dbIds].map(Number)));
}

/** Persist a new admin id into the DB Setting (idempotent). Returns full list. */
export async function addAdminIdToDb(db: Db, telegramId: number): Promise<number[]> {
  const current = parseCsvIds(await getSetting(db, ADMIN_IDS_KEY));
  const next = Array.from(new Set([...current, Number(telegramId)]));
  await setSetting(db, ADMIN_IDS_KEY, next.join(","));
  return next;
}

/** Remove an admin id from the DB Setting (does not touch env). Returns list. */
export async function removeAdminIdFromDb(db: Db, telegramId: number): Promise<number[]> {
  const next = parseCsvIds(await getSetting(db, ADMIN_IDS_KEY)).filter((n) => n !== Number(telegramId));
  await setSetting(db, ADMIN_IDS_KEY, next.join(","));
  return next;
}
