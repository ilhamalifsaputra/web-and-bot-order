/**
 * Wallet top-up — buy wallet CREDIT itself through the existing payment
 * gateways, rather than paying for a product. Represented as a bare `Order`
 * row (`kind: WALLET_TOPUP`) with NO `OrderItem` rows, no cart, no stock, no
 * voucher: the "product" being bought is a delta on the buyer's own
 * `walletBalance`/`walletBalanceUsdt`.
 *
 * Composes the same primitives real product orders use — `finalizeOrderPayment`
 * for the IDR branch (unchanged, see its doc-comment) — but does NOT reuse
 * `finalizeOrderPayment`'s USDT branch. That branch treats `order.totalAmount`
 * as a central-IDR figure and converts it to USDT via `usdtFromIdr`, which is
 * exactly right for a product order (whose cart total IS in IDR) and exactly
 * wrong for a top-up (whose typed amount, e.g. "50", already IS the USDT
 * figure — converting it again would silently turn "top up 50 USDT" into
 * "top up ~0.003 USDT"). `finalizeWalletTopupPayment` below mirrors that
 * branch's unique-cents disambiguation / payment-window / paymentRef
 * mechanics (so the existing auto-confirm pollers keep working unmodified)
 * but sets `usdt = new Decimal(args.amount)` directly, no FX conversion.
 *
 * Settlement (`settleWalletTopup`) is deliberately simpler than
 * `settlePaidOrder`/`approveOrder`: no stock to allocate, no referral
 * commission, no delivery DM — just an atomic "still awaiting payment, or
 * cancelled when its window lapsed" → DELIVERED claim (the `approveOrder`
 * idiom, widened per `isLateSettleableWalletTopup`) followed by one
 * `adjustWallet` credit.
 * Gateway-specific settlement functions (Task 3) call this after their own
 * `ProcessedXTx` idempotency claim succeeds; the `claim.count !== 1` no-op
 * branch here is defense-in-depth, not the primary idempotency gate.
 */
import { config } from "@app/core/config";
import { OrderCurrency, OrderKind, OrderStatus, PaymentMethod, StockActorType } from "@app/core/enums";
import { computeUniqueCents, generatePaymentRef, idrFromUsdt, quantizeMoney, usdtFromIdr } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { addMinutes } from "@app/core/datetime";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { PaymentLogEvent } from "@app/core/payments/logEvents";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { getSetting } from "./settings";
import { parseMinAmount } from "./_minAmount";
import {
  assertOrderTotalClearsRailMinimum,
  railMinimumFailure,
  resolveRailMinimum,
  type RailMinimumFailure,
} from "./orderMinimums";
import { getOrder, uniqueOrderCode, customerLabel, cancelOrder, findUnderpaidReceived } from "./orders";
import { adjustWallet } from "./users";
import { postUnderpaidTopupCreditPosting, postWalletTopupPosting } from "./ledgerPostings";
import { finalizeOrderPayment, writeWithUniqueRailAmount, type UniqueAmountRail } from "./pricing";
import { enqueueAdminOverpaid, enqueueOwnerWalletTopupEmail, enqueueWalletTopupCreditedDm } from "./notifications";

const ZERO = new Decimal(0);

/** "Blank/absent/invalid means no cap" Settings keys for the wallet top-up
 * amount bounds — read by `resolveWalletTopupLimits`, written by web-admin's
 * Settings page (apps/web-admin/src/routes/api/settings.ts). */
export const WALLET_TOPUP_MIN_AMOUNT_IDR_KEY = "wallet_topup_min_amount_idr";
export const WALLET_TOPUP_MAX_AMOUNT_IDR_KEY = "wallet_topup_max_amount_idr";
export const WALLET_TOPUP_MIN_AMOUNT_USDT_KEY = "wallet_topup_min_amount_usdt";
export const WALLET_TOPUP_MAX_AMOUNT_USDT_KEY = "wallet_topup_max_amount_usdt";

export interface WalletTopupLimits {
  minIdr: Decimal | null;
  maxIdr: Decimal | null;
  minUsdt: Decimal | null;
  maxUsdt: Decimal | null;
}

/**
 * Read the four wallet-topup amount-bound Settings. Reuses `parseMinAmount`
 * (crud/_minAmount.ts) — despite its name it is already a generic "free-text
 * positive Decimal or null" parser (blank/non-numeric/non-positive all mean
 * "no cap"), the same convention every other free-text Settings amount in
 * this repo follows, so it applies to a max bound exactly as well as a min.
 */
export async function resolveWalletTopupLimits(db: Db): Promise<WalletTopupLimits> {
  const [minIdrRaw, maxIdrRaw, minUsdtRaw, maxUsdtRaw] = await Promise.all([
    getSetting(db, WALLET_TOPUP_MIN_AMOUNT_IDR_KEY),
    getSetting(db, WALLET_TOPUP_MAX_AMOUNT_IDR_KEY),
    getSetting(db, WALLET_TOPUP_MIN_AMOUNT_USDT_KEY),
    getSetting(db, WALLET_TOPUP_MAX_AMOUNT_USDT_KEY),
  ]);
  return {
    minIdr: parseMinAmount(minIdrRaw),
    maxIdr: parseMinAmount(maxIdrRaw),
    minUsdt: parseMinAmount(minUsdtRaw),
    maxUsdt: parseMinAmount(maxUsdtRaw),
  };
}

/** IDR top-ups go through `finalizeOrderPayment`'s unchanged IDR branch, so
 * only its two IDR-capable methods apply here. */
export type WalletTopupIdrMethod = typeof PaymentMethod.TOKOPAY | typeof PaymentMethod.PAYDISINI;
/** USDT top-ups go through `finalizeWalletTopupPayment` below — the same
 * four auto-confirm USDT rails `finalizeOrderPayment` supports, minus
 * BINANCE_PAY (manual, bot-only proof flow) and WALLET (nothing to top up
 * wallet credit WITH). */
