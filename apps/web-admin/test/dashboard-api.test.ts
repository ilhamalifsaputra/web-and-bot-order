import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { DateTime, startOfDayUtc } from "@app/core/datetime";
import {
  prisma,
  initDb,
  upsertUser,
  setSetting,
  createCategory,
  createCatalogProduct,
  createDenomination,
  bulkAddStock,
  BINANCE_UID_KEY,
  BINANCE_API_KEY_KEY,
  BINANCE_API_SECRET_KEY,
  BINANCE_POLL_HEALTH_KEY,
  POLL_HEALTH_KEYS,
  DIGIFLAZZ_USERNAME_KEY,
  DIGIFLAZZ_API_KEY_KEY,
  createRefund,
  transitionRefundStatus,
  executeRefund,
} from "@app/db";
import { RefundExecutionMethod, RefundStatus } from "@app/core/enums";
import { TOKOPAY_MERCHANT_KEY, TOKOPAY_SECRET_KEY } from "@app/core/payments/tokopay";
import { TOKOPAY_POLL_STALE_MS } from "@app/core/payments/reconcileCycleBudget";
import { resetDb } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import { makeSession, newJti, sessionJtiKey } from "../src/auth";

const ADMIN_TG = 999;
const COOKIE = config.WEB_COOKIE_NAME;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  await setSetting(prisma, "setup_completed", "true");
});

function get(url: string, withCookie: string | null) {
  return app.inject({ method: "GET", url, cookies: withCookie ? { [COOKIE]: withCookie } : {} });
}

/** A real refund payout against `orderId`, through the same
 *  createRefund → PROCESSING → executeRefund path an admin walks, so the
 *  `RefundExecution` row the KPI endpoint reads is the one production writes. */
async function payOutRefund(orderId: number, amount: string) {
  const adminId = (await prisma.user.findFirstOrThrow({ where: { telegramId: ADMIN_TG } })).id;
  const refund = await createRefund(prisma, { orderId, amount, currency: "IDR", adminId });
  await transitionRefundStatus(prisma, {
    refundId: refund.id,
    from: RefundStatus.PENDING,
    to: RefundStatus.PROCESSING,
    adminId,
  });
  return executeRefund(prisma, {
    refundId: refund.id,
    method: RefundExecutionMethod.WALLET,
    amount,
    executedBy: adminId,
  });
}

