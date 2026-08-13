// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createOrderDirect,
  finalizeOrderPayment,
  listPendingNowpaymentsOrders,
  setSetting,
  bulkAddStock,
  getPollHealth,
} from "@app/db";
import type { Api } from "grammy";
import { OrderStatus, OrderCurrency, PaymentMethod } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { reconcileOrder, pollOnce, MAX_ORDERS_PER_CYCLE } from "../src/payments/nowpaymentsReconcile";
import { NOWPAYMENTS_API_KEY_KEY, NOWPAYMENTS_IPN_SECRET_KEY } from "@app/core/payments/nowpayments";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedNowpaymentsTx.deleteMany(); // new table, not covered by resetDb
  sample = await buildSampleData(prisma);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const CREDS = { apiKey: "ak", ipnSecret: "secret", payCurrency: "usdttrc20", minAmount: null };
const fakeApi = () => ({ sendMessage: vi.fn().mockResolvedValue(undefined) }) as unknown as Api;

/** Stub the gateway's GET /v1/invoice/{id} status call. */
function stubStatus(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }),
  );
}

/** Create a pending NOWPAYMENTS order with a cached invoice id in paymentRef
 * (the same tagged-JSON convention TokoPay/PayDisini use — see
 * apps/storefront/src/routes/checkout.ts `CachedGateway` and
 * nowpaymentsReconcile.ts's `extractInvoiceId`). */
async function makeNowpaymentsOrder(invoiceId = "INV-1") {
  const created = await prisma.$transaction(async (tx) => {
    const o = await createOrderDirect(tx, {
      user: { id: sample.user.id, role: sample.user.role },
      productId: sample.product.id,
      quantity: 1,
    });
    return finalizeOrderPayment(tx, o!.id, {
      currency: OrderCurrency.USDT,
      rate: "16000",
      method: PaymentMethod.NOWPAYMENTS,
    });
  });
  await prisma.order.update({
    where: { id: created!.id },
    data: { paymentRef: JSON.stringify({ gateway: "nowpayments", invoiceId }) },
  });
  return created!;
}

describe("reconcileOrder (NOWPayments poller safety net)", () => {
  it('delivers a pending NOWPAYMENTS order when the gateway reports "finished"', async () => {
    const created = await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    expect(pending).toBeDefined();
    stubStatus({ payment_status: "finished", payment_id: "TRX-RC", actually_paid: pending!.totalAmount.toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created.id } });
    expect(after?.status).toBe(OrderStatus.DELIVERED);
    const tx = await prisma.processedNowpaymentsTx.findFirst({ where: { orderId: created.id } });
    expect(tx?.outcome).toBe("matched");
  });

  it('leaves the order pending on in-flight statuses ("waiting"/"confirming")', async () => {
    await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());

    stubStatus({ payment_status: "waiting" });
    await reconcileOrder(fakeApi(), CREDS, pending!);
    let [stillPending] = await listPendingNowpaymentsOrders(prisma, new Date());
    expect(stillPending).toBeDefined();

    stubStatus({ payment_status: "confirming" });
    await reconcileOrder(fakeApi(), CREDS, pending!);
    [stillPending] = await listPendingNowpaymentsOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
  });

  it('never delivers on "partially_paid" — exact-match on "finished" only, not an allowlist', async () => {
    await makeNowpaymentsOrder();
    const [pending] = await listPendingNowpaymentsOrders(prisma, new Date());
    // Even if the reported amount looks sufficient, a non-"finished" status
    // must never trigger delivery — partially_paid is terminal-but-not-success.
    stubStatus({ payment_status: "partially_paid", payment_id: "TRX-PARTIAL", actually_paid: pending!.totalAmount.toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const [stillPending] = await listPendingNowpaymentsOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
    const tx = await prisma.processedNowpaymentsTx.findFirst({ where: { orderId: pending!.id } });
    expect(tx).toBeNull();
  });
});

async function seedNowpaymentsCreds() {
  await setSetting(prisma, NOWPAYMENTS_API_KEY_KEY, "ak");
  await setSetting(prisma, NOWPAYMENTS_IPN_SECRET_KEY, "secret");
}

describe("pollOnce (heartbeat + bounded cycle — Task 11)", () => {
  it("records a heartbeat even when there are no pending orders to reconcile", async () => {
    await seedNowpaymentsCreds();

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "nowpayments");
    expect(health.lastRun).not.toBeNull();
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.lastTxCount).toBe(0);
  });

  it("does not record a heartbeat when the rail has no credentials configured", async () => {
    // No seedNowpaymentsCreds() call — the rail is genuinely off.
    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "nowpayments");
    expect(health.lastRun).toBeNull();
  });

  it("records a failed heartbeat when every gateway status call in the cycle fails", async () => {
    await seedNowpaymentsCreds();
    await makeNowpaymentsOrder("INV-1");
    await makeNowpaymentsOrder("INV-2");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "nowpayments");
    expect(health.lastSuccessAt).toBeNull();
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBeTruthy();
  });

  it("leaves the cycle healthy when only some gateway status calls fail (one flaky order is not an outage)", async () => {
    await seedNowpaymentsCreds();
    await makeNowpaymentsOrder("INV-1");
    await makeNowpaymentsOrder("INV-2");
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) return Promise.reject(new Error("transient"));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ payment_status: "waiting" }) });
      }),
    );

    await pollOnce(fakeApi());

    const health = await getPollHealth(prisma, "nowpayments");
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.consecutiveFailures).toBe(0);
  });

  it("checks at most MAX_ORDERS_PER_CYCLE orders in one cycle", async () => {
    await seedNowpaymentsCreds();
    const extraCreds = Array.from({ length: MAX_ORDERS_PER_CYCLE + 5 }, (_, i) => `stock-extra-${i}`);
    await bulkAddStock(prisma, sample.product.id, extraCreds);
    for (let i = 0; i < MAX_ORDERS_PER_CYCLE + 3; i++) await makeNowpaymentsOrder(`INV-${i}`);
    stubStatus({ payment_status: "waiting" });
    const fetchMock = vi.mocked(globalThis.fetch);

    await pollOnce(fakeApi());

    expect(fetchMock).toHaveBeenCalledTimes(MAX_ORDERS_PER_CYCLE);
    const health = await getPollHealth(prisma, "nowpayments");
    expect(health.lastTxCount).toBe(MAX_ORDERS_PER_CYCLE);
  });
});
