/**
 * Read-only diagnostic (plan step B0): report what values Digiflazz's
 * per-SKU `type` sub-field actually carries, grouped by game brand, in THIS
 * account's live prepaid price-list.
 *
 * Why this exists: Digiflazz files every SKU under a `brand` plus a `type`
 * sub-filter — `"Umum"` (the base edition) vs `"Infinite"`, `"Garena"`,
 * `"Global"`, region names, `"Membership"`, etc. Our import path
 * (groupDigiflazzPriceListByBrand / importDigiflazzBrand in
 * packages/db/src/crud/digiflazz.ts) reads `type` into the item struct and
 * then throws it away, so two editions of one game (Arena Breakout / Arena
 * Breakout Infinite) collapse into a single catalog Product with a mixed
 * denomination list. Every existing test fixture hard-codes `type: "Umum"`,
 * so before building grouping logic on `type` we need to see the real
 * values. This script prints them and nothing else — it is the decision
 * gate for whether the follow-up import-grouping work keys off the
 * structured `type` field (expected) or falls back to a heuristic engine.
 *
 * Read-only: the ONLY outbound call is a single `getPriceList()` — the same
 * paid GET-equivalent the Digiflazz sync wizard's "preview" step makes. No
 * Prisma writes, no schema migration, no second Digiflazz call, nothing
 * written to disk. Credentials are read from Settings and never printed.
 *
 *   pnpm inspect-digiflazz-catalog          # fetch the price-list once and print the report
 *   pnpm inspect-digiflazz-catalog --help   # show this help
 *
 * Needs Digiflazz credentials configured in Settings (the same ones the sync
 * wizard uses); run it against the real account. A dev worktree with no
 * credentials cannot exercise it — it exits non-zero with a clear message.
 */
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma, initDb, getDigiflazzCreds } from "@app/db";
import { getPriceList, parseProductRegion, type DigiflazzPriceListItem } from "@app/core/suppliers/digiflazz";

// Load the monorepo-root `.env` regardless of cwd — the same walk-up
// scripts/export-detection-fixture.ts uses, since this script runs standalone
// via `tsx`, not through the Prisma CLI's automatic .env load. Prisma Client
// resolves DATABASE_URL_PRISMA lazily at the first query, so this only needs
// to run before main()'s first DB call — it does (top-level, synchronous,
// and main() is invoked at the bottom of this file). dotenv does not override
// already-set vars, so it is a harmless no-op if the env is loaded some other
// way.
function findRootEnv(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, ".env");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
loadEnv({ path: findRootEnv() });

const USAGE = `Inspect the live Digiflazz price-list and report, per game brand, what values
the per-SKU \`type\` field carries (diagnostic — read-only, writes nothing).

Usage:
  pnpm inspect-digiflazz-catalog          # fetch the price-list once and print the report
  pnpm inspect-digiflazz-catalog --help   # show this help

Options:
  --help, -h    Show this help.

Reads Digiflazz credentials from Settings (never prints them) and makes a
single price-list call — the same one the sync wizard's preview step makes.
Run it against the real Digiflazz account; it exits non-zero when no
credentials are configured.
`;

// ---------------------------------------------------------------------------
// Pure summary logic (no I/O) — exported so it can be unit-tested on plain
// in-memory arrays without touching the network or the DB.
// ---------------------------------------------------------------------------

/** Deterministic string ordering — plain code-point `<`/`>`, never
 * `localeCompare`, so two runs of this script diff cleanly. */
function asciiCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * How a raw `type` value is displayed and bucketed. `null` and
 * empty/whitespace are kept as SEPARATE buckets — the reader needs to see
 * which one occurs — and every other value keeps its exact original casing
 * and surrounding whitespace, so casing/whitespace noise (`"UMUM"`,
 * `" Umum "`) stays visible instead of being silently folded into `"Umum"`.
 */
export function typeDisplayKey(type: string | null): string {
  if (type === null) return "(null)";
  if (type.trim() === "") return "(empty)";
  return type;
}

function isBlankType(type: string | null): boolean {
  return type === null || type.trim() === "";
}

/** True for any value that means "the base edition" once casing and
 * surrounding whitespace are ignored — `"Umum"`, `"UMUM"`, `" umum "`. */
function meansUmum(type: string | null): boolean {
  return type !== null && type.trim().toLowerCase() === "umum";
}

export interface TypeBucket {
  /** Display/bucket key, from `typeDisplayKey`. */
  key: string;
  skuCount: number;
  /** One example product name for this (brand, type) pair — the
   * lexicographically smallest, so the choice is deterministic. */
  sampleProductName: string;
}

export interface RegionDoubleCount {
  /** The non-"umum" `type` value. */
  type: string;
  /** The region parsed from the product name's trailing parenthetical. */
  parsedRegion: string;
  /** Whether `type` and the parsed `(Region)` suffix match case-insensitively. */
  matches: boolean;
}

