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
import { assertOrderTotalClearsRailMinimum } from "./orderMinimums";
import { getOrder } from "./orders";

/** Settings key: Rupiah per 1 USDT (e.g. "16000"), set in web-admin. */
export const USD_IDR_RATE_KEY = "usd_idr_rate";
/** "false" turns the market auto-update off (unset/anything else = ON). */
export const USD_IDR_RATE_AUTO_KEY = "usd_idr_rate_auto";
/** Rounding step in Rupiah applied to the fetched market rate. */
export const USD_IDR_RATE_ROUNDING_KEY = "usd_idr_rate_rounding";
export const DEFAULT_RATE_ROUNDING = "100";
/**
 * Settings key: ISO timestamp of the last time `usd_idr_rate` was SET or
 * RE-CONFIRMED against the market (M12 / audit P0-2). Not "when the row was
 * last written" — an `"unchanged"` market refresh stamps this even though the
 * number did not move, because fetching the live rate and finding it identical
 * is a genuine re-confirmation that the saved figure is still current.
 *
 * Written ONLY through {@link setUsdIdrRate} and {@link refreshUsdIdrRate}, so
 * a rate can never be saved without its freshness claim being updated in the
 * same breath. Read by {@link finalizeOrderPayment}'s USDT branch to refuse
 * converting an order at a rate nobody has confirmed in a long time.
 *
 * NOTE for M13 (`fx_rate_min`/`fx_rate_max`/`fx_rate_max_delta_pct`): this key
 * ALREADY EXISTS as of M12 — reuse it, do not re-add it or redefine what it
 * means. M13's sanity band belongs alongside it, not on top of it.
 */
export const USD_IDR_RATE_UPDATED_AT_KEY = "usd_idr_rate_updated_at";
/**
 * Settings key: how many minutes a saved rate stays usable for converting new
 * orders, counted from {@link USD_IDR_RATE_UPDATED_AT_KEY}. Free text in
 * web-admin, so it follows this repo's existing convention for such values
 * (`parseMinAmount`, `roundRateToStep`): blank, non-numeric or non-positive
 * means "no TTL", leaving the previous behaviour of accepting any saved rate.
 * A typo must not become a shop-wide checkout outage.
 */
export const FX_QUOTE_TTL_MINUTES_KEY = "fx_quote_ttl_minutes";
/** Documented default for {@link FX_QUOTE_TTL_MINUTES_KEY}: one hour. */
export const DEFAULT_FX_QUOTE_TTL_MINUTES = "60";

// Swappable market-rate fetcher so tests never hit the network.
let fxFetcher: () => Promise<Decimal> = () => fetchUsdIdrMarketRate();
/** Test hook: stub the market-rate fetch. */
export function setFxRateFetcher(fn: () => Promise<Decimal>): void {
  fxFetcher = fn;
}

/**
 * The one sanctioned way to write `usd_idr_rate` — same "single mutator"
 * discipline as `adjustWallet`/`transitionOrderStatus`/
 * `postFinancialTransaction`. The value and its freshness stamp
 * ({@link USD_IDR_RATE_UPDATED_AT_KEY}) are written together here so the two
 * can never drift apart, which is the whole basis of the TTL check in
 * {@link finalizeOrderPayment}.
 *
 * Deliberately does NOT validate `rate`: web-admin's rate field is free text
 * today and this function must not change what an admin is allowed to type
 * (value validation is M13's `fx_rate_min`/`fx_rate_max` job). `String(rate)`
 * rather than `new Decimal(rate).toString()` for exactly that reason — parsing
 * here would turn a typo into a 500 instead of the saved-as-typed behaviour
 * every caller has today.
 */
export async function setUsdIdrRate(db: Db, rate: Decimal.Value): Promise<void> {
  await setSetting(db, USD_IDR_RATE_KEY, String(rate));
  await stampUsdIdrRateConfirmed(db);
}

/**
 * Record that the saved rate was just confirmed to still be correct, without
 * rewriting the value itself. Only `refreshUsdIdrRate`'s `"unchanged"` outcome
 * needs this: the market was genuinely fetched and compared, so the rate's
 * freshness is real even though its digits did not move.
 */
