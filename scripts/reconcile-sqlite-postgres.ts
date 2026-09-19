/**
 * Rerunnable SQLite -> Postgres reconciliation gate (engine-swap Task 6).
 *
 * Formalizes the ad-hoc verification `scripts/migrate-sqlite-to-postgres.ts`
 * (Task 5) printed once at import time into a standalone script that can be
 * run again at any point later — including as a required gate step in the
 * production cutover runbook (Task 9) — without needing to re-read or
 * re-trust that one-off output.
 *
 *   pnpm tsx scripts/reconcile-sqlite-postgres.ts [path-to-sqlite.db]
 *
 * Default source path: argv[2], else `./data/bot.db`.
 * Target: `DATABASE_URL_PRISMA` (the normal Prisma client env var), `public`
 * schema, via the generated Postgres-provider @prisma/client.
 *
 * This script is READ-ONLY on both sides: the SQLite source is opened
 * `readOnly: true`, and every Postgres access is a SELECT. It never writes
 * to either database.
 *
 * Exit code: 0 only if every one of the 36 tables' row counts match AND
 * every Decimal value compared matches exactly. Non-zero on any mismatch
 * (or on any unexpected error), so it can be used directly as a pass/fail
 * gate in CI or a runbook step.
 *
 * --- What this checks ---------------------------------------------------
 * 1. Row-count comparison for all 36 tables (SELECT COUNT(*) on each side).
 * 2. Decimal spot-check — EVERY row's value for EVERY Decimal-typed column
 *    in the schema (29 fields across 16 tables; see DECIMAL_TABLES below),
 *    compared as exact strings, keyed by each row's `id` (every
 *    Decimal-bearing table here has a plain integer `id` primary key, and
 *    Task 5's migration preserved ids verbatim, so joining source and
 *    target rows by id is safe).
 * 3. FK orphan check (target Postgres only) — Task 5's import runs with
 *    `SET session_replication_role = replica`, which suppresses FK trigger
 *    enforcement for the duration of the import transaction. That is by
 *    design (it removes the need for a topological insert order), but it
 *    also means an orphan row already present in the SQLite source (a
 *    `denomination.productId` with no matching `products.id`, say) would
 *    import into Postgres without complaint even though it violates a real
 *    FK constraint Postgres enforces on every write from here on. Row
 *    counts and Decimal values alone can't catch that — an orphan row still
 *    counts and still carries a correct Decimal value. This check
 *    enumerates every FK constraint Postgres itself now has on the `public`
 *    schema (via `information_schema`, not hand-derived from
 *    schema.prisma's `@relation` fields — the live constraints are the
 *    source of truth for what Postgres will actually enforce) and runs a
 *    `LEFT JOIN ... WHERE parent.id IS NULL` orphan query for each one.
 *
 * --- Decimal comparison method — READ THIS BEFORE TOUCHING THIS FILE ---
 * On the SQLite side, the same approach Task 5's migration script uses:
 * `CAST(col AS TEXT)` inside the SQL itself, so the value never passes
 * through a JS `number` and SQLite's own canonical text form is what gets
 * compared (see migrate-sqlite-to-postgres.ts's header comment for the
 * full reasoning).
 *
 * On the Postgres side, this script deliberately does NOT use a raw
 * `::text` cast — that was tried and empirically shown to be WRONG for
 * this purpose: Prisma maps `Decimal` (no `@db.Decimal(p,s)` override
 * anywhere in schema.prisma) to Postgres `NUMERIC(65,30)`, and casting that
 * column directly to `::text` returns the value padded to the column's
 * full declared scale (e.g. `11100.000000000000000000000000000000`, 30
 * fractional digits), not SQLite's minimal canonical form (`11100`). Doing
 * a naive string comparison against that would report a false mismatch on
 * almost every row. Confirmed instead: reading the same column through
 * Prisma's generated model API (typed `Decimal`, a decimal.js-like object)
 * and calling `.toString()` DOES return the minimal canonical form with no
 * padding — `11100`, `5.004`, `9999740.3`, etc., matching SQLite's
 * `CAST(...AS TEXT)` output exactly for every value checked. So this
 * script reads every Decimal column via `prisma.<model>.findMany` (typed
 * select, not `$queryRawUnsafe`) and compares `.toString()` output.
 *
 * --- Scope of what a match here actually proves -------------------------
 * A string match between source and target proves only that no round-trip
 * discrepancy was introduced by the Task-5 migration step (or by anything
 * since). It does NOT prove no precision was ever lost at the point a
 * value was originally written into SQLite — SQLite's NUMERIC-affinity
 * TEXT->REAL storage preserves only ~15 significant digits, and if a value
 * had already lost precision before this reconciliation script ever runs,
 * both sides would agree on the (already-imprecise) value and this check
 * would report a clean match. That earlier class of error is out of reach
 * for any tool that only ever reads the already-migrated data — this
 * script inherits that same limitation deliberately, not by oversight.
 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

// Physical table names, in schema.prisma @@map declaration order — same
// list as migrate-sqlite-to-postgres.ts. Order is cosmetic only (report
// readability); every table is checked independently.
const TABLES = [
  "users",
  "wallet_transactions",
  "password_reset_tokens",
  "categories",
  "products",
  "denominations",
  "product_provider_mappings",
  "stock_items",
  "orders",
  "order_status_history",
  "order_items",
  "refunds",
  "refund_items",
  "admin_tasks",
  "vouchers",
  "voucher_redemptions",
  "voucher_products",
  "reviews",
  "referrals",
  "support_tickets",
  "ticket_messages",
  "restock_subscriptions",
  "cart_items",
  "bulk_pricing",
  "settings",
  "audit_logs",
  "notification_outbox",
  "broadcasts",
  "processed_binance_tx",
  "processed_bybit_tx",
  "processed_tokopay_tx",
  "processed_paydisini_tx",
  "processed_nowpayments_tx",
  "idempotency_records",
] as const;

// Every Decimal-typed column in prisma/schema.prisma (grepped exhaustively;
// 29 fields across 16 tables), grouped by table. `modelAccessor` is the
// generated Prisma Client property name (camelCase model name) used to read
// the target side through the typed model API — see header comment for why
// that's required instead of a raw `::text` cast. `sourceColumn` /
// `targetField` pairs map each column's SQLite physical name (@map value,
// used for the SQLite-side SELECT) to its Prisma field name (used for the
// Postgres-side typed select).
interface DecimalTableSpec {
  table: (typeof TABLES)[number];
  modelAccessor: string;
  columns: { sourceColumn: string; targetField: string }[];
}

const DECIMAL_TABLES: DecimalTableSpec[] = [
  {
    table: "users",
    modelAccessor: "user",
    columns: [
      { sourceColumn: "wallet_balance", targetField: "walletBalance" },
      { sourceColumn: "wallet_balance_usdt", targetField: "walletBalanceUsdt" },
    ],
  },
  {
    table: "wallet_transactions",
    modelAccessor: "walletTransaction",
    columns: [
      { sourceColumn: "delta", targetField: "delta" },
      { sourceColumn: "balance_after", targetField: "balanceAfter" },
    ],
  },
  {
    table: "denominations",
    modelAccessor: "denomination",
    columns: [
      { sourceColumn: "price", targetField: "price" },
      { sourceColumn: "cost_price", targetField: "costPrice" },
      { sourceColumn: "reseller_price", targetField: "resellerPrice" },
      { sourceColumn: "flash_discount_percent", targetField: "flashDiscountPercent" },
    ],
  },
  {
    table: "product_provider_mappings",
    modelAccessor: "productProviderMapping",
    columns: [{ sourceColumn: "provider_cost", targetField: "providerCost" }],
  },
  {
    table: "orders",
    modelAccessor: "order",
    columns: [
      { sourceColumn: "subtotal_amount", targetField: "subtotalAmount" },
      { sourceColumn: "discount_amount", targetField: "discountAmount" },
      { sourceColumn: "unique_cents", targetField: "uniqueCents" },
      { sourceColumn: "total_amount", targetField: "totalAmount" },
      { sourceColumn: "wallet_used", targetField: "walletUsed" },
      { sourceColumn: "bulk_discount_amount", targetField: "bulkDiscountAmount" },
      { sourceColumn: "fx_rate", targetField: "fxRate" },
    ],
  },
  {
    table: "order_items",
    modelAccessor: "orderItem",
    columns: [{ sourceColumn: "unit_price", targetField: "unitPrice" }],
  },
  {
    table: "refunds",
    modelAccessor: "refund",
    columns: [{ sourceColumn: "amount", targetField: "amount" }],
  },
  {
    table: "refund_items",
    modelAccessor: "refundItem",
    columns: [{ sourceColumn: "amount", targetField: "amount" }],
  },
  {
    table: "vouchers",
    modelAccessor: "voucher",
    columns: [
      { sourceColumn: "value", targetField: "value" },
      { sourceColumn: "min_purchase", targetField: "minPurchase" },
      { sourceColumn: "max_discount", targetField: "maxDiscount" },
    ],
  },
  {
    table: "referrals",
    modelAccessor: "referral",
    columns: [{ sourceColumn: "commission", targetField: "commission" }],
  },
  {
    table: "bulk_pricing",
    modelAccessor: "bulkPricing",
    columns: [{ sourceColumn: "discount_percent", targetField: "discountPercent" }],
  },
  {
    table: "processed_binance_tx",
    modelAccessor: "processedBinanceTx",
    columns: [{ sourceColumn: "amount", targetField: "amount" }],
  },
  {
    table: "processed_bybit_tx",
    modelAccessor: "processedBybitTx",
    columns: [{ sourceColumn: "amount", targetField: "amount" }],
  },
  {
    table: "processed_tokopay_tx",
    modelAccessor: "processedTokopayTx",
    columns: [{ sourceColumn: "amount", targetField: "amount" }],
  },
  {
    table: "processed_paydisini_tx",
    modelAccessor: "processedPaydisiniTx",
    columns: [{ sourceColumn: "amount", targetField: "amount" }],
  },
  {
    table: "processed_nowpayments_tx",
    modelAccessor: "processedNowpaymentsTx",
    columns: [{ sourceColumn: "amount", targetField: "amount" }],
  },
];

const TOTAL_DECIMAL_FIELDS = DECIMAL_TABLES.reduce((sum, t) => sum + t.columns.length, 0);

function resolveSqlitePath(): string {
  return process.argv[2] ?? "./data/bot.db";
}

function tableExistsInSource(db: DatabaseSync, table: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
  return row != null;
}

interface RowCountResult {
  table: string;
  source: number;
  target: number;
  ok: boolean;
}

async function compareRowCounts(sqlite: DatabaseSync, prisma: PrismaClient): Promise<RowCountResult[]> {
  const results: RowCountResult[] = [];
  for (const table of TABLES) {
    let source = 0;
    if (tableExistsInSource(sqlite, table)) {
      const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
      source = row.n;
    }
    const targetRows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) as n FROM "public"."${table}"`,
    );
    const target = Number(targetRows[0]!.n);
    results.push({ table, source, target, ok: source === target });
  }
  return results;
}

interface DecimalMismatch {
  table: string;
  id: number;
  column: string;
  source: string | null;
  target: string | null;
  reason: "value-mismatch" | "missing-in-target" | "missing-in-source";
}

interface DecimalCheckResult {
  table: string;
  checked: number;
  mismatches: DecimalMismatch[];
}

/**
 * Pure id->values map diff, factored out of checkDecimalTable so it can be
 * exercised directly with synthetic data (see scripts/reconcile-sqlite-postgres.selftest.ts)
 * without needing a live SQLite file or Postgres connection — this is the
 * function actually responsible for catching every mismatch, so it's the
 * one worth being able to verify in isolation.
 */
