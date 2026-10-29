/**
 * Game identity for Game Top-up products, derived on read (no schema, no data
 * write): which game a product belongs to, its edition and its region.
 *
 * The real catalog keeps every game in ONE "Game Top Up" category and encodes
 * the region in the name ("MOBILE LEGENDS Indonesia", "Mobile Legends (BR)")
 * or in the Digiflazz `type` that became `gameVariant` ("Malaysia"). This
 * module is the single source of how those rows collapse into games so the bot
 * can show a game level, then an edition picker and a region picker scoped to
 * one game.
 *
 * Rules:
 * - gameKey: `digiflazzBrand ?? name`, with a trailing region removed (a
 *   whitelisted "(…)" suffix, a whitelisted long name / alias as the last
 *   word(s), or an UPPERCASE short code as the last word) and a trailing
 *   edition word equal to `gameVariant` removed, then normalized
 *   (normalizeGameKey). Never stripped to nothing.
 * - A publisher word (regionLabel.ts GAME_PUBLISHER_WORDS) is never a region
 *   and is never stripped from the name: "Delta Force Garena" stays its own
 *   game (owner rule: different publishers are never merged). A publisher that
 *   appears ONLY as the variant (name "Delta Force", variant "Garena") is an
 *   edition of that game.
 * - region: an explicit `gameRegion` always wins (canonicalized when it is a
 *   recognised region, kept as typed otherwise); else the variant when the
 *   variant IS a region; else the region suffix of the brand, then of the name.
 * - edition: `gameVariant` when it is not a region. The base marker "Umum" is
 *   dropped by groupProductsByGame / gameScopePickers only when it is the
 *   game's sole edition (isBaseEdition).
 */
import { canonicalGameRegion, isGamePublisherWord, lookupGameRegion } from "./regionLabel";

/** Digiflazz's base-edition marker (`type: "Umum"`), kept as gameVariant. */
export const BASE_GAME_EDITION = "Umum";

export interface GameIdentityInput {
  name: string;
  digiflazzBrand?: string | null;
  gameVariant?: string | null;
  gameRegion?: string | null;
}

export interface GameIdentity {
  /** Normalized grouping key ("mobile legends"). */
  gameKey: string;
  /** Display name of this product's game ("Mobile Legends"). */
  gameName: string;
  /** gameVariant when it is not a region, else null. */
  edition: string | null;
  /** Canonical region label ("🇲🇾 Malaysia"), an admin's unlisted value, or null. */
  region: string | null;
}

/** True for the base-edition marker "Umum" (case/space-insensitive). */
export function isBaseEdition(edition: string | null | undefined): boolean {
  return edition != null && edition.trim().toLowerCase() === BASE_GAME_EDITION.toLowerCase();
}

/**
 * Lowercase, diacritics folded, apostrophes removed, any other punctuation
 * turned into a space, spaces collapsed. Idempotent.
 */
