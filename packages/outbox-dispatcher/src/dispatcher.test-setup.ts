/**
 * dispatcher.test.ts bootstrap — MUST be the first import in that file. Sets
 * DATABASE_URL_PRISMA to an isolated temp SQLite and pushes the schema BEFORE
 * any @app/* module loads, so the @app/db `prisma` singleton (which
 * dispatcher.ts uses directly, not an injected client — binds
 * DATABASE_URL_PRISMA at construction) points at it.
 *
 * No @app/* imports here, so ESM evaluates these side effects first. Mirrors
 * apps/order-bot/test/setup-db.ts.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "outboxdispatcher-"));
const file = join(dir, "test.db");
export const DB_URL = `file:${file.replace(/\\/g, "/")}`;
export const TMP_DIR = dir;

process.env.DATABASE_URL_PRISMA = DB_URL;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL_PRISMA: DB_URL },
  stdio: "ignore",
});

export function cleanupTestDb(): void {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
