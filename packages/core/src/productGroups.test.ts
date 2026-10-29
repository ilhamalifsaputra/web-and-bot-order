import { describe, it, expect } from "vitest";
import { CategoryGroup } from "./enums";
import { CUSTOMER_SERVICES } from "./services";
import {
  GROUP_ORDER_SETTING_KEY,
  MIN_CATEGORY_SECTION_PRODUCTS,
  PRODUCT_GROUPS,
  groupForCategory,
  productGroup,
  productGroupBySlug,
  resolveGroupOrder,
} from "./productGroups";
// The admin client may not import @app/core (scripts/check-frontend-boundaries.ts),
// so it keeps a dependency-free mirror of the threshold; this pins the two together.
import { MIN_PREMIUM_SECTION_PRODUCTS } from "../../../apps/web-admin/client/src/lib/categorySections";

const ALL_GROUPS = Object.values(CategoryGroup);

describe("PRODUCT_GROUPS registry", () => {
  it("has exactly one entry per CategoryGroup value, in default order", () => {
    expect(PRODUCT_GROUPS.map((group) => group.key)).toEqual([
      CategoryGroup.PREMIUM_APPS,
      CategoryGroup.GAME_TOPUP,
    ]);
    for (const key of ALL_GROUPS) {
      expect(PRODUCT_GROUPS.filter((group) => group.key === key)).toHaveLength(1);
    }
  });

  it("has unique slugs", () => {
    const slugs = PRODUCT_GROUPS.map((group) => group.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("has an entry for every customer service group", () => {
    for (const service of CUSTOMER_SERVICES) {
      expect(productGroup(service.group as CategoryGroup).key).toBe(service.group);
    }
  });

  it("carries the exact values for Premium Apps", () => {
    expect(productGroup(CategoryGroup.PREMIUM_APPS)).toEqual({
      key: CategoryGroup.PREMIUM_APPS,
      slug: "premium-apps",
      labelKey: "web.group_premium_apps",
      emoji: "💎",
      homeLayout: "byCategory",
      allowCheapestSort: true,
    });
  });

  it("carries the exact values for Game Top Up", () => {
    expect(productGroup(CategoryGroup.GAME_TOPUP)).toEqual({
      key: CategoryGroup.GAME_TOPUP,
      slug: "top-up-games",
      labelKey: "web.group_game_topup",
      emoji: "🎮",
      homeLayout: "single",
      allowCheapestSort: false,
    });
  });
});

describe("productGroupBySlug", () => {
  it("returns the group for a known slug", () => {
    expect(productGroupBySlug("top-up-games")?.key).toBe(CategoryGroup.GAME_TOPUP);
    expect(productGroupBySlug("premium-apps")?.key).toBe(CategoryGroup.PREMIUM_APPS);
  });

  it("returns null for an unknown slug", () => {
    expect(productGroupBySlug("gift-cards")).toBeNull();
    expect(productGroupBySlug("")).toBeNull();
    expect(productGroupBySlug("PREMIUM-APPS")).toBeNull();
  });
});

describe("groupForCategory", () => {
  it("maps null and undefined to Premium Apps", () => {
    expect(groupForCategory(null)).toBe(CategoryGroup.PREMIUM_APPS);
    expect(groupForCategory(undefined)).toBe(CategoryGroup.PREMIUM_APPS);
  });

  it("maps an unknown string to Premium Apps", () => {
    expect(groupForCategory("GIFT_CARD")).toBe(CategoryGroup.PREMIUM_APPS);
    expect(groupForCategory("")).toBe(CategoryGroup.PREMIUM_APPS);
  });

  it("keeps each known group", () => {
    expect(groupForCategory(CategoryGroup.PREMIUM_APPS)).toBe(CategoryGroup.PREMIUM_APPS);
    expect(groupForCategory(CategoryGroup.GAME_TOPUP)).toBe(CategoryGroup.GAME_TOPUP);
  });
});

describe("resolveGroupOrder", () => {
  const DEFAULT = [CategoryGroup.PREMIUM_APPS, CategoryGroup.GAME_TOPUP];
  const REVERSED = [CategoryGroup.GAME_TOPUP, CategoryGroup.PREMIUM_APPS];

  it("exposes the setting key name", () => {
    expect(GROUP_ORDER_SETTING_KEY).toBe("storefront_group_order");
  });

  it("returns the default order for null, undefined and an empty string", () => {
    expect(resolveGroupOrder(null)).toEqual(DEFAULT);
    expect(resolveGroupOrder(undefined)).toEqual(DEFAULT);
    expect(resolveGroupOrder("")).toEqual(DEFAULT);
  });

  it("returns the default order for invalid JSON without throwing", () => {
    expect(resolveGroupOrder("{not json")).toEqual(DEFAULT);
  });

  it("returns the default order for JSON that is not an array", () => {
    expect(resolveGroupOrder('{"0":"GAME_TOPUP"}')).toEqual(DEFAULT);
    expect(resolveGroupOrder('"GAME_TOPUP"')).toEqual(DEFAULT);
    expect(resolveGroupOrder("null")).toEqual(DEFAULT);
  });

  it("drops unknown keys and non-string entries", () => {
    expect(resolveGroupOrder(JSON.stringify(["NOPE", 3, null, "GAME_TOPUP"]))).toEqual(REVERSED);
  });

  it("drops duplicate keys, keeping the first occurrence", () => {
    expect(
      resolveGroupOrder(JSON.stringify(["GAME_TOPUP", "GAME_TOPUP", "PREMIUM_APPS"])),
    ).toEqual(REVERSED);
  });

  it("appends missing groups in default order", () => {
    expect(resolveGroupOrder(JSON.stringify(["GAME_TOPUP"]))).toEqual(REVERSED);
    expect(resolveGroupOrder(JSON.stringify([]))).toEqual(DEFAULT);
  });

  it("keeps a full reversed list as stored", () => {
    expect(resolveGroupOrder(JSON.stringify(REVERSED))).toEqual(REVERSED);
  });
});

describe("MIN_CATEGORY_SECTION_PRODUCTS", () => {
  it("is 3, and the admin Categories page's mirror says the same", () => {
    expect(MIN_CATEGORY_SECTION_PRODUCTS).toBe(3);
    expect(MIN_PREMIUM_SECTION_PRODUCTS).toBe(MIN_CATEGORY_SECTION_PRODUCTS);
  });
});
