/**
 * One-off SQLite -> Postgres data migration (engine-swap Task 5).
 *
 * Copies every row of every one of the 36 tables from the legacy SQLite
 * snapshot (default `./data/bot.db`) into the dev Postgres database Task 4
 * already `prisma db push`-ed the current schema into, preserving primary
 * keys, exact Decimal string values, BigInt values, and UTC timestamps.
 *
 *   pnpm tsx scripts/migrate-sqlite-to-postgres.ts [path-to-sqlite.db]
 *
 * Default source path: argv[2], else `./data/bot.db`.
 * Target: `DATABASE_URL_PRISMA` (the normal Prisma client env var), `public`
 * schema, via the generated Postgres-provider @prisma/client.
 *
 * --- Safety -----------------------------------------------------------
 * - The SQLite source is opened `readOnly: true` — this script can never
 *   write to data/bot.db.
 * - Idempotency guard: refuses to run if ANY of the 36 target tables
 *   already has rows (see assertTargetIsEmpty). Since Task 4 leaves every
 *   table freshly created and empty, this only trips on a re-run after a
 *   prior partial attempt — reset the target first (e.g.
 *   `prisma db push --force-reset`) and re-run. Deliberately NOT
 *   truncate-and-restart: silently clobbering a target an operator may
 *   have already started using is worse than a loud refusal.
 * - FK-safe ordering: the whole import runs inside one Prisma interactive
 *   transaction (pins every query to a single Postgres session) with
 *   `SET session_replication_role = replica` for its duration, so table
 *   insertion order does not need to respect FK dependencies — verified
 *   empirically in this environment (see task-5-report.md) that
 *   `bot_order` really is superuser in the dev container and that this
 *   setting genuinely suppresses FK trigger enforcement (an out-of-FK-order
 *   insert was tried against a scratch parent/child pair and succeeded, vs.
 *   failing outside replica mode). No fallback to a hand-derived
 *   topological sort was needed.
 *
 * --- Decimal handling — READ THIS BEFORE TOUCHING THIS FILE ------------
 * The task brief assumed SQLite stores Prisma `Decimal` columns as TEXT.
 * Empirically, for this snapshot, that is FALSE: `Decimal` columns are
 * declared `DECIMAL` in SQLite, which has NUMERIC type affinity, so SQLite
 * stores them natively as INTEGER or REAL (confirmed via `typeof(col)` —
 * e.g. `orders.total_amount` reads back as SQLite type `real`, a plain JS
 * `number` from node:sqlite, not a string).
 *
 * To avoid ANY float round-trip, this script never lets a Decimal value
 * pass through a JS `number`: every Decimal column is read with
 * `CAST(col AS TEXT)` inside the SQL itself (SQLite's own canonical
 * text conversion of the stored value, done before the value ever reaches
 * JS) and written to Postgres with an explicit `::numeric` cast on its bind
 * parameter (Postgres's extended query protocol infers an untyped/text
 * parameter for a plain string bind and refuses to assign it to a numeric
 * column without one — confirmed empirically). This was cross-checked
 * against ALL 3201 non-null Decimal values in the staged snapshot: SQLite's
 * `CAST(col AS TEXT)` and a naive JS `String(value)` of the same column
 * produced byte-identical output for every single one. The guarantee this
 * provides is scoped: no round-trip is introduced BY THIS MIGRATION STEP
 * itself. Any precision loss that may have already occurred when these
 * values were originally written into SQLite (SQLite's NUMERIC-affinity
 * TEXT→REAL conversion preserves only ~15 significant digits) is a
 * pre-existing, unfixable-at-this-point condition that this script cannot
 * detect or verify. The CAST-in-SQL approach is used because it is correct
 * by construction, not by coincidence of this particular dataset.
 *
 * --- Generic column-type handling --------------------------------------
 * Rather than a hand-maintained per-model field map (36 models, error-prone
 * to keep in sync with schema.prisma), column handling is driven by each
 * column's *declared* SQLite type via `PRAGMA table_info`. This schema only
 * ever declares six SQL types — BIGINT, BOOLEAN, DATETIME, DECIMAL,
 * INTEGER, TEXT — verified exhaustively across all 29 tables present in the
 * staged snapshot (getSourceColumns throws loudly on any other declared
 * type, so a future schema change that introduces a 7th type fails the
 * script instead of being silently mishandled).
 *
 * This also transparently handles two forms of source/target drift without
 * special-casing every table:
 *  - Whole tables absent from the source (7 of them: `games`,
 *    `provider_game_mappings`, `product_provider_mappings`, `refunds`,
 *    `refund_items`, `admin_tasks`, `idempotency_records` — all added to
 *    the schema after this snapshot was staged) are skipped with 0 rows;
 *    the target simply keeps the empty rows Task 4 already created.
 *  - Columns absent from an otherwise-present source table (e.g.
 *    `orders.digiflazz_*` — five columns added after this snapshot) are
 *    simply left out of the generated INSERT's column list, so Postgres
 *    applies that column's own DEFAULT (or NULL) for every imported row —
 *    exactly the desired "preserve what exists, no schema/type changes"
 *    behavior for an engine-swap-only migration.
 *
 * One real DATETIME anomaly was found and is special-cased: 3 rows of
 * `support_tickets.last_status_change_at` are stored as SQLite's own
 * `CURRENT_TIMESTAMP` text default (`"YYYY-MM-DD HH:MM:SS"`, UTC, no offset
 * marker) instead of Prisma's usual millisecond-epoch integer. See
 * parseDateTimeValue() — naively calling `new Date("YYYY-MM-DD HH:MM:SS")`
 * parses that exact format as LOCAL time in Node, which would have
 * silently shifted those 3 timestamps by this machine's UTC offset
 * (verified: 7 hours off on this box). The fix normalizes that format to
 * an explicit UTC ISO string before parsing.
 *
 * BigInt columns (`users.telegram_id`, `orders.payment_msg_chat_id`): this
 * repo's existing node:sqlite convention (packages/db/src/migrate/
 * catalogRename.ts) does not use the `readBigInts` DatabaseSync option, so
 * this script doesn't either — by default node:sqlite returns integers as
 * plain JS numbers and THROWS a RangeError if a value can't be represented
 * exactly (i.e. exceeds Number.MAX_SAFE_INTEGER), rather than silently
 * truncating it. Every telegram_id/payment_msg_chat_id value in the staged
 * snapshot was confirmed to already come back as a JS `number` (171 values
 * checked, 0 exceptions), so `BigInt(value)` is a safe, exact conversion
 * for all of them; if a future snapshot ever had an out-of-range value, the
 * SELECT itself would throw before this script got a chance to mishandle
 * it.
 */
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";

