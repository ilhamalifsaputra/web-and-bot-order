/**
 * Fast path for giving a test file its own Postgres schema.
 *
 * The slow path (still used when this one is unavailable) spawns `prisma db
 * push` — and, for the app suites, the chart-of-accounts seed script — once per
 * test FILE, which was roughly 330 process spawns per full run. Instead,
 * tests/helpers/globalSetup.ts provisions ONE template schema per Vitest run
 * with exactly those commands, and writes the schema's DDL (from `prisma
 * migrate diff --from-empty`) to a temp file. Each test file then builds its
 * schema in-database: run the DDL inside the new schema, copy the template's
 * seed rows across, and move every copied table's id sequence past the copied
 * ids. tests/helpers/schemaFromTemplate.test.ts compares the result with the
 * slow path so the two cannot drift apart unnoticed.
 *
 * Like pgTestSchema.ts, this module must never import an `@app/*` module (its
 * callers run before the `@app/db` Prisma singleton is constructed). Plain
 * `@prisma/client` is fine.
 */
import { readFileSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { inject } from "vitest";

/** What globalSetup.ts hands to the workers when the template is ready. */
export interface PgTestTemplate {
  /** Name of the once-per-run template schema holding the seed rows. */
  schema: string;
  /** Path of the temp file holding the canonical schema's DDL script. */
  ddlPath: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    // Optional: globalSetup provides nothing when it could not build the
    // template, and the helpers then fall back to the slow spawn path.
    pgTestTemplate?: PgTestTemplate;
  }
}

/** A template that is ready to copy from: its schema name and parsed DDL. */
export interface ReadyTemplate {
  schema: string;
  statements: string[];
}

// The DDL file is read and split once per worker module graph rather than once
// per provisioned schema.
const statementCache = new Map<string, string[]>();

/**
 * Returns the run's template, or undefined when globalSetup did not provide
 * one (it failed, or this code is running outside Vitest) — in which case the
 * caller must use the slow spawn path.
 */
export function getSchemaTemplate(): ReadyTemplate | undefined {
  let provided: PgTestTemplate | undefined;
  try {
    provided = inject("pgTestTemplate");
  } catch {
    return undefined;
  }
  if (!provided) return undefined;
  let statements = statementCache.get(provided.ddlPath);
  if (!statements) {
    statements = prepareDdl(readFileSync(provided.ddlPath, "utf8"));
    statementCache.set(provided.ddlPath, statements);
  }
  return { schema: provided.schema, statements };
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
