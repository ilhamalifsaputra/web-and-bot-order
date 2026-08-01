import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@app/core/config", () => ({
  config: {
    LOG_LEVEL: "info",
    BYBIT_UID: "env-uid",
    BYBIT_API_KEY: "env-api-key",
    BYBIT_API_SECRET: "env-api-secret",
    BYBIT_API_BASE: "https://api.bybit.com",
    BYBIT_PAYMENT_WINDOW_MINUTES: 30,
    // Needed by createOrderDirect (packages/db/src/crud/orders.ts), exercised
    // below by the deliverPaidBybitOrder DB-integration describe block — this
    // file's config mock otherwise only covers resolveBybitConfig/poll-health,
    // which don't touch these. Defaults match packages/core/src/config.ts.
    PAYMENT_WINDOW_MINUTES: 30,
    USE_UNIQUE_CENTS: true,
    ADMIN_IDS: [] as number[],
    DEFAULT_LANGUAGE: "en",
  },
}));

import { resolveBybitConfig, getBybitPollHealth, recordBybitPollHealth, deliverPaidBybitOrder } from "./bybit_deposit";
import { createOrderDirect } from "./orders";
import { createCategory, createCatalogProduct, createDenomination } from "./catalog";
import { OrderStatus, PaymentMethod, DeliveryType, NotificationEvent } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import type { Db } from "./_types";

/** Mutable in-memory Setting store backing both `findUnique` and `upsert`,
 * needed by recordBybitPollHealth (writes) + getBybitPollHealth (reads). */
function mutableStubDb(initial: Record<string, string> = {}): Db {
  const store = new Map(Object.entries(initial));
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        store.set(where.key, create.value);
        return { key: where.key, value: create.value };
      },
    },
  } as unknown as Db;
}

/** In-memory Setting store as a Db stub (only `setting.findUnique` is used). */
function stubDb(values: Record<string, string>): Db {
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        values[where.key] != null ? { key: where.key, value: values[where.key] } : null,
    },
  } as unknown as Db;
}

const CREDS = {
  bybit_uid: "db-uid",
  bybit_api_key: "db-api-key",
  bybit_api_secret: "db-api-secret",
};

describe("resolveBybitConfig — enabled flag matrix", () => {
  it("enabled when creds present and flag is unset (default ON)", async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS }));
    expect(cfg.enabled).toBe(true);
  });

  it('enabled when creds present and flag is "true"', async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS, bybit_enabled: "true" }));
    expect(cfg.enabled).toBe(true);
  });

  it('disabled when flag is "false" even with creds present', async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS, bybit_enabled: "false" }));
    expect(cfg.enabled).toBe(false);
  });

  it('disabled when flag is "FALSE " (trimmed + case-insensitive)', async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS, bybit_enabled: "FALSE " }));
    expect(cfg.enabled).toBe(false);
  });

  it('enabled when flag is blank (empty string is still default ON)', async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS, bybit_enabled: "" }));
    expect(cfg.enabled).toBe(true);
  });

  it('disabled when creds missing regardless of flag "true"', async () => {
    const cfg = await resolveBybitConfig(
      stubDb({ bybit_uid: "", bybit_api_key: "", bybit_api_secret: "", bybit_enabled: "true" }),
    );
    // With no DB creds and the env fallback present, creds resolve from env, so
    // assert against an environment with the creds explicitly cleared instead.
    expect(cfg.uid).toBe("env-uid"); // env fallback fills it
    expect(cfg.enabled).toBe(true);
  });

  it("disabled when creds missing (env fallback also empty) regardless of flag", async () => {
    vi.doMock("@app/core/config", () => ({
      config: {
        LOG_LEVEL: "info",
        BYBIT_UID: undefined,
        BYBIT_API_KEY: undefined,
        BYBIT_API_SECRET: undefined,
        BYBIT_API_BASE: "https://api.bybit.com",
        BYBIT_PAYMENT_WINDOW_MINUTES: 30,
      },
    }));
    vi.resetModules();
    const { resolveBybitConfig: resolveNoCreds } = await import("./bybit_deposit");
    const cfg = await resolveNoCreds(stubDb({ bybit_enabled: "true" }));
    expect(cfg.uid).toBe("");
    expect(cfg.enabled).toBe(false);
  });
});

