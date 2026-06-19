// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createOrderDirect,
  finalizeOrderPayment,
  listPendingTokopayOrders,
} from "@app/db";
import type { Api } from "grammy";
import { OrderStatus, OrderCurrency } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { reconcileOrder } from "../src/payments/tokopayReconcile";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.processedTokopayTx.deleteMany(); // new table, not covered by resetDb
  sample = await buildSampleData(prisma);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const CREDS = { merchantId: "M", secret: "s", channel: "QRIS" };
const fakeApi = () => ({ sendMessage: vi.fn().mockResolvedValue(undefined) }) as unknown as Api;

/** Stub the gateway status call. */
function stubStatus(data: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "success", data }) }),
  );
}

async function makeTokopayOrder() {
  return prisma.$transaction(async (tx) => {
    const o = await createOrderDirect(tx, {
      user: { id: sample.user.id, role: sample.user.role },
      productId: sample.product.id,
      quantity: 1,
    });
    return finalizeOrderPayment(tx, o!.id, { currency: OrderCurrency.IDR });
  });
}

describe("reconcileOrder (TokoPay poller safety net)", () => {
  it("delivers a pending TOKOPAY order the gateway reports paid", async () => {
    const created = await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    expect(pending).toBeDefined();
    stubStatus({ status: "Paid", trx_id: "TRX-RC", total_bayar: pending!.totalAmount.toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const after = await prisma.order.findUnique({ where: { id: created!.id } });
    expect(after?.status).toBe(OrderStatus.DELIVERED);
    const tx = await prisma.processedTokopayTx.findFirst({ where: { orderId: created!.id } });
    expect(tx?.outcome).toBe("matched");
  });

  it("leaves the order pending when the gateway reports unpaid", async () => {
    await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    stubStatus({ status: "Unpaid" });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const [stillPending] = await listPendingTokopayOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
  });

  it("never delivers on an underpayment", async () => {
    await makeTokopayOrder();
    const [pending] = await listPendingTokopayOrders(prisma, new Date());
    stubStatus({ status: "Paid", trx_id: "TRX-SHORT", total_bayar: pending!.totalAmount.minus(1).toString() });

    await reconcileOrder(fakeApi(), CREDS, pending!);

    const [stillPending] = await listPendingTokopayOrders(prisma, new Date());
    expect(stillPending).toBeDefined();
  });
});