export function diffDecimalMaps(
  table: string,
  columns: string[],
  sourceById: Map<number, Record<string, string | null>>,
  targetById: Map<number, Record<string, string | null>>,
): { checked: number; mismatches: DecimalMismatch[] } {
  const mismatches: DecimalMismatch[] = [];
  let checked = 0;

  for (const [id, sourceValues] of sourceById) {
    const targetValues = targetById.get(id);
    if (targetValues === undefined) {
      for (const column of columns) {
        checked++;
        mismatches.push({
          table,
          id,
          column,
          source: sourceValues[column]!,
          target: null,
          reason: "missing-in-target",
        });
      }
      continue;
    }
    for (const column of columns) {
      checked++;
      const sv = sourceValues[column]!;
      const tv = targetValues[column]!;
      if (sv !== tv) {
        mismatches.push({ table, id, column, source: sv, target: tv, reason: "value-mismatch" });
      }
    }
  }

  // Rows present in target but not in source (unexpected — Task 5's import
  // is source-driven, so this should never happen, but check anyway rather
  // than assume).
  for (const [id, targetValues] of targetById) {
    if (sourceById.has(id)) continue;
    for (const column of columns) {
      checked++;
      mismatches.push({
        table,
        id,
        column,
        source: null,
        target: targetValues[column]!,
        reason: "missing-in-source",
      });
    }
  }

  return { checked, mismatches };
}

