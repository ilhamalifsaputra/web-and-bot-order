/**
 * Tests for the Digiflazz dispatch poller and auto-fulfillment path —
 * getDigiflazzCreds, buildDigiflazzCustomerNo, dispatchPendingDigiflazzOrders,
 * fulfillDigiflazzOrder. Follows crud/tokopay.test.ts's makeTestDb +
 * buildSampleData shape; mocks @app/core/suppliers/digiflazz's
 * createTransaction since this file never makes a real HTTP call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const digiflazzMock = vi.hoisted(() => ({
  createTransaction: vi.fn(),
}));
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()),
  createTransaction: digiflazzMock.createTransaction,
}));

import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  setSetting,
  deleteSetting,
  getOrder,
  ADMIN_IDS_KEY,
} from "@app/db";
import {
  getDigiflazzCreds,
  buildDigiflazzCustomerNo,
  dispatchPendingDigiflazzOrders,
  fulfillDigiflazzOrder,
  DIGIFLAZZ_USERNAME_KEY,
  DIGIFLAZZ_API_KEY_KEY,
  DIGIFLAZZ_ENABLED_KEY,
} from "@app/db";
import { OrderStatus, DeliveryType } from "@app/core/enums";

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
  digiflazzMock.createTransaction.mockReset();
  await setSetting(prisma, DIGIFLAZZ_USERNAME_KEY, "shopuser");
  await setSetting(prisma, DIGIFLAZZ_API_KEY_KEY, "shopkey");
});

/** Flip the sample denomination into a Digiflazz-mapped, manual_with_info SKU
 * and place a PROCESSING order against it — the state the poller looks for. */
async function makeProcessingDigiflazzOrder(supplierSku = "ml100") {
  await prisma.denomination.update({
    where: { id: sample.product.id },
    data: {
      autoDeliverySource: "digiflazz",
      supplierSku,
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      ]),
    },
  });
  const order = (await createOrderDirect(prisma, {
    user: sample.user,
    productId: sample.product.id,
    quantity: 1,
    customerData: JSON.stringify([{ user_id: "123456789" }]),
  }))!;
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });
  return order;
}

describe("getDigiflazzCreds", () => {
  it("returns credentials when username/apiKey are set and not disabled", async () => {
    const creds = await getDigiflazzCreds(prisma);
    expect(creds).toEqual({ username: "shopuser", apiKey: "shopkey" });
  });

  it("returns null when credentials are missing", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
    expect(await getDigiflazzCreds(prisma)).toBeNull();
  });

  it("returns null when explicitly disabled", async () => {
    await setSetting(prisma, DIGIFLAZZ_ENABLED_KEY, "false");
    expect(await getDigiflazzCreds(prisma)).toBeNull();
  });
});

describe("buildDigiflazzCustomerNo", () => {
  it("joins non-empty answers in field-definition order", () => {
    const product = {
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
        { key: "server_id", label: { id: "Server", en: "Server" }, type: "text", required: false, options: [], placeholder: "" },
      ]),
    };
    const customerData = JSON.stringify([{ user_id: "123456789", server_id: "2001" }]);
    expect(buildDigiflazzCustomerNo(product, customerData)).toBe("123456789 2001");
  });

  it("skips blank answers", () => {
    const product = {
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
        { key: "server_id", label: { id: "Server", en: "Server" }, type: "text", required: false, options: [], placeholder: "" },
      ]),
    };
    const customerData = JSON.stringify([{ user_id: "123456789", server_id: "" }]);
    expect(buildDigiflazzCustomerNo(product, customerData)).toBe("123456789");
  });
});

describe("dispatchPendingDigiflazzOrders", () => {
  it("delivers a Sukses order and flips it to DELIVERED", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Sukses",
      sn: "SN-12345",
      message: "ok",
      price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 1, pending: 0, failed: 0 });

    const refreshed = await getOrder(prisma, order.id);
    expect(refreshed!.status).toBe(OrderStatus.DELIVERED);
    expect(refreshed!.deliveredContent).toBe("SN-12345");
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("never calls Digiflazz twice for the same order (double-dispatch guard)", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Pending", sn: null, message: null, price: null,
    });

    await dispatchPendingDigiflazzOrders(prisma);
    const second = await dispatchPendingDigiflazzOrders(prisma);

    expect(second).toEqual({ claimed: 0, delivered: 0, pending: 0, failed: 0 });
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("leaves a Pending order PROCESSING with the claim set", async () => {
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Pending", sn: null, message: null, price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 1, failed: 0 });

    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.status).toBe(OrderStatus.PROCESSING);
    expect(refreshed!.digiflazzDispatchedAt).not.toBeNull();
  });

  it("alerts admins and leaves PROCESSING on Gagal, without fulfilling", async () => {
    // enqueueManualOrderAdminAlert fans out over resolveAdminIds, which is
    // empty unless a shop admin is configured (env ADMIN_IDS or the DB
    // setting) — give it one, same as bybit_deposit.test.ts's admin-alert
    // assertions.
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const order = await makeProcessingDigiflazzOrder();
    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Gagal", sn: null, message: "Saldo tidak cukup", price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });

    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.status).toBe(OrderStatus.PROCESSING);
    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull();
  });

  it("is a no-op when Digiflazz isn't configured", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
    await makeProcessingDigiflazzOrder();
    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 0, delivered: 0, pending: 0, failed: 0 });
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();
  });
});

describe("fulfillDigiflazzOrder", () => {
  it("delivers, records history, and audits as a system actor", async () => {
    const order = await makeProcessingDigiflazzOrder();
    const { order: delivered } = await fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-999" });
    expect(delivered.status).toBe(OrderStatus.DELIVERED);
    expect(delivered.deliveredContent).toBe("SN-999");

    const history = await prisma.orderStatusHistory.findFirst({
      where: { orderId: order.id, status: OrderStatus.DELIVERED },
    });
    expect(history).not.toBeNull();

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "order.auto_fulfill_digiflazz", targetId: order.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.adminId).toBeNull();
  });

  it("rejects a second claim on an already-delivered order", async () => {
    const order = await makeProcessingDigiflazzOrder();
    await fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-1" });
    await expect(fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-2" })).rejects.toThrow();
  });
});