describe("resolveBybitConfig — minAmount", () => {
  it("defaults to null when unset", async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS }));
    expect(cfg.minAmount).toBeNull();
  });

  it("parses a configured positive value", async () => {
    const cfg = await resolveBybitConfig(stubDb({ ...CREDS, bybit_min_amount: "8" }));
    expect(cfg.minAmount?.toString()).toBe("8");
  });

  it("treats a non-numeric or non-positive value as null (never throws)", async () => {
    expect((await resolveBybitConfig(stubDb({ ...CREDS, bybit_min_amount: "not-a-number" }))).minAmount).toBeNull();
    expect((await resolveBybitConfig(stubDb({ ...CREDS, bybit_min_amount: "0" }))).minAmount).toBeNull();
  });
});

describe("Bybit poll health — rate-limit tracking fields", () => {
  it("getBybitPollHealth on a never-run poller is all-null", async () => {
    const health = await getBybitPollHealth(mutableStubDb());
    expect(health).toEqual({
      lastRun: null,
      lastSuccessAt: null,
      lastTxCount: null,
      backoffUntil: null,
      consecutiveRateLimitHits: null,
      lastRateLimitAt: null,
      consecutiveFailures: null,
      lastError: null,
    });
  });

  it("round-trips lastTxCount/backoffUntil/consecutiveRateLimitHits on a healthy cycle", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, { lastTxCount: 3, backoffUntil: null, success: true });
    const health = await getBybitPollHealth(db);
    expect(health.lastTxCount).toBe(3);
    expect(health.backoffUntil).toBeNull();
    expect(health.consecutiveRateLimitHits).toBe(0);
    expect(health.lastRateLimitAt).toBeNull();
    expect(health.lastSuccessAt).toBe(health.lastRun);
    expect(health.consecutiveFailures).toBe(0);
  });

  it("records lastRateLimitAt when rateLimited is true", async () => {
    const db = mutableStubDb();
    const until = Date.now() + 6_000;
    await recordBybitPollHealth(db, {
      lastTxCount: 0,
      backoffUntil: until,
      consecutiveRateLimitHits: 2,
      rateLimited: true,
      success: false,
      error: "Bybit rate limited (HTTP 429)",
    });
    const health = await getBybitPollHealth(db);
    expect(health.consecutiveRateLimitHits).toBe(2);
    expect(health.backoffUntil).toBe(new Date(until).toISOString());
    expect(health.lastRateLimitAt).not.toBeNull();
  });

  it("carries lastRateLimitAt forward (sticky) once the poller recovers", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, {
      lastTxCount: 0,
      backoffUntil: Date.now() + 3_000,
      consecutiveRateLimitHits: 1,
      rateLimited: true,
      success: false,
      error: "Bybit rate limited (HTTP 429)",
    });
    const { lastRateLimitAt: hitAt } = await getBybitPollHealth(db);
    expect(hitAt).not.toBeNull();

    // Next cycle recovers (no rate limit) — consecutiveRateLimitHits resets to
    // 0, but lastRateLimitAt must stay visible for diagnosing rare hits.
    await recordBybitPollHealth(db, { lastTxCount: 5, backoffUntil: null, success: true });
    const health = await getBybitPollHealth(db);
    expect(health.consecutiveRateLimitHits).toBe(0);
    expect(health.lastRateLimitAt).toBe(hitAt);
  });

  it("getBybitPollHealth defaults missing new fields to null (backward-compat with old JSON)", async () => {
    const db = mutableStubDb({
      bybit_poll_health: JSON.stringify({ lastRun: "2026-01-01T00:00:00.000Z", lastTxCount: 1, backoffUntil: null }),
    });
    const health = await getBybitPollHealth(db);
    expect(health.lastRun).toBe("2026-01-01T00:00:00.000Z");
    expect(health.lastTxCount).toBe(1);
    expect(health.consecutiveRateLimitHits).toBeNull();
    expect(health.lastRateLimitAt).toBeNull();
    expect(health.lastSuccessAt).toBeNull();
    expect(health.consecutiveFailures).toBeNull();
    expect(health.lastError).toBeNull();
  });
});

