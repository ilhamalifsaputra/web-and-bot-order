/**
 * Runs `checkStockIntegrity` (packages/db/src/crud/stockIntegrity.ts) against
 * whatever `DATABASE_URL_PRISMA` points at and prints the counts — the
 * in-repo companion to scripts/audit-stock-duplicates.sql for the same
 * Fase 4a pre-flight (both feed the owner's decision on Fase 4b's unique
 * constraint on OrderItem.stockItemId).
 *
 * READ-ONLY: `checkStockIntegrity` only ever SELECTs/COUNTs, and this script
 * neither writes nor mutates anything. It prints counts only — never a
 * sample id list or, obviously, any credential text — a non-zero finding is
 * followed up by calling `checkStockIntegrity` directly (or re-reading
 * scripts/audit-stock-duplicates.sql's output) for the offending ids.
 *
 *   pnpm audit-stock-integrity
 */
import { pathToFileURL } from "node:url";
import { prisma, initDb, checkStockIntegrity } from "@app/db";

async function main(): Promise<void> {
  await initDb();

  const report = await checkStockIntegrity(prisma);

  console.log("[audit-stock-integrity] Stock/order-item integrity report (counts only):");
  console.log(`  reservedOrSoldWithoutOrderId: ${report.reservedOrSoldWithoutOrderId.count}`);
  console.log(`  soldWithoutSoldAt: ${report.soldWithoutSoldAt.count}`);
  console.log(`  statusOutsideEnum: ${report.statusOutsideEnum.count}`);
  console.log(`  duplicateStockItemPointers: ${report.duplicateStockItemPointers.count}`);
  console.log(`  softDeletedStillReserved: ${report.softDeletedStillReserved.count}`);
  console.log(`  statusEventMismatch: ${report.statusEventMismatch.count}`);
  console.log(`  legacyRowsWithoutEvents: ${report.legacyRowsWithoutEvents}`);
  console.log(
    `  cancelledOrRejectedOrderItemsStillLinked: ${report.cancelledOrRejectedOrderItemsStillLinked.count}`,
  );
  console.log(
    `  duplicateActiveCredentialFingerprints: ${report.duplicateActiveCredentialFingerprints.count}`,
  );

  const totalFindings =
    report.reservedOrSoldWithoutOrderId.count +
    report.soldWithoutSoldAt.count +
    report.statusOutsideEnum.count +
    report.duplicateStockItemPointers.count +
    report.softDeletedStillReserved.count +
    report.statusEventMismatch.count +
    report.cancelledOrRejectedOrderItemsStillLinked.count +
    report.duplicateActiveCredentialFingerprints.count;

  if (totalFindings === 0) {
    console.log("\nNo integrity violations found.");
  } else {
    console.log(
      `\n${totalFindings} row(s) across the checks above need a closer look — re-run checkStockIntegrity ` +
        "programmatically or use scripts/audit-stock-duplicates.sql to get the offending ids.",
    );
  }

  await prisma.$disconnect();
}

// Guarded so importing this file never opens the app's own database
// connection or runs the audit as a side effect — same guard as
// scripts/backfill-encrypt-stock-credentials.ts.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(async (e) => {
    console.error("[audit-stock-integrity] failed:", e instanceof Error ? e.message : e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
