import type { FastifyInstance } from "fastify";
import {
  prisma,
  getDigiflazzCreds,
  groupDigiflazzPriceListByBrand,
  isDigiflazzGameItem,
  loadDigiflazzPriceContext,
  digiflazzPriceContextProblem,
  digiflazzSellPrice,
  PricingPolicyUnreadableError,
  InvalidDigiflazzMarkupError,
  importDigiflazzBrand,
  listAllCategories,
  getCategory,
  logAdminAction,
  listDetectionIssues,
  resolveDetectionIssue,
  dismissDetectionIssue,
  getLatestDetectionRunStatus,
  runDigiflazzCatalogSync,
  bumpCatalogRevision,
  DETECTION_REVIEW_OPEN,
  DETECTION_REVIEW_RESOLVED,
  DETECTION_REVIEW_IGNORED,
} from "@app/db";
import { DigiflazzSupplierError, isDigiflazzRateLimited } from "@app/core/suppliers/digiflazz";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { errorBody } from "@app/core/errorBody";
import { logger } from "@app/core/logger";
import { gameRegionLabel } from "@app/core";
import { serviceForCategoryGroup } from "@app/core/services";
import { CategoryGroup } from "@app/core/enums";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { exactFields, readMoneyField } from "../../lib/moneyField";
import { getPriceListCached, getPriceListFresh } from "../../lib/digiflazzPriceListCache";

/**
 * Read an import row's Rupiah price, or null if it isn't a finite amount.
 *
 * The sell price is pre-filled with the preview's suggested price and may be
 * retyped by the admin: a retyped price is read BY SHAPE (`16.500` is sixteen
 * and a half thousand rupiah, never 16,5 as `new Decimal(text)` read it), and
 * an untouched suggestion — the server's own plain decimal, listed in the
 * row's `exact_fields` — is read exactly. The cost price is never typed: it is
 * the preview's own value, always read exactly. See lib/moneyField.ts.
 */
function parsePrice(value: unknown, exact: boolean): Decimal | null {
  const amount = readMoneyField(value, "IDR", { exact });
  return amount && amount.isFinite() ? amount : null;
}

// N5: cap the total row count across every brand in a single /sync/apply
// request. This is a manual, human-reviewed wizard action (not a bulk data
// pipeline) — each brand's import runs its own $transaction, so a very
// large request would run a long sequence of writes while the admin waits
// on one HTTP request. 500 rows comfortably covers a real bulk-import
// session while keeping that sequence bounded.
const MAX_APPLY_ROWS = 500;

/** Shared by /sync/preview and /sync/run; the wizard page compares against
 * this exact text to skip the preview when a run already reported it. */
const NO_CREDENTIALS_ERROR = "Digiflazz credentials are not configured. Set them in Settings first.";

/** The 502 both /sync/preview and /sync/run answer when Digiflazz refuses the
 * price-list request with rc 83 (checked too often). The wizard page matches
 * this exact text to skip the preview, which would only be refused again. */
const RATE_LIMITED_ERROR = "Digiflazz sedang membatasi pengecekan price-list (rc 83). Coba lagi beberapa menit lagi.";
const RATE_LIMITED_BODY = { error: RATE_LIMITED_ERROR, code: "digiflazz_rate_limited" } as const;

/** Why an import group's Product did not get an automatic region from this import. */
export type RegionSkippedReason =
  | "no_price_list"
  | "no_matching_group"
  | "unrecognized_suffix"
  | "no_suffix"
  | "not_game_topup_category"
  | "product_exists";

/**
 * Per-brand outcome of the automatic region derivation, returned to the admin
 * as `regions[]` in the /sync/apply response (additive; the existing response
 * fields are unchanged), aligned by index with the request's `brands`. On the
 * 409/500 partial-commit answers it covers only the brands that were imported
 * before the failure.
 *  - `written`: true ONLY when this import CREATED the brand's Product with
 *    `label` as its region. The import is create-only, so false means no region
 *    was written by this import.
 *  - `label`: the flagged label (e.g. "<flag> Indonesia") derived from the
 *    price list, or null. With `product_exists` it is the label that was
 *    derived but NOT applied.
 *  - `skippedReason`: why nothing was written (null when `written`):
 *    `product_exists` (the Product already existed and keeps its own region),
 *    `no_suffix` (the brand has no "(Region)" suffix), `unrecognized_suffix`,
 *    `no_matching_group`, `no_price_list`, `not_game_topup_category`.
 *  - `suffix`: the raw "(Region)" suffix found in the price list, or null.
 */
