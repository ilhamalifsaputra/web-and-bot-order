import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { PaymentMethod } from "@app/core/enums";
import { usdtFromIdr, computeUniqueCents } from "@app/core/formatters";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { addToCart, createOrderFromCart, bulkAddStock } from "@app/db";
import { getSetting, setSetting, __clearSettingsCacheForTests } from "./settings";
import {
  refreshUsdIdrRate,
  setFxRateFetcher,
  finalizeOrderPayment,
  setUsdIdrRate,
  USD_IDR_RATE_KEY,
  USD_IDR_RATE_AUTO_KEY,
  USD_IDR_RATE_ROUNDING_KEY,
  USD_IDR_RATE_UPDATED_AT_KEY,
  FX_QUOTE_TTL_MINUTES_KEY,
  DEFAULT_FX_QUOTE_TTL_MINUTES,
  FX_RATE_MIN_KEY,
  FX_RATE_MAX_KEY,
  FX_RATE_MAX_DELTA_PCT_KEY,
  FX_RATE_MAX_AGE_HOURS_KEY,
  DEFAULT_FX_RATE_MAX_AGE_HOURS,
  USD_IDR_MARKET_RATE_KEY,
  FX_REFRESH_FAILURES_KEY,
  FX_STALE_ALERTED_FOR_KEY,
  FX_REJECTED_ALERTED_FOR_KEY,
  USDT_SPREAD_BPS_KEY,
  getUsdIdrRate,
  usdIdrRateStaleness,
  usdIdrQuoteIsFresh,
  alertIfUsdIdrRateStale,
  alertIfFxRateRejected,
} from "./pricing";
import { NotificationEvent } from "@app/core/enums";
import { enqueueAdminFxRateRejected } from "./notifications";
import { ADMIN_IDS_KEY } from "./admins";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  __clearSettingsCacheForTests(prisma);
  await prisma.setting.deleteMany();
  setFxRateFetcher(async () => new Decimal("16243.7"));
});

describe("refreshUsdIdrRate (market rate + rounding — plan.md §15.8)", () => {
  it("saves the market rate rounded to the default Rp100 step", async () => {
    const r = await refreshUsdIdrRate(prisma);
    expect(r.status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16200");
  });

  it("honors a custom rounding step", async () => {
    await setSetting(prisma, USD_IDR_RATE_ROUNDING_KEY, "500");
    await refreshUsdIdrRate(prisma);
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16000"); // nearest 500
  });

  it("reports unchanged when the rounded rate already matches", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16200");
    const r = await refreshUsdIdrRate(prisma);
    expect(r.status).toBe("unchanged");
  });

  it("auto switch: 'false' disables the scheduled path, force overrides it", async () => {
    await setSetting(prisma, USD_IDR_RATE_AUTO_KEY, "false");
    expect((await refreshUsdIdrRate(prisma)).status).toBe("disabled");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBeNull(); // untouched
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16200");
  });

  it("a failing fetch throws and leaves the saved rate alone", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
    setFxRateFetcher(async () => {
      throw new Error("network down");
    });
    await expect(refreshUsdIdrRate(prisma, { force: true })).rejects.toThrow();
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16000");
  });
});

// ---- M13 / audit P0-3: the sanity band, the failure counter, the spread -----

