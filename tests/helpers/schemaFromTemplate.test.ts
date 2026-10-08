/**
 * Drift guard for the test-schema fast path (tests/helpers/schemaFromTemplate.ts).
 *
 * Builds one schema the fast way (DDL from `prisma migrate diff` + rows copied
 * from the run's template) and one the slow way (`prisma db push` + the
 * chart-of-accounts seed, exactly what every test file used to run), then
 * compares them through the system catalogs: tables, columns, indexes, enums,
 * constraints, seeded rows and sequence positions. A third schema checks
 * makeTestDb's tables-only variant against the same shape. If the generated DDL ever
 * stops matching what `db push` builds — or the copy misses rows or leaves a
 * sequence behind — this fails instead of the whole suite silently testing
 * against a different schema.
 */
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropSchema, pushSchema, seedChartOfAccounts, withSchema } from "./pgSchemaPlumbing";
import { createSchemaFromTemplate, ensureSchemaTemplate } from "./schemaFromTemplate";

const baseUrl = process.env.DATABASE_URL_PRISMA ?? "";
const suffix = randomBytes(6).toString("hex");
const fastSchema = `test_parity_fast_${suffix}`;
const slowSchema = `test_parity_slow_${suffix}`;
const bareSchema = `test_parity_bare_${suffix}`;

let admin: PrismaClient;
let publicBefore: string[];

/** Names of every relation and type in `public`, to prove nothing lands there. */
async function publicObjects(): Promise<string[]> {
  const rows = await admin.$queryRawUnsafe<{ name: string }[]>(
    `SELECT 'rel:' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
     UNION ALL
     SELECT 'type:' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'
     ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}

/** Everything that defines a schema's shape and seed data, schema name normalised. */
async function snapshot(schema: string) {
  const norm = (text: string | null) => (text === null ? null : text.split(`"${schema}".`).join("").split(`${schema}.`).join(""));
  const q = <T>(sql: string) => admin.$queryRawUnsafe<T[]>(sql, schema);

  const tables = (
    await q<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
    )
  ).map((r) => r.t);

  const columns = (
    await q<{ table_name: string; column_name: string; data_type: string; column_default: string | null }>(
      `SELECT table_name, column_name, ordinal_position::int, data_type, udt_name, is_nullable,
              column_default, character_maximum_length::int, numeric_precision::int, numeric_scale::int
         FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
    )
  ).map((c) => ({ ...c, column_default: norm(c.column_default) }));

  const indexes = (
    await q<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`,
    )
  ).map((i) => ({ ...i, indexdef: norm(i.indexdef) }));

  const enums = await q<{ typname: string; labels: string[] }>(
    `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = $1 GROUP BY t.typname ORDER BY t.typname`,
  );

  const constraints = (
    await q<{ tbl: string; conname: string; contype: string; def: string }>(
      `SELECT c.relname AS tbl, k.conname, k.contype::text AS contype, pg_get_constraintdef(k.oid) AS def
         FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 ORDER BY c.relname, k.conname`,
    )
  ).map((k) => ({ ...k, def: norm(k.def) }));

  // Seeded rows, with timestamp columns left out: the fast path copies the
  // template's seed time while the slow path stamps its own, so those values
  // legitimately differ by the seconds between the two seeds.
  const rows: Record<string, unknown[]> = {};
  for (const table of tables) {
    const keep = columns
      .filter((c) => c.table_name === table && !c.data_type.startsWith("timestamp"))
      .map((c) => `"${c.column_name}"`);
    const [result] = await admin.$queryRawUnsafe<{ data: unknown[] | null }[]>(
      `SELECT json_agg(r ORDER BY r::text) AS data FROM (SELECT ${keep.join(", ")} FROM "${schema}"."${table}") r`,
    );
    if (result?.data) rows[table] = result.data;
  }

  return { tables, columns, indexes, enums, constraints, rows };
}

/** For every table with rows: its serial sequences' next value and the column's max. */
async function sequencePositions(schema: string) {
  const seqs = await admin.$queryRawUnsafe<{ tbl: string; col: string; seq: string }[]>(
    `SELECT c.relname AS tbl, a.attname AS col,
            pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) AS seq
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = $1 AND c.relkind = 'r'
        AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL
      ORDER BY 1, 2`,
    schema,
  );
  const out: { tbl: string; col: string; next: number; max: number }[] = [];
  for (const { tbl, col, seq } of seqs) {
    const [maxRow] = await admin.$queryRawUnsafe<{ max: number | null }[]>(
      `SELECT MAX("${col}")::int AS max FROM "${schema}"."${tbl}"`,
    );
    const max = maxRow?.max ?? null;
    if (max === null) continue;
    const [nextRow] = await admin.$queryRawUnsafe<{ next: number }[]>(
      `SELECT nextval('${seq.replace(/'/g, "''")}'::regclass)::int AS next`,
    );
    out.push({ tbl, col, next: nextRow?.next ?? 0, max });
  }
  return out;
}