export interface ImportRegionOutcome {
  brand: string;
  written: boolean;
  label: string | null;
  skippedReason: RegionSkippedReason | null;
  suffix: string | null;
}

/** Fold what the import actually did (Product created or reused) into a derived outcome. */
function finalizeOutcome(derived: ImportRegionOutcome, productCreated: boolean): ImportRegionOutcome {
  if (!derived.label) return derived;
  return productCreated
    ? { ...derived, written: true, skippedReason: null }
    : { ...derived, written: false, skippedReason: "product_exists" };
}

/**
 * The region label each import group's new Product is born with, aligned by
 * index with `requests`. Derived on the server from the group's own `region`
 * in the Digiflazz price list, never from a client-sent value or by re-parsing
 * the brand string. Best effort: with a non-Game category, no credentials or no
 * list available every entry is skipped and the import proceeds without a
 * region (an admin can set it, or the backfill can). The list comes through the
 * 5-minute cache, so if the cache expired between the preview and this apply
 * the region may come from a newer price list than the one the admin reviewed.
 */
async function regionOutcomesForImport(
  categoryGroup: string | null,
  requests: Array<{ brand: string; gameVariant: string | null }>,
): Promise<ImportRegionOutcome[]> {
  const skipAll = (skippedReason: RegionSkippedReason): ImportRegionOutcome[] =>
    requests.map((request) => ({ brand: request.brand, written: false, label: null, skippedReason, suffix: null }));
  // Category.group is a plain nullable string column in the schema, not the
  // CategoryGroup enum, so it is narrowed here as every other reader does.
  if (serviceForCategoryGroup(categoryGroup as CategoryGroup | null).group !== CategoryGroup.GAME_TOPUP) {
    return skipAll("not_game_topup_category");
  }
  // Everything below is best effort: before region derivation /sync/apply never
  // needed credentials or the price list, so no failure here may fail the import.
  try {
    const creds = await getDigiflazzCreds(prisma);
    if (!creds) return skipAll("no_price_list");
    const items = await getPriceListCached(creds);
    const groups = await groupDigiflazzPriceListByBrand(prisma, items.filter(isDigiflazzGameItem), { withDetection: false });
    return requests.map((request): ImportRegionOutcome => {
      const group = groups.find((g) => g.brand === request.brand && (g.gameVariant ?? null) === request.gameVariant);
      if (!group) return { brand: request.brand, written: false, label: null, skippedReason: "no_matching_group", suffix: null };
      const suffix = group.region ?? null;
      const label = gameRegionLabel(suffix);
      if (label) return { brand: request.brand, written: false, label, skippedReason: null, suffix };
      return { brand: request.brand, written: false, label: null, skippedReason: suffix ? "unrecognized_suffix" : "no_suffix", suffix };
    });
  } catch (err) {
    logger.warn(
      { err },
      "The game regions could not be derived while importing Digiflazz brands (the stored credentials, the price list or the brand grouping failed), so the new products are created without an automatic game region; an admin can set it later.",
    );
    return skipAll("no_price_list");
  }
}

