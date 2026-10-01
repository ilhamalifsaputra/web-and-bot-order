import type { CanonicalProduct, CanonicalMoney } from "@app/core/canonicalProduct";
import { Decimal } from "@app/core/money";
import { esc } from "@app/core/formatters";
import { formatCompactPrice } from "@app/core/compactFormat";
import { displayUnit, sharedIconUnits } from "@app/core/unitDisplay";

export interface CatalogButton { text: string; callback_data: string }
export interface CatalogPage { text: string; rows: CatalogButton[][] }
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** A conservative cell estimate, not a guarantee about Telegram client pixels. */
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
 * Quantities are never rounded. Full digits are shown unless the value is a clean multiple of 1000
 * from 10000 up: then thousands ("10K", "1234K"), or millions with at most one decimal when it is a
 * multiple of 100000 ("1,5M" for Indonesian). "1,186K" would read as 1.186 million to an English reader.
 */
export function compactQuantity(value: number, locale = "en"): string {
  if (!Number.isInteger(value) || value < 10000 || value % 1000 !== 0) return String(value);
  if (value >= 1000000 && value % 100000 === 0) {
    const digits = new Decimal(value).div(1000000).toFixed();
    return `${locale.startsWith("id") ? digits.replace(".", ",") : digits}M`;
  }
  return `${value / 1000}K`;
}

function major(money: CanonicalMoney): Decimal {
  return new Decimal(money.amountMinor).div(new Decimal(10).pow(money.scale));
}
function compactPrice(product: CanonicalProduct, locale: string): string {
  if (product.displayPrice.currency === "USD") return product.formattedPrice;
  if (major(product.displayPrice).lt(1000)) return product.formattedPrice;
  const formatted = formatCompactPrice(major(product.displayPrice));
  return locale.startsWith("id") ? formatted.replace(".", ",") : formatted;
}
/** Repeated supplier whitespace ("Redefine  - Garena") is collapsed for display only; stored names keep it. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
export function canonicalName(product: CanonicalProduct): string {
  // Only Game Top-Up is tidied; every other group (Premium Apps, unclassified) keeps its name exactly as before.
  const name = product.category.group === "GAME_TOPUP" ? collapse(product.displayName) : product.displayName;
  return [name, ...product.qualifiers].join(" · ");
}

/** Oversized names are delivered in full before the interactive summary references their ID. */
export async function boundedCanonicalName(product: CanonicalProduct, send: (html: string) => Promise<unknown>, options: { includeProductName?: boolean } = {}): Promise<string> {
  const name = options.includeProductName && product.product.name !== product.displayName
    ? `${product.product.name} · ${canonicalName(product)}`
    : canonicalName(product);
  if (esc(name).length <= 1200) return name;
  for (const page of presentCanonicalCatalog([product], { bodyName: name }).pages) await send(page.text);
  return `#${product.id}`;
}
/** Telegram button budget: conservative cells, and a byte cap that also bounds combining marks. */
export const MAX_LABEL_WIDTH = 44;
export const MAX_LABEL_BYTES = 64;
/**
 * Width limit (in cells) for pairing two buttons in one row. It was 24 and is now 18, so wide
 * labels, such as USD amounts with thousands separators like `5 💎 · $1,000,000.00`, stay one
 * per row on narrow phones instead of being squeezed side by side.
 */
export const NARROW_LABEL_WIDTH = 18;
/** Product buttons per catalog page, for every game. */
export const CATALOG_PAGE_SIZE = 20;
const PAGE_TEXT_LIMIT = 3000;
const MAX_SHARED_LINE = 300;

/** Lowercased whole tokens; brackets, dashes and repeated whitespace are separators. */
const tokenKey = (value: string): string => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");

