/**
 * Central-IDR price model (plan.md §15): Product.price holds Rupiah — the one
 * source of truth — and the USDT figure is DERIVED from the admin-set
 * `usd_idr_rate` setting, rounded to the nearest 0.1. The transaction currency
 * is chosen at PAY time (USDT → Binance, IDR → TokoPay) and snapshotted on the
 * order together with the fx rate, so later rate edits never rewrite history.
 */
import { config } from "@app/core/config";
import { fetchUsdIdrMarketRate, roundRateToStep } from "@app/core/fx";
import { OrderCurrency, PaymentMethod, OrderStatus } from "@app/core/enums";
import {
  usdtFromIdr,
  quantizeMoney,
  computeUniqueCents,
  generatePaymentRef,
} from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { addMinutes } from "@app/core/datetime";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import type { Db } from "./_types";
import { getSetting, setSetting } from "./settings";
import { getOrder } from "./orders";

/** Settings key: Rupiah per 1 USDT (e.g. "16000"), set in web-admin. */
export const USD_IDR_RATE_KEY = "usd_idr_rate";
/** "false" turns the market auto-update off (unset/anything else = ON). */
export const USD_IDR_RATE_AUTO_KEY = "usd_idr_rate_auto";
/** Rounding step in Rupiah applied to the fetched market rate. */
export const USD_IDR_RATE_ROUNDING_KEY = "usd_idr_rate_rounding";
export const DEFAULT_RATE_ROUNDING = "100";

// Swappable market-rate fetcher so tests never hit the network.
let fxFetcher: () => Promise<Decimal> = () => fetchUsdIdrMarketRate();
/** Test hook: stub the market-rate fetch. */
export function setFxRateFetcher(fn: () => Promise<Decimal>): void {
  fxFetcher = fn;
}

export type FxRefreshResult =
  | { status: "updated"; rate: Decimal; market: Decimal; previous: Decimal | null }
  | { status: "unchanged"; rate: Decimal; market: Decimal }
  | { status: "disabled" };

/**
 * Pull the live USD→IDR market rate, round it to the configured step (default
 * Rp100), and save it as `usd_idr_rate`. The user-facing rule (plan.md §15.8
 * resolved): the rate FOLLOWS the real market, with rounding on top. Auto is
 * ON unless `usd_idr_rate_auto` is "false"; `force` (the admin's "update now"
 * button) bypasses that switch. Fetch failures throw — callers log/flash and
 * the previously saved rate stays in effect (orders snapshot their own fxRate).
 */
export async function refreshUsdIdrRate(db: Db, opts: { force?: boolean } = {}): Promise<FxRefreshResult> {
  if (!opts.force) {
    const auto = await getSetting(db, USD_IDR_RATE_AUTO_KEY);
    if (auto === "false") return { status: "disabled" };
  }
  const step = (await getSetting(db, USD_IDR_RATE_ROUNDING_KEY)) ?? DEFAULT_RATE_ROUNDING;
  const market = await fxFetcher();
  const rate = roundRateToStep(market, step);
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) {
    throw new ValidationError("error.generic");
  }
  const previousRaw = await getSetting(db, USD_IDR_RATE_KEY);
  const previous = previousRaw ? new Decimal(previousRaw) : null;
  if (previous && rate.equals(previous)) return { status: "unchanged", rate, market };
  await setSetting(db, USD_IDR_RATE_KEY, rate.toString());
  logger.info(
    `usd_idr_rate ${previous ? `updated ${previous.toString()} ->` : "set to"} ${rate.toString()} ` +
      `(market ${market.toString()}, step ${step})`,
  );
  return { status: "updated", rate, market, previous };
}

/**
 * Current Rupiah-per-USDT rate: the `usd_idr_rate` setting wins, the
 * USDT_IDR_RATE env is the bootstrap fallback. Null (= unset/invalid) hides
 * the USDT info everywhere and disables the Binance/USDT payment path; the
 * IDR/TokoPay path keeps working (design.md §8b).
 */
