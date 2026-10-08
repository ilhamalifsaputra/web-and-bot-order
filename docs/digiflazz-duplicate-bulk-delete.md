# Digiflazz identity and denomination deletion — 2026-10-09

## Evidence and scope

Confirmed from code before this change:

- Admin `DigiflazzSyncPage` calls `/api/catalog/digiflazz/sync/preview` and `/sync/apply` in `apps/web-admin/src/routes/api/digiflazzSync.ts`. The wizard calls `importDigiflazzBrand` in `packages/db/src/crud/digiflazz.ts`.
- Import found the parent using exact `Product.digiflazzBrand`, then searched for a supplier SKU **only under that parent**. A changed region/type grouping string could therefore create another parent and another denomination for an existing SKU. There was no database uniqueness for either brand or supplier SKU. The parent row lock happened after first creation, leaving concurrent first imports unprotected.
- `groupDigiflazzPriceListByBrand` builds display grouping from actual `brand`, `type`, and parsed region. Digiflazz supplies `buyerSkuCode` per denomination, not a canonical game ID. The pre-existing detection/canonical-product layer concerns classification and presentation; it is not a database ownership constraint. No name-only equivalence is safe to infer.
- The hourly bot job `apps/order-bot/src/jobs/index.ts` calls `runDigiflazzCatalogSync`; the manual recurring-sync API shares its Settings lease. Auto-add already checked SKUs globally, but import did not. Auto-add locked individual parents, so different parents still needed a common serialization guard and a database constraint.
- Manual creation uses `createCatalogProduct`/`createDenomination` from admin API and bot admin conversation. CSV import uses `catalogImport.ts`'s category/name resolver and creates manual denominations; it does not establish supplier identity. `productProviderMappings.ts` resolves the selected provider to the denomination's cached `autoDeliverySource`/`supplierSku`. These writers now share the database identity constraint.
- Re-import previously overwrote denomination display name, duration and price. Recurring sync already respected `priceOverridden`, retained missing SKUs on partial responses, and aborted empty or unusually sharp price responses. These failure safeguards remain.
- Admin list `_count.denominations` and detail `denominations.length` both counted every denomination without pagination or active filtering. No code evidence establishes the screenshot's 43/41 as a bug. Counts now both mean **not deleted**, including inactive rows. Stock is local stock inventory; `SHARED` and zero stock do not establish supplier availability. Sync uses the actual `buyerProductStatus` flag.

Read-only audit of the configured **local** PostgreSQL database on this run: 40 products, no candidate pairs or duplicate supplier ownership. Product 6, `MOBILE LEGENDS (Indonesia)`, had 27 denominations; the unparenthesized screenshot entry was absent. This does not prove the state of production. No live records were merged, archived or deleted and no migration was applied to the local application schema.

Subsequent local release verification applied both reviewed incremental SQL files to the isolated release database's `public` schema after the read-only preflight. The database still had 40 products and 326 denominations, with no archived rows, candidate pairs or identity conflicts. The archive column, inactive check and supplier-identity index were verified. A pre-change backup at `.tmp/digiflazz-release/local-before.dump` was restored and checked in a temporary database. No production database was changed and no duplicate reconciliation was performed; the final full release gate remains pending.

## Resulting behavior

Identity is `(provider, supplierSku)`. There is currently one shared Digiflazz account configured through Settings and no tenant/account column to scope this further. A legacy non-null supplier SKU with null source is interpreted as Digiflazz, matching the old schema convention; explicit other providers have a separate namespace.

Import takes a PostgreSQL transaction advisory lock **before** discovering or creating a parent. Exact SKU ownership takes precedence over presentation grouping. Identical SKU evidence across punctuation changes reuses the existing parent, preserving the admin display name, image, slug, category, price overrides and input configuration. Multiple owner products, duplicate live SKU owners, or changed grouping containing new unknown SKUs reject the brand transaction for manual review. Similar names without matching supplier identity never cause an automatic merge. With no ownership evidence, the existing exact structured grouping is the fallback. Duplicate live brand groups are blocked on import and excluded from recurring auto-add. Archived source parents are excluded from grouping ownership, so an explicitly selected same-brand survivor can receive new SKUs after repair. Auto-add rechecks the parent archive state after taking its transaction lock.

The same advisory lock serializes wizard creation and recurring auto-add across parents/processes; the database index also covers manual creation, editor updates and provider-cache resolution. Provider errors or absent rows do not purge records. Deleted denominations are ignored on recurring sync and wizard re-import. Existing rows only receive supplier cost/raw-name refresh on wizard re-import; selling-price changes remain an explicit edit or the existing recurring markup policy.