/** A product's name split into what the button needs and the qualifiers that may be stated once for the list. */
interface Shape {
  /** Non-amount name without a trailing qualifier segment listed in `quals` ("" for amounts). */
  main: string;
  /** Free text the parser could not place (shown on the button, explained in the body). */
  leftover: string[];
  /** Product-level region/variant this item carries, whether still in `qualifiers` or spelled in its own name. */
  quals: string[];
  /** True when the name ends in a supplier-style spaced " - X" segment (no digit in X) that is not one of the product's own qualifiers. */
  conflict: boolean;
  /** Product qualifiers this name spelled itself ("- Garena", "(Global)") and that were lifted into `quals`, with the spelled text. */
  lifted: { key: string; text: string }[];
}
/** The X of a trailing spaced hyphen segment ("... - Tencent"); parentheses, intra-word hyphens and digits never count. */
function spacedHyphenTail(text: string): string | null {
  const match = text.match(/(?:^|\s)-\s+([^-]*)$/);
  return match && !/\d/.test(match[1]!) ? match[1]! : null;
}
/** `keep`: qualifier keys that must stay spelled on the item's own label instead of being lifted (see `shapesOf`). */
function shape(product: CanonicalProduct, keep: ReadonlySet<string> = new Set()): Shape {
  const known = [product.product.gameRegion, product.product.gameVariant].filter((value): value is string => !!value?.trim());
  const qualifierFor = (segment: string) => known.find((q) => tokenKey(q) !== "" && tokenKey(q) === tokenKey(segment) && !keep.has(tokenKey(q)));
  const lifted: Shape["lifted"] = [];
  const quals = [...product.qualifiers];
  const addQual = (q: string) => { if (!quals.some((have) => tokenKey(have) === tokenKey(q))) quals.push(q); };
  const variant = product.variant;
  if (variant.type === "amount") {
    const leftover: string[] = [];
    let conflict = false;
    for (const segment of variant.residual) {
      const q = qualifierFor(segment);
      if (q) { addQual(q); lifted.push({ key: tokenKey(q), text: collapse(segment) }); }
      else {
        leftover.push(collapse(segment));
        if (spacedHyphenTail(segment) !== null) conflict = true;
      }
    }
    return { main: "", leftover, quals, conflict, lifted };
  }
  let main = collapse(variant.name);
  // Only a trailing "- Garena" / "(Global)" segment that equals a known qualifier is lifted; inner words stay.
  const tail = main.match(/^(.+?)\s*(?:-\s*([^()\-]+)|\(([^()]+)\))$/);
  const q = tail ? qualifierFor(tail[2] ?? tail[3]!) : undefined;
  if (tail && q) { lifted.push({ key: tokenKey(q), text: main.slice(tail[1]!.length).trim() }); main = tail[1]!; addQual(q); }
  const hyphenTail = spacedHyphenTail(collapse(variant.name));
  return { main, leftover: variant.residual.map(collapse), quals, conflict: hyphenTail !== null && !(q && tail && tail[2] !== undefined), lifted };
}
/**
 * Shapes for one list. A qualifier that some items spell themselves and others merely inherit from the
 * product is "mixed": it cannot be stated once for everybody, so the spelling items keep it on their own
 * label (and the others carry the product qualifier) instead of both collapsing into the same text.
 */
function shapesOf(products: CanonicalProduct[]): Shape[] {
  const first = products.map((p) => shape(p));
  const mixed = new Set<string>();
  for (const s of first) for (const { key } of s.lifted) {
    if (first.some((other) => other.quals.some((q) => tokenKey(q) === key) && !other.lifted.some((l) => l.key === key))) mixed.add(key);
  }
  return mixed.size === 0 ? first : products.map((p, i) => first[i]!.lifted.some((l) => mixed.has(l.key)) ? shape(p, mixed) : first[i]!);
}

const sameUnit = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function fullMain(product: CanonicalProduct, s: Shape, tails: string[] = []): string {
  const v = product.variant;
  if (v.type !== "amount") return [s.main, ...s.leftover, ...tails].join(" ");
  const bonus = v.bonus ? ` + ${v.bonus.quantity} ${v.bonus.label ?? v.bonus.unit}` : "";
  return [`${v.quantity} ${v.unit}${bonus}`, ...s.leftover, ...tails].join(" ");
}
/** Compact amount text, or null when compacting would hide meaning (a bonus in a different unit). */
function compactMain(product: CanonicalProduct, s: Shape, locale: string, spelled: Set<string>): string | null {
  const v = product.variant;
  if (v.type !== "amount") return null;
  if (v.bonus && !sameUnit(v.bonus.unit, v.unit)) return null;
  const unit = spelled.has(v.unit.toLowerCase()) ? v.unit : displayUnit(v.unit);
  const qty = `${compactQuantity(v.quantity, locale)}${v.bonus ? `+${compactQuantity(v.bonus.quantity, locale)}` : ""}`;
  return [`${qty} ${unit}`, ...s.leftover].join(" ");
}
const withQuals = (main: string, quals: string[]) => [collapse(main), ...quals].join(" · ");
const fits = (label: string) => visualWidth(label) <= MAX_LABEL_WIDTH && Buffer.byteLength(label, "utf8") <= MAX_LABEL_BYTES;

