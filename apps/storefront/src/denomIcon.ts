/**
 * Per-PRODUCT currency-icon resolution (Fase 12, mirrors images.ts's
 * `defaultThumbKind` resolution shape for a different field). Every
 * denomination under one product shares the same in-game currency, so this
 * is resolved ONCE per product (see pageData.ts's `productPageData`) and
 * passed down as a prop to every `DenominationCard` rendered for it, not
 * stored per-SKU.
 *
 * Priority order:
 *   1. category.group === "PREMIUM_APPS" -> always null (no chip ever
 *      renders for premium apps, full stop — not overridable even over a
 *      stale admin override that predates a category's reclassification).
 *   2. product.currencyIconKind, when it's a non-null recognized value —
 *      admin override wins.
 *   3. A heuristic keyed on the cheapest/first active denomination's
 *      `qtyUnit` (case-insensitive, word-boundary-anchored match — an
 *      unanchored 2-char needle like "uc" would fire inside "voucher"),
 *      then the category group, else null (better to show nothing than
 *      guess wrong).
 */
import { CategoryGroup } from "@app/core/enums";

export type DenomIconKind = "diamond" | "coin" | "key" | "card" | "voucher";

const RECOGNIZED_DENOM_ICON_KINDS: ReadonlySet<string> = new Set<DenomIconKind>([
  "diamond",
  "coin",
  "key",
  "card",
  "voucher",
]);

function isDenomIconKind(value: string | null | undefined): value is DenomIconKind {
  return value != null && RECOGNIZED_DENOM_ICON_KINDS.has(value);
}

/** `qtyUnit` pattern -> heuristic DenomIconKind. Order matters: the first
 * pattern that matches `qtyUnit` wins. Every pattern is `\b`-anchored and
 * case-insensitive so a short needle can't fire inside an unrelated word —
 * `"voucher"` contains `"uc"`, `"scpay"` contains `"cp"`. A leading `\b` with
 * no trailing one still matches a plural ("Diamonds" -> `\bdiamond`). */
const QTY_UNIT_KINDS: Array<[pattern: RegExp, kind: DenomIconKind]> = [
  [/\b(?:voucher|gift|card|coupon)\b/i, "voucher"],
  [/\b(?:key|code)\b/i, "key"],
  [/\bdiamond/i, "diamond"],
  [/\buc\b/i, "coin"],
  [/\bcp\b/i, "coin"],
  [/\bcoin/i, "coin"],
  [/\bgold/i, "coin"],
  [/\bpoint/i, "coin"],
];

export function resolveDenomIconKind(
  product: { currencyIconKind?: string | null },
  category: { group: string | null } | null | undefined,
  cheapestQtyUnit: string | null | undefined,
): DenomIconKind | null {
  if (category?.group === CategoryGroup.PREMIUM_APPS) return null;
  if (isDenomIconKind(product.currencyIconKind)) return product.currencyIconKind;

  const unit = cheapestQtyUnit ?? "";
  for (const [pattern, kind] of QTY_UNIT_KINDS) {
    if (pattern.test(unit)) return kind;
  }
  if (category?.group === CategoryGroup.GAME_TOPUP) return "diamond";
  return null;
}