describe("refreshUsdIdrRate — refuses a rate outside the sanity band", () => {
  /** Every piece of state a rejected refresh must leave exactly as it was. */
  async function savedRateState() {
    return {
      rate: await getSetting(prisma, USD_IDR_RATE_KEY),
      stampedAt: await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY),
    };
  }

  it("rejects a rate below fx_rate_min without saving it or re-stamping freshness", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
    // Wide enough to take the deviation check out of the picture — this case is
    // about the floor, and an unrelated check firing first would prove nothing.
    await setSetting(prisma, FX_RATE_MAX_DELTA_PCT_KEY, "99");
    const stamp = new Date(Date.now() - 3_600_000).toISOString();
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, stamp);
    setFxRateFetcher(async () => new Decimal("5000"));
    const before = await savedRateState();

    const r = await refreshUsdIdrRate(prisma, { force: true });

    expect(r.status).toBe("rejected");
    if (r.status !== "rejected") throw new Error("unreachable");
    expect(r.reason.reason).toBe("below_min");
    expect(r.market.toString()).toBe("5000");
    expect(await savedRateState()).toEqual(before);
  });

  // The commonest real shape of a broken source: it starts answering in
  // thousands of Rupiah. Rp16,2 per USDT rounds to 0 at the default Rp100
  // step, which used to throw an opaque `error.generic` out of the cron.
  it("rejects a figure that rounds away to zero instead of throwing", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
    const before = await savedRateState();
    setFxRateFetcher(async () => new Decimal("16.2"));

    const r = await refreshUsdIdrRate(prisma, { force: true });

    expect(r.status).toBe("rejected");
    if (r.status !== "rejected") throw new Error("unreachable");
    expect(r.reason.reason).toBe("not_positive");
    expect(await savedRateState()).toEqual(before);
  });

  it("rejects a rate above fx_rate_max", async () => {
    setFxRateFetcher(async () => new Decimal("16200000"));
    const r = await refreshUsdIdrRate(prisma, { force: true });
    expect(r.status).toBe("rejected");
    if (r.status !== "rejected") throw new Error("unreachable");
    expect(r.reason.reason).toBe("above_max");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBeNull();
  });

  // The reference the cap measures from is `usd_idr_market_rate`, not the saved
  // rate (whole-branch review D10 — see its own suite below for why), so these
  // two cases seed it.
  it("rejects a jump larger than fx_rate_max_delta_pct away from the last market rate", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16200");
    await setSetting(prisma, USD_IDR_MARKET_RATE_KEY, "16200");
    setFxRateFetcher(async () => new Decimal("17500")); // +8.02%
    const r = await refreshUsdIdrRate(prisma, { force: true });
    expect(r.status).toBe("rejected");
    if (r.status !== "rejected") throw new Error("unreachable");
    expect(r.reason.reason).toBe("delta_too_large");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16200");
  });

  it("accepts the same jump once fx_rate_max_delta_pct is widened", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16200");
    await setSetting(prisma, USD_IDR_MARKET_RATE_KEY, "16200");
    await setSetting(prisma, FX_RATE_MAX_DELTA_PCT_KEY, "10");
    setFxRateFetcher(async () => new Decimal("17500"));
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("17500");
  });

  it("judges the ROUNDED rate, not the raw market figure", async () => {
    // fx_rate_max 16200 with a market figure of 16150: the raw number is inside
    // the band, the Rp100-rounded 16200 that would actually be SAVED is exactly
    // on it. Rounding the other way (16249 → 16200) must not smuggle an
    // out-of-band figure past the check either.
    await setSetting(prisma, FX_RATE_MAX_KEY, "16200");
    setFxRateFetcher(async () => new Decimal("16150"));
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16200");

    await setSetting(prisma, FX_RATE_MAX_KEY, "16100");
    setFxRateFetcher(async () => new Decimal("16150")); // rounds UP to 16200
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("rejected");
  });

  it("a blank or unusable bound turns that check off rather than rejecting everything", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16200");
    setFxRateFetcher(async () => new Decimal("99999999"));
    for (const max of ["", "0", "-1", "abc"]) {
      await setSetting(prisma, FX_RATE_MAX_KEY, max);
      await setSetting(prisma, FX_RATE_MAX_DELTA_PCT_KEY, max);
      await setSetting(prisma, USD_IDR_RATE_KEY, "16200");
      const r = await refreshUsdIdrRate(prisma, { force: true });
      expect(r.status, `max ${JSON.stringify(max)} should disable the check`).toBe("updated");
    }
  });

  it("counts consecutive failures and clears the count on the next good refresh", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16200");
    setFxRateFetcher(async () => new Decimal("5000"));
    await refreshUsdIdrRate(prisma, { force: true });
    expect(await getSetting(prisma, FX_REFRESH_FAILURES_KEY)).toBe("1");
    await refreshUsdIdrRate(prisma, { force: true });
    expect(await getSetting(prisma, FX_REFRESH_FAILURES_KEY)).toBe("2");

    setFxRateFetcher(async () => new Decimal("16500"));
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("updated");
    expect(await getSetting(prisma, FX_REFRESH_FAILURES_KEY)).toBe("0");
  });

  it("an 'unchanged' refresh also clears the failure count — the source is working again", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16200");
    await setSetting(prisma, FX_REFRESH_FAILURES_KEY, "7");
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("unchanged");
    expect(await getSetting(prisma, FX_REFRESH_FAILURES_KEY)).toBe("0");
  });

  it("reports the failure count on the rejection itself, so the caller can say how long this has run", async () => {
    await setSetting(prisma, FX_REFRESH_FAILURES_KEY, "4");
    setFxRateFetcher(async () => new Decimal("5000"));
    const r = await refreshUsdIdrRate(prisma, { force: true });
    if (r.status !== "rejected") throw new Error("expected a rejection");
    expect(r.consecutiveFailures).toBe(5);
  });
});

describe("usdt_spread_bps — the protective spread on the saved rate", () => {
  it("shaves the market rate down BEFORE rounding, so the saved rate is lower", async () => {
    setFxRateFetcher(async () => new Decimal("16000"));
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16000");

    // 200 bps = 2% off 16000 → 15680 → rounded to the Rp100 step → 15700.
    // Rounding the already-shaved figure (not shaving the rounded one) is what
    // makes the saved rate a clean multiple of the step.
    await setSetting(prisma, USDT_SPREAD_BPS_KEY, "200");
    await setSetting(prisma, USD_IDR_RATE_KEY, "");
    const r = await refreshUsdIdrRate(prisma, { force: true });
    expect(r.status).toBe("updated");
    if (r.status !== "updated") throw new Error("unreachable");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("15700");
    // The raw market figure is still reported untouched — the spread is the
    // shop's margin, not a correction to what the market said.
    expect(r.market.toString()).toBe("16000");
  });

  it("a lower saved rate means the buyer sends MORE USDT — the safe direction for the shop", async () => {
    const withoutSpread = usdtFromIdr(new Decimal("1600000"), new Decimal("16000"));
    const withSpread = usdtFromIdr(new Decimal("1600000"), new Decimal("15700"));
    expect(withSpread.greaterThan(withoutSpread)).toBe(true);
  });

  it("defaults to no spread at all", async () => {
    expect(await getSetting(prisma, USDT_SPREAD_BPS_KEY)).toBeNull();
    setFxRateFetcher(async () => new Decimal("16000"));
    await refreshUsdIdrRate(prisma, { force: true });
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16000");
  });
});

/**
 * Whole-branch review D10 — a configured spread must not deadlock the refresh.
 *
 * The deviation cap used to judge the post-spread figure against whatever
 * `usd_idr_rate` held, so a spread wider than the cap tripped the cap by
 * itself — and because a refusal saves nothing, every later tick compared the
 * same two figures and was refused again. A shop that set a 10% spread under a
 * 5% cap could never refresh its rate again, and the rejection DM blamed a
 * market that had not moved. The cap is now measured market-to-market against
 * `usd_idr_market_rate`.
 */
