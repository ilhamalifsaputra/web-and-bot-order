/**
 * Pricing & Margins persistence: the stored selling-price policy for
 * supplier-costed (Digiflazz) SKUs, and the explicit "Apply now" reprice.
 *
 * The formula itself lives in `@app/core/pricingRule` (pure). This module only
 * loads and stores the policy pieces it needs:
 *  - the global default rule — the SAME `digiflazz_markup_type` /
 *    `digiflazz_markup_value` Settings rows the import/resync have always read,
 *    so there is one persistence authority for it;
 *  - `pricing_rounding` (blank = "none", the pre-refactor behaviour);
 *  - `pricing_low_margin_warn_pct` (blank = off; a warning only, never a block);
 *  - per-category rules on `Category.markupType` / `markupValue` (both null =
 *    inherit the global default).
 *
 * Every write is audited with a sentence a shop admin can read (docs/LOGGING.md).
 */
import { Prisma } from "@prisma/client";
import { Decimal, moneyEq } from "@app/core/money";
import { formatIdr } from "@app/core/formatters";
import { CategoryGroup } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { parsePercentInput } from "@app/core/moneyFormat";
import {
  isRoundingPolicy,
  readStoredMarkupRule,
  resolveDenominationPrice,
  type MarkupRule,
  type MarkupType,
  type RoundingPolicy,
} from "@app/core/pricingRule";
import type { Db } from "./_types";
import type { PrismaClient } from "../client";
import { setSetting, invalidateSettingCache } from "./settings";
import { logAdminAction } from "./audit";
import { updateDenomination } from "./catalog";
import { createHash } from "node:crypto";
import { denominationPriceError, MIN_SALE_PRICE } from "@app/core/denominationPrices";
import {
  DIGIFLAZZ_MARKUP_TYPE_KEY,
  DIGIFLAZZ_MARKUP_VALUE_KEY,
  DIGIFLAZZ_SUPPLIER_SCOPE,
  DIGIFLAZZ_CATALOG_SYNC_LEASE_KEY,
  claimDigiflazzCatalogSyncLease,
  releaseDigiflazzCatalogSyncLease,
} from "./digiflazz";

export const PRICING_ROUNDING_KEY = "pricing_rounding";
export const PRICING_LOW_MARGIN_WARN_PCT_KEY = "pricing_low_margin_warn_pct";

// Digiflazz also imports this module. Resolve its shared constants at call
// time so module initialization order cannot capture undefined values.
function policySettingKeys(): string[] {
  return [DIGIFLAZZ_MARKUP_TYPE_KEY, DIGIFLAZZ_MARKUP_VALUE_KEY, PRICING_ROUNDING_KEY, PRICING_LOW_MARGIN_WARN_PCT_KEY];
}

/** Invalid pricing input; the message is fit to show an admin (Task 4 → 400). */
export class PricingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingValidationError";
  }
}

/** The stored global markup or rounding cannot be read, so no price may be
 * computed from it. The message is fit to show an admin. */
export class PricingPolicyUnreadableError extends Error {
  /** `categoryNames`: for "category", every category whose rule is unreadable. */
  constructor(what: "markup" | "rounding" | "category", categoryNames: string[] = []) {
    super(
      what === "markup"
        ? "The stored default markup cannot be read as a number of zero or more, so no price can be computed from it. Save the default markup again on the Pricing & Margins page."
        : what === "rounding"
        ? "The stored rounding policy is not one this version knows, so no price can be computed from it. Save the rounding policy again on the Pricing & Margins page."
        : `The stored markup rule of ${categoryNames.map((n) => `category "${n}"`).join(", ")} cannot be read, so no price can be computed from it. Remove or save that category rule again on the Pricing & Margins page.`,
    );
    this.name = "PricingPolicyUnreadableError";
  }
}

/** A Digiflazz catalog sync (or another reprice) holds the shared lease. */
export class RepriceBusyError extends Error {
  constructor() {
    super("A Digiflazz catalog sync or another reprice is running right now. Try again in a minute.");
    this.name = "RepriceBusyError";
  }
}

/** A reprice lost the shared lease mid-run (it expired and a catalog sync
 * took it). Batches already done keep their prices and are audited. */
export class RepriceLeaseLostError extends Error {
  constructor() {
    super("The reprice stopped part-way because a Digiflazz catalog sync took over. Items repriced so far keep their new price; run it again to finish.");
    this.name = "RepriceLeaseLostError";
  }
}

