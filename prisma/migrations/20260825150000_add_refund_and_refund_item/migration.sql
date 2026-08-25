-- Task 8a (Trustance Master Architecture): Refund domain schema —
-- `refunds` + `refund_items`, a request/approval-workflow record layered on
-- top of the existing order/wallet machinery. This is SCHEMA-ONLY: no crud
-- layer, no state machine, no wiring to `adjustWallet`/WalletTransaction yet
-- (that lands in the follow-up task). Pure additive CREATE TABLE + indexes,
-- hand-written per docs/MIGRATIONS.md (this repo deploys schema with
-- `prisma db push`, so these files are the SQL audit trail, verified
-- byte-identical to `prisma migrate diff --script` output by
-- `pnpm run check-migration-drift` in `pretest`). Never touches an existing
-- table — safe on a live DB with no backfill step.
--
-- `refunds.order_id` -> `orders.id` and `refund_items.order_item_id` ->
-- `order_items.id` are both ON DELETE RESTRICT, matching this schema's
-- existing conservative FK policy for every other Order-adjacent
-- financial-audit row (wallet_transactions, order_status_history,
-- referrals, reviews, order_items itself — Infra-5 fix, security audit
-- 2026-06-23): no code path hard-deletes an Order or OrderItem today; this
-- is a schema-level guardrail against ever adding one that would silently
-- orphan a refund record. `refund_items.refund_id` -> `refunds.id` is ALSO
-- RESTRICT (not Cascade) for the same reason — RefundItem is itself
-- financial-audit-significant, the per-line detail of a Refund, and no
-- code path deletes a Refund either.
--
-- `refunds.status` defaults 'PENDING' (PENDING | PROCESSING | COMPLETED |
-- FAILED | CANCELLED) — safe as a NOT NULL DEFAULT because this is a brand
-- new, currently-empty table (unlike the nullable-no-default pattern used
-- for retrofitting a column onto an already-populated table, e.g.
-- order_items.status in 20260825140000_add_order_item_status).
--
-- See schema.prisma's doc comments on Refund/RefundItem for the full
-- design reasoning (currency snapshot, free-text reason, no typed
-- `paymentId` FK — this repo has no single Payment table to point one at —
-- and the per-order-item refund-sum invariant deliberately left for the
-- application layer, not the schema, to enforce).

-- CreateTable
CREATE TABLE "refunds" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "order_id" INTEGER NOT NULL,
    "amount" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "external_reference" TEXT,
    "processed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "refund_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "refund_id" INTEGER NOT NULL,
    "order_item_id" INTEGER NOT NULL,
    "amount" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refund_items_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "refund_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- CreateIndex
CREATE INDEX "ix_refunds_order_id" ON "refunds"("order_id");

-- CreateIndex
CREATE INDEX "ix_refunds_status" ON "refunds"("status");

-- CreateIndex
CREATE INDEX "ix_refund_items_refund_id" ON "refund_items"("refund_id");

-- CreateIndex
CREATE INDEX "ix_refund_items_order_item_id" ON "refund_items"("order_item_id");
