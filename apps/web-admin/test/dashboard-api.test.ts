import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
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
} from "@app/db";
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
});
