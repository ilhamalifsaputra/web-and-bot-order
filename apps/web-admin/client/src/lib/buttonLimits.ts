/**
 * The single source of the Telegram inline-keyboard label limits, shared by the order bot (which enforces them
 * in `apps/order-bot/src/util/canonicalPresenter.ts`) and the admin panel (which shows them next to the fields
 * whose text ends up on a button).
 *
 * Dependency-free and browser-safe on purpose. The admin client must not import `@app/core`
 * (scripts/check-frontend-boundaries.ts), so `apps/web-admin/client/src/lib/buttonLimits.ts` is a byte-identical
 * COPY of this file; `buttonLimits.test.ts` fails when the two differ. Edit this file, then copy it over.
 *
 * Telegram clients truncate a button by pixels, not characters: a full-width bold button shows roughly 28-34
 * characters on a phone (50+ on desktop). Widths below are conservative "cells": see `visualWidth`.
 */

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** A conservative cell estimate, not a guarantee about Telegram client pixels. Emoji and CJK count as 2. */
export function visualWidth(value: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(value)) {
    const cp = segment.codePointAt(0)!;
    width += /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) || cp >= 0x1100 && (
      cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7af || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xff01 && cp <= 0xff60 || cp >= 0x20000
    ) ? 2 : 1;
  }
  return width;
}

/**
 * Telegram button budget: conservative cells, and a byte cap that also bounds combining marks. A single-column
 * label is capped at 36 cells, with 32 as the soft target the shortening fallbacks aim for.
 */
export const MAX_LABEL_WIDTH = 36;
export const TARGET_LABEL_WIDTH = 32;
export const MAX_LABEL_BYTES = 64;
/**
 * Width limit (in cells) for pairing two buttons in one row. It was 24 and is now 18, so wide
 * labels, such as USD amounts with thousands separators like `5 💎 · $1,000,000.00`, stay one
 * per row on narrow phones instead of being squeezed side by side.
 */
export const NARROW_LABEL_WIDTH = 18;
/** Product buttons per catalog page, for every game. */
export const CATALOG_PAGE_SIZE = 20;
/**
 * The bot cuts a name with `truncLabel(name, LIST_LABEL_MAX_CHARS)` (string length, ends with "…") on the
 * search-result, popular-product and category-picker buttons (`apps/order-bot/src/keyboards/customer.ts`).
 */
export const LIST_LABEL_MAX_CHARS = 30;
/**
 * The Premium Apps plan picker (`denominationPickerKb`, two buttons per row, no width check) cuts a label with
 * `truncLabel(label, PLAN_LABEL_MAX_CHARS)` (string length, ends with "…"); `apps/order-bot/src/util/format.ts` reads
 * this constant. The admin budget for a plan label is NARROW_LABEL_WIDTH, the width at which two buttons still fit
 * side by side, not this hard cut.
 */
export const PLAN_LABEL_MAX_CHARS = 24;

// ---------------------------------------------------------------------------
// How many cells an admin-typed NAME may use, per kind of button.
// ---------------------------------------------------------------------------

/** " · " between the parts of a catalog label (`{name} · {price}`). */
export const SEPARATOR_CELLS = visualWidth(" · ");
/** "💎 " or any emoji plus its space, put in front of a category or variant name. */
export const EMOJI_PREFIX_CELLS = visualWidth("💎 ");
/**
 * The widest compact price that shares a Game Top-Up button with the name (`compactPrice` in
 * canonicalPresenter.ts). IDR: `formatCompactPrice` gives `Rp999K` (6) below one million and `Rp{n,nn}M`
 * above it, so `Rp99,99M` = 8 cells covers every SKU under Rp100 million. USD is shown exact (`$9,999.99`,
 * 9 cells, covers every SKU under $10,000).
 */
export const COMPACT_PRICE_CELLS = { IDR: 8, USD: 9 } as const;
/** The widest quantity beside a unit: `compactQuantity` prints a non-round value in full, so 7 digits (under 10 million). */
export const QUANTITY_CELLS = 7;

