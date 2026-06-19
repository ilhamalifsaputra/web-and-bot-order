/**
 * Test DB helper: spin up an isolated SQLite file, create the schema with
 * `prisma db push`, and hand back a PrismaClient bound to it. Used by
 * unit/integration tests so they never touch the shared dev DB.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

export interface TestDb {
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}

export async function makeTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "botdb-"));
  const file = join(dir, "test.db");
  const url = `file:${file.replace(/\\/g, "/")}`;

  // db push creates all tables in FK-correct order from the canonical schema.
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL_PRISMA: url },
    stdio: "ignore",
  });

  const prisma = new PrismaClient({ datasourceUrl: url });

  return {
    prisma,
    cleanup: async () => {
      await prisma.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
