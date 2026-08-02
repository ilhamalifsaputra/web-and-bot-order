/**
 * Guard against the unqualified-column rebuild idiom that silently corrupts
 * data (H-9, 2026-08-01).
 *
 * SQLite has no `ALTER COLUMN`, so changing an existing column's type or
 * constraints means rebuilding the table: create `new_<table>`, copy the rows
 * across with `INSERT INTO "new_<table>" (...) SELECT ... FROM "<table>"`, drop
 * the original, rename. Prisma generates exactly that, with every source column
 * written as a BARE double-quoted name.
 *
 * That is safe only while the source table has every column the SELECT names.
 * The moment one is missing — the realistic cause being an earlier migration
 * that failed part-way and was then closed out with `migrate resolve --applied`
 * (SQLite has no transactional DDL, so the statements before the failing one
 * stay committed) — the copy does not fail. Prisma's bundled SQLite still
 * enables the legacy double-quoted-string-literal fallback, so a double-quoted
 * name that matches no column is silently reinterpreted as a STRING LITERAL.
 * The migration reports success while writing the column's own name, as text,
 * into every row.
 *
 * Verified empirically on scratch databases: `prisma db execute` of
 * `INSERT INTO "dst" ("id","val") SELECT "id", coalesce("missing_col", "created_at") FROM "src"`
 * stored the string "missing_col"; the qualified form
 * `coalesce("src"."missing_col", "src"."created_at")` failed loudly with
 * `no such column: src.missing_col` and wrote nothing. The fallback applies
 * only to a bare single-token name, never to a qualified `"table"."column"`.
 *
 * So: every source column in a rebuild copy must be table-qualified. Column
 * aliases (`... AS "name"`) are exempt — an alias names an output column, it
 * never resolves against the source table.
 *
 * Two pre-existing migrations still use the bare form. They are grandfathered
 * by exact folder name below rather than fixed, because `prisma migrate deploy`
 * checksums every applied migration: editing one — comments included — breaks
 * every database that already applied it cleanly. This guard exists to stop
 * NEW migrations from joining them.
 *
 * NOT LIMITED TO TABLE REBUILDS (final-review fix, 2026-08-02): the identical
 * hazard also lives in any OTHER `SELECT ... FROM "table"` in a migration
 * file — most realistically a correlated subquery inside a backfill, e.g.
 * `UPDATE "order_items" SET "delivery_type_snapshot" = (SELECT "delivery_type"
 * FROM "denominations" WHERE ...)`. That is exactly the shape
 * 20260801000002_add_order_item_delivery_type_snapshot originally shipped
 * with (bare `"delivery_type"`, at a point in the migration chain where
 * `denominations.delivery_type` didn't exist yet).
 *
 * NOT LIMITED TO SELECT LISTS EITHER (audit follow-up, 2026-08-02): the same
 * hazard lives in a `WHERE`/`JOIN ... ON` clause that follows the `FROM` —
 * a correlated backfill's `WHERE` is exactly where a bare reference to a
 * not-yet-existing column realistically lives — and the source table can be
 * written unquoted (`FROM orders`) just as validly as quoted. The actual
 * scanning logic now lives in scripts/lib/sqlQuoting.ts (also unit-tested
 * there); this file is a thin CLI wrapper: read every migration.sql, run the
 * scan, apply the grandfather list, report.
 *
 * Run standalone: `pnpm run check-migration-rebuild-quoting`
 * Also runs automatically as part of `pretest`, next to the drift check.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanMigrationSql, type SourceReference } from "./lib/sqlQuoting";

interface GrandfatheredFolder {
  /**
   * How many rebuild copies in this folder are expected to use bare column
   * references. Pinned exactly, so that editing a frozen migration (which
   * would break its checksum anyway) cannot pass unnoticed either.
   */
  unqualifiedRebuilds: number;
  reason: string;
}

