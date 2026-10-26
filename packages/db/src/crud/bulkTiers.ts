/**
 * Volume ("bulk") pricing tiers, keyed by denomination — the crud half of the
 * tiered pricing engine in `@app/core/bulk`.
 *
 * Source of truth: `bulk_pricing_tiers` rows, gated by
 * `Denomination.tieredPricingEnabled`. A SKU whose toggle is off is priced as
 * if it had no tiers at all, whatever rows it still carries (the admin can
 * switch a tier set off and back on without retyping it).
 *
 * The legacy single-rule table (`bulk_pricing`) is kept as a MIRROR during the
 * transition, so a rollback to code that only knows that table still finds a
 * sensible rule: every write here re-derives the legacy row from the tier set
 * (see {@link legacyViewOfTiers}). Nothing in the new code reads the mirror to
 * price an order — it exists for old code and the storefront badge only.
 *
 * Pricing helpers at the bottom ({@link priceLineWithTiers},
 * {@link quoteBulkForLines}) are the ONE place every preview (storefront
 * checkout, bot confirmation) and every order creation path turns a cart line
 * into a bulk discount, so a preview can never quote a figure the order won't
 * charge.
 */
import {
  TieredPricingError,
  resolveTieredPrice,
  validateTiers,
  type PricingTier,
  type TierDiscountType,
  type TieredPrice,
} from "@app/core/bulk";
import { effectiveUnitPrice, type PricedDenomination } from "@app/core/flash";
import { formatIdr, quantizeMoney } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import type { BulkPricing, BulkPricingTier, Prisma } from "@prisma/client";
import type { Tx } from "../client";
import type { Db } from "./_types";
import { logAdminAction } from "./audit";

const ZERO = new Decimal(0);

/** What an admin submits for one tier. `id` is ignored: tiers are keyed by minQuantity. */
export interface TierInput {
  id?: string;
  minQuantity: number;
  discountType: TierDiscountType | string;
  discountValue: Decimal.Value;
  isEnabled?: boolean;
}

/** The acting admin, for the audit trail. */
export interface TierActor {
  adminId: number | null;
}

/** Run `fn` in its own short transaction, or inside the caller's when handed a `Tx`. */
function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const ownsTransaction = "$transaction" in db && typeof db.$transaction === "function";
  return ownsTransaction ? (db as { $transaction: <R>(f: (tx: Tx) => Promise<R>) => Promise<R> }).$transaction(fn) : fn(db);
}

function toPricingTier(row: BulkPricingTier): PricingTier {
  return {
    id: String(row.id),
    minQuantity: row.minQuantity,
    discountType: row.discountType as TierDiscountType,
    discountValue: row.discountValue,
    isEnabled: row.isEnabled,
    sortOrder: row.sortOrder,
  };
}

/**
 * The stored scale of a tier value: a percent keeps 2 decimals (the legacy
 * `discount_percent` precision, so a migrated rule charges the same rupiah);
 * a money amount keeps 4, like every other money column.
 */
function normalizeValue(type: string, value: Decimal.Value): Decimal | null {
  let d: Decimal;
  try {
    d = new Decimal(value);
  } catch {
    return null;
  }
  if (!d.isFinite()) return null;
  return quantizeMoney(d, type === "PERCENTAGE" ? 2 : 4);
}

/** Every tier of a denomination (disabled ones included), lowest minQuantity first. */
export async function listTiers(db: Db, denominationId: number): Promise<PricingTier[]> {
  const rows = await db.bulkPricingTier.findMany({
    where: { denominationId },
    orderBy: { minQuantity: "asc" },
  });
  return rows.map(toPricingTier);
}

/**
 * The single legacy rule a tier set can be shown as: the lowest-threshold
 * enabled PERCENTAGE tier, or null (toggle off, no tiers, or only fixed-amount
 * tiers — a fixed amount has no percent without a unit price). Used for the
 * `bulk_pricing` mirror and the legacy {@link getBulkPricingForDenomination} view.
 */
