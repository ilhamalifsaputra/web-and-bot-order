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
  createOrderFromCart,
  addToCart,
  createCatalogProduct,
  createDenomination,
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
// I3 test: spy on getSetting itself (not just the underlying Prisma query,
// which a 30s TTL cache can mask) to confirm the markup setting is read a
// CONSTANT number of times per run, not once per denomination.
import * as settingsModule from "./settings";

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

  // I6 regression (final-review batch 1): the candidate query is a
  // `some`-filter — it never guaranteed the Digiflazz-routed item is
  // order.items[0]. Build an order whose Digiflazz line is SECOND (a plain,
  // non-Digiflazz auto line is added to the cart first) and confirm the
  // poller still finds and dispatches the right one.
  it("dispatches correctly when the Digiflazz item is not order.items[0]", async () => {
    // Decoy line — sample.product, untouched (still plain AUTO, no
    // autoDeliverySource) — added to the cart FIRST.
    await addToCart(prisma, sample.user.id, sample.product.id, 1);

    // The actual Digiflazz-routed denomination — a separate product, added
    // to the cart SECOND.
    const category = await prisma.category.findFirstOrThrow();
    const digiProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "Mobile Legends" });
    const digiDenom = await createDenomination(prisma, {
      productId: digiProduct.id,
      name: "100 Diamond",
      type: "SHARED",
      durationLabel: "",
      price: "16500",
      autoDeliverySource: "digiflazz",
      supplierSku: "ml100",
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      ]),
    });
    await addToCart(prisma, sample.user.id, digiDenom.id, 1);

    const order = (await createOrderFromCart(prisma, {
      user: sample.user,
      customerData: JSON.stringify([{ user_id: "987654321" }]),
    }))!;
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });

    // Confirm the fixture actually reproduces "Digiflazz item is not
    // items[0]" before trusting the dispatch result below — otherwise this
    // test would pass for the wrong reason if cart ordering ever changes.
    const beforeDispatch = await getOrder(prisma, order.id);
    expect(beforeDispatch!.items[0]!.productId).toBe(sample.product.id);
    expect(beforeDispatch!.items[1]!.productId).toBe(digiDenom.id);

    digiflazzMock.createTransaction.mockResolvedValue({
      refId: order.orderCode, status: "Sukses", sn: "SN-I6", message: "ok", price: null,
    });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 1, pending: 0, failed: 0 });
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
    expect(digiflazzMock.createTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ buyerSkuCode: "ml100" }),
    );

    const refreshed = await getOrder(prisma, order.id);
    expect(refreshed!.status).toBe(OrderStatus.DELIVERED);
    expect(refreshed!.deliveredContent).toBe("SN-I6");
  });

  // N1 defense-in-depth (final-review batch 1): the front-door cart guards
  // (POST /cart, POST /cart/update) close off the normal way to reach this,
  // but the poller must ALSO refuse a Digiflazz item whose quantity isn't 1
  // — e.g. a pre-existing PROCESSING order from before those guards shipped,
  // or an admin hand-editing an OrderItem row.
  it("refuses to dispatch (alerts, never calls Digiflazz) when the Digiflazz item's quantity is not 1", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const order = await makeProcessingDigiflazzOrder();
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { quantity: 2 } });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();

    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed!.status).toBe(OrderStatus.PROCESSING);
    // The atomic claim still commits — this is a "needs a human" outcome,
    // not a retry-later one, same as every other alertDigiflazzDispatchFailed
    // branch in this function.
    expect(refreshed!.digiflazzDispatchedAt).not.toBeNull();
    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull();
  });

  // Same invariant, the OTHER shape it can take: not one row with quantity
  // > 1, but more than one Digiflazz-routed row in the same order (what the
  // storefront's per-unit OrderItem creation would produce for a qty>1 cart
  // line, before the front-door guards existed). Also refused, never
  // partially dispatched.
  it("refuses to dispatch when an order has more than one Digiflazz-routed line", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const fields = JSON.stringify([
      { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ]);
    await prisma.denomination.update({
      where: { id: sample.product.id },
      data: {
        autoDeliverySource: "digiflazz",
        supplierSku: "ml100",
        deliveryType: DeliveryType.MANUAL_WITH_INFO,
        additionalFields: fields,
      },
    });
    const category = await prisma.category.findFirstOrThrow();
    const product2 = await createCatalogProduct(prisma, { categoryId: category.id, name: "Free Fire" });
    const digiDenom2 = await createDenomination(prisma, {
      productId: product2.id,
      name: "100 Diamond",
      type: "SHARED",
      durationLabel: "",
      price: "10000",
      autoDeliverySource: "digiflazz",
      supplierSku: "ff100",
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: fields,
    });
    await addToCart(prisma, sample.user.id, sample.product.id, 1);
    await addToCart(prisma, sample.user.id, digiDenom2.id, 1);
    const order = (await createOrderFromCart(prisma, {
      user: sample.user,
      customerData: JSON.stringify([{ user_id: "111" }]),
    }))!;
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });

    const summary = await dispatchPendingDigiflazzOrders(prisma);
    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();
    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull();
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
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" },
        { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000", costPrice: "38000" },
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
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    const second = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000", costPrice: "38000" }],
    });
    expect(second.productId).toBe(first.productId);
    const count = await prisma.product.count({ where: { digiflazzBrand: "Mobile Legends" } });
    expect(count).toBe(1);
  });

  // I4: re-running the import wizard on an already-imported SKU (e.g. an
  // admin re-syncs and re-imports the same brand because they missed a row
  // the first time) must UPDATE the existing denomination, not create a
  // second one sharing the same supplierSku.
  it("I4: re-importing the same brand+SKU updates the existing denomination instead of duplicating it", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const first = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    const firstDenom = await prisma.denomination.findFirstOrThrow({
      where: { productId: first.productId, supplierSku: "ml100" },
    });

    const second = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond (Updated)", price: "17000", costPrice: "15500" }],
    });
    expect(second.denominationCount).toBe(1);

    const denoms = await prisma.denomination.findMany({ where: { productId: first.productId, supplierSku: "ml100" } });
    expect(denoms).toHaveLength(1); // still exactly one row, not two
    expect(denoms[0]!.id).toBe(firstDenom.id); // same row, updated in place
    expect(denoms[0]!.name).toBe("Mobile Legends 100 Diamond (Updated)");
    expect(denoms[0]!.price.toString()).toBe("17000");
    expect(denoms[0]!.costPrice!.toString()).toBe("15500");
  });

  // I11: a freshly-imported denomination must have the correct costPrice
  // immediately — no resync needed to fill it in.
  it("I11: a freshly-imported denomination has costPrice set immediately, matching the submitted value", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    const denom = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    expect(denom.costPrice).not.toBeNull();
    expect(denom.costPrice!.toString()).toBe("15000");
  });

  // C2 (import side): the wizard lets an admin hand-edit a row's price
  // before submitting — that edit must be flagged priceOverridden so the
  // very first resync tick after import doesn't silently recompute it away.
  describe("C2: priceOverridden on import", () => {
    beforeEach(async () => {
      await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "percent");
      await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "10");
    });

    it("a row submitted at exactly the suggested markup price is NOT flagged overridden", async () => {
      const category = await prisma.category.findFirstOrThrow();
      const { productId } = await importDigiflazzBrand(prisma, {
        brand: "Mobile Legends", categoryId: category.id,
        rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }], // 15000 * 1.10 = 16500
      });
      const denom = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
      expect(denom.priceOverridden).toBe(false);
    });

    it("a row submitted with a hand-edited price different from the suggested markup IS flagged overridden", async () => {
      const category = await prisma.category.findFirstOrThrow();
      const { productId } = await importDigiflazzBrand(prisma, {
        brand: "Mobile Legends", categoryId: category.id,
        rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "18000", costPrice: "15000" }], // hand-edited above the 16500 suggestion
      });
      const denom = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
      expect(denom.priceOverridden).toBe(true);
    });
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
        { buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" },
        { buyerSkuCode: "ml250", productName: "Mobile Legends 250 Diamond", price: "41000", costPrice: "38000" },
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
    expect(result).toEqual({ updated: 0, deactivated: 0 });
  });

  it("uses the cheapest seller's price when the fresh list has a duplicate buyerSkuCode", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(21000) }),
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(19500) }), // cheaper seller, same SKU
    ]);

    await resyncDigiflazzCatalog(prisma);

    const ml100 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    expect(ml100.costPrice!.toString()).toBe("19500");
  });

  // I1: sync can only ever deactivate, never reactivate — a manually
  // deactivated SKU (including a freshly-imported, deliberately-unreviewed
  // one) must stay off even when Digiflazz reports it as available again.
  it("I1: does not reactivate a manually-deactivated denomination even when buyerProductStatus is true", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    // importDigiflazzBrand always creates isActive: false — this row has
    // never been reviewed/activated by an admin.
    const denom = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    expect(denom.isActive).toBe(false);

    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15000), buyerProductStatus: true }),
    ]);
    await resyncDigiflazzCatalog(prisma);

    const after = await prisma.denomination.findFirstOrThrow({ where: { id: denom.id } });
    expect(after.isActive).toBe(false); // stays off — resync never flips isActive back to true
  });

  it("I1: still correctly deactivates an active denomination whose SKU goes buyerProductStatus false", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "16500", costPrice: "15000" }],
    });
    const denom = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    await prisma.denomination.update({ where: { id: denom.id }, data: { isActive: true } });

    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15000), buyerProductStatus: false }),
    ]);
    const result = await resyncDigiflazzCatalog(prisma);
    expect(result.deactivated).toBe(1);

    const after = await prisma.denomination.findFirstOrThrow({ where: { id: denom.id } });
    expect(after.isActive).toBe(false);
  });

  // I5: resync must quantize to the same 4-decimal precision createDenomination
  // already uses — a percentage markup can otherwise produce a longer decimal
  // expansion that drifts from import-time precision.
  it("I5: quantizes price/costPrice to 4 decimals even when the markup percentage produces a longer expansion", async () => {
    const category = await prisma.category.findFirstOrThrow();
    // price === costPrice here (no markup configured yet at import time, so
    // computeDigiflazzMarkupPrice's zero-markup default suggests cost as-is)
    // — keeps this row NOT priceOverridden, so the resync below actually
    // recomputes price instead of skipping it.
    const { productId } = await importDigiflazzBrand(prisma, {
      brand: "Mobile Legends", categoryId: category.id,
      rows: [{ buyerSkuCode: "ml100", productName: "Mobile Legends 100 Diamond", price: "15000", costPrice: "15000" }],
    });
    // Zero markup (sell === cost) so `price` mirrors `costPrice` exactly —
    // isolates the quantization behavior from the markup math. A cost value
    // that doesn't divide evenly (10000 / 3 -> 3333.333...) forces
    // quantization to actually do work.
    await setSetting(prisma, DIGIFLAZZ_MARKUP_TYPE_KEY, "flat");
    await setSetting(prisma, DIGIFLAZZ_MARKUP_VALUE_KEY, "0");
    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal("10000").dividedBy(3) }),
    ]);

    await resyncDigiflazzCatalog(prisma);

    const ml100 = await prisma.denomination.findFirstOrThrow({ where: { productId, supplierSku: "ml100" } });
    // decimal.js division defaults to 20 significant digits — unquantized
    // this would be "3333.33333333333333333" or similar, not a clean 4dp value.
    expect(ml100.costPrice!.toString()).toBe("3333.3333");
    expect(ml100.price.toString()).toBe("3333.3333");
    expect(ml100.costPrice!.decimalPlaces()).toBeLessThanOrEqual(4);
    expect(ml100.price.decimalPlaces()).toBeLessThanOrEqual(4);
  });

  // I3: the markup setting must be read a CONSTANT number of times per
  // resync run, not once per denomination touched. Compares the getSetting
  // call count for a 1-denomination run against a 3-denomination run rather
  // than hard-coding a literal — the old per-row computeDigiflazzMarkupPrice
  // call would have made the 3-row run's count strictly larger; the fixed
  // code makes both counts equal (the constant overhead of
  // getDigiflazzCreds + getDigiflazzMarkupSettings, read once regardless of
  // row count).
  it("I3: reads the markup settings a constant number of times regardless of how many denominations are touched", async () => {
    const category = await prisma.category.findFirstOrThrow();
    const product = await createCatalogProduct(prisma, { categoryId: category.id, name: "Mobile Legends" });
    async function makeDigiflazzDenom(sku: string, price: string) {
      return createDenomination(prisma, {
        productId: product.id,
        name: sku,
        type: "SHARED",
        durationLabel: sku,
        price,
        costPrice: price,
        autoDeliverySource: "digiflazz",
        supplierSku: sku,
        deliveryType: DeliveryType.MANUAL_WITH_INFO,
        isActive: true,
      });
    }

    await makeDigiflazzDenom("ml100", "15000");
    digiflazzMock.getPriceList.mockResolvedValue([priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15500) })]);
    const spyOneRow = vi.spyOn(settingsModule, "getSetting");
    await resyncDigiflazzCatalog(prisma);
    const callsForOneRow = spyOneRow.mock.calls.length;
    spyOneRow.mockRestore();
    expect(callsForOneRow).toBeGreaterThan(0);

    await makeDigiflazzDenom("ml250", "38000");
    await makeDigiflazzDenom("ml500", "75000");
    digiflazzMock.getPriceList.mockResolvedValue([
      priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15600) }),
      priceListItem({ buyerSkuCode: "ml250", price: new Decimal(38500) }),
      priceListItem({ buyerSkuCode: "ml500", price: new Decimal(76000) }),
    ]);
    const spyThreeRows = vi.spyOn(settingsModule, "getSetting");
    await resyncDigiflazzCatalog(prisma);
    const callsForThreeRows = spyThreeRows.mock.calls.length;
    spyThreeRows.mockRestore();

    expect(callsForThreeRows).toBe(callsForOneRow);
  });

  // I2: resync writes exactly one summary audit entry per run that actually
  // changed something, and none for a no-op run — never one per denomination.
  describe("I2: audit trail", () => {
    it("writes exactly one digiflazz_catalog_resync audit entry (adminId: null) when a run changes something", async () => {
      const category = await prisma.category.findFirstOrThrow();
      // price === costPrice (no markup configured at import time) so neither
      // row is priceOverridden — the resync below must actually update both.
      await importDigiflazzBrand(prisma, {
        brand: "Mobile Legends", categoryId: category.id,
        rows: [
          { buyerSkuCode: "ml100", productName: "ML 100", price: "15000", costPrice: "15000" },
          { buyerSkuCode: "ml250", productName: "ML 250", price: "38000", costPrice: "38000" },
        ],
      });
      digiflazzMock.getPriceList.mockResolvedValue([
        priceListItem({ buyerSkuCode: "ml100", price: new Decimal(15500) }),
        priceListItem({ buyerSkuCode: "ml250", price: new Decimal(38500) }),
      ]);

      await resyncDigiflazzCatalog(prisma);

      const entries = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_resync" } });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.adminId).toBeNull();
    });

    it("writes no audit entry for a no-op run (nothing changed)", async () => {
      // No Digiflazz-mapped denominations at all — mapped is empty, the loop
      // never runs, nothing changes.
      digiflazzMock.getPriceList.mockResolvedValue([]);
      const result = await resyncDigiflazzCatalog(prisma);
      expect(result).toEqual({ updated: 0, deactivated: 0 });

      const entries = await prisma.auditLog.findMany({ where: { action: "digiflazz_catalog_resync" } });
      expect(entries).toHaveLength(0);
    });
  });
});