describe("GET /api/dashboard/kpis", () => {
  it("anon gets a JSON 401", async () => {
    const res = await get("/api/dashboard/kpis", null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Your session has expired. Reload the page and log in again." });
  });

  it("returns today's revenue, profit, order funnel, and pending actions", async () => {
    const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const order = await prisma.order.create({
      data: { orderCode: "ORD-1", userId: user.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() },
    });
    void order;

    const res = await get("/api/dashboard/kpis", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revenue.idr).toBe("10000");
    expect(body.revenue.usdt).toBeNull();
    expect(body.orders.total).toBe(1);
    expect(body.orders.delivered).toBe(1);
    expect(body.pendingActions).toEqual({ toReview: 0, refundDecisions: 0, failedDeliveries: 0, manualApprovals: 0 });
  });

  // Financial Ledger M6, Task 6b. Before this, a refund changed no dashboard
  // number at all: a customer paid back in full still read as full revenue. The
  // subtraction itself lives only in this route (the two crud functions just
  // report sales and payouts separately), so these two cases are the only place
  // it is exercised end to end.
  it("reports today's refund payouts, and a net-sales figure that is gross revenue minus them", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const order = await prisma.order.create({
      data: { orderCode: "ORD-refunded", userId: buyer.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() },
    });
    await payOutRefund(order.id, "2000");

    const body = (await get("/api/dashboard/kpis", cookie)).json();
    // Gross is untouched — "Revenue Today" IS the gross figure, by definition.
    expect(body.revenue.idr).toBe("10000");
    expect(body.refunds).toEqual({ idr: "2000", usdt: null });
    expect(body.netSales).toEqual({ idr: "8000", usdt: null });
  });

  it("reports a NEGATIVE net-sales figure rather than clamping it, when today's payouts are for an order sold on an earlier day", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const yesterday = new Date(Date.now() - 86_400_000);
    const order = await prisma.order.create({
      data: { orderCode: "ORD-old", userId: buyer.id, subtotalAmount: "5000", totalAmount: "5000", currency: "IDR", status: "DELIVERED", deliveredAt: yesterday },
    });
    await payOutRefund(order.id, "2000");

    const body = (await get("/api/dashboard/kpis", cookie)).json();
    // Nothing was SOLD today, but Rp2000 really did leave the shop today.
    expect(body.revenue.idr).toBeNull();
    expect(body.refunds).toEqual({ idr: "2000", usdt: null });
    // -2000, not 0: clamping this would hide a real day of money going out.
    expect(body.netSales).toEqual({ idr: "-2000", usdt: null });
  });

  // Regression, Task 6b fix (C1): a full refund moves the order out of
  // DELIVERED into REFUNDED (executeRefund), so it leaves "Revenue Today"
  // entirely. Net Sales used to subtract the payout from a gross figure the
  // sale had already left, charging the same refund twice and reporting
  // -Rp10.000 for a day that genuinely netted zero. Net Sales now reads its own
  // gross basis, which still contains the refunded sale.
  it("nets a same-day FULL refund to zero rather than fabricating a negative figure", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const order = await prisma.order.create({
      data: { orderCode: "ORD-fullrefund", userId: buyer.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() },
    });
    await payOutRefund(order.id, "10000");
    // The premise of the bug: the order really is no longer DELIVERED.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");

    const body = (await get("/api/dashboard/kpis", cookie)).json();
    // "Revenue Today" is delivered-only and stays that way — unchanged by this
    // fix, and correctly empty now that the only order of the day is refunded.
    expect(body.revenue.idr).toBeNull();
    expect(body.refunds).toEqual({ idr: "10000", usdt: null });
    // Zero, rendered as null by this endpoint's own zero-means-null convention:
    // exactly as much was sold today as was handed back. Never "-10000".
    expect(body.netSales).toEqual({ idr: null, usdt: null });
  });

  it("puts every status the delivered/pending/failed buckets skip into `other`, so the parts always sum to the total", async () => {
    const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const statuses = [
      "DELIVERED",
      "PENDING_PAYMENT",
      "UNDERPAID",
      "CANCELLED",
      "FAILED",
      // None of these five belong to delivered/pending/failed:
      "PAID",
      "CONFIRMED",
      "PROCESSING",
      "REFUNDED",
      "EXPIRED",
    ];
    for (const [i, status] of statuses.entries()) {
      await prisma.order.create({
        data: { orderCode: `ORD-S${i}`, userId: user.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status },
      });
    }
    // A settled wallet top-up is not a product order and must not enter any bucket.
    await prisma.order.create({
      data: { orderCode: "ORD-TOPUP", userId: user.id, subtotalAmount: "50000", totalAmount: "50000", currency: "IDR", status: "DELIVERED", kind: "WALLET_TOPUP" },
    });

    const { orders } = (await get("/api/dashboard/kpis", cookie)).json();
    expect(orders).toEqual({ total: 10, delivered: 1, pending: 2, failed: 2, other: 5 });
    expect(orders.total).toBe(orders.delivered + orders.pending + orders.failed + orders.other);
  });

  it("does not repeat the USDT figure under a second, fabricated USD label", async () => {
    const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({
      data: { orderCode: "ORD-U", userId: user.id, subtotalAmount: "1", totalAmount: "20.25", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: new Date() },
    });
    const { revenue } = (await get("/api/dashboard/kpis", cookie)).json();
    expect(revenue.usdt).toBe("20.25");
    expect(revenue).not.toHaveProperty("usd");
  });

  describe("revenue trend vs the same clock time yesterday", () => {
    const yesterday = () => new Date(startOfDayUtc(new Date(Date.now() - 86_400_000)).getTime() + 1);

    async function seedRevenue(user: { id: number }, code: string, amount: string, deliveredAt: Date) {
      await prisma.order.create({
        data: { orderCode: code, userId: user.id, subtotalAmount: amount, totalAmount: amount, currency: "IDR", status: "DELIVERED", deliveredAt },
      });
    }

    it("reports the percentage when yesterday's base is large enough to compare against", async () => {
      const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
      await seedRevenue(user, "ORD-Y", "50000", yesterday());
      await seedRevenue(user, "ORD-T", "75000", new Date());
      const { revenue } = (await get("/api/dashboard/kpis", cookie)).json();
      expect(revenue.trendPct.idr).toBe("50");
    });

    it("suppresses the percentage when yesterday's base is below the comparison floor, instead of showing an absurd figure", async () => {
      const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
      await seedRevenue(user, "ORD-Y", "500", yesterday());
      await seedRevenue(user, "ORD-T", "75000", new Date());
      const { revenue } = (await get("/api/dashboard/kpis", cookie)).json();
      expect(revenue.idr).toBe("75000");
      expect(revenue.trendPct.idr).toBeNull();
    });

    it("suppresses the percentage when there was no revenue yesterday at all", async () => {
      const user = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
      await seedRevenue(user, "ORD-T", "75000", new Date());
      const { revenue } = (await get("/api/dashboard/kpis", cookie)).json();
      expect(revenue.trendPct.idr).toBeNull();
    });
  });
});

