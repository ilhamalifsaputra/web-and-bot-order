/**
 * Test environment bootstrap — MUST be the first import in every apps/server
 * test file. Sets the env that the shared `@app/core/config` + `@app/db` Prisma
 * singleton read at import time, then creates the schema in an isolated
 * Postgres schema (inside the shared dev container) via `prisma db push`.
 * Has no `@app/*` imports, so ESM evaluates these side effects before any
 * `@app` module loads. Mirrors the web-admin setup. The provisioned schema
 * is dropped automatically in a self-registered `afterAll` — no
 * per-test-file cleanup call needed.
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

const schemaEnv = await provisionPgTestSchema("server");
export const DB_URL = schemaEnv.url;
process.env.DATABASE_URL_PRISMA = DB_URL;

afterAll(schemaEnv.cleanup);

/** @deprecated kept for callers that still invoke it explicitly; cleanup now also runs automatically via afterAll above. */
export function cleanupTestDb(): Promise<void> {
  return schemaEnv.cleanup();
}
