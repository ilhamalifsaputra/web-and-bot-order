/**
 * Backend audit E2 item 7: voucher check-then-act paths under real Postgres
 * concurrency.
 *  - updateVoucher refused a code change once usedCount > 0, but read it
 *    before writing: a checkout using the voucher in between let the code
 *    change land on a used voucher. A code already taken by another voucher
 *    surfaced as a raw unique violation.
 *  - deleteVoucher had the same read-then-delete gap.
 *  - Releasing a voucher use (cancel/reject/expire, underpaid refund) read
 *    usedCount and then decremented it, so two releases that both read 1
 *    drove it to -1.
 *
 * Each race is made deterministic by holding the voucher row in another
 * transaction while the code under test reads, then letting it go.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { OrderStatus, StockActorType, VoucherType } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { cancelOrder } from "@app/db";
import { createVoucher, updateVoucher, deleteVoucher, VoucherCodeTakenError } from "./vouchers";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
  // Open the pooled connections up front: opening one lazily can take
  // seconds, which would quietly serialize the "concurrent" work below.
  await Promise.all(
    Array.from({ length: 5 }, () =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        await new Promise((r) => setTimeout(r, 300));
      }),
    ),
  );
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

/** Run `work` on the voucher row inside a transaction that stays open until the returned release() is called. */
async function holdVoucherRow(voucherId: number, work: "lock" | "use") {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const isHeld = new Promise<void>((resolve) => (held = resolve));
  const done = prisma.$transaction(
    async (tx) => {
      if (work === "use") {
        await tx.$executeRaw`UPDATE vouchers SET used_count = used_count + 1 WHERE id = ${voucherId}`;
      } else {
        await tx.$queryRaw`SELECT id FROM vouchers WHERE id = ${voucherId} FOR UPDATE`;
      }
      held();
      await released;
    },
    { timeout: 15_000 },
  );
  await isHeld;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 700));

describe("voucher admin edits vs a concurrent checkout", () => {
  it("a code change racing a checkout that uses the voucher is refused, not applied to a used voucher", async () => {
    const voucher = await createVoucher(prisma, { code: "RACE1", type: VoucherType.FIXED, value: "1" });
    const hold = await holdVoucherRow(voucher.id, "use"); // a checkout is redeeming it right now
    const edit = updateVoucher(prisma, voucher.id, { code: "RENAMED" }).then(
      () => null,
      (e: unknown) => e,
    );
    await settle();
    await hold.release();

    expect(await edit).toMatchObject({ message: "cannot change the code of a voucher that has been used" });
    const after = await prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } });
    expect(after.code).toBe("RACE1");
    expect(after.usedCount).toBe(1);
  });

  it("a delete racing a checkout that uses the voucher is refused, and the voucher survives", async () => {
    const voucher = await createVoucher(prisma, { code: "RACE2", type: VoucherType.FIXED, value: "1" });
    const hold = await holdVoucherRow(voucher.id, "use");
    const removal = deleteVoucher(prisma, voucher.id).then(
      () => null,
      (e: unknown) => e,
    );
    await settle();
    await hold.release();

    expect(await removal).toMatchObject({ message: "cannot delete a voucher that has been used" });
    expect(await prisma.voucher.findUnique({ where: { id: voucher.id } })).not.toBeNull();
  });

  it("renaming to a code another voucher already has is a friendly VoucherCodeTakenError, not a raw unique violation", async () => {
    await createVoucher(prisma, { code: "TAKEN", type: VoucherType.FIXED, value: "1" });
    const voucher = await createVoucher(prisma, { code: "MINE", type: VoucherType.FIXED, value: "1" });
    await expect(updateVoucher(prisma, voucher.id, { code: "taken" })).rejects.toBeInstanceOf(VoucherCodeTakenError);
  });

  it("an unused voucher can still be renamed and deleted", async () => {
    const voucher = await createVoucher(prisma, { code: "FREE", type: VoucherType.FIXED, value: "1" });
    const renamed = await updateVoucher(prisma, voucher.id, { code: "free2", value: "2" });
    expect(renamed?.code).toBe("FREE2");
    await deleteVoucher(prisma, voucher.id);
    expect(await prisma.voucher.findUnique({ where: { id: voucher.id } })).toBeNull();
  });
});

describe("releasing a voucher use", () => {
  it("two orders released at once never drive usedCount below zero", async () => {
    const voucher = await createVoucher(prisma, { code: "REL", type: VoucherType.FIXED, value: "1" });
    // Drifted counter: two orders carry the voucher but only one use is counted.
    await prisma.voucher.update({ where: { id: voucher.id }, data: { usedCount: 1 } });
    const orders = [];
    for (const code of ["ORD-REL-1", "ORD-REL-2"]) {
      orders.push(
        await prisma.order.create({
          data: {
            orderCode: code,
            userId: sample.user.id,
            subtotalAmount: "1",
            totalAmount: "1",
            voucherId: voucher.id,
            status: OrderStatus.PENDING_PAYMENT,
          },
        }),
      );
    }

    // Both releases read usedCount = 1 while the row is held, then both write.
    const hold = await holdVoucherRow(voucher.id, "lock");
    const cancels = Promise.allSettled(
      orders.map((o) => cancelOrder(prisma, o.id, "admin_cancelled", { type: StockActorType.SYSTEM })),
    );
    await settle();
    await hold.release();
    const results = await cancels;

    for (const r of results) {
      if (r.status === "rejected") throw r.reason;
    }
    const after = await prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } });
    expect(after.usedCount).toBe(0);
  });
});