describe("usd_idr_market_rate — the deviation cap measures the market against itself", () => {
  beforeEach(async () => {
    await setSetting(prisma, FX_RATE_MAX_DELTA_PCT_KEY, "5");
  });

  it("a spread far wider than the delta cap still refreshes, tick after tick", async () => {
    setFxRateFetcher(async () => new Decimal("16000"));
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
    await setSetting(prisma, USD_IDR_MARKET_RATE_KEY, "16000");
    // 1000 bps = 10% — double the 5% cap, and the exact configuration that used
    // to be unrecoverable.
    await setSetting(prisma, USDT_SPREAD_BPS_KEY, "1000");

    const first = await refreshUsdIdrRate(prisma);
    expect(first.status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("14400"); // 16000 − 10%
    expect(await getSetting(prisma, FX_REFRESH_FAILURES_KEY)).toBe("0");

    // And it stays converged: the market has not moved, so the next tick simply
    // re-confirms. Under the old comparison this was the deadlock — the saved
    // 14400 vs a 16000-shaped candidate, refused forever.
    expect((await refreshUsdIdrRate(prisma)).status).toBe("unchanged");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("14400");
  });

  it("still refuses a real market move past the cap, and names the market figures", async () => {
    setFxRateFetcher(async () => new Decimal("16000"));
    await refreshUsdIdrRate(prisma, { force: true });
    expect(await getSetting(prisma, USD_IDR_MARKET_RATE_KEY)).toBe("16000");

    setFxRateFetcher(async () => new Decimal("17500")); // +9.4%
    const r = await refreshUsdIdrRate(prisma, { force: true });
    expect(r.status).toBe("rejected");
    if (r.status !== "rejected") throw new Error("unreachable");
    expect(r.reason.reason).toBe("delta_too_large");
    const reason = r.reason as { subject: Decimal; lastKnown: Decimal };
    expect(reason.subject.toString()).toBe("17500");
    expect(reason.lastKnown.toString()).toBe("16000");
    // A refusal records nothing, so the reference still describes the last
    // figure this shop actually accepted.
    expect(await getSetting(prisma, USD_IDR_MARKET_RATE_KEY)).toBe("16000");
  });

  it("records the reference on an unchanged refresh too — the market was still fetched", async () => {
    setFxRateFetcher(async () => new Decimal("16000"));
    await refreshUsdIdrRate(prisma, { force: true });
    await setSetting(prisma, USD_IDR_MARKET_RATE_KEY, ""); // as a hand-typed rate leaves it
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("unchanged");
    expect(await getSetting(prisma, USD_IDR_MARKET_RATE_KEY)).toBe("16000");
  });

  it("skips the cap when no market reference has been recorded yet", async () => {
    // Every existing shop is in this state on the deploy that adds the key: a
    // saved rate, no reference. The cap cannot be measured, so it is skipped
    // once rather than refusing a rate for deviating from nothing.
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
    expect(await getSetting(prisma, USD_IDR_MARKET_RATE_KEY)).toBeNull();
    setFxRateFetcher(async () => new Decimal("25000")); // +56%, far past the cap
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_MARKET_RATE_KEY)).toBe("25000");
  });

  // A hand-typed rate is this system's documented remedy for a refresh the band
  // keeps refusing, so it has to leave the refresh able to move again. It is not
  // a market observation, so it cannot BECOME the reference either.
  it("a hand-typed rate clears the reference rather than becoming it", async () => {
    setFxRateFetcher(async () => new Decimal("16000"));
    await refreshUsdIdrRate(prisma, { force: true });
    expect(await getSetting(prisma, USD_IDR_MARKET_RATE_KEY)).toBe("16000");

    await setUsdIdrRate(prisma, "25000");
    expect(await getSetting(prisma, USD_IDR_MARKET_RATE_KEY)).toBe("");

    // …and the very next refresh is therefore not refused for a move it cannot
    // measure, whatever the market now says.
    setFxRateFetcher(async () => new Decimal("30000"));
    expect((await refreshUsdIdrRate(prisma, { force: true })).status).toBe("updated");
    expect(await getSetting(prisma, USD_IDR_MARKET_RATE_KEY)).toBe("30000");
  });

  it("an unreadable reference is no reference at all, never an outage", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
    for (const junk of ["abc", "0", "-100"]) {
      await setSetting(prisma, USD_IDR_MARKET_RATE_KEY, junk);
      setFxRateFetcher(async () => new Decimal("25000"));
      expect(
        (await refreshUsdIdrRate(prisma, { force: true })).status,
        `reference ${JSON.stringify(junk)} should disable the cap`,
      ).toBe("updated");
      await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
    }
  });
});

// ---- M13 / audit P0-3: the staleness kill-switch for the whole USDT rail ----

describe("getUsdIdrRate — hides the USDT rail once the saved rate is too old", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  beforeEach(async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
  });

  it("returns the rate while it is inside fx_rate_max_age_hours", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, hoursAgo(2));
    expect((await getUsdIdrRate(prisma))?.toString()).toBe("16000");
    expect(await usdIdrRateStaleness(prisma)).toBeNull();
  });

  it("returns null once the rate is older than the default 48h", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, hoursAgo(Number(DEFAULT_FX_RATE_MAX_AGE_HOURS) + 1));
    expect(await getUsdIdrRate(prisma)).toBeNull();
    const stale = await usdIdrRateStaleness(prisma);
    expect(stale).not.toBeNull();
    expect(stale!.maxAgeHours.toString()).toBe(DEFAULT_FX_RATE_MAX_AGE_HOURS);
    expect(stale!.ageHours.greaterThan(48)).toBe(true);
  });

  it("honors a custom fx_rate_max_age_hours", async () => {
    await setSetting(prisma, FX_RATE_MAX_AGE_HOURS_KEY, "6");
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, hoursAgo(8));
    expect(await getUsdIdrRate(prisma)).toBeNull();
    await setSetting(prisma, FX_RATE_MAX_AGE_HOURS_KEY, "24");
    expect((await getUsdIdrRate(prisma))?.toString()).toBe("16000");
  });

  // Same deploy-safety grace M12's quote TTL already documents: a shop that has
  // never written the stamp has an UNKNOWN freshness, not a stale one, and must
  // not have its USDT rail switched off on that basis alone.
  it("treats a missing or unreadable stamp as freshness unknown, never as stale", async () => {
    expect(await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY)).toBeNull();
    expect((await getUsdIdrRate(prisma))?.toString()).toBe("16000");
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, "not a timestamp");
    expect((await getUsdIdrRate(prisma))?.toString()).toBe("16000");
  });

  it("a blank or non-positive fx_rate_max_age_hours turns the kill-switch off", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, hoursAgo(24 * 365));
    for (const age of ["", "0", "-5", "abc"]) {
      await setSetting(prisma, FX_RATE_MAX_AGE_HOURS_KEY, age);
      expect((await getUsdIdrRate(prisma))?.toString(), `age ${JSON.stringify(age)}`).toBe("16000");
    }
  });

  // referrals.ts converts an already-PAID IDR order's total into the USDT
  // wallet to pay a commission. Dropping that commission on the floor because
  // nobody pressed "update rate" for two days would be a silent money loss for
  // the referrer, and unlike a checkout there is nothing to retry later.
  it("allowStale re-admits the saved rate for callers that are not pricing anything", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, hoursAgo(24 * 30));
    expect(await getUsdIdrRate(prisma)).toBeNull();
    expect((await getUsdIdrRate(prisma, { allowStale: true }))?.toString()).toBe("16000");
  });
});

