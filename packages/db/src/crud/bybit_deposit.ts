/**
 * CRUD for the Bybit USDT-BSC (BEP20) on-chain deposit payment method.
 *
 * Mirrors binance_internal.ts but simpler: BEP20 deposits carry NO memo, so an
 * incoming deposit is matched to a PENDING order purely by its unique total
 * amount (USE_UNIQUE_CENTS keeps every order distinct). There is therefore no
 * underpaid auto-path — a deposit whose amount matches no order is "unmatched"
 * and left for manual review.
 *
 * Idempotency on SQLite: the `processed_bybit_tx.bybit_tx_id` UNIQUE constraint
 * is the concurrency gate — claiming the on-chain txID is an atomic insert; a
 * duplicate insert throws and is treated as "already processed", so repeated
 * poll cycles never double-deliver.
 */
import { config } from "@app/core/config";
import { OrderStatus, OrderCurrency, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, createOrderDirect, approveOrder } from "./orders";
import { getSetting, setSetting } from "./settings";
import { finalizeOrderPayment } from "./pricing";

// ---------------------------------------------------------------------------
// Resolved config (web-admin Settings win; .env is the bootstrap/recovery
// fallback, plan.md §16). Read per-request/per-poll so an edit in /settings
// takes effect on the next cycle without a restart (like TokoPay).
// ---------------------------------------------------------------------------

export const BYBIT_ADDRESS_KEY = "bybit_deposit_address";
export const BYBIT_API_KEY_KEY = "bybit_api_key";
export const BYBIT_API_SECRET_KEY = "bybit_api_secret";

export interface BybitConfig {
  /** True only when address + apiKey + apiSecret are all present. */
  enabled: boolean;
  depositAddress: string;
  apiKey: string;
  apiSecret: string;
  apiBase: string;
  chain: string;
  windowMinutes: number;
}

/** First non-empty (trimmed) value, else "". DB value wins over the env fallback. */
function pick(dbVal: string | null, envVal?: string): string {
  const a = (dbVal ?? "").trim();
  if (a) return a;
  return (envVal ?? "").trim();
}

/**
 * Resolve the Bybit deposit config from Settings (with .env fallback). `enabled`
 * gates the poller, the watchdog, and the checkout option. The deposit chain,
 * API base, and payment window stay env-only (rarely change); only the address
 * and the API key/secret are web-editable.
 */
export async function resolveBybitConfig(db: Db): Promise<BybitConfig> {
  const [addr, key, secret] = await Promise.all([
    getSetting(db, BYBIT_ADDRESS_KEY),
    getSetting(db, BYBIT_API_KEY_KEY),
    getSetting(db, BYBIT_API_SECRET_KEY),
  ]);
  const depositAddress = pick(addr, config.BYBIT_DEPOSIT_ADDRESS);
  const apiKey = pick(key, config.BYBIT_API_KEY);
  const apiSecret = pick(secret, config.BYBIT_API_SECRET);
  return {
    enabled: Boolean(depositAddress && apiKey && apiSecret),
    depositAddress,
    apiKey,
    apiSecret,
    apiBase: config.BYBIT_API_BASE,
    chain: config.BYBIT_DEPOSIT_CHAIN,
    windowMinutes: config.BYBIT_PAYMENT_WINDOW_MINUTES,
  };
}

/**
 * Create a direct order, then stamp it as a USDT/Bybit deposit payment: the
 * central-IDR total converts once at `rate` (rounded 0.1) + unique cents, with
 * the Bybit auto-confirm payment window. No transfer note (BEP20 has none).
 */
export async function createBybitOrder(
  db: Db,
  args: {
    user: { id: number; role: string };
    productId: number;
    quantity: number;
    voucherCode?: string | null;
    /** Rupiah per 1 USDT (usd_idr_rate) — required for the USDT path. */
    rate: Decimal.Value;
  },
) {
  const created = await createOrderDirect(db, args);
  if (!created) return null;
  return finalizeOrderPayment(db, created.id, {
    currency: OrderCurrency.USDT,
    rate: args.rate,
    method: PaymentMethod.BYBIT,
  });
}

