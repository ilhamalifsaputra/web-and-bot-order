/**
 * Fast path for giving a test file its own Postgres schema.
 *
 * The slow path (still used when this one is unavailable) spawns `prisma db
 * push` — and, for the app suites, the chart-of-accounts seed script — once per
 * test FILE, which was roughly 330 process spawns per full run. Instead, the
 * first test file of a run that needs a database builds ONE template schema
 * with exactly those commands and writes the schema's DDL (from `prisma
 * migrate diff --from-empty`) to a temp file (`ensureSchemaTemplate`). Every
 * test file then builds its own schema in-database: run the DDL inside the new
 * schema, copy the template's seed rows across, and move every copied table's
 * id sequence past the copied ids. tests/helpers/schemaFromTemplate.test.ts
 * compares the result with the slow path so the two cannot drift apart
 * unnoticed.
 *
 * Like pgTestSchema.ts, this module must never import an `@app/*` module (its
 * callers run before the `@app/db` Prisma singleton is constructed). Plain
 * `@prisma/client` is fine.
 */
import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { inject } from "vitest";
import { ROOT, pushSchema, seedChartOfAccounts, withSchema } from "./pgSchemaPlumbing";

const execAsync = promisify(exec);

/** What globalSetup.ts hands to the workers: where this run's template goes. */
export interface PgTestTemplate {
  /** Name of the run's template schema (`test_template_<epochSeconds>_<hex>`). */
  schema: string;
  /** Temp directory for the template's DDL file and build-failure marker. */
  workDir: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    // Optional so the helpers still work (via the slow spawn path) under a
    // Vitest config that does not run tests/helpers/globalSetup.ts.
    pgTestTemplate?: PgTestTemplate;
  }
}

/** A template that is ready to copy from: its schema name and parsed DDL. */
export interface ReadyTemplate {
  schema: string;
  statements: string[];
}

/** Templates left by aborted runs are dropped once they are this old. */
const STALE_TEMPLATE_SECONDS = 6 * 60 * 60;
const TEMPLATE_NAME = /^test_template_(\d+)_[0-9a-f]+$/;

// One resolution per worker module graph: a failed build is remembered here
// (and, for other worker processes, by the marker file) instead of retried
// for every schema.
let resolved: Promise<ReadyTemplate | undefined> | undefined;

/**
 * Returns the run's template, building it first if no test file has yet, or
 * undefined when there is none to use (no Vitest-provided location, no
 * database URL, or the build failed) — in which case the caller must use the
 * slow spawn path.
 */
export function ensureSchemaTemplate(): Promise<ReadyTemplate | undefined> {
  resolved ??= resolveTemplate();
  return resolved;
}

async function resolveTemplate(): Promise<ReadyTemplate | undefined> {
  let provided: PgTestTemplate | undefined;
  try {
    provided = inject("pgTestTemplate");
  } catch {
    return undefined;
  }
  const baseUrl = process.env.DATABASE_URL_PRISMA;
  if (!provided || !baseUrl) return undefined;
  const { schema, workDir } = provided;
  const ddlPath = join(workDir, "schema.sql");
  const failedPath = join(workDir, "build-failed");

  // Builders in parallel workers are serialised by a transaction-scoped
  // advisory lock keyed on the template's name: the first one builds, the rest
  // block on the lock and then find the ready marker. The interactive
  // transaction pins the one connection the lock lives on, and the lock cannot
  // outlive a crashed holder.
  const client = new PrismaClient({ datasourceUrl: baseUrl });
  let ready = false;
  try {
    ready = await client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, schema);
        if (existsSync(failedPath)) return false;
        const [marker] = await tx.$queryRawUnsafe<{ comment: string | null }[]>(
          `SELECT obj_description(oid, 'pg_namespace') AS comment FROM pg_namespace WHERE nspname = $1`,
          schema,
        );
        if (marker?.comment === "ready" && existsSync(ddlPath)) return true;
        try {
          await buildTemplate(tx, schema, workDir, ddlPath, baseUrl);
          return true;
        } catch (err) {
          console.warn(
            `[test template] Building the test-schema template failed, so test files in this run will provision their own schema the slow way with prisma db push. Reason: ${firstLine(err)}`,
          );
          writeFileSync(failedPath, "");
          return false;
        }
      },
      // Waiting on the lock lasts as long as one build (push + seed + diff),
      // which takes tens of seconds on a loaded machine.
      { maxWait: 60_000, timeout: 600_000 },
    );
  } catch (err) {
    console.warn(
      `[test template] Could not check or build the test-schema template, so this test file provisions its schema the slow way with prisma db push. Reason: ${firstLine(err)}`,
    );
    return undefined;
  } finally {
    await client.$disconnect();
  }
  if (!ready) return undefined;
  return { schema, statements: prepareDdl(readFileSync(ddlPath, "utf8")) };
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Builds the template with exactly the commands the slow path runs per file,
 * then marks it ready. Called with the advisory lock held. The work directory
 * is created first because globalSetup's teardown takes it as the sign that a
 * template schema may exist and needs dropping.
 */