describe("alertIfUsdIdrRateStale — one admin DM per staleness episode, not per tick", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  async function staleDmCount() {
    return prisma.notificationOutbox.count({ where: { event: NotificationEvent.ADMIN_FX_RATE_STALE } });
  }

  beforeEach(async () => {
    await resetDb(prisma);
    await buildSampleData(prisma);
    await setSetting(prisma, ADMIN_IDS_KEY, "4001,4002");
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
  });

  it("says nothing while the rate is fresh", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, hoursAgo(1));
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(false);
    expect(await staleDmCount()).toBe(0);
  });

  it("alerts once, then stays quiet on every later tick of the same episode", async () => {
    const stamp = hoursAgo(72);
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, stamp);

    expect(await alertIfUsdIdrRateStale(prisma)).toBe(true);
    const first = await staleDmCount();
    expect(first).toBeGreaterThan(0);

    for (let tick = 0; tick < 5; tick++) {
      expect(await alertIfUsdIdrRateStale(prisma)).toBe(false);
    }
    expect(await staleDmCount()).toBe(first);
  });

  it("alerts again for a NEW episode after the rate was refreshed in between", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, hoursAgo(72));
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(true);
    const afterFirst = await staleDmCount();

    // An admin refreshes; the rail comes back; later it goes stale again off a
    // DIFFERENT stamp, which is a genuinely new outage worth telling them about.
    setFxRateFetcher(async () => new Decimal("16243.7"));
    await refreshUsdIdrRate(prisma, { force: true });
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(false);
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, hoursAgo(100));

    expect(await alertIfUsdIdrRateStale(prisma)).toBe(true);
    expect(await staleDmCount()).toBeGreaterThan(afterFirst);
  });

  it("a successful refresh clears the episode marker even if nobody reads it again", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, hoursAgo(72));
    await alertIfUsdIdrRateStale(prisma);
    expect(await getSetting(prisma, FX_STALE_ALERTED_FOR_KEY)).toBeTruthy();
    setFxRateFetcher(async () => new Decimal("16243.7"));
    await refreshUsdIdrRate(prisma, { force: true });
    expect(await getSetting(prisma, FX_STALE_ALERTED_FOR_KEY)).toBe("");
  });
});

/**
 * Whole-branch review D7 — the alert fires at the QUOTE TTL, not only at the
 * 48-hour horizon.
 *
 * Before this, a shop whose refresh died went quiet in the worst possible way:
 * every USDT rail vanished from checkout the moment the quote TTL passed, and
 * nobody was told for up to two days — until `fx_rate_max_age_hours` finally
 * took the prices down too and raised the only DM this event had. The earlier
 * threshold is where an admin can still act cheaply, so it gets its own alert,
 * with its own wording: USDT prices are still on display at that point, and a
 * DM claiming USDT is switched off would read as a false alarm.
 */
describe("alertIfUsdIdrRateStale — both staleness thresholds raise their own DM", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  const staleDms = () =>
    prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.ADMIN_FX_RATE_STALE } });
  const stages = async () =>
    (await staleDms()).map((r) => (JSON.parse(r.payloadJson) as { stage?: string }).stage);

  beforeEach(async () => {
    await resetDb(prisma);
    await buildSampleData(prisma);
    await setSetting(prisma, ADMIN_IDS_KEY, "4001,4002");
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
  });

  // The value itself, not just the mechanism: the whole reason the default moved
  // from 60 to 180 is that the refresh cron runs hourly, so 60 meant a single
  // missed tick cost the shop its USDT rails.
  it("one missed hourly refresh does not expire the quote at the default TTL", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(65));
    expect(await usdIdrQuoteIsFresh(prisma)).toBe(true);
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(false);
    expect(await staleDms()).toHaveLength(0);
  });

  it("alerts at the quote TTL, hours before the outer horizon", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(Number(DEFAULT_FX_QUOTE_TTL_MINUTES) + 30));
    // Nothing near the 48-hour horizon — the rate is still live and displayed.
    expect(await usdIdrRateStaleness(prisma)).toBeNull();
    expect(await getUsdIdrRate(prisma)).not.toBeNull();

    expect(await alertIfUsdIdrRateStale(prisma)).toBe(true);
    expect(await stages()).toEqual(["quote_ttl", "quote_ttl"]); // one per admin
    const payload = JSON.parse((await staleDms())[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.ttl_minutes).toBe(DEFAULT_FX_QUOTE_TTL_MINUTES);
    expect(payload.max_age_hours).toBeUndefined();
  });

  it("stays quiet on every later tick of the same quote-TTL episode", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(Number(DEFAULT_FX_QUOTE_TTL_MINUTES) + 30));
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(true);
    for (let tick = 0; tick < 4; tick++) {
      expect(await alertIfUsdIdrRateStale(prisma)).toBe(false);
    }
    expect(await staleDms()).toHaveLength(2);
  });

  it("escalates: the same stamp crossing the outer horizon is new news and DMs again", async () => {
    const stamp = hoursAgo(5);
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, stamp);
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(true);
    expect(await stages()).toEqual(["quote_ttl", "quote_ttl"]);

    // Narrowing the horizon stands in for hours passing. The STAMP must not
    // move: a new stamp would be a different episode by definition, and what is
    // under test is one outage crossing a second threshold.
    await setSetting(prisma, FX_RATE_MAX_AGE_HOURS_KEY, "4");
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(true);
    expect(await stages()).toEqual(["quote_ttl", "quote_ttl", "max_age", "max_age"]);

    // …and that second stage then goes quiet too.
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(false);
    expect(await staleDms()).toHaveLength(4);
  });

  // The stage never escalates backwards: once USDT is gone shop-wide, the DM has
  // to describe THAT, not the milder symptom that is also technically true.
  it("reports the worse stage when both thresholds are passed", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, hoursAgo(72));
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(true);
    expect(await stages()).toEqual(["max_age", "max_age"]);
    expect(await getUsdIdrRate(prisma)).toBeNull();
  });

  // Back-compat of the marker's own format: `fx_stale_alerted_for` held a bare
  // ISO stamp before stages existed, and the max-age stage still keys off one,
  // so a shop that was mid-outage when this shipped is not DMed a second time
  // about an episode it was already told about.
  it("honours a pre-existing bare-stamp marker for the outer horizon", async () => {
    const stamp = hoursAgo(72);
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, stamp);
    await setSetting(prisma, FX_STALE_ALERTED_FOR_KEY, stamp);
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(false);
    expect(await staleDms()).toHaveLength(0);
  });

  it("an unusable TTL leaves only the outer horizon, exactly as an unusable horizon leaves only the TTL", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, hoursAgo(5));
    await setSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY, ""); // the check is off
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(false);

    await setSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY, DEFAULT_FX_QUOTE_TTL_MINUTES);
    await setSetting(prisma, FX_RATE_MAX_AGE_HOURS_KEY, "abc"); // and so is this one
    expect(await alertIfUsdIdrRateStale(prisma)).toBe(true);
    expect(await stages()).toEqual(["quote_ttl", "quote_ttl"]);
  });
});