// Physical table names, in schema.prisma @@map declaration order. Order is
// cosmetic only (for logs/report) — FK ordering is handled by
// session_replication_role=replica, not by this list's order.
const TABLES = [
  "users",
  "wallet_transactions",
  "password_reset_tokens",
  "categories",
  "games",
  "provider_game_mappings",
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

const BATCH_SIZE = 500;
// Row-by-row this would be ~6500 network round trips; batching cuts that to
// a few dozen while staying well under Postgres's 65535-bind-parameter
// limit per statement even for the widest table here (~35 columns * 500 =
// 17500 params).

type SqlColType = "BIGINT" | "BOOLEAN" | "DATETIME" | "DECIMAL" | "INTEGER" | "TEXT";
const KNOWN_TYPES: readonly SqlColType[] = ["BIGINT", "BOOLEAN", "DATETIME", "DECIMAL", "INTEGER", "TEXT"];

interface ColumnInfo {
  name: string;
  type: SqlColType;
}

function resolveSqlitePath(): string {
  return process.argv[2] ?? "./data/bot.db";
}

function tableExistsInSource(db: DatabaseSync, table: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
  return row != null;
}

function getSourceColumns(db: DatabaseSync, table: string): ColumnInfo[] {
  const raw = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string }[];
  return raw.map((c) => {
    const type = c.type.toUpperCase();
    if (!KNOWN_TYPES.includes(type as SqlColType)) {
      throw new Error(
        `Unexpected SQLite declared column type "${c.type}" on ${table}.${c.name}. This migration's ` +
          `generic column handling only understands ${KNOWN_TYPES.join("/")} (verified exhaustively ` +
          `against the staged snapshot at write time) — the source schema has since grown a new type, ` +
          `so this script needs a matching update, not a blind run.`,
      );
    }
    return { name: c.name, type: type as SqlColType };
  });
}

