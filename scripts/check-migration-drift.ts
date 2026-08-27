/**
 * Wrapper for `prisma migrate diff --from-migrations ... --to-schema-datamodel ...`
 * (the drift check described in docs/MIGRATIONS.md, "Cek drift migrasi-vs-schema
 * di CI") that supplies the `--shadow-database-url` PostgreSQL requires for a
 * `--from-migrations` comparison.
 *
 * SQLite never needed this flag — Prisma shadows a `--from-migrations` diff with
 * a throwaway temp file automatically for that provider. PostgreSQL's CLI has no
 * such auto-provisioning for `migrate diff` specifically (unlike `migrate dev`,
 * which *can* auto-create/drop a shadow database given CREATEDB privilege): it
 * refuses outright with "You must pass the --shadow-database-url if you want to
 * diff a migrations directory" (verified empirically switching this repo to
 * postgresql, 2026-08-27, engine-swap task 4).
 *
 * This reuses a fixed, dedicated schema (`_migration_diff_shadow`) inside the
 * SAME database `DATABASE_URL_PRISMA` already points at, rather than requiring a
 * second connection string every dev/CI environment would otherwise have to
 * configure by hand — Postgres schemas are cheap and `bot_order`'s role already
 * has the CREATEDB/superuser privileges to create one (see
 * docker-compose.postgres.yml). Verified empirically that `prisma migrate diff`
 * resets/repopulates this schema on every run, so no manual cleanup is needed
 * between invocations: ran the check twice in a row against the same schema
 * (both "No difference detected", exit 0), and separately forced a real diff via
 * `--to-empty` through the same shadow schema to confirm `--exit-code` still
 * reports 2 (a genuine diff) through this path, not just 0 unconditionally.
 *
 * Run standalone: `pnpm run check-migration-drift`. Also runs as part of
 * `pretest`, next to the timestamp and rebuild-quoting checks.
 */
import { config as loadEnv } from "dotenv";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load the monorepo-root `.env` regardless of cwd, same walk-up as
// packages/core/src/config.ts — this script runs standalone via `tsx`, not
// through the Prisma CLI, so it does not get Prisma's own automatic .env load.
function findRootEnv(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, ".env");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
loadEnv({ path: findRootEnv() });

const baseUrl = process.env.DATABASE_URL_PRISMA;
if (!baseUrl) {
  console.error(
    "DATABASE_URL_PRISMA is not set — cannot build the --shadow-database-url " +
      "check-migration-drift needs. Set it in .env (see docs/MIGRATIONS.md).",
  );
  process.exit(1);
}

let shadowUrl: URL;
try {
  shadowUrl = new URL(baseUrl);
} catch {
  console.error(`DATABASE_URL_PRISMA is not a valid URL: ${baseUrl}`);
  process.exit(1);
}
shadowUrl.searchParams.set("schema", "_migration_diff_shadow");

const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma");

const result = spawnSync(
  process.execPath,
  [
    prismaCli,
    "migrate",
    "diff",
    "--from-migrations",
    "./prisma/migrations",
    "--to-schema-datamodel",
    "./prisma/schema.prisma",
    "--shadow-database-url",
    shadowUrl.toString(),
    "--exit-code",
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`Failed to launch the Prisma CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
