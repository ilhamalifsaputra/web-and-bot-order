/**
 * The money summary on the buyer's own order page (GET
 * /api/v1/account/orders/:code → OrderDetailPage.tsx's totals card).
 *
 * Split out of routes/apiAccount.ts as a plain function for the same reason
 * apps/web-admin/src/routes/orderMoneyView.ts exists: the arithmetic below is
 * the part worth unit-testing, and it should not need a database, a session and
 * an HTTP inject to pin down.
 *
 * WHY ANY ARITHMETIC AT ALL — the rows are stacked on top of each other:
 *
 *     Subtotal          Rp80.000
 *     Quantity deal    −Rp20.000
 *     Voucher          −Rp30.000
 *     Wallet credit    −Rp30.000
 *     ─────────────────────────
 *     Total                 Rp0
 *
 * so they have to reconcile exactly, or the page reads as an overcharge to the
 * customer who just paid it and becomes a support ticket. That is the same
 * standard `enqueueBuyerOrderReadyEmailIfGuest` (packages/db/src/crud/orders.ts)
 * holds the guest receipt to, and this is the same technique: convert/read ONE
 * anchor figure and derive the adjustments from it, instead of printing three
 * independently-stored columns and hoping they add up.
 *
 * Before this existed the page printed `subtotalAmount` / `bulkDiscountAmount` /
 * `discountAmount` verbatim beside `totalAmount` and dropped `walletUsed`
 * entirely, so every order paid even partly from the balance contradicted
 * itself by the whole credit — the worked example above (a wallet-paid order)
 * showed Rp30.000 of arithmetic above a Total of Rp0.
 *
 * WHAT IS DERIVED AND WHAT IS NOT. `walletUsed` and `uniqueCents` are printed
 * verbatim: both are stored exactly in the order's settlement currency, and the
 * wallet figure is a ledger movement the buyer can check against their own
 * balance history — misstating it to make a page add up would be strictly worse
 * than the arithmetic hole it closed. `subtotalAmount` and `bulkDiscountAmount`
 * are printed verbatim too: the subtotal is what the item lines above it sum to,
 * and the quantity deal is a rule with a percentage the buyer was shown.
 * The VOUCHER row is the derived one — for the same reason the guest receipt
 * derives its discount: it is an adjustment rather than a quantity, it already
 * hides when zero, and it is the cheapest row on the page to absorb whatever
 * the other figures cannot express.
 *
 * What it absorbs, concretely, is the sub-Rupiah residue of
 * `finalizeOrderPayment`'s IDR branch rounding the total to whole Rupiah while
 * subtotal/discounts/wallet stay at 4dp: a percentage bulk or voucher discount
 * on a whole-Rupiah price can land on 311.5, and `round(a - b)` is not
 * `a - round(b)`. The residue is under one Rupiah, so a derived voucher differs
 * from `discountAmount` by less than the smallest unit the page can print — but
 * it makes the printed identity exact rather than nearly exact, which is the
 * whole point of deriving anything.
 *
 * IDR ONLY, DELIBERATELY. A USDT order's `subtotalAmount`/`discountAmount` are
 * central-IDR while its `totalAmount`/`walletUsed` are USDT (see
 * `finalizeOrderPayment`), and this page formats every one of them as Rupiah.
 * That mismatch is the already-documented, deliberately-open "L-1 class" gap
 * (orders.ts's own receipt-derivation comment names it, and
 * apps/web-admin/src/routes/orderMoneyView.ts has the same one) — mixing the two
 * scales inside the derivation below would turn it into confident nonsense
 * instead of the honest passthrough it is today, so a non-IDR order keeps
 * exactly the central-IDR figures it has always been shown, unchanged.
 *
 * The ONE exception, and the reason it is an exception: `walletUsed` on a USDT
 * order is a USDT figure, and the page prints the wallet row with `formatIdr`.
 * So the open gap above — IDR figures shown at IDR scale on a page that also
 * shows a USDT total — was, for this row only, an IDR label on a USDT number:
 * a buyer who spent 30 USDT of credit was shown "−Rp30.000", off by the whole
 * exchange rate. It is suppressed for a non-IDR order rather than converted or
 * relabelled. Hiding a row the buyer can still check in their own balance
 * history is incomplete; printing a figure ~16.000× wrong is a support ticket
 * and a plausible refund dispute. Converting it here would mean deriving a
 * Rupiah wallet figure from a USDT column and printing it beside a USDT total —
 * the confident nonsense the paragraph above refuses. Showing it properly needs
 * the page to format per-currency, which is the L-1 gap itself and is not one
 * row's fix to make.
 */