describe("GET /api/dashboard/operations", () => {
  it("anon gets a JSON 401", async () => {
    const res = await get("/api/dashboard/operations", null);
    expect(res.statusCode).toBe(401);
  });

  it("reports the operation-center counts", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-pp", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "PENDING_PAYMENT" } });
    await prisma.order.create({ data: { orderCode: "ORD-proc", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "PAID" } });

    const res = await get("/api/dashboard/operations", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pendingPayments: 1, ordersProcessing: 1 });
  });

  // awaitingFulfillment (new manual-fulfilment queue, status PROCESSING) is
  // deliberately distinct from ordersProcessing (the pre-existing
  // CONFIRMED/PAID payment-gateway metric asserted above) — both must be
  // reported side by side without colliding.
  it("reports awaitingFulfillment (PROCESSING) separately from the unrelated ordersProcessing (CONFIRMED/PAID)", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-await", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "PROCESSING" } });
    await prisma.order.create({ data: { orderCode: "ORD-proc", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "PAID" } });

    const res = await get("/api/dashboard/operations", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ awaitingFulfillment: 1, ordersProcessing: 1 });
  });

  // Task 47 audit: confirms manualMatchQueueCounts (which drives this
  // failedDeliveries figure) already sums delivery_failed rows across every
  // non-Binance gateway table too — there is no sixth `processedBybitBscTx`
  // table missing from the sum; ProcessedBybitTx already covers both Bybit
  // sub-rails (see reports.ts's LedgerGateway doc comment). This guards
  // against that regressing, it does not fix a bug here.
  it("failedDeliveries sums delivery_failed rows across every gateway table, not just Binance", async () => {
    await prisma.processedTokopayTx.create({ data: { trxId: "TP-DF-1", amount: "1", outcome: "delivery_failed" } });
    await prisma.processedBybitTx.create({ data: { bybitTxId: "BY-DF-1", amount: "1", outcome: "delivery_failed" } });

    const res = await get("/api/dashboard/operations", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ failedDeliveries: 2 });
  });
});