const GRANDFATHERED: Record<string, GrandfatheredFolder> = {
  "20260619170759_add_paydisini_nowpayments_ledgers": {
    unqualifiedRebuilds: 11,
    reason:
      "Applied long before H-9; its checksum is frozen, so it cannot be " +
      "edited without breaking every database that already ran it. Reachable " +
      "in principle (20260530121500_binance_internal_transfer runs four " +
      "sequential ALTER TABLE \"orders\" ADD COLUMN statements, so a partial " +
      "failure there closed out with `migrate resolve --applied` would leave " +
      "this folder's orders rebuild short a source column), but every column " +
      "it adds takes a constant default and the tables are empty on the fresh " +
      "databases where the chain is actually replayed.",
  },
  "20260623174046_restrict_financial_cascades": {
    unqualifiedRebuilds: 4,
    reason:
      "Same situation as 20260619170759 — applied and checksum-frozen. Its " +
      "rebuilds change foreign-key actions only; it adds no columns of its " +
      "own, so it has no partially-applied predecessor state of its own to " +
      "inherit.",
  },
};

const migrationsDir = join(process.cwd(), "prisma", "migrations");

const offenders = new Map<string, { table: string; columns: string[] }[]>();
let rebuildCount = 0;
let subqueryCount = 0;
let folderCount = 0;

function record(folder: string, table: string, columns: string[]): void {
  if (columns.length === 0) return;
  const found = offenders.get(folder);
  if (found) found.push({ table, columns });
  else offenders.set(folder, [{ table, columns }]);
}

for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  folderCount += 1;
  let sql: string;
  try {
    sql = readFileSync(join(migrationsDir, entry.name, "migration.sql"), "utf8");
  } catch {
    continue; // a folder without migration.sql has nothing to check
  }

  const references: SourceReference[] = scanMigrationSql(sql);
  for (const ref of references) {
    if (ref.kind === "rebuild") rebuildCount += 1;
    else subqueryCount += 1;
    record(entry.name, ref.table, ref.unqualifiedColumns);
  }
}

const problems: string[] = [];

for (const [folder, copies] of offenders) {
  const allowed = GRANDFATHERED[folder];
  if (allowed && allowed.unqualifiedRebuilds === copies.length) continue;
  if (allowed) {
    problems.push(
      `  ${folder} is grandfathered for exactly ${allowed.unqualifiedRebuilds} ` +
        `unqualified rebuild(s), but ${copies.length} were found — this migration ` +
        `is checksum-frozen and should never have changed.`,
    );
    continue;
  }
  problems.push(`  ${folder}:`);
  for (const copy of copies) {
    problems.push(
      `      copy from "${copy.table}" reads ${copy.columns.length} column(s) ` +
        `without a table qualifier, first few: ` +
        `${copy.columns.slice(0, 4).join(", ")}`,
    );
  }
}

/** A grandfathered folder that no longer has any violation means a stale entry. */
for (const [folder, allowed] of Object.entries(GRANDFATHERED)) {
  if (offenders.has(folder)) continue;
  problems.push(
    `  ${folder} is grandfathered for ${allowed.unqualifiedRebuilds} unqualified ` +
      `rebuild(s) but none were found — remove its entry from GRANDFATHERED.`,
  );
}

if (problems.length > 0) {
  console.error(
    "A table-rebuild copy or subquery SELECT reads its source columns as bare " +
      "double-quoted names. If the source table is ever missing one of them, " +
      "Prisma's SQLite turns that name into a string literal instead of " +
      "failing, and the migration reports success while writing the column's " +
      "own name as text into every row:",
  );
  for (const problem of problems) console.error(problem);
  console.error(
    'Qualify every source column with its table — `"orders"."status"`, not ' +
      '`"status"`. Qualified references cannot take that fallback, so a ' +
      "missing column aborts the migration instead of corrupting it. Aliases " +
      "(`... AS \"name\"`) are fine unqualified. See docs/MIGRATIONS.md, " +
      'section "Pemulihan dari `migrate deploy` yang gagal".',
  );
  process.exit(1);
}

const grandfatheredCopies = Object.values(GRANDFATHERED).reduce(
  (sum, entry) => sum + entry.unqualifiedRebuilds,
  0,
);
console.log(
  `Checked ${rebuildCount} table-rebuild copies and ${subqueryCount} other ` +
    `subquery SELECTs across ${folderCount} migration folders; all source ` +
    `columns are table-qualified except the ${grandfatheredCopies} ` +
    `grandfathered pre-H-9 copies.`,
);
