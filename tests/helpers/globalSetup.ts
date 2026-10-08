/**
 * Vitest global setup (wired in the root vitest.config.ts) for the test-schema
 * template that tests/helpers/schemaFromTemplate.ts copies each test file's
 * Postgres schema from.
 *
 * It does no database work and spawns nothing: it only picks this run's
 * template schema name and the temp directory its DDL will live in, and hands
 * both to the workers with `provide` (read back with `inject`, Vitest's
 * documented channel for this — provided values are serialized into every
 * worker's context). The template itself is built lazily by the first test
 * file that actually needs a database (see `ensureSchemaTemplate`), so a run
 * with no DB tests — a guard run, a jsdom client run, a one-file
 * `test:changed` — pays nothing for it.
 *
 * The name carries the run's start time in epoch seconds so that a template
 * leaked by an aborted run can be recognised by age and dropped by a later
 * run's builder.
 */
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import type { PgTestTemplate } from "./schemaFromTemplate";

// Vitest 4 hands globalSetup the TestProject itself; `provide` is a method on
// it, so it is called on the project rather than destructured. Vitest runs
// this for the root project and for every project (node, frontend) that has
// test files in the run; each picks its own name, and only a project whose
// tests need a database ever builds the template it named.
export default function setup(project: TestProject): () => Promise<void> {
  const schema = `test_template_${Math.floor(Date.now() / 1000)}_${randomBytes(6).toString("hex")}`;
  const workDir = join(tmpdir(), `pg-${schema}`);
  const template: PgTestTemplate = { schema, workDir };
  project.provide("pgTestTemplate", template);

  return async () => {
    // The builder creates the directory before it touches the database, so
    // its absence means no worker ever built (or tried to build) the
    // template, and there is nothing to drop — no connection is opened.
    if (!existsSync(workDir)) return;
    try {
      // Imported lazily so a run that never built the template does not even
      // load the Prisma client. The import also loads the root .env, which is
      // how DATABASE_URL_PRISMA reaches this main-process code.
      const { dropSchema, withSchema } = await import("./pgSchemaPlumbing");
      const baseUrl = process.env.DATABASE_URL_PRISMA;
      if (baseUrl) await dropSchema(withSchema(baseUrl, schema), schema);
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0];
      console.warn(
        `[test globalSetup] Could not drop the template schema ${schema}; a later run drops it once it is six hours old. Reason: ${reason}`,
      );
    }
    rmSync(workDir, { recursive: true, force: true });
  };
}