Import returns/logs `created`, `updated`, `unchanged`, `skipped`, `conflicts`, `errors`. It is atomic **per brand**, as before, and its API reports earlier committed brands when a later brand conflicts. Recurring sync retains its existing public price/availability counters and emits an additional structured write report for processed visible rows and auto-add failures. Brand ambiguity is logged as a conflict; archived rows are intentionally outside that processed-row report.

`ProductDetailPage` adds **Delete selected** to the existing toolbar. The Radix confirmation dialog names the snapshot of selected IDs and explains the scope and history/supplier effects. This table has no pagination/filter: select-all selects all current rows for this product. Actions/selection are disabled during the request; the shared dialog prevents duplicate submits, preserves focus management, and disallows dismissing a pending operation. Errors retain the selection; success clears selection and invalidates the shared catalog queries, refreshing list/detail counts. Mobile uses the existing DataTable card layout and wrapping toolbar.

`POST /api/catalog/products/:productId/denominations/bulk-delete` validates/deduplicates 1–500 positive PostgreSQL integer IDs, checks that **every** ID belongs to the routed product and archives all selected rows in one transaction. Missing/foreign IDs reject the whole batch. The archive, inactive status, sync-marker removal and audit entry commit together; database failure cannot report success. Authentication, CSRF and the existing super-admin mutation gate protect delete/restore.

`Denomination.isArchived=true` plus `isActive=false` is deletion from sale, not a physical deletion. Supplier identity remains a tombstone. Manual denominations also use this reversible bulk archive policy and do not acquire supplier identity/exclusions. Single deletion keeps the existing hard-delete/refusal policy for manual rows; single supplier deletion archives instead. Supplier product cascade deletion is refused to preserve tombstones.

**Show deleted denominations → Restore inactive** calls the corresponding product-scoped `bulk-restore` endpoint. Restore retains the inactive status and removes archive exclusion; admin activation is a separate action. Restore rejects an identity occupied by another visible denomination. Deactivate alone retains the denomination in the detail table and is distinct from deletion. Editable denomination writes atomically require an unarchived row; a stale PATCH that races with deletion returns 409 and retains the original supplier tombstone.

Orders, order items, stock, inventory events, payment records, input snapshots and provider mappings are retained. The PostgreSQL check constraint prevents an archived denomination from being active even through another writer. Website/bot browse and checkout already require `isActive`, so archived rows cannot be offered or purchased. Paid orders still resolve the retained denomination/supplier SKU or the existing order fulfillment snapshot; fulfillment does not require catalog activity.

## Audit and explicitly selected reconciliation

Run from the repository root with the correct database URL:

```text
node node_modules/tsx/dist/cli.mjs scripts/audit-digiflazz-duplicates.ts --dry-run
node node_modules/tsx/dist/cli.mjs scripts/audit-digiflazz-duplicates.ts --dry-run --summary
```

Default and `--dry-run` are read-only, including on pre-migration databases. The full report includes product IDs, names, slugs, category/region/variant, source, image, active/archive state; denomination IDs, exact supplier SKUs, custom pricing, inventory and order-reference counts, mappings and input metadata. It selects neither customer answers nor stock credentials. `identityConflicts` also finds duplicate SKUs **within** one parent.

Candidate classes are `exact_overlap`, `partial_overlap`, `name_only_similarity`, and `legitimate_separate_product`. Scope disagreement plus SKU overlap is flagged for review, never silently repaired. Name normalization is only a candidate signal. Missing region/variant metadata is uncertainty, not upstream proof.

For a reviewed **exact** Digiflazz SKU set overlap, choose the survivor based on images, customized inputs/pricing, links and business semantics. Preview a reversible archive of the other product:

```text
node node_modules/tsx/dist/cli.mjs scripts/audit-digiflazz-duplicates.ts --archive-source SOURCE_ID --keep KEEP_ID --dry-run
```

Only after restoring/verifying a database backup and explicit operator selection:

```text
node node_modules/tsx/dist/cli.mjs scripts/audit-digiflazz-duplicates.ts --archive-source SOURCE_ID --keep KEEP_ID --apply --backup-confirmed
```

This tool revalidates exact overlap in a transaction and archives the selected source parent/denominations; it does **not** retarget transactions or merge metadata. Source metadata remains available for manual comparison/copy to the survivor. No automatic SEO redirect is introduced. Manual denominations, different scope, partial overlap, archived survivor or a provider other than Digiflazz are refused. Review partial/intra-product overlaps per SKU and archive only explicitly chosen duplicate denominations; do not hard-delete or rewrite historical order/payment/fulfillment references. Name-only candidates need verified upstream identity/manual grouping before any repair.

The two screenshot Mobile Legends entries have **not** been merged. Run this audit against that database and review exact overlaps/metadata before choosing either survivor. Similar punctuation alone is insufficient.

## Safe deployment and backout

Two additive migrations are included:

1. `20261009090000_denomination_archive_identity`: archive column and `CHECK (NOT is_archived OR NOT is_active)`.
2. `20261009090100_supplier_identity_unique`: explicit collision preflight and a partial expression unique index on `(COALESCE(auto_delivery_source, 'digiflazz'), supplier_sku)` for non-archived rows. Null supplier SKUs remain unconstrained. Archived historical collisions are retained. Prisma cannot express this index/check directly; SQL migrations are authoritative. The drift check ignores unsupported SQL-only constructs, so integration tests also exercise database enforcement.

Follow [the repository migration policy](MIGRATIONS.md): the existing databases use `db push` and explicitly reviewed SQL. `_prisma_migrations` is not a trusted applied-schema history. These files document this release's SQL; do not run the full migration history with `migrate deploy` or mark migrations applied with `migrate resolve` to bypass that history. `db push` can add the archive column but cannot install this release's SQL-only check or expression index.

Before deployment: take and verify a restorable backup; run the read-only audit; pause scheduled/manual sync and catalog mutations. Inspect the target database's actual column, constraint and index definitions rather than migration-history rows. On a target that has none of this release's DDL, apply the first file transactionally, with `psql` configured for the correct target database through the usual PostgreSQL connection settings:

```text
psql -v ON_ERROR_STOP=1 --single-transaction --file prisma/migrations/20261009090000_denomination_archive_identity/migration.sql
pnpm exec prisma generate
```

The SQL files are not idempotent. If the archive column already exists from `db push`, verify its definition and apply only the reviewed missing `CHECK (NOT is_archived OR NOT is_active)` statement from the first file. If any earlier attempt partially applied DDL, inspect its actual state and apply only missing statements; do not blindly rerun files or change migration-history records.

If identity conflicts exist, keep writers stopped and use the generated client with the explicit audit/repair tool after the archive column/check are ready. Select survivors manually using the reviewed report and backup; re-audit until `identityConflicts` is empty. The unique-index file's preflight must still run and must refuse any remaining collision without changing or deleting rows. Then, on a target without this index, install the second file transactionally:

```text
psql -v ON_ERROR_STOP=1 --single-transaction --file prisma/migrations/20261009090100_supplier_identity_unique/migration.sql
```

With no conflicts the same two SQL steps apply, without a repair step. Verify the archive column, named `denominations_archive_inactive` constraint and `ix_denominations_supplier_identity` index definitions, then deploy the server/admin bundle together and restart workers before new code runs. Routine `db push` remains the repository's schema synchronization policy; it does not replace these explicit SQL steps. Never use `--accept-data-loss` or automatically delete rows to get past the preflight.

Record the selected source/keep IDs, denomination IDs and original activity/archive states from the report and backup. Backout a deletion through Restore inactive, review, then explicitly activate. Backout a duplicate archive requires first freeing any occupied provider identities or reverting the choice of survivor; the index deliberately blocks restoring both visible duplicates. Historical data was never moved and remains on the source IDs. Prefer retaining additive columns/index/check when rolling application code back; keep catalog mutations paused because older code does not understand archive semantics, and prevent an older entrypoint's schema push with the documented `AUTO_MIGRATE=0` override. A schema/data rollback uses the verified pre-deploy dump and the existing [backup/restore procedure](../deploy/backup/README.md), including its `SKIP_AUTO_MIGRATE` sentinel until the matching code is selected. Any DDL rollback or bulk restoration is an explicitly reviewed maintenance action, not a startup/seed operation.

Remaining limitations: this is a single-account identity scope, supplier product grouping without known SKUs is still the existing explicit structured-group fallback, and admin-owned free-text region/variant metadata is not authoritative upstream identity. Full automatic product merge, metadata reconciliation and SEO redirects are intentionally not performed. Production screenshot counts/data require their own audit.

## Verification

Automated coverage includes global SKU reuse across punctuation changes; different regions/providers; concurrent/idempotent import; preservation of customized names/images/prices; provider timeout/partial response; read-only audit classes; strict/empty/malformed/foreign/duplicate IDs; atomic archive rollback on audit failure; real PostgreSQL uniqueness; restore conflict; retained order/stock history; website/bot checkout exclusion; supplier tombstones; consistent 43→41 counts; confirmation/cancel/pending/failure/selection-refresh UI behavior. The existing Digiflazz fulfillment/availability suites remain part of the validation run.

Validated: six relevant suites passed **463 tests**, including historical Digiflazz fulfillment after deletion. Root test/server TypeScript check and admin-client TypeScript check passed. Migration drift reported `No difference detected`; migration timestamps and frontend boundaries passed. Admin Vite production build passed, with a >500 kB chunk warning. `git diff --check` passed. The admin package has no separate lint script; its relevant static checks are TypeScript and frontend boundaries.

The test suites create temporary PostgreSQL schemas and clean up only those schemas. No production migration or repair is run by tests.