export type WalletTopupUsdtMethod =
  | typeof PaymentMethod.NOWPAYMENTS
  | typeof PaymentMethod.BINANCE_INTERNAL
  | typeof PaymentMethod.BYBIT
  | typeof PaymentMethod.BYBIT_BSC;
export type WalletTopupMethod = WalletTopupIdrMethod | WalletTopupUsdtMethod;

const IDR_TOPUP_METHODS: ReadonlySet<string> = new Set<WalletTopupIdrMethod>([
  PaymentMethod.TOKOPAY,
  PaymentMethod.PAYDISINI,
]);
const USDT_TOPUP_METHODS: ReadonlySet<string> = new Set<WalletTopupUsdtMethod>([
  PaymentMethod.NOWPAYMENTS,
  PaymentMethod.BINANCE_INTERNAL,
  PaymentMethod.BYBIT,
  PaymentMethod.BYBIT_BSC,
]);

// ---------------------------------------------------------------------------
// Rail minimums for a top-up (whole-branch review F3)
// ---------------------------------------------------------------------------

/**
 * Which currency a top-up is denominated in, plus the exchange rate needed to
 * reason about it in Rupiah. The rate is REQUIRED for a USDT top-up and absent
 * for an IDR one, because the shop-wide floor (`min_order_amount_idr`) is a
 * Rupiah figure and a USDT amount can only be compared against it through a
 * rate. Modelled as a union rather than an optional field so a caller cannot
 * silently omit it and have a Rupiah floor quietly stop being enforced.
 */
export type WalletTopupRailQuery = { currency: "IDR" } | { currency: "USDT"; rate: Decimal.Value };

/**
 * The two figures {@link railMinimumFailure} judges a top-up of `amount` by.
 *
 * A product order and a top-up derive these in OPPOSITE directions, and that is
 * the whole subtlety of this helper. A product order's cart total is central
 * Rupiah and its USDT figure is derived from it (`usdtFromIdr`), so
 * `finalizeOrderPayment` hands the guard `idrAmount = baseIdr` and
 * `railAmount = usdtFromIdr(baseIdr, rate)`. A USDT top-up is the other way
 * round: what the buyer typed ("50") ALREADY IS the USDT figure — it is what
 * lands in their wallet and what the rail is asked to collect — so `railAmount`
 * is the typed amount itself and the Rupiah figure is the derived one,
 * `amount × rate`. Converting the typed amount to USDT (or comparing it against
 * a Rupiah floor unconverted) is the same class of mistake this module's top
 * doc-comment exists to prevent.
 *
 * The Rupiah equivalent is deliberately NOT quantized: it is a comparison
 * operand, never a figure that gets stored or shown, and rounding it would move
 * the floor by up to half a Rupiah in whichever direction the rate happened to
 * favour.
 *
 * An IDR top-up's two figures are the same number, quantized to whole Rupiah
 * exactly as `finalizeOrderPayment`'s IDR branch quantizes the total it is about
 * to save — so the guard judges the figure that will really be charged, and a
 * sub-Rupiah top-up meets the same `nothing_to_collect` backstop there as here.
 */
export function walletTopupRailAmounts(
  args: WalletTopupRailQuery & { amount: Decimal.Value },
): { idrAmount: Decimal; railAmount: Decimal } {
  const amount = new Decimal(args.amount);
  if (args.currency === "IDR") {
    const idr = quantizeMoney(amount, 0);
    return { idrAmount: idr, railAmount: idr };
  }
  const rate = new Decimal(args.rate);
  // Same refusal `createWalletTopupOrder` and `finalizeWalletTopupPayment`
  // already raise for an unusable rate — a top-up priced off a zero or
  // non-finite rate has no Rupiah equivalent to judge at all.
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) throw new ValidationError("error.generic");
  return { idrAmount: idrFromUsdt(amount, rate), railAmount: amount };
}

/** Why `method` cannot collect a top-up of `amount`, or null when it can. The
 * same `railMinimumFailure` the finalize-time guard throws from, so a rail a
 * top-up form offers is always a rail the top-up can be finalized on. */
export async function walletTopupRailMinimumFailure(
  db: Db,
  args: WalletTopupRailQuery & { amount: Decimal.Value; method: WalletTopupMethod },
): Promise<RailMinimumFailure | null> {
  return railMinimumFailure(db, {
    method: args.method,
    currency: args.currency === "IDR" ? OrderCurrency.IDR : OrderCurrency.USDT,
    ...walletTopupRailAmounts(args),
  });
}

/** Predicate form of {@link walletTopupRailMinimumFailure}, for the top-up
 * forms' rail lists. */
export async function walletTopupClearsRailMinimum(
  db: Db,
  args: WalletTopupRailQuery & { amount: Decimal.Value; method: WalletTopupMethod },
): Promise<boolean> {
  return (await walletTopupRailMinimumFailure(db, args)) === null;
}

/**
 * The smallest amount, **in the currency the buyer types**, that `method` will
 * accept — or null when that rail has no floor at all.
 *
 * This is the figure a top-up form can show and compare a typed amount against,
 * which is not always the figure the Settings row holds. A rail's own
 * `<rail>_min_amount` is already denominated in the rail's settlement currency,
 * which for a top-up is the currency being typed, so it passes through
 * untouched. The shop-wide fallback is Rupiah, so on a USDT top-up it has to be
 * divided by the rate — and rounded UP to the cent, because the guard compares
 * `amount × rate` against it and a floor rounded DOWN would be a figure the form
 * advertised and the guard then refused, which is the exact failure F4b exists
 * to close.
 */
