/**
 * dispatcher.test.ts bootstrap — MUST be the first import in that file. Sets
 * DATABASE_URL_PRISMA to an isolated Postgres schema (inside the shared dev
 * container) and pushes the schema BEFORE any @app/* module loads, so the
 * @app/db `prisma` singleton (which dispatcher.ts uses directly, not an
 * injected client — binds DATABASE_URL_PRISMA at construction) points at it.
 *
 * No @app/* imports here, so ESM evaluates these side effects first. Mirrors
 * apps/order-bot/test/setup-db.ts. The provisioned schema is dropped
 * automatically in a self-registered `afterAll`; the exported
 * `cleanupTestDb()` dispatcher.test.ts still calls explicitly is now just an
 * idempotent alias for the same cleanup (safe to call twice).
 */
import { afterAll } from "vitest";
import { provisionPgTestSchema } from "../../../tests/helpers/pgTestSchema";

const schemaEnv = provisionPgTestSchema("outboxdispatcher");
export const DB_URL = schemaEnv.url;
process.env.DATABASE_URL_PRISMA = DB_URL;

afterAll(schemaEnv.cleanup);

export function cleanupTestDb(): Promise<void> {
  return schemaEnv.cleanup();
}
