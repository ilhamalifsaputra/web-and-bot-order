/**
 * Behavioural-test bootstrap — MUST be the first import in every order-bot
 * behaviour test file. Sets env + creates an isolated Postgres schema
 * (inside the shared dev container) via `prisma db push` BEFORE any
 * `@app/*` module loads, so the `@app/db` prisma singleton (which binds
 * DATABASE_URL_PRISMA at construction) points at it.
 *
 * No `@app/*` imports here, so ESM evaluates these side effects first.
 * Mirrors apps/web-admin/test/setup-env.ts. The provisioned schema is
 * dropped automatically in a self-registered `afterAll` — no per-test-file
 * cleanup call needed.
 */
import { afterAll } from "vitest";
import { provisionPgTestSchema } from "../../../tests/helpers/pgTestSchema";

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

const schemaEnv = await provisionPgTestSchema("orderbot");
export const DB_URL = schemaEnv.url;
process.env.DATABASE_URL_PRISMA = DB_URL;

afterAll(schemaEnv.cleanup);

/** @deprecated kept for callers that still invoke it explicitly; cleanup now also runs automatically via afterAll above. */
export function cleanupTestDb(): Promise<void> {
  return schemaEnv.cleanup();
}
