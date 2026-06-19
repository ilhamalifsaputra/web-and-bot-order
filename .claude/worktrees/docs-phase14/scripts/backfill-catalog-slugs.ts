/**
 * Idempotent slug backfill for categories / products / denominations. The main
 * cutover (scripts/migrate-catalog-rename.ts) already fills slugs inline; this is
 * a safety net / repair tool for any rows left with a NULL or empty slug (e.g.
 * created by an older code path). Safe to run repeatedly.
 *
 *   pnpm backfill-catalog-slugs [path-to.db]
 *
 * SQLite core has no regex, so slugs are computed in TS (slugify) and written
 * back, deduped against the slugs already present in each table.
 */
import { DatabaseSync } from "node:sqlite";
import { uniqueSlug } from "../packages/db/src/migrate/slug";

type Row = Record<string, unknown>;

function resolvePath(): string {
  const arg = process.argv[2];
  if (arg) return arg;
  const url = process.env.DATABASE_URL_PRISMA;
  if (url) return url.replace(/^file:/, "");
  return "data/bot.db";
}

function backfill(db: DatabaseSync, table: string): number {
  const taken = new Set<string>();
  for (const r of db.prepare(`SELECT slug FROM "${table}" WHERE slug IS NOT NULL AND slug<>''`).all() as Row[]) {
    taken.add(String(r.slug));
  }
  const missing = db.prepare(`SELECT id, name FROM "${table}" WHERE slug IS NULL OR slug=''`).all() as Row[];
  const upd = db.prepare(`UPDATE "${table}" SET slug=? WHERE id=?`);
  for (const row of missing) {
    upd.run(uniqueSlug(String(row.name), Number(row.id), taken), row.id);
  }
  return missing.length;
}

const path = resolvePath();
console.log(`[backfill-catalog-slugs] target DB: ${path}`);
const db = new DatabaseSync(path);
try {
  for (const table of ["categories", "products", "denominations"]) {
    const fixed = backfill(db, table);
    console.log(`[backfill-catalog-slugs] ${table}: ${fixed} slug(s) filled`);
  }
} finally {
  db.close();
}