export interface PricingPolicy {
  /** The global default rule; null when the stored value is unreadable. */
  globalRule: MarkupRule | null;
  globalRuleReadable: boolean;
  /** The raw stored strings behind `globalRule` (null = unset). */
  globalRaw: { type: string | null; value: string | null };
  /** "none" when blank/unset — and also when unreadable (see roundingReadable). */
  rounding: RoundingPolicy;
  roundingReadable: boolean;
  roundingRaw: string | null;
  /** Gross-margin percent below which a SKU is flagged; null = off (blank,
   * unset, or an unreadable stored value — a warning is never load-bearing). */
  lowMarginWarnPct: Decimal | null;
}

/** A plain decimal (as this module stores it) read exactly; anything else by
 * percent shape. Null when unreadable. */
function readStoredPercent(raw: string): Decimal | null {
  if (/^\d{1,30}(\.\d{1,30})?$/.test(raw)) return new Decimal(raw);
  return parsePercentInput(raw);
}

export async function getPricingPolicy(db: Db): Promise<PricingPolicy> {
  const policyKeys = policySettingKeys();
  // One database snapshot: independently cached reads could combine the old
  // percent amount with a newly saved flat type (or the reverse).
  const rows = await db.setting.findMany({ where: { key: { in: policyKeys } }, select: { key: true, value: true } });
  const values = new Map(rows.map(row => [row.key, row.value]));
  const [type, value, roundingRaw, lowRaw] = policyKeys.map(key => values.get(key) ?? null) as [string | null, string | null, string | null, string | null];
  const globalRule = readStoredMarkupRule({ type, value });
  const roundingTrim = (roundingRaw ?? "").trim();
  const roundingReadable = roundingTrim === "" || isRoundingPolicy(roundingTrim);
  const lowTrim = (lowRaw ?? "").trim();
  return {
    globalRule,
    globalRuleReadable: globalRule !== null,
    globalRaw: { type, value },
    rounding: roundingTrim !== "" && isRoundingPolicy(roundingTrim) ? roundingTrim : "none",
    roundingReadable,
    roundingRaw,
    lowMarginWarnPct: lowTrim === "" ? null : readStoredPercent(lowTrim),
  };
}

// ---- Admin-facing wording (audit details) ----

function describeRupiah(v: Decimal): string {
  return v.isInteger() ? formatIdr(v) : `Rp${v.toFixed()}`;
}

/** "10%", "0%", "a flat Rp1.500", or "no markup" (blank type). */
function describeRule(rule: MarkupRule | null): string {
  if (rule === null) return "an unreadable value";
  if (rule.type === null) return "no markup";
  return rule.type === "percent" ? `${rule.value.toFixed()}%` : `a flat ${describeRupiah(rule.value)}`;
}

function describeRounding(p: RoundingPolicy): string {
  return p === "none" ? "none" : `round up to ${formatIdr(p.slice("ceil_".length))}`;
}

function describeWarn(v: Decimal | null): string {
  return v === null ? "off" : `${v.toFixed()}%`;
}

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Same type and, unless blank, the same amount (a blank type is zero markup
 * whatever value holds). Unreadable (null) never equals anything. */
function rulesEqual(a: MarkupRule | null, b: MarkupRule | null): boolean {
  if (a === null || b === null) return false;
  if (a.type !== b.type) return false;
  return a.type === null || a.value.equals(b.value);
}

// ---- Global policy ----

export interface GlobalPricingInput {
  /** null = blank (no markup). Must be passed together with markupValue. */
  markupType?: MarkupType | null;
  markupValue?: Decimal;
  rounding?: RoundingPolicy;
  /** null = off. */
  lowMarginWarnPct?: Decimal | null;
}

/** Upper bounds keep a typo from pricing the catalog at absurd values and keep
 * the stored plain decimal well inside readStoredMarkupValue's digit limits. */
export const MAX_PERCENT_MARKUP = new Decimal(1000);
export const MAX_FLAT_MARKUP_IDR = new Decimal(100_000_000);
/** Percents (markup, low-margin warning) carry at most this many decimals. */
const PERCENT_MAX_DP = 4;

/** A percent or flat markup amount: zero or more, bounded, a percent with at
 * most 4 decimals, a flat amount in whole rupiah (IDR has no fraction). */
function validateMarkupAmount(type: MarkupType, value: Decimal): void {
  if (!value.isFinite() || value.isNegative()) throw new PricingValidationError("The markup must be zero or more.");
  if (type === "percent") {
    if (value.gt(MAX_PERCENT_MARKUP)) throw new PricingValidationError("A percent markup can be at most 1000%.");
    if (value.decimalPlaces() > PERCENT_MAX_DP) {
      throw new PricingValidationError("A percent markup can have at most 4 decimal places.");
    }
  } else {
    if (value.gt(MAX_FLAT_MARKUP_IDR)) throw new PricingValidationError("A flat markup can be at most Rp100.000.000.");
    if (!value.isInteger()) throw new PricingValidationError("A flat markup must be a whole rupiah amount.");
  }
}

