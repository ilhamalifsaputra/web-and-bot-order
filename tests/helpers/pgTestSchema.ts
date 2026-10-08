/**
 * Shared plumbing for the app-level `test/setup-*.ts` bootstrap files
 * (apps/order-bot/test/setup-db.ts, apps/server/test/setup-env.ts,
 * apps/storefront/test/setup-env.ts, apps/web-admin/test/setup-env.ts,
 * packages/outbox-dispatcher/src/dispatcher.test-setup.ts).
 *
 * Those files must run before any `@app/*` module loads (so the `@app/db`
 * Prisma singleton binds to the right URL at construction), which is why
 * this helper only imports `@prisma/client` directly — never `@app/*`.
 *
 * Mirrors tests/helpers/testdb.ts's schema-per-run approach (Task 10): each
 * call provisions its own Postgres schema inside the shared dev database,
 * with the tables and the seeded chart of accounts, and returns a `cleanup()`
 * that drops it again so repeated test runs don't leave `test_*` schemas
 * piling up in the dev container. The schema is normally copied in-database
 * from the run's template (tests/helpers/schemaFromTemplate.ts, built once by
 * globalSetup.ts with the same two commands); when no template was provided it
 * falls back to running `prisma db push` and the seed script for this file.
 */
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { dropSchema, pushSchema, seedChartOfAccounts, withSchema } from "./pgSchemaPlumbing";
import { createSchemaFromTemplate, getSchemaTemplate } from "./schemaFromTemplate";

export interface PgTestSchemaEnv {
  /** Schema-scoped DATABASE_URL_PRISMA to bind the app's Prisma singleton to. */
  url: string;
  /** Drops the provisioned schema. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Provisions an isolated Postgres schema (named `test_<prefix>_<random>`)
 * inside the database at `process.env.DATABASE_URL_PRISMA` (must already be
 * a Postgres connection string — e.g. this worktree's dev container) and
 * fills it from the run's template, or with `prisma db push` plus the
 * chart-of-accounts seed when there is none.
 */
export async function provisionPgTestSchema(prefix: string): Promise<PgTestSchemaEnv> {
  const baseUrl = process.env.DATABASE_URL_PRISMA;
  if (!baseUrl) {
    throw new Error("DATABASE_URL_PRISMA must be set to a Postgres connection string before provisioning a test schema.");
  }

  const schema = `test_${prefix}_${randomBytes(6).toString("hex")}`;
  const url = withSchema(baseUrl, schema);

  try {
    const template = getSchemaTemplate();
    if (template) {
      // Already seeded: the template holds the chart of accounts, and its rows
      // are copied across along with the tables.
      const prisma = new PrismaClient({ datasourceUrl: url });
      try {
        await createSchemaFromTemplate(prisma, schema, template);
      } finally {
        await prisma.$disconnect();
      }
    } else {
      pushSchema(url);
      // Seed the chart of accounts (Financial Ledger M3). Order settlement,
      // wallet top-ups, manual wallet adjustments and referral commissions all
      // post to the double-entry ledger now, so a schema without these 15 rows
      // makes every app-level suite exercise those paths with the posting
      // SKIPPED (`postOrSkipMissingAccount`) rather than performed — which
      // passes, but tests a shop with no books instead of the real thing. It
      // runs as a subprocess for the reason given in pgSchemaPlumbing.ts.
      seedChartOfAccounts(url);
    }
  } catch (err) {
    // Either path can fail partway through (schema created, not all tables
    // landed) — best-effort drop it so a failed provision doesn't leave an
    // orphaned schema behind, then re-throw the original error.
    await dropSchema(url, schema).catch(() => {});
    throw err;
  }

  // Some callers (self-registered afterAll here, plus a test file's own
  // explicit cleanupTestDb() call) may both invoke cleanup(). Share the same
  // in-flight promise rather than a "started" flag, so whichever call
  // resolves last still actually waits for the drop to finish instead of
  // racing past a cleanup that's still in flight.
  let cleanupPromise: Promise<void> | null = null;
  return {
    url,
    cleanup: () => {
      if (!cleanupPromise) {
        cleanupPromise = dropSchema(url, schema);
      }
      return cleanupPromise;
    },
  };
}
