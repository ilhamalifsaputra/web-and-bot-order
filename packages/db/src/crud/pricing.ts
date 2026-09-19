/**
 * Central-IDR price model (plan.md §15): Product.price holds Rupiah — the one
 * source of truth — and the USDT figure is DERIVED from the admin-set
 * `usd_idr_rate` setting, rounded UP to the next 0.01. The transaction currency
 * is chosen at PAY time (USDT → Binance, IDR → TokoPay) and snapshotted on the
 * order together with the fx rate, so later rate edits never rewrite history.
 */
import { config } from "@app/core/config";
import {
  fetchUsdIdrMarketRate,
  roundRateToStep,
  validateUsdIdrRate,
  applyUsdtSpread,
  type FxRateRejection,
} from "@app/core/fx";
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
import { enqueueAdminFxRateStale, enqueueAdminFxRateRejected } from "./notifications";

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
 * This stamp itself is written ONLY through {@link setUsdIdrRate} and
 * {@link refreshUsdIdrRate}, so no code path can move the rate through the
 * sanctioned mutator without updating the freshness claim in the same breath.
 * Read by {@link finalizeOrderPayment}'s USDT branch to refuse converting an
 * order at a rate nobody has confirmed in a long time.
 *
 * One path does write `usd_idr_rate` WITHOUT a stamp, and it is deliberate:
 * `scripts/convert-prices-to-idr.ts` seeds the rate with a bare `setSetting`
 * during the one-off central-IDR conversion, before any of this existed. That
 * leaves a rate with no stamp at all, which is the "freshness unknown" state
 * both {@link assertFxQuoteIsFresh} and {@link usdIdrRateStaleness} let through
 * on purpose — see their grace notes. So the invariant is not "every saved rate
 * carries a fresh stamp"; it is "a stamp, once present, is never stale-by-
 * omission". Any NEW writer of `usd_idr_rate` must go through
 * {@link setUsdIdrRate}.
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

/**
 * The sanity band a fetched market rate has to land inside before it is
 * trusted (M13 / audit P0-3). Rupiah per USDT, SANITY bounds only — not a
 * precise market range. They exist to catch a source that starts answering in
 * the wrong unit, or returns a placeholder, not to second-guess a real market
 * move; `fx_rate_max_delta_pct` is the check that does that.
 *
 * All three follow the same free-text convention as `fx_quote_ttl_minutes` and
 * `parseMinAmount`: blank, non-numeric or non-positive means "this check is
 * off", never "reject everything". An admin's typo must not freeze the shop's
 * rate at whatever it happened to be that day.
 */
export const FX_RATE_MIN_KEY = "fx_rate_min";
/** Documented default for {@link FX_RATE_MIN_KEY}: Rp8.000 per USDT. */
export const DEFAULT_FX_RATE_MIN = "8000";
export const FX_RATE_MAX_KEY = "fx_rate_max";
/** Documented default for {@link FX_RATE_MAX_KEY}: Rp40.000 per USDT. */
export const DEFAULT_FX_RATE_MAX = "40000";
/**
 * How far one refresh may move the saved rate, in percent.
 *
 * Interacts with {@link USDT_SPREAD_BPS_KEY}, and the interaction is a trap
 * worth stating (whole-branch review D10/A4). The figure judged against this cap
 * is the POST-spread, post-rounding rate, compared against whatever is saved. So
 * if the spread exceeds this percentage and the saved rate does not already
 * carry that spread — right after it was raised, or after an admin typed the raw
 * market figure in — the very first refresh is refused for moving too far. And
 * because a refusal saves nothing, the next tick compares the same new rate
 * against the same un-spread saved one and is refused again: the shop never
 * converges, and the rate simply ages until `fx_rate_max_age_hours` hides the
 * USDT rail. Keep the spread comfortably under this cap. The two ways out are to
 * widen the cap (or narrow the spread), or to hand-type the already-spread
 * figure, which a refresh then reproduces with a zero delta.
 */
export const FX_RATE_MAX_DELTA_PCT_KEY = "fx_rate_max_delta_pct";
/** Documented default for {@link FX_RATE_MAX_DELTA_PCT_KEY}: 5%. */
export const DEFAULT_FX_RATE_MAX_DELTA_PCT = "5";