describe("enqueueAdminFxRateRejected — the DM a rejected refresh sends", () => {
  beforeEach(async () => {
    await resetDb(prisma);
    await buildSampleData(prisma);
    await setSetting(prisma, ADMIN_IDS_KEY, "4001,4002");
  });

  it("carries the reason, both figures, the rate still in effect and the failure streak", async () => {
    await enqueueAdminFxRateRejected(prisma, {
      reason: "delta_too_large",
      market: new Decimal("17500"),
      rate: new Decimal("17500"),
      saved: new Decimal("16200"),
      consecutiveFailures: 3,
      lastKnown: new Decimal("16200"),
      deltaPct: new Decimal("8.02"),
      maxDeltaPct: new Decimal("5"),
    });
    const rows = await prisma.notificationOutbox.findMany({
      where: { event: NotificationEvent.ADMIN_FX_RATE_REJECTED },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.orderId).toBeNull();
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload).toMatchObject({
      reason: "delta_too_large",
      market: "17500",
      saved: "16200",
      consecutive_failures: 3,
      last_known: "16200",
      delta_pct: "8.02",
      max_delta_pct: "5",
    });
    expect(payload.chat_id).toBeTruthy();
    // Figures that do not apply to this reason are omitted, never zeroed —
    // same rule as ADMIN_DIGIFLAZZ_RESYNC_ABORTED's payload.
    expect("min" in payload).toBe(false);
    expect("max" in payload).toBe(false);
  });

  it("reports 'no saved rate' rather than inventing one when the shop has never had a rate", async () => {
    await enqueueAdminFxRateRejected(prisma, {
      reason: "above_max",
      market: new Decimal("16200000"),
      rate: new Decimal("16200000"),
      saved: null,
      consecutiveFailures: 1,
      max: new Decimal("40000"),
    });
    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.ADMIN_FX_RATE_REJECTED },
    });
    const payload = JSON.parse(row!.payloadJson) as Record<string, unknown>;
    expect(payload.saved).toBeNull();
    expect(payload.max).toBe("40000");
  });
});

/**
 * Whole-branch review A4: the rejection alert had no dedupe, so a market source
 * stuck in one failure mode DMed every admin on every hourly tick — 48 identical
 * messages over a weekend, which is how an alert stops being read. Mirrors
 * `alertIfUsdIdrRateStale`'s episode marker exactly.
 */
