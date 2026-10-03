/**
 * CRUD for the Binance Internal Transfer (UID-based) payment method.
 *
 * Idempotency on Postgres (READ COMMITTED, genuinely concurrent writers): the
 * `processed_binance_tx.binance_tx_id` UNIQUE constraint is the concurrency
 * gate — claiming a tx id is an atomic insert; a duplicate insert throws and is
 * treated as "already processed". A read-then-write on an existing ledger row
 * is NOT safe on its own (two writers both read the old value), so every
 * transition of an existing row is a conditional `updateMany` gated on the
 * outcome it expects, and a zero count means another writer got there first.
 *
 * A duplicate is not always terminal: an id stamped with an outcome from
 * AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES delivered nothing and must stay
 * re-claimable, so `deliverPaidInternalOrder` re-claims it with a
 * compare-and-swap — a read followed by an `updateMany` gated on the values
 * that read returned. Both halves stay single statements on purpose; see the
 * comment there for why wrapping them in an interactive transaction would add
 * nothing under Postgres READ COMMITTED: the gated write is what decides the
 * race either way. See that constant's own doc-comment below for why this
 * rail's reclaimable set is narrower than the QRIS rails'
 * (QRIS_RECLAIMABLE_OUTCOMES) — the two are NOT meant to be identical.
 */