export async function resolveWalletTopupRailFloor(
  db: Db,
  args: WalletTopupRailQuery & { method: WalletTopupMethod },
): Promise<Decimal | null> {
  const currency = args.currency === "IDR" ? OrderCurrency.IDR : OrderCurrency.USDT;
  const minimum = await resolveRailMinimum(db, { method: args.method, currency });
  if (!minimum) return null;
  if (minimum.currency === currency) return minimum.amount;
  // The only mixed case that exists: a USDT top-up judged by the shop-wide
  // Rupiah floor. (An IDR top-up is never judged by a USDT figure — both IDR
  // rails' own minimums are Rupiah and so is the fallback.)
  const rate = new Decimal((args as { rate: Decimal.Value }).rate);
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) throw new ValidationError("error.generic");
  return usdtFromIdr(minimum.amount, rate);
}

/**
 * The minimum a top-up form should advertise for `currency`: the smallest amount
 * that at least one of the `methods` offered will actually accept.
 *
 * `max(wallet_topup_min_amount_*, the LOWEST rail floor among the offered
 * rails)` — the two floors answer different questions and both are real, so the
 * binding one is whichever is higher. The rail side takes the LOWEST of the
 * offered rails rather than the highest because the rails are alternatives: an
 * amount one rail refuses is still payable through a cheaper-floored sibling,
 * and the form filters the refusing rail out of its picker instead (F3). Taking
 * the highest would tell a buyer to type more than they need.
 *
 * A rail with no floor of its own makes the rail side vacuous — there is an
 * offered rail with nothing to clear — so only `wallet_topup_min_amount_*`
 * binds. Likewise when `methods` is empty, which is what a shop with no
 * configured gateway for that currency looks like.
 *
 * Returns null when neither floor exists, i.e. "no minimum to advertise".
 */
export async function resolveWalletTopupEffectiveMin(
  db: Db,
  args: WalletTopupRailQuery & { methods: readonly WalletTopupMethod[] },
): Promise<Decimal | null> {
  const limits = await resolveWalletTopupLimits(db);
  const topupMin = args.currency === "IDR" ? limits.minIdr : limits.minUsdt;

  let railMin: Decimal | null = null;
  for (const method of args.methods) {
    const floor = await resolveWalletTopupRailFloor(db, { ...args, method });
    if (!floor) return topupMin; // an unfloored rail is offered — nothing to add
    railMin = railMin === null ? floor : Decimal.min(railMin, floor);
  }

  if (!railMin) return topupMin;
  if (!topupMin) return railMin;
  return Decimal.max(topupMin, railMin);
}

/**
 * Mirrors `finalizeOrderPayment`'s USDT branch (unique-cents disambiguation
 * per method, auto-confirm payment windows, Binance Internal `paymentRef`
 * generation, Bybit/Bybit BSC uniqueness retry loop against the SAME pending
 * pool the pollers read) so the existing auto-confirm pollers work against a
 * wallet-topup order exactly as they do against a product order. The one
 * deliberate difference — the whole reason this isn't just a call to
 * `finalizeOrderPayment` — is the amount itself: `usdt = new Decimal(args.amount)`
 * directly, never `usdtFromIdr`. `args.amount` is what the buyer actually
 * typed as their top-up amount and is ALREADY denominated in USDT; running it
 * through the IDR→USDT converter a second time would silently divide it by
 * the exchange rate (e.g. "top up 50 USDT" -> "top up ~0.003 USDT" at a
 * 16000 rate). `rate` is still stamped onto `fxRate` for record-keeping
 * (matching every other USDT order's snapshot convention) even though it
 * plays no role in the credited amount — with one exception added by F3: the
 * rail-minimum guard below needs it to express the typed USDT figure in the
 * Rupiah the shop-wide floor is denominated in.
 *
 * The rest of the branch is still duplicated from `finalizeOrderPayment`, with
 * one exception: the Bybit unique-amount search-and-write is shared through
 * `writeWithUniqueRailAmount` (./pricing.ts). Product orders and top-ups draw
 * from one pending-amount pool per rail, so they must take the same advisory
 * lock; two private copies of that loop could never serialize against each
 * other.
 */