describe("GET /api/dashboard/inventory", () => {
  it("anon gets a JSON 401", async () => {
    const res = await get("/api/dashboard/inventory", null);
    expect(res.statusCode).toBe(401);
  });

  it("lists denominations at or below the threshold", async () => {
    const category = await createCategory(prisma, "Cat");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, { productId: parent.id, name: "Low item", type: "SHARED", durationLabel: "1 Month", price: "1" });
    await bulkAddStock(prisma, denom.id, ["a@b.com:pw"]);

    const res = await get("/api/dashboard/inventory?threshold=3", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ denominationId: denom.id, productName: "Low item", available: 1, threshold: 3 }]);
  });
});

describe("GET /api/dashboard/expirations", () => {
  it("anon gets a JSON 401", async () => {
    const res = await get("/api/dashboard/expirations", null);
    expect(res.statusCode).toBe(401);
  });

  it("lists order items whose warranty expires within the window", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const category = await createCategory(prisma, "Cat");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, { productId: parent.id, name: "Expiring item", type: "SHARED", durationLabel: "1 Month", price: "1", warrantyDays: 1 });
    const deliveredAt = new Date(); // expires in 1 day, well inside a 7-day window
    const order = await prisma.order.create({ data: { orderCode: "ORD-exp", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED", deliveredAt } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: denom.id, quantity: 1, unitPrice: "1", warrantyDaysSnapshot: 1 } });

    const res = await get("/api/dashboard/expirations?withinDays=7", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ orderId: order.id, orderCode: "ORD-exp", productName: "Expiring item", customerLabel: "buyer" });
  });
});

describe("GET /api/dashboard/orders/recent", () => {
  it("anon gets a JSON 401", async () => {
    const res = await get("/api/dashboard/orders/recent", null);
    expect(res.statusCode).toBe(401);
  });

  it("returns the newest orders first", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "1", status: "DELIVERED" } });

    const res = await get("/api/dashboard/orders/recent?limit=5", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});