import { config } from "@app/core/config";
import { OrderStatus, OrderCurrency, OrderKind, PaymentMethod, RefundStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import { PaymentLogEvent } from "@app/core/payments/logEvents";
import { ValidationError } from "@app/core/errors";
import { startOfDayUtc } from "@app/core/datetime";
import type { Prisma, ProcessedBinanceTx } from "@prisma/client";
import type { PrismaClient, Tx } from "../client";
import type { ServiceChannel } from "@app/core/services";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import {
  getOrder,
  createOrderDirect,
  approveOrder,
  settlePaidOrder,
  applyUsdtWalletToOrder,
  findUnderpaidReceived,
  ORDER_USER_SELECT,
  withoutDeliveredContent,
  type SettleResult,
} from "./orders";
import { transitionOrderStatus } from "./orderStatus";
import { adjustWallet } from "./users";
import { releaseVoucherUse } from "./vouchers";
import { postOrderWalletCreditPosting } from "./ledgerPostings";
import { getSetting, getDecryptedSetting, setSetting } from "./settings";
import { finalizeOrderPayment } from "./pricing";
import { parseMinAmount, BINANCE_INTERNAL_MIN_AMOUNT_KEY } from "./_minAmount";
import { enqueueAdminOverpaid } from "./notifications";
import { settleWalletTopup, isLateSettleableWalletTopup, flagWalletTopupOverpayment } from "./wallet_topup";
import { POLL_HEALTH_KEYS, getPollHealth, recordPollHealth, type PollHealth } from "./poll_health";
import { getPendingPaymentAttempt, confirmPaymentAttempt } from "./payments";
import { reclaimStaleMatchedClaim } from "./_staleClaim";

// ---------------------------------------------------------------------------
// Resolved config (web-admin Settings win; .env is the bootstrap/recovery
// fallback, plan.md §16). Read per-request/per-poll so an edit in /settings
// takes effect on the next cycle without a restart (like Bybit/TokoPay).
// ---------------------------------------------------------------------------

export const BINANCE_UID_KEY = "binance_receive_uid";
export const BINANCE_API_KEY_KEY = "binance_api_key";
export const BINANCE_API_SECRET_KEY = "binance_api_secret";
// On/off toggle (web admin). Default ON: only the literal "false" disables.
export const BINANCE_INTERNAL_ENABLED_KEY = "binance_internal_enabled";
// Declared in ./_minAmount (the leaf module that also parses it) so
// orderMinimums.ts can read all six rails' keys without importing this
// file — see that module's own comment for the import cycle that avoids.
export { BINANCE_INTERNAL_MIN_AMOUNT_KEY } from "./_minAmount";

export interface BinanceInternalConfig {
  /** True only when receiveUid + apiKey + apiSecret are all present. */
  enabled: boolean;
  receiveUid: string;
  apiKey: string;
  apiSecret: string;
  apiBase: string;
  /** Official Binance mirror hosts tried, in order, only after apiBase's own
   * retry budget is exhausted within one poll cycle. Empty = no fallback
   * (today's behavior). Env-only — never web-editable. */
  apiBaseFallbacks: string[];
  currency: string;
  pollIntervalSeconds: number;
  windowMinutes: number;
  minAmount: Decimal | null;
}

/** First non-empty (trimmed) value, else "". DB value wins over the env fallback. */
function pick(dbVal: string | null, envVal?: string): string {
  const a = (dbVal ?? "").trim();
  if (a) return a;
  return (envVal ?? "").trim();
}

/**
 * Resolve the Binance Internal Transfer config from Settings (with .env
 * fallback). `enabled` gates the poller, the watchdog, and the checkout
 * option. The API base, its fallback mirror list, currency, poll interval,
 * and payment window stay env-only (rarely change); only the receive UID and
 * the API key/secret are web-editable.
 */
export async function resolveBinanceInternalConfig(db: Db): Promise<BinanceInternalConfig> {
  const [uid, key, secret, flag, minAmountSetting] = await Promise.all([
    getSetting(db, BINANCE_UID_KEY),
    getDecryptedSetting(db, BINANCE_API_KEY_KEY),
    getDecryptedSetting(db, BINANCE_API_SECRET_KEY),
    getSetting(db, BINANCE_INTERNAL_ENABLED_KEY),
    getSetting(db, BINANCE_INTERNAL_MIN_AMOUNT_KEY),
  ]);
  const receiveUid = pick(uid, config.BINANCE_RECEIVE_UID);
  const apiKey = pick(key, config.BINANCE_API_KEY);
  const apiSecret = pick(secret, config.BINANCE_API_SECRET);
  return {
    // Default ON: an unset/empty flag means enabled; only the literal "false"
    // (trimmed, case-insensitive) disables the method without touching creds.
    enabled: Boolean(receiveUid && apiKey && apiSecret) && (flag ?? "").trim().toLowerCase() !== "false",
    receiveUid,
    apiKey,
    apiSecret,
    apiBase: config.BINANCE_API_BASE,
    apiBaseFallbacks: config.BINANCE_API_BASE_FALLBACKS.split(",").map((s) => s.trim()).filter(Boolean),
    currency: config.CURRENCY,
    pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
    windowMinutes: config.INTERNAL_PAYMENT_WINDOW_MINUTES,
    minAmount: parseMinAmount(minAmountSetting),
  };
}

/**
 * Create a direct order, then stamp it as a USDT/Binance-Internal payment:
 * the central-IDR total converts once at `rate` (rounded up to the next 0.01) + unique cents,
 * with a unique transfer note and the short auto-confirm window (plan.md §15.4).
 */
export async function createInternalOrder(
  db: Db,
  args: {
    user: { id: number; role: string };
    /** Bot or website — forwarded to createOrderDirect's service guard. */
    channel: ServiceChannel;
    productId: number;
    quantity: number;
    voucherCode?: string | null;
    /** Rupiah per 1 USDT (usd_idr_rate) — required for the USDT path. */
    rate: Decimal.Value;
    /** Optional USDT credit balance to spend on this order (clamped to total). */
    walletAmount?: Decimal.Value;
    /** Stringified JSON of the buyer's manual_with_info answers (validated by
     * the caller). Forwarded verbatim to createOrderDirect; null otherwise. */
    customerData?: string | null;
    /** Client-minted checkout attempt id (A1) — forwarded verbatim to
     * createOrderDirect via the `...baseArgs` spread below; see
     * {@link DuplicateCheckoutIntentError} in orders.ts for the collision
     * contract this enforces. */
    checkoutIntentId?: string | null;
  },
) {
  const { walletAmount, rate, ...baseArgs } = args;
  const created = await createOrderDirect(db, baseArgs);
  if (!created) return null;
  const finalized = await finalizeOrderPayment(db, created.id, {
    currency: OrderCurrency.USDT,
    rate,
    method: PaymentMethod.BINANCE_INTERNAL,
    // The credit this order is about to spend, so the rail-minimum guard inside
    // judges what the gateway will really be asked for rather than the total
    // before the credit (whole-branch review D6). Passed unclamped; the spend
    // itself is still `applyUsdtWalletToOrder`'s, two lines down.
    walletAmount,
  });
  // Spend the USDT credit balance against the finalized USDT total (no-op when
  // walletAmount is unset). Re-read so callers see the updated walletUsed/total.
  await applyUsdtWalletToOrder(db, created.id, walletAmount);
  return walletAmount != null ? getOrder(db, created.id) : finalized;
}

/**
 * Bybit BSC's on-chain tracking milestones — the statuses whose bubble a live
 * poller is still re-rendering on its own schedule.
 *
 * `onPaymentDetected` (bybitBscDeposit.ts) and the confirmation tracker
 * (bybitBscConfirmationTracker.ts) keep editing that one bubble as
 * confirmations arrive, so while an order sits here its anchor is not merely a
 * pointer the sweeper might act on later — it is the address of a screen
 * something is actively writing to. Every other status either still owns a
 * bubble the buyer can simply navigate away from (PENDING_PAYMENT) or is
 * settled and waiting for the sweeper.
 *
 * This list is NOT a blanket exemption from anchor clearing: it only matters
 * to callers that pass `keepOnChainTracked`, and exactly one does — see
 * {@link clearPaymentMessageAnchorsAt} for why the two callers need opposite
 * rules.
 */
const ONCHAIN_TRACKED_STATUSES = [
  OrderStatus.PAYMENT_DETECTED,
  OrderStatus.CONFIRMING,
  OrderStatus.CONFIRMED,
] as const;

/**
 * Drop every stale payment-message anchor pointing at one Telegram message.
 *
 * An anchor means "this message still shows THIS order's payment
 * instructions". A Telegram message can only show one thing at a time, so the
 * moment something else is rendered into it every anchor on it but the new
 * owner's is a lie — and acting on that lie is destructive: the bubble sweeper
 * would overwrite whatever the buyer is actually looking at, which in the worst
 * case is another order's unpaid deposit address and amount.
 *
 * Gated on the (chatId, messageId) PAIR, never on messageId alone: Telegram
 * message ids are per-chat counters, so a bare messageId match would clear a
 * completely unrelated buyer's anchor.
 *
 * `keepOnChainTracked` spares orders in {@link ONCHAIN_TRACKED_STATUSES}, and
 * it defaults to OFF because the two callers need opposite rules and only one
 * of them can afford the exemption:
 *
 * - The buyer navigated away and the bubble became a menu
 *   (`releasePaymentAnchorIfReused`, apps/order-bot/src/util/paymentAnchor.ts)
 *   — pass `keepOnChainTracked: true`. The tracker still conceptually owns
 *   that bubble and will re-render it on its next cycle, so the worst an
 *   over-kept anchor does there is overwrite a menu.
 * - Another order took the message over (`setOrderPaymentMessage` below) —
 *   leave it off. The message now shows a DIFFERENT order's payment
 *   instructions, so every older claim on it is false regardless of status,
 *   and honouring the exemption there re-creates a money bug: two orders
 *   anchored on one bubble, with the Bybit BSC confirmation tracker editing it
 *   every cycle straight over the second order's unpaid deposit address.
 *
 * `paymentMsgChatId`/`paymentMsgId` are unindexed, so this is a sequential scan
 * of `Order`, and the rows it updates stay row-locked until the surrounding
 * transaction commits — and
 * `setOrderPaymentMessage` runs it on every single checkout, not only when an
 * anchor is known to exist. That is accepted today because the table is small
 * and a comparable scan already runs every minute from
 * `listSettledOrdersAwaitingBubbleEdit` (same unindexed columns), so this adds
 * no new class of load. Revisit — index or narrow the scan — if `Order` grows
 * past a few hundred thousand rows, or if checkout rate makes this a hot path
 * (Postgres runs concurrent checkouts in parallel, so a slow scan now costs
 * CPU and I/O per checkout rather than queueing them). The render path is
 * separately protected: it only reaches here behind a session-level gate
 * (see util/paymentAnchor.ts) so a mere button tap never pays for a scan.
 */
export async function clearPaymentMessageAnchorsAt(
  db: Db,
  chatId: number | bigint,
  messageId: number,
  opts: { exceptOrderId?: number; keepOnChainTracked?: boolean } = {},
): Promise<void> {
  await db.order.updateMany({
    where: {
      paymentMsgChatId: BigInt(chatId),
      paymentMsgId: messageId,
      ...(opts.keepOnChainTracked ? { status: { notIn: [...ONCHAIN_TRACKED_STATUSES] } } : {}),
      ...(opts.exceptOrderId != null ? { id: { not: opts.exceptOrderId } } : {}),
    },
    data: { paymentMsgChatId: null, paymentMsgId: null },
  });
}

/**
 * Remember which message holds the payment instructions, so the poller can edit it.
 *
 * Every caller anchors `ctx.session.menuMsgId` — the chat's ONE menu bubble,
 * which the next checkout re-renders in place — so taking over a message is
 * also the moment any earlier order's claim on it becomes stale. Clearing that
 * claim here is what stops the sweeper from later flipping this bubble to
 * "payment received, order A" on top of order B's still-unpaid deposit address
 * and amount. Own anchor first, stale ones after: if the second statement ever
 * fails, the worst outcome is the old (already broken) double-anchor rather
 * than an order left with no anchor at all and a bubble that never flips.
 *
 * The clear runs WITHOUT `keepOnChainTracked` on purpose, and that costs
 * something real: if the overtaken order was a Bybit BSC deposit in
 * PAYMENT_DETECTED/CONFIRMING/CONFIRMED, dropping its anchor makes
 * `onPaymentDetected` (apps/order-bot/src/payments/bybitBscDeposit.ts) and the
 * confirmation tracker return early, so that buyer's live tracking screen
 * simply stops updating and no DM replaces it — they have to open My Orders to
 * see progress. That is a deliberate trade, not an oversight: the alternative
 * is leaving two orders anchored on one bubble, where the tracker's per-cycle
 * edit overwrites the new order's still-unpaid deposit address and amount and
 * the buyer pays to nowhere. A lost tracking screen is recoverable; a
 * destroyed deposit address is money. Nothing in the bot blocks two parallel
 * checkouts in one chat, so this is a reachable path, not a theoretical one —
 * handlers/checkout/timers.ts used to carry a map that looked like such a
 * guard but was never read; see its header.
 */
export async function setOrderPaymentMessage(db: Db, orderId: number, chatId: number | bigint, messageId: number) {
  await db.order.update({
    where: { id: orderId },
    data: { paymentMsgChatId: BigInt(chatId), paymentMsgId: messageId },
  });
  await clearPaymentMessageAnchorsAt(db, chatId, messageId, { exceptOrderId: orderId });
}

/** Clear the anchored payment-message pointer (idempotency gate for the success sweep). */
export async function clearOrderPaymentMessage(db: Db, orderId: number): Promise<void> {
  await db.order.update({ where: { id: orderId }, data: { paymentMsgChatId: null, paymentMsgId: null } });
}

/** The exact projection `flipSettledOrderBubble` (apps/order-bot/src/jobs/
 * index.ts) needs off an order, shared by both the batch sweep below and
 * `getSettledBubbleOrder`'s single-row lookup: `id`/`orderCode`/`kind`/
 * `status`/`paymentMsgChatId`/`paymentMsgId` plus the buyer's `language` —
 * exactly `AnchoredSettledOrder`'s shape there, no more. Just `language` on
 * `user` — `settledPaymentBubble` (apps/order-bot/src/util/delivery.ts)
 * interpolates no buyer balance into either branch (a WALLET_TOPUP bubble is
 * a neutral status line; the balance-quoting sentence lives exclusively in
 * the outbox's WALLET_TOPUP_CREDITED_DM), so `currency`/`totalAmount` and the
 * user's two wallet columns were dropped from this projection along with
 * `SettledBubbleOrder`'s own fields. `select` (not `include: { user: true }`)
 * for the same H-4 leak class as `listPendingInternalOrders`' own comment
 * above: an `include` here would pull `passwordHash`/`email` into memory for
 * no reason. */
const SETTLED_BUBBLE_ORDER_SELECT = {
  id: true,
  orderCode: true,
  kind: true,
  status: true,
  paymentMsgChatId: true,
  paymentMsgId: true,
  user: { select: { language: true } },
} satisfies Prisma.OrderSelect;

/** Settled (DELIVERED or manual-fulfilment PROCESSING) orders of ANY payment
 * method that still carry an un-edited payment-message anchor, oldest first —
 * the cross-method query the generic bubble-flip sweeper polls. Not locked to
 * one `paymentMethod` (it replaced an earlier, TokoPay/PayDisini-only query,
 * `listDeliveredOrdersAwaitingEdit`, removed in Task T2-F once the generic
 * sweeper covered every rail), and it also picks up PROCESSING:
 * manual-fulfilment orders stop there instead of reaching DELIVERED, but
 * their bubble still needs to flip.
 * `paymentMsgChatId`/`paymentMsgId` being non-null doubles as the
 * idempotency gate: the three crypto rails already null both out via
 * `clearOrderPaymentMessage` once they've flipped their own bubble, so this
 * query naturally skips anything already handled. It also does NOT catch
 * Bybit BSC's PAYMENT_DETECTED/CONFIRMING/CONFIRMED — those intermediate
 * statuses deliberately keep the anchor alive for on-chain tracking
 * (bybitBscDeposit.ts, bybitBscConfirmationTracker.ts) and must not be swept. */
export function listSettledOrdersAwaitingBubbleEdit(db: Db, limit?: number) {
  return db.order.findMany({
    where: {
      status: { in: [OrderStatus.DELIVERED, OrderStatus.PROCESSING] },
      paymentMsgChatId: { not: null },
      paymentMsgId: { not: null },
    },
    select: SETTLED_BUBBLE_ORDER_SELECT,
    orderBy: { createdAt: "asc" },
    ...(limit != null ? { take: limit } : {}),
  });
}

/** Single-row counterpart to `listSettledOrdersAwaitingBubbleEdit` above, for
 * the one caller that already knows the order id and just needs this order's
 * bubble-flip fields: `flushSettledOrderBubble` (apps/order-bot/src/jobs/
 * index.ts), the payment-bubble flush hook that runs once per settlement DM.
 * That hot path used to call `getOrder`, whose
 * `fullInclude` pulls in items, `stockItem` credentials, product and voucher
 * to extract six scalars and `user.language` — needlessly materialising the
 * buyer's credentials into memory on every settlement DM. This reuses the
 * exact same lean `select` for the reason explained on it above, just without
 * the status/anchor `where` filter: `flipSettledOrderBubble` itself already
 * turns a wrong status or a missing anchor into "not_settled"/"no_anchor", so
 * filtering here would only turn those into a silent "order not found"
 * instead. Returns `null` when the order doesn't exist, same as `getOrder`. */
export function getSettledBubbleOrder(db: Db, orderId: number) {
  return db.order.findUnique({
    where: { id: orderId },
    select: SETTLED_BUBBLE_ORDER_SELECT,
  });
}

/** PENDING, not-yet-expired internal-transfer orders the poller should match
 * against. Also the direct data source for web-admin's Payments page
 * "pending internal transfers" list (apps/web-admin/src/routes/api/
 * payments.ts spreads these straight into JSON) — `user` is therefore
 * projected through orders.ts's ORDER_USER_SELECT, never `include: { user:
 * true }`, so a raw passwordHash/email can't ship in that response
 * (backend audit finding H-4). */
export async function listPendingInternalOrders(db: Db, now: Date) {
  const orders = await db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.BINANCE_INTERNAL,
      paymentRef: { not: null },
      expiresAt: { gt: now },
    },
    include: { user: { select: ORDER_USER_SELECT } },
  });
  return orders.map(withoutDeliveredContent);
}