async function checkDecimalTable(
  sqlite: DatabaseSync,
  prisma: PrismaClient,
  spec: DecimalTableSpec,
): Promise<DecimalCheckResult> {
  if (!tableExistsInSource(sqlite, spec.table)) {
    // Same drift case migrate-sqlite-to-postgres.ts handles: a table added
    // to the schema after the snapshot was staged. Nothing to compare —
    // the row-count check above already confirms the target is empty too.
    return { table: spec.table, checked: 0, mismatches: [] };
  }

  const sourceColsSql = spec.columns
    .map((c) => `CAST("${c.sourceColumn}" AS TEXT) AS "${c.sourceColumn}"`)
    .join(", ");
  const sourceRows = sqlite
    .prepare(`SELECT "id", ${sourceColsSql} FROM "${spec.table}"`)
    .all() as Record<string, unknown>[];

  const sourceById = new Map<number, Record<string, string | null>>();
  for (const row of sourceRows) {
    const id = row.id as number;
    const values: Record<string, string | null> = {};
    for (const c of spec.columns) {
      const v = row[c.sourceColumn];
      values[c.sourceColumn] = v === null || v === undefined ? null : String(v);
    }
    sourceById.set(id, values);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = (prisma as any)[spec.modelAccessor];
  const select: Record<string, boolean> = { id: true };
  for (const c of spec.columns) select[c.targetField] = true;
  const targetRows = (await model.findMany({ select })) as Record<string, unknown>[];

  const targetById = new Map<number, Record<string, string | null>>();
  for (const row of targetRows) {
    const id = row.id as number;
    const values: Record<string, string | null> = {};
    for (const c of spec.columns) {
      const v = row[c.targetField] as { toString(): string } | null;
      values[c.sourceColumn] = v === null || v === undefined ? null : v.toString();
    }
    targetById.set(id, values);
  }

  const columnNames = spec.columns.map((c) => c.sourceColumn);
  const { checked, mismatches } = diffDecimalMaps(spec.table, columnNames, sourceById, targetById);
  return { table: spec.table, checked, mismatches };
}

interface ForeignKeyInfo {
  constraintName: string;
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
}

/**
 * Enumerates every FK constraint Postgres actually enforces on the `public`
 * schema, via `information_schema` — deliberately not hand-derived from
 * schema.prisma's `@relation` fields, so this stays correct even if a future
 * schema change adds/renames a relation without this script being updated in
 * lockstep; whatever Postgres itself enforces is what gets checked.
 */
async function fetchForeignKeys(prisma: PrismaClient): Promise<ForeignKeyInfo[]> {
  const rows = await prisma.$queryRawUnsafe<
    {
      constraint_name: string;
      child_table: string;
      child_column: string;
      parent_table: string;
      parent_column: string;
    }[]
  >(`
    SELECT
      tc.constraint_name,
      tc.table_name AS child_table,
      kcu.column_name AS child_column,
      ccu.table_name AS parent_table,
      ccu.column_name AS parent_column
    FROM information_schema.table_constraints tc
    -- Joining kcu/ccu on constraint_name alone (no column ordinal) assumes a
    -- single-column FK per constraint. That holds for every @relation in the
    -- current schema.prisma (none declare a composite `fields: [a, b]`), but
    -- a future composite FK would produce a cross-product of column pairs
    -- here and mispair columns — known limitation, not handled.
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    ORDER BY tc.table_name, kcu.column_name
  `);
  return rows.map((r) => ({
    constraintName: r.constraint_name,
    childTable: r.child_table,
    childColumn: r.child_column,
    parentTable: r.parent_table,
    parentColumn: r.parent_column,
  }));
}

interface OrphanCheckResult {
  fk: ForeignKeyInfo;
  orphanCount: number;
}

/**
 * For one FK, counts child rows whose FK column is non-null but has no
 * matching parent row — i.e. rows that would fail this constraint if it were
 * re-validated from scratch. Read-only (SELECT + LEFT JOIN), same as every
 * other Postgres access in this script.
 */
async function checkOrphans(prisma: PrismaClient, fk: ForeignKeyInfo): Promise<OrphanCheckResult> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*) AS n
    FROM "public"."${fk.childTable}" c
    LEFT JOIN "public"."${fk.parentTable}" p ON c."${fk.childColumn}" = p."${fk.parentColumn}"
    WHERE c."${fk.childColumn}" IS NOT NULL AND p."${fk.parentColumn}" IS NULL
  `);
  return { fk, orphanCount: Number(rows[0]!.n) };
}

async function main(): Promise<void> {
  const sqlitePath = resolveSqlitePath();
  console.log(`[reconcile] source SQLite: ${sqlitePath} (opened read-only)`);
  console.log(`[reconcile] target: DATABASE_URL_PRISMA (public schema)`);
  console.log(`[reconcile] ${TABLES.length} tables, ${TOTAL_DECIMAL_FIELDS} Decimal fields to check\n`);

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const prisma = new PrismaClient();

  try {
    // --- 1. Row-count comparison ------------------------------------
    console.log(`=== Row count comparison (source vs target) ===`);
    const rowCounts = await compareRowCounts(sqlite, prisma);
    let totalSource = 0;
    let totalTarget = 0;
    for (const r of rowCounts) {
      totalSource += r.source;
      totalTarget += r.target;
      console.log(
        `  ${r.table.padEnd(28)} source=${String(r.source).padStart(5)}  target=${String(r.target).padStart(5)}  ${r.ok ? "OK" : "MISMATCH"}`,
      );
    }
    console.log(`  ${"TOTAL".padEnd(28)} source=${String(totalSource).padStart(5)}  target=${String(totalTarget).padStart(5)}`);
    const rowCountMismatches = rowCounts.filter((r) => !r.ok);
    console.log(
      `\nRow counts: ${rowCounts.length - rowCountMismatches.length}/${rowCounts.length} tables match.`,
    );
    if (rowCountMismatches.length > 0) {
      console.log(`Mismatched tables:`);
      for (const r of rowCountMismatches) {
        console.log(`  ${r.table}: source=${r.source} target=${r.target} delta=${r.target - r.source}`);
      }
    }

    // --- 2. Decimal spot-check (every row, every Decimal column) ----
    console.log(`\n=== Decimal value comparison (every row, every Decimal column) ===`);
    const decimalResults: DecimalCheckResult[] = [];
    for (const spec of DECIMAL_TABLES) {
      const result = await checkDecimalTable(sqlite, prisma, spec);
      decimalResults.push(result);
      const status = result.mismatches.length === 0 ? "OK" : "MISMATCH";
      console.log(
        `  ${spec.table.padEnd(28)} columns=${spec.columns.length}  values_checked=${String(result.checked).padStart(6)}  ${status}`,
      );
    }

    let totalChecked = 0;
    const allDecimalMismatches: DecimalMismatch[] = [];
    for (const r of decimalResults) {
      totalChecked += r.checked;
      allDecimalMismatches.push(...r.mismatches);
    }
    console.log(
      `\nDecimal values: ${totalChecked - allDecimalMismatches.length}/${totalChecked} match.`,
    );
    if (allDecimalMismatches.length > 0) {
      console.log(`Mismatches (up to first 50 shown):`);
      for (const m of allDecimalMismatches.slice(0, 50)) {
        console.log(
          `  ${m.table}.id=${m.id}.${m.column}: source=${m.source ?? "NULL"} target=${m.target ?? "NULL"} (${m.reason})`,
        );
      }
      if (allDecimalMismatches.length > 50) {
        console.log(`  ... and ${allDecimalMismatches.length - 50} more`);
      }
    }

    // --- 3. FK orphan check (target Postgres only) -------------------
    console.log(`\n=== Foreign-key orphan-row check (target Postgres only) ===`);
    const foreignKeys = await fetchForeignKeys(prisma);
    console.log(`Found ${foreignKeys.length} foreign-key constraints in the "public" schema.`);
    const orphanResults: OrphanCheckResult[] = [];
    for (const fk of foreignKeys) {
      const result = await checkOrphans(prisma, fk);
      orphanResults.push(result);
      const status = result.orphanCount === 0 ? "OK" : "ORPHANS FOUND";
      console.log(
        `  ${fk.childTable}.${fk.childColumn} -> ${fk.parentTable}.${fk.parentColumn}  orphans=${String(result.orphanCount).padStart(4)}  ${status}`,
      );
    }
    const orphanFailures = orphanResults.filter((r) => r.orphanCount > 0);
    console.log(
      `\nFK constraints: ${orphanResults.length - orphanFailures.length}/${orphanResults.length} clean.`,
    );
    if (orphanFailures.length > 0) {
      console.log(`Constraints with orphan rows:`);
      for (const r of orphanFailures) {
        console.log(
          `  ${r.fk.childTable}.${r.fk.childColumn} -> ${r.fk.parentTable}.${r.fk.parentColumn}: ${r.orphanCount} orphan row(s)`,
        );
      }
    }

    // --- Overall verdict ---------------------------------------------
    const overallPass =
      rowCountMismatches.length === 0 && allDecimalMismatches.length === 0 && orphanFailures.length === 0;
    console.log(`\n=== SUMMARY ===`);
    console.log(`Tables checked:        ${rowCounts.length}`);
    console.log(`Row-count matches:     ${rowCounts.length - rowCountMismatches.length}/${rowCounts.length}`);
    console.log(`Decimal values checked: ${totalChecked}`);
    console.log(`Decimal value matches:  ${totalChecked - allDecimalMismatches.length}/${totalChecked}`);
    console.log(`FK constraints checked: ${orphanResults.length}`);
    console.log(`FK constraints clean:   ${orphanResults.length - orphanFailures.length}/${orphanResults.length}`);
    console.log(`Overall verdict: ${overallPass ? "PASS" : "FAIL"}`);

    if (!overallPass) {
      process.exitCode = 1;
    }
  } finally {
    sqlite.close();
    await prisma.$disconnect();
  }
}

// Only run when executed directly (`pnpm tsx scripts/reconcile-sqlite-postgres.ts`),
// not when imported — diffDecimalMaps above is exported for
// scripts/_reconcile-selftest.ts (and any future test) to exercise without
// triggering a real run against live databases as an import side effect.
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().catch((err) => {
    console.error("[reconcile] FAILED:", err);
    process.exitCode = 1;
  });
}
