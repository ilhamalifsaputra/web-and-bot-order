/**
 * Vitest global setup (wired in the root vitest.config.ts): builds the
 * once-per-run template that tests/helpers/schemaFromTemplate.ts copies each
 * test file's Postgres schema from, so the per-file helpers (testdb.ts,
 * pgTestSchema.ts) no longer spawn `prisma db push` and the chart-of-accounts
 * seed for every file.
 *
 * Runs in Vitest's main process before any worker starts. It hands the
 * template's schema name and DDL file path to the workers with `provide`
 * (read back with `inject`), Vitest's documented channel for this: provided
 * values are serialized into every worker's context, whereas process.env
 * changes made here are not part of Vitest's contract with its workers.
 *
 * If anything fails it warns once, cleans up, and provides nothing: the
 * helpers then fall back to the old per-file spawn path, which is slower but
 * otherwise identical — so a broken template costs time, never correctness.
 */
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
// Importing the generated Prisma client also loads the repository's root .env
// into process.env (the client does this itself at import time), which is how
// DATABASE_URL_PRISMA reaches this main-process code — the same mechanism that
// supplies it to the per-file helpers in the workers.
import "@prisma/client";
import type { GlobalSetupContext } from "vitest/node";
import type { PgTestTemplate } from "./schemaFromTemplate";
import { ROOT, dropSchema, pushSchema, seedChartOfAccounts, withSchema } from "./pgSchemaPlumbing";

const execAsync = promisify(exec);

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const baseUrl = process.env.DATABASE_URL_PRISMA;
  if (!baseUrl) {
    // Nothing to template against; the DB-backed helpers raise their own
    // clear error if a test actually needs a database.
    return async () => {};
  }

  const schema = `test_template_${randomBytes(6).toString("hex")}`;
  const url = withSchema(baseUrl, schema);
  const tempDir = mkdtempSync(join(tmpdir(), "pg-test-template-"));
  const ddlPath = join(tempDir, "schema.sql");

  const cleanup = async () => {
    try {
      await dropSchema(url, schema);
    } catch (err) {
      console.warn(
        `[test globalSetup] Could not drop the template schema ${schema}; it may be left behind in the dev database and can be dropped by hand. Reason: ${errorMessage(err)}`,
      );
    }
    rmSync(tempDir, { recursive: true, force: true });
  };

  // The DDL needs no database, so it is generated in a separate process while
  // the template is pushed and seeded, saving its couple of seconds of
  // start-up on every run. Its rejection is observed below, after the push.
  const ddlDone = execAsync(
    `pnpm exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script --output "${ddlPath}"`,
    { cwd: ROOT },
  );
  ddlDone.catch(() => {});
  try {
    // Exactly the commands the slow path runs per file, run once.
    pushSchema(url);
    seedChartOfAccounts(url);
    await ddlDone;
  } catch (err) {
    console.warn(
      `[test globalSetup] Building the test-schema template failed, so every test file will provision its own schema the slow way with prisma db push. Reason: ${errorMessage(err)}`,
    );
    // Let the DDL process finish before its temp directory is removed.
    await ddlDone.catch(() => {});
    await cleanup();
    return async () => {};
  }

  const template: PgTestTemplate = { schema, ddlPath };
  provide("pgTestTemplate", template);
  return cleanup;
}

// Subprocess errors embed the full command line, which never includes the URL
// (it is passed through the environment), but keep the message to its first
// line so subprocess output cannot leak into the log either.
function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split(/\r?\n/)[0] ?? "unknown error";
}