export type DeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "processing"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>> }
  | { status: "already_processed" }
  | { status: "stale" };

/**
 * Idempotently confirm + deliver a matched internal-transfer order.
 * Claims the Binance tx id (UNIQUE gate) then runs the normal approve/deliver
 * path. Returns "already_processed" if the tx was seen before, "stale" if the
 * order is no longer awaiting payment (delivered/expired elsewhere).
 */
export async function deliverPaidInternalOrder(
  db: PrismaClient,
  args: { orderId: number; binanceTxId: string; amount: Decimal.Value },
): Promise<DeliverResult> {
  // 1. Claim the tx id. A duplicate normally means another cycle already
  //    handled it — UNLESS the prior claim's outcome is in
  //    AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES (today just "delivery_failed"):
  //    that never actually delivered anything, so the tx id must stay
  //    re-claimable, or the buyer's payment is silently lost forever behind a
  //    stuck idempotency row (H-3, backend audit 2026-07-31). "unmatched" is
  //    deliberately NOT in that set — see its doc-comment below for why this
  //    rail's amount-only matching makes that different from the QRIS rails.
  //    The reclaim is a compare-and-swap, not a transaction: read the row,
  //    then gate a single `updateMany` on the exact values that read
  //    returned. `count === 1` therefore PROVES the row was still in that
  //    state at the instant of the write, so the captured prior values are
  //    trustworthy; `count === 0` means a racer got there first and
  //    already_processed is the right answer.
  //
  //    An interactive $transaction would add nothing here. Under Postgres
  //    READ COMMITTED (the default) a plain read takes no lock, so two racing
  //    reclaims, in a transaction or not, both read the same row and both pass
  //    the outcome check; only the gated write can tell them apart. It does:
  //    the second `updateMany` blocks on the first one's row lock, then
  //    re-checks its WHERE against the newly committed row, matches nothing,
  //    and returns count 0, a graceful already_processed rather than a thrown
  //    error. That matters on a path that races across processes (the poller
  //    reclaims while an admin clicks manual-match in web-admin). Keeping both
  //    halves as single statements also means no row lock is held across the
  //    gap between them (Task 15 re-review).
  //
  //    `reclaimedFrom` remembers exactly what the reclaim overwrote
  //    (outcome/orderId/amount) so step 2 can put it back if this turns out to
  //    be a stale match — unlike the three QRIS rails, one Binance transfer can
  //    be re-tried against ANY pending order by amount, so a reclaim that turns
  //    out stale here must not strand the row outside the manual-match queue
  //    (Task 15 review, Important #1).
  let reclaimedFrom: Pick<ProcessedBinanceTx, "outcome" | "orderId" | "amount"> | null = null;
  try {
    await db.processedBinanceTx.create({
      data: { binanceTxId: args.binanceTxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const prior = await db.processedBinanceTx.findUnique({ where: { binanceTxId: args.binanceTxId } });
    // Task B2: a "matched" row whose delivery crashed before finishing is
    // recoverable for its own order — see crud/_staleClaim.ts for exactly
    // when. `reclaimedFrom` then holds "matched", so a stale outcome in step 2
    // puts the row back exactly as it was.
    const recovered =
      prior != null &&
      (await reclaimStaleMatchedClaim(db, {
        rail: "Binance internal-transfer",
        txId: args.binanceTxId,
        prior,
        forOrderId: args.orderId,
        cas: (guard) =>
          db.processedBinanceTx.updateMany({
            where: { binanceTxId: args.binanceTxId, ...guard },
            data: { amount: new Decimal(args.amount), outcome: "matched", updatedAt: new Date() },
          }),
      }));
    if (recovered) {
      reclaimedFrom = { outcome: prior.outcome, orderId: prior.orderId, amount: prior.amount };
    } else if (!prior || !(AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES as readonly string[]).includes(prior.outcome)) {
      logger.info(
        {
          event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.BINANCE_INTERNAL,
          providerPaymentId: args.binanceTxId,
          status: "already_processed",
        },
        `Skipped settling Binance transaction ${args.binanceTxId} for order ${args.orderId} because it had already been processed — its ledger row is in a terminal outcome that may not be reclaimed, so nothing was delivered or credited twice`,
      );
      return { status: "already_processed" };
    } else {
      const reclaimed = await db.processedBinanceTx.updateMany({
        where: { binanceTxId: args.binanceTxId, outcome: prior.outcome, orderId: prior.orderId },
        data: { orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
      });
      if (reclaimed.count === 0) {
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.BINANCE_INTERNAL,
            providerPaymentId: args.binanceTxId,
            status: "already_processed",
          },
          `Skipped settling Binance transaction ${args.binanceTxId} for order ${args.orderId} because it had already been processed — another path won the race to reclaim its ledger row, so nothing was delivered or credited twice`,
        );
        return { status: "already_processed" };
      }
      reclaimedFrom = { outcome: prior.outcome, orderId: prior.orderId, amount: prior.amount };
    }
  }

  // 2. Deliver. On failure, flag the ledger row so we don't silently retry
  //    forever (e.g. paid but out of stock) and let the caller alert an admin.
  try {
    return await db.$transaction(async (tx: Tx) => {
      const order = await getOrder(tx, args.orderId);
      // A cancelled WALLET_TOPUP is still payable (isLateSettleableWalletTopup):
      // the transfer arrived after the window closed, and a top-up reserves
      // nothing that cancelling gave away. This poller only ever hands us a
      // PENDING_PAYMENT order, so in practice this covers the order being
      // auto-cancelled between the poller's read and this delivery. A
      // cancelled PRODUCT order is NOT payable — its stock went back to the
      // pool — so it keeps falling through to "stale".
      if (!order || (order.status !== OrderStatus.PENDING_PAYMENT && !isLateSettleableWalletTopup(order))) {
        // If step 1 re-claimed this row from a non-delivering outcome, undo
        // that claim — restore the outcome/orderId/amount it overwrote —
        // instead of leaving the row "matched" against an order that never
        // got delivered. Left as "matched", the transfer would become
        // permanently unreachable: "matched" is excluded from
        // AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES (so it can never be re-claimed
        // again), and
        // both manualMatchTx and dismissUnmatchedTx refuse anything whose
        // outcome isn't "unmatched" — an admin's own recovery tooling would
        // refuse the very row their alert points at. A fresh claim
        // (reclaimedFrom === null) has nothing to undo — that row simply
        // stays "matched" against this now-stale order, the same pre-existing
        // behavior as before Task 15 and out of scope here (see the "tx
        // already delivered is never re-claimed" test).
        if (reclaimedFrom) {
          await tx.processedBinanceTx.update({
            where: { binanceTxId: args.binanceTxId },
            data: { outcome: reclaimedFrom.outcome, orderId: reclaimedFrom.orderId, amount: reclaimedFrom.amount },
          });
          logger.warn(
            `Binance transfer ${args.binanceTxId} was amount-matched to order ${args.orderId}, but that order is no longer awaiting payment — the ledger row was returned to "${reclaimedFrom.outcome}" so it stays in the manual-match queue. This usually means the amount-matching heuristic picked the wrong order, or the order was delivered by another path first.`,
          );
        }
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.BINANCE_INTERNAL,
            providerPaymentId: args.binanceTxId,
            status: "stale",
          },
          `Did not settle Binance Binance transaction ${args.binanceTxId} because order ${args.orderId} is no longer payable — it was cancelled, already settled, or is not a internal-transfer order, so the ledger row is marked stale and a human decides what the payment was for`,
        );
        return { status: "stale" as const };
      }
      // Trustance Phase A Task A2b: look up this order's own PENDING Payment
      // ledger row (if any) BEFORE settling, so both branches below can
      // confirm it once delivery actually succeeds. May legitimately be null
      // — orders created before this ledger was wired up, or a rail change
      // that left no PENDING row — and that is never treated as an error.
      const pendingPayment = await getPendingPaymentAttempt(tx, args.orderId).catch((err) => {
        logger.warn({ err }, `Could not look up the Payment ledger row for order ${args.orderId} — this only keeps a benign miss from stopping the settlement; a genuine database error here still aborts this whole transaction, exactly as it would without this lookup`);
        return null;
      });
      if (order.kind === OrderKind.WALLET_TOPUP) {
        const { order: settled, credited } = await settleWalletTopup(tx, args.orderId, { amount: args.amount });
        // Overpayment: same flag + admin alert the product branch below raises,
        // without changing what was credited (see flagWalletTopupOverpayment).
        await flagWalletTopupOverpayment(tx, {
          order: settled,
          credited,
          paid: args.amount,
          expected: order.totalAmount,
          rail: "Binance Internal",
          markLedgerOverpaid: () =>
            tx.processedBinanceTx.update({ where: { binanceTxId: args.binanceTxId }, data: { outcome: "overpaid" } }),
        });
        if (pendingPayment) {
          // Best-effort: swallows the benign race where a concurrent
          // poller/webhook already confirmed this same Payment row
          // (ValidationError, count!==1) — expected and harmless. A genuine
          // database error here still aborts this whole transaction
          // regardless of this .catch, since Postgres poisons an
          // interactive transaction on any failed statement; this call
          // cannot rescue the settlement from that, it only prevents the
          // benign race from doing so.
          //
          // Financial Ledger M3: the confirmation also captures Binance's own
          // transfer id, which is what `Payment.providerTransactionId` is
          // reconciled against when a provider settlement report is matched.
          // No `fee`/`netAmount` are passed: nothing in this rail's poller
          // payload reports a cut Binance deducted, so both columns stay null —
          // Payment.fee's documented "not known" (prisma/schema.prisma), which
          // is deliberately NOT the same statement as a fee of zero.
          await confirmPaymentAttempt(tx, {
            paymentId: pendingPayment.id,
            providerTransactionId: args.binanceTxId,
          }).catch((err) =>
            logger.warn({ err }, `Could not confirm the Payment ledger row for order ${settled.orderCode} — that row is left stuck PENDING and needs manual reconciliation. Whether the settlement itself survived depends on which failure this was, and this line cannot tell them apart: the benign race this catch exists for (another poller or webhook confirmed the same row first) leaves the order settled, but a real database error — a unique violation on providerTransactionId, say — has already aborted this interactive transaction in Postgres, so the settlement rolls back with it. Check whether the order actually reached its settled status before treating this as harmless`),
          );
        }
        // settleWalletTopup (packages/db/src/crud/wallet_topup.ts) already
        // enqueued the buyer's WALLET_TOPUP_CREDITED_DM outbox row, one frame
        // deeper on the line above, behind its own atomic claim — that single
        // call site is shared by all six top-up-capable rails, this one
        // included, so nothing here may enqueue it again or DM the buyer
        // directly. `onDelivered` (apps/order-bot/src/payments/
        // binanceInternal.ts) no longer sends a DM for a WALLET_TOPUP order
        // either; it only nudges the outbox dispatcher and updates the
        // payment bubble.
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.BINANCE_INTERNAL,
            providerPaymentId: args.binanceTxId,
            status: "delivered",
          },
        `Settled internal-transfer wallet top-up order ${settled.orderCode} for Binance transaction ${args.binanceTxId} — the buyer's balance was credited and their notification queued`,
        );
        return { status: "delivered" as const, order: settled, credentials: [] };
      }
      await tx.order.update({
        where: { id: args.orderId },
        data: { binanceTxid: args.binanceTxId, paidAt: new Date() },
      });
      await transitionOrderStatus(tx, {
        orderId: args.orderId,
        from: OrderStatus.PENDING_PAYMENT,
        to: OrderStatus.PENDING_VERIFICATION,
        meta: `binanceTxId=${args.binanceTxId}`,
      });
      const result = await settlePaidOrder(tx, args.orderId, { adminId: 0 });
      if (pendingPayment) {
        // See the WALLET_TOPUP branch above for what this .catch actually
        // protects against, and for why no fee figures are captured here.
        await confirmPaymentAttempt(tx, {
          paymentId: pendingPayment.id,
          providerTransactionId: args.binanceTxId,
        }).catch((err) =>
          logger.warn({ err }, `Could not confirm the Payment ledger row for order ${result.order.orderCode} — that row is left stuck PENDING and needs manual reconciliation. Whether the settlement itself survived depends on which failure this was, and this line cannot tell them apart: the benign race this catch exists for (another poller or webhook confirmed the same row first) leaves the order settled, but a real database error — a unique violation on providerTransactionId, say — has already aborted this interactive transaction in Postgres, so the settlement rolls back with it. Check whether the order actually reached its settled status before treating this as harmless`),
        );
      }
      // Overpayment: the buyer sent more USDT than the order total. Still
      // deliver (handled above) but flag the ledger row and alert admins so
      // the excess can be refunded/credited manually — never auto-refunded.
      // Mirrors TokoPay/PayDisini/NOWPayments (M-13, backend audit
      // 2026-07-31): Binance Internal's match tolerance already lets an
      // overpaid transfer through to delivery, but until now it left no
      // ledger flag and no admin alert, so the excess had no operational
      // trail for a later refund request.
      const paidAmount = new Decimal(args.amount);
      const excess = paidAmount.minus(order.totalAmount);
      if (excess.greaterThan(0)) {
        await tx.processedBinanceTx.update({ where: { binanceTxId: args.binanceTxId }, data: { outcome: "overpaid" } });
        await enqueueAdminOverpaid(tx, {
          orderId: result.order.id,
          orderCode: result.order.orderCode,
          paid: paidAmount,
          expected: order.totalAmount,
          excess,
          currency: order.currency,
        });
        logger.warn(
          `Binance Internal order ${result.order.orderCode} was overpaid — got ${paidAmount.toString()}, expected ${order.totalAmount.toString()} (excess ${excess.toString()} ${order.currency}) — flagged for manual refund/credit, an admin alert was enqueued`,
        );
      }
      if (result.kind === "delivered") {
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.BINANCE_INTERNAL,
            providerPaymentId: args.binanceTxId,
            status: "delivered",
          },
        `Auto-delivered internal-transfer order ${result.order.orderCode} for Binance transaction ${args.binanceTxId}`,
        );
        return { status: "delivered" as const, order: result.order, credentials: result.credentials };
      }
      logger.info(
        {
          event: PaymentLogEvent.PAYMENT_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.BINANCE_INTERNAL,
          providerPaymentId: args.binanceTxId,
          status: "processing",
        },
      `Internal-transfer order ${result.order.orderCode} paid — queued for manual fulfilment (Binance transaction ${args.binanceTxId})`,
      );
      return { status: "processing" as const, order: result.order };
    }, { timeout: 15000 });
  } catch (e) {
    await db.processedBinanceTx
      .update({ where: { binanceTxId: args.binanceTxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    throw e;
  }
}

/**
 * Note matched but amount short: flag UNDERPAID for admin review (idempotent).
 *
 * The ledger claim, the order.update, and the status transition run as one
 * `$transaction` so a crash or thrown error between them can never leave a
 * torn state — e.g. a ledger row claiming the transfer was handled while the
 * order never actually moved to UNDERPAID (Task 18). The ledger claim itself
 * stays a single atomic `create` inside the transaction (not preceded by a
 * read): the unique constraint on `binanceTxId` IS the claim. Under Postgres
 * READ COMMITTED a "does a row exist?" read would let two racing claims both
 * see nothing; with a bare `create`, the loser waits for the winner to commit
 * and then fails with a unique violation, which is caught and turned into a
 * graceful `false`. Returning at that point leaves the transaction aborted,
 * so its commit becomes a rollback and nothing else is written (see
 * deliverPaidInternalOrder's comment above for the same unique-claim idea).
 */
export async function markUnderpaid(
  db: PrismaClient,
  args: { orderId: number; binanceTxId: string; amount: Decimal.Value },
): Promise<boolean> {
  return db.$transaction(async (tx: Tx) => {
    try {
      await tx.processedBinanceTx.create({
        data: { binanceTxId: args.binanceTxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "underpaid" },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
    await tx.order.update({
      where: { id: args.orderId },
      data: {
        binanceTxid: args.binanceTxId,
        adminNote: `[underpaid] received ${new Decimal(args.amount).toString()} via tx ${args.binanceTxId}`,
      },
    });
    await transitionOrderStatus(tx, {
      orderId: args.orderId,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.UNDERPAID,
      meta: `binanceTxId=${args.binanceTxId}`,
    });
    return true;
  }, { timeout: 15000 });
}

/** A transfer that matched no PENDING order — record once for manual review. */
export async function recordUnmatchedTx(db: Db, args: { binanceTxId: string; amount: Decimal.Value }): Promise<boolean> {
  try {
    await db.processedBinanceTx.create({
      data: { binanceTxId: args.binanceTxId, amount: new Decimal(args.amount), outcome: "unmatched" },
    });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

// ===========================================================================
// Ops panel (web-admin /payments) — ledger, UNDERPAID resolution, manual match,
// poller health. `processed_binance_tx` has no Prisma relation to `orders`
// (orderId is a bare FK-less column), so order rows are stitched in by id here.
// ===========================================================================

/** Known ledger outcomes, in the order the ops panel lists them. */
export const TX_OUTCOMES = [
  "matched",
  "overpaid",
  "underpaid",
  "unmatched",
  "delivery_failed",
  "credited_to_balance",
  "dismissed",
] as const;
export type TxOutcome = (typeof TX_OUTCOMES)[number];

/**
 * Two DIFFERENT reclaimable sets, not one — this asymmetry is deliberate,
 * not an oversight, and it must stay that way even though it is tempting to
 * "harmonize" them. Both name outcomes that never delivered anything, so the
 * trx/tx id they're stamped on is safe to hand to a later callback/poller
 * pass without risking a second delivery attempt racing a settlement that
 * already happened. Where they differ is whether "unmatched" belongs in that
 * safe set, and that difference tracks a real difference in how each group
 * of rails decides what a transfer was FOR:
 *
 * - TokoPay/PayDisini/NOWPayments (QRIS_RECLAIMABLE_OUTCOMES) get a trxId
 *   back from the gateway itself, scoped to one specific order
 *   (`reconcileOrder` asks the gateway about `order.orderCode` and gets that
 *   order's own trxId). "unmatched" on these rails can therefore only mean
 *   "this trxId's order was temporarily un-matchable when the webhook/poll
 *   first saw it" (wrong method/currency, a short payment later topped up)
 *   — the money was always meant for that one order, so re-claiming it later
 *   is recovering a real payment, never a guess (Task 15).
 *
 * - binance_internal.ts (deliverPaidInternalOrder), bybit_deposit.ts
 *   (deliverPaidBybitOrder), and bybit_bsc_deposit.ts
 *   (deliverPaidBybitBscOrder) — AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES — carry
 *   NO memo or gateway-supplied order reference at all: `matchByAmount`
 *   guesses which pending order a deposit belongs to purely from its total,
 *   which is exactly why "unmatched" exists as an outcome in the first
 *   place. On these rails "unmatched" means only "no PENDING order happened
 *   to share this deposit's amount at the moment it was scanned" — it
 *   carries no assertion the deposit was ever meant for whatever order it
 *   might later get matched to.
 *
 *   Leaving "unmatched" re-claimable here — as an earlier version of this
 *   branch did — opens a real money-loss path: `fetchRecentDeposits` looks
 *   back up to 3 days (Bybit) / 1 hour (Binance), and
 *   `processDeposits`/`processTransfers` never consult the ledger before
 *   calling `matchByAmount` on every fetched deposit, every cycle. So an old
 *   stray deposit sitting in the ledger as "unmatched" — the shop owner's
 *   own top-up, a late payment for an order that has since expired — stays
 *   free to auto-match and auto-deliver against a completely unrelated LATER
 *   order that merely happens to share its total, the moment one exists.
 *   Before any of these three rails had a reclaim at all, the *_tx_id UNIQUE
 *   constraint was exactly what stopped that outcome; the fix here is to
 *   restore that guard for "unmatched" specifically, while keeping the
 *   reclaim these rails legitimately need for "delivery_failed". See
 *   apps/order-bot/src/payments/amountMatching.ts's own M-14 comment for the
 *   identical reasoning from the matcher's side: a stray transfer, an
 *   owner's own top-up, or a late payment for an expired order must never
 *   auto-deliver — an "unmatched" row is exactly that category of deposit.
 *
 *   Consequence: a buyer who pays BEFORE their order exists lands in
 *   "unmatched" on these three rails and needs an admin to recover it. On
 *   Binance that path already exists — `manualMatchTx` / `dismissUnmatchedTx`
 *   below both already require outcome "unmatched", so nothing about their
 *   contract changes. Bybit and Bybit BSC have no manual-match action at
 *   all; that gap is real but pre-existing (see bybit_deposit.ts's and
 *   bybit_bsc_deposit.ts's own module comments) and is not this fix's scope.
 *
 * "delivery_failed" stays reclaimable on EVERY rail (both sets) for a
 * different reason than "unmatched": it never re-runs the amount-matching
 * guess or re-derives which order a payment was for — it only retries
 * delivery for the exact (order, amount) pairing a prior cycle already
 * committed to, so re-claiming it repeats a decision that was already
 * trusted once, not a fresh guess.
 *
 * Neither set includes "matched", "overpaid", or "stale" — those three are
 * terminal on every rail. "matched"/"overpaid" mean a delivery actually
 * ran, so re-claiming risks a second attempt racing a settlement that
 * already happened; "stale" is terminal for a different reason — no
 * delivery attempt ran, but the order is provably no longer claimable, so
 * there is nothing left to re-claim it against. Neither set is exactly the
 * complement of TX_OUTCOMES either: TX_OUTCOMES also lists "underpaid" and
 * "credited_to_balance", equally terminal/non-re-claimable but out of this
 * fix's scope (see the "underpaid" note below).
 *
 * "stale" is deliberately NOT a member of TX_OUTCOMES: it's a QRIS-only
 * label — tokopay.ts/paydisini.ts/nowpayments.ts each stamp their ledger row
 * "stale" (through `tx`, inside the $transaction) when the trxId's order is
 * no longer PENDING_PAYMENT, because on those rails a trxId binds 1:1 to one
 * order, so "stale" there just means that order already left
 * PENDING_PAYMENT. deliverPaidInternalOrder never stamps "stale": it matches
 * one transfer against ANY pending order by amount, so a stale outcome here
 * can follow a genuine re-claim — instead of a generic terminal label, the
 * stale branch restores the exact outcome/orderId/amount the re-claim
 * overwrote, keeping the row in the manual-match queue rather than
 * stranding it as an unreachable "matched" (Task 15 review, Important #1).
 * bybit_deposit.ts and bybit_bsc_deposit.ts (Task 16) carry the same
 * reclaimedFrom-and-revert logic for the same reason (a stale reclaim there
 * is even more dangerous than here: Bybit has no manualMatchTx/
 * dismissUnmatchedTx equivalent at all, so an unreverted stale reclaim would
 * strand the ledger row with no recovery path, automatic or manual).
 *
 * "underpaid" (written by markUnderpaid below) was considered for either set
 * and left out of both on purpose: nothing is delivered for it either, so by
 * this fix's own logic that trxId is blocked the same way — but it already
 * has its own admin recovery path (UNDERPAID order status → deliver-anyway
 * or refund-to-wallet) that doesn't depend on the trxId ever being
 * re-claimable, so it isn't the same money-loss shape this fix addresses.
 */
export const QRIS_RECLAIMABLE_OUTCOMES = ["unmatched", "delivery_failed"] as const;

/** See the shared doc-comment above QRIS_RECLAIMABLE_OUTCOMES for the full
 * reasoning — this is the narrower set for the three rails that match a
 * deposit to an order purely by amount (no memo, no gateway-scoped trxId):
 * binance_internal.ts, bybit_deposit.ts, bybit_bsc_deposit.ts.
 * "unmatched" is excluded on purpose. */
export const AMOUNT_MATCHED_RECLAIMABLE_OUTCOMES = ["delivery_failed"] as const;

type LinkedOrder = { id: number; orderCode: string; status: string; totalAmount: Decimal };

/** Ledger rows (newest first), each enriched with its linked order (if any). */
export async function listProcessedBinanceTx(
  db: Db,
  opts: { outcome?: string | null; limit?: number; offset?: number; q?: string | null } = {},
) {
  const where: Record<string, unknown> = {};
  if (opts.outcome) where.outcome = opts.outcome;
  if (opts.q && opts.q.trim()) where.binanceTxId = { contains: opts.q.trim(), mode: "insensitive" };
  const rows = await db.processedBinanceTx.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 50,
  });
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is number => id != null))];
  const orders = orderIds.length
    ? await db.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, orderCode: true, status: true, totalAmount: true },
      })
    : [];
  const byId = new Map(orders.map((o) => [o.id, o as LinkedOrder]));
  return rows.map((r) => ({ ...r, order: r.orderId != null ? byId.get(r.orderId) ?? null : null }));
}

