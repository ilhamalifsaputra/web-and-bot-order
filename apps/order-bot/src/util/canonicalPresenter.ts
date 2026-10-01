import type { CanonicalProduct, CanonicalMoney } from "@app/core/canonicalProduct";
import { Decimal } from "@app/core/money";
import { esc } from "@app/core/formatters";
import { formatCompactPrice } from "@app/core/compactFormat";
import { visualWidth, MAX_LABEL_WIDTH, TARGET_LABEL_WIDTH, NARROW_LABEL_WIDTH, MAX_LABEL_BYTES, CATALOG_PAGE_SIZE } from "@app/core/buttonLimits";
import { abbreviateText, displayUnit, hasRepeatedIcon, iconizeUnitOnce, sharedIconUnits } from "@app/core/unitDisplay";

export interface CatalogButton { text: string; callback_data: string }
export interface CatalogPage { text: string; rows: CatalogButton[][] }
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

// The limits live in one browser-safe module shared with the admin panel; re-exported so existing imports keep working.
export { visualWidth, MAX_LABEL_WIDTH, TARGET_LABEL_WIDTH, NARROW_LABEL_WIDTH, MAX_LABEL_BYTES, CATALOG_PAGE_SIZE };

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
/** The leading "quantity unit (+ bonus)" of an amount's full text ("" for any other variant). */
function fullHead(product: CanonicalProduct): string {
  const v = product.variant;
  if (v.type !== "amount") return "";
  const bonus = v.bonus ? ` + ${v.bonus.quantity} ${v.bonus.label ?? v.bonus.unit}` : "";
  return `${v.quantity} ${v.unit}${bonus}`;
}
function fullMain(product: CanonicalProduct, s: Shape, tails: string[] = []): string {
  if (product.variant.type !== "amount") return [s.main, ...s.leftover, ...tails].join(" ");
  return [fullHead(product), ...s.leftover, ...tails].join(" ");
}
/** Compact "quantity unit" of an amount, or null when compacting would hide meaning (a bonus in a different unit). */
function compactHead(product: CanonicalProduct, locale: string, spelled: Set<string>): string | null {
  const v = product.variant;
  if (v.type !== "amount") return null;
  if (v.bonus && !sameUnit(v.bonus.unit, v.unit)) return null;
  const unit = spelled.has(v.unit.toLowerCase()) ? v.unit : displayUnit(v.unit);
  const qty = `${compactQuantity(v.quantity, locale)}${v.bonus ? `+${compactQuantity(v.bonus.quantity, locale)}` : ""}`;
  return `${qty} ${unit}`;
}
const withQuals = (main: string, quals: string[]) => [collapse(main), ...quals].join(" · ");
const fits = (label: string, limit = MAX_LABEL_WIDTH) => visualWidth(label) <= limit && Buffer.byteLength(label, "utf8") <= MAX_LABEL_BYTES;

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

/** True when `name` begins and ends like the "lead…tail" cut `candidate`, i.e. the cut would read the same for it. */
function endsLike(name: string, candidate: string): boolean {
  const cut = candidate.indexOf("…");
  const lead = candidate.slice(0, cut);
  const tail = candidate.slice(cut + 1);
  return name.length >= lead.length + tail.length && name.startsWith(lead) && name.endsWith(tail);
}

/** True when a word (letters only, any case) or a dictionary icon occurs twice, or two dictionary icons sit side by side. */
function stutters(value: string): boolean {
  const seen = new Set<string>();
  for (const word of value.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 1)) {
    if (seen.has(word)) return true;
    seen.add(word);
  }
  return hasRepeatedIcon(value);
}

/**
 * The trailing spaced " - X" or "(X)" segment of `text` and what precedes it. X never holds a digit ("(x2)" is a
 * variant, not a qualifier) and a hyphen inside a word ("Super-Value") is never a separator.
 */
function trailingQualifier(text: string): { rest: string; key: string } | null {
  const match = text.match(/^(.*?)(?:^|\s)-\s+([^()-]+)$/) ?? text.match(/^(.*?)\s*\(([^()]+)\)$/);
  if (!match || /\d/.test(match[2]!)) return null;
  const key = tokenKey(match[2]!);
  return key ? { rest: collapse(match[1]!), key } : null;
}
/** `text` without its trailing qualifier segment when that qualifier is one of `keys` (the product's own or one shared by the list), else null. */
function withoutTrailingQualifier(text: string, keys: ReadonlySet<string>): string | null {
  const q = trailingQualifier(text);
  return q && keys.has(q.key) ? q.rest : null;
}
/** The amount's head with ITS OWN unit as the dictionary icon ("1000 💎 + 100 Bonds"), only for a head that spells the unit and a unit the list does not spell. */
function iconizedHead(product: CanonicalProduct, head: string, spelled: Set<string>): string | null {
  const v = product.variant;
  if (v.type !== "amount" || head !== fullHead(product) || spelled.has(v.unit.toLowerCase())) return null;
  const swapped = iconizeUnitOnce(head, v.unit);
  return swapped === head ? null : swapped;
}