async function buildTemplate(tx: Tx, schema: string, workDir: string, ddlPath: string, baseUrl: string) {
  const started = Date.now();
  mkdirSync(workDir, { recursive: true });

  // Templates leaked by aborted runs carry their start time in the name;
  // drop those older than six hours. No other test_* schema is touched.
  const now = Math.floor(Date.now() / 1000);
  const existing = await tx.$queryRawUnsafe<{ name: string }[]>(
    `SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'test\\_template\\_%'`,
  );
  let dropped = 0;
  for (const { name } of existing) {
    const match = TEMPLATE_NAME.exec(name);
    if (!match || name === schema || now - Number(match[1]) < STALE_TEMPLATE_SECONDS) continue;
    await tx.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    dropped += 1;
  }
  if (dropped > 0) {
    console.info(`[test template] Dropped ${dropped} test-schema template(s) left behind by runs more than six hours old.`);
  }

  // The DDL needs no database, so it is generated in a separate process while
  // the template is pushed and seeded.
  const ddlDone = execAsync(
    `pnpm exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script --output "${ddlPath}"`,
    { cwd: ROOT },
  );
  ddlDone.catch(() => {});
  try {
    const url = withSchema(baseUrl, schema);
    pushSchema(url);
    seedChartOfAccounts(url);
    await ddlDone;
  } catch (err) {
    await ddlDone.catch(() => {});
    throw err;
  }
  await tx.$executeRawUnsafe(`COMMENT ON SCHEMA "${schema}" IS 'ready'`);
  console.info(
    `[test template] Built the test-schema template for this run in ${((Date.now() - started) / 1000).toFixed(1)}s; test files copy their schemas from it.`,
  );
}

// Subprocess errors embed the command line (never the URL, which travels in
// the environment); keep only the first line so subprocess output stays out.
function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0] ?? "unknown error";
}

/**
 * Turns `prisma migrate diff --script` output into a list of single
 * statements that create everything inside whatever schema is first on the
 * search_path.
 *
 * Prisma's raw queries go through Postgres's extended protocol, which refuses
 * a multi-statement string ("cannot insert multiple commands into a prepared
 * statement"), and one round trip per statement (~250 of them) measured about
 * twice as slow as the alternative. So the script is split into statements
 * here and createSchemaFromTemplate runs them all as the body of one `DO`
 * block — a single command. Splitting on a `;` at end of line is safe for
 * what Prisma generates today (CREATE TABLE / INDEX, ALTER TABLE … ADD
 * CONSTRAINT, no function bodies); dollar-quoted text would make both the
 * split and the `DO` wrapper unsafe, so its appearance is refused loudly.
 *
 * The script for a single-schema datasource carries no schema qualifier today,
 * but a `"public".` qualifier or a `CREATE SCHEMA` statement would put objects
 * into the shared `public` schema, so both are removed defensively, and any
 * remaining mention of `"public"` is refused.
 */
