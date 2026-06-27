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

// Pricing-4 (security audit, 2026-06-23): a misconfigured PERCENT voucher is
// the only thing standing between an admin typo and a free (Rp0) order.
describe("createVoucher discountPercent bounds (PERCENT type)", () => {
  it("rejects value > 100", async () => {
    await expect(
      createVoucher(prisma, { code: "OVER100", type: VoucherType.PERCENT, value: "150" }),
    ).rejects.toMatchObject({ key: "error.invalid_discount_percent" });
    expect(await prisma.voucher.findUnique({ where: { code: "OVER100" } })).toBeNull();
  });

  it("rejects value === 0 and negative", async () => {
    await expect(
      createVoucher(prisma, { code: "ZEROPCT", type: VoucherType.PERCENT, value: "0" }),
    ).rejects.toMatchObject({ key: "error.invalid_discount_percent" });
    await expect(
      createVoucher(prisma, { code: "NEGPCT", type: VoucherType.PERCENT, value: "-10" }),
    ).rejects.toMatchObject({ key: "error.invalid_discount_percent" });
  });

  it("accepts exactly 100 for PERCENT", async () => {
    const v = await createVoucher(prisma, { code: "FULL100", type: VoucherType.PERCENT, value: "100" });
    expect(Number(v.value)).toBe(100);
  });

  it("does NOT bound a FIXED voucher's value (capped at subtotal elsewhere)", async () => {
    const v = await createVoucher(prisma, { code: "BIGFIXED", type: VoucherType.FIXED, value: "999999" });
    expect(Number(v.value)).toBe(999999);
  });
});