describe("GET /api/dashboard/health", () => {
  it("anon gets a JSON 401", async () => {
    const res = await get("/api/dashboard/health", null);
    expect(res.statusCode).toBe(401);
  });

  it("reports the bot token-present flag and an unmonitored status for unhealthed providers", async () => {
    const res = await get("/api/dashboard/health", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // setup-env.ts sets BOT_TOKEN to a non-blank test value and resetDb()
    // clears any Settings-row override, so resolveBotCredentials() falls
    // through to that env token — "green", not "red" — in this test env.
    expect(body.telegramBot.status).toBe("green");
    expect(body.bybit.status).toBe("unmonitored");
    expect(body.bybitBsc.status).toBe("unmonitored");
    expect(body.tokopay.status).toBe("unmonitored");
    expect(body.paydisini.status).toBe("unmonitored");
    expect(body.nowpayments.status).toBe("unmonitored");
    expect(body.digiflazzCatalogSync.status).toBe("unmonitored");
  });

  it("reports digiflazzCatalogSync as green when configured and a recent heartbeat is recorded, red when stale", async () => {
    await setSetting(prisma, DIGIFLAZZ_USERNAME_KEY, "shopuser");
    await setSetting(prisma, DIGIFLAZZ_API_KEY_KEY, "shopkey");
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.digiflazzCatalogSync,
      JSON.stringify({ lastRun: new Date().toISOString(), consecutiveFailures: 0 }),
    );

    const healthy = await get("/api/dashboard/health", cookie);
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json().digiflazzCatalogSync.status).toBe("green");

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.digiflazzCatalogSync,
      JSON.stringify({ lastRun: twoHoursAgo, consecutiveFailures: 0 }),
    );

    const stale = await get("/api/dashboard/health", cookie);
    expect(stale.statusCode).toBe(200);
    expect(stale.json().digiflazzCatalogSync.status).toBe("red");
  });

  // Regression guard (review finding): the hourly catalog re-sync's
  // heartbeat is written once per COMPLETED run, not continuously, so
  // evaluatePollHealth's 5-minute crypto-rail default would flip this card
  // red for the ordinary ~55-minute gap between two healthy hourly runs.
  // 40 minutes past the last run is deep in that ordinary gap (well past
  // the old 5-minute default, well short of the next hourly run) — this
  // must still read green under the corrected staleMs.
  it("reports digiflazzCatalogSync as green 40 minutes after a healthy hourly run (mid-cycle, not just at connect time)", async () => {
    await setSetting(prisma, DIGIFLAZZ_USERNAME_KEY, "shopuser");
    await setSetting(prisma, DIGIFLAZZ_API_KEY_KEY, "shopkey");
    const fortyMinutesAgo = new Date(Date.now() - 40 * 60_000).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.digiflazzCatalogSync,
      JSON.stringify({ lastRun: fortyMinutesAgo, consecutiveFailures: 0 }),
    );

    const res = await get("/api/dashboard/health", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().digiflazzCatalogSync.status).toBe("green");
  });

  // The headline bug this task fixes: a poller that is enabled but has gone
  // stale silently (lastRun hours old, consecutiveFailures still 0 because it
  // never got to run again) read "green" on this endpoint while the watchdog
  // was simultaneously paging admins about the same poller. Today this
  // asserts "green" — evaluatePollHealth's staleness rule (Rule 5) is what
  // must turn it "red".
  it("reports an enabled poller whose last cycle is two hours old as red, not green", async () => {
    await setSetting(prisma, BINANCE_UID_KEY, "test-uid");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "test-key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "test-secret");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await setSetting(
      prisma,
      BINANCE_POLL_HEALTH_KEY,
      JSON.stringify({ lastRun: twoHoursAgo, consecutiveFailures: 0 }),
    );

    const res = await get("/api/dashboard/health", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.binance.status).toBe("red");
  });

  // Review finding on this task: the old endpoint tested `backoffUntil` for
  // truthiness rather than expiry, so an expired backoff stamp still read
  // yellow until the next successful cycle nulled it out. evaluatePollHealth's
  // Rule 2 is expiry-aware (`backoffUntil > now`), so an expired stamp must
  // fall through to the healthy rule instead.
  //
  // lastRun is set to "just now" so Rule 5 (staleness) cannot fire, and
  // consecutiveFailures is 0 so neither Rule 4 (paging failure threshold) nor
  // Rule 6 (yellow single-failure tier) can fire either — only Rule 2
  // (backoff) is left able to produce anything other than green.
  it("reports an enabled poller with an expired backoff stamp as green, not yellow", async () => {
    await setSetting(prisma, BINANCE_UID_KEY, "test-uid");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "test-key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "test-secret");
    const justNow = new Date(Date.now() - 5_000).toISOString();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await setSetting(
      prisma,
      BINANCE_POLL_HEALTH_KEY,
      JSON.stringify({ lastRun: justNow, backoffUntil: tenMinutesAgo, consecutiveFailures: 0 }),
    );

    const res = await get("/api/dashboard/health", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.binance.status).toBe("green");
  });

  // Mirror case, pinned alongside the expired-backoff fix above since it's
  // cheap: a backoff window still in the future is an intentional pause and
  // must keep reading yellow, not fall through to green.
  it("reports an enabled poller with a still-active backoff stamp as yellow", async () => {
    await setSetting(prisma, BINANCE_UID_KEY, "test-uid");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "test-key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "test-secret");
    const justNow = new Date(Date.now() - 5_000).toISOString();
    const tenMinutesFromNow = new Date(Date.now() + 10 * 60_000).toISOString();
    await setSetting(
      prisma,
      BINANCE_POLL_HEALTH_KEY,
      JSON.stringify({ lastRun: justNow, backoffUntil: tenMinutesFromNow, consecutiveFailures: 0 }),
    );

    const res = await get("/api/dashboard/health", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.binance.status).toBe("yellow");
  });

  // Review finding on Task 12: this endpoint used to hardcode TokoPay/
  // PayDisini/NOWPayments to evaluatePollHealth(null, { enabled: true }) —
  // always "unmonitored", no matter how dead their reconcile poller actually
  // was — because Task 6 wrote that hardcoding before Task 11 gave those
  // three rails real heartbeats. This is the TokoPay equivalent of the
  // Binance "two hours old" test above: it pins that the dashboard now reads
  // the REAL heartbeat (getPollHealth(prisma, "tokopay")) instead of the old
  // placeholder, so the Business Health card can actually turn this rail red
  // like docs/TROUBLESHOOTING.md promises.
  it("reports an enabled TokoPay poller whose last cycle is two hours old as red, not unmonitored", async () => {
    await setSetting(prisma, TOKOPAY_MERCHANT_KEY, "merchant-1");
    await setSetting(prisma, TOKOPAY_SECRET_KEY, "secret-1");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.tokopay,
      JSON.stringify({ lastRun: twoHoursAgo, lastSuccessAt: twoHoursAgo, consecutiveFailures: 0 }),
    );

    const res = await get("/api/dashboard/health", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokopay.status).toBe("red");
  });

  // The other half of the same fix: `enabled` for the three QRIS rails must
  // come from their own credentials (the same gate tokopayPollWatchdog uses),
  // not a bare `true` — a rail the shop never configured must keep reading
  // "unmonitored" even though a (stale, fabricated) heartbeat blob happens to
  // sit in Settings, e.g. left over from a merchant ID that was later cleared.
  it("reports TokoPay as unmonitored, not red, when no credentials are configured even if a stale heartbeat exists", async () => {
    // No TOKOPAY_MERCHANT_KEY/TOKOPAY_SECRET_KEY set.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.tokopay,
      JSON.stringify({ lastRun: twoHoursAgo, lastSuccessAt: twoHoursAgo, consecutiveFailures: 0 }),
    );

    const res = await get("/api/dashboard/health", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokopay.status).toBe("unmonitored");
  });

  // Whole-branch review finding (Task 13): this endpoint used to call
  // evaluatePollHealth(tokopayHealth, { enabled: tokopayEnabled }) with no
  // `staleMs`, so it applied the crypto rails' 5-minute default to TokoPay
  // too — even though tokopayPollWatchdog (apps/order-bot/src/jobs/index.ts)
  // uses a much wider ~820s threshold (TOKOPAY_POLL_STALE_MS) because one
  // TokoPay reconcile cycle can legitimately make up to 50 sequential,
  // individually-timed-out gateway calls. A webhook outage plus a slow
  // gateway can make a genuinely healthy cycle take 8 minutes — past the
  // 5-minute default, comfortably inside TokoPay's real threshold. Before
  // the fix, the card read red ("the poller appears stuck or stopped")
  // while the watchdog correctly stayed silent — the exact three-consumers-
  // three-rules divergence this branch's P1 exists to prevent, reappearing
  // at the seam between the watchdog task and this dashboard task.
  it("reports an enabled TokoPay poller whose last cycle is 8 minutes old as healthy, not red, because that is within TokoPay's own wider staleness window", async () => {
    await setSetting(prisma, TOKOPAY_MERCHANT_KEY, "merchant-1");
    await setSetting(prisma, TOKOPAY_SECRET_KEY, "secret-1");
    const eightMinutesAgo = new Date(Date.now() - 8 * 60_000).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.tokopay,
      JSON.stringify({ lastRun: eightMinutesAgo, lastSuccessAt: eightMinutesAgo, consecutiveFailures: 0 }),
    );

    const res = await get("/api/dashboard/health", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokopay.status).not.toBe("red");
    expect(body.tokopay.status).toBe("green");
  });

  // Mirror of the test above: once a TokoPay cycle really is older than its
  // OWN widened staleness threshold (not the crypto rails' 5-minute default),
  // the card must still turn red — the fix must not silence a genuine hang,
  // only stop paging on ordinary slowness.
  it("reports an enabled TokoPay poller as red once its last cycle is older than its own widened staleness threshold", async () => {
    await setSetting(prisma, TOKOPAY_MERCHANT_KEY, "merchant-1");
    await setSetting(prisma, TOKOPAY_SECRET_KEY, "secret-1");
    const staleAt = new Date(Date.now() - (TOKOPAY_POLL_STALE_MS + 5_000)).toISOString();
    await setSetting(
      prisma,
      POLL_HEALTH_KEYS.tokopay,
      JSON.stringify({ lastRun: staleAt, lastSuccessAt: staleAt, consecutiveFailures: 0 }),
    );

    const res = await get("/api/dashboard/health", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokopay.status).toBe("red");
  });
});

