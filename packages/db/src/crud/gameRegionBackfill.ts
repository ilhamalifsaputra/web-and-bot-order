/**
 * One-time backfill: fill `Product.gameRegion` for Game Top-up products that
 * were imported BEFORE the importer started seeding it, from the region suffix
 * of `Product.digiflazzBrand` ("Mobile Legends (Malaysia)" -> "<flag> Malaysia").
 *
 * Why it is all-or-nothing per scope: the bot shows a Region picker for a
 * (category, gameVariant) scope as soon as ANY product in it has a gameRegion,
 * and a product without one then vanishes behind the picker/filter (there is no
 * "mixed" guard for region, unlike gameVariant). So a scope is written only
 * when every member can be labelled; otherwise it is skipped and reported.
 *
 * Scope  = non-archived products (active or not) of ONE category whose `group`
 *          is exactly GAME_TOPUP, sharing one `gameVariant` (null is its own
 *          scope). Null-group legacy categories resolve to Premium Apps
 *          (serviceForCategoryGroup), so they are never touched.
 * Written only when ALL hold:
 *   - every member's digiflazzBrand has a suffix that gameRegionLabel() knows
 *     (publisher words and unlisted countries are never guessed);
 *   - no member already has a gameRegion (an admin-set value wins);
 *   - no suffix looks doubled ("Game Malaysia (Malaysia)");
 *   - the members map to at least 2 distinct labels. A single-region scope
 *     gains nothing (the bot would just apply it as a filter) and would hide
 *     siblings imported later without a region, so it is reported as
 *     `single_region_scope` and left alone.
 * Every write is compare-and-set (`gameRegion` still empty), one short
 * transaction per scope; any lost race rolls the whole scope back.
 * Dry run (`apply: false`, the default) performs zero writes.
 */
import { CategoryGroup } from "@app/core/enums";
import { gameRegionLabel } from "@app/core";
import { parseProductRegion } from "@app/core/suppliers/digiflazz";
import type { PrismaClient } from "../client";
import { logAdminAction } from "./audit";
import { bumpCatalogRevision } from "./detectionIndex";

export const GAME_REGION_BACKFILL_ACTION = "game_region_backfill";

export type GameRegionSkipReason =
  | "admin_set_region_present"
  | "unknown_suffix"
  | "possible_doubled_suffix"
  | "mixed"
  | "no_suffix"
  | "single_region_scope"
  | "changed_concurrently";

export interface GameRegionMember {
  productId: number;
  name: string;
  digiflazzBrand: string | null;
  /** The parsed trailing "(...)" of digiflazzBrand, or null. */
  suffix: string | null;
  /** The label that would be / was written, or null when the suffix is unknown. */
  label: string | null;
  /** The gameRegion the product already had when it was read. */
  currentRegion: string | null;
}

export interface GameRegionScopeReport {
  categoryId: number;
  categoryName: string;
  gameVariant: string | null;
  status: "written" | "would_write" | "skipped";
  reason?: GameRegionSkipReason;
  /** Distinct unmapped suffixes (publisher words etc.), for `unknown_suffix`. */
  unknownSuffixes?: string[];
  members: GameRegionMember[];
}

export interface GameRegionBackfillReport {
  applied: boolean;
  scopes: GameRegionScopeReport[];
  /** Products whose gameRegion was written (always 0 on a dry run). */
  updated: number;
  /** Products in skipped scopes. */
  skipped: number;
}

