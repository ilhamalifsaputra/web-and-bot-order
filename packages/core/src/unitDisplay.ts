import { ABBREVIATIONS, UNITS } from "./unitDictionary";

/**
 * Lookups over the unit dictionary (`unitDictionary.ts`, the single source of truth) for compact
 * presenters (Telegram buttons). Only exact unit names or listed aliases match, as whole
 * case-insensitive tokens; a unit is never recognised by a substring of a package name, so
 * "Weekly Diamond Pass" is not a diamond amount.
 */
export interface UnitDisplayEntry {
  unit: string;
  aliases: string[];
  /** Emoji shown instead of the unit. */
  icon?: string;
  /** Text short form used when there is no icon. */
  shortAlias?: string;
}

export const UNIT_DISPLAY_REGISTRY: readonly UnitDisplayEntry[] = UNITS.map((entry) => ({
  unit: entry.canonical, aliases: entry.aliases, ...(entry.icon ? { icon: entry.icon } : {}), ...(entry.short ? { shortAlias: entry.short } : {}),
}));

/** Per-category replacement of a canonical unit's short form: { [category]: { [unit or alias]: short } }. */
export type UnitDisplayOverrides = Record<string, Record<string, string>>;
export interface UnitDisplayContext {
  category?: string;
  overrides?: UnitDisplayOverrides;
}

const key = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();

function findEntry(unit: string): UnitDisplayEntry | null {
  const wanted = key(unit);
  return UNIT_DISPLAY_REGISTRY.find((entry) => key(entry.unit) === wanted || entry.aliases.some((alias) => key(alias) === wanted)) ?? null;
}

function overrideFor(unit: string, entry: UnitDisplayEntry | null, ctx?: UnitDisplayContext): string | null {
  const table = ctx?.category ? ctx.overrides?.[ctx.category] : undefined;
  if (!table) return null;
  const names = [unit, ...(entry ? [entry.unit, ...entry.aliases] : [])].map(key);
  for (const [name, short] of Object.entries(table)) if (names.includes(key(name))) return short;
  return null;
}

/** Short form of a unit (icon or alias), or the original unit unchanged when it is not registered. */
export function displayUnit(unit: string, ctx?: UnitDisplayContext): string {
  const entry = findEntry(unit);
  return overrideFor(unit, entry, ctx) ?? entry?.icon ?? entry?.shortAlias ?? unit;
}

/** The registered icon for a unit, or null (no icon, unmapped, or a package-like name). */
export function unitIcon(unit: string): string | null {
  return findEntry(unit)?.icon ?? null;
}

/**
 * Groups of different canonical units in `units` that render to the same short
 * form, so a presenter can add a distinguishing alias. Aliases of one canonical
 * unit (World Lock / World Locks) do not collide.
 */
export function sharedIconUnits(units: readonly string[], ctx?: UnitDisplayContext): { short: string; units: string[] }[] {
  const byShort = new Map<string, Set<string>>();
  for (const unit of units) {
    const entry = findEntry(unit);
    const short = displayUnit(unit, ctx);
    if (short === unit && !entry) continue;
    const canonical = entry?.unit ?? unit;
    const set = byShort.get(short) ?? new Set<string>();
    set.add(canonical);
    byShort.set(short, set);
  }
  return [...byShort].filter(([, set]) => set.size > 1).map(([short, set]) => ({ short, units: [...set] }));
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phraseRegExp = (names: string[], flags = "giu") => new RegExp(
  String.raw`(?<![\p{L}\p{N}])(${names.map((name) => escapeRegExp(name.trim()).replace(/\s+/g, String.raw`\s+`)).join("|")})(?![\p{L}\p{N}])`, flags,
);
const SHORT_PHRASES = UNIT_DISPLAY_REGISTRY.filter((entry) => entry.icon && entry.shortAlias);
const ABBREVIATION_WORDS = phraseRegExp(ABBREVIATIONS.map((entry) => entry.word));

/**
 * Replaces the FIRST whole-token occurrence of `unit` inside `text` by the unit's icon or short form
 * ("1000 Diamonds + 100 Bonds" -> "1000 💎 + 100 Bonds"). Exactly one phrase and exactly the named unit: a presenter
 * passes the SKU's own structured unit, so no other word of a package or bundle name is ever turned into an icon.
 * An unregistered unit, or a text without it, comes back unchanged.
 */
export function iconizeUnitOnce(text: string, unit: string, ctx?: UnitDisplayContext): string {
  const short = displayUnit(unit, ctx);
  if (!unit.trim() || short === unit) return text;
  return text.replace(phraseRegExp([unit], "iu"), short);
}

const UNIT_ICONS = [...new Set(UNIT_DISPLAY_REGISTRY.flatMap((entry) => entry.icon ? [entry.icon] : []))];
const ICON_ALTERNATIVES = UNIT_ICONS.join("|");
const ADJACENT_ICONS = new RegExp(String.raw`(?:${ICON_ALTERNATIVES})\s*(?:${ICON_ALTERNATIVES})`, "u");
/** True when the same dictionary icon occurs twice in `text`, or two dictionary icons sit side by side. */
export function hasRepeatedIcon(text: string): boolean {
  return UNIT_ICONS.some((icon) => text.split(icon).length > 2) || ADJACENT_ICONS.test(text);
}

const followCase = (source: string, short: string): string => {
  if (source.length > 1 && source === source.toUpperCase()) return short.toUpperCase();
  if (source[0] === source[0]!.toUpperCase() && source[0] !== source[0]!.toLowerCase()) return short[0]!.toUpperCase() + short.slice(1);
  return short.toLowerCase();
};
/**
 * Abbreviates, as whole tokens and keeping their case, the dictionary's long words ("Weekly Premium
 * Subscription" -> "Wkly Prem Sub") and the short forms of icon units ("Genesis Crystals" -> "Gen Crystals").
 * A last-resort label form; never applied to a label that already fits.
 */
export function abbreviateText(text: string): string {
  let out = text;
  for (const entry of SHORT_PHRASES) {
    out = out.replace(phraseRegExp([entry.unit, ...entry.aliases]), (phrase) => followCase(phrase, entry.shortAlias!));
  }
  return out.replace(ABBREVIATION_WORDS, (word) => followCase(word, ABBREVIATIONS.find((entry) => entry.word.toLowerCase() === word.toLowerCase())!.short));
}
