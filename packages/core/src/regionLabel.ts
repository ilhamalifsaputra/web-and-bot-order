/**
 * Region labels for Game Top-up products: the whitelist the Digiflazz import
 * writes into `Product.gameRegion`, and the one gameIdentity.ts reads to tell a
 * region suffix ("(BR)", "MOBILE LEGENDS Indonesia", type "Malaysia") from the
 * rest of a game name.
 *
 * One row per region: its code, the long name and every alias, the flag, and
 * the canonical label `${flag} ${name}`. Adding a country is one row. The owner
 * confirmed BR = Brazil, PH = Philippines and MY = Malaysia; the other rows are
 * a draft for the owner to check. A code and its long name always give the
 * SAME label (production writes "Malaysia", not "MY" — both read as
 * "🇲🇾 Malaysia").
 *
 * Only a value found here is ever treated as a region; anything else (a
 * publisher such as "Garena" or "Activision", an unlisted country) yields null
 * so it is left for an admin to fill. A publisher word can never be a region
 * alias (GAME_PUBLISHER_WORDS, enforced by regionLabel.test.ts and by the
 * lookup itself).
 *
 * Each label must fit one narrow button (NARROW_LABEL_WIDTH cells, a flag
 * emoji counts 2) — regionLabel.test.ts enforces it.
 */
export interface GameRegionRow {
  /** Short code ("BR", "MY", "SEA"); "GLOBAL" for the worldwide row. */
  code: string;
  /** Long display name ("Brazil"). */
  name: string;
  /** Flag or globe emoji. */
  flag: string;
  /** Canonical label stored in / shown for gameRegion: `${flag} ${name}`. */
  label: string;
  /** Every other spelling recognised, the long name included. */
  aliases: readonly string[];
}

function region(code: string, name: string, flag: string, aliases: readonly string[]): GameRegionRow {
  return { code, name, flag, label: `${flag} ${name}`, aliases };
}

export const GAME_REGIONS: readonly GameRegionRow[] = [
  region("ID", "Indonesia", "\u{1F1EE}\u{1F1E9}", ["indonesia"]),
  region("MY", "Malaysia", "\u{1F1F2}\u{1F1FE}", ["malaysia"]),
  region("SG", "Singapore", "\u{1F1F8}\u{1F1EC}", ["singapore"]),
  region("PH", "Philippines", "\u{1F1F5}\u{1F1ED}", ["philippines", "filipina"]),
  region("TH", "Thailand", "\u{1F1F9}\u{1F1ED}", ["thailand"]),
  region("VN", "Vietnam", "\u{1F1FB}\u{1F1F3}", ["vietnam", "viet nam"]),
  region("TR", "Turkey", "\u{1F1F9}\u{1F1F7}", ["turkey", "turkiye"]),
  region("RU", "Russia", "\u{1F1F7}\u{1F1FA}", ["russia"]),
  region("BR", "Brazil", "\u{1F1E7}\u{1F1F7}", ["brazil", "brasil"]),
  region("GLOBAL", "Global", "\u{1F310}", ["global", "worldwide"]),
  region("SEA", "Southeast Asia", "\u{1F30F}", ["southeast asia", "south east asia", "asia tenggara"]),
];

/**
 * Publisher / distributor words that must never be read as a region: two
 * games that differ only by publisher are two games (owner rule), so a
 * trailing "Garena" stays part of the game name.
 */
export const GAME_PUBLISHER_WORDS: readonly string[] = [
  "garena",
  "moonton",
  "riot",
  "riot games",
  "tencent",
  "tencent games",
  "level infinite",
  "netease",
  "activision",
  "blizzard",
  "ubisoft",
  "ea",
  "electronic arts",
  "supercell",
  "krafton",
  "mihoyo",
  "hoyoverse",
  "nexon",
  "lilith",
  "gravity",
  "vng",
  "megaxus",
  "lyto",
  "unipin",
];

/** Lowercase, diacritics folded, one wrapping "( … )" removed, spaces collapsed. */
function normalizeToken(raw: string): string {
  let token = raw.normalize("NFKD").replace(/\p{M}+/gu, "").trim().replace(/\s+/g, " ").toLowerCase();
  const wrapped = /^\(\s*([^()]*?)\s*\)$/.exec(token);
  if (wrapped) token = wrapped[1]!;
  return token;
}

const PUBLISHER_SET: ReadonlySet<string> = new Set(GAME_PUBLISHER_WORDS.map(normalizeToken));

export interface GameRegionHit {
  row: GameRegionRow;
  /** True when the match was the row's short code (≤ 3 letters, e.g. "BR"). */
  viaShortCode: boolean;
}

const ROW_BY_TOKEN: ReadonlyMap<string, GameRegionHit> = new Map(
  GAME_REGIONS.flatMap((row) => [
    [normalizeToken(row.code), { row, viaShortCode: row.code.length <= 3 }] as const,
    ...row.aliases.map((alias) => [normalizeToken(alias), { row, viaShortCode: false }] as const),
  ]),
);

/** True when the value is a known publisher word ("Garena", "Level Infinite"). */
export function isGamePublisherWord(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return PUBLISHER_SET.has(normalizeToken(raw));
}

/**
 * The whitelist row for a code or alias (case-insensitive, one wrapping pair of
 * parentheses allowed), with whether it matched a short code. A publisher word
 * never matches. For gameIdentity.ts, which needs the code/alias distinction.
 */
export function lookupGameRegion(raw: string | null | undefined): GameRegionHit | null {
  if (!raw) return null;
  const token = normalizeToken(raw);
  if (token === "" || PUBLISHER_SET.has(token)) return null;
  return ROW_BY_TOKEN.get(token) ?? null;
}

/** The flagged label for a Digiflazz "(Region)" suffix, a `type` value or a
 * code, or null when it is not a known region (never a publisher or an
 * unlisted country). */
export function gameRegionLabel(rawSuffix: string | null | undefined): string | null {
  return lookupGameRegion(rawSuffix)?.row.label ?? null;
}

/**
 * The canonical form of a stored or admin-typed `gameRegion`: a recognised
 * value — code, alias, or a label with its flag, current or older
 * ("🇵🇭 Filipina") — becomes today's canonical label; anything else is kept as
 * typed (trimmed), never replaced by a guess. Blank → null. Idempotent.
 */
export function canonicalGameRegion(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed === "") return null;
  const direct = gameRegionLabel(trimmed);
  if (direct) return direct;
  // Drop a leading flag / globe emoji (and joiners) and look the name up.
  const withoutFlag = trimmed.replace(/^[^\p{L}\p{N}(]+/u, "");
  return gameRegionLabel(withoutFlag) ?? trimmed;
}

/** Every normalized suffix token the table recognizes, for callers (the
 * backfill) that must tell a known region from any other suffix. */
export function knownGameRegionTokens(): string[] {
  return [...ROW_BY_TOKEN.keys()];
}

/** The labels themselves, for width checks and documentation. */
export function knownGameRegionLabels(): string[] {
  return GAME_REGIONS.map((row) => row.label);
}
