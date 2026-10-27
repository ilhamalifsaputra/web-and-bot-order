/**
 * Test environment bootstrap — MUST be the first import in every web-admin
 * test file. It sets the env the shared `@app/core/config` + `@app/db` Prisma
 * singleton read at import time, then creates the schema in an isolated
 * Postgres schema (inside the shared dev container) via `prisma db push`.
 * Because it has no `@app/*` imports, ESM evaluates it (and these side
 * effects) before any `@app` module is loaded.
 *
 * The provisioned schema is dropped automatically in a self-registered
 * `afterAll` — no per-test-file cleanup call needed (a Postgres schema has
 * to be dropped explicitly or it lingers in the shared dev database).
 *
 * Mirrors telegram-stock-web/tests/conftest.py's env preamble.
 */
import { afterAll } from "vitest";
import { provisionPgTestSchema } from "../../../tests/helpers/pgTestSchema";

process.env.WEB_COOKIE_SECRET = "test-secret-key-at-least-32-chars-long-xx";
process.env.ADMIN_IDS = "999,1000";
process.env.BOT_TOKEN = "123:ABCDEFGHIJKLMNOPQRSTUVWXYZ-test";
process.env.BOT_USERNAME = "TestBot";
process.env.BINANCE_PAY_ID = "111222333";
process.env.USE_UNIQUE_CENTS = "0";
process.env.DEFAULT_LANGUAGE = "en";
// Pinned like apps/order-bot/test/setup-db.ts does, so the dashboard's
// QRIS staleness tests (whose reconcile budget scales with this window —
// packages/core/src/payments/reconcileCycleBudget.ts) do not change meaning
// when a developer's `.env` moves to the 10-minute default.
process.env.PAYMENT_WINDOW_MINUTES = "30";

const schemaEnv = await provisionPgTestSchema("webadmin");
export const DB_URL = schemaEnv.url;
process.env.DATABASE_URL_PRISMA = DB_URL;

afterAll(schemaEnv.cleanup);

/** @deprecated kept for callers that still invoke it explicitly; cleanup now also runs automatically via afterAll above. */
export function cleanupTestDb(): Promise<void> {
  return schemaEnv.cleanup();
}
