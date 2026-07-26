/**
 * Vouchers domain — port of the "Vouchers" section of Python crud.py.
 * applyVoucherToSubtotal is a pure function (no DB, no mutation).
 */
import { VoucherType, VoucherScope, OrderStatus } from "@app/core/enums";
import { quantizeMoney } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import type { PrismaClient } from "../client";
import type { Db } from "./_types";

const q4 = (v: Decimal.Value) => quantizeMoney(v, 4);

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
    maxDiscount?: Decimal.Value | null;
    startAt?: Date | null;
    scope?: VoucherScope;
    /** Scoped product ids (real catalog Product, not Denomination) — only
     *  written when scope === SELECTED. Ignored (never persisted) for ALL. */
    productIds?: number[];
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
  const scope = args.scope ?? VoucherScope.ALL;
  const voucher = await db.voucher.create({
    data: {
      code: args.code.toUpperCase(),
      type: args.type,
      value: new Decimal(args.value),
      usageLimit: args.usageLimit ?? null,
      minPurchase: new Decimal(args.minPurchase ?? 0),
      expiresAt: args.expiresAt ?? null,
      maxDiscount: args.maxDiscount != null ? new Decimal(args.maxDiscount) : null,
      startAt: args.startAt ?? null,
      scope,
    },
  });
  if (scope === VoucherScope.SELECTED && args.productIds && args.productIds.length > 0) {
    await db.voucherProduct.createMany({
      data: args.productIds.map((productId) => ({ voucherId: voucher.id, productId })),
    });
  }
  return voucher;
}

/**
 * Editable fields for an existing voucher (admin Vouchers page's Edit
 * action). `code` is refused once `usedCount > 0` — mirrors deleteVoucher's
 * "refuses once used" guard exactly, since a code rename after real
 * redemptions would desync what buyers typed from what's on record. Every
 * other field stays editable regardless of usedCount: Order.discountAmount
 * is a snapshot taken at order-creation time and is never recomputed, so
 * fixing a typo'd value or extending an expiry can never retroactively
 * change an already-completed order.
 *
 * The voucher-row update and the VoucherProduct set replacement run in one
 * short `db.$transaction` so a crash mid-edit can never leave the row and
 * its scoped-product set disagreeing. The product set is replaced
 * (delete-then-recreate) rather than diffed — simplest correct behavior for
 * a small per-voucher set — but ONLY when the caller explicitly passes
 * `productIds`. `productIds === undefined` means "caller isn't touching the
 * product set" and leaves existing `VoucherProduct` rows completely alone:
 * a partial edit that only changes e.g. `value` on a SELECTED-scope voucher
 * must never silently wipe its product list just because that one call
 * didn't happen to mention it. To also clear a SELECTED voucher's product
 * set (e.g. when flipping `scope` back to `ALL`), pass `productIds: []`
 * explicitly alongside it. (Leaving stale `VoucherProduct` rows behind after
 * an ALL flip without an explicit `productIds: []` is harmless — they're
 * never read while `scope === "ALL"` — just not proactively cleaned up.)
 */
export async function updateVoucher(
  db: PrismaClient,
  voucherId: number,
  args: {
    code?: string;
    type?: VoucherType;
    value?: Decimal.Value;
    usageLimit?: number | null;
    minPurchase?: Decimal.Value;
    expiresAt?: Date | null;
    maxDiscount?: Decimal.Value | null;
    startAt?: Date | null;
    isActive?: boolean;
    scope?: VoucherScope;
    productIds?: number[];
  },
) {
  const existing = await db.voucher.findUnique({ where: { id: voucherId } });
  if (!existing) throw new Error("voucher not found");

  const nextCode = args.code !== undefined ? args.code.toUpperCase() : existing.code;
  if (nextCode !== existing.code && existing.usedCount > 0) {
    throw new Error("cannot change the code of a voucher that has been used");
  }

  const data: Record<string, unknown> = {};
  if (args.code !== undefined) data.code = nextCode;
  if (args.type !== undefined) data.type = args.type;
  if (args.value !== undefined) data.value = new Decimal(args.value);
  if (args.usageLimit !== undefined) data.usageLimit = args.usageLimit;
  if (args.minPurchase !== undefined) data.minPurchase = new Decimal(args.minPurchase);
  if (args.expiresAt !== undefined) data.expiresAt = args.expiresAt;
  if (args.maxDiscount !== undefined) {
    data.maxDiscount = args.maxDiscount != null ? new Decimal(args.maxDiscount) : null;
  }
  if (args.startAt !== undefined) data.startAt = args.startAt;
  if (args.isActive !== undefined) data.isActive = args.isActive;
  if (args.scope !== undefined) data.scope = args.scope;

  const finalScope = args.scope ?? existing.scope;

  // Only touch the VoucherProduct set when the caller explicitly passed
  // productIds — omitting it (undefined) must never delete existing rows
  // (Critical fix, code review round 1: a bare `updateVoucher(db, id,
  // { value: "25" })` on a SELECTED-scope voucher was silently wiping its
  // entire product set, since deleteMany ran unconditionally on every call).
  const ops =
    args.productIds !== undefined
      ? [
          db.voucher.update({ where: { id: voucherId }, data }),
          db.voucherProduct.deleteMany({ where: { voucherId } }),
          ...(finalScope === VoucherScope.SELECTED && args.productIds.length > 0
            ? [db.voucherProduct.createMany({ data: args.productIds.map((productId) => ({ voucherId, productId })) })]
            : []),
        ]
      : [db.voucher.update({ where: { id: voucherId }, data })];

  await db.$transaction(ops);

  return db.voucher.findUnique({ where: { id: voucherId } });
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
  /** "ALL" | "SELECTED" (VoucherScope) — which cart lines the discount applies to. */
  scope: string;
  /** Absolute cap on the computed discount, applied after the eligibleSubtotal
   *  cap. Null = uncapped (today's behavior). */
  maxDiscount: Decimal.Value | null;
  /** Voucher isn't usable before this instant. Null = no schedule (usable
   *  immediately, subject to the other checks). */
  startAt: Date | null;
}