function buildSelectSql(table: string, cols: ColumnInfo[]): string {
  // CAST(...AS TEXT) for Decimal columns is load-bearing: see this file's
  // header comment. Every other type is read as SQLite hands it back.
  const parts = cols.map((c) =>
    c.type === "DECIMAL" ? `CAST("${c.name}" AS TEXT) AS "${c.name}"` : `"${c.name}"`,
  );
  return `SELECT ${parts.join(", ")} FROM "${table}"`;
}

// SQLite's own CURRENT_TIMESTAMP / datetime() default text format: UTC,
// no offset marker. Must NOT be handed to `new Date()` as-is (parses as
// local time in Node) — see header comment.
const NAIVE_SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

function parseDateTimeValue(raw: unknown, table: string, column: string): Date | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return new Date(raw); // Prisma's own writes: ms since Unix epoch (UTC)
  if (typeof raw === "string") {
    const normalized = NAIVE_SQLITE_DATETIME_RE.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Unparseable DATETIME text "${raw}" at ${table}.${column}`);
    }
    return d;
  }
  throw new Error(`Unexpected DATETIME raw JS type "${typeof raw}" at ${table}.${column}: ${String(raw)}`);
}

function transformValue(raw: unknown, col: ColumnInfo, table: string): unknown {
  if (raw === null || raw === undefined) return null;
  switch (col.type) {
    case "DECIMAL":
      // Already an exact string from CAST(...AS TEXT) in the SELECT — never
      // touched as a JS number. Passed straight through.
      if (typeof raw !== "string") {
        throw new Error(
          `Expected DECIMAL ${table}.${col.name} to already be a string from CAST(...AS TEXT); got ${typeof raw}`,
        );
      }
      return raw;
    case "BOOLEAN":
      if (typeof raw !== "number" && typeof raw !== "bigint") {
        throw new Error(`Expected BOOLEAN ${table}.${col.name} to be numeric; got ${typeof raw}`);
      }
      return Number(raw) !== 0;
    case "DATETIME":
      return parseDateTimeValue(raw, table, col.name);
    case "BIGINT":
      if (typeof raw === "bigint") return raw;
      if (typeof raw === "number") {
        if (!Number.isInteger(raw)) {
          throw new Error(`Expected BIGINT ${table}.${col.name} to be an integer; got ${raw}`);
        }
        return BigInt(raw);
      }
      throw new Error(`Expected BIGINT ${table}.${col.name} to be number/bigint; got ${typeof raw}`);
    case "INTEGER":
      if (typeof raw === "bigint") return Number(raw);
      if (typeof raw === "number") return raw;
      throw new Error(`Expected INTEGER ${table}.${col.name} to be numeric; got ${typeof raw}`);
    case "TEXT":
    default:
      if (typeof raw !== "string") {
        throw new Error(`Expected TEXT ${table}.${col.name} to be a string; got ${typeof raw}`);
      }
      return raw;
  }
}

function buildInsertSql(table: string, cols: ColumnInfo[], rowCount: number): string {
  const colList = cols.map((c) => `"${c.name}"`).join(", ");
  const rowsSql: string[] = [];
  let p = 1;
  for (let r = 0; r < rowCount; r++) {
    const placeholders = cols.map((c) => (c.type === "DECIMAL" ? `$${p++}::numeric` : `$${p++}`));
    rowsSql.push(`(${placeholders.join(", ")})`);
  }
  return `INSERT INTO "public"."${table}" (${colList}) VALUES ${rowsSql.join(", ")}`;
}

/** Refuses to run against a non-empty target — see header comment. */
async function assertTargetIsEmpty(prisma: PrismaClient): Promise<void> {
  const nonEmpty: { table: string; count: number }[] = [];
  for (const table of TABLES) {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) as n FROM "public"."${table}"`,
    );
    const n = Number(rows[0]!.n);
    if (n > 0) nonEmpty.push({ table, count: n });
  }
  if (nonEmpty.length > 0) {
    throw new Error(
      `Refusing to run: target already has rows in ${nonEmpty.length} table(s): ` +
        nonEmpty.map((x) => `${x.table}=${x.count}`).join(", ") +
        `. This script only imports into an empty target (idempotency guard). If this is a re-run ` +
        `after a failed partial attempt, reset the target first (e.g. \`prisma db push --force-reset\`).`,
    );
  }
}

