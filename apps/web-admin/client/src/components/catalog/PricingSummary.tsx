import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Decimal } from "decimal.js";
import { formatCurrencyDisplay } from "../shared/CurrencyAmount.helpers";

export interface CatalogPricingInfo {
  automaticAvailable: boolean;
  source: "manual_sku" | "manual_no_cost" | "category_rule" | "global_default";
  calculatedPrice: string | null;
  effectivePrice: string;
  costPrice: string | null;
  grossProfit: string | null;
  grossMarginPct: string | null;
  warnings: string[];
  pendingReprice: boolean;
}
const SOURCES = { manual_sku: "Manual", manual_no_cost: "Manual", category_rule: "Category", global_default: "Global" };
export function PricingSourceBadge({ pricing }: { pricing: CatalogPricingInfo }) {
  return <Badge variant="secondary">{SOURCES[pricing.source]}</Badge>;
}
export function PricingMargin({ pricing }: { pricing: CatalogPricingInfo }) {
  return <span className="text-xs tabular-nums text-ink-soft">{pricing.costPrice === null ? "HPP belum tersedia" : pricing.grossMarginPct === null ? "—" : `${new Decimal(pricing.grossMarginPct).toDecimalPlaces(2).toString()}%`}</span>;
}
const WARNINGS: Record<string, string> = {
  below_cost: "Harga jual berada di bawah HPP.", low_margin: "Margin berada di bawah batas peringatan.",
  unreadable_policy: "Kebijakan harga tidak terbaca. Periksa Pricing & Margins.",
};
export function PricingSummary({ pricing }: { pricing: CatalogPricingInfo }) {
  return <section aria-label="Ringkasan harga" className="space-y-3 border-t border-line pt-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs text-ink-soft">Harga jual aktif</p><p className="text-xl font-semibold tabular-nums">{formatCurrencyDisplay(pricing.effectivePrice, "IDR")}</p></div><PricingSourceBadge pricing={pricing} /></div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-ink-soft">
      <dt>HPP</dt><dd className="text-right tabular-nums">{pricing.costPrice === null ? "HPP belum tersedia" : formatCurrencyDisplay(pricing.costPrice, "IDR")}</dd>
      {pricing.automaticAvailable && <><dt>Harga hasil aturan</dt><dd className="text-right tabular-nums">{pricing.calculatedPrice === null ? "Belum tersedia" : formatCurrencyDisplay(pricing.calculatedPrice, "IDR")}</dd></>}
      {pricing.costPrice !== null && <><dt>Estimasi laba</dt><dd className="text-right tabular-nums">{pricing.grossProfit === null ? "—" : formatCurrencyDisplay(pricing.grossProfit, "IDR")}</dd><dt>Estimasi margin</dt><dd className="text-right"><PricingMargin pricing={pricing} /></dd></>}
    </dl>
    <p className="text-xs text-ink-soft">Berdasarkan harga tersimpan, sebelum biaya/diskon. Perubahan draft dihitung saat disimpan.</p>
    {pricing.pendingReprice && <p className="text-xs text-ink-soft">Aturan baru belum diterapkan pada harga aktif. Gunakan sync atau Terapkan sekarang.</p>}
    {pricing.warnings.filter(w => WARNINGS[w]).map(w => <Alert key={w}><AlertDescription>{WARNINGS[w]}</AlertDescription></Alert>)}
  </section>;
}
