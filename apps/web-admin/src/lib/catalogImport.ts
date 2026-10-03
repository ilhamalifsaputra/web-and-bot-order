/**
 * Shared catalog CSV-import logic: parsing, validation, and the find-or-create
 * helper for mid-tier Products. Extracted from routes/catalog.ts so the JSON
 * API endpoints (routes/api/catalog.ts) can reuse the same code without
 * duplicating it.
 */
import { ProductType } from "@app/core/enums";
import { parseMoneyInput } from "@app/core/moneyFormat";
import type { Db } from "@app/db";
import { listAllCategories, createCatalogProduct } from "@app/db";

export interface ImportRow {
  line: number;
  ok: boolean;
  error?: string;
  category?: string;
  product?: string;
  denomination?: string;
  price?: string;
  data?: {
    categoryId: number;
    productName: string;
    denominationName: string;
    type: ProductType;
    durationLabel: string;
    price: string;
    costPrice: string | null;
    resellerPrice: string | null;
    warrantyDays: number | null;
    description: string | null;
  };
}

/**
 * A typed Rupiah amount read by its shape ("79.000" and "79,000" are seventy-nine
 * thousand, "4480.50" has a decimal), as the canonical plain-decimal string that
 * gets stored; null when it is malformed or ambiguous.
 */
const rupiah = (s: string): string | null => parseMoneyInput(s, "IDR")?.toString() ?? null;

/**
 * Parse pipe-delimited denomination rows (one per line):
 *   category | product | denomination | type | duration | price [| cost | reseller | warranty_days | description]
 * Validates each row against known category names; returns per-row status so
 * the operator sees a dry-run before any write. Re-run on apply (never trust
 * a precomputed payload). The mid-tier Product is resolved-or-created by name
 * within the category at apply time (not here — this is a pure parse/validate).
 */
export function parseDenominationCsv(text: string, catByName: Map<string, number>): ImportRow[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((raw, idx) => {
      const line = idx + 1;
      const cols = raw.split("|").map((c) => c.trim());
      const [category, product, denomination, type, durationLabel, price, costPrice, resellerPrice, warrantyDays, ...descParts] =
        cols;
      const base: ImportRow = { line, ok: false, category, product, denomination, price };
      const fail = (error: string): ImportRow => ({ ...base, error });

      if (cols.length < 6) return fail("need: category|product|denomination|type|duration|price");
      const categoryId = category ? catByName.get(category.toLowerCase()) : undefined;
      if (!categoryId) return fail(`unknown category "${category ?? ""}"`);
      if (!product) return fail("product name is required");
      if (!denomination) return fail("denomination name is required");
      const typeUpper = (type ?? "").toUpperCase();
      if (typeUpper !== "SHARED" && typeUpper !== "PRIVATE") return fail("type must be shared or private");
      if (!durationLabel) return fail("duration label is required");
      const priceValue = price ? rupiah(price) : null;
      if (priceValue === null || Number(priceValue) <= 0) return fail("price must be a positive number (Rupiah, e.g. 79000 or 79.000)");
      let cost: string | null = null;
      if (costPrice) {
        cost = rupiah(costPrice);
        if (cost === null) return fail("cost price must be a number (Rupiah, e.g. 40000 or 40.000)");
      }
      let reseller: string | null = null;
      if (resellerPrice) {
        reseller = rupiah(resellerPrice);
        if (reseller === null) return fail("reseller price must be a number (Rupiah, e.g. 70000 or 70.000)");
      }
      let warranty: number | null = null;
      if (warrantyDays) {
        if (!/^\d+$/.test(warrantyDays)) return fail("warranty days must be a whole number");
        warranty = Number(warrantyDays);
      }
      return {
        ...base,
        ok: true,
        data: {
          categoryId,
          productName: product,
          denominationName: denomination,
          type: typeUpper as ProductType,
          durationLabel,
          price: priceValue,
          costPrice: cost,
          resellerPrice: reseller,
          warrantyDays: warranty,
          description: descParts.join("|").trim() || null,
        },
      };
    });
}

/** Build a lowercase-name → id map for all categories. */
export async function categoryNameMap(db: Db): Promise<Map<string, number>> {
  const cats = await listAllCategories(db);
  return new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
}

/**
 * Find-or-create the mid-tier Product by name within a category (CSV import).
 * Takes the active `db` handle explicitly so callers running inside a
 * `prisma.$transaction(...)` pass the `tx` — a call against the outer
 * `prisma` client here would not see the transaction's uncommitted rows and
 * could hold a second connection while it waits.
 */
export async function resolveOrCreateProduct(db: Db, categoryId: number, name: string) {
  const existing = await db.product.findFirst({ where: { categoryId, name } });
  if (existing) return existing;
  return createCatalogProduct(db, { categoryId, name });
}
