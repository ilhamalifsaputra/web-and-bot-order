/**
 * The dictionary (kamus) behind compact Telegram button labels: which icon or short form stands for a
 * quantity unit, and which long words may be abbreviated when a label would not otherwise fit.
 * It holds DATA ONLY; the lookups live in `unitDisplay.ts`.
 *
 * Presentation only: icons and abbreviations never change identity, callbacks, SKUs, prices or what the
 * body/detail screens say. They are used for button labels. An icon stands in for a SKU's OWN unit only (one
 * phrase, never another word of a package or bundle name) and never twice in one label.
 *
 * HOW TO ADD
 *  - A unit: append one line to UNITS. `canonical` is the name, `aliases` are the other exact spellings
 *    (singular/plural). Give it an `icon` (exactly one emoji) and/or a `short` text form. Do not add a unit
 *    only because it "looks like" another one: Tokens, Credits and Points are not Coins.
 *  - An abbreviation: append one line to ABBREVIATIONS (`word` -> shorter `short`). A whole word only.
 *
 * MATCHING RULES (applied by unitDisplay.ts)
 *  - Case-insensitive, whole tokens, extra whitespace ignored. A name or alias never matches as a substring,
 *    so "Weekly Diamond Pass" is a pass, not a diamond amount, and "Gemstone" is not "Gem".
 *  - Different units that share an icon (Diamonds, Crystals, Gems, ...) are spelled out when they meet in one
 *    list, so their buttons stay distinguishable.
 *  - No name/alias may belong to two entries; unitDictionary.test.ts enforces this and the other invariants.
 */
export interface UnitEntry {
  /** The unit's own name, as shown on a detail screen. */
  canonical: string;
  /** Other exact spellings of the same unit. */
  aliases: string[];
  /** Exactly one emoji, shown instead of the unit. */
  icon?: string;
  /** Text short form: shown when there is no icon, and used by the abbreviation fallback otherwise. */
  short?: string;
  kind: "unit";
}

export interface Abbreviation {
  /** One whole word, matched case-insensitively. */
  word: string;
  /** Its shorter form; takes the case pattern of the word it replaces. */
  short: string;
}

export const UNITS: readonly UnitEntry[] = [
  // Gem-like in-game currencies share the diamond icon on purpose: the user asked for it.
  { canonical: "Diamonds", aliases: ["Diamond"], icon: "💎", kind: "unit" },
  { canonical: "Crystals", aliases: ["Crystal"], icon: "💎", kind: "unit" },
  { canonical: "Genesis Crystals", aliases: ["Genesis Crystal"], icon: "💎", short: "Gen Crystals", kind: "unit" },
  { canonical: "Gems", aliases: ["Gem"], icon: "💎", kind: "unit" },
  { canonical: "Primogems", aliases: ["Primogem"], icon: "💎", kind: "unit" },
  { canonical: "Jewels", aliases: ["Jewel"], icon: "💎", kind: "unit" },
  { canonical: "Coins", aliases: ["Coin"], icon: "🪙", kind: "unit" },
  { canonical: "Delta Coins", aliases: ["Delta Coin"], icon: "🪙", kind: "unit" },
  // Change the icon here if 🥇 is not the one you want for Gold.
  { canonical: "Gold", aliases: [], icon: "🥇", kind: "unit" },
  { canonical: "Stars", aliases: ["Star"], icon: "⭐", kind: "unit" },
  { canonical: "Tickets", aliases: ["Ticket"], icon: "🎫", kind: "unit" },
  // Growtopia's World Lock has no verified emoji; "WL" is the community's own abbreviation.
  { canonical: "World Lock", aliases: ["World Locks"], short: "WL", kind: "unit" },
];

export const ABBREVIATIONS: readonly Abbreviation[] = [
  // "Genesis Crystals" is a Genshin currency name; the dictionary above has its own short form for the phrase.
  { word: "Genesis", short: "Gen" },
  { word: "Membership", short: "Member" },
  { word: "Subscription", short: "Sub" },
  { word: "Package", short: "Pkg" },
  { word: "Premium", short: "Prem" },
  { word: "Weekly", short: "Wkly" },
  { word: "Monthly", short: "Mthly" },
  // "Bundle" stays Bundle: it is already short and unambiguous.
];