export function validateGlobalPricingInput(input: GlobalPricingInput): void {
  const hasType = input.markupType !== undefined;
  const hasValue = input.markupValue !== undefined;
  if (hasType !== hasValue) throw new PricingValidationError("Set the markup type and amount together.");
  if (hasType) {
    if (input.markupType !== null && input.markupType !== "percent" && input.markupType !== "flat") {
      throw new PricingValidationError('Markup type must be "percent", "flat" or empty.');
    }
    if (!input.markupValue!.isFinite() || input.markupValue!.isNegative()) {
      throw new PricingValidationError("The markup must be zero or more.");
    }
    if (input.markupType !== null) validateMarkupAmount(input.markupType, input.markupValue!);
  }
  if (input.rounding !== undefined && !isRoundingPolicy(input.rounding)) {
    throw new PricingValidationError("Choose one of the listed rounding options.");
  }
  const warn = input.lowMarginWarnPct;
  if (warn !== undefined && warn !== null) {
    if (!warn.isFinite() || warn.isNegative() || warn.gte(100)) {
      throw new PricingValidationError("The low-margin warning must be at least 0% and below 100%.");
    }
    if (warn.decimalPlaces() > PERCENT_MAX_DP) {
      throw new PricingValidationError("The low-margin warning can have at most 4 decimal places.");
    }
  }
}

/**
 * Store the global pricing policy. Fields left undefined stay as they are.
 * Writes only the keys that actually change and one audit sentence for them;
 * returns `{ changed: false }` without auditing when nothing changes.
 */
export async function setGlobalPricing(
  db: Db,
  adminId: number | null,
  input: GlobalPricingInput,
): Promise<{ changed: boolean }> {
  validateGlobalPricingInput(input);
  if ("$transaction" in db) {
    const result = await db.$transaction(tx => setGlobalPricing(tx, adminId, input));
    if (result.changed) invalidateSettingCache(db, policySettingKeys());
    return result;
  }
  const before = await getPricingPolicy(db);
  const clauses: string[] = [];
  const writes: Array<[string, string]> = [];

  if (input.markupType !== undefined) {
    const next: MarkupRule = { type: input.markupType, value: input.markupValue! };
    if (!before.globalRuleReadable || !rulesEqual(before.globalRule, next)) {
      clauses.push(`the default markup from ${describeRule(before.globalRule)} to ${describeRule(next)}`);
      writes.push([DIGIFLAZZ_MARKUP_TYPE_KEY, next.type ?? ""]);
      writes.push([DIGIFLAZZ_MARKUP_VALUE_KEY, next.type === null ? "" : next.value.toFixed()]);
    }
  }
  if (input.rounding !== undefined && (input.rounding !== before.rounding || !before.roundingReadable)) {
    clauses.push(`rounding from ${describeRounding(before.rounding)} to ${describeRounding(input.rounding)}`);
    writes.push([PRICING_ROUNDING_KEY, input.rounding]);
  }
  if (input.lowMarginWarnPct !== undefined) {
    const next = input.lowMarginWarnPct;
    const prev = before.lowMarginWarnPct;
    const same = next === null ? prev === null : prev !== null && prev.equals(next);
    if (!same) {
      clauses.push(`the low-margin warning from ${describeWarn(prev)} to ${describeWarn(next)}`);
      writes.push([PRICING_LOW_MARGIN_WARN_PCT_KEY, next === null ? "" : next.toFixed()]);
    }
  }

  if (writes.length === 0) return { changed: false };
  // The outer call supplies one transaction for the complete policy and audit.
  for (const [key, value] of writes) await setSetting(db, key, value);
  await logAdminAction(db, {
    adminId,
    action: "pricing_global_update",
    targetType: "setting",
    details: `Changed ${joinClauses(clauses)}.`,
  });
  return { changed: true };
}

// ---- Category rules ----

export interface CategoryRuleInput {
  markupType: MarkupType | null;
  markupValue: Decimal | null;
}

/** A stored category rule this version cannot read (an unknown type, a
 * missing or negative amount — only reachable by direct SQL). */
export const UNREADABLE_CATEGORY_RULE = "unreadable" as const;
export type StoredCategoryRule = MarkupRule | null | typeof UNREADABLE_CATEGORY_RULE;