/**
 * Settings key: how many HOURS a saved rate may go unconfirmed before the
 * whole USDT rail is switched off shop-wide (M13 / audit P0-3).
 *
 * Deliberately a different lever from {@link FX_QUOTE_TTL_MINUTES_KEY}, which
 * is measured in MINUTES and refuses ONE order at a time at finalize. This one
 * is the outer horizon: past it, {@link getUsdIdrRate} reports no rate at all,
 * so checkout stops offering USDT anywhere, prices stop showing a USDT figure,
 * and nothing gets as far as the quote TTL. The two are layered on purpose —
 * a shop whose auto-update dies at 09:00 starts refusing USDT conversions an
 * hour later (quote TTL) and stops advertising USDT two days later (this).
 */
export const FX_RATE_MAX_AGE_HOURS_KEY = "fx_rate_max_age_hours";
/** Documented default for {@link FX_RATE_MAX_AGE_HOURS_KEY}: two days. */
export const DEFAULT_FX_RATE_MAX_AGE_HOURS = "48";

/**
 * Settings key: the shop's protective spread on the market rate, in basis
 * points (100 bps = 1%). Applied by {@link applyUsdtSpread} BEFORE rounding,
 * so what gets saved — and therefore what every USDT order snapshots as its
 * `fxRate` — already carries it. This is a real pricing lever, not a display
 * tweak. See `applyUsdtSpread`'s own comment for why lowering the rate is the
 * protective direction. Default {@link DEFAULT_USDT_SPREAD_BPS} = no spread,
 * so nothing changes for a shop that never sets it.
 *
 * Two things this spread is NOT (whole-branch review A4):
 *  - It applies ONLY to the automatic market refresh, which is the only path
 *    that runs {@link applyUsdtSpread}. A rate an admin types into web-admin is
 *    saved exactly as typed ({@link setUsdIdrRate} does not touch it), so a shop
 *    that sets its rate by hand is not quietly getting a spread on top — it is
 *    getting none at all, and has to build its margin into the figure it types.
 *  - It is not free of the sanity band. Because the spread moves the figure that
 *    band judges, a spread larger than {@link FX_RATE_MAX_DELTA_PCT_KEY} makes
 *    every refresh get refused, permanently — see that key's own comment for
 *    why it never self-corrects.
 */
export const USDT_SPREAD_BPS_KEY = "usdt_spread_bps";
/** Documented default for {@link USDT_SPREAD_BPS_KEY}: no spread at all. */
export const DEFAULT_USDT_SPREAD_BPS = "0";

/**
 * Settings key: how many market-rate refreshes in a row have been refused by
 * the sanity band. A plain integer string, read-then-written (the generic
 * settings table has no atomic increment) — safe here because the only writer
 * is an hourly cron plus an admin pressing a button, never a concurrent hot
 * path. Reset to "0" by the next refresh that actually confirms a rate, so a
 * streak that self-heals stops being reported as one.
 */
export const FX_REFRESH_FAILURES_KEY = "fx_refresh_failures";

/**
 * Settings key: which freshness stamp the shop's admins have already been
 * DMed about being stale. Internal bookkeeping for
 * {@link alertIfUsdIdrRateStale}, never an admin-editable field: it makes the
 * staleness alert fire once per EPISODE rather than once per hourly tick,
 * while still firing again after a refresh-then-go-stale-again cycle, because
 * that cycle produces a different stamp. Cleared by every successful refresh.
 */
export const FX_STALE_ALERTED_FOR_KEY = "fx_stale_alerted_for";

/**
 * Settings key: which REJECTION episode the shop's admins have already been
 * DMed about. Internal bookkeeping for {@link alertIfFxRateRejected}, never an
 * admin-editable field — the exact counterpart of
 * {@link FX_STALE_ALERTED_FOR_KEY} for the other FX failure mode, and cleared by
 * the same {@link clearFxFailureState}.
 *
 * The episode key is the rejection's REASON, not its figures. A source stuck in
 * one failure mode produces the same reason every hour, and after the first DM
 * there is no new information in the next one — the sentence, the settings to go
 * and check and the action to take are identical, and an hourly repeat of it for
 * days is how an alert stops being read. A reason that CHANGES (the source went
 * from answering below the floor to jumping past the delta cap) is genuinely
 * different news and gets its own DM. The figures deliberately do not enter the
 * key: a drifting market source would otherwise make every tick a fresh
 * "episode" and defeat the whole mechanism.
 */