function duplicates(labels: string[]): number[][] {
  const groups = new Map<string, number[]>();
  labels.forEach((label, index) => groups.set(label, [...(groups.get(label) ?? []), index]));
  return [...groups.values()].filter((group) => group.length > 1);
}

/** Split escaped text only at grapheme boundaries, so no HTML entity or emoji is cut. */
function escapedChunks(value: string, limit: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  const append = (escaped: string) => {
    if (chunk.length + escaped.length > limit && chunk) { chunks.push(chunk); chunk = ""; }
    chunk += escaped;
  };
  for (const { segment } of graphemes.segment(value)) {
    const escaped = esc(segment);
    if (escaped.length <= limit) append(escaped);
    // One combining grapheme can exceed a whole Telegram message. Split only
    // that exceptional segment by code point; escaping each keeps entities and
    // surrogate pairs intact while every chunk stays within the budget.
    else for (const codePoint of segment) append(esc(codePoint));
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/**
 * Button labels, in order: compact (or full where compacting would hide
 * meaning) → full name on a collision → ` #id` suffix → `#id` when too wide.
 * Collisions are re-checked after every step, so no two final labels match.
 */
function catalogLabels(products: CanonicalProduct[], locale: string, sharedQuals: boolean): { text: string; fallback: boolean; complex: boolean }[] {
  const conflictingShorts = new Set(sharedIconUnits(products.flatMap((p) => p.variant.type === "amount" ? [p.variant.unit] : [])).map((group) => group.short));
  const spelled = new Set(products.flatMap((p) => p.variant.type === "amount" && conflictingShorts.has(displayUnit(p.variant.unit)) ? [p.variant.unit.toLowerCase()] : []));
  const shapes = shapesOf(products);
  const items = products.map((product, index) => {
    const s = shapes[index]!;
    const quals = sharedQuals ? [] : s.quals;
    const price = compactPrice(product, locale);
    const compact = compactMain(product, s, locale, spelled);
    // Identity = the label without its price. Price alone must never be what tells two SKUs apart.
    // The full form restores what lifting hid: the name's own "- Garena" tail, and not the same qualifier twice.
    const tails = s.lifted.map((l) => l.text);
    const fullQuals = quals.filter((q) => !s.lifted.some((l) => l.key === tokenKey(q)));
    const fullIdentity = withQuals(fullMain(product, s, tails), fullQuals);
    const identity = compact === null ? withQuals(fullMain(product, s), quals) : withQuals(compact, quals);
    return {
      identity, fullIdentity, price, fallback: false,
      complex: product.variant.type === "unknown" || (product.variant.type === "amount" && compact === null) || s.leftover.length > 0,
    };
  });
  // Same identity (whatever the price, rounded or not) is a collision: try the
  // full form, which shows what compacting hid; otherwise suffix the ID and
  // explain both in the body.
  const identities = () => items.map((item) => item.identity);
  for (const group of duplicates(identities())) {
    const fulls = group.map((index) => items[index]!.fullIdentity);
    const others = new Set(identities().filter((_, index) => !group.includes(index)));
    if (new Set(fulls).size === group.length && !fulls.some((full) => others.has(full))) group.forEach((index, i) => { items[index]!.identity = fulls[i]!; });
    else for (const index of group) items[index]!.fallback = true;
  }
  const labels = items.map((item, index) => ({
    text: `${item.identity} · ${item.price}${item.fallback ? ` #${products[index]!.id}` : ""}`, fallback: item.fallback, complex: item.complex,
  }));
  const texts = () => labels.map((label) => label.text);
  labels.forEach((label, index) => {
    // Width alone misses thousands of combining marks in one visual cell, so bytes are bounded too.
    if (!fits(label.text)) Object.assign(label, { text: `#${products[index]!.id}`, fallback: true });
  });
  // IDs are unique, so turning every remaining duplicate into its bare ID terminates.
  for (let group = duplicates(texts()); group.length; group = duplicates(texts())) {
    for (const index of group.flat()) Object.assign(labels[index]!, { text: `#${products[index]!.id}`, fallback: true });
  }
  return labels;
}

/**
 * What the list header may state once. `quals` is the region/variant shared by every product, or [] when
 * the group does not verifiably share it (they then stay on the buttons); `name` is the product's name
 * when all products are one product.
 */
function sharedHeader(products: CanonicalProduct[]): { name: string | null; quals: string[] } {
  if (products.length === 0) return { name: null, quals: [] };
  const shapes = shapesOf(products);
  const keyOf = (quals: string[]) => quals.map(tokenKey).sort().join("|");
  const first = shapes[0]!.quals;
  const shared = first.length > 0 && !shapes.some((s) => s.conflict || keyOf(s.quals) !== keyOf(first));
  const names = new Set(products.map((p) => p.product.name));
  return { name: names.size === 1 ? products[0]!.product.name : null, quals: shared ? first : [] };
}
/** `Product · Region · Variant` (either part may be absent), escaped, or "" when empty or too long for a header. */
function headerLine(parts: (string | null)[]): string {
  const line = esc(parts.filter((part): part is string => !!part).join(" · "));
  return line && line.length <= MAX_SHARED_LINE ? `${line}

` : "";
}

/**
 * Body: intro, the shared qualifier line, then name + exact price only for the
 * page's items whose button cannot carry their meaning (ID fallback, unknown or
 * unparsed text, stock). Items already clear on their button are not repeated.
 */
export function presentCanonicalCatalog(products: CanonicalProduct[], context: { locale?: string; intro?: string; stockLabels?: Record<number, string>; bodyName?: string } = {}): { pages: CatalogPage[] } {
  const locale = context.locale ?? "id";
  const shared = context.bodyName === undefined ? sharedHeader(products) : { name: null, quals: [] };
  const sharedQuals = shared.quals.length > 0 && headerLine(shared.quals) !== "";
  const quals = sharedQuals ? shared.quals : [];
  // Page 1 skips the product name when the intro title already has it; later pages always carry it, so they are never blank.
  const introNamesProduct = !!context.intro && !!shared.name && context.intro.toLowerCase().includes(shared.name.toLowerCase());
  const firstHeader = headerLine([introNamesProduct ? null : shared.name, ...quals]);
  const laterHeader = headerLine([shared.name, ...quals]) || headerLine(quals);
  const labels = catalogLabels(products, locale, sharedQuals);
  const entries = products.map((product, index) => {
    const label = labels[index]!;
    const callback_data = `v1:browse:denom:${product.id}`;
    if (Buffer.byteLength(callback_data, "utf8") > MAX_LABEL_BYTES) throw new Error("Catalog callback exceeds Telegram byte limit");
    const stock = context.stockLabels?.[product.id];
    return {
      product, stock, button: { text: label.text, callback_data },
      explain: label.fallback || label.complex || stock !== undefined || context.bodyName !== undefined,
      narrow: !label.fallback && product.variant.type !== "unknown" && visualWidth(label.text) <= NARROW_LABEL_WIDTH,
    };
  });
  const pages: CatalogPage[] = [];
  let page: CatalogPage = { text: "", rows: [] };
  let hasHeader = false;
  let priorNarrow = false;
  const flush = () => { if (page.text || page.rows.length) pages.push(page); page = { text: "", rows: [] }; hasHeader = false; priorNarrow = false; };
  if (context.intro) {
    const chunks = escapedChunks(context.intro, 2800);
    for (let i = 0; i < chunks.length; i++) { page.text = chunks[i]! + "\n\n"; if (i < chunks.length - 1) flush(); }
  }
  for (const entry of entries) {
    const prefix = `#${entry.product.id} · ${esc(entry.product.formattedPrice)}${entry.stock !== undefined ? ` (${locale.startsWith("id") ? "Stok" : "Stock"} ${esc(entry.stock)})` : ""}\n`;
    const chunks = entry.explain ? escapedChunks(context.bodyName ?? canonicalName(entry.product), 2800 - prefix.length - Math.max(firstHeader.length, laterHeader.length)) : [""];
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const block = entry.explain ? `${prefix}${chunks[chunkIndex]}\n\n` : "";
      // Budget for the longer header: the flush below may move this block onto a page with the other one.
      const needed = (hasHeader ? 0 : Math.max(firstHeader.length, laterHeader.length)) + block.length;
      if (page.text.length + needed > PAGE_TEXT_LIMIT || page.rows.flat().length >= CATALOG_PAGE_SIZE) flush();
      // Each page repeats the product (and shared qualifier) so a later page still says what it lists.
      if (!hasHeader) { page.text += pages.length === 0 ? firstHeader : laterHeader; hasHeader = true; }
      page.text += block;
      const last = page.rows.at(-1);
      if (chunkIndex === 0 && priorNarrow && entry.narrow && last?.length === 1) last.push(entry.button);
      else page.rows.push([entry.button]);
      priorNarrow = chunks.length === 1 && entry.narrow && page.rows.at(-1)!.length === 1;
      if (chunks.length > 1) flush();
    }
  }
  flush();
  return { pages: pages.length ? pages : [{ text: "", rows: [] }] };
}
