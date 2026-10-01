import { z } from "zod";
import { Decimal } from "./money";
import { convertIdrToDisplay } from "./formatters";

const text = z.string().min(1);
const quantity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const residual = z.array(text);
export const CanonicalMoneySchema = z.discriminatedUnion("currency", [
  z.object({ currency: z.literal("IDR"), amountMinor: z.string().regex(/^(0|[1-9]\d*)$/), scale: z.number().int().min(0).max(4) }),
  z.object({ currency: z.literal("USD"), amountMinor: z.string().regex(/^(0|[1-9]\d*)$/), scale: z.literal(2) }),
]);
export type CanonicalMoney = z.infer<typeof CanonicalMoneySchema>;
export const CanonicalVariantSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("amount"), quantity, unit: text, residual, bonus: z.object({ quantity, unit: text, label: text.optional() }).optional() }),
  ...(["subscription", "pass"] as const).map((type) => z.object({ type: z.literal(type), name: text, residual, duration: z.object({ value: quantity, unit: z.enum(["day", "week", "month", "year"]) }).optional() })),
  ...(["package", "bundle", "voucher", "unknown"] as const).map((type) => z.object({ type: z.literal(type), name: text, residual })),
]);
export type CanonicalVariant = z.infer<typeof CanonicalVariantSchema>;

/** The same rendering supplies every platform; residual is never silently discarded. */
function renderVariant(variant: CanonicalVariant): string {
  const primary = variant.type === "amount"
    ? `${variant.quantity} ${variant.unit}${variant.bonus ? ` + ${variant.bonus.quantity} ${variant.bonus.label ?? variant.bonus.unit}` : ""}`
    : variant.name;
  return [primary, ...variant.residual].join(" ");
}

export const CanonicalProductSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  supplierSku: text.nullable(),
  rawName: text,
  rawNameProvenance: z.enum(["supplier", "legacy_name"]),
  displayName: text,
  variant: CanonicalVariantSchema,
  qualifiers: z.array(text),
  product: z.object({ id: z.number().int().positive(), name: text, gameVariant: text.nullable(), gameRegion: text.nullable() }),
  category: z.object({ id: z.number().int().positive(), name: text, group: text.nullable() }),
  priceIDR: CanonicalMoneySchema.refine((value) => value.currency === "IDR"),
  displayPrice: CanonicalMoneySchema,
  formattedPrice: text,
  currencyFallback: z.boolean(),
  conversion: z.object({ basis: z.literal("USDT"), direction: z.literal("IDR_PER_USDT"), rate: text.refine((value) => {
    try { return new Decimal(value).isFinite() && new Decimal(value).gt(0); } catch { return false; }
  }), rounding: z.literal("CEIL_2DP"), source: z.enum(["settings:usd_idr_rate", "config:USDT_IDR_RATE", "caller"]), asOf: z.string().datetime().nullable() }).nullable(),
  availability: z.object({ status: z.enum(["available", "inactive", "out_of_stock"]), purchasable: z.boolean() }),
  createdAt: z.string().datetime().nullable(),
  generatedAt: z.string().datetime(),
}).superRefine((value, ctx) => {
  if (value.availability.purchasable !== (value.availability.status === "available")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["availability"], message: "Status and purchasable must agree" });
  if (value.displayName !== renderVariant(value.variant)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["displayName"], message: "Name must derive from the variant" });
  if ((value.displayPrice.currency === "USD") !== (value.conversion !== null)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["conversion"], message: "USD display must identify its conversion" });
});
export type CanonicalProduct = z.infer<typeof CanonicalProductSchema>;

/** Scalar-only adapter input: callers pass their effective price, never ORM or pricing objects. */
export interface CanonicalProductInput {
  denomination: {
    id: number; name: string; durationLabel: string; supplierRawName?: string | null;
    supplierSku?: string | null; autoDeliverySource?: string | null;
    qtyValue?: number | null; qtyUnit?: string | null; isActive: boolean; createdAt?: string | null;
  };
  product: { id: number; name: string; digiflazzBrand?: string | null; gameVariant?: string | null; gameRegion?: string | null; isActive: boolean; isArchived?: boolean };
  category: { id: number; name: string; group?: string | null; isActive: boolean };
  stockAvailable?: boolean;
}
export interface CanonicalProductContext {
  effectivePriceIDR: string;
  preferredCurrency: "IDR" | "USD";
  /** Existing setting is IDR per USDT, despite the USD display label. */
  rate?: string | null;
  rateSource?: "settings:usd_idr_rate" | "config:USDT_IDR_RATE" | "caller";
  rateAsOf?: string | null;
  locale?: string;
  generatedAt?: string;
}