export function normalizeGameKey(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['‘’`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function collapse(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ");
}

function blankToNull(raw: string | null | undefined): string | null {
  const value = collapse(raw);
  return value === "" ? null : value;
}

const TRAILING_PARENTHETICAL = /^(.*\S)\s*\(([^()]*)\)$/;
/** A region may span up to this many trailing words ("South East Asia"). */
const MAX_REGION_WORDS = 3;

/** Remove a trailing whitelisted region; `rest` is never empty. */
function stripTrailingRegion(base: string): { rest: string; region: string | null } {
  const paren = TRAILING_PARENTHETICAL.exec(base);
  if (paren) {
    const hit = lookupGameRegion(paren[2]);
    return hit ? { rest: paren[1]!.trim(), region: hit.row.label } : { rest: base, region: null };
  }
  const words = base.split(" ");
  for (let n = Math.min(MAX_REGION_WORDS, words.length - 1); n >= 1; n--) {
    const tail = words.slice(-n).join(" ");
    const hit = lookupGameRegion(tail);
    if (!hit) continue;
    // A bare short code counts only when written in capitals ("ML BR"), so an
    // ordinary trailing word like "my" or "id" is never read as a country.
    if (hit.viaShortCode && tail !== tail.toUpperCase()) continue;
    return { rest: words.slice(0, -n).join(" "), region: hit.row.label };
  }
  return { rest: base, region: null };
}

/** Remove `phrase` from the end of `base` (normalized word comparison), or null. */
function stripTrailingPhrase(base: string, phrase: string): string | null {
  const baseWords = base.split(" ");
  const phraseKey = normalizeGameKey(phrase);
  if (phraseKey === "") return null;
  const phraseLength = phrase.split(" ").length;
  if (phraseLength >= baseWords.length) return null;
  if (normalizeGameKey(baseWords.slice(-phraseLength).join(" ")) !== phraseKey) return null;
  return baseWords.slice(0, -phraseLength).join(" ");
}

interface DerivedIdentity extends GameIdentity {
  /** The stripped base in its original casing, for displayGameName. */
  rawName: string;
}

function derive(input: GameIdentityInput): DerivedIdentity {
  const name = collapse(input.name);
  const source = blankToNull(input.digiflazzBrand) ?? name;
  const variant = blankToNull(input.gameVariant);
  const variantRegion = variant ? (lookupGameRegion(variant)?.row.label ?? null) : null;

  const first = stripTrailingRegion(source);
  let base = first.rest;
  let suffixRegion = first.region;
  // Only an edition word is stripped: never the base marker, never a region
  // (handled above) and never a publisher — "Delta Force Garena" stays a game.
  if (variant && !variantRegion && !isBaseEdition(variant) && !isGamePublisherWord(variant)) {
    base = stripTrailingPhrase(base, variant) ?? base;
  }
  if (!suffixRegion) {
    const second = stripTrailingRegion(base);
    base = second.rest;
    suffixRegion = second.region;
  }
  const nameRegion = source === name ? null : stripTrailingRegion(name).region;

  const region = canonicalGameRegion(input.gameRegion) ?? variantRegion ?? suffixRegion ?? nameRegion;
  const edition = variant && !variantRegion ? variant : null;
  const gameKey = normalizeGameKey(base) || normalizeGameKey(source);
  return { gameKey, gameName: displayGameName([base]), edition, region, rawName: base };
}

/** The game, edition and region of one product. Pure; see the module header. */
export function deriveGameIdentity(input: GameIdentityInput): GameIdentity {
  const { gameKey, gameName, edition, region } = derive(input);
  return { gameKey, gameName, edition, region };
}

/** Words kept in capitals when an all-caps or all-lowercase name is title-cased. */
const ACRONYMS: ReadonlySet<string> = new Set([
  "pubg", "cod", "gta", "fifa", "nba", "nfl", "wwe", "mlbb", "hok", "aov", "ea", "fc",
  "cs", "csgo", "ff", "ml", "pb", "psn", "uc", "rpg", "mmorpg", "ii", "iii", "iv", "vi", "vii", "viii", "ix", "xi", "xii",
]);
/** Short words kept lowercase inside a title-cased name. */
const SMALL_WORDS: ReadonlySet<string> = new Set(["of", "the", "and", "a", "an", "in", "on", "to", "for", "at", "by", "vs"]);

function hasMixedCase(value: string): boolean {
  return /\p{Lu}/u.test(value) && /\p{Ll}/u.test(value);
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .map((word, index) => {
      const lower = word.toLowerCase();
      const core = lower.replace(/[^\p{L}\p{N}]/gu, "");
      if (ACRONYMS.has(core)) return word.toUpperCase();
      if (/\p{N}/u.test(core)) return word.toUpperCase();
      if (index > 0 && SMALL_WORDS.has(core)) return lower;
      return lower.replace(/\p{L}/u, (letter) => letter.toUpperCase());
    })
    .join(" ");
}

/**
 * The best display name among spellings of one game: the first mixed-case
 * spelling ("Mobile Legends", "eFootball") as written; when every spelling is
 * all caps or all lowercase, the first one in Title Case with acronyms
 * ("PUBG") and numbers ("8 Ball Pool") kept readable.
 */
export function displayGameName(candidates: readonly string[]): string {
  const spellings = candidates.map(collapse).filter((value) => value !== "");
  const mixed = spellings.find(hasMixedCase);
  if (mixed) return mixed;
  return titleCase(spellings[0] ?? "");
}

export interface GameGroupMember<T> {
  product: T;
  /** Edition within the game; null when there is none, or when the base
   * marker "Umum" is the game's sole edition. */
  edition: string | null;
  region: string | null;
}

export interface GameGroup<T> {
  gameKey: string;
  gameName: string;
  /** Members ordered by sortOrder, then name, then id, then input order. */
  members: GameGroupMember<T>[];
}

export interface GameGroupableProduct extends GameIdentityInput {
  id?: number | null;
  sortOrder?: number | null;
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base", numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Group products into games. Members are ordered by (sortOrder, name, id,
 * input order) — the same order the catalog queries use — and games by their
 * first member, so the result does not depend on input order. Does not mutate
 * the input.
 */
export function groupProductsByGame<T extends GameGroupableProduct>(products: readonly T[]): GameGroup<T>[] {
  const rows = products.map((product, index) => ({ product, index, identity: derive(product) }));
  rows.sort(
    (a, b) =>
      (a.product.sortOrder ?? 0) - (b.product.sortOrder ?? 0) ||
      compareNames(collapse(a.product.name), collapse(b.product.name)) ||
      (a.product.id ?? Number.MAX_SAFE_INTEGER) - (b.product.id ?? Number.MAX_SAFE_INTEGER) ||
      a.index - b.index,
  );
  const byKey = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byKey.get(row.identity.gameKey);
    if (list) list.push(row);
    else byKey.set(row.identity.gameKey, [row]);
  }
  return [...byKey].map(([gameKey, list]) => {
    const soleBase = isSoleBaseEdition(list.map((row) => row.identity.edition));
    return {
      gameKey,
      gameName: displayGameName(list.map((row) => row.identity.rawName)),
      members: list.map((row) => ({
        product: row.product,
        edition: soleBase ? null : row.identity.edition,
        region: row.identity.region,
      })),
    };
  });
}

