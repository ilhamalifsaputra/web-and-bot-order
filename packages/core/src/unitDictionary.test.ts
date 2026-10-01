import { describe, expect, it } from "vitest";
import { ABBREVIATIONS, UNITS } from "./unitDictionary";
import { abbreviateText, displayUnit, hasRepeatedIcon, iconizeUnitOnce, sharedIconUnits } from "./unitDisplay";

const norm = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const names = (entry: (typeof UNITS)[number]) => [entry.canonical, ...entry.aliases];

describe("unit dictionary integrity", () => {
  it("has no duplicate canonical name", () => {
    const canon = UNITS.map((entry) => norm(entry.canonical));
    expect(new Set(canon).size).toBe(canon.length);
  });
  it("never lets two different entries claim the same name or alias", () => {
    const owner = new Map<string, string>();
    for (const entry of UNITS) for (const name of names(entry)) {
      const prior = owner.get(norm(name));
      expect(prior === undefined || prior === entry.canonical, `${name} is claimed by ${prior} and ${entry.canonical}`).toBe(true);
      owner.set(norm(name), entry.canonical);
    }
  });
  it("uses exactly one emoji grapheme as an icon", () => {
    for (const entry of UNITS.filter((e) => e.icon)) {
      expect([...graphemes.segment(entry.icon!)], entry.canonical).toHaveLength(1);
      expect(/\p{Extended_Pictographic}/u.test(entry.icon!), entry.canonical).toBe(true);
    }
  });
  it("gives every entry an icon or a short form, and keeps a short form shorter than its name", () => {
    for (const entry of UNITS) {
      expect(!!entry.icon || !!entry.short, entry.canonical).toBe(true);
      if (entry.short) expect(entry.short.length, entry.canonical).toBeLessThan(entry.canonical.length);
    }
  });
  it("keeps abbreviations to whole words that are really shorter", () => {
    for (const { word, short } of ABBREVIATIONS) {
      expect(word, word).toMatch(/^\p{L}+$/u);
      expect(short, word).toMatch(/^\p{L}+$/u);
      expect(short.length, word).toBeLessThan(word.length);
    }
    const words = ABBREVIATIONS.map((a) => norm(a.word));
    expect(new Set(words).size).toBe(words.length);
  });
  it("never lets an abbreviation equal a unit name or alias", () => {
    const unitNames = new Set(UNITS.flatMap(names).map(norm));
    for (const { short } of ABBREVIATIONS) expect(unitNames.has(norm(short)), short).toBe(false);
  });
  it("round-trips every name and alias through the lookup", () => {
    for (const entry of UNITS) for (const name of names(entry)) {
      expect(displayUnit(name), name).toBe(entry.icon ?? entry.short);
      expect(displayUnit(name.toUpperCase()), name).toBe(entry.icon ?? entry.short);
    }
  });
  it("carries no fields beyond the name, aliases, icon and short form", () => {
    for (const entry of UNITS) expect(Object.keys(entry).filter((key) => !["canonical", "aliases", "icon", "short"].includes(key)), entry.canonical).toEqual([]);
  });
  it("leaves an unknown unit unchanged", () => {
    for (const unit of ["Oneiric Shards", "Robux", "Bonds", "UC", "Weekly Diamond Pass", "Gold Pass", "Diamondz"]) expect(displayUnit(unit)).toBe(unit);
  });
});