async function finalizeWalletTopupPayment(
  db: Db,
  orderId: number,
  args: { method: WalletTopupUsdtMethod; rate: Decimal.Value; amount: Decimal.Value },
) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ValidationError("error.order_not_found");
  if (order.status !== OrderStatus.PENDING_PAYMENT) {
    throw new ValidationError("error.order_not_pending");
  }

  const rate = new Decimal(args.rate);
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) {
    throw new ValidationError("error.generic");
  }

  // THE fix for Global Constraint 2 — no usdtFromIdr here. args.amount is
  // already the USDT figure the buyer asked to top up.
  const usdt = new Decimal(args.amount);
  const method = args.method;

  // M11's rail-minimum guard, which this function never had (whole-branch review
  // F3). `finalizeOrderPayment`'s USDT branch has enforced it since M11, but a
  // USDT top-up does not go through that branch — so a top-up below a rail's own
  // `<rail>_min_amount`, or below the shop-wide Rupiah floor, was handed to the
  // gateway anyway and refused out of band, leaving the buyer on a payment
  // screen that could never succeed. The whole reason the guard exists, missed on
  // one of the two paths that reach a gateway.
  //
  // Placed here, immediately after the amount is known and BEFORE any
  // gateway-specific state is derived (unique cents, paymentRef, the payment
  // window, the Bybit collision-avoidance loop) and before the row is touched at
  // all — so a refused top-up is left exactly as `createWalletTopupOrder` made
  // it and rolls back with the caller's transaction. `usdt` excludes the unique
  // cents on purpose, exactly as the product path does: the cents are matching
  // noise added on top, so the amount the rail is really asked for is never less
  // than this figure.
  //
  // `purpose` is derived from the row rather than hardcoded, for D9's reason: a
  // caller that has to declare what it is finalizing eventually forgets, and
  // that is precisely how a top-up buyer ends up being told to add more items.
  // This function is only ever reached for a WALLET_TOPUP order today.
  await assertOrderTotalClearsRailMinimum(db, {
    method,
    currency: OrderCurrency.USDT,
    ...walletTopupRailAmounts({ currency: "USDT", rate, amount: usdt }),
    purpose: order.kind === OrderKind.WALLET_TOPUP ? "wallet_topup" : "order",
  });

  const cents = config.USE_UNIQUE_CENTS ? computeUniqueCents(order.id) : new Decimal(0);
  const totalAmount = usdt.plus(cents);

  let paymentRef: string | null = null;
  let expiresAt: Date | null = null;
  let needsUniqueAmount = false;
  if (method === PaymentMethod.BINANCE_INTERNAL) {
    paymentRef = generatePaymentRef();
    for (let i = 0; i < 5; i++) {
      const clash = await db.order.findUnique({ where: { paymentRef } });
      if (!clash) break;
      paymentRef = generatePaymentRef();
    }
    expiresAt = addMinutes(new Date(), config.INTERNAL_PAYMENT_WINDOW_MINUTES);
  } else if (method === PaymentMethod.BYBIT || method === PaymentMethod.BYBIT_BSC) {
    expiresAt = addMinutes(
      new Date(),
      method === PaymentMethod.BYBIT ? config.BYBIT_PAYMENT_WINDOW_MINUTES : config.BYBIT_BSC_PAYMENT_WINDOW_MINUTES,
    );
    // Same per-method collision-avoidance as finalizeOrderPayment's Bybit
    // branch: neither Bybit rail has a memo, so amount is the only
    // disambiguator, and the retry pool is scoped to `paymentMethod: method`
    // so BYBIT and BYBIT_BSC orders never collide with each other's pool —
    // including against a live PRODUCT order under the same method/amount,
    // since this query has no `kind` filter (intentional: both kinds share
    // one pending-amount pool per gateway). The search and the write go
    // through `writeWithUniqueRailAmount`, the same helper and the same
    // per-rail advisory lock product checkouts use, so a top-up and a product
    // order finalizing at once serialize instead of both taking one amount,
    // and a full cents space is refused instead of silently reused.
    needsUniqueAmount = config.USE_UNIQUE_CENTS;
  } else if (method === PaymentMethod.NOWPAYMENTS) {
    expiresAt = addMinutes(new Date(), config.NOWPAYMENTS_PAYMENT_WINDOW_MINUTES);
  }

  const finalData = (pick: { cents: Decimal; totalAmount: Decimal }) => ({
    currency: OrderCurrency.USDT,
    fxRate: rate,
    paymentMethod: method,
    uniqueCents: pick.cents,
    totalAmount: pick.totalAmount,
    ...(paymentRef ? { paymentRef } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  });
  if (needsUniqueAmount) {
    await writeWithUniqueRailAmount(
      db,
      { orderId, orderCode: order.orderCode, method: method as UniqueAmountRail, usdt },
      async (tx, pick) => {
        await tx.order.update({ where: { id: orderId }, data: finalData(pick) });
      },
    );
  } else {
    await db.order.update({ where: { id: orderId }, data: finalData({ cents, totalAmount }) });
  }
  logger.info(
    `Wallet top-up order ${order.orderCode} finalized as USDT (${usdt.toString()} via ${method}, no FX conversion applied).`,
  );
  return getOrder(db, orderId);
}

/**
 * Create a bare wallet-topup `Order` (no `OrderItem` rows) and finalize its
 * payment method. Re-validates the amount against `resolveWalletTopupLimits`
 * itself — never trusts a caller-echoed "already validated" flag, since this
 * is the sole source of truth for the bound check. Throws before creating
 * any row if the amount is out of bounds or the method isn't one of the six
 * top-up-capable rails for the given currency.
 */
export async function createWalletTopupOrder(
  db: Db,
  args: {
    userId: number;
    amount: Decimal.Value;
    currency: "IDR" | "USDT";
    method: WalletTopupMethod;
    /** Rupiah per 1 USDT — required for USDT methods, same contract as
     * finalizeOrderPayment's PaymentChoice.rate. Stamped onto the order for
     * record-keeping; plays no role in the credited USDT amount. */
    rate?: Decimal.Value;
  },
): Promise<NonNullable<Awaited<ReturnType<typeof getOrder>>>> {
  const amount = new Decimal(args.amount);
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    throw new ValidationError("error.generic");
  }

  const limits = await resolveWalletTopupLimits(db);
  const [min, max] = args.currency === "IDR" ? [limits.minIdr, limits.maxIdr] : [limits.minUsdt, limits.maxUsdt];
  if (min && amount.lessThan(min)) throw new ValidationError("error.wallet_topup_below_min");
  if (max && amount.greaterThan(max)) throw new ValidationError("error.wallet_topup_above_max");

  if (args.currency === "IDR") {
    if (!IDR_TOPUP_METHODS.has(args.method)) throw new ValidationError("error.wallet_topup_invalid_method");
  } else {
    if (!USDT_TOPUP_METHODS.has(args.method)) throw new ValidationError("error.wallet_topup_invalid_method");
    if (args.rate == null) throw new ValidationError("error.generic");
  }

  const orderCode = await uniqueOrderCode(db);
  const order = await db.order.create({
    data: {
      orderCode,
      userId: args.userId,
      kind: OrderKind.WALLET_TOPUP,
      subtotalAmount: amount,
      totalAmount: amount,
      discountAmount: ZERO,
      uniqueCents: ZERO,
      walletUsed: ZERO,
      status: OrderStatus.PENDING_PAYMENT,
      voucherId: null,
      // IDR top-ups get their payment window HERE, at creation, exactly the
      // way createOrderDirect/createOrderFromCart stamp one on a product
      // order — and deliberately NOT inside finalizeOrderPayment's IDR
      // branch, which product orders share and which must keep leaving their
      // creation-time window alone. Without a window the order's expiresAt
      // stayed null, and both QRIS reconcile pollers filter on
      // `expiresAt > now`, which null never satisfies — so no IDR top-up was
      // ever reconcilable and a missed storefront webhook meant a paid buyer
      // with nothing watching. USDT top-ups are left alone: each of their
      // four rails gets its own, shorter auto-confirm window from
      // finalizeWalletTopupPayment below.
      ...(args.currency === "IDR"
        ? { expiresAt: addMinutes(new Date(), config.PAYMENT_WINDOW_MINUTES) }
        : {}),
    },
  });

  if (args.currency === "IDR") {
    await finalizeOrderPayment(db, order.id, {
      currency: OrderCurrency.IDR,
      method: args.method as WalletTopupIdrMethod,
    });
  } else {
    await finalizeWalletTopupPayment(db, order.id, {
      method: args.method as WalletTopupUsdtMethod,
      rate: args.rate!,
      amount,
    });
  }

  const finalized = await getOrder(db, order.id);
  if (!finalized) throw new ValidationError("error.order_not_found");
  return finalized;
}

