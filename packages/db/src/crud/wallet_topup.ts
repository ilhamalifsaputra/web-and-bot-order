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
 * commission, no delivery DM — just an atomic PENDING_PAYMENT → DELIVERED
 * claim (same idiom as `approveOrder`) followed by one `adjustWallet` credit.
 * Gateway-specific settlement functions (Task 3) call this after their own
 * `ProcessedXTx` idempotency claim succeeds; the `claim.count !== 1` no-op
 * branch here is defense-in-depth, not the primary idempotency gate.
 */
import { config } from "@app/core/config";
import { OrderCurrency, OrderKind, OrderStatus, PaymentMethod } from "@app/core/enums";
import { computeUniqueCents, generatePaymentRef } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { addMinutes } from "@app/core/datetime";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import type { Db } from "./_types";
import { getSetting } from "./settings";
import { parseMinAmount } from "./_minAmount";
import { getOrder, uniqueOrderCode, customerLabel } from "./orders";
import { adjustWallet } from "./users";
import { finalizeOrderPayment } from "./pricing";
import { enqueueOwnerWalletTopupEmail } from "./notifications";

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
 * plays no role in the credited amount.
 *
 * Duplicated rather than extracted out of `finalizeOrderPayment`: pulling the
 * ~30-line disambiguation block into a shared helper risked destabilizing
 * that function's behavior for live PRODUCT orders for the sake of avoiding
 * one block of duplication — not a trade worth making in payment-finalization
 * code (see this file's top doc-comment and the task brief).
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
  let cents = config.USE_UNIQUE_CENTS ? computeUniqueCents(order.id) : new Decimal(0);
  let totalAmount = usdt.plus(cents);

  let paymentRef: string | null = null;
  let expiresAt: Date | null = null;
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
    // one pending-amount pool per gateway).
    if (config.USE_UNIQUE_CENTS) {
      for (let attempt = 1; attempt <= 49; attempt++) {
        const clash = await db.order.findFirst({
          where: {
            id: { not: orderId },
            paymentMethod: method,
            status: OrderStatus.PENDING_PAYMENT,
            expiresAt: { gt: new Date() },
            totalAmount,
          },
        });
        if (!clash) break;
        cents = computeUniqueCents(order.id + attempt);
        totalAmount = usdt.plus(cents);
      }
    }
  } else if (method === PaymentMethod.NOWPAYMENTS) {
    expiresAt = addMinutes(new Date(), config.NOWPAYMENTS_PAYMENT_WINDOW_MINUTES);
  }

  await db.order.update({
    where: { id: orderId },
    data: {
      currency: OrderCurrency.USDT,
      fxRate: rate,
      paymentMethod: method,
      uniqueCents: cents,
      totalAmount,
      ...(paymentRef ? { paymentRef } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    },
  });
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
 * Settle a paid wallet-topup order: atomically claim PENDING_PAYMENT ->
 * DELIVERED (same idiom as `approveOrder`, orders.ts:1284), then credit the
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
 * If the order is no longer PENDING_PAYMENT when this runs (double-settlement
 * — e.g. a retried gateway callback), this is a no-op: returns the current
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
 * internally, so surfacing it here lets the three webhook-rail callers
 * (Task 7 — TokoPay/PayDisini/NOWPayments) build their
 * `enqueueWalletTopupCreditedDm` payload without a second wallet read. On the
 * no-op double-settlement path, `newBalance` reflects the buyer's CURRENT
 * balance (re-read fresh) rather than a stale/zero figure, even though
 * `credited` is 0 — callers should gate any notification on
 * `credited.greaterThan(0)`, not on `newBalance` alone.
 *
 * Also enqueues the shop OWNER's OWNER_EMAIL_WALLET_TOPUP notification
 * (`enqueueOwnerWalletTopupEmail`) right after the `adjustWallet` credit
 * lands — this is the ONE call site for that email, shared by all six
 * top-up-capable rails, so callers must never enqueue it themselves per-rail
 * (that would produce a duplicate email). Placed after the atomic claim, so
 * the no-op double-settlement early-return above never reaches it — the
 * claim is what guarantees the email is sent at most once per top-up. This
 * is distinct from `enqueueWalletTopupCreditedDm`, which the three webhook
 * rail callers enqueue separately for the BUYER over Telegram DM — different
 * recipient, different channel, never to be conflated.
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
  const claim = await db.order.updateMany({
    where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
    data: { status: OrderStatus.DELIVERED, paidAt: now, deliveredAt: now },
  });
  if (claim.count !== 1) {
    const current = await getOrder(db, orderId);
    const currentUser = await db.user.findUniqueOrThrow({ where: { id: current!.userId } });
    const currentBalance = new Decimal(
      current!.currency === OrderCurrency.USDT ? currentUser.walletBalanceUsdt : currentUser.walletBalance,
    );
    return { order: current!, credited: new Decimal(0), newBalance: currentBalance };
  }

  const reportedAmount = new Decimal(args.amount);
  if (!reportedAmount.equals(order.totalAmount)) {
    logger.warn(
      `Wallet top-up order ${order.orderCode} settled with a reported amount (${reportedAmount.toString()}) ` +
        `different from the order's own total (${new Decimal(order.totalAmount).toString()}) — crediting the order's ` +
        `total, which is the figure createWalletTopupOrder already validated, not the reported amount.`,
    );
  }

  const newBalance = await adjustWallet(db, order.userId, order.totalAmount, {
    reason: "wallet_topup",
    currency: order.currency as "IDR" | "USDT",
    orderId: order.id,
    adminId: null,
  });

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

  const refreshed = await getOrder(db, orderId);
  return { order: refreshed!, credited: new Decimal(order.totalAmount), newBalance };
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
