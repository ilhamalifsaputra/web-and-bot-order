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
  getPriceList: vi.fn(),
}));
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()),
  createTransaction: digiflazzMock.createTransaction,
  getPriceList: digiflazzMock.getPriceList,
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
  collapseToCheapestSeller,
  groupDigiflazzPriceListByBrand,
  computeDigiflazzMarkupPrice,
  importDigiflazzBrand,
  resyncDigiflazzCatalog,
  DIGIFLAZZ_MARKUP_TYPE_KEY,
  DIGIFLAZZ_MARKUP_VALUE_KEY,
} from "@app/db";
import { OrderStatus, DeliveryType } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import type { DigiflazzPriceListItem } from "@app/core/suppliers/digiflazz";

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
  digiflazzMock.getPriceList.mockReset();
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

function priceListItem(overrides: Partial<DigiflazzPriceListItem> = {}): DigiflazzPriceListItem {
  return {
    buyerSkuCode: "ml100",
    productName: "Mobile Legends 100 Diamond",
    category: "Game",
    brand: "Mobile Legends",
    type: "Umum",
    price: new Decimal(15000),
    buyerProductStatus: true,
    sellerProductStatus: true,
    stock: null,
    ...overrides,
  };
}

describe("collapseToCheapestSeller", () => {
  it("keeps only the lowest-price row when the same buyerSkuCode appears from multiple sellers", () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(16000) }),
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15500) }),
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15800) }),
      priceListItem({ buyerSkuCode: "ml250", price: new Decimal(41000) }),
    ];
    const collapsed = collapseToCheapestSeller(items);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.find((i) => i.buyerSkuCode === "ml100")!.price.toString()).toBe("15500");
  });

  it("is a no-op when every buyerSkuCode is already unique", () => {
    const items = [priceListItem({ buyerSkuCode: "ml100" }), priceListItem({ buyerSkuCode: "ml250" })];
    expect(collapseToCheapestSeller(items)).toHaveLength(2);
  });
});

describe("groupDigiflazzPriceListByBrand", () => {
  it("groups items by brand and flags brands with no existing Product as new", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends" }),
      priceListItem({ buyerSkuCode: "ml250", brand: "Mobile Legends", productName: "Mobile Legends 250 Diamond" }),
      priceListItem({ buyerSkuCode: "ff100", brand: "Free Fire", productName: "Free Fire 100 Diamond" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(2);
    const ml = groups.find((g) => g.brand === "Mobile Legends")!;
    expect(ml.items).toHaveLength(2);
    expect(ml.existingProductId).toBeNull();
  });

  it("collapses a multi-seller SKU to its cheapest offer before grouping, so it never produces two lookalike rows", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends", price: new Decimal(16000) }),
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends", price: new Decimal(15500) }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(1);
    expect(groups[0]!.items[0]!.price.toString()).toBe("15500");
  });

  it("separates region variants that Digiflazz reports as distinct brand strings", async () => {
    const items = [
      priceListItem({ buyerSkuCode: "ml100", brand: "Mobile Legends" }),
      priceListItem({ buyerSkuCode: "mlglobal100", brand: "Mobile Legends (Region Lain)" }),
    ];
    const groups = await groupDigiflazzPriceListByBrand(prisma, items);
    expect(groups.map((g) => g.brand).sort()).toEqual(["Mobile Legends", "Mobile Legends (Region Lain)"]);
  });

  it("flags a brand already imported via digiflazzBrand as existing", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const product = await prisma.product.create({
      data: { categoryId: category.id, name: "Mobile Legends", slug: "mobile-legends-x", digiflazzBrand: "Mobile Legends" },
    });
    const groups = await groupDigiflazzPriceListByBrand(prisma, [priceListItem({ brand: "Mobile Legends" })]);
    expect(groups[0]!.existingProductId).toBe(product.id);
  });
});