type CutKind = "swap" | "qualifier" | "middle" | "tail";
/**
 * The fallback forms of `main`, in order, for a label that does not fit. An amount's head ("quantity unit") is kept whole.
 *  - swap: the name as is, the amount's own unit as its icon (`iconHead`, one unit, only when it is not spelled in this list), long words abbreviated;
 *  - qualifier: the same without a trailing "- Garena" / "(Global)" that is the product's own qualifier or one the list shares;
 *  - middle: the first words and the END behind one "…" ("Blessing of… Moon x2"), so the start that names the item survives;
 *  - tail: only the END behind one "…" (the end carries the number that tells siblings apart).
 * Icons replace nothing but the SKU's own unit; no other word of a name is ever turned into an icon.
 */
/** Words that carry meaning: a bare "-" or "&" does not count towards what a cut keeps. */
const meaningfulWords = (words: string[]) => words.filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
function* shorterNames(main: string, head: string, options: { iconHead: string | null; qualifierKeys: ReadonlySet<string> }): Generator<{ text: string; kind: CutKind; kept: number }> {
  const name = collapse(main);
  const body = collapse(name.slice(head.length));
  const joined = (lead: string, rest: string) => collapse(lead ? `${lead} ${rest}` : rest);
  const forms = (rest: string) => {
    const abbreviated = collapse(abbreviateText(rest));
    const heads = options.iconHead ? [head, options.iconHead] : [head];
    return [...heads.map((lead) => joined(lead, rest)), ...heads.map((lead) => joined(lead, abbreviated))];
  };
  const seen = new Set<string>();
  for (const text of forms(body)) if (!seen.has(text)) { seen.add(text); yield { text, kind: "swap", kept: Infinity }; }
  const dropped = withoutTrailingQualifier(body, options.qualifierKeys);
  if (dropped !== null) for (const text of forms(dropped)) if (!seen.has(text)) { seen.add(text); yield { text, kind: "qualifier", kept: Infinity }; }
  const prefix = options.iconHead ?? head;
  const lead = prefix ? `${prefix} ` : "";
  // Cuts start from the name without its droppable qualifier; if every such cut reads like a sibling, from the name with it.
  const cutBodies = (dropped !== null ? [dropped, body] : [body]).map((text) => collapse(abbreviateText(text)).split(" ").filter(Boolean));
  // Most words kept first; of equal size, the longest end. Names of more than 30 words go straight to the end cut.
  for (const words of cutBodies) {
    if (words.length < 3 || words.length > 30) continue;
    for (let kept = words.length - 1; kept >= 2; kept--) {
      for (let end = kept - 1; end >= 1; end--) {
        const first = words.slice(0, kept - end);
        const last = words.slice(words.length - end);
        yield { text: `${lead}${first.join(" ")}… ${last.join(" ")}`, kind: "middle", kept: meaningfulWords([...first, ...last]) };
      }
    }
  }
  for (const words of cutBodies) for (let drop = 1; drop < words.length; drop++) yield { text: `${lead}…${words.slice(drop).join(" ")}`, kind: "tail", kept: meaningfulWords(words.slice(drop)) };
  // One enormous last word: keep its end, never cutting inside a grapheme.
  const last = cutBodies[0]!.at(-1);
  if (last) {
    const parts = [...graphemes.segment(last)].map((part) => part.segment);
    for (let keep = parts.length - 1; keep >= 4; keep--) yield { text: `${lead}…${parts.slice(parts.length - keep).join("")}`, kind: "tail", kept: 1 };
  }
}

/**
 * Button labels, in order: compact (or full where compacting would hide
 * meaning) → full name on a collision → ` #id` suffix. A label that is then too
 * wide tries, while it still fits and stays distinct, the name without its
 * qualifiers, the amount's own unit as its icon, abbreviations, a trailing
 * qualifier dropped, the first words plus the END behind one "…", the END alone,
 * and only then the bare `#id` (see `shorterNames`). Anything shortened is
 * explained in the body. Collisions are re-checked after every step, so no two
 * final labels match.
 */