export interface BrandSummary {
  brand: string;
  skuCount: number;
  /** Distinct `type` buckets for this brand, sorted by key. */
  types: TypeBucket[];
  /** Non-`"Umum"`-cased values that still lowercase to `"umum"` (e.g.
   * `"UMUM"`, `" Umum "`) — sorted, deduped. Empty when none. */
  baseCasingVariants: string[];
  /** At least one SKU has a null/empty/whitespace `type`. */
  hasBlankType: boolean;
  /** (type, parsed region) pairs where a non-"umum" `type` co-occurs with a
   * trailing `(Region)` parenthetical in the product name. Sorted, deduped.
   * Empty when none. Blank `type` values are excluded — they carry no region
   * info, so pairing them with a `(Region)` suffix is not a double-count;
   * `hasBlankType` already flags them. */
  regionDoubleCounts: RegionDoubleCount[];
}

export interface CatalogSummary {
  /** Total price-list items fetched (before the Game filter). */
  totalItems: number;
  /** Items that matched the Game category filter. */
  gameItemCount: number;
  /** Per-brand breakdown, brands in ascending order. */
  brands: BrandSummary[];
  /** Game-category items whose `brand` was null (not groupable). */
  noBrandCount: number;
  /** Game brands with >= 2 distinct `type` buckets (the ones that would
   * split under structured `type` grouping). */
  brandsThatWouldSplit: number;
  /** Sorted, deduped union of every non-blank, non-"umum" `type` value seen
   * across all game brands (original casing kept). */
  nonUmumTypeValues: string[];
  /** True when no game brand carries any `type` value beyond blank / "umum"
   * — i.e. `type` cannot distinguish editions in this catalog. */
  typeIsUninformative: boolean;
}

/**
 * Reduce the game-category price-list items to the per-brand `type` report.
 * `gameItems` must already be filtered to the Game category; `totalItems` is
 * the pre-filter count, carried only for the report header.
 */
export function summarizeCatalog(
  gameItems: DigiflazzPriceListItem[],
  totalItems: number = gameItems.length,
): CatalogSummary {
  const byBrand = new Map<string, DigiflazzPriceListItem[]>();
  let noBrandCount = 0;
  for (const item of gameItems) {
    if (item.brand === null) {
      noBrandCount++;
      continue;
    }
    const list = byBrand.get(item.brand) ?? [];
    list.push(item);
    byBrand.set(item.brand, list);
  }

  const brands: BrandSummary[] = [];
  for (const brand of [...byBrand.keys()].sort(asciiCompare)) {
    const items = byBrand.get(brand) ?? [];

    const buckets = new Map<string, { skuCount: number; sample: string }>();
    for (const item of items) {
      const key = typeDisplayKey(item.type);
      const bucket = buckets.get(key);
      if (bucket === undefined) {
        buckets.set(key, { skuCount: 1, sample: item.productName });
      } else {
        bucket.skuCount++;
        if (item.productName < bucket.sample) bucket.sample = item.productName;
      }
    }
    const types: TypeBucket[] = [...buckets.entries()]
      .map(([key, value]) => ({ key, skuCount: value.skuCount, sampleProductName: value.sample }))
      .sort((a, b) => asciiCompare(a.key, b.key));

    const baseCasingVariants = [
      ...new Set(
        items
          .map((i) => i.type)
          .filter((t): t is string => t !== null && meansUmum(t) && t !== "Umum"),
      ),
    ].sort(asciiCompare);

    const hasBlankType = items.some((i) => isBlankType(i.type));

    const doubleCounts = new Map<string, RegionDoubleCount>();
    for (const item of items) {
      if (isBlankType(item.type) || meansUmum(item.type)) continue;
      const type = item.type ?? ""; // isBlankType ruled out null above; keep TS happy
      const parsedRegion = parseProductRegion(item.productName);
      if (parsedRegion === null) continue;
      const dedupeKey = `${type} ${parsedRegion}`;
      if (!doubleCounts.has(dedupeKey)) {
        doubleCounts.set(dedupeKey, {
          type,
          parsedRegion,
          matches: type.trim().toLowerCase() === parsedRegion.trim().toLowerCase(),
        });
      }
    }
    const regionDoubleCounts = [...doubleCounts.values()].sort(
      (a, b) => asciiCompare(a.type, b.type) || asciiCompare(a.parsedRegion, b.parsedRegion),
    );

    brands.push({
      brand,
      skuCount: items.length,
      types,
      baseCasingVariants,
      hasBlankType,
      regionDoubleCounts,
    });
  }

  const nonUmumTypeValues = [
    ...new Set(
      gameItems
        .filter((i) => i.brand !== null && !isBlankType(i.type) && !meansUmum(i.type))
        .map((i) => i.type ?? ""),
    ),
  ].sort(asciiCompare);

  const brandsThatWouldSplit = brands.filter((b) => b.types.length >= 2).length;

  // Verdict A ("type does not distinguish editions") holds only when EVERY
  // game brand's every `type` bucket is blank or a casing-variant of "umum".
  const typeIsUninformative = brands.every((b) =>
    b.types.every((t) => t.key === "(null)" || t.key === "(empty)" || meansUmum(t.key)),
  );

  return {
    totalItems,
    gameItemCount: gameItems.length,
    brands,
    noBrandCount,
    brandsThatWouldSplit,
    nonUmumTypeValues,
    typeIsUninformative,
  };
}

