/**
 * Static, git-committed catalog of every game KokinPay's own docs
 * (api.kokinpay.com/docs/kode-game) publish a `game_code` for — 41 games,
 * verified against that page. This replaces the old admin-configured
 * "which games support nickname-check" CRUD (removed in a later task) as
 * the single source of truth for which games this shop's nickname-check
 * feature supports and what code to send KokinPay for each.
 *
 * `code` values are used verbatim as the `gameCode` param to
 * `checkGameNickname` (../suppliers/kokinpay.ts) — do not alter them, they
 * must exactly match KokinPay's docs. Object keys are our own stable
 * internal slugs and do not have to equal `code`.
 */

export interface GameCatalogEntry {
  /** KokinPay's own game_code, sent verbatim as the `gameCode` param to
   * checkGameNickname. Must exactly match KokinPay's docs. */
  code: string;
  /** Display name, used only for matching against Product.digiflazzBrand/name. */
  name: string;
  requiresZone: boolean;
  requiresServer: boolean;
}

/**
 * requiresZone/requiresServer are not stated per-game in KokinPay's docs;
 * they're a best-effort judgment call (erring toward false when unsure —
 * a missing prompt is far less harmful than blocking a buyer with an
 * unnecessary one). Every `true` flag below carries a comment explaining
 * the reasoning so a human reviewer can sanity-check it before go-live.
 */
export const GAME_CATALOG: Record<string, GameCatalogEntry> = {
  mobileLegends: {
    code: "mobile-legends",
    name: "Mobile Legends",
    requiresZone: false,
    // Known certain case: every Indonesian top-up site asks for "ID + Server".
    requiresServer: true,
  },
  freeFire: { code: "free-fire", name: "Free Fire", requiresZone: false, requiresServer: false },
  pubgMobile: { code: "pubg-mobile", name: "PUBG Mobile", requiresZone: false, requiresServer: false },
  callOfDutyMobile: {
    code: "call-of-duty-mobile",
    name: "Call of Duty Mobile",
    requiresZone: false,
    requiresServer: false,
  },
  valorant: { code: "valorant", name: "Valorant", requiresZone: false, requiresServer: false },
  genshinImpact: {
    code: "genshin-impact",
    name: "Genshin Impact",
    requiresZone: false,
    // HoYoverse's UID-based top-up requires picking the account's server
    // region (Asia/America/Europe/TW,HK,MO) — well-established convention
    // on every top-up site for this game.
    requiresServer: true,
  },
  honorOfKings: { code: "honor-of-kings", name: "Honor of Kings", requiresZone: false, requiresServer: false },
  leagueOfLegendsWildRift: {
    code: "league-of-legends-wild-rift",
    name: "League of Legends: Wild Rift",
    requiresZone: false,
    requiresServer: false,
  },
  arenaOfValor: { code: "arena-of-valor", name: "Arena of Valor", requiresZone: false, requiresServer: false },
  pointBlank: { code: "point-blank", name: "Point Blank", requiresZone: false, requiresServer: false },
  freeFireMax: { code: "free-fire-max", name: "Free Fire Max", requiresZone: false, requiresServer: false },
  whiteoutSurvival: {
    code: "whiteout-survival",
    name: "Whiteout Survival",
    requiresZone: false,
    requiresServer: false,
  },
  honkaiImpact3: {
    code: "honkai-impact-3",
    name: "Honkai Impact 3",
    requiresZone: false,
    // Same HoYoverse server-region system as Genshin Impact.
    requiresServer: true,
  },
  honkaiStarRail: {
    code: "honkai-star-rail",
    name: "Honkai: Star Rail",
    requiresZone: false,
    // Same HoYoverse server-region system as Genshin Impact.
    requiresServer: true,
  },
  eggyParty: { code: "eggy-party", name: "Eggy Party", requiresZone: false, requiresServer: false },
  undawn: { code: "undawn", name: "Undawn", requiresZone: false, requiresServer: false },
  growtopia: { code: "growtopia", name: "Growtopia", requiresZone: false, requiresServer: false },
  leagueOfLegendsPc: {
    code: "league-of-legends-pc",
    name: "League of Legends PC",
    requiresZone: false,
    // The PC client is region/server-locked (NA/EUW/ID/etc.); top-up
    // requires selecting the account's server, unlike the mobile Riot
    // titles which use a single global Riot ID.
    requiresServer: true,
  },
  fcMobile: { code: "fc-mobile", name: "FC Mobile", requiresZone: false, requiresServer: false },
  superSus: { code: "super-sus", name: "Super Sus", requiresZone: false, requiresServer: false },
  harryPotterMagicAwakened: {
    code: "harry-potter-magic-awakened",
    name: "Harry Potter: Magic Awakened",
    requiresZone: false,
    requiresServer: false,
  },
  revelationInfiniteJourney: {
    code: "revelation-infinite-journey",
    name: "Revelation: Infinite Journey",
    requiresZone: false,
    requiresServer: false,
  },
  muOrigin3: { code: "mu-origin-3", name: "MU Origin 3", requiresZone: false, requiresServer: false },
  sausageMan: { code: "sausage-man", name: "Sausage Man", requiresZone: false, requiresServer: false },
  speedDrifters: { code: "speed-drifters", name: "Speed Drifters", requiresZone: false, requiresServer: false },
  tomAndJerryChase: {
    code: "tom-and-jerry-chase",
    name: "Tom and Jerry: Chase",
    requiresZone: false,
    requiresServer: false,
  },
  teamfightTacticsMobile: {
    code: "teamfight-tactics-mobile",
    name: "Teamfight Tactics Mobile",
    requiresZone: false,
    requiresServer: false,
  },
  lifeAfter: { code: "lifeafter", name: "LifeAfter", requiresZone: false, requiresServer: false },
  laplaceM: { code: "laplace-m", name: "Laplace M", requiresZone: false, requiresServer: false },
  arenaBreakout: { code: "arena-breakout", name: "Arena Breakout", requiresZone: false, requiresServer: false },
  zenlessZoneZero: {
    code: "zenless-zone-zero",
    name: "Zenless Zone Zero",
    requiresZone: false,
    // Same HoYoverse server-region system as Genshin Impact.
    requiresServer: true,
  },
  afkJourney: { code: "afk-journey", name: "AFK Journey", requiresZone: false, requiresServer: false },
  magicChessGoGo: { code: "magic-chess-go-go", name: "Magic Chess Go Go", requiresZone: false, requiresServer: false },
  loveAndDeepspace: {
    code: "love-and-deepspace",
    name: "Love and Deepspace",
    requiresZone: false,
    requiresServer: false,
  },
  pokemonUnite: { code: "pokemon-unite", name: "Pokemon Unite", requiresZone: false, requiresServer: false },
  dragonRaja: { code: "dragon-raja", name: "Dragon Raja", requiresZone: false, requiresServer: false },
  footballMaster2: {
    code: "football-master-2",
    name: "Football Master 2",
    requiresZone: false,
    requiresServer: false,
  },
  garenaShell: { code: "garena-shell", name: "Garena Shell", requiresZone: false, requiresServer: false },
  goddessOfVictoryNikke: {
    code: "goddess-of-victory-nikke",
    name: "Goddess of Victory: Nikke",
    requiresZone: false,
    requiresServer: false,
  },
  metalSlugAwakening: {
    code: "metal-slug-awakening",
    name: "Metal Slug: Awakening",
    requiresZone: false,
    requiresServer: false,
  },
  ragnarokMEternalLove: {
    code: "ragnarok-m-eternal-love",
    name: "Ragnarok M: Eternal Love",
    requiresZone: false,
    requiresServer: false,
  },
};

