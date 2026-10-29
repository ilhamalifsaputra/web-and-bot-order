/**
 * The storefront home page's sections for ONE product group. Pure — the
 * caller (pageData.ts's homePageData) loads and ranks the catalog once; this
 * only splits a group's ranked cards into the sections the page renders.
 *
 * Layout `single` (Top Up Games) is one grid; layout `byCategory` (Premium
 * Apps) gives each category with enough products its own sub-section and
 * merges the rest into one final "Others" sub-section.
 */
import { MIN_CATEGORY_SECTION_PRODUCTS, groupForCategory, type ProductGroupDef } from "@app/core";
import { isOutOfStock, type ProductCard } from "./cards";

/** Cards on a section's first page; "Show more" fetches this many again. */
export const HOME_SECTION_PAGE = 10;
/** A category needs this many products for its own byCategory sub-section
 * (defined in @app/core so the admin's mirror can be pinned to it). */
export { MIN_CATEGORY_SECTION_PRODUCTS };
/** The sold-out cap (at most half the first page) applies only above this many products. */
export const SOLD_OUT_CAP_MIN_TOTAL = 6;

/** The category fields the sections need (a subset of the Category row). */
export interface HomeCategory {
  id: number;
  slug: string;
  name: string;
  emoji: string | null;
  sortOrder: number;
  group: string | null;
}

/** One ranked card and the category its product belongs to. */
export interface RankedEntry {
  categoryId: number;
  card: ProductCard;
}

export interface HomeSection {
  key: string;
  kind: "group" | "category" | "others";
  title: string | null;
  emoji: string | null;
  category_slugs: string[];
  /** The first page of cards (see firstPage). */
  products: ProductCard[];
  /** Every product in the section; the rest is paged from the group endpoint. */
  total: number;
  /** True when the section has products and every one is sold out. */
  all_sold_out: boolean;
}

/**
 * This group's categories that have at least one ranked product, in the
 * shared category order (sortOrder, then name). A null-group category counts
 * as Premium Apps (groupForCategory).
 */
export function groupCategories<C extends HomeCategory>(
  def: ProductGroupDef,
  categories: readonly C[],
  entries: readonly Pick<RankedEntry, "categoryId">[],
): C[] {
  const withProducts = new Set(entries.map((e) => e.categoryId));
  return categories
    .filter((c) => groupForCategory(c.group) === def.key && withProducts.has(c.id))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * The first page of a section: HOME_SECTION_PAGE cards, except that a section
 * with more than SOLD_OUT_CAP_MIN_TOTAL products shows at most half a page of
 * sold-out cards. Sold-out cards are already last (rankCards), so the cap
 * trims from the end; the client pages on from the number of cards shown.
 */
function firstPage(cards: readonly ProductCard[]): ProductCard[] {
  const page = cards.slice(0, HOME_SECTION_PAGE);
  if (cards.length <= SOLD_OUT_CAP_MIN_TOTAL) return page;
  const cap = Math.floor(HOME_SECTION_PAGE / 2);
  let soldOut = page.filter(isOutOfStock).length;
  while (soldOut > cap && page.length > 0 && isOutOfStock(page[page.length - 1]!)) {
    page.pop();
    soldOut--;
  }
  return page;
}

function section(
  head: Pick<HomeSection, "key" | "kind" | "title" | "emoji" | "category_slugs">,
  cards: readonly ProductCard[],
): HomeSection {
  return {
    ...head,
    products: firstPage(cards),
    total: cards.length,
    all_sold_out: cards.length > 0 && cards.every(isOutOfStock),
  };
}

/**
 * Split one group's ranked entries into home sections. `entries` must already
 * be in display order (bestseller, sold-out last) and belong to `def`'s
 * group; every section keeps that relative order.
 */
export function homeSections(
  def: ProductGroupDef,
  entries: readonly RankedEntry[],
  categories: readonly HomeCategory[],
): HomeSection[] {
  const cats = groupCategories(def, categories, entries);
  const cardsOf = (ids: ReadonlySet<number>) => entries.filter((e) => ids.has(e.categoryId)).map((e) => e.card);
  const whole = () =>
    section({ key: "all", kind: "group", title: null, emoji: null, category_slugs: cats.map((c) => c.slug) }, cardsOf(new Set(cats.map((c) => c.id))));

  if (def.homeLayout === "single") return [whole()];

  const counts = new Map<number, number>();
  for (const e of entries) counts.set(e.categoryId, (counts.get(e.categoryId) ?? 0) + 1);
  const big = cats.filter((c) => (counts.get(c.id) ?? 0) >= MIN_CATEGORY_SECTION_PRODUCTS);
  if (big.length === 0) return [whole()];

  const sections = big.map((c) =>
    section({ key: `c-${c.slug}`, kind: "category", title: c.name, emoji: c.emoji, category_slugs: [c.slug] }, cardsOf(new Set([c.id]))),
  );
  const rest = cats.filter((c) => !big.includes(c));
  if (rest.length > 0) {
    sections.push(
      section({ key: "others", kind: "others", title: null, emoji: null, category_slugs: rest.map((c) => c.slug) }, cardsOf(new Set(rest.map((c) => c.id)))),
    );
  }
  return sections;
}
