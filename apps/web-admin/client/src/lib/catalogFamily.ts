/**
 * The product families the admin separates (AGENTS.md "Premium Apps and Game
 * Top Up stay separate"), keyed by the category's `group`.
 *
 * Everything that varies per family — the catalog tabs, the Stock page's
 * product-type filter, the category options that follow them — is derived from
 * the single `FAMILY_REGISTRY` below. Adding a product type means adding one
 * entry; no component carries its own list or if/else chain.
 *
 * The browser bundle cannot import `@app/core`, so the group literals are
 * repeated here. A category with no group (legacy) falls into the entry marked
 * `fallback`, the same `group ?? PREMIUM_APPS` rule the server's group resolver
 * applies — the family is never guessed from a product name.
 */
export interface FamilyDef {
  /** The category `group` value this entry matches. */
  group: string;
  /** Tab / filter option label. */
  tabLabel: string;
  /** Short `?tab=` URL value. */
  param: string;
  /** Receives categories whose group is null or not in the registry. Exactly one entry. */
  fallback?: boolean;
}

/** Add a new product family here; tabs and filters pick it up automatically. */
export const FAMILY_REGISTRY: FamilyDef[] = [
  { group: "GAME_TOPUP", tabLabel: "Game Top-Up", param: "game" },
  { group: "PREMIUM_APPS", tabLabel: "Digital Apps", param: "apps", fallback: true },
];

/** "all", or a registry entry's `group`. */
export type FamilyTab = string;

export const ALL_TAB = "all";
export const ALL_TAB_LABEL = "All Products";

/** The group literal Game Top Up uses (form logic keys off it elsewhere). */
export const GAME_TOPUP_GROUP = "GAME_TOPUP";

export interface FamilyTabOption {
  value: FamilyTab;
  label: string;
}

/** "All Products" first, then one option per registry entry in registry order. */
export function familyTabOptions(registry: readonly FamilyDef[] = FAMILY_REGISTRY): FamilyTabOption[] {
  return [{ value: ALL_TAB, label: ALL_TAB_LABEL }, ...registry.map((f) => ({ value: f.group, label: f.tabLabel }))];
}

/** The registry `group` a category group belongs to; null/unknown goes to the fallback entry. */
export function familyOfGroup(
  group: string | null | undefined,
  registry: readonly FamilyDef[] = FAMILY_REGISTRY,
): string {
  const hit = group == null ? undefined : registry.find((f) => f.group === group);
  if (hit) return hit.group;
  return (registry.find((f) => f.fallback) ?? registry[registry.length - 1])!.group;
}

/** Reads `?tab=`; anything unknown (or absent) is "all". */
export function familyTabFromParam(raw: string | null, registry: readonly FamilyDef[] = FAMILY_REGISTRY): FamilyTab {
  return registry.find((f) => f.param === raw)?.group ?? ALL_TAB;
}

/** The `?tab=` value for a tab, or null for "all" (the param is dropped). */
export function familyTabToParam(tab: FamilyTab, registry: readonly FamilyDef[] = FAMILY_REGISTRY): string | null {
  return registry.find((f) => f.group === tab)?.param ?? null;
}

/** Whether a row whose category has `group` is visible under `tab`. */
export function matchesFamilyTab(
  group: string | null | undefined,
  tab: FamilyTab,
  registry: readonly FamilyDef[] = FAMILY_REGISTRY,
): boolean {
  return tab === ALL_TAB || familyOfGroup(group, registry) === tab;
}