export const FX_REJECTED_ALERTED_FOR_KEY = "fx_rejected_alerted_for";

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
  // An admin typing the rate in by hand is the documented fix for BOTH FX
  // failure modes — a refresh the sanity band keeps refusing, and a rate that
  // aged out — so it ends whatever episode was in progress, exactly as a
  // confirmed market refresh does. Without this, an admin who corrected the
  // rate themselves left `fx_refresh_failures` reading "7 in a row" for a
  // streak that was over, which is the figure the rejection DM quotes.
  await clearFxFailureState(db);
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
  | { status: "disabled" }
  /**
   * M13 / audit P0-3: the market answered, but with a figure the sanity band
   * refuses. NOT an error — the refresh worked exactly as designed, it simply
   * declined to trust the answer — so it is a result, not a throw: the saved
   * rate and its freshness stamp are untouched and the caller decides whether
   * to alert. `market` is what the source said; `rate` is what that became
   * after the spread and rounding, which is the figure actually judged.
   */
  | {
      status: "rejected";
      market: Decimal;
      rate: Decimal;
      reason: FxRateRejection;
      /** How many refreshes in a row have now been refused, including this one. */
      consecutiveFailures: number;
    };

/** Read one free-text numeric setting as a bound, or null when it is absent,
 * blank, unparseable or non-positive — i.e. "this check is not configured".
 * Shared by the sanity band and the staleness horizon so the two can never
 * disagree about what an unusable value means. */
async function numericSetting(db: Db, key: string, fallback: string): Promise<Decimal | null> {
  const raw = (await getSetting(db, key)) ?? fallback;
  let value: Decimal;
  try {
    value = new Decimal(raw.trim() === "" ? "0" : raw);
  } catch {
    return null;
  }
  return value.isFinite() && value.greaterThan(0) ? value : null;
}

/** The configured sanity band for {@link validateUsdIdrRate}. */
async function fxRateBounds(db: Db) {
  return {
    min: await numericSetting(db, FX_RATE_MIN_KEY, DEFAULT_FX_RATE_MIN),
    max: await numericSetting(db, FX_RATE_MAX_KEY, DEFAULT_FX_RATE_MAX),
    maxDeltaPct: await numericSetting(db, FX_RATE_MAX_DELTA_PCT_KEY, DEFAULT_FX_RATE_MAX_DELTA_PCT),
  };
}

/** Bump {@link FX_REFRESH_FAILURES_KEY} and return the new count. */
async function countFxRefreshFailure(db: Db): Promise<number> {
  const raw = (await getSetting(db, FX_REFRESH_FAILURES_KEY)) ?? "0";
  const parsed = Number.parseInt(raw, 10);
  const next = (Number.isFinite(parsed) && parsed > 0 ? parsed : 0) + 1;
  await setSetting(db, FX_REFRESH_FAILURES_KEY, String(next));
  return next;
}

/**
 * A rate was confirmed — by a market refresh, or by an admin typing it in — so
 * the shop is out of every FX failure mode at once: the streak of refused
 * fetches is over, and neither the staleness episode nor the rejection episode
 * the admins were told about is still running. Clearing both episode markers
 * here (rather than waiting for the next check) is what lets a LATER episode
 * raise a fresh DM instead of being swallowed as a repeat.
 */
async function clearFxFailureState(db: Db): Promise<void> {
  await setSetting(db, FX_REFRESH_FAILURES_KEY, "0");
  await setSetting(db, FX_STALE_ALERTED_FOR_KEY, "");
  await setSetting(db, FX_REJECTED_ALERTED_FOR_KEY, "");
}

