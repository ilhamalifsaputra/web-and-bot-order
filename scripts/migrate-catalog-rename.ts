/**
 * Catalog rename cutover (Category → Product → Denomination). Run on the box
 * that holds the SQLite DB, with the bot/notifier/web STOPPED and a fresh
 * backup of data/bot.db (+ -wal/-shm) taken first:
 *
 *   pnpm migrate-catalog-rename [path-to.db]
 *
 * Default path: $DATABASE_URL_PRISMA (file: prefix stripped) or data/bot.db.
 * The cutover preserves old `products` ids as `denominations.id`, wraps each
 * ungrouped SKU in a 1:1 parent Product, backfills slugs, and ends with a
 * foreign_key_check gate. It is NOT idempotent — run exactly once on the backup.
 *
 * After it succeeds: `pnpm prisma generate`, then start the new code.
 */
import { DatabaseSync } from "node:sqlite";
import { migrateCatalogRename } from "../packages/db/src/migrate/catalogRename";

function resolvePath(): string {
  const arg = process.argv[2];
  if (arg) return arg;
  const url = process.env.DATABASE_URL_PRISMA;
  if (url) return url.replace(/^file:/, "");
  return "data/bot.db";
}

const path = resolvePath();
console.log(`[migrate-catalog-rename] target DB: ${path}`);
const db = new DatabaseSync(path);
try {
  migrateCatalogRename(db);
  console.log("[migrate-catalog-rename] OK — FK integrity gate passed, slugs backfilled.");
  console.log("[migrate-catalog-rename] next: pnpm prisma generate, then restart services.");
} finally {
  db.close();
}