export interface GameScopePickers {
  /** Distinct editions in member order ([] when the sole edition is the base marker). */
  editions: string[];
  /** Distinct regions in member order (within `edition` when one is given). */
  regions: string[];
  /** Some members have an edition and some do not → skip the edition level. */
  editionMixed: boolean;
  /** Some members have a region and some do not → skip the region level. */
  regionMixed: boolean;
  /** ≥ 2 editions and not mixed. */
  showEditionPicker: boolean;
  /** ≥ 2 regions and not mixed. */
  showRegionPicker: boolean;
}

function distinct(values: readonly (string | null)[]): string[] {
  const out: string[] = [];
  for (const value of values) if (value !== null && !out.includes(value)) out.push(value);
  return out;
}

function isSoleBaseEdition(editions: readonly (string | null | undefined)[]): boolean {
  const present = distinct(editions.map(blankToNull));
  return present.length === 1 && isBaseEdition(present[0]);
}

/**
 * Edition and region pickers for ONE game, with the same rules as the
 * category-level pickers (listCategoryGameVariants / listCategoryGameRegions
 * and the mixed guards in the bot's browseCategoryEntry / enterGameVariant): a
 * picker only for ≥ 2 distinct values, and a level is skipped when some
 * members lack a value while others have one. Pass `edition` (null = "no
 * edition") to scope the regions to that edition's members; leave it out to
 * use every member.
 */
