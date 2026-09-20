/**
 * Minimum order amount per payment rail (Finance Hardening M11 / audit P0-1).
 *
 * Two real failure modes this closes, both previously unguarded:
 *  - A Rupiah total small enough that the IDR→USDT conversion rounds it away
 *    entirely, so a crypto rail would be asked to collect nothing and the order
 *    could never be matched or paid. NOTE (M13 / P2-1): this case is no longer
 *    REACHABLE for a positive Rupiah total. `usdtFromIdr` used to round to the
 *    nearest 0.1 half-up, which turned Rp700 at a 16.000 rate into `0.0`; it
 *    now rounds UP to the next cent, so the same total is `0.05` and any
 *    positive amount is at least `0.01`. `railMinimumFailure`'s
 *    `nothing_to_collect` backstop stays — it still catches a zero or negative
 *    rail amount, which is a real state (a fully discounted order) — but it is
 *    no longer the rounding case it was written for.
 *  - A total below a gateway's OWN documented minimum, which the gateway then
 *    rejects out of band, leaving the buyer on a payment screen that can never
 *    succeed.
 *
 * Where the numbers come from — every one of them a real admin-set setting,
 * never a figure invented here:
 *  - The per-method override is each rail's EXISTING `<rail>_min_amount`
 *    setting (see `_minAmount.ts` for the keys). Those settings already
 *    existed, already have a web-admin field whose help text reads "Minimum
 *    order total customers can pay via <rail>", and were already read at
 *    checkout — but only ever to PRINT an informational note. M11 enforces
 *    them. Each is denominated in the currency its rail settles in: Rupiah for
 *    TokoPay/PayDisini, USDT for the four crypto rails.
 *  - The shop-wide fallback is the new `min_order_amount_idr` setting, in
 *    Rupiah, defaulting to {@link DEFAULT_MIN_ORDER_AMOUNT_IDR} when unset.
 *
 * The comparison is deliberately done in each minimum's OWN currency rather
 * than converting everything to one of them: the shop-wide minimum is a Rupiah
 * figure and an order's central-IDR total is a Rupiah figure, so comparing
 * those two needs no exchange rate and cannot be distorted by `usdtFromIdr`'s
 * rounding step at all.
 *
 * That reasoning survived M13's change to the rounding rule, but its worked
 * example did not, so here is the current one. Under the old 0.1-half-up step a
 * Rp100 minimum converted to `0.0` — no minimum whatsoever, the very bug this
 * module exists to prevent. Under the new 0.01-ceil step it converts to `0.01`,
 * which is not nothing but is not Rp100 either: at a 16.000 rate `0.01` USDT is
 * Rp160, so converting the FLOOR would silently make it 60% stricter than the
 * figure the admin typed, and at a different rate it would be something else
 * again. Either direction is a floor that does not mean what it says.
 * Comparing each figure in its own currency is what keeps the number an admin
 * entered the number that is enforced, whatever the rounding rule happens to
 * be.
 *
 * `PaymentMethod.WALLET` has no minimum of any kind and is never checked: a
 * wallet payment is an internal ledger movement, there is no rail with a floor
 * to clear, and its own sufficiency rule (`error.insufficient_wallet`) already
 * governs it.
 */
import { Decimal } from "@app/core/money";
import { OrderCurrency, PaymentMethod } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import type { Db } from "./_types";
import { getSetting } from "./settings";
import {
  parseMinAmount,
  TOKOPAY_MIN_AMOUNT_KEY,
  PAYDISINI_MIN_AMOUNT_KEY,
  NOWPAYMENTS_MIN_AMOUNT_KEY,
  BYBIT_MIN_AMOUNT_KEY,
  BYBIT_BSC_MIN_AMOUNT_KEY,
  BINANCE_INTERNAL_MIN_AMOUNT_KEY,
} from "./_minAmount";

/**
 * Settings key: the shop-wide minimum order total in Rupiah, applied to any
 * rail that has no `<rail>_min_amount` of its own. Free text in web-admin, so
 * it follows this repo's existing convention for such values
 * (`parseMinAmount`). The three cases are genuinely different, and only the
 * first one reaches the default:
 *  - ABSENT (no settings row at all, i.e. a shop that has never touched the
 *    field) means "use {@link DEFAULT_MIN_ORDER_AMOUNT_IDR}".
 *  - BLANK — a row holding `""`, which is what saving the web-admin field
 *    empty writes — means "no shop-wide minimum", exactly like an explicit
 *    "0". `parseMinAmount` returns null for both, and
 *    {@link getShopMinOrderAmountIdr} only substitutes the default for a
 *    MISSING row (`?? default`), never for a blank one.
 *  - NON-NUMERIC or non-positive likewise means "no shop-wide minimum",
 *    leaving only the per-rail overrides in force.
 */
export const MIN_ORDER_AMOUNT_IDR_KEY = "min_order_amount_idr";

/** Documented default for {@link MIN_ORDER_AMOUNT_IDR_KEY}: Rp1.000. */
export const DEFAULT_MIN_ORDER_AMOUNT_IDR = "1000";

