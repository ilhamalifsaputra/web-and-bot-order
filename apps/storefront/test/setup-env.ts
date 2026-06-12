/**
 * Test environment bootstrap — MUST be the first import in every storefront
 * test file. Sets the env that `@app/core/config` + the `@app/db` Prisma
 * singleton read at import time, then creates the schema in an isolated temp
 * SQLite via `prisma db push`. Mirror of apps/web-admin/test/setup-env.ts.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "storefront-"));
const file = join(dir, "test.db");
export const DB_URL = `file:${file.replace(/\\/g, "/")}`;
export const TMP_DIR = dir;

process.env.DATABASE_URL_PRISMA = DB_URL;
process.env.WEB_COOKIE_SECRET = "test-secret-key-at-least-32-chars-long-xx";
process.env.ADMIN_IDS = "999,1000";
process.env.BOT_TOKEN = "123:ABCDEFGHIJKLMNOPQRSTUVWXYZ-test";
process.env.BOT_USERNAME = "TestBot";
process.env.BINANCE_PAY_ID = "111222333";
process.env.USE_UNIQUE_CENTS = "0";
process.env.DEFAULT_LANGUAGE = "en";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL_PRISMA: DB_URL },
  stdio: "ignore",
});

export function cleanupTestDb(): void {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
