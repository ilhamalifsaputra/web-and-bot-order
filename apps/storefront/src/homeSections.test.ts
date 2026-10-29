/**
 * The home page's per-group sections. Pure: input is one group's already
 * ranked cards (bestseller order, sold-out last) plus the active categories.
 */
import { describe, it, expect } from "vitest";
import { CategoryGroup, productGroup } from "@app/core";
import type { ProductCard } from "./cards";
import {
  HOME_SECTION_PAGE,
  MIN_CATEGORY_SECTION_PRODUCTS,
  SOLD_OUT_CAP_MIN_TOTAL,
  groupCategories,
  homeSections,
  type HomeCategory,
  type RankedEntry,
} from "./homeSections";

const premium = productGroup(CategoryGroup.PREMIUM_APPS);
const games = productGroup(CategoryGroup.GAME_TOPUP);

let nextCategoryId = 1;
const category = (over: Partial<HomeCategory> = {}): HomeCategory => {
  const id = nextCategoryId++;
  return { id, slug: `cat-${id}`, name: `Category ${id}`, emoji: "🎬", sortOrder: 0, group: CategoryGroup.PREMIUM_APPS, ...over };
};

let nextCard = 1;
const entry = (cat: HomeCategory, soldOut = false): RankedEntry => ({
  categoryId: cat.id,
  card: { slug: `card-${nextCard++}`, all_local_inventory: soldOut, available: 0 } as ProductCard,
});
const entries = (cat: HomeCategory, n: number, soldOut = false) => Array.from({ length: n }, () => entry(cat, soldOut));
const slugs = (cards: ProductCard[]) => cards.map((c) => c.slug);

describe("homeSections constants", () => {
  it("exposes the paging and threshold numbers the client mirrors", () => {
    expect(HOME_SECTION_PAGE).toBe(10);
    expect(MIN_CATEGORY_SECTION_PRODUCTS).toBe(3);
    expect(SOLD_OUT_CAP_MIN_TOTAL).toBe(6);
  });
});

describe("groupCategories", () => {
  it("lists only this group's categories that have products, in sortOrder then name order", () => {
    const b = category({ name: "Beta", sortOrder: 1 });
    const a = category({ name: "Alpha", sortOrder: 1 });
    const first = category({ name: "Zulu", sortOrder: 0 });
    const empty = category({ sortOrder: 0 });
    const legacy = category({ name: "Legacy", sortOrder: 2, group: null });
    const game = category({ group: CategoryGroup.GAME_TOPUP });
    const list = [b, a, first, empty, legacy, game];
    const result = groupCategories(premium, list, [...entries(b, 1), ...entries(a, 1), ...entries(first, 1), ...entries(legacy, 1), ...entries(game, 1)]);
    expect(result.map((c) => c.slug)).toEqual([first.slug, a.slug, b.slug, legacy.slug]);
  });
});

describe("homeSections — single layout", () => {
  it("returns one group section over every product, naming the categories that have products", () => {
    const ml = category({ group: CategoryGroup.GAME_TOPUP, sortOrder: 2 });
    const ff = category({ group: CategoryGroup.GAME_TOPUP, sortOrder: 1 });
    const unused = category({ group: CategoryGroup.GAME_TOPUP });
    const ranked = [...entries(ml, 2), ...entries(ff, 1)];
    const [section, ...rest] = homeSections(games, ranked, [ml, ff, unused]);
    expect(rest).toEqual([]);
    expect(section).toMatchObject({ key: "all", kind: "group", title: null, emoji: null, category_slugs: [ff.slug, ml.slug], total: 3, all_sold_out: false });
    expect(slugs(section!.products)).toEqual(slugs(ranked.map((e) => e.card)));
  });

  it("shows the first page of ten cards and reports the full total", () => {
    const cat = category({ group: CategoryGroup.GAME_TOPUP });
    const ranked = entries(cat, 25);
    const [section] = homeSections(games, ranked, [cat]);
    expect(section!.total).toBe(25);
    expect(slugs(section!.products)).toEqual(slugs(ranked.slice(0, 10).map((e) => e.card)));
  });
});

