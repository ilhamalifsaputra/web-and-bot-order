/**
 * Vouchers domain — port of the "Vouchers" section of Python crud.py.
 * applyVoucherToSubtotal is a pure function (no DB, no mutation).
 */
import { VoucherType } from "@app/core/enums";
import { quantizeMoney } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import type { Db } from "./_types";

export function getVoucherByCode(db: Db, code: string) {
  return db.voucher.findUnique({ where: { code: code.toUpperCase() } });
}

export function getVoucher(db: Db, voucherId: number) {
  return db.voucher.findUnique({ where: { id: voucherId } });
}

export function listVouchers(db: Db) {
  return db.voucher.findMany({ orderBy: { createdAt: "desc" } });
}

export function createVoucher(
  db: Db,
  args: {
    code: string;
    type: VoucherType;
    value: Decimal.Value;
    usageLimit?: number | null;
    minPurchase?: Decimal.Value;
    expiresAt?: Date | null;
  },
) {
  return db.voucher.create({
    data: {
      code: args.code.toUpperCase(),
      type: args.type,
      value: new Decimal(args.value),
      usageLimit: args.usageLimit ?? null,
      minPurchase: new Decimal(args.minPurchase ?? 0),
      expiresAt: args.expiresAt ?? null,
    },
  });
}

export async function setVoucherActive(db: Db, voucherId: number, isActive: boolean) {
  await db.voucher.update({ where: { id: voucherId }, data: { isActive } });
}

/** Refuses once a code has been used at least once — deactivate it instead. */
export async function deleteVoucher(db: Db, voucherId: number): Promise<void> {
  const voucher = await db.voucher.findUnique({ where: { id: voucherId } });
  if (voucher && voucher.usedCount > 0) {
    throw new Error("cannot delete a voucher that has been used");
  }
  await db.voucher.delete({ where: { id: voucherId } });
}

/** Shape of the fields applyVoucherToSubtotal reads (Prisma Voucher subset). */
export interface VoucherLike {
  isActive: boolean;
  expiresAt: Date | null;
  usageLimit: number | null;
  usedCount: number;
  minPurchase: Decimal.Value;
  type: string;
  value: Decimal.Value;
}

/**
 * Compute the discount for `subtotal` given a voucher, without mutating
 * anything. Throws ValidationError (i18n key) when the voucher is invalid.
 * Returns the discount as a positive Decimal (caller subtracts it).
 */
export function applyVoucherToSubtotal(
  voucher: VoucherLike,
  subtotal: Decimal.Value,
  now: Date = new Date(),
): Decimal {
  const sub = new Decimal(subtotal);

  if (!voucher.isActive) throw new ValidationError("error.voucher_inactive");
  if (voucher.expiresAt && voucher.expiresAt.getTime() < now.getTime()) {
    throw new ValidationError("error.voucher_expired");
  }
  if (voucher.usageLimit !== null && voucher.usedCount >= voucher.usageLimit) {
    throw new ValidationError("error.voucher_used_up");
  }
  if (sub.lessThan(voucher.minPurchase)) {
    throw new ValidationError("error.voucher_min_purchase", {
      min: new Decimal(voucher.minPurchase).toString(),
    });
  }

  let discount =
    voucher.type === VoucherType.PERCENT
      ? sub.times(voucher.value).div(100)
      : new Decimal(voucher.value);

  if (discount.greaterThan(sub)) discount = sub; // cap at subtotal
  return quantizeMoney(discount, 4);
}