export function countProcessedBinanceTx(db: Db, opts: { outcome?: string | null; q?: string | null } = {}) {
  const where: Record<string, unknown> = {};
  if (opts.outcome) where.outcome = opts.outcome;
  if (opts.q && opts.q.trim()) where.binanceTxId = { contains: opts.q.trim(), mode: "insensitive" };
  return db.processedBinanceTx.count({ where });
}

/**
 * Resolve UNDERPAID by delivering anyway (operator eats the shortfall).
 * Flips UNDERPAID → PENDING_VERIFICATION then runs the normal approve/deliver
 * path (allocates stock, enqueues the testimoni outbox row). Same shape as
 * deliverPaidInternalOrder so the caller can show credentials.
 */
export async function deliverUnderpaidOrder(
  db: PrismaClient,
  args: { orderId: number; adminId: number },
): Promise<{ order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }> {
  return db.$transaction(async (tx: Tx) => {
    const order = await getOrder(tx, args.orderId);
    if (!order) throw new ValidationError("error.order_not_found");
    if (order.status !== OrderStatus.UNDERPAID) {
      throw new ValidationError("error.order_not_underpaid");
    }
    await tx.order.update({
      where: { id: args.orderId },
      data: { paidAt: new Date() },
    });
    await transitionOrderStatus(tx, {
      orderId: args.orderId,
      from: OrderStatus.UNDERPAID,
      to: OrderStatus.PENDING_VERIFICATION,
      meta: `deliver_underpaid_anyway by admin_id=${args.adminId}`,
    });
    // NOTE: a manual-delivery SKU CAN reach UNDERPAID (markUnderpaid triggers
    // purely on received-amount vs order-total, independent of deliveryType)
    // — but this path deliberately stays on approveOrder, not settlePaidOrder.
    // For a manual SKU that means approveOrder's stock-allocation step throws
    // error.cannot_deliver_out_of_stock (no stock was ever reserved for it),
    // failing closed: the admin sees a clear error and can refund instead of
    // "delivering anyway." Accepted scope exclusion — see the per-SKU
    // delivery flows plan — not a silent gap.
    const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: args.adminId });
    logger.info(`Underpaid order ${delivered.orderCode} delivered anyway by admin ${args.adminId} — operator absorbed the shortfall`);
    return { order: delivered, credentials };
  });
}