async function stampUsdIdrRateConfirmed(db: Db): Promise<void> {
  await setSetting(db, USD_IDR_RATE_UPDATED_AT_KEY, new Date().toISOString());
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
 *
 * Freshness (M12): both the `"updated"` and `"unchanged"` outcomes re-stamp
 * {@link USD_IDR_RATE_UPDATED_AT_KEY}, because each one involved really asking
 * the market. `"disabled"` and a throwing fetch do not — nothing was checked in
 * either case, so the saved rate's freshness claim is exactly what it was.
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
  if (previous && rate.equals(previous)) {
    // Fetched, compared, still correct — a real re-confirmation of freshness.
    await stampUsdIdrRateConfirmed(db);
    return { status: "unchanged", rate, market };
  }
  await setUsdIdrRate(db, rate);
  logger.info(
    `USD/IDR rate ${previous ? `updated from ${previous.toString()} to` : "set to"} ${rate.toString()} ` +
      `(market rate ${market.toString()}, rounded to the nearest ${step})`,
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

/**
 * Refuse to convert an order at a rate the shop has not confirmed lately
 * (M12 / audit P0-2).
 *
 * What this actually guards. `finalizeOrderPayment` never reads `usd_idr_rate`
 * itself — it snapshots whatever rate its caller passed, and every real caller
 * fetches that rate and finalizes in the same handler invocation, milliseconds
 * apart. So "how old is this buyer's quote" is never the risk here. The risk is
 * that `usd_idr_rate` ITSELF went stale: the hourly auto-update failing
 * silently, or `usd_idr_rate_auto` switched off months ago and forgotten. Left
 * unguarded, every USDT order would keep being priced off that frozen number
 * indefinitely with nothing anywhere saying so.
 *
 * A MISSING stamp is deliberately treated as "freshness unknown", not "stale",
 * and is allowed through. Do not "fix" this into a hard failure: every shop
 * that has not yet hit either write path since this shipped — and every shop
 * whose rate was seeded directly, e.g. by `scripts/convert-prices-to-idr.ts` —
 * has no stamp, and rejecting them would be a self-inflicted checkout outage
 * with no actual staleness behind it. The stamp appears the first time the rate
 * is refreshed or edited, and the guard becomes real from then on.
 */
async function assertFxQuoteIsFresh(db: Db): Promise<void> {
  const stampedAt = await getSetting(db, USD_IDR_RATE_UPDATED_AT_KEY);
  if (!stampedAt) return; // freshness unknown — see the grace note above
  const confirmedAt = new Date(stampedAt);
  // An unreadable stamp is no more proof of staleness than a missing one.
  if (Number.isNaN(confirmedAt.getTime())) return;

  const raw = (await getSetting(db, FX_QUOTE_TTL_MINUTES_KEY)) ?? DEFAULT_FX_QUOTE_TTL_MINUTES;
  let ttlMinutes: Decimal;
  try {
    ttlMinutes = new Decimal(raw.trim() === "" ? "0" : raw);
  } catch {
    return; // free-text setting: an unusable TTL means no TTL, never an outage
  }
  if (!ttlMinutes.isFinite() || ttlMinutes.lessThanOrEqualTo(0)) return;

  const expiresAt = addMinutes(confirmedAt, ttlMinutes.toNumber());
  if (expiresAt.getTime() > Date.now()) return;

  logger.warn(
    `Refusing to price an order in USDT: the saved USD/IDR rate was last confirmed at ${confirmedAt.toISOString()}, ` +
      `which is older than the ${ttlMinutes.toString()}-minute quote lifetime (${FX_QUOTE_TTL_MINUTES_KEY}). ` +
      `The market auto-update (${USD_IDR_RATE_AUTO_KEY}) is either switched off or failing, so every USDT checkout ` +
      `will keep being refused until an admin refreshes or re-enters the rate.`,
  );
  throw new ValidationError("error.fx_quote_expired");
}

export type PaymentChoice =
  | {
      currency: typeof OrderCurrency.IDR;
      /** TOKOPAY (default jika tidak diisi — caller existing TIDAK pass ini,
       *  jadi perilaku TokoPay byte-identik), PAYDISINI, atau WALLET (dibayar
       *  penuh dari saldo kredit, tanpa gateway). */
      method?: typeof PaymentMethod.TOKOPAY | typeof PaymentMethod.PAYDISINI | typeof PaymentMethod.WALLET;
    }
  /** Pay in USDT via Binance — charged the derived, rounded USDT total. */
  | {
      currency: typeof OrderCurrency.USDT;
      rate: Decimal.Value;
      /**
       * BINANCE_INTERNAL (auto-confirm via note, default), BYBIT (auto-confirm
       * via Bybit Internal Transfer UID, matched by unique amount), BYBIT_BSC
       * (auto-confirm via on-chain BSC deposit, also matched by unique
       * amount), BINANCE_PAY (manual proof, bot only), NOWPAYMENTS
       * (auto-confirm via hosted invoice IPN webhook), or WALLET (dibayar
       * penuh dari saldo kredit USDT, tanpa gateway).
       */
      method?:
        | typeof PaymentMethod.BINANCE_INTERNAL
        | typeof PaymentMethod.BYBIT
        | typeof PaymentMethod.BYBIT_BSC
        | typeof PaymentMethod.BINANCE_PAY
        | typeof PaymentMethod.NOWPAYMENTS
        | typeof PaymentMethod.WALLET;
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
    const idrTotal = quantizeMoney(baseIdr, 0);
    // M11 / audit P0-1. Runs BEFORE the update below, so a rejected order keeps
    // the exact shape its creator left it in — nothing is stamped, no payment
    // method, no expiry, no reference — and the caller can show the buyer an
    // error or offer a different rail without a half-finalized row behind it.
    // WALLET is exempt inside the guard itself (see orderMinimums.ts).
    await assertOrderTotalClearsRailMinimum(db, {
      method: choice.method ?? PaymentMethod.TOKOPAY,
      currency: OrderCurrency.IDR,
      idrAmount: idrTotal,
      railAmount: idrTotal,
    });
    await db.order.update({
      where: { id: orderId },
      data: {
        currency: OrderCurrency.IDR,
        fxRate: null,
        paymentMethod: choice.method ?? PaymentMethod.TOKOPAY,
        uniqueCents: new Decimal(0),
        totalAmount: idrTotal,
      },
    });
    return getOrder(db, orderId);
  }

  const rate = new Decimal(choice.rate);
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) {
    throw new ValidationError("error.generic");
  }
  // M12 / audit P0-2. Logically prior to trusting this rate for anything: it
  // runs before the conversion below, and — like M11's rail-minimum guard two
  // steps further down — before any row is touched, so a refused order is left
  // exactly as its creator made it and the caller can offer the buyer a fresh
  // quote or the IDR rail instead.
  await assertFxQuoteIsFresh(db);
  const method = choice.method ?? PaymentMethod.BINANCE_INTERNAL;
  const usdt = usdtFromIdr(baseIdr, rate);
  // M11 / audit P0-1, the USDT half. Placed here, immediately after the
  // conversion and before ANY gateway-specific state is derived (unique cents,
  // paymentRef, the payment window, the Bybit collision-avoidance loop), so a
  // too-small total costs nothing and mutates nothing. `usdt` excludes the
  // unique cents on purpose: the cents are matching noise added on top, so the
  // amount the rail is really being asked for is never less than this figure.
  // WALLET is exempt inside the guard itself (see orderMinimums.ts).
  await assertOrderTotalClearsRailMinimum(db, {
    method,
    currency: OrderCurrency.USDT,
    idrAmount: baseIdr,
    railAmount: usdt,
  });
  // WALLET orders are pure ledger entries — there is no on-chain/gateway
  // transfer to disambiguate, so unique cents (which would otherwise leave a
  // nonzero remainder even when wallet credit fully covers the order) never
  // apply here.
  let cents =
    config.USE_UNIQUE_CENTS && method !== PaymentMethod.WALLET
      ? computeUniqueCents(order.id)
      : new Decimal(0);
  let totalAmount = usdt.plus(cents);

  // Auto-confirm paths get a bounded payment window. Binance Internal also gets
  // a unique transfer note (paymentRef); neither Bybit rail (Internal
  // Transfer or on-chain BSC) has a memo, so both rely on the unique-cents
  // amount alone for matching — no paymentRef.
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
    // Neither Bybit rail has a memo (Internal Transfer or on-chain BEP20) —
    // amount is the ONLY disambiguator. The 49-bucket space in
    // computeUniqueCents can still collide for two orders with the same base
    // USDT amount whose ids land in the same bucket. Guarantee uniqueness
    // among the SAME pool the matcher itself reads (listPendingBybitOrders /
    // listPendingBybitBscOrders: PENDING_PAYMENT, this method, not-yet-
    // expired) instead of just statistically reducing the odds (Checkout-4
    // fix, security audit 2026-06-23). `paymentMethod: method` scopes this to
    // the order's own method, so BYBIT and BYBIT_BSC orders never collide
    // with each other's pool — each is matched against its own independent
    // poller. Bumping the seed by +1 each retry cycles through all 49 buckets
    // before repeating.
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
    // tidak ada paymentRef di sini — NOWPayments invoice id dibuat & dicache di
    // order.paymentRef oleh caller storefront/bot setelah finalizeOrderPayment,
    // sama seperti TokoPay/PayDisini melakukannya untuk paymentRef JSON cache.
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
    `Order ${order.orderCode} finalized as USDT (${usdt.toString()} @ ${rate.toString()}, via ${method})`,
  );
  return getOrder(db, orderId);
}
