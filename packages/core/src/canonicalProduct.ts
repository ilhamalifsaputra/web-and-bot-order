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

const KNOWN_UNITS = "World Locks?|Delta Coins|Diamonds?|Bonds?|UC|VP|Gems?|Coins?|Tokens?";
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The closed unit list, plus the SKU's own admin-structured unit as a whole token (Game Top Up only, see `isGameTopUp`). */
function unitPattern(structuredUnit: string | null): string {
  return structuredUnit ? `${escapeRegExp(structuredUnit).replace(/\s+/g, "\\s+")}|${KNOWN_UNITS}` : KNOWN_UNITS;
}
/** Singular and plural spell one unit ("World Lock" / "World Locks"); short codes like UC and VP are left alone. */
const stem = (word: string) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
const sameWord = (a: string, b: string) => nameTokens(a).map(stem).join(" ") === nameTokens(b).map(stem).join(" ");
const groupedNumber = /^\d+(?:\.\d{3})*$/;
const wordTokens = (value: string) => [...value.matchAll(/\d+(?:\.\d{3})+|[\p{L}\p{N}]+/gu)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
/**
 * Removes from `name` what merely repeats the structured quantity and unit, whatever their order ("Primogems 160"
 * and "160 Primogems" are the same tokens): the quantity token (dot grouping normalised, never a fragment of a
 * numeric group) and the unit's words as a whole phrase. Everything else, including every differing number, stays;
 * null means the name was not recognised as repeating them and is left untouched.
 *  - "pair": only a unit phrase directly beside the quantity, each repeat of the pair ("160 Primogems Primogems 160").
 *  - "both": a pair, or else the unit and the quantity wherever they sit ("Primogems Pack 160").
 *  - "amount": a "both", or else the unit alone in a number-free name ("Diamond Lock"), or else the one quantity
 *    token alone ("Google Play 300.000"); the label prints the structured quantity and unit itself.
 */
function withoutStructuredQuantity(name: string, value: number, unit: string, mode: "pair" | "both" | "amount"): string | null {
  const unitWords = nameTokens(unit).map(stem);
  if (unitWords.length === 0) return null;
  const tokens = wordTokens(name);
  const lower = tokens.map((token) => stem(token.text.toLowerCase()));
  const unitStarts = tokens.flatMap((_, i) => i + unitWords.length <= tokens.length && unitWords.every((word, k) => lower[i + k] === word) ? [i] : []);
  const unitIndices = (start: number) => unitWords.map((_, k) => start + k);
  // A standalone quantity only: never the tail of an unsupported group ("1, 050", "1 050") or a zero-padded number.
  const standalone = (i: number) => !/\d\s*[.,]?\s*$/.test(name.slice(0, tokens[i]!.start));
  const isQuantity = (i: number) => i >= 0 && i < tokens.length && groupedNumber.test(tokens[i]!.text) && tokens[i]!.text.replace(/\./g, "") === String(value) && standalone(i);
  const drop = new Set<number>();
  for (const start of unitStarts) {
    const beside = [start - 1, start + unitWords.length].find((i) => !drop.has(i) && isQuantity(i));
    if (beside !== undefined) for (const i of [...unitIndices(start), beside]) drop.add(i);
  }
  if (drop.size === 0 && mode !== "pair") {
    const quantity = tokens.findIndex((_, i) => isQuantity(i));
    if (unitStarts.length > 0 && quantity >= 0) for (const i of [...unitIndices(unitStarts[0]!), quantity]) drop.add(i);
    else if (mode === "amount" && unitStarts.length > 0 && !tokens.some((token) => /\d/.test(token.text))) for (const i of unitIndices(unitStarts[0]!)) drop.add(i);
    else if (mode === "amount" && unitStarts.length === 0 && tokens.filter((_, i) => isQuantity(i)).length === 1) drop.add(quantity);
  }
  if (drop.size === 0) return null;
  let rest = "";
  let cursor = 0;
  for (const [i, token] of tokens.entries()) {
    if (!drop.has(i)) continue;
    rest += `${name.slice(cursor, token.start)} `;
    cursor = token.end;
  }
  return `${rest}${name.slice(cursor)}`.replace(/\s+/g, " ").trim();
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
  // Game Top Up: the SKU's admin-structured unit is also a recognised unit when parsing its own name.
  const units = unitPattern(isGameTopUp(input) && structured ? denom.qtyUnit!.trim() : null);
  const sharedBonus = name.match(new RegExp(String.raw`(?:^|\s)(\d+(?:\.\d{3})*)\s*\+\s*(\d+(?:\.\d{3})*)\s+(${units})(?=\s|$)`, "i"));
  const match = sharedBonus ?? name.match(new RegExp(String.raw`(?:^|\s)(\d+(?:\.\d{3})*)\s+(${units})(?=\s|$|\+)`, "i"));
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
  // Game Top Up: a name that already spells the structured quantity and unit, in any order, does not need them repeated.
  const namedResidual = structured && !(isGameTopUp(input) && withoutStructuredQuantity(name, denom.qtyValue!, denom.qtyUnit!.trim(), "both") !== null)
    ? [`${denom.qtyValue} ${denom.qtyUnit!.trim()}`] : [];
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
    if (structured && !agrees) {
      if (!isGameTopUp(input)) return { type: "amount", quantity: value, unit, residual: [name] };
      // "A + B <unit>" whose parts add up to the structured total: the structured data verifies the bonus.
      if (sharedBonus && !numericContinuation && sameWord(sharedBonus[3]!, unit)) {
        const base = Number(sharedBonus[1]!.replace(/\./g, ""));
        const extra = Number(sharedBonus[2]!.replace(/\./g, ""));
        if (Number.isSafeInteger(base) && Number.isSafeInteger(extra) && base > 0 && extra > 0 && base + extra === value) {
          const rest = [name.slice(0, sharedBonus.index!).trim(), name.slice(sharedBonus.index! + sharedBonus[0].length).trim()].filter(Boolean);
          return { type: "amount", quantity: base, unit, residual: rest, bonus: { quantity: extra, unit } };
        }
      }
      // Same tokens as the structured quantity and unit in any order: nothing left to show but what differs.
      const rest = withoutStructuredQuantity(name, value, unit, "amount");
      return { type: "amount", quantity: value, unit, residual: rest === null ? [name] : rest ? [rest] : [] };
    }
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
    const pieces = [before, after].filter(Boolean);
    // Game Top Up: words that only repeat the quantity and unit already shown are not residual.
    const residual = isGameTopUp(input) && structured ? pieces.map((piece) => withoutStructuredQuantity(piece, value, unit, "pair") ?? piece).filter(Boolean) : pieces;
    return { type: "amount", quantity: value, unit, residual, ...(bonus ? { bonus } : {}) };
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