/**
 * Settle a paid wallet-topup order: atomically claim PENDING_PAYMENT (or
 * CANCELLED — see `isLateSettleableWalletTopup`) -> DELIVERED (same idiom as
 * `approveOrder`, orders.ts:1284), then credit the
 * buyer's wallet via `adjustWallet` — the only function allowed to mutate a
 * wallet balance — for `order.totalAmount` in `order.currency`. Must run
 * inside the caller's `$transaction` (same contract as `settlePaidOrder`) —
 * does not open its own transaction.
 *
 * `args.amount` (what the caller/gateway observed as received) is accepted
 * for parity with the gateway settlement functions calling this and for
 * observability, but is deliberately NOT what gets credited: the amount
 * credited is always `order.totalAmount`, the figure `createWalletTopupOrder`
 * already validated and fixed at order-creation time. Trusting a second,
 * caller-supplied "amount" for the credit itself would reopen exactly the
 * kind of caller-trust gap this task's brief calls out elsewhere. A
 * mismatch is logged, not silently ignored, so a gateway reporting a
 * different amount than the order expects is visible to ops.
 *
 * If the order is neither PENDING_PAYMENT nor CANCELLED when this runs
 * (double-settlement — e.g. a retried gateway callback landing on an already
 * DELIVERED top-up), this is a no-op: returns the current
 * order unchanged with `credited: 0`. This is defense-in-depth only; the real
 * idempotency gate is each gateway's own `ProcessedXTx` unique-claim (Task 3),
 * which runs before this function is ever called.
 *
 * Also defense-in-depth: refuses to run at all on a non-WALLET_TOPUP order.
 * Task 3's six gateway-settlement call sites are each expected to guard this
 * themselves (`if (order.kind === OrderKind.WALLET_TOPUP)`) before ever
 * calling this function, but this function has no way to know a future
 * caller got that right — and the failure mode if one doesn't is severe: a
 * PENDING_PAYMENT PRODUCT order would silently flip to DELIVERED, credit the
 * buyer's wallet for the product's price, and skip stock allocation/referral/
 * delivery entirely. Same reasoning as the double-settlement guard above,
 * just guarding "kind" instead of "status".
 *
 * Returns `newBalance` (the buyer's post-credit balance in `order.currency`)
 * alongside `order`/`credited` — `adjustWallet` already computes this value
 * internally, so surfacing it here lets this function build the buyer DM
 * payload below without a second wallet read. On the no-op double-settlement
 * path, `newBalance` reflects the buyer's CURRENT balance (re-read fresh)
 * rather than a stale/zero figure, and `credited` is reported as 0 — but
 * that path already returned above (see the double-settlement paragraph)
 * before the buyer-notification code below ever runs.
 *
 * Also enqueues two notifications right after the `adjustWallet` credit
 * lands, and both are the ONE call site for their event across all six
 * top-up-capable rails, so no rail-specific caller may enqueue either itself
 * (that would produce a duplicate):
 *
 *  - `enqueueOwnerWalletTopupEmail` — the shop OWNER's OWNER_EMAIL_WALLET_TOPUP
 *    email. Itself a no-op unless the owner has configured the feature; see
 *    its own doc-comment.
 *  - `enqueueWalletTopupCreditedDm` — the BUYER's WALLET_TOPUP_CREDITED_DM
 *    Telegram DM, gated on `credited.greaterThan(0)` (never notify the no-op
 *    double-settlement path) and on `order.user.telegramId != null` (a
 *    web-only buyer has no chat to DM). This used to be enqueued separately
 *    by the three webhook rails (TokoPay/PayDisini/NOWPayments) while the
 *    other three (Binance Internal/Bybit/Bybit BSC) DM'd the buyer directly
 *    from the bot process — two different code paths that both assumed they
 *    were the only producer, which is exactly what let a QRIS top-up
 *    double-notify. Consolidating both into this one place, behind the
 *    atomic claim above, makes "exactly one notification per rail" a
 *    structural guarantee instead of a per-call-site convention.
 *
 * Both are placed after the atomic claim succeeded and the credit landed, so
 * neither can ever fire on the no-op double-settlement branch above (that
 * branch returns early, before this line) — the claim is what guarantees
 * each is sent at most once per top-up. Different recipients, different
 * channels; never conflate the two.
 */
