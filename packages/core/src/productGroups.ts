import { CategoryGroup } from "./enums";
import { CUSTOMER_SERVICES, serviceForCategoryGroup } from "./services";

/** How a group's storefront home section is laid out. */
export type HomeLayout = "single" | "byCategory";

/** Display and routing definition for one product group (Premium Apps, Game Top Up, ...). */
export interface ProductGroupDef {
  key: CategoryGroup;
  /** URL handle for /g/:slug. */
  slug: string;
  /** Storefront i18n key for the group name, e.g. "web.group_premium_apps". */
  labelKey: string;
  emoji: string;
  homeLayout: HomeLayout;
  allowCheapestSort: boolean;
}

/** One entry per CategoryGroup value, in default order. */
export const PRODUCT_GROUPS: readonly ProductGroupDef[] = [
  {
    key: CategoryGroup.PREMIUM_APPS,
    slug: "premium-apps",
    labelKey: "web.group_premium_apps",
    emoji: "💎",
    homeLayout: "byCategory",
    allowCheapestSort: true,
  },
  {
    key: CategoryGroup.GAME_TOPUP,
    slug: "top-up-games",
    labelKey: "web.group_game_topup",
    emoji: "🎮",
    homeLayout: "single",
    allowCheapestSort: false,
  },
];

/** The registry entry for a group key. */
export function productGroup(key: CategoryGroup): ProductGroupDef {
  const group = PRODUCT_GROUPS.find((entry) => entry.key === key);
  if (!group) throw new Error(`No product group is registered for "${key}".`);
  return group;
}

/** The registry entry for a URL slug, or null when no group uses it. */
export function productGroupBySlug(slug: string): ProductGroupDef | null {
  return PRODUCT_GROUPS.find((entry) => entry.slug === slug) ?? null;
}

/**
 * The group a category belongs to. A null, undefined or unregistered group
 * resolves to Premium Apps, the same rule as serviceForCategoryGroup.
 */
export function groupForCategory(group: string | null | undefined): CategoryGroup {
  return serviceForCategoryGroup(group, CUSTOMER_SERVICES).group;
}

/** Settings key holding the admin-chosen group display order (a JSON array of group keys). */
export const GROUP_ORDER_SETTING_KEY = "storefront_group_order";

const DEFAULT_GROUP_ORDER: readonly CategoryGroup[] = PRODUCT_GROUPS.map((group) => group.key);

function isCategoryGroup(value: unknown): value is CategoryGroup {
  return typeof value === "string" && (DEFAULT_GROUP_ORDER as readonly string[]).includes(value);
}

/**
 * The stored group order, made complete: unknown keys and duplicates are
 * dropped, and any group missing from the stored list is appended in default
 * order. Invalid JSON or a non-array value yields the default order. Never throws.
 */
export function resolveGroupOrder(stored: string | null | undefined): CategoryGroup[] {
  let parsed: unknown;
  try {
    parsed = stored ? JSON.parse(stored) : null;
  } catch {
    return [...DEFAULT_GROUP_ORDER];
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_GROUP_ORDER];

  const ordered: CategoryGroup[] = [];
  for (const value of parsed) {
    if (isCategoryGroup(value) && !ordered.includes(value)) ordered.push(value);
  }
  for (const key of DEFAULT_GROUP_ORDER) {
    if (!ordered.includes(key)) ordered.push(key);
  }
  return ordered;
}