/**
 * Resolve UNDERPAID by refunding what the buyer actually sent to their wallet
 * and marking the order REFUNDED. Rolls back voucher usage so reconciliation
 * stays clean. (UNDERPAID orders never reserved stock, so nothing to release.)
 *
 * The credit goes to the balance matching the ORDER's own currency, so a USDT
 * order returns USDT and a rupiah order returns rupiah — `adjustWallet`
 * silently defaults to IDR when no currency is passed, which would otherwise
 * pay a crypto buyer back in the wrong money entirely.
 *
 * Also writes a `Refund` record (Trustance Master Architecture Task 8b) so
 * this concrete, already-idempotency-protected payout path shows up in the
 * new Refund domain's history instead of being invisible to it. That Refund
 * row is created directly here with `status: COMPLETED` and `processedAt`
 * already stamped — NOT via `createRefund`/`transitionRefundStatus`
 * (packages/db/src/crud/refunds.ts) — because by the time this function
 * writes it, the wallet credit a few lines above has already happened
 * atomically in this same transaction. Running it through the general
 * PENDING->PROCESSING->COMPLETED workflow would fabricate intermediate
 * states ("awaiting review", "processing") that never actually occurred for
 * this specific path, and would double the audit trail: the route that
 * calls this function (apps/web-admin/src/routes/api/payments.ts) already
 * writes one `logAdminAction` "underpaid_refund" entry for the human-facing
 * audit log, so this Refund row is pure structured record-keeping, not a
 * second audit line.
 *
 * No `RefundItem` rows: an UNDERPAID order never reserved stock or resolved
 * any specific OrderItem, and the refunded amount is the shortfall the buyer
 * actually sent — a quantity with no relationship to any OrderItem's
 * subtotal. Attaching RefundItem rows here would misrepresent this as a
 * per-item partial refund, which it structurally isn't. A whole-order Refund
 * with no item children is the correct shape for this call site.
 *
 * The Refund row (and the wallet credit above it) are both gated on
 * `received.greaterThan(0)`: an UNDERPAID order with a zero received amount
 * (e.g. the shortfall ledger row itself recorded 0) must not leave a
 * misleading COMPLETED Refund of 0.00 in refund history implying a payout
 * that never happened — `refundId` is `null` in that case.
 */