/**
 * Pull the live USD→IDR market rate, apply the shop's spread, round it to the
 * configured step (default Rp100), and save it as `usd_idr_rate`. The
 * user-facing rule (plan.md §15.8 resolved): the rate FOLLOWS the real market,
 * with the spread and rounding on top. Auto is ON unless `usd_idr_rate_auto`
 * is "false"; `force` (the admin's "update now" button) bypasses that switch.
 * Fetch failures throw — callers log/flash and the previously saved rate stays
 * in effect (orders snapshot their own fxRate). A rate the market DID return
 * but that fails the sanity band does not throw; see `"rejected"` below.
 *
 * Freshness (M12): both the `"updated"` and `"unchanged"` outcomes re-stamp
 * {@link USD_IDR_RATE_UPDATED_AT_KEY}, because each one involved really asking
 * the market. `"disabled"` and a throwing fetch do not — nothing was checked in
 * either case, so the saved rate's freshness claim is exactly what it was.
 *
 * Sanity band (M13 / audit P0-3): between fetching and trusting, the figure
 * that would actually be SAVED — after the spread and the rounding step, not
 * the raw market number — has to clear {@link validateUsdIdrRate}. A failure
 * returns `"rejected"` rather than throwing, and changes nothing: not the
 * rate, not its freshness stamp. A refused fetch is not a confirmation of
 * anything, and re-stamping freshness off one would be the worst possible
 * outcome — a rate nobody has verified in days, wearing a fresh timestamp.
 *
 * This function deliberately does NOT alert anyone. Its two callers differ:
 * the hourly cron has nobody watching and enqueues an admin DM, while
 * web-admin's "update now" button answers the admin who pressed it, on screen,
 * synchronously. Alerting here would DM every admin about a failure one of
 * them is already reading.
 */
