import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { OrderStatus, ProductType } from "@app/core/enums";
import { buildPlayerNicknameRequest, parseInputFields } from "@app/core/playerInput";
import { createOrderDirect, createDenomination, updateDenomination, updateOrderCustomerData, buildDigiflazzCustomerNo, resolveNicknameGate } from "@app/db";
let db: TestDb;
let sample: SampleData;
const fields = JSON.stringify([
  { key: "user_id", label: { id: "User ID", en: "User ID" }, type: "number", required: true },
  { key: "zone_id", label: { id: "Zone ID", en: "Zone ID" }, type: "number", required: true },
]);
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => { await resetDb(db.prisma); sample = await buildSampleData(db.prisma); });
describe("player input order boundary", () => {
  it("rejects missing zone on AUTO and persists a snapshot on a complete order", async () => {
    await updateDenomination(db.prisma, sample.product.id, { additionalFields: fields });
    const args = { user: sample.user, productId: sample.product.id, quantity: 1, channel: "bot" as const };
    await expect(createOrderDirect(db.prisma, { ...args, customerData: JSON.stringify([{ user_id: "000123" }]) })).rejects.toThrow();
    const order = (await createOrderDirect(db.prisma, { ...args, customerData: JSON.stringify([{ user_id: "000123", zone_id: "004" }]) }))!;
    const saved = await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved.customerData).toBe(JSON.stringify([{ user_id: "000123", zone_id: "004" }]));
    expect(JSON.parse((saved as unknown as { inputConfigSnapshot: string }).inputConfigSnapshot).fields).toHaveLength(2);
  });
  it("refuses a top-up SKU with no input fields but keeps the dispatcher's manual-review fallbacks", async () => {
    const args = { user: sample.user, productId: sample.product.id, channel: "bot" as const };
    await updateDenomination(db.prisma, sample.product.id, { autoDeliverySource: "digiflazz", supplierSku: "ml100", additionalFields: null });
    await expect(createOrderDirect(db.prisma, { ...args, quantity: 1, customerData: null })).rejects.toThrow("error.customer_data_incomplete");
    // Missing supplierSku and quantity > 1 still create the order — dispatch
    // routes both to manual review, so checkout must not refuse them.
    await updateDenomination(db.prisma, sample.product.id, { supplierSku: null, additionalFields: fields });
    const one = { user_id: "1", zone_id: "2" };
    await expect(createOrderDirect(db.prisma, { ...args, quantity: 1, customerData: JSON.stringify([one]) })).resolves.toBeTruthy();
    await updateDenomination(db.prisma, sample.product.id, { supplierSku: "ml100" });
    await expect(createOrderDirect(db.prisma, { ...args, quantity: 2, customerData: JSON.stringify([one, one]) })).resolves.toBeTruthy();
  });
  it("dispatches a new order from its snapshot after an admin edit, and a historical order from current fields", async () => {
    const answers = JSON.stringify([{ user_id: "000123", zone_id: "004" }]);
    const snapshot = JSON.stringify({ fields: JSON.parse(fields), providerInputMapping: JSON.stringify({ digiflazz: { keys: ["user_id", "zone_id"], separator: "" } }) });
    const edited = { additionalFields: fields, providerInputMapping: JSON.stringify({ digiflazz: { keys: ["user_id", "zone_id"], separator: "|" } }) };
    expect(buildDigiflazzCustomerNo(edited, answers, snapshot)).toBe("000123004");
    expect(buildDigiflazzCustomerNo(edited, answers, null)).toBe("000123|004");
  });
  it("an admin edit of a pending order's answers validates against the order's snapshot, not the edited SKU", async () => {
    await updateDenomination(db.prisma, sample.product.id, { additionalFields: fields });
    const order = (await createOrderDirect(db.prisma, { user: sample.user, productId: sample.product.id, quantity: 1, channel: "bot", customerData: JSON.stringify([{ user_id: "1", zone_id: "2" }]) }))!;
    await db.prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });
    await updateDenomination(db.prisma, sample.product.id, { additionalFields: JSON.stringify([JSON.parse(fields)[0]]) });
    await expect(updateOrderCustomerData(db.prisma, order.id, [{ user_id: "9" }])).rejects.toThrow();
    await updateOrderCustomerData(db.prisma, order.id, [{ user_id: "9", zone_id: "8" }]);
    const saved = await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(JSON.parse(saved.customerData!)).toEqual([{ user_id: "9", zone_id: "8" }]);
  });
  it("two variants of the same game resolve their own input profile and never inherit from each other", async () => {
    const variantB = await createDenomination(db.prisma, {
      productId: sample.parentProduct.id, name: "Variant B", type: ProductType.SHARED, durationLabel: "B", price: "5.00",
      additionalFields: JSON.stringify([JSON.parse(fields)[0]]),
    });
    await updateDenomination(db.prisma, sample.product.id, { additionalFields: fields, nicknameCheckGameCode: "mobile-legends" });
    await updateDenomination(db.prisma, variantB.id, { nicknameCheckGameCode: "mobile-legends" });
    const a = await db.prisma.denomination.findUniqueOrThrow({ where: { id: sample.product.id } });
    const b = await db.prisma.denomination.findUniqueOrThrow({ where: { id: variantB.id } });
    // Same product row, same game code, different requirements.
    expect(a.productId).toBe(b.productId);
    expect(resolveNicknameGate(a)).toMatchObject({ gameCode: "mobile-legends", requiresZone: true });
    expect(resolveNicknameGate(b)).toMatchObject({ gameCode: "mobile-legends", requiresZone: false });
    const answers = { user_id: "1", zone_id: "2" };
    expect(buildPlayerNicknameRequest(parseInputFields(a.additionalFields), a.providerInputMapping, answers)).toEqual({ target: "1", zone: "2" });
    // Variant B has no zone field, so an injected zone is rejected, not forwarded.
    expect(() => buildPlayerNicknameRequest(parseInputFields(b.additionalFields), b.providerInputMapping, answers)).toThrow();
  });
  it("never infers input requirements from product names", () => {
    expect(resolveNicknameGate({ nicknameCheckGameCode: null, product: { digiflazzBrand: "Mobile Legends", name: "Mobile Legends" } })).toEqual({ gameCode: null, requiresZone: false, requiresServer: false });
  });
  it("validates before supplier target assembly and honors explicit format", () => {
    const product = { additionalFields: fields, providerInputMapping: JSON.stringify({ digiflazz: { keys: ["user_id", "zone_id"], separator: "" } }) };
    expect(() => buildDigiflazzCustomerNo(product, JSON.stringify([{ user_id: "123" }]))).toThrow();
    expect(buildDigiflazzCustomerNo(product, JSON.stringify([{ user_id: "000123", zone_id: "004" }]))).toBe("000123004");
  });
});