/** null = no rule (inherits the global default). Pricing review Minor 4: an
 * unreadable rule is reported, never silently read as "inherit". */
function storedCategoryRule(row: { markupType: string | null; markupValue: Prisma.Decimal | null }): StoredCategoryRule {
  if (row.markupType === null) return null;
  if ((row.markupType !== "percent" && row.markupType !== "flat") || row.markupValue === null) return UNREADABLE_CATEGORY_RULE;
  const value = new Decimal(row.markupValue.toString());
  if (!value.isFinite() || value.isNegative()) return UNREADABLE_CATEGORY_RULE;
  return { type: row.markupType, value };
}

/**
 * Set (or, with both fields null, clear) a category's markup rule. Type and
 * value must be given together; type is "percent" or "flat"; the value is
 * zero or more (a percent, or rupiah for "flat"). No-op without audit when
 * the rule is unchanged.
 */
export async function setCategoryRule(
  db: Db,
  adminId: number | null,
  categoryId: number,
  rule: CategoryRuleInput,
): Promise<{ changed: boolean }> {
  if ("$transaction" in db) return db.$transaction(tx => setCategoryRule(tx, adminId, categoryId, rule));
  const hasType = rule.markupType !== null;
  const hasValue = rule.markupValue !== null;
  if (hasType !== hasValue) throw new PricingValidationError("Set the category's markup type and amount together, or clear both.");
  if (hasType && rule.markupType !== "percent" && rule.markupType !== "flat") {
    throw new PricingValidationError('Markup type must be "percent" or "flat".');
  }
  if (hasType) validateMarkupAmount(rule.markupType!, rule.markupValue!);

  const category = await db.category.findUnique({
    where: { id: categoryId },
    select: { id: true, name: true, group: true, markupType: true, markupValue: true },
  });
  if (!category) throw new PricingValidationError("That category no longer exists.");
  // Pricing review I2: category rules are a Game Top Up concept (AGENTS.md
  // family separation). A no-group legacy category belongs to Premium Apps,
  // the same `group ?? PREMIUM_APPS` rule as serviceForCategoryGroup. Clearing
  // stays allowed so a rule stored before this check can still be removed.
  if (hasType && (category.group ?? CategoryGroup.PREMIUM_APPS) !== CategoryGroup.GAME_TOPUP) {
    throw new PricingValidationError("Category markup rules apply only to Game Top Up categories; Premium Apps keep manual prices.");
  }
  const stored = storedCategoryRule(category);
  // An unreadable stored rule is described as such (describeRule(null)) and
  // never equals anything, so saving or clearing it always writes.
  const before: MarkupRule | null = stored === UNREADABLE_CATEGORY_RULE ? null : stored;
  const next: MarkupRule | null = hasType ? { type: rule.markupType, value: rule.markupValue! } : null;

  const unchanged = stored !== UNREADABLE_CATEGORY_RULE &&
    (next === null ? before === null : before !== null && rulesEqual(before, next));
  if (unchanged) return { changed: false };

  await db.category.update({
    where: { id: categoryId },
    data: { markupType: next?.type ?? null, markupValue: next ? next.value.toFixed() : null },
  });
  const name = `category "${category.name}"`;
  const details = next === null
    ? `Removed the markup for ${name} (it was ${describeRule(before)}); it now uses the default markup.`
    : stored === null
      ? `Set the markup for ${name} to ${describeRule(next)} (it used the default markup before).`
      : `Changed the markup for ${name} from ${describeRule(before)} to ${describeRule(next)}.`;
  await logAdminAction(db, {
    adminId,
    action: next === null ? "pricing_category_rule_clear" : "pricing_category_rule_set",
    targetType: "category",
    targetId: categoryId,
    details,
  });
  return { changed: true };
}

export function clearCategoryRule(db: Db, adminId: number | null, categoryId: number): Promise<{ changed: boolean }> {
  return setCategoryRule(db, adminId, categoryId, { markupType: null, markupValue: null });
}

/** One category's stored rule without throwing: null when it has none
 * (inherits the global default) or the category does not exist,
 * {@link UNREADABLE_CATEGORY_RULE} when it cannot be read. */
export async function readCategoryRule(db: Db, categoryId: number): Promise<{ rule: StoredCategoryRule; name: string | null }> {
  const row = await db.category.findUnique({
    where: { id: categoryId },
    select: { name: true, markupType: true, markupValue: true },
  });
  return row ? { rule: storedCategoryRule(row), name: row.name } : { rule: null, name: null };
}

