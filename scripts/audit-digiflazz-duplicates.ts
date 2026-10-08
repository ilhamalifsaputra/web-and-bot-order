import "dotenv/config";
import { prisma, auditDigiflazzDuplicates, logAdminAction } from "@app/db";

// Default and --dry-run are strictly read-only. Archive is an explicitly
// selected, reversible alternative to merging or retargeting historic orders.
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Audit: tsx scripts/audit-digiflazz-duplicates.ts [--dry-run]\nReview: --archive-source ID --keep ID\nWrite only after backup: add --apply --backup-confirmed (requires archive-column migration).");
    return;
  }
  const allowed = new Set(["--dry-run", "--summary", "--archive-source", "--keep", "--apply", "--backup-confirmed"]);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i]!)) throw new Error(`Unknown argument: ${args[i]}`);
    if (["--archive-source", "--keep"].includes(args[i]!)) i++;
  }
  const readId = (flag: string) => args.includes(flag) ? Number(args[args.indexOf(flag) + 1]) : null;
  const sourceId = readId("--archive-source");
  const keepId = readId("--keep");
  const report = await auditDigiflazzDuplicates(prisma);
  console.log(JSON.stringify(args.includes("--summary") ? {
    products: report.products.map(p => ({ ...p, denominations: undefined,
      denominationCount: p.denominations.length, liveCount: p.denominations.filter(d => !d.archived).length,
      orderReferences: p.denominations.reduce((count, d) => count + d.orders, 0),
      inventory: p.denominations.reduce((count, d) => count + d.inventory, 0),
      customPrices: p.denominations.filter(d => d.priceOverridden).length })),
    candidates: report.candidates, identityConflicts: report.identityConflicts,
  } : report, null, 2));
  if (sourceId === null && keepId === null) {
    if (args.includes("--apply")) throw new Error("Select --archive-source and --keep IDs explicitly.");
    return;
  }
  if (!sourceId || !keepId || sourceId === keepId || !Number.isSafeInteger(sourceId) || !Number.isSafeInteger(keepId)) throw new Error("Select two distinct valid product IDs.");
  const validate = (current: typeof report) => {
    const candidate = current.candidates.find(pair => [pair.leftId, pair.rightId].includes(sourceId) && [pair.leftId, pair.rightId].includes(keepId));
    const source = current.products.find(p => p.id === sourceId);
    const keep = current.products.find(p => p.id === keepId);
    if (!source || !keep || candidate?.classification !== "exact_overlap" ||
        source.denominations.some(d => !d.sku || (d.provider && d.provider !== "digiflazz")) || keep.denominations.some(d => !d.sku || (d.provider && d.provider !== "digiflazz")) || keep.archived ||
        keep.denominations.some(d => d.archived)) throw new Error("Only reviewed exact SKU overlap without manual denominations or scope conflicts can be archived by this tool.");
    return source;
  };
  const source = validate(report);
  console.log(JSON.stringify({ mode: "dry-run", archiveProduct: sourceId, keepProduct: keepId,
    denominationIds: source.denominations.map(d => d.id), historicalReferences: "unchanged", metadata: "retained on source" }));
  if (!args.includes("--apply") || args.includes("--dry-run")) return;
  if (!args.includes("--backup-confirmed")) throw new Error("A restorable database backup is required; confirm with --backup-confirmed.");
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(73910421)::text`;
    await tx.$queryRaw`SELECT id FROM products WHERE id IN (${sourceId}, ${keepId}) ORDER BY id FOR UPDATE`;
    const fresh = validate(await auditDigiflazzDuplicates(tx));
    // The batch helper owns a transaction; use the existing marker lock and
    // writer inside this transaction instead, preserving its lock order.
    const { forgetDigiflazzAutoDeactivatedIds } = await import("../packages/db/src/crud/digiflazzAutoDeactivated");
    const ids = fresh.denominations.map(d => d.id);
    await forgetDigiflazzAutoDeactivatedIds(tx, ids);
    await tx.$queryRaw`SELECT id FROM denominations WHERE id = ANY(${ids}::int[]) ORDER BY id FOR UPDATE`;
    await tx.denomination.updateMany({ where: { productId: sourceId }, data: { isArchived: true, isActive: false } });
    await tx.product.update({ where: { id: sourceId }, data: { isArchived: true, isActive: false } });
    await logAdminAction(tx, { adminId: null, action: "digiflazz_duplicate_archive_cli", targetType: "product", targetId: sourceId,
      details: `Archived duplicate product ${sourceId} and ${ids.length} denomination${ids.length === 1 ? "" : "s"}; kept product ${keepId}. Requested denomination IDs: ${ids.join(", ")}. Historical records remain on their original IDs.` });
  });
  console.log("Selected duplicate archived. No historical records were merged or retargeted.");
}
main().catch(err => { console.error(err instanceof Error ? err.message : "Audit failed"); process.exitCode = 1; }).finally(() => prisma.$disconnect());