export async function settleWalletTopup(
  db: Db,
  orderId: number,
  args: { amount: Decimal.Value },
): Promise<{ order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credited: Decimal; newBalance: Decimal }> {
  const order = await getOrder(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");
  if (order.kind !== OrderKind.WALLET_TOPUP) {
    throw new ValidationError("error.order_not_wallet_topup");
  }

  const now = new Date();
  // CANCELLED is claimable alongside PENDING_PAYMENT (see
  // `isLateSettleableWalletTopup`): a top-up whose window lapsed was
  // auto-cancelled, but the buyer's money can still land afterwards, and a
  // top-up reserves nothing that cancelling gave away. Every other status —
  // DELIVERED above all — still fails the claim, so the double-settlement
  // no-op below is untouched.
  const wasCancelled = order.status === OrderStatus.CANCELLED;
  const claim = await db.order.updateMany({
    where: { id: orderId, status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED] } },
    data: { status: OrderStatus.DELIVERED, paidAt: now, deliveredAt: now },
  });
  if (claim.count !== 1) {
    const current = await getOrder(db, orderId);
    const currentUser = await db.user.findUniqueOrThrow({ where: { id: current!.userId } });
    const currentBalance = new Decimal(
      current!.currency === OrderCurrency.USDT ? currentUser.walletBalanceUsdt : currentUser.walletBalance,
    );
    logger.info(
      {
        event: PaymentLogEvent.WALLET_CREDIT_ALREADY_APPLIED,
        orderId,
        provider: order.paymentMethod,
        status: current!.status,
      },
      `Credited nothing for wallet top-up order ${order.orderCode} because its settlement claim was lost — another path settled this top-up first, so the buyer's balance was moved exactly once and this call is a no-op`,
    );
    return { order: current!, credited: new Decimal(0), newBalance: currentBalance };
  }

  if (wasCancelled) {
    logger.warn(
      `Wallet top-up order ${order.orderCode} was credited after its payment window had already closed — the order had ` +
        `been auto-cancelled as expired, and the buyer's payment reached the gateway afterwards. Crediting it is still ` +
        `correct: a top-up reserves no stock and no voucher, so nothing was given away when it was cancelled and the ` +
        `only alternative would be keeping money the buyer has already paid. The buyer was told the order was ` +
        `cancelled, so they will now receive a separate "balance credited" message. If this happens often, the ` +
        `payment window is too short for how long the payment gateways actually take to confirm.`,
    );
  }

  const reportedAmount = new Decimal(args.amount);
  if (!reportedAmount.equals(order.totalAmount)) {
    logger.warn(
      `Wallet top-up order ${order.orderCode} settled with a reported amount (${reportedAmount.toString()}) ` +
        `different from the order's own total (${new Decimal(order.totalAmount).toString()}) — crediting the order's ` +
        `total, which is the figure createWalletTopupOrder already validated, not the reported amount.`,
    );
  }

  const { balance: newBalance } = await adjustWallet(db, order.userId, order.totalAmount, {
    reason: "wallet_topup",
    currency: order.currency as "IDR" | "USDT",
    orderId: order.id,
    adminId: null,
  });

  // Recognise the top-up in the double-entry ledger: the gateway is holding the
  // buyer's cash, and the shop now owes them that much spendable credit. `now`
  // is the timestamp the claim above stamped as `paidAt`, so the posting's
  // `occurredAt` is when the money really arrived. Keyed `order:{id}:topup`, so
  // a rail that redelivers its webhook posts this once — the same at-least-once
  // reality the atomic claim above guards the credit itself against.
  await postWalletTopupPosting(db, order, now);

  // The one line that says a buyer's balance actually moved, for every rail.
  // Deliberately AFTER the write rather than around it: `adjustWallet` throws
  // on an overdraw or a duplicate ledger row, so reaching here is what proves
  // the money moved. No balance figure in the message — the amount and the new
  // balance are the buyer's business, and the log's job here is only to say
  // this top-up was the one that credited them.
  logger.info(
    {
      event: PaymentLogEvent.WALLET_CREDIT_APPLIED,
      orderId: order.id,
      provider: order.paymentMethod,
      status: "credited",
    },
    `Credited wallet top-up order ${order.orderCode} to the buyer's ${order.currency} balance`,
  );

  // Owner-notification email — the single call site for all six top-up rails
  // (see this function's own doc-comment). Placed after the atomic claim
  // succeeded and the credit landed, so it can never fire on the no-op
  // double-settlement branch above (that branch returns early, before this
  // line). enqueueOwnerWalletTopupEmail is itself a no-op unless the owner
  // has configured the master toggle, owner_email_on_wallet_topup, and a
  // valid owner_email — same inert-until-configured contract every other
  // OWNER_EMAIL_* event follows.
  await enqueueOwnerWalletTopupEmail(db, {
    orderId: order.id,
    orderCode: order.orderCode,
    customerLabel: customerLabel(order.user),
    amount: new Decimal(order.totalAmount),
    currency: order.currency,
    newBalance,
    paymentMethod: order.paymentMethod,
    transactionId: order.paymentRef ?? order.binanceTxid ?? order.bybitTxid ?? null,
    toppedUpAt: now,
  });

  // Buyer notification — the single call site for WALLET_TOPUP_CREDITED_DM
  // across all six top-up rails (see this function's own doc-comment).
  // Gated on `credited.greaterThan(0)` so the no-op double-settlement branch
  // above never reaches it, and on the buyer having a Telegram id at all —
  // mirrors the gating every one of the former per-rail call sites used.
  const credited = new Decimal(order.totalAmount);
  if (credited.greaterThan(0) && order.user.telegramId != null) {
    await enqueueWalletTopupCreditedDm(db, {
      orderId: order.id,
      orderCode: order.orderCode,
      chatId: Number(order.user.telegramId),
      amount: credited,
      currency: order.currency,
      newBalance,
    });
  }

  const refreshed = await getOrder(db, orderId);
  return { order: refreshed!, credited, newBalance };
}

