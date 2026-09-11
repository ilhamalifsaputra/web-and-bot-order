import type { FastifyInstance } from "fastify";
import {
  prisma,
  getDigiflazzCreds,
  groupDigiflazzPriceListByBrand,
  getDigiflazzMarkupSettings,
  applyDigiflazzMarkup,
  importDigiflazzBrand,
  listAllCategories,
  logAdminAction,
  listDetectionIssues,
  resolveDetectionIssue,
  dismissDetectionIssue,
  getLatestDetectionRunStatus,
  DETECTION_REVIEW_OPEN,
  DETECTION_REVIEW_RESOLVED,
  DETECTION_REVIEW_IGNORED,
} from "@app/db";
import { getPriceList } from "@app/core/suppliers/digiflazz";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

/**
 * Parse a price string into a Decimal, or null if it isn't a valid number
 * (mirrors routes/api/catalog.ts's parseDecimal — new Decimal(...) throws
 * synchronously on a non-numeric string, so this must be try/catch'd rather
 * than trusted like the rest of this row's fields).
 */
function parsePrice(value: string): Decimal | null {
  try {
    return new Decimal(value);
  } catch {
    return null;
  }
}

// N5: cap the total row count across every brand in a single /sync/apply
// request. This is a manual, human-reviewed wizard action (not a bulk data
// pipeline) — each brand's import runs its own $transaction, and this
// repo's shared SQLite is single-writer (see CLAUDE.md), so a very large
// request would hold a long sequence of writes against it. 500 rows
// comfortably covers a real bulk-import session while keeping that
// sequence bounded.
const MAX_APPLY_ROWS = 500;

export default async function digiflazzSyncApiRoutes(app: FastifyInstance): Promise<void> {
  // Step 1: fetch + group (dry run, no write) — same "preview then apply"
  // shape as /api/catalog/products/import, just sourced from Digiflazz's
  // live price list instead of a pasted CSV. Uses csrfProtect (not just
  // currentAdmin) because it makes a real paid outbound call to Digiflazz —
  // it must never be more permissive than /sync/apply right below it, which
  // it directly feeds into.
  app.post("/api/catalog/digiflazz/sync/preview", { preHandler: csrfProtect }, async (_req, reply) => {
    const creds = await getDigiflazzCreds(prisma);
    if (!creds) {
      return reply.code(400).send({ error: "Digiflazz credentials are not configured. Set them in Settings first." });
    }
    let items;
    try {
      items = await getPriceList(creds);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "Failed to reach Digiflazz." });
    }
    // I8 fix: tolerant, case-insensitive match on "game"/"games" — Digiflazz's
    // own docs (and this branch's core-client test fixture) use the plural
    // "Games", while the original filter only matched the exact string
    // "Game". A mismatch here used to silently produce an empty preview with
    // no diagnostic, indistinguishable from "nothing new to import".
    const gameItems = items.filter((i) => (i.category ?? "").toLowerCase().startsWith("game"));
    if (gameItems.length === 0 && items.length > 0) {
      const categoriesSeen = [...new Set(items.map((i) => i.category ?? "(none)"))];
      logger.warn(
        `Digiflazz sync preview: none of the ${items.length} price-list item(s) matched the Game category filter — categories present: ${categoriesSeen.join(", ")}`,
      );
    }
    const groups = await groupDigiflazzPriceListByBrand(prisma, gameItems);
    // I3 fix: read the markup setting ONCE for this whole preview call, not
    // once per SKU — the old computeDigiflazzMarkupPrice-per-item shape could
    // issue thousands of concurrent Settings reads against single-writer
    // SQLite on one preview click.
    const markupSettings = await getDigiflazzMarkupSettings(prisma);
    const withPrices = groups.map((g) => ({
      brand: g.brand,
      rawBrand: g.rawBrand,
      region: g.region,
      existingProductId: g.existingProductId,
      skus: g.items.map((item) => ({
        buyerSkuCode: item.buyerSkuCode,
        productName: item.productName,
        costPrice: item.price.toString(),
        suggestedPrice: applyDigiflazzMarkup(item.price, markupSettings).toString(),
      })),
    }));
    return reply.send({ groups: withPrices });
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
          rows: Array<{ buyerSkuCode: string; productName: string; price: string; costPrice: string }>;
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
      const totalRows = brands.reduce((sum, b) => sum + (Array.isArray(b.rows) ? b.rows.length : 0), 0);
      if (totalRows > MAX_APPLY_ROWS) {
        return reply.code(400).send({ error: "Too many rows in one import — narrow the filter or import in smaller batches." });
      }
      for (const b of brands) {
        for (const row of b.rows) {
          const price = row.price ? parsePrice(row.price) : null;
          if (!row.buyerSkuCode || !row.productName || !price || price.lessThanOrEqualTo(0)) {
            return reply.code(400).send({ error: `Invalid price for "${row.productName || row.buyerSkuCode}".` });
          }
          // I11 fix: costPrice is now submitted alongside price so a freshly
          // imported denomination has a correct costPrice immediately,
          // instead of null until the first resync tick fills it in. Same
          // validation shape as price above.
          const costPrice = row.costPrice ? parsePrice(row.costPrice) : null;
          if (!costPrice || costPrice.lessThanOrEqualTo(0)) {
            return reply.code(400).send({ error: `Invalid cost price for "${row.productName || row.buyerSkuCode}".` });
          }
        }
      }

      let brandsImported = 0;
      let denominationsImported = 0;
      for (const b of brands) {
        const result = await importDigiflazzBrand(prisma, { brand: b.brand, categoryId, rows: b.rows });
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
      return reply.send({ ok: true, brandsImported, denominationsImported });
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
        if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
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
        if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
        throw e;
      }
      return reply.send({ ok: true });
    },
  );
}