export async function refreshUsdIdrRate(db: Db, opts: { force?: boolean } = {}): Promise<FxRefreshResult> {
  if (!opts.force) {
    const auto = await getSetting(db, USD_IDR_RATE_AUTO_KEY);
    if (auto === "false") return { status: "disabled" };
  }
  const step = (await getSetting(db, USD_IDR_RATE_ROUNDING_KEY)) ?? DEFAULT_RATE_ROUNDING;
  const spreadBps = (await getSetting(db, USDT_SPREAD_BPS_KEY)) ?? DEFAULT_USDT_SPREAD_BPS;
  const market = await fxFetcher();
  // Spread first, THEN round: rounding the already-shaved figure keeps the
  // saved rate a clean multiple of the step, which is the whole point of the
  // step (buyers see tidy numbers). Shaving a rounded figure would produce
  // Rp15.680-shaped rates instead.
  const rate = roundRateToStep(applyUsdtSpread(market, spreadBps), step);
  // A non-finite or non-positive rounded rate used to throw `error.generic`
  // here. It is now `validateUsdIdrRate`'s `not_a_number`/`not_positive`
  // rejection instead (M13), which is strictly better: the same figure is
  // still refused, but the saved rate visibly stays in effect, the failure is
  // counted, and an admin is told what the source actually returned rather
  // than the cron logging an opaque generic error. The commonest way to reach
  // it is a source that switched units — Rp16,2 per USDT rounds to 0 at the
  // default Rp100 step.
  const previousRaw = await getSetting(db, USD_IDR_RATE_KEY);
  let previous: Decimal | null = null;
  if (previousRaw) {
    try {
      const parsed = new Decimal(previousRaw);
      previous = parsed.isFinite() && parsed.greaterThan(0) ? parsed : null;
    } catch {
      // A hand-typed saved rate can be anything; an unreadable one is simply
      // no baseline to compare against, exactly like having none at all.
      previous = null;
    }
  }

  const rejection = validateUsdIdrRate(rate, previous, await fxRateBounds(db));
  if (rejection) {
    const consecutiveFailures = await countFxRefreshFailure(db);
    logger.error(
      `Refusing a USD/IDR rate fetched from the market: ${describeFxRejection(rejection, rate)} ` +
        `The market source answered ${market.toString()} (${rate.toString()} after the spread and rounding). ` +
        `Nothing was saved, so orders keep being priced at ${previous ? previous.toString() : "no saved rate"} ` +
        `and its existing freshness stamp stands. This is refusal number ${consecutiveFailures} in a row — ` +
        `until it clears, the saved rate keeps ageing towards ${FX_RATE_MAX_AGE_HOURS_KEY}, past which the USDT rail is hidden entirely.`,
    );
    return { status: "rejected", market, rate, reason: rejection, consecutiveFailures };
  }

  await clearFxFailureState(db);
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
 * One English sentence naming which sanity check a rate failed and by how
 * much — for the developer-facing Pino line above. The admin-facing wording
 * lives in the outbox template, deliberately separate: the two audiences need
 * different detail and different languages.
 */
export function describeFxRejection(rejection: FxRateRejection, rate: Decimal): string {
  switch (rejection.reason) {
    case "not_a_number":
      return "the figure is not a usable number at all.";
    case "not_positive":
      return `the figure ${rate.toString()} is zero or negative.`;
    case "below_min":
      return `${rate.toString()} is below the ${FX_RATE_MIN_KEY} floor of ${rejection.min.toString()}.`;
    case "above_max":
      return `${rate.toString()} is above the ${FX_RATE_MAX_KEY} ceiling of ${rejection.max.toString()}.`;
    case "delta_too_large":
      return (
        `${rate.toString()} is ${rejection.deltaPct.toDecimalPlaces(2).toString()}% away from the saved ` +
        `${rejection.lastKnown.toString()}, more than the ${rejection.maxDeltaPct.toString()}% one refresh may move it (${FX_RATE_MAX_DELTA_PCT_KEY}).`
      );
  }
}

/**
 * How long past {@link FX_RATE_MAX_AGE_HOURS_KEY} the saved rate is, or null
 * when it is inside the horizon (M13 / audit P0-3).
 *
 * Pure read, no side effects — it is called from {@link getUsdIdrRate}, which
 * every catalogue render and checkout page goes through. The alerting lives in
 * {@link alertIfUsdIdrRateStale}, called once an hour from the cron, precisely
 * so this stays cheap enough for a hot path.
 *
 * A MISSING or unreadable stamp is "freshness unknown", not "stale", and is
 * allowed through — the same deploy-safety grace `assertFxQuoteIsFresh`
 * documents at length just below, and for the same reason: a shop that has not
 * touched its rate since this shipped, or seeded it straight into the
 * settings table, would otherwise lose its entire USDT rail on deploy with no
 * real staleness behind it. The stamp appears the first time the rate is
 * refreshed or edited, and the kill-switch becomes real from then on.
 */
export async function usdIdrRateStaleness(
  db: Db,
): Promise<{ confirmedAt: Date; ageHours: Decimal; maxAgeHours: Decimal } | null> {
  const stampedAt = await getSetting(db, USD_IDR_RATE_UPDATED_AT_KEY);
  if (!stampedAt) return null; // freshness unknown — see the grace note above
  const confirmedAt = new Date(stampedAt);
  if (Number.isNaN(confirmedAt.getTime())) return null;

  const maxAgeHours = await numericSetting(db, FX_RATE_MAX_AGE_HOURS_KEY, DEFAULT_FX_RATE_MAX_AGE_HOURS);
  if (!maxAgeHours) return null; // an unusable horizon means no horizon, never an outage

  const ageHours = new Decimal(Date.now() - confirmedAt.getTime()).dividedBy(3_600_000);
  return ageHours.greaterThan(maxAgeHours) ? { confirmedAt, ageHours, maxAgeHours } : null;
}

/**
 * Current Rupiah-per-USDT rate: the `usd_idr_rate` setting wins, the
 * USDT_IDR_RATE env is the bootstrap fallback. Null (= unset/invalid) hides
 * the USDT info everywhere and disables the Binance/USDT payment path; the
 * IDR/TokoPay path keeps working (design.md §8b).
 *
 * M13 / audit P0-3: a rate nobody has confirmed for longer than
 * {@link FX_RATE_MAX_AGE_HOURS_KEY} reads as null too. This is the whole
 * staleness kill-switch, landed here on purpose rather than at each of the
 * dozen call sites: every real caller already treats a null rate as "USDT is
 * not available" and already has the copy for it — the storefront's two wallet
 * checkouts raise `web.pay_method_unavailable`, the bot's `currentUsdtRate`
 * makes its screens Rupiah-only, web-admin's stock export leaves the USDT
 * column blank. That copy reads correctly for BOTH causes: a buyer can do
 * nothing about either one, and "pay in Rupiah instead" is the right next step
 * whether the rate is missing or merely old. Telling them WHICH would leak an
 * operational fault into a shopfront for no gain; the admins get the real
 * explanation by DM (`alertIfUsdIdrRateStale`).
 *
 * `allowStale` is for the one caller that is not pricing anything a buyer is
 * about to pay: `referrals.ts` converting an already-settled IDR order into
 * the USDT wallet to pay a commission. A missed commission there is a silent,
 * permanent loss for the referrer with nothing to retry, and the conversion
 * itself is not a quote anyone can act on — so an old rate is better than no
 * rate. Do not reach for this flag anywhere a buyer is being quoted a price.
 */
export async function getUsdIdrRate(db: Db, opts: { allowStale?: boolean } = {}): Promise<Decimal | null> {
  const raw = (await getSetting(db, USD_IDR_RATE_KEY)) ?? config.USDT_IDR_RATE;
  if (raw == null || raw === "") return null;
  let rate: Decimal;
  try {
    rate = new Decimal(raw);
  } catch {
    return null;
  }
  if (!rate.isFinite() || !rate.greaterThan(0)) return null;
  if (!opts.allowStale && (await usdIdrRateStaleness(db))) return null;
  return rate;
}

/**
 * Tell every admin, ONCE per staleness episode, that the saved rate aged out
 * and the USDT rail is now off shop-wide (M13 / audit P0-3). Returns whether
 * it actually enqueued anything.
 *
 * Called from the hourly `scheduleFxRefresh` tick, not from
 * {@link getUsdIdrRate}: that function runs on every catalogue render, and an
 * alert there would be both a side effect in a hot read path and an
 * unbounded DM firehose. Once an hour is as often as this needs checking —
 * the horizon it guards is measured in days.
 *
 * The episode key is the freshness stamp itself. Alerting on a stamp marks
 * that stamp as told-about; every later tick of the same outage sees the same
 * stamp and stays quiet. A refresh clears the marker
 * ({@link clearFxFailureState}) AND writes a new stamp, so if the rate later
 * goes stale again that is a different stamp and a genuinely new outage, and
 * it gets its own DM.
 */
export async function alertIfUsdIdrRateStale(db: Db): Promise<boolean> {
  const stale = await usdIdrRateStaleness(db);
  if (!stale) return false;

  const episode = stale.confirmedAt.toISOString();
  if ((await getSetting(db, FX_STALE_ALERTED_FOR_KEY)) === episode) return false;

  logger.error(
    `The saved USD/IDR rate has not been confirmed since ${episode}, about ${stale.ageHours.toDecimalPlaces(1).toString()} hours ago, ` +
      `which is past the ${stale.maxAgeHours.toString()}-hour limit in ${FX_RATE_MAX_AGE_HOURS_KEY}. ` +
      `The USDT payment rail is now hidden shop-wide: customers are shown Rupiah only and cannot pay in USDT until an admin ` +
      `refreshes or re-enters the rate. Every admin has been sent one alert about this; they will not be sent another until the rate is refreshed.`,
  );
  await enqueueAdminFxRateStale(db, {
    confirmedAt: stale.confirmedAt,
    ageHours: stale.ageHours.toDecimalPlaces(1),
    maxAgeHours: stale.maxAgeHours,
  });
  await setSetting(db, FX_STALE_ALERTED_FOR_KEY, episode);
  return true;
}

/**
 * Tell every admin, ONCE per rejection episode, that the market refresh keeps
 * being refused by the sanity band. Returns whether it actually enqueued
 * anything.
 *
 * The exact sibling of {@link alertIfUsdIdrRateStale}, deliberately: same
 * outbox fan-out, same "marker written only after the enqueue succeeded", same
 * re-arm through {@link clearFxFailureState} on the next confirmed rate. It is
 * called from the hourly `runFxRefreshTick`, which is the only unattended
 * caller. web-admin's own "update now" button does NOT call it — the admin who
 * pressed it is reading the refusal on screen, and DMing everyone about a
 * failure one of them just triggered on purpose is how the alert that matters
 * (the unattended one) gets trained away. That also means a manual attempt
 * never marks an episode as told-about, so it cannot silence the cron.
 *
 * Before this, every hourly tick of the same stuck source sent a fresh DM to
 * every admin — a source misconfigured on a Friday was 48 identical messages by
 * Monday. The `consecutiveFailures` figure carried in the one DM that is sent
 * still says how long the streak has been running.
 */
export async function alertIfFxRateRejected(
  db: Db,
  rejection: {
    reason: FxRateRejection;
    /** The raw figure the market source returned. */
    market: Decimal;
    /** What it became after the spread and rounding — the figure actually judged. */
    rate: Decimal;
    consecutiveFailures: number;
  },
): Promise<boolean> {
  const episode = rejection.reason.reason;
  if ((await getSetting(db, FX_REJECTED_ALERTED_FOR_KEY)) === episode) return false;

  const reason = rejection.reason;
  await enqueueAdminFxRateRejected(db, {
    reason: reason.reason,
    market: rejection.market,
    rate: rejection.rate,
    // What orders are being priced with right now — the first thing an admin
    // reading this would otherwise go and look up. `allowStale` because the
    // whole point of the DM is that this rate is not being re-confirmed.
    saved: await getUsdIdrRate(db, { allowStale: true }),
    consecutiveFailures: rejection.consecutiveFailures,
    ...(reason.reason === "below_min" ? { min: reason.min } : {}),
    ...(reason.reason === "above_max" ? { max: reason.max } : {}),
    ...(reason.reason === "delta_too_large"
      ? { lastKnown: reason.lastKnown, deltaPct: reason.deltaPct.toDecimalPlaces(2), maxDeltaPct: reason.maxDeltaPct }
      : {}),
  });
  await setSetting(db, FX_REJECTED_ALERTED_FOR_KEY, episode);
  return true;
}

/**
 * How far past {@link FX_QUOTE_TTL_MINUTES_KEY} the saved rate is, or null when
 * it is still inside the quote lifetime (M12 / audit P0-2).
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
 *
 * Pure read, no side effects, and cheap enough for the checkout page: the
 * throwing guard ({@link assertFxQuoteIsFresh}) and the predicate the rail
 * lists call ({@link usdIdrQuoteIsFresh}) are both thin wrappers over this, so
 * "which rails are offered" and "which rails finalize" cannot drift apart. Same
 * one-implementation-two-wrappers shape as `railMinimumFailure` in
 * `orderMinimums.ts`, and for exactly the same reason: M11 learned that a
 * checkout list re-deriving a guard's rule by hand ends up disagreeing with it.
 */
export async function usdIdrQuoteStaleness(
  db: Db,
): Promise<{ confirmedAt: Date; ttlMinutes: Decimal } | null> {
  const stampedAt = await getSetting(db, USD_IDR_RATE_UPDATED_AT_KEY);
  if (!stampedAt) return null; // freshness unknown — see the grace note above
  const confirmedAt = new Date(stampedAt);
  // An unreadable stamp is no more proof of staleness than a missing one.
  if (Number.isNaN(confirmedAt.getTime())) return null;

  const raw = (await getSetting(db, FX_QUOTE_TTL_MINUTES_KEY)) ?? DEFAULT_FX_QUOTE_TTL_MINUTES;
  let ttlMinutes: Decimal;
  try {
    ttlMinutes = new Decimal(raw.trim() === "" ? "0" : raw);
  } catch {
    return null; // free-text setting: an unusable TTL means no TTL, never an outage
  }
  if (!ttlMinutes.isFinite() || ttlMinutes.lessThanOrEqualTo(0)) return null;

  const expiresAt = addMinutes(confirmedAt, ttlMinutes.toNumber());
  if (expiresAt.getTime() > Date.now()) return null;
  return { confirmedAt, ttlMinutes };
}

/**
 * Can a USDT order be priced at the saved rate right now? The question the
 * checkout rail lists ask — the bot's `offerableRails` and the storefront's
 * `checkoutView` — so that a USDT rail is never advertised to a buyer whose tap
 * {@link assertFxQuoteIsFresh} is about to refuse with
 * `error.fx_quote_expired`.
 *
 * Without this, a shop whose auto-update dies spends the whole window between
 * the quote TTL (an hour by default) and `fx_rate_max_age_hours` (two days)
 * showing every USDT button and refusing every one of them, which reads to the
 * buyer as a broken shop rather than as "pay in Rupiah instead".
 *
 * Both callers exempt a ZERO total from this, exactly as they already exempt it
 * from the rail minimums: a nothing-left-to-collect order is settled from the
 * shop's own books (`settleFullyDiscountedOrder`) and never reaches
 * `finalizeOrderPayment` at all, so no freshness check can refuse it and
 * hiding its buttons would strand a buyer whose voucher covered their cart.
 */
export async function usdIdrQuoteIsFresh(db: Db): Promise<boolean> {
  return (await usdIdrQuoteStaleness(db)) === null;
}

/**
 * Refuse to convert an order at a rate the shop has not confirmed lately
 * (M12 / audit P0-2) — the enforcing half of {@link usdIdrQuoteStaleness},
 * whose doc comment explains what is being guarded and why a missing stamp is
 * let through.
 */
async function assertFxQuoteIsFresh(db: Db): Promise<void> {
  const stale = await usdIdrQuoteStaleness(db);
  if (!stale) return;
  logger.warn(
    `Refusing to price an order in USDT: the saved USD/IDR rate was last confirmed at ${stale.confirmedAt.toISOString()}, ` +
      `which is older than the ${stale.ttlMinutes.toString()}-minute quote lifetime (${FX_QUOTE_TTL_MINUTES_KEY}). ` +
      `The market auto-update (${USD_IDR_RATE_AUTO_KEY}) is either switched off or failing, so every USDT checkout ` +
      `will keep being refused until an admin refreshes or re-enters the rate. Checkout has already stopped offering ` +
      `the USDT rails for the same reason, so reaching this guard means a buyer was holding a screen rendered before the quote expired.`,
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
       * How much USDT credit the caller is about to spend on this order with
       * `applyUsdtWalletToOrder` (orders.ts), which every USDT caller runs
       * immediately after this function and inside the same transaction.
       *
       * It exists for ONE reason (whole-branch review D6): the rail-minimum
       * guard below has to judge what the gateway will really be asked for,
       * which is the converted total MINUS this credit. Judged before the
       * credit, a buyer whose balance covers all but a sliver of the order gets
       * an order finalized against a rail that then refuses the sliver out of
       * band, leaving them on a payment screen that can never succeed — the
       * exact failure M11's guard exists to prevent, reintroduced by doing the
       * two steps in this order.
       *
       * Pass the same figure `applyUsdtWalletToOrder` will be passed, unclamped;
       * this function applies the identical "clamped to the payable total" rule
       * and nothing else. In particular it does NOT clamp to the buyer's
       * balance: an unaffordable request is `applyUsdtWalletToOrder`'s
       * `error.insufficient_wallet` to raise, and pre-empting it here with a
       * "that total is too small" error would name the wrong problem.
       *
       * Omitted/null/zero = no credit, and then every figure below is exactly
       * what it was before this existed.
       */
      walletAmount?: Decimal.Value | null;
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
 *  - USDT → totalAmount = ceil(idr/rate, 0.01) + unique cents (kept: the
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
  //
  // What the guard is handed is what is LEFT TO COLLECT after the buyer's USDT
  // credit (whole-branch review D6 — see `PaymentChoice.walletAmount`). Both
  // figures shrink together, each in its own currency: the credit is USDT, so
  // its Rupiah equivalent is `credit × rate`, which is what the shop-wide
  // Rupiah floor has to be compared against. With no credit the two figures are
  // byte-identical to what they always were.
  const creditRequested = Decimal.max(new Decimal(0), new Decimal(choice.walletAmount ?? 0));
  const credit = Decimal.min(creditRequested, usdt);
  const railUsdt = usdt.minus(credit);
  const railIdr = credit.greaterThan(0)
    ? Decimal.max(new Decimal(0), baseIdr.minus(credit.times(rate)))
    : baseIdr;
  // A credit that covers the whole converted total leaves the rail nothing to
  // clear, so there is no floor to test — the same exemption the checkout rail
  // lists and `settleFullyDiscountedOrder` already make for a total of zero.
  // Deliberately narrow: an order that is zero for any OTHER reason still meets
  // the `nothing_to_collect` backstop, exactly as before.
  if (!(credit.greaterThan(0) && !railUsdt.greaterThan(0))) {
    await assertOrderTotalClearsRailMinimum(db, {
      method,
      currency: OrderCurrency.USDT,
      idrAmount: railIdr,
      railAmount: railUsdt,
    });
  }
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