async function main(): Promise<void> {
  const sqlitePath = resolveSqlitePath();
  console.log(`[migrate] source SQLite: ${sqlitePath} (opened read-only)`);
  console.log(`[migrate] target: DATABASE_URL_PRISMA (public schema)`);

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const prisma = new PrismaClient();

  try {
    await assertTargetIsEmpty(prisma);

    const sourceCounts: Record<string, number> = {};

    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET session_replication_role = replica`);

        for (const table of TABLES) {
          if (!tableExistsInSource(sqlite, table)) {
            console.log(`[migrate] ${table}: not present in source snapshot (newer table) — 0 rows`);
            sourceCounts[table] = 0;
            continue;
          }

          const cols = getSourceColumns(sqlite, table);
          const rows = sqlite.prepare(buildSelectSql(table, cols)).all() as Record<string, unknown>[];
          sourceCounts[table] = rows.length;

          for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, i + BATCH_SIZE);
            const sql = buildInsertSql(table, cols, batch.length);
            const values = batch.flatMap((row) => cols.map((c) => transformValue(row[c.name], c, table)));
            await tx.$executeRawUnsafe(sql, ...values);
          }

          // Keep the id sequence in sync so the app's own next insert after
          // this migration doesn't collide with an imported id.
          if (cols.some((c) => c.name === "id")) {
            await tx.$executeRawUnsafe(
              `SELECT setval(pg_get_serial_sequence('public.${table}', 'id'), ` +
                `COALESCE((SELECT MAX(id) FROM "public"."${table}"), 1), ` +
                `(SELECT MAX(id) FROM "public"."${table}") IS NOT NULL)`,
            );
          }

          console.log(`[migrate] ${table}: imported ${rows.length} rows`);
        }

        await tx.$executeRawUnsafe(`SET session_replication_role = DEFAULT`);
      },
      { timeout: 15 * 60 * 1000, maxWait: 10_000 },
    );

    console.log(`[migrate] transaction committed.`);

    // --- Verification: per-table row counts, source vs target ----------
    console.log(`\n[migrate] === Row count comparison (source vs target) ===`);
    let totalSource = 0;
    let totalTarget = 0;
    let anyMismatch = false;
    for (const table of TABLES) {
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) as n FROM "public"."${table}"`,
      );
      const target = Number(rows[0]!.n);
      const source = sourceCounts[table] ?? 0;
      totalSource += source;
      totalTarget += target;
      const ok = source === target;
      if (!ok) anyMismatch = true;
      console.log(`  ${table.padEnd(28)} source=${String(source).padStart(5)}  target=${String(target).padStart(5)}  ${ok ? "OK" : "MISMATCH"}`);
    }
    console.log(`  ${"TOTAL".padEnd(28)} source=${String(totalSource).padStart(5)}  target=${String(totalTarget).padStart(5)}`);

    if (anyMismatch) {
      throw new Error("Row count mismatch between source and target — see table above.");
    }

    console.log(`\n[migrate] DONE — ${totalTarget} rows imported across ${TABLES.length} tables, all row counts match.`);
  } finally {
    sqlite.close();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exitCode = 1;
});
