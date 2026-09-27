import type { Decimal } from "@app/core/money";
import { formatCompactQty, formatCompactPrice } from "@app/core/compactFormat";
import type { UserPriceFormatter } from "./format";

/**
 * Concise denomination-picker button label: pulls a leading/embedded
 * quantity to the front, and collapses redundant product-name noise out of
 * the leftover descriptor (so "Bonds 1580" and the noisier "Arena Breakout
 * Bonds 1580" both become "1580 Bonds"). Genuine distinguishing text that
 * follows the quantity (a duration unit, a variant word, …) is always kept —
 * "Capcut Pro 1 Bulan" and "Capcut Pro 1 Tahun" collapse to "1 Bulan" and
 * "1 Tahun" respectively, never the same "1 Capcut Pro" for both. Safe/
 * idempotent on labels with no digits or whose digits already sit at
 * position 0 with no product-name text in the rest (e.g. "1 Month", "1
 * month preorder") — those round-trip unchanged.
 *
 * An Indonesian-style thousands separator is kept whole: "3.200" and
 * "10.000" are a single quantity token, not "3" + ".200" — the dot may sit
 * between digits but never at the token's end, so "1.5 Jam" still yields
 * "1.5 Jam". Comma is not treated as a separator (Digiflazz uses the dot).
 */
export function formatDenominationLabel(productName: string, rawLabel: string): string {
  const raw = rawLabel.trim();
  if (!raw) return raw;

  const match = raw.match(/\d(?:[\d.]*\d)?/);
  if (!match) {
    return collapseWhole(productName, raw) || raw;
  }

  const qty = match[0];
  const before = raw.slice(0, match.index).trim();
  const after = raw.slice((match.index ?? 0) + qty.length).trim();
  const descriptor = collapseDescriptor(productName, before, after);

  const body = descriptor ? `${qty} ${descriptor}` : qty;
  return appendDiamondSuffix(body);
}

/**
 * Combine the leading/trailing descriptor text found around the extracted
 * quantity into one collapsed descriptor.
 *
 * - No trailing text (`after` empty): the leading text is the ENTIRE
 *   descriptor, so it's safe to collapse the old way — if the product name
 *   appears anywhere in it, the whole thing becomes the bare product name,
 *   dropping redundant category-name noise ("Arena Breakout Bonds" → "Bonds").
 * - Trailing text present: it's genuine information that must never be
 *   discarded (a duration unit, a variant word, …). Only the product-name
 *   phrase itself is stripped out of the leading text; whatever legitimately
 *   distinct text is left (in `before`, and always all of `after`) survives.
 */
function collapseDescriptor(productName: string, before: string, after: string): string {
  if (!after) return collapseWhole(productName, before);
  const pn = productName.trim();
  if (!pn || !before) return [before, after].filter(Boolean).join(" ").trim();
  const re = new RegExp(`\\b${escapeRegExp(pn)}\\b`, "i");
  const strippedBefore = before.replace(re, "").trim();
  return [strippedBefore, after].filter(Boolean).join(" ").trim();
}

function collapseWhole(productName: string, text: string): string {
  const pn = productName.trim();
  if (!pn || !text) return text;
  const re = new RegExp(`\\b${escapeRegExp(pn)}\\b`, "i");
  return re.test(text) ? pn : text;
}

function appendDiamondSuffix(text: string): string {
  if (/💎\s*$/.test(text)) return text;
  return /\bdiamonds?\b/i.test(text) ? `${text} 💎` : text;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface GameTopUpDenomLike {
  qtyValue: number | null;
  qtyUnit: string | null;
  durationLabel: string;
  name: string;
}

/**
 * Compact "<qty> <unit> — <price>" denomination button label for Game Top Up
 * SKUs, optionally prefixed with the parent Product's gameVariantEmoji.
 * Falls back to the existing plain durationLabel||name whenever
 * qtyValue/qtyUnit is unset (non-Game-Top-Up denominations, or a Game Top Up
 * SKU an admin hasn't backfilled yet).
 */
export function gameTopUpDenomLabel(
  d: GameTopUpDenomLike,
  unitPrice: Decimal.Value,
  variantEmoji?: string | null,
  prices?: Pick<UserPriceFormatter, "compact">,
): string {
  if (d.qtyValue == null || !d.qtyUnit) return d.durationLabel || d.name;
  // `unitPrice` is canonical IDR; the formatter (the buyer's display
  // currency) converts it once. No formatter → the legacy compact Rupiah.
  const priceText = prices ? prices.compact(unitPrice) : formatCompactPrice(unitPrice);
  const label = `${formatCompactQty(d.qtyValue)} ${d.qtyUnit} — ${priceText}`;
  return variantEmoji ? `${variantEmoji} ${label}` : label;
}