describe("alertIfFxRateRejected — one admin DM per rejection episode, not per tick", () => {
  async function rejectedDmCount() {
    return prisma.notificationOutbox.count({ where: { event: NotificationEvent.ADMIN_FX_RATE_REJECTED } });
  }

  const belowMin = (n: number) => ({
    reason: { reason: "below_min", min: new Decimal("8000") } as const,
    market: new Decimal("20"),
    rate: new Decimal("0"),
    consecutiveFailures: n,
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await buildSampleData(prisma);
    await setSetting(prisma, ADMIN_IDS_KEY, "4001,4002");
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
  });

  it("alerts on the first refusal, then stays quiet on every later tick of the same episode", async () => {
    expect(await alertIfFxRateRejected(prisma, belowMin(1))).toBe(true);
    const first = await rejectedDmCount();
    expect(first).toBeGreaterThan(0);

    for (let tick = 2; tick <= 6; tick++) {
      expect(await alertIfFxRateRejected(prisma, belowMin(tick))).toBe(false);
    }
    expect(await rejectedDmCount()).toBe(first);
  });

  it("alerts again when the source changes failure mode — that is genuinely new news", async () => {
    await alertIfFxRateRejected(prisma, belowMin(1));
    const afterFirst = await rejectedDmCount();

    expect(
      await alertIfFxRateRejected(prisma, {
        reason: {
          reason: "delta_too_large",
          // `subject` is the figure whose move was measured — the pre-spread
          // market rate, matching `market` below (D10). With no spread set the
          // two happen to be equal, which is why the saved rate is not here.
          subject: new Decimal("17500"),
          lastKnown: new Decimal("16000"),
          deltaPct: new Decimal("9.4"),
          maxDeltaPct: new Decimal("5"),
        },
        market: new Decimal("17500"),
        rate: new Decimal("17500"),
        consecutiveFailures: 2,
      }),
    ).toBe(true);
    expect(await rejectedDmCount()).toBeGreaterThan(afterFirst);
  });

  it("re-arms after a confirmed refresh, so a LATER episode gets its own DM", async () => {
    await alertIfFxRateRejected(prisma, belowMin(1));
    const afterFirst = await rejectedDmCount();

    setFxRateFetcher(async () => new Decimal("16243.7"));
    await refreshUsdIdrRate(prisma, { force: true });
    expect(await getSetting(prisma, FX_REJECTED_ALERTED_FOR_KEY)).toBe("");

    expect(await alertIfFxRateRejected(prisma, belowMin(1))).toBe(true);
    expect(await rejectedDmCount()).toBeGreaterThan(afterFirst);
  });

  it("re-arms when an ADMIN fixes the rate by hand, and stops the streak counter lying", async () => {
    await setSetting(prisma, FX_REFRESH_FAILURES_KEY, "7");
    await alertIfFxRateRejected(prisma, belowMin(7));
    expect(await getSetting(prisma, FX_REJECTED_ALERTED_FOR_KEY)).toBe("below_min");

    // The documented fix for a refresh the sanity band keeps refusing: type the
    // rate in. That ends the streak as surely as a market refresh would.
    await setUsdIdrRate(prisma, "16500");
    expect(await getSetting(prisma, FX_REFRESH_FAILURES_KEY)).toBe("0");
    expect(await getSetting(prisma, FX_REJECTED_ALERTED_FOR_KEY)).toBe("");
    expect(await getSetting(prisma, FX_STALE_ALERTED_FOR_KEY)).toBe("");

    const afterFirst = await rejectedDmCount();
    expect(await alertIfFxRateRejected(prisma, belowMin(1))).toBe(true);
    expect(await rejectedDmCount()).toBeGreaterThan(afterFirst);
  });

  it("carries the same payload the job used to build inline", async () => {
    await alertIfFxRateRejected(prisma, {
      reason: {
        reason: "delta_too_large",
        subject: new Decimal("17500"), // the market figure whose move was measured (D10)
        lastKnown: new Decimal("16200"),
        deltaPct: new Decimal("8.0234"),
        maxDeltaPct: new Decimal("5"),
      },
      market: new Decimal("17500"),
      rate: new Decimal("17500"),
      consecutiveFailures: 3,
    });
    const row = await prisma.notificationOutbox.findFirst({
      where: { event: NotificationEvent.ADMIN_FX_RATE_REJECTED },
    });
    expect(JSON.parse(row!.payloadJson)).toMatchObject({
      reason: "delta_too_large",
      market: "17500",
      rate: "17500",
      saved: "16000", // the rate still pricing orders, read with allowStale
      consecutive_failures: 3,
      last_known: "16200",
      delta_pct: "8.02", // rounded to 2dp for the DM, as the job did
      max_delta_pct: "5",
    });
  });
});

// ---- M12 / audit P0-2: how fresh is the shop's own rate? --------------------

describe("usd_idr_rate_updated_at — when the rate's freshness is re-stamped", () => {
  it("setUsdIdrRate writes the value and its freshness stamp together", async () => {
    const before = Date.now();
    await setUsdIdrRate(prisma, new Decimal("16500"));
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16500");
    const stamp = await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY);
    expect(stamp).toBeTruthy();
    expect(Date.parse(stamp!)).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("an 'updated' refresh stamps the rate as freshly confirmed", async () => {
    const before = Date.now();
    expect((await refreshUsdIdrRate(prisma)).status).toBe("updated");
    const stamp = await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY);
    expect(stamp).toBeTruthy();
    expect(Date.parse(stamp!)).toBeGreaterThanOrEqual(before - 1_000);
  });

  // An "unchanged" outcome is a real re-confirmation against the market — the
  // rate was fetched and compared, it simply had not moved — so it refreshes
  // the freshness claim exactly like a changed value does.
  it("an 'unchanged' refresh re-stamps freshness even though the number did not move", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16200");
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, new Date(Date.now() - 86_400_000).toISOString());
    const before = Date.now();
    expect((await refreshUsdIdrRate(prisma)).status).toBe("unchanged");
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16200"); // value untouched
    expect(Date.parse((await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY))!)).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("a 'disabled' refresh checks nothing, so it claims no freshness", async () => {
    await setSetting(prisma, USD_IDR_RATE_AUTO_KEY, "false");
    const stale = new Date(Date.now() - 86_400_000).toISOString();
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, stale);
    expect((await refreshUsdIdrRate(prisma)).status).toBe("disabled");
    expect(await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY)).toBe(stale);
  });

  it("a failing fetch leaves both the rate and its freshness stamp alone", async () => {
    await setSetting(prisma, USD_IDR_RATE_KEY, "16000");
    const stale = new Date(Date.now() - 86_400_000).toISOString();
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, stale);
    setFxRateFetcher(async () => {
      throw new Error("network down");
    });
    await expect(refreshUsdIdrRate(prisma, { force: true })).rejects.toThrow();
    expect(await getSetting(prisma, USD_IDR_RATE_KEY)).toBe("16000");
    expect(await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY)).toBe(stale);
  });
});

/**
 * M12 / audit P0-2 — the FX quote TTL.
 *
 * Same contract as M11's rail-minimum guard right beside it in
 * `finalizeOrderPayment`: a rejected order must come back exactly as its
 * creator left it, so every rejection case re-reads the row and compares it
 * field by field against the snapshot taken before the call.
 */
