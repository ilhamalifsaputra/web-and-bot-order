/**
 * Declarative short forms for canonical quantity units, used by compact
 * presenters (Telegram buttons). Only exact unit names or listed aliases match;
 * a unit is never recognised by a substring of a package name, so
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

export const UNIT_DISPLAY_REGISTRY: readonly UnitDisplayEntry[] = [
  { unit: "Diamonds", aliases: ["Diamond"], icon: "💎" },
  { unit: "Coins", aliases: ["Coin"], icon: "🪙" },
  { unit: "Delta Coins", aliases: ["Delta Coin"], icon: "🪙" },
  { unit: "World Lock", aliases: ["World Locks"], shortAlias: "WL" },
];

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