export function prepareDdl(sql: string): string[] {
  if (/\$\w*\$/.test(sql)) {
    throw new Error(
      "The generated schema DDL contains dollar-quoted text, which the test-schema fast path cannot split or wrap safely.",
    );
  }
  const statements = sql
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((chunk) =>
      chunk
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((stmt) => stmt.length > 0)
    .filter((stmt) => !/^CREATE\s+SCHEMA\b/i.test(stmt))
    .map((stmt) => stmt.replace(/"public"\./g, ""));
  const leaked = statements.find((stmt) => stmt.includes('"public"'));
  if (leaked) {
    throw new Error(
      "The generated schema DDL still refers to the public schema after neutralising qualifiers, so the test-schema fast path refuses to run it.",
    );
  }
  if (statements.length === 0) {
    throw new Error("The generated schema DDL contained no statements.");
  }
  return statements;
}

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;

/**
 * Creates `target` and fills it from the template: DDL first, then (unless
 * `copySeedRows` is false) the template's seed rows and the matching sequence
 * resets. `prisma` may be bound to any schema of the right database;
 * everything here is either qualified or runs under an explicit
 * `SET LOCAL search_path`.
 *
 * `copySeedRows: false` exists for makeTestDb (testdb.ts), whose slow path has
 * only ever run `prisma db push` — no seed — so its crud-level tests start from
 * empty tables; copying the chart of accounts there would quietly change what
 * those tests exercise.
 *
 * On failure the half-built `target` schema is left behind; callers drop it.
 */
export async function createSchemaFromTemplate(
  prisma: PrismaClient,
  target: string,
  template: ReadyTemplate,
  { copySeedRows = true }: { copySeedRows?: boolean } = {},
): Promise<void> {
  const tgt = quote(target);
  const tpl = quote(template.schema);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA ${tgt}`);

  await prisma.$transaction(
    async (tx) => {
      // SET LOCAL ends with the transaction, so the connection goes back to the
      // pool with its normal search_path.
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${tgt}`);
      // One command for the whole DDL; see prepareDdl for why. Inside the DO
      // block the statements run under the search_path set just above.
      await tx.$executeRawUnsafe(`DO $ddl$ BEGIN\n${template.statements.join(";\n")};\nEND $ddl$`);
      if (!copySeedRows) return;

      // Every ordinary table of the template, with its columns in order.
      const columns = await tx.$queryRawUnsafe<{ table: string; column: string }[]>(
        `SELECT c.relname AS "table", a.attname AS "column"
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          WHERE n.nspname = $1 AND c.relkind = 'r'
          ORDER BY c.relname, a.attnum`,
        template.schema,
      );
      const columnsByTable = new Map<string, string[]>();
      for (const { table, column } of columns) {
        const list = columnsByTable.get(table) ?? [];
        list.push(column);
        columnsByTable.set(table, list);
      }
      if (columnsByTable.size === 0) return;

      // Which tables hold seed rows, in one round trip.
      const tables = [...columnsByTable.keys()];
      const withRows = await tx.$queryRawUnsafe<{ table: string }[]>(
        tables
          .map(
            (t) =>
              `SELECT ${literal(t)}::text AS "table" WHERE EXISTS (SELECT 1 FROM ${tpl}.${quote(t)})`,
          )
          .join(" UNION ALL "),
      );
      const seeded = new Set(withRows.map((r) => r.table));
      if (seeded.size === 0) return;

      // Copy parents before children: the generated foreign keys are not
      // DEFERRABLE, so constraint deferral is not available. Self-references
      // are fine within a single INSERT … SELECT because Postgres checks them
      // at the end of the statement.
      const edges = await tx.$queryRawUnsafe<{ child: string; parent: string }[]>(
        `SELECT ch.relname AS child, pa.relname AS parent
           FROM pg_constraint k
           JOIN pg_class ch ON ch.oid = k.conrelid
           JOIN pg_class pa ON pa.oid = k.confrelid
           JOIN pg_namespace n ON n.oid = ch.relnamespace
          WHERE k.contype = 'f' AND n.nspname = $1`,
        template.schema,
      );
      const order = parentsFirst(seeded, edges);

      for (const table of order) {
        const cols = (columnsByTable.get(table) ?? []).map(quote).join(", ");
        await tx.$executeRawUnsafe(
          `INSERT INTO ${tgt}.${quote(table)} (${cols}) SELECT ${cols} FROM ${tpl}.${quote(table)}`,
        );
      }

      // Move every serial/identity sequence of a copied table past the copied
      // ids, or the next insert would collide with a seed row's primary key.
      const sequences = await tx.$queryRawUnsafe<{ table: string; column: string; seq: string }[]>(
        `SELECT c.relname AS "table", a.attname AS "column",
                pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) AS seq
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          WHERE n.nspname = $1 AND c.relkind = 'r'
            AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL`,
        target,
      );
      for (const { table, column, seq } of sequences) {
        if (!seeded.has(table)) continue;
        await tx.$queryRawUnsafe(
          `SELECT setval(${literal(seq)}::regclass, COALESCE((SELECT MAX(${quote(column)}) FROM ${tgt}.${quote(table)}), 0) + 1, false)`,
        );
      }
    },
    // Creating ~280 relations takes about a second on an idle machine and
    // several times that on a loaded parallel run, so Prisma's 5s default
    // interactive transaction timeout is too tight.
    { maxWait: 30_000, timeout: 120_000 },
  );
}

/** Orders `tables` so every FK parent in the set comes before its children. */
function parentsFirst(tables: Set<string>, edges: { child: string; parent: string }[]): string[] {
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: string[] = [];
  const visit = (table: string) => {
    if (done.has(table) || visiting.has(table)) return;
    visiting.add(table);
    for (const e of edges) {
      if (e.child === table && e.parent !== table && tables.has(e.parent)) visit(e.parent);
    }
    visiting.delete(table);
    done.add(table);
    out.push(table);
  };
  for (const t of [...tables].sort()) visit(t);
  return out;
}