export function gameScopePickers(
  members: readonly { edition: string | null; region: string | null }[],
  edition?: string | null,
): GameScopePickers {
  const soleBase = isSoleBaseEdition(members.map((member) => member.edition));
  const editionOf = (member: { edition: string | null }) => (soleBase ? null : blankToNull(member.edition));
  const editions = distinct(members.map(editionOf));
  const editionMixed = editions.length > 0 && members.some((member) => editionOf(member) === null);

  let scoped = members;
  if (edition !== undefined) {
    const wanted = soleBase && isBaseEdition(edition) ? null : blankToNull(edition);
    scoped = members.filter((member) => editionOf(member) === wanted);
  }
  const regionOf = (member: { region: string | null }) => blankToNull(member.region);
  const regions = distinct(scoped.map(regionOf));
  const regionMixed = regions.length > 0 && scoped.some((member) => regionOf(member) === null);

  return {
    editions,
    regions,
    editionMixed,
    regionMixed,
    showEditionPicker: !editionMixed && editions.length >= 2,
    showRegionPicker: !regionMixed && regions.length >= 2,
  };
}

/** Why a product looks like a regioned game member whose region was not derived. */
export type UnrecognisedRegionReason =
  /** The name / brand ends in "(…)" that is not a known region, publisher, base marker or the product's edition. */
  | "unknown_suffix"
  /** The variant is a short UPPERCASE code ("KZ") that is not a known region or publisher. */
  | "unknown_code"
  /** Other products of the same game carry a region, this one has none. */
  | "region_missing_in_regioned_game";

export interface UnrecognisedRegion<T> {
  product: T;
  reason: UnrecognisedRegionReason;
  /** The unrecognised text ("KZ", "Kazakhstan") when there is one. */
  token: string | null;
}

const SHORT_CODE = /^[A-Z]{2,3}$/;

/**
 * The "regions not recognised" report: products of one category that look
 * like a regioned member of a game but whose region could not be derived, so a
 * new country that is not in the whitelist (regionLabel.ts GAME_REGIONS) is
 * never silently flattened into an edition or a game of its own. Pure; it
 * never changes how products are grouped or browsed. A product with any
 * derived region (an admin's unlisted `gameRegion` included) is never listed.
 * Each product at most once, in input order.
 */
export function findUnrecognisedGameRegions<T extends GameGroupableProduct>(products: readonly T[]): UnrecognisedRegion<T>[] {
  const identities = products.map((product) => derive(product));
  const regionedKeys = new Set(identities.filter((identity) => identity.region !== null).map((identity) => identity.gameKey));
  const out: UnrecognisedRegion<T>[] = [];
  products.forEach((product, index) => {
    const identity = identities[index]!;
    if (identity.region !== null) return;
    const variant = blankToNull(product.gameVariant);
    // A publisher, the base marker or the product's own edition in parentheses is not a region.
    const isQuiet = (token: string) =>
      isGamePublisherWord(token) || isBaseEdition(token) || (variant !== null && normalizeGameKey(token) === normalizeGameKey(variant));
    for (const source of [blankToNull(product.digiflazzBrand), collapse(product.name)]) {
      const token = source ? blankToNull(TRAILING_PARENTHETICAL.exec(source)?.[2]) : null;
      if (token && !isQuiet(token)) {
        out.push({ product, reason: "unknown_suffix", token });
        return;
      }
    }
    if (variant && SHORT_CODE.test(variant) && !isGamePublisherWord(variant)) {
      out.push({ product, reason: "unknown_code", token: variant });
      return;
    }
    if (regionedKeys.has(identity.gameKey)) {
      out.push({ product, reason: "region_missing_in_regioned_game", token: variant && !isBaseEdition(variant) ? variant : null });
    }
  });
  return out;
}

/** The one-line admin note for that report, or null when nothing is listed. */
export function unrecognisedRegionsNote(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return `Regions not recognised: ${names.join(", ")} — add one row to packages/core/src/regionLabel.ts or set the game region in the admin.`;
}