describe("homeSections — byCategory layout", () => {
  it("gives each category with at least 3 products its own section and merges the rest into one Others section", () => {
    const music = category({ name: "Music", sortOrder: 2, emoji: "🎵" });
    const video = category({ name: "Video", sortOrder: 1, emoji: "🎬" });
    const tools = category({ name: "Tools", sortOrder: 3 });
    const vpn = category({ name: "VPN", sortOrder: 4 });
    // Interleaved in bestseller order: each section keeps that relative order.
    const ranked = [entry(music), entry(tools), entry(video), entry(vpn), entry(music), entry(video), entry(music), entry(video), entry(tools)];
    const sections = homeSections(premium, ranked, [music, video, tools, vpn]);
    expect(sections.map((s) => s.key)).toEqual([`c-${video.slug}`, `c-${music.slug}`, "others"]);
    expect(sections[0]).toMatchObject({ kind: "category", title: "Video", emoji: "🎬", category_slugs: [video.slug], total: 3 });
    expect(sections[1]).toMatchObject({ kind: "category", title: "Music", emoji: "🎵", category_slugs: [music.slug], total: 3 });
    expect(sections[2]).toMatchObject({ kind: "others", title: null, emoji: null, category_slugs: [tools.slug, vpn.slug], total: 3 });
    expect(slugs(sections[1]!.products)).toEqual(slugs([ranked[0]!, ranked[4]!, ranked[6]!].map((e) => e.card)));
    expect(slugs(sections[2]!.products)).toEqual(slugs([ranked[1]!, ranked[3]!, ranked[8]!].map((e) => e.card)));
  });

  it("omits the Others section when every category is big enough", () => {
    const a = category();
    const sections = homeSections(premium, entries(a, 3), [a]);
    expect(sections.map((s) => s.kind)).toEqual(["category"]);
  });

  it("emits a single group section when no category reaches 3 products", () => {
    const a = category({ sortOrder: 1 });
    const b = category({ sortOrder: 0 });
    const sections = homeSections(premium, [...entries(a, 2), ...entries(b, 2)], [a, b]);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: "all", kind: "group", title: null, emoji: null, category_slugs: [b.slug, a.slug], total: 4 });
  });

  it("ignores categories of another group", () => {
    const own = category();
    const game = category({ group: CategoryGroup.GAME_TOPUP });
    const sections = homeSections(premium, entries(own, 3), [own, game]);
    expect(sections.flatMap((s) => s.category_slugs)).toEqual([own.slug]);
  });
});

describe("homeSections — sold-out handling", () => {
  it("caps sold-out cards at five on the first page when the section has more than six products", () => {
    const cat = category({ group: CategoryGroup.GAME_TOPUP });
    const ranked = [...entries(cat, 3), ...entries(cat, 9, true)];
    const [section] = homeSections(games, ranked, [cat]);
    expect(section!.total).toBe(12);
    expect(section!.products).toHaveLength(8);
    expect(slugs(section!.products)).toEqual(slugs(ranked.slice(0, 8).map((e) => e.card)));
    expect(section!.all_sold_out).toBe(false);
  });

  it("does not cap a section of six products or fewer", () => {
    const cat = category({ group: CategoryGroup.GAME_TOPUP });
    const [section] = homeSections(games, [...entries(cat, 0), ...entries(cat, 6, true)], [cat]);
    expect(section!.products).toHaveLength(6);
    expect(section!.all_sold_out).toBe(true);
  });

  it("shows five cards of a large all-sold-out section and flags it", () => {
    const cat = category({ group: CategoryGroup.GAME_TOPUP });
    const [section] = homeSections(games, entries(cat, 7, true), [cat]);
    expect(section!.products).toHaveLength(5);
    expect(section!.total).toBe(7);
    expect(section!.all_sold_out).toBe(true);
  });

  it("leaves a first page with no more than five sold-out cards untouched", () => {
    const cat = category({ group: CategoryGroup.GAME_TOPUP });
    const [section] = homeSections(games, [...entries(cat, 6), ...entries(cat, 10, true)], [cat]);
    expect(section!.products).toHaveLength(10);
  });
});