/** One category's own rule; null when it has none (inherits the global
 * default) or the category does not exist. Throws PricingPolicyUnreadableError
 * for an unreadable rule. For single-row callers; a run over many rows loads
 * {@link getCategoryRuleMap} once instead. */
export async function getCategoryRule(db: Db, categoryId: number): Promise<MarkupRule | null> {
  const { rule, name } = await readCategoryRule(db, categoryId);
  if (rule === UNREADABLE_CATEGORY_RULE) throw new PricingPolicyUnreadableError("category", [name ?? String(categoryId)]);
  return rule;
}

/** Every category rule without throwing: the readable ones by category id
 * (a category missing from `rules` inherits the global default), and the
 * names of the categories whose stored rule cannot be read. */
export async function readCategoryRules(db: Db): Promise<{ rules: Map<number, MarkupRule>; unreadable: string[] }> {
  const rows = await db.category.findMany({
    where: { markupType: { not: null } },
    select: { id: true, name: true, markupType: true, markupValue: true },
    orderBy: { name: "asc" },
  });
  const rules = new Map<number, MarkupRule>();
  const unreadable: string[] = [];
  for (const row of rows) {
    const rule = storedCategoryRule(row);
    if (rule === UNREADABLE_CATEGORY_RULE) unreadable.push(row.name);
    else if (rule) rules.set(row.id, rule);
  }
  return { rules, unreadable };
}

/** categoryId → rule, for every category with a rule. A category missing from
 * the map inherits the global default. Throws PricingPolicyUnreadableError
 * when any stored category rule cannot be read (never a silent fallback to
 * the global rule). */
export async function getCategoryRuleMap(db: Db): Promise<Map<number, MarkupRule>> {
  const { rules, unreadable } = await readCategoryRules(db);
  if (unreadable.length > 0) throw new PricingPolicyUnreadableError("category", unreadable);
  return rules;
}

export interface PricingCategoryRow {
  id: number;
  name: string;
  group: string | null;
  markupType: string | null;
  markupValue: Prisma.Decimal | null;
  /** Unarchived Digiflazz-routed SKUs (with a supplier SKU) in the category. */
  skuCount: number;
}

/** Every category with its stored rule and Digiflazz SKU count, for the
 * Pricing & Margins page. A fixed number of queries whatever the catalog
 * size (pricing review Minor 6: was one count per category). */
export async function listPricingCategories(db: Db): Promise<PricingCategoryRow[]> {
  const [categories, perProduct] = await Promise.all([
    db.category.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, group: true, markupType: true, markupValue: true } }),
    db.denomination.groupBy({
      by: ["productId"],
      where: { AND: [DIGIFLAZZ_SUPPLIER_SCOPE, { supplierSku: { not: null }, isArchived: false }] },
      _count: { _all: true },
    }),
  ]);
  const products = perProduct.length === 0 ? [] : await db.product.findMany({
    where: { id: { in: perProduct.map((r) => r.productId) } },
    select: { id: true, categoryId: true },
  });
  const categoryOf = new Map(products.map((p) => [p.id, p.categoryId]));
  const counts = new Map<number, number>();
  for (const row of perProduct) {
    const categoryId = categoryOf.get(row.productId);
    if (categoryId !== undefined) counts.set(categoryId, (counts.get(categoryId) ?? 0) + row._count._all);
  }
  return categories.map((c) => ({ ...c, skuCount: counts.get(c.id) ?? 0 }));
}

// ---- Reprice ("Apply now") ----

export type RepriceScope = "all" | number;

export interface RepriceSampleRow {
  denominationId: number;
  name: string;
  productName: string;
  oldPrice: Decimal;
  newPrice: Decimal;
  cost: Decimal;
}

/** Why a new price was refused by the admin form's price checks
 * (`denominationPriceError`): below the Rp1 sale minimum, or below the SKU's
 * own reseller price. */
export type RepriceBlockReason = "price_below_minimum" | "reseller_above_price" | "invalid_prices";

export interface RepriceBlockedRow extends RepriceSampleRow {
  reason: RepriceBlockReason;
  resellerPrice: Decimal | null;
}

export interface RepriceImpact {
  eligibleCount: number;
  /** Rows Apply now would actually write (blocked rows excluded). */
  changedCount: number;
  /** Up to {@link REPRICE_SAMPLE_SIZE} changed SKUs, lowest id first. */
  sample: RepriceSampleRow[];
  /** Rows whose new price fails a price check; Apply now leaves them alone. */
  blockedCount: number;
  /** Up to {@link REPRICE_SAMPLE_SIZE} blocked SKUs, lowest id first. */
  blocked: RepriceBlockedRow[];
  /** Identifies the pricing policy this preview was priced from; pass it back
   * to {@link applyReprice} so a policy saved in between is refused. */
  policyFingerprint: string;
}

