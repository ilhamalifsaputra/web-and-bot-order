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
 * call provisions its own Postgres schema inside the shared dev database via
 * `prisma db push`, and returns a `cleanup()` that drops it again so
 * repeated test runs don't leave `test_*` schemas piling up in the dev
 * container.
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

function withSchema(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  return url.toString();
}

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
 * runs `prisma db push` against it.
 */
export function provisionPgTestSchema(prefix: string): PgTestSchemaEnv {
  const baseUrl = process.env.DATABASE_URL_PRISMA;
  if (!baseUrl) {
    throw new Error("DATABASE_URL_PRISMA must be set to a Postgres connection string before provisioning a test schema.");
  }

  const schema = `test_${prefix}_${randomBytes(6).toString("hex")}`;
  const url = withSchema(baseUrl, schema);

  try {
    execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL_PRISMA: url },
      stdio: "ignore",
    });
  } catch (err) {
    // db push can fail partway through (schema created, not all tables
    // landed) — best-effort drop it so a failed provision doesn't leave an
    // orphaned schema behind, then re-throw the original error.
    dropSchema(url, schema).catch(() => {});
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

async function dropSchema(url: string, schema: string): Promise<void> {
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await prisma.$disconnect();
  }
}
