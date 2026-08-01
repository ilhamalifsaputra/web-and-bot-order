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
 * Run standalone: `pnpm run check-migration-rebuild-quoting`
 * Also runs automatically as part of `pretest`, next to the drift check.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Matches one rebuild copy: `INSERT INTO "new_x" (<targets>) SELECT <sources> FROM "x"`.
 * The source list is captured non-greedily up to the single `FROM "..."` that
 * closes the statement.
 */
const REBUILD_COPY =
  /INSERT\s+INTO\s+"(new_\w+)"\s*\([^)]*\)\s*SELECT\s+([\s\S]*?)\s+FROM\s+"(\w+)"/gi;

/** Every double-quoted identifier, so each can be classified in context. */
const QUOTED_IDENTIFIER = /"([^"]+)"/g;

/**
 * Returns the source columns in `selectList` that are written bare rather than
 * table-qualified. Skips the qualifier and column halves of `"t"."c"` pairs,
 * and skips aliases introduced by `AS`.
 */
function findUnqualifiedSources(selectList: string): string[] {
  const bare: string[] = [];
  for (const match of selectList.matchAll(QUOTED_IDENTIFIER)) {
    const start = match.index;
    const end = start + match[0].length;
    // `"table"."column"` — the qualifier is followed by a dot, the column
    // preceded by one. Either half means this reference is qualified.
    if (selectList[end] === "." || selectList[start - 1] === ".") continue;
    // `... AS "alias"` names an output column; it never resolves against the
    // source table, so the string-literal fallback cannot apply to it.
    if (/\bAS\s*$/i.test(selectList.slice(0, start))) continue;
    bare.push(match[1]);
  }
  return bare;
}

const migrationsDir = join(process.cwd(), "prisma", "migrations");

const offenders = new Map<string, { table: string; columns: string[] }[]>();
let rebuildCount = 0;
let folderCount = 0;

for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  folderCount += 1;
  let sql: string;
  try {
    sql = readFileSync(join(migrationsDir, entry.name, "migration.sql"), "utf8");
  } catch {
    continue; // a folder without migration.sql has nothing to check
  }
  for (const copy of sql.matchAll(REBUILD_COPY)) {
    rebuildCount += 1;
    const columns = findUnqualifiedSources(copy[2]);
    if (columns.length === 0) continue;
    const found = offenders.get(entry.name);
    if (found) found.push({ table: copy[3], columns });
    else offenders.set(entry.name, [{ table: copy[3], columns }]);
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
    "A table-rebuild copy reads its source columns as bare double-quoted names. " +
      "If the source table is ever missing one of them, Prisma's SQLite turns " +
      "that name into a string literal instead of failing, and the migration " +
      "reports success while writing the column's own name as text into every " +
      "row:",
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
  `Checked ${rebuildCount} table-rebuild copies across ${folderCount} migration ` +
    `folders; all source columns are table-qualified except the ` +
    `${grandfatheredCopies} grandfathered pre-H-9 copies.`,
);