/**
 * Which `<rail>_min_amount` setting overrides the shop-wide minimum for a given
 * `PaymentMethod`. `BINANCE_PAY` (manual proof upload, bot only) and `WALLET`
 * are absent on purpose: neither has such a setting in web-admin, and WALLET is
 * exempt from minimums entirely.
 */
export const PER_METHOD_MIN_AMOUNT_KEYS: Readonly<Record<string, string>> = {
  [PaymentMethod.TOKOPAY]: TOKOPAY_MIN_AMOUNT_KEY,
  [PaymentMethod.PAYDISINI]: PAYDISINI_MIN_AMOUNT_KEY,
  [PaymentMethod.NOWPAYMENTS]: NOWPAYMENTS_MIN_AMOUNT_KEY,
  [PaymentMethod.BYBIT]: BYBIT_MIN_AMOUNT_KEY,
  [PaymentMethod.BYBIT_BSC]: BYBIT_BSC_MIN_AMOUNT_KEY,
  [PaymentMethod.BINANCE_INTERNAL]: BINANCE_INTERNAL_MIN_AMOUNT_KEY,
};

export interface RailMinimum {
  /** The floor itself, in `currency`. */
  amount: Decimal;
  /** Which of the order's two figures this must be compared against. */
  currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT;
  /** `method` = the rail's own `<rail>_min_amount`; `shop` = the fallback. */
  source: "method" | "shop";
  /** The Settings key the figure came from, for logs and admin-facing copy. */
  settingKey: string;
}

/** The shop-wide Rupiah minimum, or null when an admin has explicitly cleared
 * it (see {@link MIN_ORDER_AMOUNT_IDR_KEY} for what "cleared" means). */
export async function getShopMinOrderAmountIdr(db: Db): Promise<Decimal | null> {
  const raw = await getSetting(db, MIN_ORDER_AMOUNT_IDR_KEY);
  // `?? default` (not `|| default`): an admin who typed "0" means "no
  // shop-wide minimum" and must not be silently given Rp1.000 back.
  return parseMinAmount(raw ?? DEFAULT_MIN_ORDER_AMOUNT_IDR);
}

/** Effective floor for one payment method, or null when it has none (WALLET,
 * or a rail with no override and a cleared shop-wide minimum). */
export async function resolveRailMinimum(
  db: Db,
  args: {
    /** Omitted/null resolves the same default `finalizeOrderPayment` applies:
     * TOKOPAY for an IDR order, BINANCE_INTERNAL for a USDT one. */
    method?: string | null;
    currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT;
  },
): Promise<RailMinimum | null> {
  const method =
    args.method ??
    (args.currency === OrderCurrency.IDR ? PaymentMethod.TOKOPAY : PaymentMethod.BINANCE_INTERNAL);
  if (method === PaymentMethod.WALLET) return null;

  const overrideKey = PER_METHOD_MIN_AMOUNT_KEYS[method];
  if (overrideKey) {
    const override = parseMinAmount(await getSetting(db, overrideKey));
    // A rail's own minimum is always denominated in the currency that rail
    // settles in, which is the currency of the order being finalized on it —
    // the two IDR rails only ever appear on an IDR order and the four crypto
    // rails only ever on a USDT one (enforced by PaymentChoice in pricing.ts).
    if (override) {
      return { amount: override, currency: args.currency, source: "method", settingKey: overrideKey };
    }
  }

  const shopIdr = await getShopMinOrderAmountIdr(db);
  if (!shopIdr) return null;
  return {
    amount: shopIdr,
    currency: OrderCurrency.IDR,
    source: "shop",
    settingKey: MIN_ORDER_AMOUNT_IDR_KEY,
  };
}

/** The two figures a would-be order total is judged by. On an IDR rail they are
 * the same number; on a USDT rail `railAmount` is the converted USDT total and
 * `idrAmount` the central-Rupiah total it was converted from. */
export interface RailAmounts {
  /** Central-IDR total, before unique cents. */
  idrAmount: Decimal.Value;
  /** Total in the rail's own settlement currency, before unique cents. */
  railAmount: Decimal.Value;
}

/**
 * Does this total clear the rail's floor? Shared by the enforcing guard in
 * `finalizeOrderPayment` and by the checkout payment-method lists, so a rail a
 * buyer is offered is always a rail their order can actually be finalized on.
 */
export async function orderTotalClearsRailMinimum(
  db: Db,
  args: {
    method?: string | null;
    currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT;
  } & RailAmounts,
): Promise<boolean> {
  return (await railMinimumFailure(db, args)) === null;
}

/** Why a total cannot be charged through a rail. `nothing_to_collect` carries
 * no figure on purpose — the floor it fails is "more than zero", which is not a
 * configured amount, and printing an invented one would misreport it. */
export type RailMinimumFailure =
  | { reason: "below_minimum"; minimum: RailMinimum }
  | { reason: "nothing_to_collect"; currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT };

/**
 * Why this total cannot be charged through the rail, or null when it can.
 * One implementation behind both the predicate above and the throwing guard
 * below, so the checkout list and the finalize-time rejection can never
 * disagree about which rails are usable.
 */
