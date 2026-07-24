import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { createVoucher, listVouchersPaged, deriveVoucherStatus } from "@app/db";
import { VoucherType } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
});

describe("deriveVoucherStatus", () => {
  const now = new Date("2026-07-24T00:00:00.000Z");

  it("returns expired when expiresAt is in the past, regardless of isActive", () => {
    expect(deriveVoucherStatus({ isActive: true, expiresAt: new Date("2026-07-01"), usageLimit: null, usedCount: 0 }, now)).toBe("expired");
    expect(deriveVoucherStatus({ isActive: false, expiresAt: new Date("2026-07-01"), usageLimit: null, usedCount: 0 }, now)).toBe("expired");
  });

  it("returns usedUp when usedCount >= usageLimit and not expired", () => {
    expect(deriveVoucherStatus({ isActive: true, expiresAt: null, usageLimit: 10, usedCount: 10 }, now)).toBe("usedUp");
    expect(deriveVoucherStatus({ isActive: true, expiresAt: new Date("2026-08-01"), usageLimit: 5, usedCount: 7 }, now)).toBe("usedUp");
  });

  it("returns active when isActive, not expired, not used up", () => {
    expect(deriveVoucherStatus({ isActive: true, expiresAt: null, usageLimit: null, usedCount: 0 }, now)).toBe("active");
  });

  it("returns null when inactive, not expired, not used up", () => {
    expect(deriveVoucherStatus({ isActive: false, expiresAt: null, usageLimit: null, usedCount: 0 }, now)).toBeNull();
  });

  it("prioritizes expired over usedUp", () => {
    expect(deriveVoucherStatus({ isActive: true, expiresAt: new Date("2026-07-01"), usageLimit: 5, usedCount: 5 }, now)).toBe("expired");
  });
});

describe("listVouchersPaged", () => {
  it("filters by q (code substring, case-insensitive-in-practice via uppercase storage)", async () => {
    await createVoucher(prisma, { code: "SAVE10", type: VoucherType.PERCENT, value: "10" });
    await createVoucher(prisma, { code: "WELCOME5", type: VoucherType.FIXED, value: "5" });

    const result = await listVouchersPaged(prisma, { q: "save" });
    expect(result.rows.map((v) => v.code)).toEqual(["SAVE10"]);
    expect(result.total).toBe(1);
  });

  it("returns everything when q is empty or omitted", async () => {
    await createVoucher(prisma, { code: "A1", type: VoucherType.PERCENT, value: "1" });
    await createVoucher(prisma, { code: "B2", type: VoucherType.PERCENT, value: "1" });

    expect((await listVouchersPaged(prisma, {})).total).toBe(2);
    expect((await listVouchersPaged(prisma, { q: "" })).total).toBe(2);
  });

  it("filters by status across the WHOLE dataset, not just the requested page", async () => {
    // 3 expired vouchers total; request page 1 with limit 2 and status=expired —
    // total must reflect all 3, not just what's on this page (the exact class
    // of bug the Payments plan fixed for KPI cards).
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const code of ["EXP1", "EXP2", "EXP3"]) {
      await createVoucher(prisma, { code, type: VoucherType.PERCENT, value: "1", expiresAt: past });
    }
    await createVoucher(prisma, { code: "ACTIVE1", type: VoucherType.PERCENT, value: "1" });

    const page1 = await listVouchersPaged(prisma, { status: "expired", limit: 2, offset: 0 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await listVouchersPaged(prisma, { status: "expired", limit: 2, offset: 2 });
    expect(page2.rows).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  it("filters by usedUp status (cross-column usedCount >= usageLimit)", async () => {
    const v = await createVoucher(prisma, { code: "USEDUP1", type: VoucherType.PERCENT, value: "1", usageLimit: 2 });
    await prisma.voucher.update({ where: { id: v.id }, data: { usedCount: 2 } });
    await createVoucher(prisma, { code: "NOTUSED", type: VoucherType.PERCENT, value: "1", usageLimit: 5 });

    const result = await listVouchersPaged(prisma, { status: "usedUp" });
    expect(result.rows.map((r) => r.code)).toEqual(["USEDUP1"]);
    expect(result.total).toBe(1);
  });

  it("combines q and status filters", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await createVoucher(prisma, { code: "COMBOEXP", type: VoucherType.PERCENT, value: "1", expiresAt: past });
    await createVoucher(prisma, { code: "COMBOACTIVE", type: VoucherType.PERCENT, value: "1" });

    const result = await listVouchersPaged(prisma, { q: "combo", status: "expired" });
    expect(result.rows.map((r) => r.code)).toEqual(["COMBOEXP"]);
  });

  it("respects limit/offset when no status filter is given (plain DB pagination path)", async () => {
    for (let i = 0; i < 5; i++) {
      await createVoucher(prisma, { code: `PLAIN${i}`, type: VoucherType.PERCENT, value: "1" });
    }
    const result = await listVouchersPaged(prisma, { limit: 2, offset: 0 });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(5);
  });
});