export async function getUsdIdrRate(db: Db): Promise<Decimal | null> {
  const raw = (await getSetting(db, USD_IDR_RATE_KEY)) ?? config.USDT_IDR_RATE;
  if (raw == null || raw === "") return null;
  try {
    const rate = new Decimal(raw);
    return rate.isFinite() && rate.greaterThan(0) ? rate : null;
  } catch {
    return null;
  }
}

export type PaymentChoice =
  /** Pay in Rupiah via TokoPay — charged the exact central price. */
  | { currency: typeof OrderCurrency.IDR }
  /** Pay in USDT via Binance — charged the derived, rounded USDT total. */
  | {
      currency: typeof OrderCurrency.USDT;
      rate: Decimal.Value;
      /** BINANCE_INTERNAL (auto-confirm, default) or BINANCE_PAY (manual proof, bot only). */
      method?: typeof PaymentMethod.BINANCE_INTERNAL | typeof PaymentMethod.BINANCE_PAY;
    };

/**
 * Stamp a freshly created PENDING order with the buyer's payment choice
 * (plan.md §15.4). Orders are created with central-IDR totals; this converts
 * the TOTAL once (never per item — §15.7 #1):
 *  - IDR  → whole-Rupiah total, unique cents stripped (QRIS confirms by
 *           callback, not by amount matching), method TOKOPAY.
 *  - USDT → totalAmount = round(idr/rate, 0.1) + unique cents (kept: the
 *           Binance poller's amount fallback needs distinct totals), fxRate
 *           snapshot, a unique paymentRef + the short internal payment window
 *           for the auto-confirm path.
 * Run inside the same $transaction as the order creation.
 */
export async function finalizeOrderPayment(db: Db, orderId: number, choice: PaymentChoice) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ValidationError("error.order_not_found");
  if (order.status !== OrderStatus.PENDING_PAYMENT) {
    throw new ValidationError("error.order_not_pending");
  }

  // The central-IDR amount before any unique-cents noise.
  const baseIdr = new Decimal(order.totalAmount).minus(order.uniqueCents);

  if (choice.currency === OrderCurrency.IDR) {
    await db.order.update({
      where: { id: orderId },
      data: {
        currency: OrderCurrency.IDR,
        fxRate: null,
        paymentMethod: PaymentMethod.TOKOPAY,
        uniqueCents: new Decimal(0),
        totalAmount: quantizeMoney(baseIdr, 0),
      },
    });
    return getOrder(db, orderId);
  }

  const rate = new Decimal(choice.rate);
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) {
    throw new ValidationError("error.generic");
  }
  const method = choice.method ?? PaymentMethod.BINANCE_INTERNAL;
  const usdt = usdtFromIdr(baseIdr, rate);
  const cents = config.USE_UNIQUE_CENTS ? computeUniqueCents(order.id) : new Decimal(0);

  // Auto-confirm path gets a unique transfer note + the short payment window.
  let paymentRef: string | null = null;
  if (method === PaymentMethod.BINANCE_INTERNAL) {
    paymentRef = generatePaymentRef();
    for (let i = 0; i < 5; i++) {
      const clash = await db.order.findUnique({ where: { paymentRef } });
      if (!clash) break;
      paymentRef = generatePaymentRef();
    }
  }

  await db.order.update({
    where: { id: orderId },
    data: {
      currency: OrderCurrency.USDT,
      fxRate: rate,
      paymentMethod: method,
      uniqueCents: cents,
      totalAmount: usdt.plus(cents),
      ...(paymentRef
        ? {
            paymentRef,
            expiresAt: addMinutes(new Date(), config.INTERNAL_PAYMENT_WINDOW_MINUTES),
          }
        : {}),
    },
  });
  logger.info(
    `Order ${order.orderCode} finalized as USDT (${usdt.toString()} @ ${rate.toString()}, method=${method})`,
  );
  return getOrder(db, orderId);
}
