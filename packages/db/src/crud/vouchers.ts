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

export async function createVoucher(
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
  // The only thing standing between a misconfigured PERCENT voucher and a
  // free (Rp0) order — reject anything outside (0,100] (Pricing-4 fix,
  // security audit 2026-06-23). FIXED vouchers are already capped at the
  // subtotal in applyVoucherToSubtotal, so only the percentage needs bounding.
  if (args.type === VoucherType.PERCENT) {
    const value = new Decimal(args.value);
    if (value.lte(0) || value.gt(100)) {
      throw new ValidationError("error.invalid_discount_percent");
    }
  }
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

/**
 * Throws if `userId` has already redeemed `voucherId` (1x/voucher/user cap —
 * security audit Pricing-1, 2026-06-23: without this, a customer could reuse
 * the same discount voucher across unlimited orders). Call before computing
 * the discount; the `(voucherId, userId)` unique index on VoucherRedemption
 * is the atomic race-safety net for two concurrent checkouts.
 */
export async function assertVoucherNotRedeemedByUser(db: Db, voucherId: number, userId: number): Promise<void> {
  const existing = await db.voucherRedemption.findUnique({
    where: { voucherId_userId: { voucherId, userId } },
  });
  if (existing) throw new ValidationError("error.voucher_already_redeemed");
}

export type VoucherStatus = "active" | "expired" | "usedUp";

/** Precedence: expired > usedUp > active — a voucher's status can't depend
 *  on which page it's on, so this is the single source of truth used by both
 *  server-side status filtering (listVouchersPaged) and the KPI aggregate
 *  (getVoucherStats). Kept in sync with the client's per-row display logic
 *  in VouchersPage.tsx (which annotates already-fetched rows, not filters —
 *  no pagination-correctness risk there). */
export function deriveVoucherStatus(
  v: { isActive: boolean; expiresAt: Date | null; usageLimit: number | null; usedCount: number },
  now: Date = new Date(),
): VoucherStatus | null {
  if (v.expiresAt && v.expiresAt.getTime() < now.getTime()) return "expired";
  if (v.usageLimit != null && v.usedCount >= v.usageLimit) return "usedUp";
  return v.isActive ? "active" : null;
}

/**
 * Paginated + filterable voucher listing for the admin Vouchers page.
 * Distinct from `listVouchers` (used unmodified by the Telegram bot's admin
 * panel, apps/order-bot/src/handlers/admin.ts) — that function keeps its
 * existing plain-array signature untouched.
 *
 * `status` depends on a cross-column comparison (usedCount vs usageLimit)
 * that isn't expressible in a single Prisma `where` clause. Rather than drop
 * to raw SQL (disallowed, CLAUDE.md), this fetches the `q`-narrowed set (a
 * single shop's voucher table — small), derives status in JS, then filters
 * and paginates in JS. This stays correct regardless of page (never scoped
 * to just the requested page), unlike a client-side-only filter would be.
 */
export async function listVouchersPaged(
  db: Db,
  opts: { q?: string | null; status?: VoucherStatus | null; limit?: number; offset?: number } = {},
) {
  const where: Record<string, unknown> = {};
  if (opts.q?.trim()) where.code = { contains: opts.q.trim().toUpperCase() };

  const all = await db.voucher.findMany({ where, orderBy: { createdAt: "desc" } });
  const now = new Date();
  const filtered = opts.status ? all.filter((v) => deriveVoucherStatus(v, now) === opts.status) : all;

  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? filtered.length;
  return { rows: filtered.slice(offset, offset + limit), total: filtered.length };
}
