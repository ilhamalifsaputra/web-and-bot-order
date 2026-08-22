import type { Decimal } from "@app/core/money";
import { formatCompactQty, formatCompactPrice } from "@app/core/compactFormat";

/**
 * Concise denomination-picker button label: pulls a leading/embedded
 * quantity to the front, and collapses any leftover descriptor down to the
 * product's own canonical name when that's genuinely all the leftover text
 * says (so "Bonds 1580" and the noisier "Arena Breakout Bonds 1580" both
 * become "1580 Bonds"). Safe/idempotent on labels with no digits or whose
 * digits already sit at position 0 with no product-name text in the rest
 * (e.g. "1 Month", "1 month preorder") — those round-trip unchanged.
 */
export function formatDenominationLabel(productName: string, rawLabel: string): string {
  const raw = rawLabel.trim();
  if (!raw) return raw;

  const match = raw.match(/\d+/);
  if (!match) {
    return collapseDescriptor(productName, raw) || raw;
  }

  const qty = match[0];
  const before = raw.slice(0, match.index).trim();
  const after = raw.slice((match.index ?? 0) + qty.length).trim();
  const descriptor = collapseDescriptor(productName, [before, after].filter(Boolean).join(" ").trim());

  const body = descriptor ? `${qty} ${descriptor}` : qty;
  return appendDiamondSuffix(body);
}

function collapseDescriptor(productName: string, text: string): string {
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
): string {
  if (d.qtyValue == null || !d.qtyUnit) return d.durationLabel || d.name;
  const label = `${formatCompactQty(d.qtyValue)} ${d.qtyUnit} — ${formatCompactPrice(unitPrice)}`;
  return variantEmoji ? `${variantEmoji} ${label}` : label;
}
