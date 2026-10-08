/**
 * Low-level plumbing shared by the test-schema helpers (testdb.ts,
 * pgTestSchema.ts, schemaFromTemplate.ts) and the Vitest global setup's
 * teardown (globalSetup.ts): building a
 * schema-scoped connection URL, running the two provisioning subprocesses
 * (`prisma db push` and the chart-of-accounts seed), and dropping a schema.
 *
 * Like pgTestSchema.ts, this module must never import an `@app/*` module: its
 * callers run before the `@app/db` Prisma singleton is constructed, and an
 * import here would bind that singleton to the wrong URL.
 */
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root, where `prisma/schema.prisma` and `scripts/` live. */
export const ROOT = join(HERE, "..", "..");

/**
 * Builds a schema-scoped connection URL, preserving any query params already
 * on the base URL (such as `?connection_limit=`) rather than naively
 * string-concatenating.
 */
export function withSchema(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  return url.toString();
}

/**
 * Creates every table of the canonical Prisma schema inside the schema named
 * by `url`. `prisma db push`'s diffing issues the CREATE SCHEMA and all the
 * CREATE TABLE statements (in FK-correct order) itself — Postgres does not
 * create schemas implicitly.
 */
export function pushSchema(url: string): void {
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL_PRISMA: url },
    stdio: "ignore",
  });
}

/**
 * Seeds the Financial Ledger chart of accounts into the schema named by `url`.
 *
 * Run as a subprocess, not an import: the seed lives behind `@app/db`, and
 * loading that here would construct the app's Prisma singleton against the
 * wrong URL (see this file's header). A child process has its own singleton
 * and its own DATABASE_URL_PRISMA, so the ordering constraint does not apply.
 */
export function seedChartOfAccounts(url: string): void {
  execSync("pnpm exec tsx scripts/seed-chart-of-accounts.ts", {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL_PRISMA: url },
    stdio: "ignore",
  });
}

/** Drops `schema` (and everything in it) through a short-lived client. */
export async function dropSchema(url: string, schema: string): Promise<void> {
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await prisma.$disconnect();
  }
}