export interface RepriceResult {
  eligibleCount: number;
  updatedCount: number;
  unchangedCount: number;
  /** Eligible when listed, but no longer eligible once locked (made manual,
   * archived, cost cleared or moved out of scope meanwhile). */
  skippedCount: number;
  /** Left at their current price because the new price failed a price check
   * (below Rp1, or below the SKU's reseller price). */
  blockedCount: number;
}

/** Apply now committed every batch, but its final audit row failed. */
export class RepriceAuditFailedError extends Error {
  constructor(updatedCount: number, options?: { cause?: unknown }) {
    super(
      `The new prices were applied to ${updatedCount} item(s), but the change could not be written to the audit log. The prices stay as applied; tell the developer so the audit entry can be recorded.`,
      options,
    );
    this.name = "RepriceAuditFailedError";
  }
}

/** The policy changed between the admin's preview and their Apply now. */
export class RepricePolicyChangedError extends Error {
  constructor() {
    super("The pricing rules changed after you opened the preview. Review the new impact and apply again.");
    this.name = "RepricePolicyChangedError";
  }
}

const REPRICE_SAMPLE_SIZE = 10;
const REPRICE_BATCH_SIZE = 100;

/** Exactly the rows the resync reprices (Digiflazz scope with a supplier SKU,
 * not archived), narrowed to auto-priced rows with a positive known cost (a
 * cost of 0 would price the SKU from nothing — pricing review I4). A Premium
 * Apps manual SKU has no supplierSku, so it is never in here. */
function eligibleWhere(scope: RepriceScope): Prisma.DenominationWhereInput {
  return {
    AND: [
      DIGIFLAZZ_SUPPLIER_SCOPE,
      { supplierSku: { not: null }, isArchived: false, priceOverridden: false, costPrice: { not: null, gt: 0 } },
      ...(scope === "all" ? [] : [{ product: { categoryId: scope } }]),
    ],
  };
}

/** The admin form's price checks (`denominationPriceError`) on a new price;
 * null when it may be written. */
function repriceBlockReason(newPrice: Decimal, costPrice: Decimal, resellerPrice: Decimal | null): RepriceBlockReason | null {
  if (denominationPriceError({ price: newPrice, costPrice, resellerPrice }) === null) return null;
  if (!newPrice.isFinite() || newPrice.lessThan(MIN_SALE_PRICE)) return "price_below_minimum";
  if (resellerPrice !== null && resellerPrice.greaterThan(newPrice)) return "reseller_above_price";
  return "invalid_prices";
}

function toDecimalOrNull(v: Prisma.Decimal | null): Decimal | null {
  return v === null ? null : new Decimal(v.toString());
}

interface LoadedPolicy {
  globalRule: MarkupRule;
  rounding: RoundingPolicy;
  lowMarginWarnPct: Decimal | null;
  categoryRules: Map<number, MarkupRule>;
}

async function loadUsablePolicy(db: Db): Promise<LoadedPolicy> {
  const policy = await getPricingPolicy(db);
  if (!policy.globalRuleReadable || policy.globalRule === null) throw new PricingPolicyUnreadableError("markup");
  if (!policy.roundingReadable) throw new PricingPolicyUnreadableError("rounding");
  return {
    globalRule: policy.globalRule,
    rounding: policy.rounding,
    lowMarginWarnPct: policy.lowMarginWarnPct,
    categoryRules: await getCategoryRuleMap(db),
  };
}

function newPriceFor(
  policy: LoadedPolicy,
  row: { price: Prisma.Decimal; costPrice: Prisma.Decimal | null; categoryId: number },
): Decimal {
  const resolved = resolveDenominationPrice({
    cost: new Decimal(row.costPrice!.toString()),
    priceOverridden: false,
    currentPrice: new Decimal(row.price.toString()),
    categoryRule: policy.categoryRules.get(row.categoryId) ?? null,
    globalRule: policy.globalRule,
    rounding: policy.rounding,
    lowMarginWarnPct: policy.lowMarginWarnPct,
  });
  // Eligible rows always have a cost, so there is always a calculated price.
  return resolved.calculatedPrice!;
}

/** A stable digest of everything that decides an Apply-now price: the global
 * rule, rounding and every category rule. The low-margin warning is left out
 * on purpose (it never changes a price). */