describe("finalizeOrderPayment — refuses to convert at a rate nobody has confirmed lately", () => {
  let sample: SampleData;
  let orderId: number;

  /** Every field finalizeOrderPayment is capable of writing. */
  async function paymentFieldsOf(id: number) {
    const o = await prisma.order.findUniqueOrThrow({ where: { id } });
    return {
      currency: o.currency,
      fxRate: o.fxRate === null ? null : o.fxRate.toString(),
      paymentMethod: o.paymentMethod,
      uniqueCents: o.uniqueCents.toString(),
      totalAmount: o.totalAmount.toString(),
      paymentRef: o.paymentRef,
      expiresAt: o.expiresAt === null ? null : o.expiresAt.toISOString(),
    };
  }

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
    // Same reason as the sibling describes above: the fixture SKU's Rp5 would
    // convert to 0.0 USDT and trip M11's guard before this one is reached.
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "80000" } });
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const created = await createOrderFromCart(prisma, { user: sample.user });
    orderId = created!.id;
  });

  it("rejects a quote older than the default TTL and leaves the order row untouched", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(Number(DEFAULT_FX_QUOTE_TTL_MINUTES) + 5));
    const before = await paymentFieldsOf(orderId);
    await expect(
      finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" }),
    ).rejects.toMatchObject({ key: "error.fx_quote_expired" });
    expect(await paymentFieldsOf(orderId)).toEqual(before);
  });

  it("honors a custom fx_quote_ttl_minutes", async () => {
    await setSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY, "10");
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(30));
    const before = await paymentFieldsOf(orderId);
    await expect(
      finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" }),
    ).rejects.toMatchObject({ key: "error.fx_quote_expired" });
    expect(await paymentFieldsOf(orderId)).toEqual(before);

    // …and the same age passes once the TTL is widened past it.
    await setSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY, "120");
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" });
    expect(order!.currency).toBe("USDT");
  });

  it("accepts a quote inside the TTL", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(5));
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" });
    expect(order!.currency).toBe("USDT");
    expect(new Decimal(order!.fxRate!).equals(16000)).toBe(true);
  });

  // The deliberate grace path: a shop that has not written the stamp yet has an
  // UNKNOWN freshness, not a stale one, and must not be refused.
  it("accepts when the freshness stamp has never been written", async () => {
    expect(await getSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY)).toBeNull();
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" });
    expect(order!.currency).toBe("USDT");
  });

  it("accepts when the stamp is unreadable — an unparseable value is still not proof of staleness", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, "not a timestamp");
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "USDT", rate: "16000" });
    expect(order!.currency).toBe("USDT");
  });

  it("a blank or non-positive fx_quote_ttl_minutes turns the check off rather than expiring everything", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(60 * 24 * 30));
    for (const ttl of ["", "0", "-5", "abc"]) {
      await setSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY, ttl);
      await addToCart(prisma, sample.user.id, sample.product.id, 1);
      const fresh = (await createOrderFromCart(prisma, { user: sample.user }))!;
      const order = await finalizeOrderPayment(prisma, fresh.id, { currency: "USDT", rate: "16000" });
      expect(order!.currency, `ttl ${JSON.stringify(ttl)} should disable the check`).toBe("USDT");
    }
  });

  // The IDR rail derives nothing from the exchange rate, so a stale quote is
  // none of its business.
  it("never blocks an IDR order, however stale the rate is", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(60 * 24 * 30));
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "IDR" });
    expect(order!.currency).toBe("IDR");
  });

  /**
   * Whole-branch review A2: the checkout rail lists (the bot's `offerableRails`,
   * the storefront's `checkoutView`) hide their USDT options by asking
   * `usdIdrQuoteIsFresh`. It has to answer the same question the guard above
   * enforces for every input, or a list and a guard drift apart again — M11's
   * lesson, re-learned. Asserted as a PAIR per case rather than separately, so
   * neither side can be changed without the other.
   */
  it("usdIdrQuoteIsFresh agrees with the guard on every input the guard sees", async () => {
    // One order per case, and the fixture ships 5 stock items.
    await bulkAddStock(
      prisma,
      sample.product.id,
      Array.from({ length: 12 }, (_, i) => `ttlcase${i}@example.com:pwd`),
    );
    const guardAccepts = async () => {
      await addToCart(prisma, sample.user.id, sample.product.id, 1);
      const fresh = (await createOrderFromCart(prisma, { user: sample.user }))!;
      try {
        await finalizeOrderPayment(prisma, fresh.id, { currency: "USDT", rate: "16000" });
        return true;
      } catch {
        return false;
      }
    };

    const cases: Array<{ stamp: string | null; ttl: string | null; fresh: boolean }> = [
      { stamp: null, ttl: null, fresh: true }, // no stamp: freshness unknown, allowed
      { stamp: "not a timestamp", ttl: null, fresh: true }, // unreadable: likewise
      { stamp: minutesAgo(5), ttl: null, fresh: true },
      { stamp: minutesAgo(Number(DEFAULT_FX_QUOTE_TTL_MINUTES) + 5), ttl: null, fresh: false },
      { stamp: minutesAgo(30), ttl: "10", fresh: false },
      { stamp: minutesAgo(30), ttl: "120", fresh: true },
      { stamp: minutesAgo(60 * 24 * 30), ttl: "", fresh: true }, // unusable TTL = no TTL
      { stamp: minutesAgo(60 * 24 * 30), ttl: "0", fresh: true },
      { stamp: minutesAgo(60 * 24 * 30), ttl: "abc", fresh: true },
    ];

    for (const c of cases) {
      const label = `stamp ${JSON.stringify(c.stamp)} / ttl ${JSON.stringify(c.ttl)}`;
      if (c.stamp === null) await prisma.setting.deleteMany({ where: { key: USD_IDR_RATE_UPDATED_AT_KEY } });
      else await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, c.stamp);
      if (c.ttl === null) await prisma.setting.deleteMany({ where: { key: FX_QUOTE_TTL_MINUTES_KEY } });
      else await setSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY, c.ttl);
      __clearSettingsCacheForTests(prisma);

      expect(await usdIdrQuoteIsFresh(prisma), `predicate, ${label}`).toBe(c.fresh);
      expect(await guardAccepts(), `guard, ${label}`).toBe(c.fresh);
    }
  });
});

