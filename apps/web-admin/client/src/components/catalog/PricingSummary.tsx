import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Decimal } from "decimal.js";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { formatCurrencyDisplay } from "../shared/CurrencyAmount.helpers";

export interface CatalogPricingInfo {
  /** The admin may pick Auto/Manual on the edit form (Game Top Up only). */
  automaticAvailable: boolean;
  /** The sync / Apply now price this SKU from the rules (any category). */
  automaticPricing: boolean;
  source: "manual_sku" | "manual_no_cost" | "category_rule" | "global_default";
  calculatedPrice: string | null;
  effectivePrice: string;
  costPrice: string | null;
  grossProfit: string | null;
  grossMarginPct: string | null;
  warnings: string[];
  pendingReprice: boolean;
}
// manual_no_cost: automatic, but no HPP yet — the next sync fills it and prices the SKU.
const SOURCES = { manual_sku: "Manual", manual_no_cost: "Menunggu HPP", category_rule: "Category", global_default: "Global" };
export function PricingSourceBadge({ pricing }: { pricing: CatalogPricingInfo }) {
  return <Badge variant="secondary">{SOURCES[pricing.source]}</Badge>;
}
export function PricingMargin({ pricing, className = "text-xs" }: { pricing: CatalogPricingInfo; className?: string }) {
  const negative = pricing.grossMarginPct !== null && new Decimal(pricing.grossMarginPct).isNegative();
  return <span className={cn("tabular-nums", negative ? "text-rust" : "text-ink-soft", className)}>{pricing.costPrice === null ? "HPP belum tersedia" : pricing.grossMarginPct === null ? "—" : `${new Decimal(pricing.grossMarginPct).toDecimalPlaces(2).toString()}%`}</span>;
}
/** Errors (destructive, AlertCircle) vs the low-margin warning (amber, AlertTriangle):
 * told apart by icon and title text, not colour alone. */
const WARNINGS: Record<string, { tone: "error" | "warning"; title: string; text: string }> = {
  below_cost: { tone: "error", title: "Di bawah HPP", text: "Harga jual berada di bawah HPP." },
  unreadable_policy: { tone: "error", title: "Kebijakan harga tidak terbaca", text: "Periksa Pricing & Margins." },
  low_margin: { tone: "warning", title: "Margin rendah", text: "Margin berada di bawah batas peringatan." },
};
function PricingWarning({ code }: { code: string }) {
  const w = WARNINGS[code]!;
  if (w.tone === "error") {
    // Filled rust tint + border so the error reads stronger than the amber warning (review M1).
    return <Alert variant="destructive" className="border-rust/40 bg-rust-tint"><AlertCircle aria-hidden="true" /><AlertTitle>{w.title}</AlertTitle><AlertDescription>{w.text}</AlertDescription></Alert>;
  }
  // A standing state of the SKU, not an event: role="status" (same pattern as OrderDetailPage's amber notice).
  return <Alert role="status" className="border-amberx/40 bg-amberx-tint text-ink"><AlertTriangle className="text-amberx" aria-hidden="true" /><AlertTitle>{w.title}</AlertTitle><AlertDescription className="text-ink">{w.text}</AlertDescription></Alert>;
}
/** Known warnings, errors first; low_margin is dropped next to below_cost
 * (a negative margin is always below the threshold, so it adds nothing). */
function shownWarnings(codes: string[]): string[] {
  const known = codes.filter(w => WARNINGS[w] && !(w === "low_margin" && codes.includes("below_cost")));
  return [...known.filter(w => WARNINGS[w]!.tone === "error"), ...known.filter(w => WARNINGS[w]!.tone !== "error")];
}
export function PricingSummary({ pricing }: { pricing: CatalogPricingInfo }) {
  return <section aria-label="Ringkasan harga" className="space-y-3 border-t border-line pt-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs text-ink-soft">Harga jual aktif</p><p className="text-xl font-semibold tabular-nums">{formatCurrencyDisplay(pricing.effectivePrice, "IDR")}</p></div><PricingSourceBadge pricing={pricing} /></div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-ink-soft">
      <dt>HPP</dt><dd className="text-right tabular-nums">{pricing.costPrice === null ? "HPP belum tersedia" : formatCurrencyDisplay(pricing.costPrice, "IDR")}</dd>
      {pricing.automaticPricing && <><dt>Harga hasil aturan</dt><dd className="text-right tabular-nums">{pricing.calculatedPrice === null ? "Belum tersedia" : formatCurrencyDisplay(pricing.calculatedPrice, "IDR")}</dd></>}
      {pricing.costPrice !== null && <><dt>Estimasi laba</dt><dd className="text-right tabular-nums">{pricing.grossProfit === null ? "—" : formatCurrencyDisplay(pricing.grossProfit, "IDR")}</dd><dt>Estimasi margin</dt><dd className="text-right"><PricingMargin pricing={pricing} className="text-sm" /></dd></>}
    </dl>
    <p className="text-xs text-ink-soft">Berdasarkan harga tersimpan, sebelum biaya/diskon. Perubahan draft dihitung saat disimpan.</p>
    {pricing.source === "manual_no_cost" && <p className="text-xs text-ink-soft">Menunggu HPP: sync berikutnya mengisi HPP lalu menghitung harga dari aturan.</p>}
    {pricing.pendingReprice && <p className="text-xs text-ink-soft">Aturan baru belum diterapkan pada harga aktif. Gunakan sync atau Terapkan sekarang.</p>}
    {shownWarnings(pricing.warnings).map(w => <PricingWarning key={w} code={w} />)}
  </section>;
}
