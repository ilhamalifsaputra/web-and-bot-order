/**
 * Behavioural-test bootstrap — MUST be the first import in every order-bot
 * behaviour test file. Sets env + creates an isolated temp SQLite via
 * `prisma db push` BEFORE any `@app/*` module loads, so the `@app/db` prisma
 * singleton (which binds DATABASE_URL_PRISMA at construction) points at it.
 *
 * No `@app/*` imports here, so ESM evaluates these side effects first.
 * Mirrors apps/web-admin/test/setup-env.ts.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "orderbot-"));
const file = join(dir, "test.db");
export const DB_URL = `file:${file.replace(/\\/g, "/")}`;
export const TMP_DIR = dir;

process.env.DATABASE_URL_PRISMA = DB_URL;
process.env.BOT_TOKEN = "123:ABCDEFGHIJKLMNOPQRSTUVWXYZ-test";
process.env.BOT_USERNAME = "TestBot";
process.env.BINANCE_PAY_ID = "111222333";
// Admins are 999/1000 — the sample customer (tg 42) stays a CUSTOMER.
process.env.ADMIN_IDS = "999,1000";
process.env.CURRENCY = "USDT";
process.env.USE_UNIQUE_CENTS = "0";
process.env.DEFAULT_LANGUAGE = "en";
process.env.LOW_STOCK_THRESHOLD = "3";
process.env.PAYMENT_WINDOW_MINUTES = "30";
// Neutralize payment creds so a developer's real root .env can't leak live keys
// into the test process or make the auto-confirm "enabled" gate non-deterministic.
process.env.BYBIT_DEPOSIT_ADDRESS = "";
process.env.BYBIT_API_KEY = "";
process.env.BYBIT_API_SECRET = "";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL_PRISMA: DB_URL },
  stdio: "ignore",
});

export function cleanupTestDb(): void {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