describe("test-schema fast path parity with prisma db push + seed", () => {
  beforeAll(async () => {
    if (!baseUrl) throw new Error("DATABASE_URL_PRISMA must be set for the schema parity test.");
    admin = new PrismaClient({ datasourceUrl: baseUrl });
    publicBefore = await publicObjects();
  });

  afterAll(async () => {
    await dropSchema(withSchema(baseUrl, fastSchema), fastSchema).catch(() => {});
    await dropSchema(withSchema(baseUrl, slowSchema), slowSchema).catch(() => {});
    await dropSchema(withSchema(baseUrl, bareSchema), bareSchema).catch(() => {});
    await admin?.$disconnect();
  });

  it(
    "builds the same schema, seed rows and sequence positions as the spawn path, and nothing in public",
    async () => {
      const template = await ensureSchemaTemplate();
      expect(template, "the run's template must be available for the fast path to be tested").toBeDefined();

      const fastClient = new PrismaClient({ datasourceUrl: withSchema(baseUrl, fastSchema) });
      try {
        await createSchemaFromTemplate(fastClient, fastSchema, template!);
      } finally {
        await fastClient.$disconnect();
      }
      const slowUrl = withSchema(baseUrl, slowSchema);
      pushSchema(slowUrl);
      seedChartOfAccounts(slowUrl);

      const fast = await snapshot(fastSchema);
      const slow = await snapshot(slowSchema);
      expect(fast.tables.length).toBeGreaterThan(0);
      expect(fast.tables).toEqual(slow.tables);
      expect(fast.columns).toEqual(slow.columns);
      expect(fast.indexes).toEqual(slow.indexes);
      expect(fast.enums).toEqual(slow.enums);
      expect(fast.constraints).toEqual(slow.constraints);
      // The chart of accounts must actually be there, not just equally absent.
      expect(Object.keys(fast.rows).length).toBeGreaterThan(0);
      expect(fast.rows).toEqual(slow.rows);

      const fastSeqs = await sequencePositions(fastSchema);
      const slowSeqs = await sequencePositions(slowSchema);
      expect(fastSeqs.length).toBeGreaterThan(0);
      for (const s of fastSeqs) expect(s.next, `${s.tbl}.${s.col}`).toBeGreaterThan(s.max);
      expect(fastSeqs).toEqual(slowSeqs);

      // makeTestDb's variant: same tables, but no seed rows, exactly like the
      // `prisma db push`-only path it replaces.
      const bareClient = new PrismaClient({ datasourceUrl: withSchema(baseUrl, bareSchema) });
      try {
        await createSchemaFromTemplate(bareClient, bareSchema, template!, { copySeedRows: false });
      } finally {
        await bareClient.$disconnect();
      }
      const bare = await snapshot(bareSchema);
      expect({ ...bare, rows: undefined }).toEqual({ ...slow, rows: undefined });
      expect(bare.rows).toEqual({});

      expect(await publicObjects()).toEqual(publicBefore);
    },
    180_000,
  );
});