export function legacyViewOfTiers(
  enabled: boolean,
  tiers: readonly PricingTier[],
): { minQuantity: number; discountPercent: Decimal } | null {
  if (!enabled) return null;
  const first = [...tiers]
    .filter((t) => t.isEnabled && t.discountType === "PERCENTAGE")
    .sort((a, b) => a.minQuantity - b.minQuantity)[0];
  return first ? { minQuantity: first.minQuantity, discountPercent: new Decimal(first.discountValue) } : null;
}

/** Re-derive the legacy `bulk_pricing` row from the current tier state (rollback safety). */
async function syncLegacyMirror(db: Db, denominationId: number, enabled: boolean, tiers: readonly PricingTier[]) {
  const view = legacyViewOfTiers(enabled, tiers);
  const existing = await db.bulkPricing.findUnique({ where: { productId: denominationId } });
  if (view) {
    if (existing) {
      await db.bulkPricing.update({
        where: { productId: denominationId },
        data: { minQuantity: view.minQuantity, discountPercent: view.discountPercent, isActive: true },
      });
    } else {
      await db.bulkPricing.create({
        data: { productId: denominationId, minQuantity: view.minQuantity, discountPercent: view.discountPercent },
      });
    }
  } else if (existing?.isActive) {
    await db.bulkPricing.update({ where: { productId: denominationId }, data: { isActive: false } });
  }
}

/**
 * Write `tiers` as the denomination's complete tier set, without auditing —
 * shared by {@link replaceTiers} and the legacy adapters, whose callers audit
 * themselves. Diffs by minQuantity (the unique key), so an unchanged tier keeps
 * its id. Must run inside a transaction.
 */
async function writeTierSet(db: Db, denominationId: number, tiers: readonly PricingTier[]): Promise<PricingTier[]> {
  const sorted = [...tiers].sort((a, b) => a.minQuantity - b.minQuantity);
  const existing = await db.bulkPricingTier.findMany({ where: { denominationId } });
  const byMin = new Map(existing.map((row) => [row.minQuantity, row]));
  const keep = new Set(sorted.map((t) => t.minQuantity));
  const stale = existing.filter((row) => !keep.has(row.minQuantity)).map((row) => row.id);
  if (stale.length > 0) await db.bulkPricingTier.deleteMany({ where: { id: { in: stale } } });
  for (const [index, t] of sorted.entries()) {
    const data = {
      discountType: t.discountType,
      discountValue: new Decimal(t.discountValue),
      isEnabled: t.isEnabled,
      sortOrder: index,
    };
    const row = byMin.get(t.minQuantity);
    if (row) await db.bulkPricingTier.update({ where: { id: row.id }, data });
    else await db.bulkPricingTier.create({ data: { denominationId, minQuantity: t.minQuantity, ...data } });
  }
  return listTiers(db, denominationId);
}

/** Validate and normalize admin input into tiers, or throw TieredPricingError. */
function parseTierInputs(inputs: readonly TierInput[]): PricingTier[] {
  const tiers: PricingTier[] = inputs.map((input, index) => {
    const value = normalizeValue(String(input.discountType), input.discountValue);
    return {
      id: input.id ?? `new-${index}`,
      minQuantity: input.minQuantity,
      discountType: input.discountType as TierDiscountType,
      // An unparseable value is kept as NaN so validateTiers reports it.
      discountValue: value ?? Number.NaN,
      isEnabled: input.isEnabled ?? true,
    };
  });
  const result = validateTiers(tiers);
  if (!result.ok) throw new TieredPricingError("INVALID_TIERS", result.errors);
  return tiers;
}