export interface FillGameRegionsOptions {
  apply?: boolean;
  categoryIds?: number[];
  /** Test seam: runs after a scope was read and before its write transaction. */
  beforeScopeWrite?: (scope: GameRegionScopeReport) => Promise<void>;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the brand's own base text already names the region it ends with. */
function looksDoubled(brand: string, suffix: string): boolean {
  const open = brand.lastIndexOf("(");
  const base = open >= 0 ? brand.slice(0, open) : brand;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(suffix)}($|[^\\p{L}\\p{N}])`, "iu").test(base);
}

function skipReason(members: Array<GameRegionMember & { doubled: boolean }>): GameRegionSkipReason | null {
  if (members.some((m) => (m.currentRegion ?? "").trim() !== "")) return "admin_set_region_present";
  if (members.some((m) => m.suffix !== null && m.label === null)) return "unknown_suffix";
  if (members.some((m) => m.doubled)) return "possible_doubled_suffix";
  const withSuffix = members.filter((m) => m.suffix !== null).length;
  if (withSuffix === 0) return "no_suffix";
  if (withSuffix < members.length) return "mixed";
  if (new Set(members.map((m) => m.label)).size < 2) return "single_region_scope";
  return null;
}

export async function fillGameRegions(db: PrismaClient, opts: FillGameRegionsOptions = {}): Promise<GameRegionBackfillReport> {
  const apply = opts.apply === true;
  const categories = await db.category.findMany({
    where: { group: CategoryGroup.GAME_TOPUP, ...(opts.categoryIds ? { id: { in: opts.categoryIds } } : {}) },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });
  const report: GameRegionBackfillReport = { applied: apply, scopes: [], updated: 0, skipped: 0 };
  const writtenByScope: GameRegionScopeReport[] = [];

  for (const category of categories) {
    const products = await db.product.findMany({
      where: { categoryId: category.id, isArchived: false },
      select: { id: true, name: true, digiflazzBrand: true, gameVariant: true, gameRegion: true },
      orderBy: { id: "asc" },
    });
    const byVariant = new Map<string | null, typeof products>();
    for (const p of products) byVariant.set(p.gameVariant, [...(byVariant.get(p.gameVariant) ?? []), p]);

    for (const [gameVariant, group] of byVariant) {
      const members = group.map((p) => {
        const suffix = p.digiflazzBrand ? parseProductRegion(p.digiflazzBrand) : null;
        return {
          productId: p.id,
          name: p.name,
          digiflazzBrand: p.digiflazzBrand,
          suffix,
          label: gameRegionLabel(suffix),
          currentRegion: p.gameRegion,
          doubled: suffix !== null && gameRegionLabel(suffix) !== null && looksDoubled(p.digiflazzBrand!, suffix),
        };
      });
      const reason = skipReason(members);
      const scope: GameRegionScopeReport = {
        categoryId: category.id,
        categoryName: category.name,
        gameVariant,
        status: reason ? "skipped" : apply ? "written" : "would_write",
        members: members.map(({ doubled: _doubled, ...m }) => m),
      };
      if (reason) {
        scope.reason = reason;
        if (reason === "unknown_suffix") {
          scope.unknownSuffixes = [...new Set(members.filter((m) => m.suffix !== null && m.label === null).map((m) => m.suffix!))].sort();
        }
      } else if (apply) {
        await opts.beforeScopeWrite?.(scope);
        const ok = await writeScope(db, scope);
        if (!ok) {
          scope.status = "skipped";
          scope.reason = "changed_concurrently";
        } else {
          writtenByScope.push(scope);
        }
      }
      report.scopes.push(scope);
    }
  }

  for (const scope of report.scopes) {
    if (scope.status === "written") report.updated += scope.members.length;
    else if (scope.status === "skipped") report.skipped += scope.members.length;
  }
  if (writtenByScope.length > 0) await bumpCatalogRevision(db);
  return report;
}

/** Writes one scope in a short transaction; false means a concurrent edit won and nothing was kept. */
async function writeScope(db: PrismaClient, scope: GameRegionScopeReport): Promise<boolean> {
  class LostRace extends Error {}
  try {
    await db.$transaction(async (tx) => {
      for (const m of scope.members) {
        const { count } = await tx.product.updateMany({
          where: { id: m.productId, OR: [{ gameRegion: null }, { gameRegion: "" }] },
          data: { gameRegion: m.label! },
        });
        if (count !== 1) throw new LostRace();
        await logAdminAction(tx, {
          adminId: null,
          action: GAME_REGION_BACKFILL_ACTION,
          targetType: "product",
          targetId: m.productId,
          details: `Set the region of "${m.name}" to ${m.label} from its Digiflazz name.`,
        });
      }
    });
    return true;
  } catch (err) {
    if (err instanceof LostRace) return false;
    throw err;
  }
}
