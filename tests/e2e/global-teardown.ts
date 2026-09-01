/**
 * Drops the dedicated e2e schema (tests/e2e/schema.ts's E2E_SCHEMA) once the
 * whole Playwright run finishes, so the shared dev Postgres container
 * (docker-compose.postgres.yml — the same instance other worktrees/manual
 * dev sessions may be using) doesn't accumulate an orphaned schema every
 * time the suite runs. Best-effort and non-fatal: seed.ts drops-and-recreates
 * this same schema at the START of every run regardless, so a failure here
 * (e.g. the DB became unreachable mid-suite) only leaves stale rows behind
 * for the NEXT run's seed step to clean up, not a broken suite.
 */
import { PrismaClient } from "@prisma/client";
import { withSchema, E2E_SCHEMA } from "./schema";

export default async function globalTeardown(): Promise<void> {
  const baseUrl = process.env.DATABASE_URL_PRISMA;
  if (!baseUrl) return;
  // process.env.DATABASE_URL_PRISMA here is the *base* URL (playwright.config
  // .ts only overrides it for the webServer child process's own environment,
  // not this Node process's), so re-derive the schema-scoped URL the same way
  // the config does.
  const url = withSchema(baseUrl, E2E_SCHEMA);
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${E2E_SCHEMA}" CASCADE`);
  } catch (err) {
    console.warn("[e2e global-teardown] could not drop the e2e schema (non-fatal):", err);
  } finally {
    await prisma.$disconnect();
  }
}