/** PENDING, not-yet-expired Bybit orders the deposit poller should match against. */
export function listPendingBybitOrders(db: Db, now: Date) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.BYBIT,
      expiresAt: { gt: now },
    },
    include: { user: true },
  });
}

export type BybitDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "already_processed" }
  | { status: "stale" };

/**
 * Idempotently confirm + deliver a matched Bybit deposit.
 * Claims the on-chain txID (UNIQUE gate) then runs the normal approve/deliver
 * path. Returns "already_processed" if the tx was seen before, "stale" if the
 * order is no longer awaiting payment (delivered/expired elsewhere).
 */
export async function deliverPaidBybitOrder(
  db: PrismaClient,
  args: { orderId: number; bybitTxId: string; amount: Decimal.Value },
): Promise<BybitDeliverResult> {
  // 1. Claim the tx id. A duplicate means another cycle already handled it.
  try {
    await db.processedBybitTx.create({
      data: { bybitTxId: args.bybitTxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { status: "already_processed" };
    throw e;
  }

  // 2. Deliver. On failure, flag the ledger row so we don't silently retry
  //    forever (e.g. paid but out of stock) and let the caller alert an admin.
  try {
    return await db.$transaction(async (tx: Tx) => {
      const order = await getOrder(tx, args.orderId);
      if (!order || order.status !== OrderStatus.PENDING_PAYMENT) {
        return { status: "stale" as const };
      }
      await tx.order.update({
        where: { id: args.orderId },
        data: { status: OrderStatus.PENDING_VERIFICATION, bybitTxid: args.bybitTxId, paidAt: new Date() },
      });
      const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: 0 });
      logger.info(`Auto-delivered Bybit order ${delivered.orderCode} (tx ${args.bybitTxId})`);
      return { status: "delivered" as const, order: delivered, credentials };
    });
  } catch (e) {
    await db.processedBybitTx
      .update({ where: { bybitTxId: args.bybitTxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    throw e;
  }
}

/** A deposit that matched no PENDING order — record once for manual review. */
export async function recordUnmatchedBybitTx(db: Db, args: { bybitTxId: string; amount: Decimal.Value }): Promise<boolean> {
  try {
    await db.processedBybitTx.create({
      data: { bybitTxId: args.bybitTxId, amount: new Decimal(args.amount), outcome: "unmatched" },
    });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

// ---- Poller heartbeat (written by the order-bot poller, read by the web) ----

/** Single settings key holding the Bybit poller's last-cycle heartbeat as JSON. */
export const BYBIT_POLL_HEALTH_KEY = "bybit_poll_health";

export interface BybitPollHealth {
  lastRun: string | null;
  lastTxCount: number | null;
  backoffUntil: string | null;
}

/** Read the Bybit poller heartbeat; all-null when it has never run. */
export async function getBybitPollHealth(db: Db): Promise<BybitPollHealth> {
  const raw = await getSetting(db, BYBIT_POLL_HEALTH_KEY);
  if (!raw) return { lastRun: null, lastTxCount: null, backoffUntil: null };
  try {
    const p = JSON.parse(raw) as Partial<BybitPollHealth>;
    return {
      lastRun: p.lastRun ?? null,
      lastTxCount: typeof p.lastTxCount === "number" ? p.lastTxCount : null,
      backoffUntil: p.backoffUntil ?? null,
    };
  } catch {
    return { lastRun: null, lastTxCount: null, backoffUntil: null };
  }
}

/** Record one Bybit poll cycle's heartbeat. Called by the poller each tick. */
export async function recordBybitPollHealth(
  db: Db,
  args: { lastTxCount: number; backoffUntil?: number | null },
): Promise<void> {
  await setSetting(
    db,
    BYBIT_POLL_HEALTH_KEY,
    JSON.stringify({
      lastRun: new Date().toISOString(),
      lastTxCount: args.lastTxCount,
      backoffUntil: args.backoffUntil ? new Date(args.backoffUntil).toISOString() : null,
    }),
  );
}
