import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { VoucherType } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createVoucher, deleteVoucher } from "./vouchers";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

describe("deleteVoucher", () => {
  it("deletes a never-used voucher", async () => {
    const v = await createVoucher(prisma, { code: "UNUSED1", type: VoucherType.PERCENT, value: "10" });
    await deleteVoucher(prisma, v.id);
    expect(await prisma.voucher.findUnique({ where: { id: v.id } })).toBeNull();
  });

  it("refuses to delete a voucher that has been used", async () => {
    const v = await createVoucher(prisma, { code: "USED1", type: VoucherType.PERCENT, value: "10" });
    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 1 } });
    await expect(deleteVoucher(prisma, v.id)).rejects.toThrow(/has been used/);
    expect(await prisma.voucher.findUnique({ where: { id: v.id } })).not.toBeNull();
  });
});
