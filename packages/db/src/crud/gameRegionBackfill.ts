/**
 * One-time backfill: fill `Product.gameRegion` for Game Top-up products that
 * were imported BEFORE the importer started seeding it, from the region suffix
 * of `Product.digiflazzBrand` ("Mobile Legends (Malaysia)" -> "<flag> Malaysia").
 *
 * Why it is all-or-nothing per scope: the bot shows a Region picker for a
 * (category, gameVariant) scope as soon as ANY product in it has a gameRegion,
 * and a product without one is easy to miss. The bot does have a mixed-scope
 * guard (it skips the Region level and lists everything when any eligible
 * product in the scope lacks a region), so nothing vanishes; this backfill is
 * still all-or-nothing so a scope ends up either fully labelled or untouched,
 * and the picker never offers a half-labelled set of regions. A scope is
 * written only when every member can be labelled; otherwise it is skipped and
 * reported.
 *
 * Scope  = non-archived products (active or not) of ONE category whose `group`
 *          is exactly GAME_TOPUP, sharing one `gameVariant` (null is its own
 *          scope). Null-group legacy categories resolve to Premium Apps
 *          (serviceForCategoryGroup), so they are never touched.
 * Written only when ALL hold:
 *   - every member's digiflazzBrand has a suffix that gameRegionLabel() knows
 *     (publisher words and unlisted countries are never guessed);
 *   - no member already has a gameRegion (an admin-set value wins; ANY non-null
 *     value counts, including '' and whitespace, and is never overwritten). A
 *     scope whose members ALL already carry exactly the label we would write is
 *     reported as `already_filled` (idempotent re-apply) instead;
 *   - no suffix looks doubled ("Game Malaysia (Malaysia)");
 *   - the members map to at least 2 distinct labels. A single-region scope
 *     gains nothing (the bot would just apply it as a filter) and would hide
 *     siblings imported later without a region, so it is reported as
 *     `single_region_scope` and left alone.
 * Every write is compare-and-set (`gameRegion` still null), one short
 * transaction per scope. Inside it the scope is re-read with the same
 * membership predicate used for reading, so a sibling imported, archived or
 * moved to another variant/category in the read-to-write window aborts the
 * scope (`changed_concurrently`) instead of leaving it half-labelled; any lost
 * race rolls the whole scope back.
 * Residual risk: the transaction runs at READ COMMITTED, so a sibling product
 * that another session inserts (and commits) in the window between the
 * in-transaction recount and this transaction's COMMIT is not seen, and the
 * scope is then labelled without it. That product keeps a null region and is
 * still listed by the bot (mixed-scope guard), just without the picker. This
 * is acceptable for an operator-run one-off script: run it when no Digiflazz
 * sync or import is in progress.
 * One stale inactive (non-archived) product with a junk brand blocks its whole
 * scope (`unknown_suffix` / `mixed`); archive or fix it, then run again.
 * An unexpected (non-race) error stops the run after the first failing scope:
 * the partial report (scopes already written, plus the failed one with
 * `error`) is returned rather than thrown away, and later scopes are not
 * attempted (`stoppedEarly`; the members of the failed scope count in `failed`,
 * not in `skipped`). Error messages are stripped of postgres(ql):// URLs before
 * they reach the report. A failing catalog-revision bump is logged and flagged as
 * `revisionBumpFailed` while the report is still returned.
 * Dry run (`apply: false`, the default) performs zero writes.
 */
import { CategoryGroup } from "@app/core/enums";
import { gameRegionLabel } from "@app/core";
import { logger } from "@app/core/logger";
import { parseProductRegion } from "@app/core/suppliers/digiflazz";
import type { PrismaClient } from "../client";
import { logAdminAction } from "./audit";
import { bumpCatalogRevision } from "./detectionIndex";

export const GAME_REGION_BACKFILL_ACTION = "game_region_backfill";

export type GameRegionSkipReason =
  | "admin_set_region_present"
  | "already_filled"
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
  status: "written" | "would_write" | "skipped" | "failed";
  reason?: GameRegionSkipReason;
  /** Distinct unmapped suffixes (publisher words etc.), for `unknown_suffix`. */
  unknownSuffixes?: string[];
  /** Message of the unexpected error, for `status: "failed"`. */
  error?: string;
  members: GameRegionMember[];
}