describe("requested icon mappings", () => {
  it.each([
    ["Diamonds", "💎"], ["Diamond", "💎"], ["Crystals", "💎"], ["Crystal", "💎"], ["Genesis Crystals", "💎"], ["Genesis Crystal", "💎"],
    ["Gems", "💎"], ["Gem", "💎"], ["Primogems", "💎"], ["Primogem", "💎"], ["Jewels", "💎"], ["Jewel", "💎"],
    ["Coins", "🪙"], ["Coin", "🪙"], ["Delta Coins", "🪙"], ["Delta Coin", "🪙"],
    ["Gold", "🪙"], ["World Lock", "WL"], ["World Locks", "WL"],
  ])("maps %s to %s", (unit, short) => expect(displayUnit(unit)).toBe(short));
  // "Star" and "Ticket" are often part of a game's own name ("Honkai Star Rail", "Gold Ticket Membership"), so they are not units.
  it.each(["UC", "VP", "Bonds", "Robux", "Tokens", "Credits", "Points", "Stars", "Star", "Tickets", "Ticket"])("keeps %s as text", (unit) => expect(displayUnit(unit)).toBe(unit));
  it("reports different units that share one icon", () => {
    expect(sharedIconUnits(["Crystals", "Diamonds", "Diamond"])).toEqual([{ short: "💎", units: ["Crystals", "Diamonds"] }]);
    expect(sharedIconUnits(["Genesis Crystals", "Primogems", "Crystals"])[0]!.units).toEqual(["Genesis Crystals", "Primogems", "Crystals"]);
    // Gold, Coins and Delta Coins all render as the coin icon, so a list holding two of them must spell them out.
    expect(sharedIconUnits(["Gold", "Coins", "Delta Coins"])).toEqual([{ short: "🪙", units: ["Gold", "Coins", "Delta Coins"] }]);
    expect(sharedIconUnits(["Gold", "Gold"])).toEqual([]);
  });
});

describe("single-unit substitution and abbreviation", () => {
  it("replaces only the first whole-token occurrence of the named unit, never another word", () => {
    expect(iconizeUnitOnce("1000 Diamonds + 100 Bonds", "Diamonds")).toBe("1000 💎 + 100 Bonds");
    expect(iconizeUnitOnce("Diamonds Pack 1 Diamonds", "Diamonds")).toBe("💎 Pack 1 Diamonds");
    expect(iconizeUnitOnce("Weekly Diamond Pass", "Gold")).toBe("Weekly Diamond Pass");
    expect(iconizeUnitOnce("Gemstone Gem Gems", "Gem")).toBe("Gemstone 💎 Gems");
    expect(iconizeUnitOnce("Genesis Crystals Bundle 8.000 Crystals", "Crystals")).toBe("Genesis 💎 Bundle 8.000 Crystals");
  });
  it("leaves an unregistered unit, and a name without the unit, unchanged", () => {
    expect(iconizeUnitOnce("500 Tokens", "Tokens")).toBe("500 Tokens");
    expect(iconizeUnitOnce("Diamondz Gemstone Coinage", "Gem")).toBe("Diamondz Gemstone Coinage");
  });
  it("abbreviates whole words only, keeping their case, and leaves other words alone", () => {
    expect(abbreviateText("Weekly Premium Subscription")).toBe("Wkly Prem Sub");
    expect(abbreviateText("MONTHLY membership Package")).toBe("MTHLY member Pkg");
    expect(abbreviateText("Subscriptions Genesisx Preweekly")).toBe("Subscriptions Genesisx Preweekly");
    expect(abbreviateText("Genesis Crystals Bundle")).toBe("Gen Crystals Bundle");
  });
});

describe("icon repetition", () => {
  it("flags the same dictionary icon twice, and two dictionary icons side by side", () => {
    expect(hasRepeatedIcon("💎 Bundle 8.000 💎")).toBe(true);
    expect(hasRepeatedIcon("💎 💎 100")).toBe(true);
    expect(hasRepeatedIcon("💎🪙 100")).toBe(true);
    expect(hasRepeatedIcon("🪙 Gold 🪙 Pack")).toBe(true);
  });
  it("accepts one icon, or different icons that something separates, and icons the dictionary does not own", () => {
    expect(hasRepeatedIcon("7 💎 Event Gift Pack")).toBe(false);
    expect(hasRepeatedIcon("💎 Pack 🪙")).toBe(false);
    expect(hasRepeatedIcon("✨🔥 Mega Combo 🎁 🎁")).toBe(false);
  });
});