export default async function digiflazzSyncApiRoutes(app: FastifyInstance): Promise<void> {
  // Step 1: fetch + group (dry run, no write) — same "preview then apply"
  // shape as /api/catalog/products/import, just sourced from Digiflazz's
  // live price list instead of a pasted CSV. Uses csrfProtect (not just
  // currentAdmin) because it makes a real paid outbound call to Digiflazz —
  // it must never be more permissive than /sync/apply right below it, which
  // it directly feeds into.
  app.post("/api/catalog/digiflazz/sync/preview", { preHandler: csrfProtect }, async (req, reply) => {
    const creds = await getDigiflazzCreds(prisma);
    if (!creds) {
      return reply.code(400).send({ error: NO_CREDENTIALS_ERROR });
    }
    // Through the shared cache: the Sync button calls /sync/run right before
    // this, and a second fetch that soon is refused by Digiflazz (rc 83). A
    // list up to five minutes old is fine here because the preview prices
    // nothing — /sync/apply writes the prices the admin reviewed.
    let items;
    try {
      items = await getPriceListCached(creds);
    } catch (err) {
      if (isDigiflazzRateLimited(err)) {
        logger.warn(
          "An admin's Digiflazz import preview could not load because Digiflazz is rate-limiting price-list checks (rc 83); the admin was asked to try again in a few minutes.",
        );
        return reply.code(502).send(RATE_LIMITED_BODY);
      }
      return reply.code(502).send({ error: err instanceof Error ? err.message : "Failed to reach Digiflazz." });
    }
    // I8 fix: tolerant, case-insensitive match on "game"/"games" — Digiflazz's
    // own docs (and this branch's core-client test fixture) use the plural
    // "Games", while the original filter only matched the exact string
    // "Game". A mismatch here used to silently produce an empty preview with
    // no diagnostic, indistinguishable from "nothing new to import".
    const gameItems = items.filter(isDigiflazzGameItem);
    if (gameItems.length === 0 && items.length > 0) {
      const categoriesSeen = [...new Set(items.map((i) => i.category ?? "(none)"))];
      logger.warn(
        `Digiflazz sync preview: none of the ${items.length} price-list item(s) matched the Game category filter — categories present: ${categoriesSeen.join(", ")}`,
      );
    }
    const groups = await groupDigiflazzPriceListByBrand(prisma, gameItems);
    // I3 fix: read the markup setting ONCE for this whole preview call, not
    // once per SKU — the old computeDigiflazzMarkupPrice-per-item shape could
    // issue thousands of concurrent Settings reads against the database on
    // one preview click.
    const context = await loadDigiflazzPriceContext(prisma);
    // An unreadable global markup or rounding prices nothing: refuse.
    const problem = digiflazzPriceContextProblem(context);
    if (problem) return reply.code(400).send({ error: problem === "markup"
      ? new InvalidDigiflazzMarkupError().message
      : new PricingPolicyUnreadableError(problem).message });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const targetId = body.categoryId == null ? null : Number(body.categoryId);
    if (targetId !== null && (!Number.isSafeInteger(targetId) || targetId <= 0 ||
      !await prisma.category.findUnique({ where: { id: targetId } }))) {
      return reply.code(400).send({ error: "Invalid target category." });
    }
    const products = await prisma.product.findMany({
      where: { id: { in: groups.flatMap(g => g.existingProductId === null ? [] : [g.existingProductId]) } },
      select: { id: true, categoryId: true },
    });
    const categories = new Map(products.map(p => [p.id, p.categoryId]));
    // The category each group is priced by: its existing product's, else the target.
    const categoryOf = (g: (typeof groups)[number]) =>
      (g.existingProductId === null ? null : categories.get(g.existingProductId)) ?? targetId;
    // Re-review N1: an unreadable category rule refuses only a preview that
    // targets or touches that category; the rest of the catalog stays importable.
    const blocked = [...new Set(groups.map(categoryOf).flatMap(id =>
      id === null || !context.unreadableCategoryById.has(id) ? [] : [context.unreadableCategoryById.get(id)!]))];
    if (targetId !== null && context.unreadableCategoryById.has(targetId)) {
      const name = context.unreadableCategoryById.get(targetId)!;
      if (!blocked.includes(name)) blocked.push(name);
    }
    if (blocked.length > 0) {
      return reply.code(400).send({ error: new PricingPolicyUnreadableError("category", blocked.sort()).message });
    }
    const withPrices = groups.map((g) => ({
      brand: g.brand,
      rawBrand: g.rawBrand,
      region: g.region,
      gameVariant: g.gameVariant,
      existingProductId: g.existingProductId,
      skus: g.items.map((item) => ({
        buyerSkuCode: item.buyerSkuCode,
        productName: item.productName,
        costPrice: item.price.toString(),
        suggestedPrice: digiflazzSellPrice(context, item.price, categoryOf(g)).toString(),
      })),
    }));
    return reply.send({ groups: withPrices });
  });

  // The full catalog sync on demand — the same run the hourly cron makes
  // (prices, new SKUs on already-imported brands added (active while the game is on sale), sync-deactivated
  // SKUs reactivated, unavailable SKUs deactivated). It goes through the same
  // lease as the cron, so the two never overlap: a held lease answers 409.
  // csrfProtect for the same reason as /sync/preview (a real outbound call to
  // Digiflazz, plus catalog writes); `/api/catalog` is super-only.
  app.post("/api/catalog/digiflazz/sync/run", { preHandler: csrfProtect }, async (req, reply) => {
    // resyncDigiflazzCatalog silently does nothing without credentials; say so.
    if (!(await getDigiflazzCreds(prisma))) {
      return reply.code(400).send({ error: NO_CREDENTIALS_ERROR });
    }
    let outcome;
    try {
      // Always a fresh list: this run writes prices, and the hourly cron (in
      // order-bot, outside this cache) may have applied a newer list since
      // any cached one was fetched. The fresh fetcher still honours the rc 83
      // cooldown and stores its list, so the preview that follows reuses it.
      outcome = await runDigiflazzCatalogSync(prisma, undefined, { fetchPriceList: getPriceListFresh });
    } catch (err) {
      if (isDigiflazzRateLimited(err)) {
        logger.warn(
          { err },
          "An admin's manual Digiflazz catalog sync did not run because Digiflazz is rate-limiting price-list checks (rc 83); nothing was changed, and the admin was asked to try again in a few minutes.",
        );
        return reply.code(502).send(RATE_LIMITED_BODY);
      }
      if (err instanceof DigiflazzSupplierError) {
        logger.error(
          { err },
          "An admin's manual Digiflazz catalog sync failed because Digiflazz could not be reached or refused the price-list request; nothing was changed, and the hourly sync or the next manual press will retry it.",
        );
        // The message is credential-free by construction (DigiflazzSupplierError).
        return reply.code(502).send({
          error: `The Digiflazz sync could not finish because Digiflazz could not be reached or refused the request: ${err.message}. Please try again in a moment.`,
        });
      }
      logger.error(
        { err },
        "An admin's manual Digiflazz catalog sync failed part-way with an internal error (not a Digiflazz problem); whatever it had already written stands, and the hourly sync or the next manual press will retry it.",
      );
      return reply.code(500).send({
        error: "The Digiflazz sync failed because of an internal error. Please try again; if it keeps failing, check the server logs.",
      });
    }
    if (outcome.status === "busy") {
      return reply.code(409).send({
        error: "A Digiflazz sync is already running (the hourly sync or another admin's). Please wait a few minutes and try again.",
      });
    }
    if (outcome.status === "aborted") {
      // The circuit breaker already audited the abort (system actor) and alerted
      // every admin; record that this admin's press ended that way.
      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "digiflazz_catalog_sync_manual",
        targetType: "product",
        targetId: null,
        details:
          "Started a manual Digiflazz sync; it was aborted because the Digiflazz price list looked malformed, so nothing was changed.",
      });
      return reply.send({
        ok: true,
        aborted: true,
        abortReason: outcome.abortReason,
        updated: 0,
        deactivated: 0,
        added: 0,
        reactivated: 0,
      });
    }
    const { updated, deactivated, added, reactivated } = outcome.result;
    try {
      await bumpCatalogRevision(prisma);
    } catch (err) {
      logger.warn(
        { err },
        "Could not bump the catalog revision after a manual Digiflazz sync; the sync's changes stand, and the detection catalog index will pick them up on its next rebuild.",
      );
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "digiflazz_catalog_sync_manual",
      targetType: "product",
      targetId: null,
      details: `Started a manual Digiflazz sync; it updated ${updated} price(s), added ${added} new SKU(s), reactivated ${reactivated} and deactivated ${deactivated}.`,
    });
    return reply.send({ ok: true, updated, deactivated, added, reactivated });
  });

  // Step 2: commit selected brands/rows in one transaction per brand.
  app.post(
    "/api/catalog/digiflazz/sync/apply",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        categoryId?: number;
        brands?: Array<{
          brand: string;
          rows: Array<{ buyerSkuCode: string; productName: string; price: unknown; costPrice: unknown; exact_fields?: unknown }>;
          gameVariant?: unknown;
        }>;
      };
      const categoryId = Number(body.categoryId);
      if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return reply.code(400).send({ error: "A target category is required." });
      }
      const brands = Array.isArray(body.brands) ? body.brands : [];
      if (brands.length === 0) {
        return reply.code(400).send({ error: "Select at least one brand to import." });
      }
      if (brands.some(b => !b || typeof b.brand !== "string" || !b.brand.trim() || !Array.isArray(b.rows) || !b.rows.length ||
          b.rows.some(row => !row || typeof row.buyerSkuCode !== "string" || !row.buyerSkuCode.trim() || typeof row.productName !== "string" || !row.productName.trim()))) {
        return reply.code(400).send({ error: "Each import group requires a brand and valid supplier SKU rows." });
      }
      const totalRows = brands.reduce((sum, b) => sum + (Array.isArray(b.rows) ? b.rows.length : 0), 0);
      if (totalRows > MAX_APPLY_ROWS) {
        return reply.code(400).send({ error: "Too many rows in one import — narrow the filter or import in smaller batches." });
      }
      // N-variant: normalised per-brand gameVariant, aligned by index with
      // `brands` — computed in this same validation pass so a malformed
      // value rejects the whole request before any import runs, same as the
      // price/costPrice checks below.
      const gameVariants: Array<string | null> = [];
      // The rows as the import writes them: prices already read (by shape or
      // exactly, see parsePrice), aligned by index with `brands`.
      const parsedRows: Array<Array<{ buyerSkuCode: string; productName: string; price: Decimal; costPrice: Decimal }>> = [];
      for (const b of brands) {
        const rows: Array<{ buyerSkuCode: string; productName: string; price: Decimal; costPrice: Decimal }> = [];
        parsedRows.push(rows);
        for (const row of b.rows) {
          const price = row.price ? parsePrice(row.price, exactFields(row).has("price")) : null;
          if (!row.buyerSkuCode || !row.productName || !price || price.lessThanOrEqualTo(0)) {
            return reply.code(400).send({ error: `Invalid price for "${row.productName || row.buyerSkuCode}".` });
          }
          // I11 fix: costPrice is now submitted alongside price so a freshly
          // imported denomination has a correct costPrice immediately,
          // instead of null until the first resync tick fills it in. Same
          // validation shape as price above.
          const costPrice = row.costPrice ? parsePrice(row.costPrice, true) : null;
          if (!costPrice || costPrice.lessThanOrEqualTo(0)) {
            return reply.code(400).send({ error: `Invalid cost price for "${row.productName || row.buyerSkuCode}".` });
          }
          rows.push({ buyerSkuCode: row.buyerSkuCode, productName: row.productName, price, costPrice });
        }

        const rawVariant = b.gameVariant;
        if (rawVariant === undefined || rawVariant === null) {
          gameVariants.push(null);
        } else if (typeof rawVariant === "string") {
          const trimmed = rawVariant.trim();
          if (trimmed.length === 0) {
            gameVariants.push(null);
          } else if (trimmed.length > 32) {
            return reply.code(400).send({ error: `gameVariant is too long for "${b.brand}".` });
          } else {
            gameVariants.push(trimmed);
          }
        } else {
          return reply.code(400).send({ error: `Invalid gameVariant for "${b.brand}".` });
        }
      }

      const category = await getCategory(prisma, categoryId);
      // A missing category is left to the import itself to reject, as before.
      const derivedRegions = await regionOutcomesForImport(category?.group ?? null, brands.map((b, i) => ({ brand: b.brand, gameVariant: gameVariants[i] ?? null })));

      let brandsImported = 0;
      let denominationsImported = 0;
      const reports = [];
      const regions: ImportRegionOutcome[] = [];
      for (const [i, b] of brands.entries()) {
        let result;
        try {
          result = await importDigiflazzBrand(prisma, {
            brand: b.brand,
            categoryId,
            rows: parsedRows[i] ?? [],
            gameVariant: gameVariants[i] ?? null,
            gameRegion: derivedRegions[i]?.label ?? null,
          });
        } catch (err) {
          logger.warn({ brand: b.brand, brandsImported, denominationsImported, conflicts: err instanceof ValidationError ? 1 : 0, errors: err instanceof ValidationError ? 0 : 1 }, "Digiflazz import stopped");
          if (err instanceof ValidationError || (err as { code?: string }).code === "P2002") {
            const reason = err instanceof ValidationError ? err.message : "Supplier SKU identity conflict.";
            return reply.code(409).send({ error: `${reason} ${brandsImported} preceding brand(s) committed; the conflicting brand was rolled back.`, brandsImported, denominationsImported, reports, regions, atomic: false });
          }
          logger.error({ err, brand: b.brand, brandsImported, errors: 1 }, "Digiflazz brand transaction failed");
          return reply.code(500).send({ error: `Import failed. ${brandsImported} preceding brand(s) committed; the failing brand was rolled back.`, brandsImported, denominationsImported, reports, regions, atomic: false });
        }
        regions.push(finalizeOutcome(derivedRegions[i]!, result.productCreated));
        reports.push({ productId: result.productId, ...result.report });
        brandsImported++;
        denominationsImported += result.denominationCount;
      }

      await logAdminAction(prisma, {
        adminId: req.admin!.userId,
        action: "digiflazz_catalog_import",
        targetType: "product",
        targetId: null,
        details: `Imported ${brandsImported} game(s) / ${denominationsImported} denomination(s) from Digiflazz.`,
      });
      const writtenCount = regions.filter((r) => r.written).length;
      const skippedByReason = new Map<string, number>();
      for (const r of regions) if (r.skippedReason) skippedByReason.set(r.skippedReason, (skippedByReason.get(r.skippedReason) ?? 0) + 1);
      logger.info(
        { brandsImported, regionsWritten: writtenCount, regionsSkipped: Object.fromEntries(skippedByReason) },
        `Digiflazz import finished: an automatic game region was written for ${writtenCount} of ${regions.length} imported brand(s); the others were skipped for the reasons counted in regionsSkipped (existing products keep their own region) and an admin can set it later.`,
      );
      // `regions` is additive (see ImportRegionOutcome): it tells the admin which
      // brands got an automatic region and why the rest did not.
      return reply.send({ ok: true, brandsImported, denominationsImported, reports, regions, atomic: false });
    },
  );

  // Categories for the target-category picker (existing categories only —
  // this wizard never auto-creates one).
  app.get("/api/catalog/digiflazz/categories", { preHandler: currentAdmin }, async (_req, reply) => {
    return reply.send({ categories: await listAllCategories(prisma) });
  });

  // === Detection Engine review queue (Task 9, AC-16/AC-20) ===
  // Reads use `currentAdmin` like the rest of this file's GETs; the state
  // transition uses `csrfProtect` (auth -> CSRF -> RBAC gate — `/api/catalog`
  // is a super-only mutation prefix per plugins/auth.ts).

  const DETECTION_REVIEW_VALUES = new Set([
    DETECTION_REVIEW_OPEN,
    DETECTION_REVIEW_RESOLVED,
    DETECTION_REVIEW_IGNORED,
  ]);

  // Latest full-catalog detection run summary (resolved/ambiguous/unknown
  // counts, confidence distribution, override hits). `null` until a run has
  // ever completed.
  app.get("/api/catalog/detection/metrics", { preHandler: currentAdmin }, async (_req, reply) => {
    return reply.send({ metrics: await getLatestDetectionRunStatus(prisma) });
  });

  // The review queue. `?reviewStatus=OPEN|RESOLVED|IGNORED` narrows it; an
  // unrecognized value is ignored and every row is returned.
  app.get("/api/catalog/detection/issues", { preHandler: currentAdmin }, async (req, reply) => {
    const q = (req.query ?? {}) as { reviewStatus?: string };
    const reviewStatus =
      q.reviewStatus && DETECTION_REVIEW_VALUES.has(q.reviewStatus) ? q.reviewStatus : undefined;
    return reply.send({ issues: await listDetectionIssues(prisma, { reviewStatus }) });
  });

  // Resolve an OPEN issue (its underlying input is now handled). A re-call on
  // an already-resolved/ignored issue is a caller bug -> 422.
  app.post(
    "/api/catalog/detection/issues/:id/resolve",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid issue id." });
      try {
        await resolveDetectionIssue(prisma, id, req.admin!.userId);
      } catch (e) {
        if (e instanceof ValidationError) return reply.code(422).send(errorBody(e));
        throw e;
      }
      return reply.send({ ok: true });
    },
  );

  // Dismiss an OPEN issue (reviewed, no action needed). Same 422-on-re-call
  // contract as /resolve.
  app.post(
    "/api/catalog/detection/issues/:id/dismiss",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid issue id." });
      try {
        await dismissDetectionIssue(prisma, id, req.admin!.userId);
      } catch (e) {
        if (e instanceof ValidationError) return reply.code(422).send(errorBody(e));
        throw e;
      }
      return reply.send({ ok: true });
    },
  );
}
