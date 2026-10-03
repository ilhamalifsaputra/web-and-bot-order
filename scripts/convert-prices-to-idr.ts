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
 *   1. Back up the database (pg_dump).
 *   2. pnpm tsx scripts/convert-prices-to-idr.ts 16000
 *   3. Deploy the IDR-basis code and restart.
 * Refuses to run twice: an existing usd_idr_rate marks the DB as converted.
 * Rehearse on a copy of the DB first — see CUTOVER-IDR.md.
 */
import { Decimal } from "@app/core/money";
import { VoucherType } from "@app/core/enums";
import { validateUsdIdrRate } from "@app/core/fx";
import { parseMoneyInput } from "@app/core/moneyFormat";
import { initDb, prisma, getSetting, setUsdIdrRate, fxRateBounds, USD_IDR_RATE_KEY } from "@app/db";

async function main(): Promise<void> {
  // Read like any typed rupiah amount (money audit A1): "16.000" is sixteen
  // thousand, not sixteen. `new Decimal("16.000")` would have multiplied the
  // whole catalog by 16.
  const rate = parseMoneyInput(process.argv[2] ?? "", "IDR");
  if (rate === null) {
    console.error(
      "Usage: pnpm tsx scripts/convert-prices-to-idr.ts <rupiah-per-usdt>  (e.g. 16000 or 16.000). " +
        "The rate argument was missing or not a plain rupiah amount, so nothing was changed.",
    );
    process.exit(1);
  }

  await initDb();

  const rejection = validateUsdIdrRate(rate, null, await fxRateBounds(prisma));
  if (rejection) {
    const why =
      rejection.reason === "below_min"
        ? `it is below the fx_rate_min floor of ${rejection.min.toString()}`
        : rejection.reason === "above_max"
          ? `it is above the fx_rate_max ceiling of ${rejection.max.toString()}`
          : "it is not a positive number";
    console.error(`Refusing to run: the rate ${rate.toString()} is not plausible because ${why}. Nothing was changed.`);
    process.exit(1);
  }

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

    // The one sanctioned mutator: writes the rate with its freshness stamp.
    await setUsdIdrRate(tx, rate);
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