function describeTier(t: PricingTier): string {
  const value = new Decimal(t.discountValue).toString();
  const what =
    t.discountType === "PERCENTAGE"
      ? `${value}% off`
      : t.discountType === "FIXED_AMOUNT_OFF_PER_UNIT"
        ? `${formatIdr(value)} off each unit`
        : `${formatIdr(value)} per unit`;
  return `${t.minQuantity}+ units: ${what}${t.isEnabled ? "" : " (disabled)"}`;
}

async function denominationOrThrow(db: Db, denominationId: number) {
  const denomination = await db.denomination.findUnique({
    where: { id: denominationId },
    select: { id: true, name: true, tieredPricingEnabled: true },
  });
  if (!denomination) throw new ValidationError("error.product_unavailable");
  return denomination;
}

/**
 * Replace a denomination's whole tier set (an empty list removes every tier).
 * Validated with the engine's `validateTiers` (duplicates, thresholds, values)
 * before anything is written; one short transaction writes the tiers, the
 * legacy mirror and the audit entry. Does not change the on/off toggle.
 */
export async function replaceTiers(
  db: Db,
  denominationId: number,
  inputs: readonly TierInput[],
  actor: TierActor,
): Promise<PricingTier[]> {
  const tiers = parseTierInputs(inputs);
  return inTransaction(db, async (tx) => {
    const denomination = await denominationOrThrow(tx, denominationId);
    const written = await writeTierSet(tx, denominationId, tiers);
    await syncLegacyMirror(tx, denominationId, denomination.tieredPricingEnabled, written);
    const details =
      written.length === 0
        ? `Removed every volume pricing tier from "${denomination.name}".`
        : `Saved ${written.length} volume pricing tiers for "${denomination.name}": ${written.map(describeTier).join("; ")}.`;
    await logAdminAction(tx, {
      adminId: actor.adminId,
      action: "pricing_tiers_replace",
      targetType: "denomination",
      targetId: denominationId,
      details,
    });
    return written;
  });
}

/** Switch tiered pricing on or off for one denomination, keeping its tiers. Audited. */
export async function setTieredPricingEnabled(
  db: Db,
  denominationId: number,
  enabled: boolean,
  actor: TierActor,
): Promise<void> {
  await inTransaction(db, async (tx) => {
    const denomination = await denominationOrThrow(tx, denominationId);
    await tx.denomination.update({ where: { id: denominationId }, data: { tieredPricingEnabled: enabled } });
    await syncLegacyMirror(tx, denominationId, enabled, await listTiers(tx, denominationId));
    await logAdminAction(tx, {
      adminId: actor.adminId,
      action: "tiered_pricing_toggle",
      targetType: "denomination",
      targetId: denominationId,
      details: enabled
        ? `Turned on volume pricing for "${denomination.name}".`
        : `Turned off volume pricing for "${denomination.name}"; its tiers are kept but no longer discount orders.`,
    });
  });
}

/** True when `next` would store exactly the tiers `current` already holds (order does not matter). */
function sameTierSet(current: readonly PricingTier[], next: readonly PricingTier[]): boolean {
  if (current.length !== next.length) return false;
  const byMin = new Map(current.map((t) => [t.minQuantity, t]));
  return next.every((t) => {
    const stored = byMin.get(t.minQuantity);
    return (
      stored !== undefined &&
      stored.discountType === t.discountType &&
      stored.isEnabled === t.isEnabled &&
      new Decimal(stored.discountValue).equals(new Decimal(t.discountValue))
    );
  });
}

/**
 * The admin tier editor's one save: the whole tier set AND the on/off toggle,
 * in one short transaction, so the toggle can never end up on over a tier set
 * that failed to save. Each part is written (and audited) only when it
 * actually changes — re-saving an unchanged editor writes nothing. Throws
 * TieredPricingError for an invalid set before anything is written.
 */