/**
 * Make an overpaid wallet top-up visible, exactly the way every rail already
 * makes an overpaid PRODUCT order visible: stamp `outcome: "overpaid"` on the
 * rail's own processed-transaction row and enqueue one `ADMIN_OVERPAID` DM per
 * admin (via `notification_outbox` — the webhook rails run in the web process,
 * which never sends Telegram itself).
 *
 * Each rail's deliver function used to return from its `WALLET_TOPUP` branch
 * before reaching the overpayment check its product branch runs, and
 * `settleWalletTopup` credits `order.totalAmount` whatever arrived — so the
 * excess of an overpaid top-up was recorded nowhere: no ledger flag, no alert,
 * and therefore no Overpayment card on the admin order page, whose
 * `findOverpaidExcess` (crud/overpayments.ts) reads exactly that ledger outcome.
 * With the flag in place an admin can hand the excess back through
 * `creditOverpaymentToBalance` like any other overpayment; that function and its
 * ledger posting are order-kind agnostic.
 *
 * Deliberately does NOT change what was credited: crediting the excess
 * automatically is a business decision that has not been taken, so the buyer
 * still receives the order total and the excess waits for an admin.
 *
 * The rule is the product branch's own: any excess above zero over what the
 * rail BILLED (`qrisChargeAmount(total)` on TokoPay, the bare total elsewhere).
 * A payment the amount matcher accepted slightly BELOW the total is not an
 * overpayment.
 *
 * Runs inside the caller's delivery transaction, after `settleWalletTopup`, so
 * the credit, the flag and the alert commit or roll back together. It is a
 * no-op when that settlement credited nothing (another path won the top-up's
 * atomic claim first): the flag and alert belong to the call that actually
 * settled, so a second transaction reaching an already-credited top-up can
 * never alert a second time. A re-delivery of the SAME transaction never gets
 * this far — every rail's ledger claim answers it `already_processed`.
 *
 * Returns the excess it flagged, or null when nothing was flagged.
 */
export async function flagWalletTopupOverpayment(
  db: Db,
  args: {
    order: { id: number; orderCode: string; currency: string };
    /** What `settleWalletTopup` returned as `credited` for this call. */
    credited: Decimal;
    paid: Decimal.Value;
    /** What the rail billed the buyer for this order. */
    expected: Decimal.Value;
    /** The rail's display name, for the developer log line. */
    rail: string;
    /** Stamps `outcome: "overpaid"` on this rail's processed-transaction row. */
    markLedgerOverpaid: () => Promise<unknown>;
  },
): Promise<Decimal | null> {
  if (!args.credited.greaterThan(0)) return null;
  const paid = new Decimal(args.paid);
  const expected = new Decimal(args.expected);
  const excess = paid.minus(expected);
  if (!excess.greaterThan(0)) return null;

  await args.markLedgerOverpaid();
  await enqueueAdminOverpaid(db, {
    orderId: args.order.id,
    orderCode: args.order.orderCode,
    paid,
    expected,
    excess,
    currency: args.order.currency,
  });
  logger.warn(
    `${args.rail} wallet top-up order ${args.order.orderCode} was overpaid — got ${paid.toString()}, expected ${expected.toString()} (excess ${excess.toString()} ${args.order.currency}). The buyer's balance was credited the order total only; the ledger row is flagged overpaid and an admin alert was enqueued so the excess can be returned from the order page.`,
  );
  return excess;
}

/**
 * True for a wallet top-up whose order was already cancelled — in practice
 * always by `autoCancelExpiredOrders` once the payment window lapsed — but
 * whose money has now genuinely arrived at the gateway. Every rail's
 * "this order is no longer payable → stale" guard consults this so a late
 * payment is settled instead of silently pocketed.
 *
 * Safe for a top-up and ONLY for a top-up: a `WALLET_TOPUP` order reserves
 * nothing. No stock is held, no voucher is consumed, no referral is pending —
 * there is nothing that had to be given back when it was cancelled, and so
 * nothing that has to be taken back to settle it now. Crediting it is purely
 * "add the balance whose money we are already holding". A cancelled PRODUCT
 * order is the exact opposite: its stock was released back to the pool and may
 * already belong to someone else, so it must stay stale — reviving one is a
 * different and far bigger problem, deliberately out of scope here.
 *
 * The gateway invoice does not expire alongside our own `expiresAt` (none of
 * the QRIS rails are told about it — `createTransaction` sends only the
 * nominal), so paying after the window closed is an ordinary thing for a
 * buyer to do, not an edge case.
 */
export function isLateSettleableWalletTopup(order: { kind: string; status: string }): boolean {
  return order.kind === OrderKind.WALLET_TOPUP && order.status === OrderStatus.CANCELLED;
}

/**
 * True when the buyer already has a PENDING_PAYMENT top-up order for the same
 * rail created within the last `sinceMs` — the bot's double-tap/grammY-retry
 * guard (mirrors checkout.ts's own per-product refuseDuplicateCheckout query,
 * scoped to `kind: WALLET_TOPUP` instead of a productId so a pending PRODUCT
 * order under the same method never blocks a top-up, and vice versa). Kept
 * here rather than as an inline `prisma.order.findFirst` in the handler file
 * per this repo's "no raw SQL/ad-hoc Prisma in routes or handlers" rule.
 */
export async function hasPendingWalletTopupOrder(
  db: Db,
  args: { userId: number; method: WalletTopupMethod; sinceMs: number },
): Promise<boolean> {
  const dupe = await db.order.findFirst({
    where: {
      userId: args.userId,
      paymentMethod: args.method,
      kind: OrderKind.WALLET_TOPUP,
      status: OrderStatus.PENDING_PAYMENT,
      createdAt: { gt: new Date(Date.now() - args.sinceMs) },
    },
    select: { id: true },
  });
  return dupe !== null;
}