describe("finalizeOrderPayment — PaymentChoice widening (PAYDISINI/NOWPAYMENTS)", () => {
  let sample: SampleData;
  let orderId: number;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
    // M11: the fixture SKU costs Rp5, which converts to 0.0 USDT at the 16000
    // rate these cases use — and finalizeOrderPayment now refuses to put a
    // nothing-to-collect total on a gateway. Price it realistically; every
    // assertion below is about which fields get stamped, not about the amount.
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "80000" } });
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const created = await createOrderFromCart(prisma, { user: sample.user });
    orderId = created!.id;
  });

  it("regression: IDR with no method still stamps TOKOPAY (existing callers unaffected)", async () => {
    const order = await finalizeOrderPayment(prisma, orderId, { currency: "IDR" });
    expect(order!.paymentMethod).toBe(PaymentMethod.TOKOPAY);
    expect(new Decimal(order!.uniqueCents).equals(0)).toBe(true);
  });

  it("IDR + method: PAYDISINI stamps PAYDISINI with unique cents stripped", async () => {
    const order = await finalizeOrderPayment(prisma, orderId, {
      currency: "IDR",
      method: PaymentMethod.PAYDISINI,
    });
    expect(order!.paymentMethod).toBe(PaymentMethod.PAYDISINI);
    expect(new Decimal(order!.uniqueCents).equals(0)).toBe(true);
  });

  it("USDT + method: NOWPAYMENTS stamps NOWPAYMENTS, sets the NOWPayments window, no paymentRef", async () => {
    const before = Date.now();
    const order = await finalizeOrderPayment(prisma, orderId, {
      currency: "USDT",
      rate: "16000",
      method: PaymentMethod.NOWPAYMENTS,
    });
    expect(order!.paymentMethod).toBe(PaymentMethod.NOWPAYMENTS);
    expect(order!.paymentRef).toBeNull();
    expect(order!.expiresAt).not.toBeNull();
    const expectedMs =
      before + config.NOWPAYMENTS_PAYMENT_WINDOW_MINUTES * 60_000;
    const actualMs = order!.expiresAt!.getTime();
    // Allow a small skew for test execution time between `before` and the call.
    expect(Math.abs(actualMs - expectedMs)).toBeLessThan(5_000);
  });
});

describe("finalizeOrderPayment — WALLET method never attaches unique cents", () => {
  let sample: SampleData;
  let orderId: number;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    const created = await createOrderFromCart(prisma, { user: sample.user });
    orderId = created!.id;
  });

  it("IDR + method: WALLET strips unique cents (same as the no-method default)", async () => {
    const order = await finalizeOrderPayment(prisma, orderId, {
      currency: "IDR",
      method: PaymentMethod.WALLET,
    });
    expect(order!.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(new Decimal(order!.uniqueCents).equals(0)).toBe(true);
  });

  it("USDT + method: WALLET stays at exactly the converted total even with USE_UNIQUE_CENTS on", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      const order = await finalizeOrderPayment(prisma, orderId, {
        currency: "USDT",
        rate: "16000",
        method: PaymentMethod.WALLET,
      });
      expect(order!.paymentMethod).toBe(PaymentMethod.WALLET);
      expect(new Decimal(order!.uniqueCents).equals(0)).toBe(true);
      expect(new Decimal(order!.totalAmount).equals(usdtFromIdr(new Decimal("5.00"), "16000"))).toBe(true);
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });
});

// Checkout-4's collision-avoidance generalized from a BYBIT-only literal to
// `paymentMethod: method` so it covers BYBIT_BSC too. These prove the pool
// scoping is genuinely per-method: a same-amount pending order under the
// OTHER Bybit rail must never be treated as a collision, while one under the
// SAME rail still is.
describe("finalizeOrderPayment — BYBIT vs BYBIT_BSC collision-avoidance is scoped per method", () => {
  let sample: SampleData;

  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
    // M11: see the sibling describe above — Rp5 converts to 0.0 USDT at this
    // rate, which finalizeOrderPayment now refuses. The collision-avoidance
    // behaviour under test is unaffected by the size of the amount.
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "80000" } });
  });

  async function makeOrder() {
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    return (await createOrderFromCart(prisma, { user: sample.user }))!;
  }

  /** What finalizeOrderPayment computes on its FIRST attempt, before any
   * collision-avoidance retry — matches its own baseIdr/usdt/cents math. */
  function firstAttemptTotal(order: { totalAmount: Decimal.Value; uniqueCents: Decimal.Value; id: number }, rate: Decimal.Value) {
    const baseIdr = new Decimal(order.totalAmount).minus(order.uniqueCents);
    return usdtFromIdr(baseIdr, rate).plus(computeUniqueCents(order.id));
  }

  it("a same-amount pending order under the OTHER Bybit method never triggers a bump", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      const target = await makeOrder();
      const rate = new Decimal("16000");
      const expectedTotal = firstAttemptTotal(target, rate);

      // Seed a PENDING, not-expired BYBIT order with the EXACT amount
      // BYBIT_BSC's first attempt will compute — without per-method scoping
      // this would force target's totalAmount to bump away from it.
      const decoy = await makeOrder();
      await prisma.order.update({
        where: { id: decoy.id },
        data: { paymentMethod: PaymentMethod.BYBIT, currency: "USDT", totalAmount: expectedTotal, expiresAt: new Date(Date.now() + 60_000) },
      });

      const finalized = await finalizeOrderPayment(prisma, target.id, { currency: "USDT", rate, method: PaymentMethod.BYBIT_BSC });
      expect(new Decimal(finalized!.totalAmount).equals(expectedTotal)).toBe(true);
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });

  it("control: a same-amount pending order under the SAME method does trigger a bump", async () => {
    const original = config.USE_UNIQUE_CENTS;
    config.USE_UNIQUE_CENTS = true;
    try {
      const target = await makeOrder();
      const rate = new Decimal("16000");
      const expectedTotal = firstAttemptTotal(target, rate);

      const decoy = await makeOrder();
      await prisma.order.update({
        where: { id: decoy.id },
        data: { paymentMethod: PaymentMethod.BYBIT_BSC, currency: "USDT", totalAmount: expectedTotal, expiresAt: new Date(Date.now() + 60_000) },
      });

      const finalized = await finalizeOrderPayment(prisma, target.id, { currency: "USDT", rate, method: PaymentMethod.BYBIT_BSC });
      expect(new Decimal(finalized!.totalAmount).equals(expectedTotal)).toBe(false);
    } finally {
      config.USE_UNIQUE_CENTS = original;
    }
  });
});