export async function railMinimumFailure(
  db: Db,
  args: {
    method?: string | null;
    currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT;
  } & RailAmounts,
): Promise<RailMinimumFailure | null> {
  const method =
    args.method ??
    (args.currency === OrderCurrency.IDR ? PaymentMethod.TOKOPAY : PaymentMethod.BINANCE_INTERNAL);
  if (method === PaymentMethod.WALLET) return null;

  const railAmount = new Decimal(args.railAmount);
  const minimum = await resolveRailMinimum(db, { method, currency: args.currency });
  if (minimum) {
    const actual = minimum.currency === OrderCurrency.IDR ? new Decimal(args.idrAmount) : railAmount;
    if (actual.lessThan(minimum.amount)) return { reason: "below_minimum", minimum };
  }

  // Backstop, independent of every setting: we will not ask a gateway to
  // collect nothing. This was written for the "Rp700 becomes 0.0 USDT" case — a
  // real Rupiah amount rounding away in the rail's own currency, leaving nothing
  // for the buyer to send or the amount-matching pollers to recognise. M13's
  // move to a 0.01 CEIL step closed that case off (any positive Rupiah total is
  // now at least 0.01 USDT), so what this now catches is a total that is
  // genuinely zero or negative — a fully discounted or fully wallet-covered
  // order that reached here instead of the zero-value short-circuit. Keep it:
  // the check costs nothing and the day the rounding rule changes again is not
  // the day to discover it was the only thing standing between a gateway and a
  // zero charge. Reachable only when an admin has cleared both the rail's own
  // minimum and the shop-wide one; with either in force the check above catches
  // it first, and with a more specific figure to report.
  if (!railAmount.greaterThan(0)) return { reason: "nothing_to_collect", currency: args.currency };

  return null;
}

/**
 * What the buyer is paying for, which decides only which sentence they are
 * shown — never which floor is enforced (whole-branch review D9).
 *
 * An IDR wallet top-up reaches this guard through `finalizeOrderPayment`'s IDR
 * branch, exactly like a product order, and used to inherit the product-order
 * copy with it: "That total is below the minimum... Add more items, or choose a
 * different payment method." There is no cart and there are no items to add, so
 * the one instruction the message gave was impossible to follow, on a screen
 * where the buyer had just typed a number they could simply have typed larger.
 *
 * The FLOOR is deliberately still shared. `min_order_amount_idr` is the
 * shop-wide "we will not ask a gateway to collect less than this" figure, which
 * is a property of the rail and the shop, not of what is being bought — and a
 * top-up already has its own separate bound in
 * `wallet_topup_min_amount_idr`, checked earlier by `createWalletTopupOrder`.
 * Splitting the rail floor as well would give a top-up two floors with nothing
 * to say about which of them an admin meant.
 */
export type RailMinimumPurpose = "order" | "wallet_topup";

/** The two sentences each purpose can produce: the configured-floor failure and
 * the zero-amount backstop. Kept as one table so a future purpose cannot be
 * added with half its copy missing — both locales carry every key here. */
const RAIL_MINIMUM_MESSAGE_KEYS: Readonly<
  Record<RailMinimumPurpose, { below_minimum: string; nothing_to_collect: string }>
> = {
  order: {
    below_minimum: "error.amount_below_rail_minimum",
    nothing_to_collect: "error.amount_too_small_for_rail",
  },
  wallet_topup: {
    below_minimum: "error.wallet_topup_below_rail_minimum",
    nothing_to_collect: "error.wallet_topup_nothing_to_collect",
  },
};

/**
 * Throw when `railAmount`/`idrAmount` is below the chosen rail's floor. Called
 * by `finalizeOrderPayment` BEFORE it writes anything, so a rejected order is
 * left exactly as its creator made it — no half-finalized row with a payment
 * method, expiry or reference pointing at a gateway that was never going to
 * accept it.
 *
 * `purpose` chooses the wording only (see {@link RailMinimumPurpose}); it
 * defaults to `"order"`, so every existing caller keeps the sentence it had.
 */
export async function assertOrderTotalClearsRailMinimum(
  db: Db,
  args: {
    method?: string | null;
    currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT;
    purpose?: RailMinimumPurpose;
  } & RailAmounts,
): Promise<void> {
  const failure = await railMinimumFailure(db, args);
  if (!failure) return;
  const keys = RAIL_MINIMUM_MESSAGE_KEYS[args.purpose ?? "order"];
  if (failure.reason === "nothing_to_collect") {
    throw new ValidationError(keys.nothing_to_collect, { currency: failure.currency });
  }
  // The top-up wording carries no {min}/{currency} placeholders — the
  // storefront surfaces a ValidationError as its key alone (its API client
  // throws `new Error(body.error)`, dropping `formatArgs`), so a top-up buyer
  // there would read the braces verbatim. `formatArgs` is populated for both
  // purposes regardless: the bot substitutes what its template asks for, and
  // tests and callers can still see the figure that failed.
  throw new ValidationError(keys.below_minimum, {
    min: failure.minimum.amount.toString(),
    currency: failure.minimum.currency,
  });
}
