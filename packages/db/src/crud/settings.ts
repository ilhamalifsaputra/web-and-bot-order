/**
 * Runtime key/value settings — port of the "Settings" section of crud.py.
 */
import type { Db } from "./_types";

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const s = await db.setting.findUnique({ where: { key } });
  return s ? s.value : null;
}

export async function setSetting(db: Db, key: string, value: string) {
  await db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export function listAllSettings(db: Db) {
  return db.setting.findMany({ orderBy: { key: "asc" } });
}

/** Remove a setting if present (no-op if it doesn't exist). */
export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.setting.deleteMany({ where: { key } });
}