export type ButtonNameKind =
  /** Product name on a search-result or popular-product button (one per row). */
  | "productList"
  /** Category name on the category picker (two per row, optional emoji in front). */
  | "category"
  /** Product `gameVariant` on the variant picker (two per row, optional emoji in front). */
  | "gameVariant"
  /** Product `gameRegion` on the region picker (two per row). */
  | "gameRegion"
  /** Premium Apps plan name: `denominationPickerKb` (two per row, price and stock stay in the body). */
  | "denominationPlan"
  /** Game Top-Up SKU name when it is the label: `{name} · {price}` in the canonical picker (one per row). */
  | "denominationGame"
  /** Game Top-Up quantity unit: `{quantity} {unit} · {price}` in the canonical picker (one per row). */
  | "qtyUnit";

export interface ButtonNameBudgetOptions {
  /** Currency the price on the button is shown in. Omitted = the wider of the two (USD), so the budget is safe for either. */
  currency?: "IDR" | "USD";
  /** The name is shown after an emoji (category and variant buttons). */
  emoji?: boolean;
}

const priceCells = (currency?: "IDR" | "USD") => currency ? COMPACT_PRICE_CELLS[currency] : Math.max(COMPACT_PRICE_CELLS.IDR, COMPACT_PRICE_CELLS.USD);

/**
 * Cells a name may use so that the whole button still fits. Derivations:
 *  - productList: the bot truncates at LIST_LABEL_MAX_CHARS characters; a name of at most that many cells is also
 *    at most that many characters, so it is never cut (and 30 is under MAX_LABEL_WIDTH).
 *  - category / gameVariant / gameRegion / denominationPlan: two buttons share a row, which the repo allows only up to
 *    NARROW_LABEL_WIDTH cells; the emoji prefix, when there is one, comes out of that.
 *  - denominationGame: MAX_LABEL_WIDTH - SEPARATOR_CELLS - compact price.
 *  - qtyUnit: MAX_LABEL_WIDTH - QUANTITY_CELLS - 1 (space) - SEPARATOR_CELLS - compact price. A bonus ("1186+224")
 *    is not reserved: the presenter's fallback chain (icon, abbreviation) absorbs it.
 * Soft limits: the bot shortens or numbers anything longer, it is never an error.
 */
export function buttonNameBudget(kind: ButtonNameKind, options: ButtonNameBudgetOptions = {}): number {
  const emoji = options.emoji ? EMOJI_PREFIX_CELLS : 0;
  switch (kind) {
    case "productList": return LIST_LABEL_MAX_CHARS;
    case "category":
    case "gameVariant": return NARROW_LABEL_WIDTH - emoji;
    case "gameRegion":
    case "denominationPlan": return NARROW_LABEL_WIDTH;
    case "denominationGame": return MAX_LABEL_WIDTH - SEPARATOR_CELLS - priceCells(options.currency);
    case "qtyUnit": return MAX_LABEL_WIDTH - QUANTITY_CELLS - 1 - SEPARATOR_CELLS - priceCells(options.currency);
  }
}

/**
 * What the bot keeps of a Game Top-Up denomination name once it is on a button: the list header already names the
 * product, so the product's own name at the START of the name (whole token, case-insensitive, also written without
 * its trailing "(Region)") is dropped. Mirrors `cleanName` in `canonicalProduct.ts` (a test compares the two);
 * the bot's extra list of verified brand prefixes is not mirrored, so this can only OVER-measure, never under-measure.
 * The rest must start with a letter or digit and not be a bare number ("Delta Force 400" keeps its name), else the
 * whole name stays. Repeated whitespace is collapsed and the ends trimmed, as on the button.
 */
export function nameAfterProductPrefix(name: string, productName: string): string {
  const text = name.replace(/\s+/g, " ").trim();
  const product = productName.replace(/\s+/g, " ").trim();
  const candidates = [product, product.replace(/\s*\([^()]*\)\s*$/, "")].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    if (!text.toLowerCase().startsWith(`${candidate.toLowerCase()} `)) continue;
    const rest = text.slice(candidate.length).trim();
    if (rest && /^[\p{L}\p{N}]/u.test(rest) && !/^[\d.,]+$/.test(rest)) return rest;
  }
  return text;
}