/**
 * Resolve an UNDERPAID wallet top-up by cancelling the order and manually
 * crediting the buyer the amount they ACTUALLY sent — the top-up counterpart
 * of the recovery actions a PRODUCT order already has (deliver-anyway /
 * `refundUnderpaidOrder` / plain cancel), none of which fit a top-up:
 *
 *  - Delivering anyway (`deliverUnderpaidOrder`) cannot even run: it routes
 *    through `approveOrder`, which refuses a WALLET_TOPUP outright. And the
 *    top-up equivalent it would have to route through instead,
 *    `settleWalletTopup`, always credits `order.totalAmount` — the FULL amount
 *    the buyer asked to top up — so it would give away the shortfall.
 *  - Refunding (`refundUnderpaidOrder`) marks the order REFUNDED, which claims
 *    a delivery was undone. A top-up delivered nothing; there is nothing to
 *    refund, only money sitting in a gateway that was always meant to become
 *    balance.
 *  - Cancelling alone strands the buyer's money: the order goes away and the
 *    amount they really sent is never credited to anyone.
 *
 * So: credit what arrived, then cancel. The credit is written with reason
 * `admin_adjust` — the SAME reason code the existing manual "credit balance"
 * admin primitive uses (web-admin's users route, the bot's /wallet command),
 * because that is exactly what this is: an admin moving a balance by hand.
 * Deliberately NOT `underpaid_refund` (this is not a refund) and NOT
 * `wallet_topup` (that reason means a top-up settled for its full requested
 * amount, and `settleWalletTopup` owns it — reusing it here would also collide
 * with the `wallet_transactions` UNIQUE (orderId, reason) constraint if the
 * top-up were later settled late).
 *
 * The double-entry posting is NOT the one those other two `admin_adjust` sites
 * raise, though: real money arrived on a rail here, so it books `Dr
 * provider_clearing / Cr wallet_liability` (`postUnderpaidTopupCreditPosting`)
 * rather than crediting the buyer out of the shop's own equity. The
 * `WalletTransaction` reason records WHO moved the balance; the ledger has to
 * record WHERE the money came from, and those are different questions.
 *
 * The credit is gated on `received > 0`, mirroring `refundUnderpaidOrder`: a
 * top-up flagged UNDERPAID with no ledger row recording an amount (every
 * automated rail writes one, so in practice an order an admin moved to
 * UNDERPAID by hand) is still cancelled, but writes no wallet movement — a
 * 0-amount ledger row would claim money moved when none did.
 *
 * Idempotency is the order's own status: the first call leaves the order
 * CANCELLED, so a second call fails the UNDERPAID precondition and cannot
 * credit the buyer twice. The `wallet_transactions` UNIQUE (orderId, reason)
 * constraint is the backstop underneath that.
 *
 * Opens its own `$transaction` (hence `PrismaClient`, not `Db`) so the credit
 * and the cancellation land together or not at all — the same shape as its
 * sibling `refundUnderpaidOrder` (crud/binance_internal.ts). The caller is
 * expected to write its own `logAdminAction` audit entry, exactly as the
 * existing UNDERPAID resolution routes do.
 */
export async function creditUnderpaidTopupAnyway(
  db: PrismaClient,
  args: { orderId: number; adminId: number },
): Promise<{ credited: Decimal; currency: string }> {
  return db.$transaction(async (tx: Tx) => {
    const order = await getOrder(tx, args.orderId);
    if (!order) throw new ValidationError("error.order_not_found");
    if (order.kind !== OrderKind.WALLET_TOPUP) {
      throw new ValidationError("error.order_not_wallet_topup");
    }
    if (order.status !== OrderStatus.UNDERPAID) {
      throw new ValidationError("error.order_not_underpaid");
    }

    const received = (await findUnderpaidReceived(tx, args.orderId)) ?? ZERO;
    const anythingReceived = received.greaterThan(0);
    if (anythingReceived) {
      const { transactionId } = await adjustWallet(tx, order.userId, received, {
        reason: "admin_adjust",
        currency: order.currency as "IDR" | "USDT",
        orderId: order.id,
        adminId: args.adminId,
        note: `Underpaid top-up order ${order.orderCode}: credited the amount actually received.`,
      });
      // Posted as gateway cash becoming wallet credit (`Dr provider_clearing /
      // Cr wallet_liability`), NOT as the equity-funded manual adjustment the
      // `admin_adjust` reason above might suggest: money really did arrive on a
      // rail here, an admin only decided what to do with it. Sharing a reason
      // code with the two hand-made adjustment call sites is not sharing their
      // economics — see `postUnderpaidTopupCreditPosting`'s doc comment for why
      // booking this against `adjustment.*` would understate the shop's
      // gateway assets by every shortfall it ever credits.
      await postUnderpaidTopupCreditPosting(tx, {
        walletTransactionId: transactionId,
        orderId: order.id,
        orderCode: order.orderCode,
        adminId: args.adminId,
        occurredAt: new Date(),
      });
    }
    await cancelOrder(tx, args.orderId, `underpaid_credited_anyway by admin_id=${args.adminId}`, {
      type: StockActorType.ADMIN,
      adminId: args.adminId,
    });

    if (anythingReceived) {
      logger.info(
        `Resolved underpaid wallet top-up order ${order.orderCode} by cancelling it and crediting the buyer ` +
          `${received.toString()} ${order.currency} as a manual adjustment by admin ${args.adminId} — the amount ` +
          `they actually sent, rather than the ${new Decimal(order.totalAmount).toString()} the order asked for. ` +
          `The shortfall is not credited because it never arrived.`,
      );
    } else {
      logger.warn(
        `Cancelled underpaid wallet top-up order ${order.orderCode} without crediting the buyer anything, because ` +
          `no payment rail recorded how much was actually received for it — admin ${args.adminId} resolved it ` +
          `manually. Every automated rail writes that ledger row, so this is most likely an order somebody moved ` +
          `to UNDERPAID by hand. If the buyer really did send money, it has to be credited to their balance by hand.`,
      );
    }
    // `currency` travels back with the amount because `credited` alone is
    // ambiguous once a top-up can be underpaid on either an IDR or a USDT
    // rail — the caller needs both to write an audit line (or a toast) that
    // says which money moved, and `credited === 0` is the caller's signal
    // that nothing was credited at all and the buyer needs manual attention.
    return { credited: received, currency: order.currency };
  });
}