export async function saveTieredPricing(
  db: Db,
  denominationId: number,
  input: { enabled: boolean; tiers: readonly TierInput[] },
  actor: TierActor,
): Promise<{ enabled: boolean; tiers: PricingTier[] }> {
  const parsed = parseTierInputs(input.tiers);
  return inTransaction(db, async (tx) => {
    const denomination = await denominationOrThrow(tx, denominationId);
    const current = await listTiers(tx, denominationId);
    const tiers = sameTierSet(current, parsed) ? current : await replaceTiers(tx, denominationId, input.tiers, actor);
    if (denomination.tieredPricingEnabled !== input.enabled) {
      await setTieredPricingEnabled(tx, denominationId, input.enabled, actor);
    }
    return { enabled: input.enabled, tiers };
  });
}

/**
 * Validate on read: drop any stored tier the engine would refuse (a row
 * written by hand, or before a guard existed) instead of failing checkout on
 * it — the same rule `activeBulkPercent` applies to a legacy rule. Duplicate
 * thresholds cannot reach here (unique index).
 */
function usableTiers(denominationId: number, tiers: PricingTier[]): PricingTier[] {
  const usable = tiers.filter((t) => t.isEnabled && validateTiers([t]).ok);
  const dropped = tiers.filter((t) => t.isEnabled).length - usable.length;
  if (dropped > 0) {
    logger.warn(
      { denominationId, dropped },
      `Ignored ${dropped} stored volume pricing tiers on denomination ${denominationId} because their threshold, type or value is invalid. Those tiers will not discount any order until an admin fixes them in the tier editor.`,
    );
  }
  return usable;
}

/**
 * Enabled, valid tiers per denomination, for every id whose tiered pricing is
 * switched on. Denominations with the toggle off (or no tiers) are absent.
 */
export async function effectiveTiersByDenomination(db: Db, ids: readonly number[]): Promise<Map<number, PricingTier[]>> {
  const out = new Map<number, PricingTier[]>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const rows = await db.bulkPricingTier.findMany({
    where: { denominationId: { in: unique }, isEnabled: true, denomination: { tieredPricingEnabled: true } },
    orderBy: [{ denominationId: "asc" }, { minQuantity: "asc" }],
  });
  const grouped = new Map<number, PricingTier[]>();
  for (const row of rows) {
    const list = grouped.get(row.denominationId) ?? [];
    list.push(toPricingTier(row));
    grouped.set(row.denominationId, list);
  }
  for (const [id, tiers] of grouped) {
    const usable = usableTiers(id, tiers);
    if (usable.length > 0) out.set(id, usable);
  }
  return out;
}

/** The tiers that price this denomination right now — [] when its tiered pricing is off. */
export async function getEffectiveTiers(db: Db, denominationId: number): Promise<PricingTier[]> {
  return (await effectiveTiersByDenomination(db, [denominationId])).get(denominationId) ?? [];
}

/** Storefront badges: enabled tiers keyed by denomination id (lowest threshold first). */
export async function activeTiersByDenomination(
  db: Db,
  ids: readonly number[],
): Promise<Record<number, PricingTier[]>> {
  return Object.fromEntries(await effectiveTiersByDenomination(db, ids));
}

// ---------------------------------------------------------------------------
// Legacy single-rule adapters (bulk_pricing). Signatures and results unchanged;
// re-exported from ./catalog where they always lived.
// ---------------------------------------------------------------------------

/**
 * Legacy "N+ units, X% off" setter: writes the rule as the denomination's ONE
 * PERCENTAGE tier (replacing any others), switches tiered pricing on, and keeps
 * the old `bulk_pricing` row written too. Not audited — its callers (web admin
 * bulk-pricing route, bot admin) write their own audit line.
 */
export async function upsertBulkPricingAdapter(
  db: Db,
  denominationId: number,
  minQuantity: number,
  discountPercent: Decimal,
): Promise<BulkPricing> {
  return inTransaction(db, async (tx) => {
    const existing = await tx.bulkPricing.findUnique({ where: { productId: denominationId } });
    const row = existing
      ? await tx.bulkPricing.update({
          where: { productId: denominationId },
          data: { minQuantity, discountPercent, isActive: true },
        })
      : await tx.bulkPricing.create({ data: { productId: denominationId, minQuantity, discountPercent } });
    await writeTierSet(tx, denominationId, [
      { id: "legacy", minQuantity, discountType: "PERCENTAGE", discountValue: discountPercent, isEnabled: true },
    ]);
    await tx.denomination.update({ where: { id: denominationId }, data: { tieredPricingEnabled: true } });
    return row;
  });
}

