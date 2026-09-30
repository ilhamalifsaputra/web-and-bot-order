import type { CanonicalProduct, CanonicalMoney } from "@app/core/canonicalProduct";
import { Decimal } from "@app/core/money";
import { esc } from "@app/core/formatters";
import { formatCompactPrice } from "@app/core/compactFormat";

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

/** No quantity rounding. Decimal division retains every significant digit. */
export function compactQuantity(value: number, locale = "en"): string {
  if (value < 1000) return String(value);
  const divisor = value >= 1000000 ? 1000000 : 1000;
  const digits = new Decimal(value).div(divisor).toFixed();
  return `${locale.startsWith("id") ? digits.replace(".", ",") : digits}${divisor === 1000000 ? "M" : "K"}`;
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
export function canonicalName(product: CanonicalProduct): string {
  return [product.displayName, ...product.qualifiers].join(" · ");
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
function compactName(product: CanonicalProduct, locale: string): string {
  const variant = product.variant;
  if (variant.type !== "amount") return canonicalName(product);
  const name = `${compactQuantity(variant.quantity, locale)} ${variant.unit}${variant.bonus ? ` + ${compactQuantity(variant.bonus.quantity, locale)} ${variant.bonus.label ?? variant.bonus.unit}` : ""}`;
  return [name, ...variant.residual, ...product.qualifiers].join(" ");
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

/** Final labels resolve collisions before measuring; body always supplies exact full meaning. */
export function presentCanonicalCatalog(products: CanonicalProduct[], context: { locale?: string; intro?: string; stockLabels?: Record<number, string>; bodyName?: string } = {}): { pages: CatalogPage[] } {
  const locale = context.locale ?? "id";
  const candidates = products.map((p) => `${compactName(p, locale)} · ${compactPrice(p, locale)}`);
  const counts = new Map<string, number>();
  for (const label of candidates) counts.set(label, (counts.get(label) ?? 0) + 1);
  const entries = products.map((product, index) => {
    let label = candidates[index]!;
    if (counts.get(label)! > 1) label += ` #${product.id}`;
    // Width alone misses thousands of combining marks in one visual cell.
    // Keep the serialized button label conservatively bounded to 64 UTF-8 bytes.
    const fallback = visualWidth(label) > 44 || Buffer.byteLength(label, "utf8") > 64;
    if (fallback) label = `#${product.id}`;
    const callback_data = `v1:browse:denom:${product.id}`;
    if (Buffer.byteLength(callback_data, "utf8") > 64) throw new Error("Catalog callback exceeds Telegram byte limit");
    return { product, button: { text: label, callback_data }, narrow: !fallback && product.variant.type !== "unknown" && visualWidth(label) <= 24 };
  });
  const pages: CatalogPage[] = [];
  let page: CatalogPage = { text: "", rows: [] };
  let priorNarrow = false;
  const flush = () => { if (page.text || page.rows.length) pages.push(page); page = { text: "", rows: [] }; priorNarrow = false; };
  if (context.intro) {
    const chunks = escapedChunks(context.intro, 2800);
    for (let i = 0; i < chunks.length; i++) { page.text = chunks[i]! + "\n\n"; if (i < chunks.length - 1) flush(); }
  }
  for (const entry of entries) {
    const stock = context.stockLabels?.[entry.product.id];
    const prefix = `#${entry.product.id} · ${esc(entry.product.formattedPrice)}${stock !== undefined ? ` (${locale.startsWith("id") ? "Stok" : "Stock"} ${esc(stock)})` : ""}\n`;
    const chunks = escapedChunks(context.bodyName ?? canonicalName(entry.product), 2800 - prefix.length);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const block = `${prefix}${chunks[chunkIndex]}\n\n`;
      if (page.text.length + block.length > 3000 || page.rows.flat().length >= 20) flush();
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