function catalogLabels(products: CanonicalProduct[], locale: string, sharedQuals: boolean): { text: string; fallback: boolean; complex: boolean }[] {
  const conflictingShorts = new Set(sharedIconUnits(products.flatMap((p) => p.variant.type === "amount" ? [p.variant.unit] : [])).map((group) => group.short));
  const spelled = new Set(products.flatMap((p) => p.variant.type === "amount" && conflictingShorts.has(displayUnit(p.variant.unit)) ? [p.variant.unit.toLowerCase()] : []));
  const shapes = shapesOf(products);
  const items = products.map((product, index) => {
    const s = shapes[index]!;
    const quals = sharedQuals ? [] : s.quals;
    const price = compactPrice(product, locale);
    const head = compactHead(product, locale, spelled);
    const compact = head === null ? null : [head, ...s.leftover].join(" ");
    // Identity = the label without its price. Price alone must never be what tells two SKUs apart.
    // The full form restores what lifting hid: the name's own "- Garena" tail, and not the same qualifier twice.
    const tails = s.lifted.map((l) => l.text);
    const fullQuals = quals.filter((q) => !s.lifted.some((l) => l.key === tokenKey(q)));
    const fullText = fullMain(product, s, tails);
    const fullIdentity = withQuals(fullText, fullQuals);
    const main = compact ?? fullMain(product, s);
    return {
      identity: withQuals(main, quals), fullIdentity, price, fallback: false,
      // What the shortening fallbacks start from: the identity's name part and the leading "quantity unit" they keep whole.
      main, mainHead: head ?? fullHead(product), fullText, fullHead: fullHead(product),
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
    if (new Set(fulls).size === group.length && !fulls.some((full) => others.has(full))) {
      group.forEach((index, i) => { Object.assign(items[index]!, { identity: fulls[i]!, main: items[index]!.fullText, mainHead: items[index]!.fullHead }); });
    } else for (const index of group) items[index]!.fallback = true;
  }
  const labels = items.map((item, index) => ({
    text: `${item.identity} · ${item.price}${item.fallback ? ` #${products[index]!.id}` : ""}`, fallback: item.fallback, complex: item.complex,
  }));
  const texts = () => labels.map((label) => label.text);
  const identityKey = (value: string) => collapse(value).toLowerCase();
  // A trailing "- Garena" / "(Global)" may be dropped from a button when it is the product's own qualifier or the list repeats it.
  const qualifierKeys = new Set(products.flatMap((p) => [p.product.gameRegion, p.product.gameVariant]).filter((q): q is string => !!q?.trim()).map(tokenKey));
  const trailing = new Map<string, number>();
  for (const item of items) {
    const q = trailingQualifier(collapse(item.main.slice(item.mainHead.length)));
    if (q) trailing.set(q.key, (trailing.get(q.key) ?? 0) + 1);
  }
  for (const [key, count] of trailing) if (count >= 2) qualifierKeys.add(key);
  labels.forEach((label, index) => {
    // Width alone misses thousands of combining marks in one visual cell, so bytes are bounded too.
    if (fits(label.text)) return;
    const item = items[index]!;
    const suffix = item.fallback ? ` #${products[index]!.id}` : "";
    const candidates = [...shorterNames(item.main, item.mainHead, { iconHead: iconizedHead(products[index]!, item.mainHead, spelled), qualifierKeys })];
    // A name that already doubles an icon on its own may keep doing so; no step may add that.
    const nameStutters = hasRepeatedIcon(collapse(item.main));
    // Substitutions and a dropped qualifier first (any that fits the cap), then cuts: the first words plus the end, then the end alone.
    // Cuts aim for the soft target and avoid a stutter ("…Crystals Bundle 8.000 Crystals" repeats a word), each relaxed only when nothing else fits.
    const passes: { kinds: CutKind[]; limit: number; strict: boolean }[] = [
      { kinds: ["swap", "qualifier"], limit: MAX_LABEL_WIDTH, strict: false },
      { kinds: ["middle"], limit: TARGET_LABEL_WIDTH, strict: true }, { kinds: ["middle"], limit: MAX_LABEL_WIDTH, strict: true },
      { kinds: ["tail"], limit: TARGET_LABEL_WIDTH, strict: true }, { kinds: ["tail"], limit: MAX_LABEL_WIDTH, strict: true },
      { kinds: ["middle"], limit: TARGET_LABEL_WIDTH, strict: false }, { kinds: ["middle"], limit: MAX_LABEL_WIDTH, strict: false },
      { kinds: ["tail"], limit: TARGET_LABEL_WIDTH, strict: false }, { kinds: ["tail"], limit: MAX_LABEL_WIDTH, strict: false },
    ];
    for (const pass of passes) for (const { text: candidate, kind, kept } of candidates) {
      // Strict cuts also keep enough words (two after an end-only ellipsis, three around a middle one): a lone word is a worse label than a cut that repeats one.
      if (!pass.kinds.includes(kind) || (!nameStutters && hasRepeatedIcon(candidate))) continue;
      if (pass.strict && (stutters(candidate) || kept < (kind === "middle" ? 3 : 2))) continue;
      const text = `${candidate} · ${item.price}${suffix}`;
      if (!fits(text, pass.limit)) continue;
      // A suffixed (colliding) item is told apart by its ID; any other must not equal another item's identity.
      if (!item.fallback && items.some((other, otherIndex) => otherIndex !== index && identityKey(other.identity) === identityKey(candidate))) continue;
      // A cut that another SKU's name also ends with does not tell the two apart (only the dropped beginning does).
      if (!item.fallback && candidate.includes("…") && items.some((other, otherIndex) => otherIndex !== index && endsLike(collapse(other.main), candidate))) continue;
      // Qualifiers, or part of the name, were dropped: the body explains this item in full.
      Object.assign(label, { text, complex: true });
      item.identity = candidate;
      return;
    }
    Object.assign(label, { text: `#${products[index]!.id}`, fallback: true });
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