/** Lowercase and strip everything that is not a-z0-9, so "Mobile Legends",
 * "mobile-legends", "MOBILE LEGENDS", "Mobile  Legends" all normalize to
 * "mobilelegends". */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Normalize `product.digiflazzBrand` (fall back to `product.name` when
 * digiflazzBrand is null) and match it against GAME_CATALOG's `name` values
 * to find which catalog key (if any) this product belongs to. Match rule:
 * the normalized product string must CONTAIN the normalized catalog name
 * (substring match) — Digiflazz brand strings sometimes carry extra
 * suffixes (e.g. "Mobile Legends (Indonesia)"). When more than one catalog
 * name matches (e.g. "Free Fire" is itself a substring of "Free Fire Max"
 * once normalized), the longest matching name wins, since it's the more
 * specific match. Returns null if no catalog entry matches. Pure function,
 * no DB/IO.
 */
export function matchGameKey(product: { digiflazzBrand: string | null; name: string }): string | null {
  const normalizedProduct = normalize(product.digiflazzBrand ?? product.name);

  let bestKey: string | null = null;
  let bestLength = -1;
  for (const [key, entry] of Object.entries(GAME_CATALOG)) {
    const normalizedName = normalize(entry.name);
    if (normalizedProduct.includes(normalizedName) && normalizedName.length > bestLength) {
      bestKey = key;
      bestLength = normalizedName.length;
    }
  }
  return bestKey;
}

/**
 * Find the GAME_CATALOG entry whose `code` field equals `code` exactly
 * (used when an admin has typed a KokinPay code directly as a per-SKU
 * override — see the separate nickname.ts task). Returns null if no
 * entry's `code` matches (a hand-typed code that isn't one of the 41 is
 * still valid to send to KokinPay — this function is only used to recover
 * requiresZone/requiresServer metadata when possible).
 */
export function findCatalogEntryByCode(code: string): GameCatalogEntry | null {
  for (const entry of Object.values(GAME_CATALOG)) {
    if (entry.code === code) {
      return entry;
    }
  }
  return null;
}