// Full-name prefixes verified in detection/__fixtures__/catalogSnapshot.json.
// No ML/AB aliases: that snapshot does not establish them as supplier prefixes.
const VERIFIED_GAME_PREFIXES = ["Mobile Legends", "Arena Breakout", "Growtopia", "Free Fire", "PUBG Mobile", "Valorant", "Delta Force"];
/** The remainder after a whole-token, case-insensitive leading `candidate`, or null when it is not a prefix or the remainder would read badly. */
function remainderAfter(name: string, candidate: string): string | null {
  const own = candidate.trim();
  if (!own || !name.toLowerCase().startsWith(`${own.toLowerCase()} `)) return null;
  const rest = name.slice(own.length).trim();
  // "- Family 3 Bulan", "(Duo) 1 Bulan", "+ Netflix" and a bare "400" lose their meaning without the product name.
  if (!rest || !/^[\p{L}\p{N}]/u.test(rest) || /^[\d.,]+$/.test(rest)) return null;
  return rest;
}
const withoutTrailingParens = (value: string) => value.replace(/\s*\([^()]*\)\s*$/, "");
/** Only Game Top Up opts into the newer catalog semantics; Premium Apps and any other (or null) group keep the original behavior. */
const isGameTopUp = (input: CanonicalProductInput) => input.category.group === "GAME_TOPUP";
function cleanName(name: string, product: CanonicalProductInput["product"], isGame: boolean): string {
  const identities = [product.name, product.digiflazzBrand ?? ""];
  const prefix = VERIFIED_GAME_PREFIXES.find((candidate) => identities.some((identity) => identity.toLowerCase() === candidate.toLowerCase() || identity.toLowerCase().startsWith(`${candidate.toLowerCase()} `)));
  if (!isGame) {
    if (prefix && name.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) return name.slice(prefix.length).trim() || name.trim();
    return name.trim();
  }
  if (prefix) {
    const rest = remainderAfter(name, prefix);
    if (rest) return rest;
  }
  // The list intro/header already names the product, so its own name (or its brand), with or without a trailing
  // "(Region)" suffix, is a safe whole-token prefix to drop (not a guessed alias). Longest candidate first.
  const candidates = identities.flatMap((identity) => [identity.trim(), withoutTrailingParens(identity.trim())]).filter(Boolean).sort((x, y) => y.length - x.length);
  for (const candidate of candidates) {
    const rest = remainderAfter(name, candidate);
    if (rest) return rest;
  }
  return name.trim();
}

