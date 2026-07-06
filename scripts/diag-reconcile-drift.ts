/**
 * Diagnostic for the "⚠ Reconciliation drift detected" admin DM — that alert
 * (apps/order-bot/src/jobs/index.ts reconcileFinancesJob) and its audit-log
 * entry (action `reconcile_finances.drift`) only ever carry the COUNTS
 * (orders/vouchers/negative wallets). The actual drifted rows are computed by
 * reconcileFinances() but never persisted anywhere — this script re-runs that
 * same check and prints the specific rows so the drift can actually be
 * diagnosed. Run it on the box holding the live SQLite DB (the VPS):
 *
 *   pnpm tsx scripts/diag-reconcile-drift.ts
 *
 * Read-only — reconcileFinances() never mutates rows.
 */
import { prisma, initDb, reconcileFinances } from "@app/db";

async function main() {
  await initDb();
  const findings = await reconcileFinances(prisma);

  console.log(`order_drift: ${findings.order_drift.length}`);
  for (const d of findings.order_drift) {
    const o = await prisma.order.findUnique({ where: { id: d.order_id } });
    console.log(`\n--- order #${d.order_id} (${d.order_code}) ---`);
    console.log(`  expected total: ${d.expected}`);
    console.log(`  stored total:   ${d.actual}`);
    if (o) {
      console.log(`  status: ${o.status}  currency: ${o.currency}  fxRate: ${o.fxRate}`);
      console.log(`  subtotal: ${o.subtotalAmount}  bulkDiscount: ${o.bulkDiscountAmount}  discount: ${o.discountAmount}`);
      console.log(`  walletUsed: ${o.walletUsed}  uniqueCents: ${o.uniqueCents}`);
      console.log(`  createdAt: ${o.createdAt.toISOString()}  updatedAt: ${o.updatedAt?.toISOString?.() ?? "n/a"}`);
    }
  }

  console.log(`\nvoucher_drift: ${findings.voucher_drift.length}`);
  for (const v of findings.voucher_drift) {
    console.log(`  voucher #${v.voucher_id} (${v.code}): recorded_used=${v.recorded_used} actual_orders=${v.actual_orders}`);
  }

  console.log(`\nnegative_wallets: ${findings.negative_wallets.length}`);
  for (const w of findings.negative_wallets) {
    console.log(`  user #${w.user_id} (tg:${w.telegram_id}): balance=${w.balance}`);
  }

  process.exit(0);
}

main();