export async function refundUnderpaidOrder(
  db: PrismaClient,
  args: { orderId: number; adminId: number },
): Promise<{ refunded: Decimal; refundId: number | null; currency: string; orderCode: string }> {
  const result = await db.$transaction((tx: Tx) => refundUnderpaidOrderTx(tx, args));
  logUnderpaidRefundCommitted(result, args.adminId);
  return result;
}

/**
 * {@link refundUnderpaidOrder}'s body, run inside the CALLER's transaction —
 * so the web admin's refund route can write its `logAdminAction` audit line
 * in the same transaction (backend audit Task C3): if the audit insert fails,
 * the wallet credit, Refund row and status change roll back with it, and a
 * refund can never happen without its audit line.
 */
export async function refundUnderpaidOrderTx(
  tx: Tx,
  args: { orderId: number; adminId: number },
): Promise<{ refunded: Decimal; refundId: number | null; currency: string; orderCode: string }> {
  const order = await getOrder(tx, args.orderId);
  if (!order) throw new ValidationError("error.order_not_found");
  if (order.status !== OrderStatus.UNDERPAID) {
    throw new ValidationError("error.order_not_underpaid");
  }
  const received = (await findUnderpaidReceived(tx, args.orderId)) ?? new Decimal(0);
  if (received.greaterThan(0)) {
    const { transactionId } = await adjustWallet(tx, order.userId, received, {
      reason: "underpaid_refund",
      currency: order.currency as "IDR" | "USDT",
      orderId: order.id,
      adminId: args.adminId,
    });
    // An UNDERPAID order never settled, so no ORDER_PAYMENT was posted for it
    // and there is no revenue to reverse: the on-chain transfer the buyer
    // really sent is being recognised here for the first time, as wallet
    // credit. `postOrderWalletCreditPosting` checks that rather than assuming
    // it, so this stays correct if a future path reaches it on a settled order.
    await postOrderWalletCreditPosting(tx, {
      walletTransactionId: transactionId,
      orderId: order.id,
      orderCode: order.orderCode,
      occurredAt: new Date(),
    });
  }
  if (order.voucherId) {
    // One guarded decrement; never below zero even when two releases race.
    await releaseVoucherUse(tx, order.voucherId);
  }
  await tx.order.update({
    where: { id: args.orderId },
    data: {
      adminNote: `${order.adminNote ?? ""}\n[refund] ${received.toString()} ${order.currency} to wallet by admin_id=${args.adminId}`,
    },
  });
  // Only write a Refund record when money actually moved (`received > 0`,
  // guarding the wallet credit above too) — an UNDERPAID order with a zero
  // received amount would otherwise leave a misleading COMPLETED Refund of
  // 0.00 in refund history, implying a payout that never happened.
  const refund = received.greaterThan(0)
    ? await tx.refund.create({
        data: {
          orderId: order.id,
          amount: received,
          currency: order.currency,
          reason: `Underpaid order refunded to buyer's wallet balance by admin_id=${args.adminId}.`,
          status: RefundStatus.COMPLETED,
          processedAt: new Date(),
        },
      })
    : null;
  await transitionOrderStatus(tx, {
    orderId: args.orderId,
    from: OrderStatus.UNDERPAID,
    to: OrderStatus.REFUNDED,
    meta: `refund ${received.toString()} by admin_id=${args.adminId}`,
  });
  // No log line here: this runs inside the caller's transaction, and a later
  // rollback (e.g. its audit insert failing) would leave a log claiming money
  // moved. Callers log via logUnderpaidRefundCommitted once committed.
  // `currency` travels back with the amount so the caller's audit line can
  // say which money was returned — a bare amount is ambiguous now that the
  // refund lands in the order's own currency rather than always IDR.
  return { refunded: received, refundId: refund?.id ?? null, currency: order.currency, orderCode: order.orderCode };
}