import { Decimal } from "@app/core/money";
import { OrderCurrency } from "@app/core/enums";

/** The Order columns the summary needs — a narrow shape so this stays a plain
 * function rather than depending on the full include `getOrderByCodeFull`
 * returns. */
export interface BuyerOrderSummaryInput {
  currency: string;
  fxRate: Decimal.Value | null;
  subtotalAmount: Decimal.Value;
  bulkDiscountAmount: Decimal.Value;
  discountAmount: Decimal.Value;
  walletUsed: Decimal.Value;
  uniqueCents: Decimal.Value;
  totalAmount: Decimal.Value;
}

export interface BuyerOrderSummary {
  subtotal: Decimal;
  bulkDiscount: Decimal;
  /** The voucher row — derived for an IDR order (see the module comment). */
  discount: Decimal;
  /** Balance spent, in Rupiah. Zero for a non-IDR order, where the stored
   * figure is USDT and the page has no way to say so — see the module comment's
   * "ONE exception" paragraph. */
  walletCredit: Decimal;
}

const ZERO = new Decimal(0);

export function buyerOrderSummary(order: BuyerOrderSummaryInput): BuyerOrderSummary {
  const subtotal = new Decimal(order.subtotalAmount);
  const bulkDiscount = new Decimal(order.bulkDiscountAmount);
  // The unique-cents payment marker. Only ever nonzero on a USDT order (the IDR
  // branch of `finalizeOrderPayment` strips it), and needed here purely to get
  // back to the figure the discounts were computed against. It used to be
  // returned and sent to the client as `amount_marker` "so the identity holds
  // without a currency special case"; no client code ever read it, and it could
  // not have helped — the only orders where it is nonzero are exactly the
  // non-IDR ones this function does not derive for.
  const marker = new Decimal(order.uniqueCents);

  // A converted order's figures are on two different scales — left alone on
  // purpose, see the module comment's last two paragraphs.
  //
  // Gated on the CURRENCY alone. This used to also require `order.fxRate`,
  // which inverted the intent: the only writer of `currency = "USDT"` is
  // `finalizeOrderPayment`'s USDT branch, which stamps `fxRate` in the same
  // update, so the extra condition never changed the outcome — but had a
  // USDT-stamped order without a snapshot ever existed, the guard would have
  // sent precisely that order into the IDR derivation below and subtracted
  // Rupiah discounts from a USDT total. A currency the derivation does not
  // understand is reason enough not to derive.
  if (order.currency !== OrderCurrency.IDR) {
    return {
      subtotal,
      bulkDiscount,
      discount: new Decimal(order.discountAmount),
      walletCredit: ZERO,
    };
  }

  // What the buyer was actually asked for, with the matching marker taken back
  // off: the one figure that is exact by construction, because
  // `finalizeOrderPayment` built `totalAmount` from it.
  const walletCredit = new Decimal(order.walletUsed);
  const net = new Decimal(order.totalAmount).minus(marker);
  // Every reduction between the subtotal and that figure, at once — so a
  // reduction this page has no row for can never silently vanish (which is how
  // wallet credit went unprinted in the first place). `Decimal.max` is
  // defensive: the reductions can only exceed the subtotal if a stored column
  // disagrees with the total, and a negative discount row would be a worse way
  // to show that than a zero one.
  const reductions = Decimal.max(ZERO, subtotal.minus(net).minus(walletCredit));
  // Anything the quantity-deal row cannot account for lands on the voucher row.
  const discount = Decimal.max(ZERO, reductions.minus(bulkDiscount));
  return { subtotal, bulkDiscount, discount, walletCredit };
}