function policyFingerprint(policy: LoadedPolicy): string {
  const ruleKey = (r: MarkupRule) => `${r.type ?? ""}:${r.type === null ? "0" : r.value.toFixed()}`;
  const categories = [...policy.categoryRules.entries()].sort(([a], [b]) => a - b).map(([id, r]) => `${id}=${ruleKey(r)}`);
  const text = [ruleKey(policy.globalRule), policy.rounding, ...categories].join("|");
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** What "Apply now" would change, priced from the real stored rows with the
 * same price checks Apply now runs, so the preview matches the apply. Throws
 * PricingPolicyUnreadableError instead of pricing from an unreadable policy. */
export async function computeRepriceImpact(db: Db, scope: RepriceScope): Promise<RepriceImpact> {
  const policy = await loadUsablePolicy(db);
  const rows = await db.denomination.findMany({
    where: eligibleWhere(scope),
    select: { id: true, name: true, price: true, costPrice: true, resellerPrice: true, product: { select: { name: true, categoryId: true } } },
    orderBy: { id: "asc" },
  });
  let changedCount = 0;
  let blockedCount = 0;
  const sample: RepriceSampleRow[] = [];
  const blocked: RepriceBlockedRow[] = [];
  for (const row of rows) {
    const newPrice = newPriceFor(policy, { ...row, categoryId: row.product.categoryId });
    if (moneyEq(newPrice, row.price)) continue;
    const cost = new Decimal(row.costPrice!.toString());
    const resellerPrice = toDecimalOrNull(row.resellerPrice);
    const base = {
      denominationId: row.id,
      name: row.name,
      productName: row.product.name,
      oldPrice: new Decimal(row.price.toString()),
      newPrice,
      cost,
    };
    const reason = repriceBlockReason(newPrice, cost, resellerPrice);
    if (reason !== null) {
      blockedCount++;
      if (blocked.length < REPRICE_SAMPLE_SIZE) blocked.push({ ...base, reason, resellerPrice });
      continue;
    }
    changedCount++;
    if (sample.length < REPRICE_SAMPLE_SIZE) sample.push(base);
  }
  return { eligibleCount: rows.length, changedCount, sample, blockedCount, blocked, policyFingerprint: policyFingerprint(policy) };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Reprice every eligible SKU in `scope` from the current policy, now. Holds
 * the Digiflazz catalog-sync lease for the whole run so it never races the
 * resync (RepriceBusyError when the lease is taken). Works in short batched
 * transactions: each locks its rows, re-checks eligibility on the locked row,
 * and writes only prices that actually change. One summary audit row.
 */
export async function applyReprice(
  db: PrismaClient,
  adminId: number | null,
  scope: RepriceScope,
  now: Date = new Date(),
  /** Test seams only: a smaller batch size, and a hook run before each
   * batch's transaction (to change rows or the lease mid-run, or to fail). */
  opts: {
    batchSize?: number;
    beforeBatch?: (batchIndex: number) => Promise<void>;
    /** The `policyFingerprint` of the preview the admin confirmed; when given
     * and the stored policy no longer matches it, nothing is written
     * (RepricePolicyChangedError). */
    expectedPolicyFingerprint?: string;
  } = {},
): Promise<RepriceResult> {
  // Refuse an unreadable policy before taking the lease.
  const policy = await loadUsablePolicy(db);
  if (opts.expectedPolicyFingerprint !== undefined && opts.expectedPolicyFingerprint !== policyFingerprint(policy)) {
    throw new RepricePolicyChangedError();
  }
  const batchSize = opts.batchSize ?? REPRICE_BATCH_SIZE;
  const token = await claimDigiflazzCatalogSyncLease(db, now);
  if (!token) throw new RepriceBusyError();
  try {
    let where = "";
    if (scope !== "all") {
      const category = await db.category.findUnique({ where: { id: scope }, select: { name: true } });
      if (category) where = ` in category "${category.name}"`;
    }
    const auditTarget = { targetType: scope === "all" ? "setting" : "category", targetId: scope === "all" ? null : scope };
    const ids = (
      await db.denomination.findMany({ where: eligibleWhere(scope), select: { id: true }, orderBy: { id: "asc" } })
    ).map((r) => r.id);
    const result: RepriceResult = { eligibleCount: ids.length, updatedCount: 0, unchangedCount: 0, skippedCount: 0, blockedCount: 0 };

    try {
      for (let i = 0, batchIndex = 0; i < ids.length; i += batchSize, batchIndex++) {
        const batch = ids.slice(i, i + batchSize);
        if (opts.beforeBatch) await opts.beforeBatch(batchIndex);
        const counts = await db.$transaction(async (tx) => {
          // Renew the lease and prove it is still ours, so a run longer than
          // the lease never overlaps a catalog sync that took it over.
          const renewed = await tx.setting.updateMany({
            where: { key: DIGIFLAZZ_CATALOG_SYNC_LEASE_KEY, value: token },
            data: { updatedAt: new Date() },
          });
          if (renewed.count !== 1) throw new RepriceLeaseLostError();
          const c = { updated: 0, unchanged: 0, skipped: 0, blocked: 0 };
          await tx.$queryRaw`SELECT id FROM denominations WHERE id IN (${Prisma.join(batch)}) ORDER BY id FOR UPDATE`;
          const locked = await tx.denomination.findMany({
            where: { AND: [{ id: { in: batch } }, eligibleWhere(scope)] },
            select: { id: true, price: true, costPrice: true, resellerPrice: true, product: { select: { categoryId: true } } },
          });
          c.skipped = batch.length - locked.length;
          for (const row of locked) {
            const newPrice = newPriceFor(policy, { ...row, categoryId: row.product.categoryId });
            if (moneyEq(newPrice, row.price)) {
              c.unchanged++;
              continue;
            }
            // Pricing review I4: the admin form's checks, on the locked row.
            if (repriceBlockReason(newPrice, new Decimal(row.costPrice!.toString()), toDecimalOrNull(row.resellerPrice)) !== null) {
              c.blocked++;
              continue;
            }
            await updateDenomination(tx, row.id, { price: newPrice });
            c.updated++;
          }
          return c;
        });
        result.updatedCount += counts.updated;
        result.unchangedCount += counts.unchanged;
        result.skippedCount += counts.skipped;
        result.blockedCount += counts.blocked;
      }
    } catch (err) {
      // Earlier batches are committed live prices: they must not go unaudited.
      if (result.updatedCount > 0) {
        try {
          await logAdminAction(db, {
            adminId,
            action: "pricing_reprice",
            ...auditTarget,
            details: `Repriced ${plural(result.updatedCount, "Digiflazz item", "Digiflazz items")}${where} before the run stopped on an error; the rest were not changed.`,
          });
        } catch (auditErr) {
          logger.error(
            { err: auditErr, updatedCount: result.updatedCount },
            "A pricing reprice failed part-way and its partial audit row could not be written either, so some Digiflazz prices changed without an audit entry.",
          );
        }
      }
      throw err;
    }

    const skippedNote = result.skippedCount > 0
      ? ` ${plural(result.skippedCount, "item was", "items were")} skipped because ${result.skippedCount === 1 ? "it" : "they"} changed while repricing.`
      : "";
    const blockedNote = result.blockedCount > 0
      ? ` ${plural(result.blockedCount, "item was", "items were")} left at ${result.blockedCount === 1 ? "its" : "their"} current price because the new price failed a price check (below Rp1, or below ${result.blockedCount === 1 ? "its" : "their"} reseller price).`
      : "";
    const details = result.eligibleCount === 0
      ? `Found no auto-priced Digiflazz items${where} to reprice from the current pricing rules.`
      : result.updatedCount === 0
      ? `Checked ${plural(result.eligibleCount, "Digiflazz item", "Digiflazz items")}${where} against the current pricing rules; ${plural(result.unchangedCount, "was", "were")} already up to date.${skippedNote}${blockedNote}`
      : `Repriced ${plural(result.updatedCount, "Digiflazz item", "Digiflazz items")}${where} from the current pricing rules; ${plural(result.unchangedCount, "was", "were")} already up to date.${skippedNote}${blockedNote}`;
    try {
      await logAdminAction(db, {
        adminId,
        action: "pricing_reprice",
        ...auditTarget,
        details,
      });
    } catch (auditErr) {
      // Every batch is already committed: the prices are live. Say so loudly
      // rather than let a bare 500 hide that they changed without an audit row.
      logger.error(
        { err: auditErr, updatedCount: result.updatedCount, blockedCount: result.blockedCount, scope },
        `A pricing reprice finished and changed ${result.updatedCount} Digiflazz prices, but its audit row could not be written, so those price changes have no audit entry; the prices stay as repriced.`,
      );
      throw new RepriceAuditFailedError(result.updatedCount, { cause: auditErr });
    }
    return result;
  } finally {
    try {
      await releaseDigiflazzCatalogSyncLease(db, token);
    } catch (err) {
      logger.error(
        { err },
        "Could not release the Digiflazz catalog sync lease after a pricing reprice; catalog syncs and further reprices will be refused until the lease expires on its own, at most ten minutes from when it was taken.",
      );
    }
  }
}