describe("computeDigiflazzMarkupPrice", () => {
  it("applies a percent markup", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    const price = await computeDigiflazzMarkupPrice(prisma, new Decimal(10000));
    expect(price.toString()).toBe("11000");
  });

  it("applies a flat markup", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "flat");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "1500");
    const price = await computeDigiflazzMarkupPrice(prisma, new Decimal(10000));
    expect(price.toString()).toBe("11500");
  });

  it("defaults to zero markup (equals cost) when unset", async () => {
    const price = await computeDigiflazzMarkupPrice(prisma, new Decimal(10000));
    expect(price.toString()).toBe("10000");
  });
});

describe("importDigiflazzBrand", () => {
  it("creates a Product with digiflazzBrand set and one Denomination per row", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const result = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends",
      categoryId: category.id,
      rows: [
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500" },
        { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000" },
      ],
    });
    expect(result.denominationCount).toBe(2);

    const product = await prisma.product.findUnique({ where: { id: result.productId }, include: { denominations: true } });
    expect(product!.digiflazzBrand).toBe("Mobile Legends");
    expect(product!.isActive).toBe(false); // imported inactive — review-before-live
    expect(product!.denominations).toHaveLength(2);
    const denom = product!.denominations.find((d) => d.supplierSku === "ml100")!;
    expect(denom.autoDeliverySource).toBe("digiflazz");
    expect(denom.deliveryType).toBe("manual_with_info");
    expect(JSON.parse(denom.additionalFields!)).toEqual([
      { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      { key: "server_id", label: { id: "Server / Zone", en: "Server / Zone" }, type: "text", required: false, options: [], placeholder: "" },
    ]);
  });

  it("reuses the existing Product on a second import for the same brand rather than duplicating it", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const first = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500" }],
    });
    const second = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000" }],
    });
    expect(second.productId).toBe(first.productId);
    const count = await prisma.product.count({ where: { digiflazzBrand: "Mobile Legends" } });
    expect(count).toBe(1);
  });
});

describe("resyncDigiflazzCatalog", () => {
  it("updates costPrice/price from a fresh price list and leaves priceOverridden rows untouched", async () => {
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500" },
        { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000" },
      ],
    });
    // Admin reviews, hand-edits ml250's price, and publishes it (imports land
    // inactive — this is the "review before it goes live" step).
    const ml250 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml250" } });
    await prisma.denomination.update({
      where: { id: ml250.id },
      data: { price: "50000", priceOverridden: true, isActive: true },
    });

    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(20000), buyerProductStatus: true }),
      priceListItem({ buyerSkuCode: "ml250", price: new Decimal(45000), buyerProductStatus: false }),
    ]);

    const result = await resyncDigiflazzCatalog(prisma);
    expect(result.updated).toBe(1); // only ml100 — ml250 is priceOverridden
    expect(result.deactivated).toBe(1); // ml250's isActive still flips off from buyerProductStatus, independent of price

    const ml100 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    expect(ml100.costPrice!.toString()).toBe("20000");
    expect(ml100.price.toString()).toBe("22000"); // 20000 + 10%

    const ml250After = await prisma.denomination.findFirstOrThrow({ where: { id: ml250.id } });
    expect(ml250After.price.toString()).toBe("50000"); // untouched
    expect(ml250After.isActive).toBe(false); // status still mirrors buyerProductStatus
  });

  it("is a no-op when Digiflazz isn't configured", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
    const result = await resyncDigiflazzCatalog(prisma);
    expect(result).toEqual({ updated: 0, deactivated: 0, reactivated: 0 });
  });

  it("uses the cheapest seller's price when the fresh list has a duplicate buyerSkuCode", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500" }],
    });
    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(21000) }),
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(19500) }), // cheaper seller, same SKU
    ]);

    await resyncDigiflazzCatalog(prisma);

    const ml100 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    expect(ml100.costPrice!.toString()).toBe("19500");
  });
});