/**
 * Compute the discount given a voucher, without mutating anything. Throws
 * ValidationError (i18n key) when the voucher is invalid. Returns the
 * discount as a positive Decimal (caller subtracts it).
 *
 * Two subtotals, deliberately kept separate:
 * - `subtotal` — the full cart subtotal (net of bulk discount). Used ONLY for
 *   the `minPurchase` gate: minPurchase answers "does this buyer qualify at
 *   all by total spend", which must not be conflated with scope ("what
 *   actually gets discounted") — a buyer who clearly qualifies by total
 *   spend shouldn't be rejected just because most of their cart isn't the
 *   scoped item.
 * - `eligibleSubtotal` — the scope-matching lines only (net of their own
 *   bulk discount). Used as the discount base AND its cap. For an ALL-scope
 *   voucher the caller always passes `eligibleSubtotal === subtotal`, which
 *   makes every branch below a no-op change from the pre-scope behavior.
 */
export function applyVoucherToSubtotal(
  voucher: VoucherLike,
  subtotal: Decimal.Value,
  eligibleSubtotal: Decimal.Value,
  now: Date = new Date(),
): Decimal {
  const sub = new Decimal(subtotal);
  const eligibleSub = new Decimal(eligibleSubtotal);

  if (!voucher.isActive) throw new ValidationError("error.voucher_inactive");
  if (voucher.startAt && voucher.startAt.getTime() > now.getTime()) {
    throw new ValidationError("error.voucher_not_yet_active");
  }
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
  if (voucher.scope === VoucherScope.SELECTED && eligibleSub.lessThanOrEqualTo(0)) {
    // Explicit rejection rather than silently computing a Rp0 discount when
    // nothing in the cart matches the voucher's scope.
    throw new ValidationError("error.voucher_not_applicable");
  }

  let discount =
    voucher.type === VoucherType.PERCENT
      ? eligibleSub.times(voucher.value).div(100)
      : new Decimal(voucher.value);

  if (discount.greaterThan(eligibleSub)) discount = eligibleSub; // cap at the eligible slice, not the whole cart
  if (voucher.maxDiscount != null) {
    const maxDiscount = new Decimal(voucher.maxDiscount);
    if (discount.greaterThan(maxDiscount)) discount = maxDiscount; // the smaller of the two caps wins
  }
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

/** Plain array of the real catalog Product ids a SELECTED-scope voucher
 *  applies to. Empty for an ALL-scope voucher (no VoucherProduct rows). */
export async function getVoucherProductIds(db: Db, voucherId: number): Promise<number[]> {
  const rows = await db.voucherProduct.findMany({ where: { voucherId }, select: { productId: true } });
  return rows.map((r) => r.productId);
}

/** One caller-supplied cart/order line, already priced by whatever pricing
 *  helper the caller uses — see computeEligibleAmounts below for why this
 *  file stays pricing-agnostic instead of recomputing prices itself. */
export interface EligibilityLine {
  /** The real catalog Product id (NOT the Denomination/SKU id) — voucher
   *  scope always matches against this. */
  catalogProductId: number;
  /** This line's own gross subtotal contribution (unitPrice × quantity,
   *  before its own bulk discount — mirrors the full-cart subtotal/
   *  bulkDiscount pair, which are also tracked as two separate numbers
   *  rather than one pre-netted figure). */
  lineSubtotal: Decimal.Value;
  /** This line's own bulk-discount contribution. */
  lineBulkDiscount: Decimal.Value;
}

/**
 * Resolve `(eligibleSubtotal, eligibleBulkDiscount)` for a voucher scoped
 * against a set of already-priced lines — the single source of truth for the
 * "if scope === SELECTED, fetch getVoucherProductIds, then sum only the
 * matching lines; otherwise reuse the full totals untouched" glue that used
 * to be re-implemented near-identically at every checkout/preview call site
 * (`createOrderFromCart`, `createOrderDirect`, the order-bot's confirmation
 * screen, the storefront's checkout preview — code review round 1, Finding 2).
 *
 * ALL-scope (and any non-SELECTED scope) short-circuits to `fullSubtotal`/
 * `fullBulkDiscount` untouched, with zero DB round-trip and zero
 * recomputation — byte-identical to every pre-scope voucher's behavior.
 *
 * Deliberately pricing-agnostic: this file has no dependency on
 * `orders.ts`'s `unitPrice`/`computeBulkDiscountForCart` (`orders.ts` already
 * imports FROM `vouchers.ts`; the reverse would be circular). Each call site
 * computes its own line's subtotal/bulk-discount contribution with whatever
 * pricing helper it already uses and passes the already-computed Decimals in
 * via `lines` — this function only owns the scope-membership fetch/filter/sum
 * step. A single-SKU call site is just the one-line-array case.
 */
export async function computeEligibleAmounts(
  db: Db,
  voucher: { id: number; scope: string },
  lines: EligibilityLine[],
  fullSubtotal: Decimal.Value,
  fullBulkDiscount: Decimal.Value,
): Promise<{ eligibleSubtotal: Decimal; eligibleBulkDiscount: Decimal }> {
  if (voucher.scope !== VoucherScope.SELECTED) {
    return { eligibleSubtotal: new Decimal(fullSubtotal), eligibleBulkDiscount: new Decimal(fullBulkDiscount) };
  }
  const scopedProductIds = new Set(await getVoucherProductIds(db, voucher.id));
  let eligibleSubtotal = new Decimal(0);
  let eligibleBulkDiscount = new Decimal(0);
  for (const line of lines) {
    if (!scopedProductIds.has(line.catalogProductId)) continue;
    eligibleSubtotal = eligibleSubtotal.plus(line.lineSubtotal);
    eligibleBulkDiscount = eligibleBulkDiscount.plus(line.lineBulkDiscount);
  }
  return { eligibleSubtotal, eligibleBulkDiscount };
}

export type VoucherStatus = "active" | "expired" | "usedUp" | "disabled" | "scheduled";

/** Precedence: expired > usedUp > disabled > scheduled > active — a
 *  voucher's status can't depend on which page it's on, so this is the
 *  single source of truth used by both server-side status filtering
 *  (listVouchersPaged) and the KPI aggregate (getVoucherStats).
 *  expired/usedUp stay on top (objective, irreversible-without-an-edit
 *  facts). `disabled` (isActive === false) outranks `scheduled`: an admin
 *  who explicitly turned a voucher off shouldn't see it reported as "on
 *  track to start". Every voucher lands in exactly one bucket — there is no
 *  longer a `null` case. */
export function deriveVoucherStatus(
  v: { isActive: boolean; expiresAt: Date | null; usageLimit: number | null; usedCount: number; startAt: Date | null },
  now: Date = new Date(),
): VoucherStatus {
  if (v.expiresAt && v.expiresAt.getTime() < now.getTime()) return "expired";
  if (v.usageLimit != null && v.usedCount >= v.usageLimit) return "usedUp";
  if (!v.isActive) return "disabled";
  if (v.startAt && v.startAt.getTime() > now.getTime()) return "scheduled";
  return "active";
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

/** Global voucher health counts for the admin page's KPI row — always
 *  computed over the WHOLE table, never scoped to the current search/status
 *  filter or page (mirrors PaymentsPage's KPI cards, which read
 *  server-wide aggregates rather than the currently-filtered/paginated set).
 *  `totalRedemptions` counts `VoucherRedemption` rows, not `sum(usedCount)`:
 *  `usedCount` decrements on order cancellation (releaseOrderHolds,
 *  orders.ts) while VoucherRedemption rows are never deleted, so the
 *  redemption count is the true all-time metric a "Total Redemptions" KPI
 *  should report. */
export async function getVoucherStats(
  db: Db,
  now: Date = new Date(),
): Promise<{ active: number; scheduled: number; expired: number; totalRedemptions: number }> {
  const all = await db.voucher.findMany({
    select: { isActive: true, expiresAt: true, usageLimit: true, usedCount: true, startAt: true },
  });
  let active = 0;
  let scheduled = 0;
  let expired = 0;
  for (const v of all) {
    const status = deriveVoucherStatus(v, now);
    if (status === "active") active++;
    else if (status === "scheduled") scheduled++;
    else if (status === "expired") expired++;
  }
  const totalRedemptions = await db.voucherRedemption.count();
  return { active, scheduled, expired, totalRedemptions };
}

/**
 * Per-voucher performance for the admin Vouchers page: orders/revenue/
 * customers, aggregated in one query and reduced in JS. DELIVERED-only
 * (mirrors revenue.ts's deliveredRevenueByCurrency — only a completed,
 * fulfilled order counts as "earned" performance). Revenue is a single
 * IDR-equivalent Decimal per voucher: IDR orders pass through unconverted,
 * USDT orders convert via THAT order's own fxRate snapshot (never a live
 * rate) before summing — the same blend-to-IDR convention revenue.ts's
 * combinedRevenueByDay uses for its one intentionally-blended figure, so a
 * voucher's reported revenue is never a mix of raw IDR and raw USDT amounts.
 * Returns an empty Map immediately for an empty `voucherIds` input, without
 * querying.
 */
export async function getVoucherPerformance(
  db: Db,
  voucherIds: number[],
): Promise<Map<number, { ordersCount: number; revenue: Decimal; customers: number }>> {
  if (voucherIds.length === 0) return new Map();

  const orders = await db.order.findMany({
    where: { voucherId: { in: voucherIds }, status: OrderStatus.DELIVERED },
    select: { voucherId: true, userId: true, totalAmount: true, currency: true, fxRate: true },
  });

  const acc = new Map<number, { ordersCount: number; revenue: Decimal; customerIds: Set<number> }>();
  for (const o of orders) {
    if (o.voucherId == null) continue;
    const bucket = acc.get(o.voucherId) ?? { ordersCount: 0, revenue: new Decimal(0), customerIds: new Set<number>() };
    bucket.ordersCount += 1;
    const amountIdr =
      o.currency === "USDT" && o.fxRate != null
        ? new Decimal(o.totalAmount).times(o.fxRate)
        : new Decimal(o.totalAmount);
    bucket.revenue = bucket.revenue.plus(amountIdr);
    bucket.customerIds.add(o.userId);
    acc.set(o.voucherId, bucket);
  }

  const result = new Map<number, { ordersCount: number; revenue: Decimal; customers: number }>();
  for (const [voucherId, b] of acc) {
    result.set(voucherId, { ordersCount: b.ordersCount, revenue: q4(b.revenue), customers: b.customerIds.size });
  }
  return result;
}

/** Batched `{id, name}` product lookup for a page of voucher rows (admin
 *  Vouchers page's `products` column) — one query for the whole page, not an
 *  N+1 per row (mirrors getVoucherPerformance's batching style). ALL-scope
 *  vouchers simply have no VoucherProduct rows and are absent from the
 *  returned Map; callers should default a missing key to `[]`. */
export async function getVoucherProductNames(
  db: Db,
  voucherIds: number[],
): Promise<Map<number, { id: number; name: string }[]>> {
  if (voucherIds.length === 0) return new Map();

  const rows = await db.voucherProduct.findMany({
    where: { voucherId: { in: voucherIds } },
    select: { voucherId: true, product: { select: { id: true, name: true } } },
  });

  const result = new Map<number, { id: number; name: string }[]>();
  for (const r of rows) {
    const list = result.get(r.voucherId) ?? [];
    list.push(r.product);
    result.set(r.voucherId, list);
  }
  return result;
}

/** Toggle-only bulk action — can't fail per-item, so a simple updateMany
 *  suffices (mirrors bulkSetCatalogProductsActive, packages/db/src/crud/catalog.ts:212-216). */
export async function bulkSetVouchersActive(db: Db, ids: number[], isActive: boolean): Promise<number> {
  if (!ids.length) return 0;
  const res = await db.voucher.updateMany({ where: { id: { in: ids } }, data: { isActive } });
  return res.count;
}

/** Delete can fail per-item (a used voucher can't be deleted — same guard as
 *  the existing single-id deleteVoucher), so this needs the richer
 *  succeeded/failed shape — mirrors POST /api/orders/bulk-action's
 *  loop-and-collect pattern (apps/web-admin/src/routes/api/orders.ts:455-485). */
export async function bulkDeleteVouchers(
  db: Db,
  ids: number[],
): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }> {
  const succeeded: number[] = [];
  const failed: { id: number; error: string }[] = [];
  for (const id of ids) {
    const voucher = await db.voucher.findUnique({ where: { id } });
    if (!voucher) {
      failed.push({ id, error: "voucher not found" });
      continue;
    }
    if (voucher.usedCount > 0) {
      failed.push({ id, error: "cannot delete a voucher that has been used" });
      continue;
    }
    await db.voucher.delete({ where: { id } });
    succeeded.push(id);
  }
  return { succeeded, failed };
}
