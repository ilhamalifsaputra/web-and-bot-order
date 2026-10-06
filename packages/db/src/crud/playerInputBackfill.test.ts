import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { OrderStatus } from "@app/core/enums";
import { createOrderDirect } from "@app/db";
import { backfillPlayerInputConfiguration } from "./playerInputBackfill";

let db: TestDb;
let sample: SampleData;

// The exact generic template the Digiflazz import used to stamp on every game.
const GENERIC = JSON.stringify([
  { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
  { key: "server_id", label: { id: "Server / Zone", en: "Server / Zone" }, type: "text", required: false, options: [], placeholder: "" },
]);

beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => {
  await resetDb(db.prisma);
  sample = await buildSampleData(db.prisma);
  await db.prisma.product.update({ where: { id: sample.parentProduct.id }, data: { name: "Delta Force", digiflazzBrand: "Delta Force" } });
  await db.prisma.denomination.update({ where: { id: sample.product.id }, data: { autoDeliverySource: "digiflazz", supplierSku: "delta1", additionalFields: GENERIC } });
});

async function orderWithoutSnapshot(status: string) {
  const order = (await createOrderDirect(db.prisma, { user: sample.user, productId: sample.product.id, quantity: 1, channel: "bot", customerData: JSON.stringify([{ user_id: "1", server_id: "" }]) }))!;
  await db.prisma.order.update({ where: { id: order.id }, data: { status, inputConfigSnapshot: null } });
  return order.id;
}

describe("backfillPlayerInputConfiguration", () => {
  it("dry-run reports the Delta Force fix without writing anything", async () => {
    const changes = await backfillPlayerInputConfiguration(db.prisma, { apply: false });
    expect(changes).toHaveLength(1);
    expect(JSON.parse(changes[0]!.after).map((f: { key: string }) => f.key)).toEqual(["user_id"]);
    const denom = await db.prisma.denomination.findUniqueOrThrow({ where: { id: sample.product.id } });
    expect(denom.additionalFields).toBe(GENERIC);
    expect(denom.providerInputMapping).toBeNull();
  });

  it("apply collapses the generic template to Player ID only and a second run changes nothing", async () => {
    await backfillPlayerInputConfiguration(db.prisma, { apply: true });
    const denom = await db.prisma.denomination.findUniqueOrThrow({ where: { id: sample.product.id } });
    const fields = JSON.parse(denom.additionalFields!) as Array<{ key: string; label: { en: string } }>;
    expect(fields.map((f) => [f.key, f.label.en])).toEqual([["user_id", "Player ID"]]);
    expect(JSON.parse(denom.providerInputMapping!)).toEqual({ digiflazz: { keys: ["user_id"], separator: " " } });
    expect(await backfillPlayerInputConfiguration(db.prisma, { apply: true })).toEqual([]);
  });

  it("freezes the old fields onto in-flight orders but leaves finished orders alone", async () => {
    const paid = await orderWithoutSnapshot(OrderStatus.PAID);
    const processing = await orderWithoutSnapshot(OrderStatus.PROCESSING);
    const delivered = await orderWithoutSnapshot(OrderStatus.DELIVERED);
    await backfillPlayerInputConfiguration(db.prisma, { apply: true });
    const snapshot = async (id: number) => (await db.prisma.order.findUniqueOrThrow({ where: { id } })).inputConfigSnapshot;
    for (const id of [paid, processing]) {
      expect(JSON.parse((await snapshot(id))!).fields.map((f: { key: string }) => f.key)).toEqual(["user_id", "server_id"]);
    }
    expect(await snapshot(delivered)).toBeNull();
  });

  it("leaves a hand-edited SKU's fields untouched", async () => {
    const custom = JSON.stringify([{ key: "role_id", label: { id: "Role ID", en: "Role ID" }, type: "text", required: true, options: [], placeholder: "" }]);
    await db.prisma.denomination.update({ where: { id: sample.product.id }, data: { additionalFields: custom } });
    await backfillPlayerInputConfiguration(db.prisma, { apply: true });
    const denom = await db.prisma.denomination.findUniqueOrThrow({ where: { id: sample.product.id } });
    expect(denom.additionalFields).toBe(custom);
  });
});