/** Legacy delete: removes the rule, every tier, and switches tiered pricing off. True if anything was removed. */
export async function deleteBulkPricingAdapter(db: Db, denominationId: number): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    const legacy = await tx.bulkPricing.deleteMany({ where: { productId: denominationId } });
    const tiers = await tx.bulkPricingTier.deleteMany({ where: { denominationId } });
    if (legacy.count === 0 && tiers.count === 0) return false;
    await tx.denomination.updateMany({ where: { id: denominationId }, data: { tieredPricingEnabled: false } });
    return true;
  });
}

/**
 * The legacy single-rule view, derived from the tiers (authoritative): the
 * lowest enabled PERCENTAGE tier while tiered pricing is on, else null. Shaped
 * as the old `BulkPricing` row so display callers keep working.
 */
export async function legacyBulkRuleView(db: Db, denominationId: number): Promise<BulkPricing | null> {
  const [denomination, tiers, row] = await Promise.all([
    db.denomination.findUnique({ where: { id: denominationId }, select: { tieredPricingEnabled: true } }),
    listTiers(db, denominationId),
    db.bulkPricing.findUnique({ where: { productId: denominationId } }),
  ]);
  const view = legacyViewOfTiers(denomination?.tieredPricingEnabled ?? false, tiers);
  if (!view) return null;
  return {
    id: row?.id ?? 0,
    productId: denominationId,
    minQuantity: view.minQuantity,
    discountPercent: view.discountPercent as unknown as Prisma.Decimal,
    isActive: true,
    createdAt: row?.createdAt ?? new Date(0),
  };
}

// ---------------------------------------------------------------------------
// Pricing — the one path from a cart line to a bulk discount.
// ---------------------------------------------------------------------------

/** Bump when the snapshot shape or the engine's arithmetic changes. */
export const BULK_TIER_ENGINE_VERSION = 1;

export interface BulkTierSnapshotLine {
  denominationId: number;
  quantity: number;
  tierId: string | null;
  minQuantity: number | null;
  discountType: TierDiscountType | null;
  discountValue: string | null;
  baseUnitPrice: string;
  finalUnitPrice: string;
  totalDiscount: string;
}

/** Stored on `Order.bulkTierSnapshot` when any tier applied; never recomputed later. */
export interface BulkTierSnapshot {
  version: number;
  lines: BulkTierSnapshotLine[];
}

/**
 * The volume discount an order's stored snapshot gave `quantity` units of
 * `denominationId`, or null when the order carries no usable snapshot (an
 * untiered order, or a historical one priced before tiers existed — callers
 * must not invent a per-line split for those).
 *
 * A snapshot line holds its own `totalDiscount`, so a mixed cart's untiered
 * line gets 0 here rather than a share of another line's discount. Several
 * lines of the same denomination are pooled (Σ discount / Σ quantity). The
 * result is rounded UP to 4dp: callers subtract it from a budget, and a budget
 * must never exceed what the buyer actually paid.
 */
export function snapshotBulkDiscountFor(snapshot: unknown, denominationId: number, quantity: number): Decimal | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const lines = (snapshot as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return null;
  let discount = ZERO;
  let units = 0;
  for (const raw of lines) {
    const line = raw as Partial<BulkTierSnapshotLine> | null;
    if (!line || line.denominationId !== denominationId) continue;
    let lineDiscount: Decimal;
    try {
      lineDiscount = new Decimal(line.totalDiscount ?? 0);
    } catch {
      return null;
    }
    if (!lineDiscount.isFinite() || typeof line.quantity !== "number" || line.quantity <= 0) return null;
    discount = discount.plus(lineDiscount);
    units += line.quantity;
  }
  if (units === 0 || !discount.greaterThan(0)) return ZERO;
  return discount.times(quantity).div(units).toDecimalPlaces(4, Decimal.ROUND_UP);
}