function parseVariant(name: string, input: CanonicalProductInput): CanonicalVariant {
  const { denomination: denom } = input;
  const durationMatch = name.match(/(?:^|\s)(\d+)\s+(days?|weeks?|months?|years?)\b/i);
  const durationValue = durationMatch ? Number(durationMatch[1]) : null;
  const duration = durationMatch && durationValue && Number.isSafeInteger(durationValue)
    ? { value: durationValue, unit: durationMatch[2]!.toLowerCase().replace(/s$/, "") as "day" | "week" | "month" | "year" }
    : undefined;
  const structured = denom.qtyValue != null && denom.qtyUnit?.trim();
  // Only known, complete semantic units; punctuation and residual stay visible.
  const sharedBonus = name.match(/(?:^|\s)(\d+(?:\.\d{3})*)\s*\+\s*(\d+(?:\.\d{3})*)\s+(World Locks?|Delta Coins|Diamonds?|Bonds?|UC|VP|Gems?|Coins?|Tokens?)(?=\s|$)/i);
  const match = sharedBonus ?? name.match(/(?:^|\s)(\d+(?:\.\d{3})*)\s+(World Locks?|Delta Coins|Diamonds?|Bonds?|UC|VP|Gems?|Coins?|Tokens?)(?=\s|$|\+)/i);
  const parsedUnit = sharedBonus?.[3] ?? match?.[2];
  const grouped = (match?.[1]?.includes(".") || sharedBonus?.[2]?.includes(".")) ?? false;
  // A whitespace match may be only the tail of an unsupported numeric group
  // ("1, 050" or "1 050"). Never reinterpret that tail as a smaller amount.
  // Require a standalone preceding numeric token, so named qualifiers such
  // as "Infinite" or "Edition2" can still precede a simple quantity.
  const numericContinuation = !!match && /(?:^|\s)\d+(?:[.,]\d+|\s+\d+)*(?:\s*[.,])?\s*(?:\+\s*)?$/.test(name.slice(0, match.index));
  const parsed = match && !numericContinuation && (!grouped || denom.autoDeliverySource === "digiflazz") ? Number(match[1]!.replace(/\./g, "")) : null;
  const safeParsed = parsed != null && parsed > 0 && Number.isSafeInteger(parsed);
  // Subscription/package meaning wins over a coincidental number in a name.
  const namedResidual = structured ? [`${denom.qtyValue} ${denom.qtyUnit!.trim()}`] : [];
  if (/\bsubscription\b/i.test(name)) return { type: "subscription", name, residual: namedResidual, ...(duration ? { duration } : {}) };
  if (/\bpass\b/i.test(name)) return { type: "pass", name, residual: namedResidual, ...(duration ? { duration } : {}) };
  if (/\bbundle\b/i.test(name)) return { type: "bundle", name, residual: namedResidual };
  if (/\bvoucher\b/i.test(name)) return { type: "voucher", name, residual: namedResidual };
  const growtopiaPackage = /^(Chest O Gems|Gem Fountain|Its Rainin Gems|Gem Bounty|Gem Abundance)$/i.test(name);
  if (growtopiaPackage || /\bpackage\b/i.test(name)) return { type: "package", name, residual: namedResidual };
  if (structured || safeParsed) {
    const value = structured ? denom.qtyValue! : parsed!;
    const unit = structured ? denom.qtyUnit!.trim() : parsedUnit!;
    const agrees = safeParsed && value === parsed && unit.toLowerCase() === parsedUnit!.toLowerCase();
    // A unit outside the closed regex still agrees when the whole cleaned name is exactly the structured quantity and unit.
    const ungroup = (value: string) => value.replace(/\d{1,3}(?:\.\d{3})+/g, (group) => group.replace(/\./g, ""));
    const nameIsStructured = !!structured && nameTokens(ungroup(name)).join(" ") === nameTokens(`${denom.qtyValue} ${unit}`).join(" ");
    if (structured && !agrees) return { type: "amount", quantity: value, unit, residual: isGameTopUp(input) && nameIsStructured ? [] : [name] };
    const before = name.slice(0, match!.index!).trim();
    let after = name.slice(match!.index! + match![0].length).trim();
    const bonusMatch = after.match(/^\+\s*(\d+)\s+(Bonus|Diamonds?|Bonds?|UC|World Locks?)(?=\s|$)/i);
    let bonus: Extract<CanonicalVariant, { type: "amount" }>["bonus"];
    if (sharedBonus) {
      const bonusQuantity = Number(sharedBonus[2]!.replace(/\./g, ""));
      if (!Number.isSafeInteger(bonusQuantity) || bonusQuantity <= 0) return structured
        ? { type: "amount", quantity: value, unit, residual: [name] }
        : { type: "unknown", name, residual: [] };
      bonus = { quantity: bonusQuantity, unit };
    }
    if (!bonus && bonusMatch && Number(bonusMatch[1]) > 0 && Number.isSafeInteger(Number(bonusMatch[1]))) {
      bonus = { quantity: Number(bonusMatch[1]), unit: /^bonus$/i.test(bonusMatch[2]!) ? unit : bonusMatch[2]!, label: bonusMatch[2]! };
      after = after.slice(bonusMatch[0].length).trim();
    }
    return { type: "amount", quantity: value, unit, residual: [before, after].filter(Boolean), ...(bonus ? { bonus } : {}) };
  }
  return { type: "unknown", name, residual: [] };
}

function exactMoney(value: Decimal, currency: "IDR" | "USD"): CanonicalMoney {
  const scale = currency === "USD" ? 2 : value.decimalPlaces();
  if (!value.isFinite() || value.isNegative() || scale > 4) throw new Error("Invalid exact catalog price");
  return CanonicalMoneySchema.parse({ currency, amountMinor: value.toFixed(scale).replace(".", "").replace(/^0+(?=\d)/, ""), scale });
}

