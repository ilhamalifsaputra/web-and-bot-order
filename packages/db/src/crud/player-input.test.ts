import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect, updateDenomination, buildDigiflazzCustomerNo, resolveNicknameGate } from "@app/db";
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
  it("never infers input requirements from product names", () => {
    expect(resolveNicknameGate({ nicknameCheckGameCode: null, product: { digiflazzBrand: "Mobile Legends", name: "Mobile Legends" } })).toEqual({ gameCode: null, requiresZone: false, requiresServer: false });
  });
  it("validates before supplier target assembly and honors explicit format", () => {
    const product = { additionalFields: fields, providerInputMapping: JSON.stringify({ digiflazz: { keys: ["user_id", "zone_id"], separator: "" } }) };
    expect(() => buildDigiflazzCustomerNo(product, JSON.stringify([{ user_id: "123" }]))).toThrow();
    expect(buildDigiflazzCustomerNo(product, JSON.stringify([{ user_id: "000123", zone_id: "004" }]))).toBe("000123004");
  });
});