export type PricedLineWithTiers = TieredPrice & {
  /** The unit before tiers: reseller/flash already applied (`effectiveUnitPrice`). */
  effectiveUnit: Decimal;
};

/**
 * Price one line: the buyer's effective unit (reseller/flash, at `now`), then
 * the tiers on top. Pure — the caller loads `tiers` (getEffectiveTiers).
 */
export function priceLineWithTiers(args: {
  denomination: PricedDenomination;
  quantity: number;
  isReseller: boolean;
  now: Date;
  tiers: readonly PricingTier[];
}): PricedLineWithTiers {
  const effectiveUnit = effectiveUnitPrice(args.denomination, args.isReseller, args.now);
  const priced = resolveTieredPrice({ effectiveUnit, quantity: args.quantity, tiers: args.tiers });
  return { ...priced, effectiveUnit };
}

export interface BulkQuoteLine {
  denominationId: number;
  quantity: number;
  priced: PricedLineWithTiers;
}

export interface BulkQuote {
  lines: BulkQuoteLine[];
  /** Σ effectiveUnit × quantity over every line. */
  subtotal: Decimal;
  /** Σ per-line tier discount, quantized to 4dp (whole rupiah in practice). */
  bulkDiscount: Decimal;
  /** Null when no line had a tier applied. */
  snapshot: BulkTierSnapshot | null;
}

/** Pure: combine already-priced lines into a quote and its snapshot. */
export function buildBulkQuote(lines: BulkQuoteLine[]): BulkQuote {
  let subtotal = ZERO;
  let discount = ZERO;
  for (const line of lines) {
    subtotal = subtotal.plus(line.priced.originalSubtotal);
    discount = discount.plus(line.priced.totalDiscount);
  }
  const anyApplied = lines.some((l) => l.priced.appliedTier !== null);
  const snapshot: BulkTierSnapshot | null = anyApplied
    ? {
        version: BULK_TIER_ENGINE_VERSION,
        lines: lines.map(({ denominationId, quantity, priced }) => {
          const tier = priced.appliedTier;
          return {
            denominationId,
            quantity,
            tierId: tier?.id ?? null,
            minQuantity: tier?.minQuantity ?? null,
            discountType: tier?.discountType ?? null,
            discountValue: tier ? new Decimal(tier.discountValue).toString() : null,
            baseUnitPrice: priced.baseUnitPrice.toString(),
            finalUnitPrice: priced.finalUnitPrice.toString(),
            totalDiscount: priced.totalDiscount.toString(),
          };
        }),
      }
    : null;
  return { lines, subtotal, bulkDiscount: quantizeMoney(discount, 4), snapshot };
}

/**
 * Load the tiers for every line (one query) and price the lot. Every preview
 * and both order-creation paths call this, so they agree to the rupiah.
 * Pass the order's transaction client to read the tiers inside it.
 */
export async function quoteBulkForLines(
  db: Db,
  lines: ReadonlyArray<{ denominationId: number; quantity: number; denomination: PricedDenomination }>,
  isReseller: boolean,
  now: Date,
): Promise<BulkQuote> {
  const tiersById = await effectiveTiersByDenomination(db, lines.map((l) => l.denominationId));
  return buildBulkQuote(
    lines.map((l) => ({
      denominationId: l.denominationId,
      quantity: l.quantity,
      priced: priceLineWithTiers({
        denomination: l.denomination,
        quantity: l.quantity,
        isReseller,
        now,
        tiers: tiersById.get(l.denominationId) ?? [],
      }),
    })),
  );
}