/** The ops log line for a refundUnderpaidOrderTx result — call it only AFTER
 * the surrounding transaction has committed. */
export function logUnderpaidRefundCommitted(
  result: { refunded: Decimal; currency: string; orderCode: string },
  adminId: number,
): void {
  logger.info(
    `Refunded underpaid order ${result.orderCode} (${result.refunded.toString()} ${result.currency}) to wallet by admin ${adminId}`,
  );
}

/**
 * Manually attach an UNMATCHED transfer to a PENDING internal-transfer order
 * (buyer forgot the note) and run the same deliver path. Updates the existing
 * ledger row (it was already claimed as "unmatched") rather than inserting,
 * so the binance_tx_id UNIQUE gate is never tripped.
 */
export async function manualMatchTx(
  db: PrismaClient,
  args: { binanceTxId: string; orderId: number; adminId: number },
): Promise<SettleResult> {
  return db.$transaction(async (tx: Tx) => {
    const ledger = await tx.processedBinanceTx.findUnique({ where: { binanceTxId: args.binanceTxId } });
    if (!ledger) throw new ValidationError("error.tx_not_found");
    if (ledger.outcome !== "unmatched") throw new ValidationError("error.tx_not_unmatched");

    const order = await getOrder(tx, args.orderId);
    if (!order) throw new ValidationError("error.order_not_found");
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new ValidationError("error.order_not_pending");
    }

    // Claim the row atomically: the outcome check above is only a read, and
    // under Postgres READ COMMITTED a second admin matching the same transfer
    // (to another order) or dismissing it reads "unmatched" too. Gating the
    // UPDATE on `outcome: "unmatched"` makes the loser's statement wait for the
    // winner's commit, re-check the row, and match zero rows — so one transfer
    // can never settle two orders.
    const claimed = await tx.processedBinanceTx.updateMany({
      where: { binanceTxId: args.binanceTxId, outcome: "unmatched" },
      data: { orderId: args.orderId, outcome: "matched" },
    });
    if (claimed.count === 0) throw new ValidationError("error.tx_not_unmatched");
    await tx.order.update({
      where: { id: args.orderId },
      data: {
        binanceTxid: args.binanceTxId,
        paidAt: new Date(),
      },
    });
    await transitionOrderStatus(tx, {
      orderId: args.orderId,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PENDING_VERIFICATION,
      meta: `manual_match binanceTxId=${args.binanceTxId} by admin_id=${args.adminId}`,
    });
    const result = await settlePaidOrder(tx, args.orderId, { adminId: args.adminId });
    logger.info(`Manually matched Binance transaction ${args.binanceTxId} to order ${result.order.orderCode} by admin ${args.adminId}`);
    return result;
  });
}

