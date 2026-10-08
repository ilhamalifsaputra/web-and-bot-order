/**
 * Test DB helper: spin up an isolated Postgres schema inside the shared dev
 * database, create the tables in it, and hand back a PrismaClient bound to it.
 * Used by unit/integration tests so they never touch each other's data (or the
 * app's own `public` schema).
 *
 * The tables normally come from the run's template (copied in-database by
 * tests/helpers/schemaFromTemplate.ts, built once per run by whichever test
 * file needs it first); when there is no template to use, this falls back to
 * running `prisma db push` for the file, as it always used to.
 */
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { pushSchema, withSchema } from "./pgSchemaPlumbing";
import { createSchemaFromTemplate, ensureSchemaTemplate } from "./schemaFromTemplate";

export interface TestDb {
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}

/**
 * `connectionLimit` widens the client's connection pool for a concurrency test
 * that needs more transactions open at once than Prisma's default pool
 * (derived from the machine's core count, which can be as small as 5) allows —
 * otherwise the extra transactions just queue for a connection and the race
 * under test never happens.
 */
export async function makeTestDb(opts: { connectionLimit?: number } = {}): Promise<TestDb> {
  const baseUrl = process.env.DATABASE_URL_PRISMA;
  if (!baseUrl) {
    throw new Error("DATABASE_URL_PRISMA must be set to a Postgres connection string for tests.");
  }

  const schema = `test_${randomBytes(6).toString("hex")}`;
  const schemaUrl = withSchema(baseUrl, schema);
  const url = opts.connectionLimit
    ? (() => {
        const withLimit = new URL(schemaUrl);
        withLimit.searchParams.set("connection_limit", String(opts.connectionLimit));
        return withLimit.toString();
      })()
    : schemaUrl;
  // Same `transactionOptions` the real client is built with (packages/db/src/
  // client.ts). Left at Prisma's own defaults (maxWait 2000 / timeout 5000)
  // this harness gave every test a NARROWER concurrency envelope than
  // production has: a second caller blocked on a row lock — the intended
  // behavior of the `SELECT ... FOR UPDATE` guards in `executeRefund`,
  // `adjustWallet` and `replaceStockItem` — would give up with P2028 "Unable to
  // start a transaction in the given time" after 2s instead of waiting its turn
  // and meeting the guard it was supposed to meet. A test asserting on that
  // guard would then be asserting on the harness's timeout, and would go
  // red-or-green with machine load rather than with the code.
  const prisma = new PrismaClient({
    datasourceUrl: url,
    transactionOptions: { maxWait: 5000, timeout: 10000 },
  });

  try {
    const template = await ensureSchemaTemplate();
    if (template) {
      // Tables only, no seed rows: the slow path below never seeded either.
      await createSchemaFromTemplate(prisma, schema, template, { copySeedRows: false });
    } else {
      // No template this run: `prisma db push` issues the CREATE SCHEMA and
      // every CREATE TABLE itself, as this helper always did.
      pushSchema(url);
    }
  } catch (err) {
    // Either path can fail partway through provisioning (e.g. after the
    // schema was created but before all tables landed). Best-effort drop it so
    // a failed provision doesn't leave an orphaned test_* schema behind in the
    // shared dev database, then re-throw the original error.
    try {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // Nothing more we can do here; the original provisioning error is what matters.
    } finally {
      await prisma.$disconnect();
    }
    throw err;
  }

  return {
    prisma,
    cleanup: async () => {
      try {
        await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await prisma.$disconnect();
      }
    },
  };
}