describe("GET /api/dashboard/top-products", () => {
  it("anon gets a JSON 401", async () => {
    const res = await get("/api/dashboard/top-products", null);
    expect(res.statusCode).toBe(401);
  });

  it("returns delivered products ranked by units sold", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const category = await createCategory(prisma, "Cat");
    const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
    const denom = await createDenomination(prisma, { productId: parent.id, name: "Top item", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "5000" });
    const order = await prisma.order.create({ data: { orderCode: "ORD-top", userId: buyer.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() } });
    await prisma.orderItem.create({ data: { orderId: order.id, productId: denom.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 } });

    const res = await get("/api/dashboard/top-products?days=30&limit=5", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ productId: denom.id, productLabel: "Parent · Top item", unitsSold: 1, revenueIdrEquiv: "10000", profitIdrEquiv: "5000", costUnknownUnits: 0 }]);
  });
});

describe("GET /api/dashboard/analytics", () => {
  it("anon gets a JSON 401", async () => {
    const res = await get("/api/dashboard/analytics", null);
    expect(res.statusCode).toBe(401);
  });

  it("defaults to a 7-day IDR revenue series", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "5000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() } });

    const res = await get("/api/dashboard/analytics", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(7);
    expect(body[6].value).toBe("5000"); // today is the last bucket
  });

  it("switches to order counts when metric=orders", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "5000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() } });

    const res = await get("/api/dashboard/analytics?metric=orders", cookie);
    expect(res.json()[6].value).toBe(1);
  });

  it("counts orders of both currencies when metric=orders and currency=combined, instead of falling through to IDR only", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    const now = new Date();
    await prisma.order.create({ data: { orderCode: "ORD-I1", userId: buyer.id, subtotalAmount: "1", totalAmount: "5000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.order.create({ data: { orderCode: "ORD-I2", userId: buyer.id, subtotalAmount: "1", totalAmount: "6000", currency: "IDR", status: "DELIVERED", deliveredAt: now } });
    await prisma.order.create({ data: { orderCode: "ORD-U1", userId: buyer.id, subtotalAmount: "1", totalAmount: "3", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: now } });

    const combined = await get("/api/dashboard/analytics?metric=orders&currency=combined", cookie);
    expect(combined.json()[6].value).toBe(3);
    // The per-currency views keep their own split.
    expect((await get("/api/dashboard/analytics?metric=orders&currency=idr", cookie)).json()[6].value).toBe(2);
    expect((await get("/api/dashboard/analytics?metric=orders&currency=usdt", cookie)).json()[6].value).toBe(1);
  });

  it("switches to the IDR-equivalent combined series when currency=combined", async () => {
    const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
    await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "3", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: new Date() } });

    const res = await get("/api/dashboard/analytics?currency=combined", cookie);
    expect(res.json()[6].value).toBe("48000");
  });

  it("accepts range=30d", async () => {
    const res = await get("/api/dashboard/analytics?range=30d", cookie);
    expect(res.json()).toHaveLength(30);
  });

  // Financial Ledger M6, Task 6c — the calendar-rollup ranges and the Profit
  // metric. The bucket labels are recomputed here from the same luxon call the
  // crud layer makes, so these assertions don't expire with the calendar.
  describe("calendar ranges and the profit metric (Task 6c)", () => {
    /** A delivered sale whose denomination has a known costPrice, so the profit
     *  series has something real to report: revenue 10000 - cost 6000 = 4000. */
    async function makeSaleWithMargin() {
      const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
      const category = await createCategory(prisma, "Cat");
      const parent = await createCatalogProduct(prisma, { categoryId: category.id, name: "Parent", description: "x" });
      const denom = await createDenomination(prisma, {
        productId: parent.id, name: "Item", type: "SHARED", durationLabel: "1 Month", price: "10000", costPrice: "6000",
      });
      const order = await prisma.order.create({
        data: { orderCode: "ORD-margin", userId: buyer.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() },
      });
      await prisma.orderItem.create({
        data: { orderId: order.id, productId: denom.id, quantity: 1, unitPrice: "10000", warrantyDaysSnapshot: 30 },
      });
    }

    it("returns 12 monthly revenue buckets when range=month, labelled by calendar month", async () => {
      const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
      await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "5000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() } });

      const body = (await get("/api/dashboard/analytics?range=month", cookie)).json();
      expect(body).toHaveLength(12);
      expect(body[11].day).toBe(DateTime.utc().toFormat("yyyy-LL"));
      expect(body[11].value).toBe("5000");
    });

    it("returns 12 weekly order-count buckets when range=week&metric=orders, labelled by ISO week", async () => {
      const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
      await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "5000", currency: "IDR", status: "DELIVERED", deliveredAt: new Date() } });

      const body = (await get("/api/dashboard/analytics?range=week&metric=orders", cookie)).json();
      expect(body).toHaveLength(12);
      expect(body[11].day).toBe(DateTime.utc().toFormat("kkkk-'W'WW"));
      expect(body[11].value).toBe(1);
    });

    it("returns 5 yearly revenue buckets when range=year", async () => {
      const body = (await get("/api/dashboard/analytics?range=year", cookie)).json();
      expect(body).toHaveLength(5);
      expect(body[4].day).toBe(DateTime.utc().toFormat("yyyy"));
    });

    it("blends currencies for a calendar range when currency=combined", async () => {
      const buyer = await upsertUser(prisma, { telegramId: 42, username: "buyer", fullName: "Buyer" });
      await prisma.order.create({ data: { orderCode: "ORD-1", userId: buyer.id, subtotalAmount: "1", totalAmount: "3", currency: "USDT", fxRate: "16000", status: "DELIVERED", deliveredAt: new Date() } });

      const body = (await get("/api/dashboard/analytics?range=month&currency=combined", cookie)).json();
      expect(body[11].value).toBe("48000");
    });

    it("returns a daily profit series when metric=profit, with null for days that have no cost-known sale", async () => {
      await makeSaleWithMargin();

      const body = (await get("/api/dashboard/analytics?metric=profit", cookie)).json();
      expect(body).toHaveLength(7);
      expect(body[6].value).toBe("4000");
      // A day with nothing delivered is an absence, not a break-even day.
      expect(body[0].value).toBeNull();
    });

    it("returns a yearly profit series when range=year&metric=profit", async () => {
      await makeSaleWithMargin();

      const body = (await get("/api/dashboard/analytics?range=year&metric=profit", cookie)).json();
      expect(body).toHaveLength(5);
      expect(body[4].value).toBe("4000");
    });

    it("reports the USDT profit series when metric=profit&currency=usdt", async () => {
      await makeSaleWithMargin();

      const body = (await get("/api/dashboard/analytics?metric=profit&currency=usdt", cookie)).json();
      // The only sale settled in IDR, so the USDT series has nothing to report.
      expect(body[6].value).toBeNull();
    });

    it("falls back to the IDR profit series when metric=profit&currency=combined — there is no combined-profit figure to fabricate", async () => {
      await makeSaleWithMargin();

      const combined = (await get("/api/dashboard/analytics?metric=profit&currency=combined", cookie)).json();
      const idr = (await get("/api/dashboard/analytics?metric=profit&currency=idr", cookie)).json();
      expect(combined).toEqual(idr);
      expect(combined[6].value).toBe("4000");
    });
  });
});
