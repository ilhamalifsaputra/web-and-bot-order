/**
 * One-time cutover: reinterpret the catalog's money base from USDT to Rupiah
 * (plan.md §15.1 / §17.2 #4).
 *
 * Until the cutover, `Product.price` / `resellerPrice` and fixed-amount
 * voucher values mean USDT. The central-IDR model keeps the SAME columns but
 * stores Rupiah, deriving the displayed/charged USDT from the `usd_idr_rate`
 * setting. This script multiplies every catalog amount by the given rate ONCE
 * and stores the rate, all in a single transaction:
 *   - Product.price and Product.resellerPrice            × rate (whole Rupiah)
 *   - Voucher.value for FIXED vouchers                   × rate
 *   - Voucher.minPurchase (money threshold, all types)   × rate
 *   - Setting usd_idr_rate = rate
 * BulkPricing is percent-based and historical orders/wallets are snapshots —
 * both stay untouched (plan.md §15.1).
 *
 * Usage (STOP the bot/server first; this must be the only writer):
 *   1. Back up data/bot.db (+ -wal/-shm).
 *   2. pnpm tsx scripts/convert-prices-to-idr.ts 16000
 *   3. Deploy the IDR-basis code and restart.
 * Refuses to run twice: an existing usd_idr_rate marks the DB as converted.
 * Rehearse on a copy of the DB first — see CUTOVER-IDR.md.
 */
import { Decimal } from "@app/core/money";
import { VoucherType } from "@app/core/enums";
import { initDb, prisma, getSetting, setSetting, USD_IDR_RATE_KEY } from "@app/db";

async function main(): Promise<void> {
  const rateArg = process.argv[2];
  const rate = new Decimal(rateArg ?? NaN);
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) {
    console.error("Usage: pnpm tsx scripts/convert-prices-to-idr.ts <rupiah-per-usdt>  (e.g. 16000)");
    process.exit(1);
  }

  await initDb();

  const existing = await getSetting(prisma, USD_IDR_RATE_KEY);
  if (existing) {
    console.error(
      `Refusing to run: usd_idr_rate is already set (${existing}) — this DB looks converted already.`,
    );
    process.exit(1);
  }

  const idr = (v: Decimal.Value) => new Decimal(v).times(rate).toDecimalPlaces(0);

  const summary = await prisma.$transaction(async (tx) => {
    const products = await tx.product.findMany();
    for (const p of products) {
      await tx.product.update({
        where: { id: p.id },
        data: {
          price: idr(p.price.toString()),
          resellerPrice: p.resellerPrice === null ? null : idr(p.resellerPrice.toString()),
        },
      });
    }

    const vouchers = await tx.voucher.findMany();
    let fixedVouchers = 0;
    for (const v of vouchers) {
      const isFixed = v.type === VoucherType.FIXED;
      if (isFixed) fixedVouchers++;
      await tx.voucher.update({
        where: { id: v.id },
        data: {
          value: isFixed ? idr(v.value.toString()) : v.value,
          minPurchase: idr(v.minPurchase.toString()),
        },
      });
    }

    await setSetting(tx, USD_IDR_RATE_KEY, rate.toString());
    return { products: products.length, vouchers: vouchers.length, fixedVouchers };
  });

  console.log(
    `Converted to central-IDR at rate ${rate.toString()}: ` +
      `${summary.products} products, ${summary.vouchers} vouchers ` +
      `(${summary.fixedVouchers} fixed-amount), usd_idr_rate saved.`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