export interface GameRegionBackfillReport {
  applied: boolean;
  scopes: GameRegionScopeReport[];
  /** Products whose gameRegion was written (always 0 on a dry run). */
  updated: number;
  /** Products in scopes skipped by a rule (including a lost race). */
  skipped: number;
  /** Products in scopes that failed with an unexpected error (not a skip by rule). */
  failed: number;
  /** True when the run stopped after a failed scope, so later scopes were not attempted. */
  stoppedEarly: boolean;
  /** True when data was written but the detection catalog revision bump then failed. */
  revisionBumpFailed?: boolean;
}

export interface FillGameRegionsOptions {
  apply?: boolean;
  categoryIds?: number[];
  /** Test seam: runs after a scope was read and before its write transaction. */
  beforeScopeWrite?: (scope: GameRegionScopeReport) => Promise<void>;
  /** Test seam: replaces the catalog revision bump. */
  bumpRevision?: (db: PrismaClient) => Promise<unknown>;
}

/** Replaces any postgres(ql):// connection URL in a message, which may carry a host or credentials. */
export function redactConnectionUrls(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, "[redacted-url]");
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the brand's own base text already names the region it ends with. */
function looksDoubled(brand: string, suffix: string): boolean {
  const open = brand.lastIndexOf("(");
  const base = open >= 0 ? brand.slice(0, open) : brand;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(suffix)}($|[^\\p{L}\\p{N}])`, "iu").test(base);
}

function skipReason(members: Array<GameRegionMember & { doubled: boolean }>): GameRegionSkipReason | null {
  if (members.every((m) => m.label !== null && m.currentRegion === m.label)) return "already_filled";
  if (members.some((m) => m.currentRegion !== null)) return "admin_set_region_present";
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
  const report: GameRegionBackfillReport = { applied: apply, scopes: [], updated: 0, skipped: 0, failed: 0, stoppedEarly: false };
  let wroteAny = false;
  let stopped = false;

  categoryLoop: for (const category of categories) {
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
        try {
          await opts.beforeScopeWrite?.(scope);
          const ok = await writeScope(db, scope, category.id, gameVariant);
          if (!ok) {
            scope.status = "skipped";
            scope.reason = "changed_concurrently";
          } else {
            wroteAny = true;
          }
        } catch (err) {
          scope.status = "failed";
          scope.error = redactConnectionUrls(err instanceof Error ? err.message : String(err));
          // The raw error can carry a connection URL with credentials, so only the redacted message and code are logged.
          const code = (err as { code?: unknown } | null)?.code;
          logger.error(
            { message: scope.error, code: typeof code === "string" ? code : undefined, categoryId: category.id },
            "Game region backfill stopped after an unexpected error in one scope; scopes written before it are kept and later scopes were not attempted.",
          );
          stopped = true;
        }
      }
      report.scopes.push(scope);
      if (stopped) break categoryLoop;
    }
  }

  for (const scope of report.scopes) {
    if (scope.status === "written") report.updated += scope.members.length;
    else if (scope.status === "skipped") report.skipped += scope.members.length;
    else if (scope.status === "failed") report.failed += scope.members.length;
  }
  report.stoppedEarly = stopped;
  if (wroteAny) {
    try {
      await (opts.bumpRevision ?? bumpCatalogRevision)(db);
    } catch (err) {
      report.revisionBumpFailed = true;
      logger.warn(
        { err },
        "Game regions were written but bumping the detection catalog revision failed, so the bot may keep serving a stale catalog index until the revision is bumped another way.",
      );
    }
  }
  return report;
}

/**
 * Writes one scope in a short transaction; false means a concurrent edit won and nothing was kept.
 * Membership is re-read inside the transaction with the same predicate as the initial read.
 */
async function writeScope(db: PrismaClient, scope: GameRegionScopeReport, categoryId: number, gameVariant: string | null): Promise<boolean> {
  class LostRace extends Error {}
  try {
    await db.$transaction(async (tx) => {
      const current = await tx.product.findMany({
        where: { categoryId, isArchived: false, gameVariant },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      const expected = scope.members.map((m) => m.productId).sort((a, b) => a - b);
      if (current.length !== expected.length || current.some((p, i) => p.id !== expected[i])) throw new LostRace();
      for (const m of scope.members) {
        const { count } = await tx.product.updateMany({
          where: { id: m.productId, categoryId, isArchived: false, gameVariant, gameRegion: null },
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
