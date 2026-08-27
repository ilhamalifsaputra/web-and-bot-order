/**
 * Test DB helper: spin up an isolated Postgres schema inside the shared dev
 * database, create the tables in it with `prisma db push`, and hand back a
 * PrismaClient bound to it. Used by unit/integration tests so they never
 * touch each other's data (or the app's own `public` schema).
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

export interface TestDb {
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}

// Builds a schema-scoped connection URL, preserving any query params already
// on the base URL (same care the removed `withConnectionLimit` helper took
// for SQLite's `?connection_limit=`) rather than naively string-concatenating.
function withSchema(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  return url.toString();
}

export async function makeTestDb(): Promise<TestDb> {
  const baseUrl = process.env.DATABASE_URL_PRISMA;
  if (!baseUrl) {
    throw new Error("DATABASE_URL_PRISMA must be set to a Postgres connection string for tests.");
  }

  const schema = `test_${randomBytes(6).toString("hex")}`;
  const url = withSchema(baseUrl, schema);

  // db push creates the schema (Postgres creates it implicitly on first use
  // when it doesn't exist) and all tables in FK-correct order from the
  // canonical schema.
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL_PRISMA: url },
    stdio: "ignore",
  });

  const prisma = new PrismaClient({ datasourceUrl: url });

  return {
    prisma,
    cleanup: async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await prisma.$disconnect();
    },
  };
}
