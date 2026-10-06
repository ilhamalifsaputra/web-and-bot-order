/**
 * The list of denominations the hourly Digiflazz catalog resync switched off
 * itself (Digiflazz reported the SKU unavailable). Only ids in this list are
 * ever switched back on automatically when Digiflazz recovers
 * (resyncDigiflazzCatalog in ./digiflazz).
 *
 * An admin's own active/inactive toggle takes a denomination out of the list
 * (bulkSetDenominationsActive in ./catalog calls forgetDigiflazzAutoDeactivatedIds),
 * so a SKU an admin decided about by hand is never touched by the sync again.
 *
 * Stored as a JSON number[] under one Settings key; every change is a
 * read-modify-write under a row lock so concurrent writers merge rather than
 * overwrite. Kept in its own module so ./catalog can use it without importing
 * ./digiflazz (which imports ./catalog).
 */
import type { Db } from "./_types";
import type { Tx } from "../client";

export const DIGIFLAZZ_AUTO_DEACTIVATED_IDS_KEY = "digiflazz_auto_deactivated_ids";

/** Read a stored id list; a missing or malformed value is an empty list. */
export function parseDigiflazzIdList(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

/** The ids currently remembered, read straight from the table (never cached). */
export async function getDigiflazzAutoDeactivatedIds(db: Db): Promise<number[]> {
  const row = await db.setting.findUnique({ where: { key: DIGIFLAZZ_AUTO_DEACTIVATED_IDS_KEY } });
  return parseDigiflazzIdList(row?.value);
}

/**
 * Apply a change to the remembered list under a row lock: first drop `remove`,
 * then add `add` (so an id in both ends up remembered). Opens its own
 * transaction when handed the bare client and reuses the caller's otherwise.
 */
export async function updateDigiflazzAutoDeactivatedIds(
  db: Db,
  change: { add?: number[]; remove?: Iterable<number> },
): Promise<void> {
  const add = change.add ?? [];
  const remove = new Set(change.remove ?? []);
  if (add.length === 0 && remove.size === 0) return;
  const run = async (tx: Db) => {
    const key = DIGIFLAZZ_AUTO_DEACTIVATED_IDS_KEY;
    await tx.setting.upsert({ where: { key }, create: { key, value: "[]" }, update: {} });
    await tx.$queryRaw`SELECT key FROM settings WHERE key = ${key} FOR UPDATE`;
    const current = parseDigiflazzIdList((await tx.setting.findUniqueOrThrow({ where: { key } })).value);
    const next = new Set(current.filter((id) => !remove.has(id)));
    for (const id of add) next.add(id);
    await tx.setting.update({ where: { key }, data: { value: JSON.stringify([...next].sort((a, b) => a - b)) } });
  };
  const ownsTransaction = "$transaction" in db && typeof db.$transaction === "function";
  if (ownsTransaction) await db.$transaction((tx: Tx) => run(tx));
  else await run(db);
}

/**
 * Forget these ids — called when an admin sets a denomination's active state
 * by hand. Skips the lock entirely when none of them is remembered, which is
 * the normal case for every non-Digiflazz toggle.
 */
export async function forgetDigiflazzAutoDeactivatedIds(db: Db, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const remembered = new Set(await getDigiflazzAutoDeactivatedIds(db));
  if (!ids.some((id) => remembered.has(id))) return;
  await updateDigiflazzAutoDeactivatedIds(db, { remove: ids });
}