/** Render a `CatalogSummary` as plain terminal lines (no ANSI, no JSON). */
export function formatReport(summary: CatalogSummary): string[] {
  const out: string[] = [];
  const rule = "=".repeat(60);

  out.push("Digiflazz catalog — `type` field diagnostic (read-only)");
  out.push(
    `Fetched ${summary.totalItems} price-list item(s); ${summary.gameItemCount} matched the Game category filter.`,
  );

  for (const brand of summary.brands) {
    out.push("");
    out.push(rule);
    out.push(`BRAND: ${brand.brand}  (${brand.skuCount} ${brand.skuCount === 1 ? "SKU" : "SKUs"})`);
    const keyWidth = brand.types.reduce((max, t) => Math.max(max, t.key.length), 0);
    for (const t of brand.types) {
      out.push(
        `  type ${t.key.padEnd(keyWidth)}  -> ${String(t.skuCount).padStart(4)} ` +
          `${t.skuCount === 1 ? "SKU" : "SKUs"}   e.g. ${JSON.stringify(t.sampleProductName)}`,
      );
    }
    if (brand.baseCasingVariants.length > 0) {
      out.push(
        `  ⚠ base-casing: ${brand.baseCasingVariants.map((v) => JSON.stringify(v)).join(", ")} ` +
          `— lowercases to "umum" but is not exactly "Umum"`,
      );
    }
    if (brand.hasBlankType) {
      out.push("  ⚠ blank-type: at least one SKU has a null/empty/whitespace type");
    }
    if (brand.regionDoubleCounts.length > 0) {
      out.push("  ⚠ region-double-count:");
      for (const r of brand.regionDoubleCounts) {
        out.push(
          `      type ${JSON.stringify(r.type)} + productName region ${JSON.stringify(r.parsedRegion)} — ` +
            (r.matches
              ? "match (case-insensitive) — dedupe is enough"
              : "NO MATCH — type carries region info the (suffix) does not"),
        );
      }
    }
  }

  out.push("");
  out.push(rule);
  out.push("SUMMARY");
  out.push(`  Game brands:                          ${summary.brands.length}`);
  out.push(`  Brands with >=2 distinct type values: ${summary.brandsThatWouldSplit}`);
  out.push(
    `  Distinct non-"Umum" type values seen: ${
      summary.nonUmumTypeValues.length > 0 ? summary.nonUmumTypeValues.join(", ") : "(none)"
    }`,
  );
  out.push(`  ${summary.noBrandCount} game item(s) had no brand and were not grouped.`);
  out.push("");
  out.push(
    summary.typeIsUninformative
      ? "Verdict: `type` does not distinguish editions in this catalog — the heuristic fallback is needed."
      : "Verdict: `type` carries edition/variant information — structured grouping by `type` is viable.",
  );

  return out;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const unknown = argv.filter((a) => a !== "--help" && a !== "-h");
  if (unknown.length > 0) {
    console.error(`Unknown option(s): ${unknown.join(", ")}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  await initDb(); // no-op on Postgres; kept for boot-sequencing parity with the app

  const creds = await getDigiflazzCreds(prisma);
  if (!creds) {
    console.error("Digiflazz credentials are not configured. Set them in Settings first.");
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }

  let items: DigiflazzPriceListItem[];
  try {
    // The single outbound call — same as the sync wizard's preview step.
    items = await getPriceList(creds);
  } catch (err) {
    console.error(`Failed to fetch the Digiflazz price list: ${err instanceof Error ? err.message : String(err)}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }

  await prisma.$disconnect().catch(() => {});

  if (items.length === 0) {
    console.log("Digiflazz returned 0 price-list item(s) — nothing to report.");
    return;
  }

  // Mirror apps/web-admin/src/routes/api/digiflazzSync.ts exactly.
  const gameItems = items.filter((i) => (i.category ?? "").toLowerCase().startsWith("game"));

  if (gameItems.length === 0) {
    const categories = [...new Set(items.map((i) => i.category ?? "(null)"))].sort(asciiCompare);
    console.log(
      `None of the ${items.length} price-list item(s) matched the Game category filter ` +
        `(category starts with "game") — nothing to report.`,
    );
    console.log(`Distinct category values seen: ${categories.join(", ")}`);
    return;
  }

  for (const line of formatReport(summarizeCatalog(gameItems, items.length))) {
    console.log(line);
  }
}

main().catch(async (err) => {
  console.error("inspect-digiflazz-catalog failed:", err instanceof Error ? err.message : err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
