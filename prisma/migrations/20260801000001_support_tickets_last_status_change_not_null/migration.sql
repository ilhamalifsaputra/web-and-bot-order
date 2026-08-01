-- H-8 catch-up migration (part 2/2 — isolated on purpose, higher risk than
-- part 1). Closes the one remaining schema.prisma/migrations gap:
-- support_tickets.last_status_change_at was added nullable by
-- 20260725000000_add_ticket_priority_category_resolved (that file's own
-- header explains why: SQLite's `ALTER TABLE ADD COLUMN` rejects
-- CURRENT_TIMESTAMP as a non-constant default), but schema.prisma declares
-- it `DateTime @default(now())` — NOT NULL. Unlike every column in part 1
-- (20260801000000_catchup_missing_columns_and_indexes), this is a
-- CONSTRAINT CHANGE on an EXISTING column, not a new column — SQLite has no
-- `ALTER TABLE ... ALTER COLUMN`, so there is no ADD-COLUMN-style shortcut
-- here. A table rebuild (create-new/copy/drop/rename) is unavoidable.
--
-- WHY THIS IS ITS OWN FILE, NOT BUNDLED INTO PART 1:
-- support_tickets is a cascade-FK parent (child: ticket_messages, ON DELETE
-- CASCADE). DROP TABLE performs an implicit DELETE, which fires ON DELETE
-- CASCADE actions on children UNLESS foreign-key enforcement is genuinely
-- off. `PRAGMA foreign_keys=OFF` (used below, matching Prisma's own
-- generated form) is a **documented SQLite no-op when issued from inside an
-- already-open transaction** — https://www.sqlite.org/pragma.html#pragma_foreign_keys
-- states the pragma is a no-op within a transaction. If some runner wraps
-- this file's statements in an explicit BEGIN/COMMIT, foreign-key
-- enforcement silently stays on the whole time, and the DROP TABLE below
-- cascade-deletes every ticket_messages row for every ticket — silently,
-- no error.
--
-- EMPIRICAL VERIFICATION (done for this task, not assumed): built a scratch
-- parent/child schema shaped identically to support_tickets/ticket_messages
-- (nullable timestamp -> NOT NULL @default(now()), ON DELETE CASCADE
-- child), seeded it with rows on both sides, and ran the equivalent
-- rebuild SQL through each mechanism this repo could realistically use:
--   * `prisma db push` (recomputes its own plan; does NOT read this file at
--     all under this repo's actual deploy process — see docs/MIGRATIONS.md)
--     -> children intact.
--   * `prisma db execute --file <the exact generated rebuild script>`
--     -> children intact.
--   * a real `prisma migrate deploy` run (seed after migration 1, then
--     apply this migration as migration 2) -> children intact.
--   * the SAME script wrapped in an explicit `BEGIN` / `<script>` / `COMMIT`
--     (simulating a tool or operator that runs it as one manual
--     transaction) -> children SILENTLY DELETED, zero errors. This
--     reproduces the exact failure mode originally flagged in code review.
-- Conclusion: every mechanism this repo would actually use today (`db
-- push`) or is meant to unblock (`migrate deploy`, the whole point of H-8)
-- applies this safely, because none of them wrap SQLite DDL in an explicit
-- transaction. The hazard is real specifically for manual/ad-hoc execution
-- that DOES wrap it in a transaction (e.g. pasting into a DB GUI client
-- with "run as transaction" on, `psql`-style scripted transactions, or a
-- future runner that isn't one of the three above) — DO NOT do that with
-- this file. If you're about to run this file any other way than `prisma
-- db push` or a genuine `prisma migrate deploy`, stop and re-verify
-- transaction behavior first, the same way this header did.
--
-- REQUIRED, NOT INCIDENTAL, PLUS ITS OWN RISK (not cascade-related): the
-- rebuild below also creates `support_tickets_order_id_fkey ... ON DELETE
-- SET NULL`, a constraint that has never existed in this table's history —
-- `order_id` was added by 20260724150000_add_support_ticket_order_link as a
-- bare `ALTER TABLE ADD COLUMN` with no FK (SQLite's ADD COLUMN can't add
-- one), but schema.prisma has always declared `order Order? @relation(fields:
-- [orderId], references: [id], ...)` on SupportTicket. Adding this FK is a
-- REQUIRED outcome of this migration, not an incidental side effect of the
-- rebuild: without it, `prisma migrate diff --exit-code` (check-migration-
-- drift) reports a difference and this migration's own "verified: reports
-- No difference detected" claim below would be false. It does carry its own
-- risk, documented here so it isn't mistaken for a free side effect: with
-- `defer_foreign_keys=ON`, if `foreign_keys` enforcement ends up genuinely
-- ON during this rebuild (i.e. the same bad condition as above —
-- an enclosing transaction), any pre-existing support_tickets row whose
-- order_id points at a since-deleted/nonexistent order would fail this new
-- FK's deferred check at COMMIT, aborting the migration with an error
-- (safer than the silent cascade above, but still an unplanned failure).
-- Under the three verified-safe mechanisms this doesn't trigger either,
-- for the same reason: foreign-key enforcement never actually turns on.
--
-- INTERACTION WITH THE PARTIALLY-APPLIED 20260725000000 MIGRATION (H-9):
-- 20260725000000_add_ticket_priority_category_resolved once failed a real
-- `migrate deploy` with P3018 ("Cannot add a column with non-constant
-- default"), leaving a database where `category`, `first_response_at` and
-- `resolved_at` HAD landed but `last_status_change_at` had NOT (SQLite
-- auto-commits each DDL statement, so the three statements before the
-- failing one stuck; Prisma nonetheless records `applied_steps_count = 0`,
-- which is what tempts an operator into `migrate resolve --rolled-back`).
-- On such a database `SELECT ... "last_status_change_at" ... FROM
-- "support_tickets"` below has no column to resolve against.
--
-- Every column reference in the SELECT is therefore QUALIFIED
-- (`"support_tickets"."col"`, not bare `"col"`). This is load-bearing, not
-- style: Prisma's bundled SQLite has the legacy double-quoted-string-literal
-- fallback ENABLED, so a BARE `"last_status_change_at"` that resolves to no
-- column is silently reinterpreted as the string literal
-- 'last_status_change_at' — the rebuild then "succeeds" and writes that
-- literal text into every row's last_status_change_at, corrupting the whole
-- table with no error at all. Verified empirically for this task on scratch
-- databases under the OS temp dir: `prisma db execute` of
-- `SELECT coalesce("missing_col", "created_at")` stored the string
-- "missing_col"; the qualified form `coalesce("src"."missing_col", ...)`
-- failed loudly with `no such column: src.missing_col`. Qualified references
-- cannot take that fallback, so a partially-applied database now aborts the
-- migration instead of silently corrupting it.
--
-- RECOVERY for that partially-applied state (complete the missing statement
-- first, THEN mark the old migration applied, THEN deploy) is written out
-- step by step in docs/MIGRATIONS.md, section "Pemulihan dari `migrate
-- deploy` yang gagal (P3018 / P3009)". Do not simply re-point this file at
-- unqualified column names to make the error go away.
--
-- CROSS-TASK NOTE: Task 38 (M-29) is scoped to fix two write paths that
-- never stamp `lastStatusChangeAt` and the resulting schema/migration
-- mismatch this file closes. This migration's `coalesce(last_status_change_at,
-- CURRENT_TIMESTAMP)` backfill assumes every existing row already has a
-- real value (true today per 20260725000000_add_ticket_priority_category_resolved's
-- own backfill UPDATE) — Task 38 should double-check that assumption still
-- holds once it audits those write paths, and is free to add a follow-up
-- migration if it finds rows this one's backfill doesn't actually cover.
--
-- VALIDATED FOR: bringing prisma/migrations/* in sync with schema.prisma
-- via `prisma migrate diff` (confirmed zero-diff after this file — see
-- task-36-report.md). NOT validated as a general-purpose "safe against any
-- populated database under any runner" claim — see the transaction caveat
-- above.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
-- Retry safety: SQLite auto-commits each DDL statement, so if this file
-- aborts part-way (e.g. the INSERT below hits a partially-applied
-- support_tickets — see the header), the staging table survives and a second
-- `migrate deploy` would fail with "table new_support_tickets already
-- exists", masking the real cause. On a healthy database this is a no-op:
-- the staging table only ever exists mid-file. It has no foreign-key
-- children of its own, so dropping it cascades to nothing.
DROP TABLE IF EXISTS "new_support_tickets";
CREATE TABLE "new_support_tickets" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "photo_file_ids" TEXT,
    "attachment_urls" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "category" TEXT,
    "admin_reply" TEXT,
    "admin_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replied_at" DATETIME,
    "first_response_at" DATETIME,
    "resolved_at" DATETIME,
    "order_id" INTEGER,
    "last_status_change_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" DATETIME,
    CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "support_tickets_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "support_tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
-- Source columns are qualified with "support_tickets". on purpose — see the
-- header. A bare double-quoted name that matches no column would be silently
-- treated as a string literal by Prisma's SQLite build instead of failing.
INSERT INTO "new_support_tickets" ("admin_id", "admin_reply", "attachment_urls", "category", "closed_at", "created_at", "first_response_at", "id", "last_status_change_at", "message", "order_id", "photo_file_ids", "priority", "replied_at", "resolved_at", "status", "user_id") SELECT "support_tickets"."admin_id", "support_tickets"."admin_reply", "support_tickets"."attachment_urls", "support_tickets"."category", "support_tickets"."closed_at", "support_tickets"."created_at", "support_tickets"."first_response_at", "support_tickets"."id", coalesce("support_tickets"."last_status_change_at", CURRENT_TIMESTAMP) AS "last_status_change_at", "support_tickets"."message", "support_tickets"."order_id", "support_tickets"."photo_file_ids", "support_tickets"."priority", "support_tickets"."replied_at", "support_tickets"."resolved_at", "support_tickets"."status", "support_tickets"."user_id" FROM "support_tickets";
DROP TABLE "support_tickets";
ALTER TABLE "new_support_tickets" RENAME TO "support_tickets";
CREATE INDEX "ix_support_tickets_user_id" ON "support_tickets"("user_id");
CREATE INDEX "ix_support_tickets_closed_at" ON "support_tickets"("closed_at");
CREATE INDEX "ix_support_tickets_order_id" ON "support_tickets"("order_id");
CREATE INDEX "ix_support_tickets_status" ON "support_tickets"("status");
CREATE INDEX "ix_support_tickets_priority" ON "support_tickets"("priority");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