/** Exact, Decimal-based localized display; fractions of a rupiah are never rounded away. */
function formatExactMoney(value: CanonicalMoney, locale: string): string {
  const id = locale.toLowerCase().startsWith("id");
  const decimal = id ? "," : ".";
  const grouping = id ? "." : ",";
  const padded = value.amountMinor.padStart(value.scale + 1, "0");
  const whole = value.scale === 0 ? padded : padded.slice(0, -value.scale);
  const fraction = value.scale === 0 ? "" : `${decimal}${padded.slice(-value.scale)}`;
  return `${value.currency === "IDR" ? "Rp" : "$"}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, grouping)}${fraction}`;
}

/** Lowercased whole tokens; brackets, dashes and repeated whitespace are separators. */
function nameTokens(value: string): string[] {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The "- X" and "(X)" segments of a name: the only places a region/variant is spelled out as a qualifier rather than as part of a package name. */
function qualifierSegments(name: string): string[] {
  const bracketed = [...name.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]!);
  const dashed = name.split(/\s*-\s*/).slice(1).map((part) => part.replace(/\(.*$/, ""));
  return [...bracketed, ...dashed];
}

/** True when a "- X" or "(X)" segment of `name` is exactly `qualifier`, whole tokens, any case. The word elsewhere in the name ("Indonesia Merdeka Package") does not count. */
function nameContainsQualifier(name: string, qualifier: string): boolean {
  const wanted = nameTokens(qualifier).join(" ");
  return wanted !== "" && qualifierSegments(name).some((segment) => nameTokens(segment).join(" ") === wanted);
}

export function canonicalProduct(input: CanonicalProductInput, context: CanonicalProductContext): CanonicalProduct {
  const denom = input.denomination;
  const rawName = denom.supplierRawName ?? denom.name;
  const isGame = isGameTopUp(input);
  const cleaned = cleanName(rawName, input.product, isGame);
  const variant = parseVariant(cleaned, input);
  for (const source of [denom.name, denom.durationLabel]) {
    const extra = cleanName(source, input.product, isGame);
    // A substring inside a word is not redundant editable metadata.
    const alreadyPresent = ` ${cleaned} `.includes(` ${extra} `);
    if (extra && !alreadyPresent && !variant.residual.includes(extra)) variant.residual.push(extra);
  }
  const price = new Decimal(context.effectivePriceIDR);
  const priceIDR = exactMoney(price, "IDR");
  const converted = convertIdrToDisplay(price, context.preferredCurrency, context.rate);
  const displayPrice = converted.ok ? exactMoney(converted.amount, converted.currency) : priceIDR;
  const conversion = displayPrice.currency === "USD" ? { basis: "USDT" as const, direction: "IDR_PER_USDT" as const, rate: new Decimal(context.rate!).toString(), rounding: "CEIL_2DP" as const, source: context.rateSource ?? "caller", asOf: context.rateAsOf ?? null } : null;
  const inactive = !denom.isActive || !input.product.isActive || input.product.isArchived || !input.category.isActive;
  const status = inactive ? "inactive" : input.stockAvailable === false ? "out_of_stock" : "available";
  const displayName = renderVariant(variant);
  // A qualifier already spelled out as a "- Garena" / "(Global)" segment of this product's own name is redundant; different ones stay.
  const qualifiers = [input.product.gameRegion, input.product.gameVariant]
    .filter((value): value is string => !!value?.trim())
    .filter((value) => !isGame || !nameContainsQualifier(displayName, value));
  return CanonicalProductSchema.parse({
    id: denom.id, supplierSku: denom.supplierSku ?? null, rawName,
    rawNameProvenance: denom.supplierRawName != null ? "supplier" : "legacy_name",
    variant, displayName, qualifiers,
    product: { id: input.product.id, name: input.product.name, gameVariant: input.product.gameVariant || null, gameRegion: input.product.gameRegion || null },
    category: { id: input.category.id, name: input.category.name, group: input.category.group || null },
    priceIDR, displayPrice, formattedPrice: formatExactMoney(displayPrice, context.locale ?? "id"),
    currencyFallback: !converted.ok, conversion, availability: { status, purchasable: status === "available" },
    createdAt: denom.createdAt ?? null, generatedAt: context.generatedAt ?? new Date().toISOString(),
  });
}