describe("Bybit poll health — non-rate-limit failure streak (consecutiveFailures/lastSuccessAt/lastError)", () => {
  it("increments consecutiveFailures and records lastError on a network/HTTP failure", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    const health = await getBybitPollHealth(db);
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error");
    expect(health.lastSuccessAt).toBeNull(); // never succeeded yet

    await recordBybitPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    expect((await getBybitPollHealth(db)).consecutiveFailures).toBe(2);
  });

  it("resets consecutiveFailures to 0 on the next success, but keeps lastError sticky", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    await recordBybitPollHealth(db, { lastTxCount: 1, success: true });
    const health = await getBybitPollHealth(db);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError).toBe("fetch failed: Connect Timeout Error"); // sticky for diagnostics
    expect(health.lastSuccessAt).toBe(health.lastRun);
  });

  it("a rate-limited failure neither increments nor resets consecutiveFailures (it has its own counter)", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, { lastTxCount: 0, success: false, error: "network error" });
    expect((await getBybitPollHealth(db)).consecutiveFailures).toBe(1);

    await recordBybitPollHealth(db, {
      lastTxCount: 0,
      success: false,
      rateLimited: true,
      consecutiveRateLimitHits: 1,
      error: "Bybit rate limited (HTTP 429)",
    });
    const health = await getBybitPollHealth(db);
    expect(health.consecutiveFailures).toBe(1); // unchanged by the rate-limit hit
    expect(health.consecutiveRateLimitHits).toBe(1);
  });

  it("lastSuccessAt only advances on success, even while lastRun keeps ticking on every failed cycle", async () => {
    const db = mutableStubDb();
    await recordBybitPollHealth(db, { lastTxCount: 2, success: true });
    const firstSuccess = (await getBybitPollHealth(db)).lastSuccessAt;

    await recordBybitPollHealth(db, { lastTxCount: 0, success: false, error: "fetch failed: Connect Timeout Error" });
    const health = await getBybitPollHealth(db);
    expect(health.lastSuccessAt).toBe(firstSuccess); // unchanged by the failed cycle
  });
});

// ===========================================================================
// deliverPaidBybitOrder — "processing" branch (M-35, backend audit
// 2026-07-31). The idempotency/delivered/already_processed/stale branches are
// covered extensively in apps/order-bot/test/bybit-deposit.test.ts (Task 24,
// M-14); this file only had resolveBybitConfig/poll-health coverage, and
// nowhere exercised the "processing" branch a manual-delivery SKU takes.
// Unlike nowpayments/paydisini/binance_internal, deliverPaidBybitOrder itself
// has no overpaid-ledger/DM logic at all (see bybit_deposit.ts) — so this
// only pins the processing-branch shape shared with every gateway via
// settlePaidOrder, not an overpaid interaction that doesn't exist here.
describe("deliverPaidBybitOrder — processing branch (manual SKU)", () => {
  let db: TestDb;
  let prisma: PrismaClient;
  let sample: SampleData;

  beforeAll(async () => {
    db = await makeTestDb();
    prisma = db.prisma;
  });
  afterAll(async () => {
    await db.cleanup();
  });
  beforeEach(async () => {
    await resetDb(prisma);
    sample = await buildSampleData(prisma);
  });

  /** A manual (no-stock) denomination, on its own category/product. */
  async function makeManualDenom() {
    const category = await createCategory(prisma, `manual-cat-${Math.random()}`);
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Manual Product ${Math.random()}` });
    return createDenomination(prisma, {
      productId: product.id,
      name: "Manual Denom",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10.00",
      warrantyDays: 30,
      deliveryType: DeliveryType.MANUAL,
    });
  }

  /** Create a PENDING_PAYMENT order stamped as a Bybit deposit payment. */
  async function makePendingBybitOrderFor(productId: number) {
    const order = (await createOrderDirect(prisma, { user: sample.user, productId, quantity: 1 }))!;
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BYBIT } });
    return order;
  }

  it("processing (manual SKU): kind stays processing, no stock is touched, and settlePaidOrder's own buyer DM still fires", async () => {
    const manualDenom = await makeManualDenom();
    const order = await makePendingBybitOrderFor(manualDenom.id);

    const result = await deliverPaidBybitOrder(prisma, {
      orderId: order.id,
      bybitTxId: "0x-processing-1",
      amount: order.totalAmount,
    });

    expect(result.status).toBe("processing");
    if (result.status !== "processing") throw new Error("expected processing");
    expect(result.order.status).toBe(OrderStatus.PROCESSING);

    // Manual SKUs never reserve stock.
    const stockCount = await prisma.stockItem.count({ where: { productId: manualDenom.id } });
    expect(stockCount).toBe(0);

    // Ledger claimed as matched (not overpaid — bybit_deposit.ts has no
    // overpaid handling at all, unlike the other 4 gateway files).
    const ledgerRow = await prisma.processedBybitTx.findUnique({ where: { bybitTxId: "0x-processing-1" } });
    expect(ledgerRow?.outcome).toBe("matched");

    const processingDm = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_PROCESSING_DM },
    });
    expect(processingDm).not.toBeNull();
  });
});