/** One Binance transfer's ledger row by its transfer id, or null when unknown. */
export function getProcessedBinanceTx(db: Db, binanceTxId: string) {
  return db.processedBinanceTx.findUnique({ where: { binanceTxId } });
}

/**
 * Acknowledge an UNMATCHED transfer that belongs to no order (e.g. a test
 * deposit, or money sent with no order behind it): flip its ledger row
 * unmatched → dismissed so it stops showing up as an open problem. The row is
 * kept (auditable, still listable under the "dismissed" filter); only rows that
 * are currently `unmatched` can be dismissed.
 */
export async function dismissUnmatchedTx(db: Db, binanceTxId: string): Promise<void> {
  const ledger = await db.processedBinanceTx.findUnique({ where: { binanceTxId } });
  if (!ledger) throw new ValidationError("error.tx_not_found");
  if (ledger.outcome !== "unmatched") throw new ValidationError("error.tx_not_unmatched");
  // Gated on the outcome for the same reason as manualMatchTx: a concurrent
  // match must not be overwritten by a dismiss that read "unmatched" first.
  const claimed = await db.processedBinanceTx.updateMany({
    where: { binanceTxId, outcome: "unmatched" },
    data: { outcome: "dismissed" },
  });
  if (claimed.count === 0) throw new ValidationError("error.tx_not_unmatched");
}

// ---- Poller heartbeat (written by the order-bot poller, read by the web) ----
// Delegates to the generic per-rail store (packages/db/src/crud/poll_health.ts,
// Task 10) — see that module for the JSON-parse / sticky-field /
// consecutive-failure rules this used to carry directly, including why a
// rate-limit hit neither increments nor resets `consecutiveFailures`.

/** Single settings key holding the poller's last-cycle heartbeat as JSON. */
export const BINANCE_POLL_HEALTH_KEY = POLL_HEALTH_KEYS.binance;

/** Alias of the generic `PollHealth` shape — byte-identical to the old
 * standalone interface, kept as a named type so existing imports resolve
 * unchanged. */
export type BinancePollHealth = PollHealth;

/** Read the poller heartbeat; all-null when the poller has never run. */
export function getBinancePollHealth(db: Db): Promise<BinancePollHealth> {
  return getPollHealth(db, "binance");
}

/** Record one poll cycle's heartbeat. Called by the poller each tick. */
export function recordBinancePollHealth(
  db: Db,
  args: {
    lastTxCount: number;
    backoffUntil?: number | null;
    consecutiveRateLimitHits?: number;
    rateLimited?: boolean;
    success: boolean;
    error?: string | null;
  },
): Promise<void> {
  return recordPollHealth(db, "binance", args);
}
