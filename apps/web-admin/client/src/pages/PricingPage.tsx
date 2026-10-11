import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Decimal } from "decimal.js";
import { apiGet, apiPost, apiPut, apiDelete } from "../api/client";
import { exactFieldsOf } from "../lib/exactFields";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DataTable } from "../components/shared/DataTable";
import { SaveConfirmDialog } from "../components/shared/SaveConfirmDialog";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { formatCurrencyDisplay } from "../components/shared/CurrencyAmount";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

type RuleType = "none" | "percent" | "flat";
interface Category { id: number; name: string; group: string | null; markupType: "percent" | "flat" | null; markupValue: string | null; skuCount: number }
interface PricingData {
  isOwner: boolean;
  policy: { globalRule: { type: "percent" | "flat" | null; value: string } | null; globalRuleReadable: boolean; roundingReadable: boolean; rounding: string; lowMarginWarnPct: string | null };
  categories: Category[];
}
interface Form { markupType: RuleType; markupValue: string; rounding: string; lowMarginWarnPct: string }
interface PreviewRow { costPrice: string; effectivePrice: string; grossProfit: string | null; grossMarginPct: string | null }
interface Impact { eligibleCount: number; changedCount: number; sample: { denominationId: number; productName: string; name: string; oldPrice: string; newPrice: string }[] }
const ROUNDING = [{ value: "none", label: "Tanpa pembulatan tambahan" }, { value: "ceil_100", label: "Ke atas Rp100" }, { value: "ceil_500", label: "Ke atas Rp500" }, { value: "ceil_1000", label: "Ke atas Rp1.000" }];
const AMOUNTS = ["markupValue", "lowMarginWarnPct"] as const;
const money = (value: string) => formatCurrencyDisplay(value, "IDR");
export const marginDisplay = (value: string | null) => value === null ? "—" : `${new Decimal(value).toDecimalPlaces(2).toString()}%`;
function payload(form: Form, initial: Form | null) {
  return { ...form, markupType: form.markupType === "none" ? null : form.markupType,
    lowMarginWarnPct: form.lowMarginWarnPct || null,
    exact_fields: exactFieldsOf(form, initial, AMOUNTS).filter(key => key !== "markupValue" || initial?.markupType === form.markupType) };
}
function TypeSelect({ value, onChange, label, allowNone = true }: { value: string; onChange: (v: RuleType) => void; label: string; allowNone?: boolean }) {
  return <Select value={value} onValueChange={v => onChange(v as RuleType)}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectContent>
    {allowNone && <SelectItem value="none">Tanpa markup</SelectItem>}<SelectItem value="percent">Persentase (%)</SelectItem><SelectItem value="flat">Nominal tetap (IDR)</SelectItem>
  </SelectContent></Select>;
}

export function PricingPage() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["pricing"], queryFn: () => apiGet<PricingData>("/api/pricing") });
  const [form, setForm] = useState<Form>({ markupType: "none", markupValue: "0", rounding: "none", lowMarginWarnPct: "" });
  const [initial, setInitial] = useState<Form | null>(null);
  const [sample, setSample] = useState("100000");
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const sequence = useRef(0);
  const [saveOpen, setSaveOpen] = useState(false);
  const [editCategory, setEditCategory] = useState<Category | null>(null);
  const [categoryType, setCategoryType] = useState<RuleType>("percent");
  const [categoryValue, setCategoryValue] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [categorySaving, setCategorySaving] = useState(false);
  const [remove, setRemove] = useState<Category | null>(null);
  const [scope, setScope] = useState("all");
  const [impact, setImpact] = useState<Impact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const owner = query.data?.isOwner === true;
  useEffect(() => {
    if (!query.data || initial) return;
    const p = query.data.policy;
    const next: Form = { markupType: p.globalRule?.type ?? "none", markupValue: p.globalRule?.value ?? "0", rounding: p.rounding, lowMarginWarnPct: p.lowMarginWarnPct ?? "" };
    setForm(next); setInitial(next);
  }, [query.data, initial]);
  useEffect(() => {
    const seq = ++sequence.current;
    const controller = new AbortController();
    setPreview(null); setPreviewError(null);
    if (!owner || !initial) return;
    setChecking(true);
    const timer = setTimeout(() => {
      void apiPost<{ rows: PreviewRow[] }>("/api/pricing/preview", { ...payload(form, initial), costs: [sample] }, { signal: controller.signal })
        .then(result => { if (sequence.current === seq) setPreview(result.rows); })
        .catch((e: Error) => { if (sequence.current === seq && !controller.signal.aborted) setPreviewError(e.message); })
        .finally(() => { if (sequence.current === seq) setChecking(false); });
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); sequence.current++; };
  }, [form, sample, initial, owner]);
  const dirty = initial !== null && (JSON.stringify(form) !== JSON.stringify(initial) || !query.data?.policy.globalRuleReadable || !query.data?.policy.roundingReadable);
  const reload = async () => { await qc.invalidateQueries({ queryKey: ["pricing"] }); await qc.invalidateQueries({ queryKey: ["catalog"] }); };
  async function saveGlobal() {
    await apiPost("/api/pricing/global", payload(form, initial));
    await reload(); setInitial(null); setNotice("Aturan disimpan. Harga berubah pada sync berikutnya atau setelah Terapkan sekarang.");
  }
  async function saveCategory() {
    if (!editCategory) return;
    setCategorySaving(true); setCategoryError(null);
    try {
      await apiPut(`/api/pricing/categories/${editCategory.id}`, { markupType: categoryType, markupValue: categoryValue,
        exact_fields: categoryType === editCategory.markupType && categoryValue === editCategory.markupValue ? ["markupValue"] : [] });
      setEditCategory(null); await reload(); setNotice("Aturan kategori disimpan. Terapkan sekarang atau tunggu sync berikutnya.");
    } catch (e) { setCategoryError((e as Error).message); } finally { setCategorySaving(false); }
  }
  return <PageLayout title="Pricing & Margins"><PageHeader title="Pricing & Margins" description="Atur markup Digiflazz, pembulatan, dan pantau estimasi margin." />
    {query.isPending ? <p role="status">Memuat kebijakan harga…</p> : query.error ? <Alert variant="destructive"><AlertDescription>{query.error.message}</AlertDescription></Alert> : <>
      <p className="mb-5 text-sm text-ink-soft">{query.data.categories.length} kategori · {query.data.categories.filter(c => c.markupType).length} aturan khusus. Perubahan berlaku pada sync berikutnya atau saat diterapkan.</p>
      {!owner && <Alert><AlertDescription>Akses baca saja. Hanya super-admin dapat mengubah harga.</AlertDescription></Alert>}
      {notice && <p role="status" className="mb-4 text-sm text-pine">{notice}</p>}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <nav aria-label="Pricing sections" className="mb-5 flex gap-5 overflow-x-auto text-sm text-pine"><a href="#global-pricing">Global Defaults</a><a href="#category-rules">Category Rules</a><a href="#apply-pricing">Terapkan harga</a></nav>
      <div className="space-y-6">
        <Card id="global-pricing"><CardHeader><CardTitle as="h2">Global Defaults</CardTitle><CardDescription>Aturan dasar untuk SKU Digiflazz yang mengikuti harga otomatis.</CardDescription></CardHeader>
          <CardContent><form className="space-y-5" onSubmit={e => { e.preventDefault(); setSaveOpen(true); }}>
            {(!query.data.policy.globalRuleReadable || !query.data.policy.roundingReadable) && <Alert variant="destructive"><AlertDescription>Kebijakan tersimpan tidak terbaca. Periksa dan simpan kembali sebelum menghitung harga.</AlertDescription></Alert>}
            <fieldset disabled={!owner} className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><label className="text-sm font-medium">Jenis markup</label><TypeSelect value={form.markupType} label="Jenis markup" onChange={v => setForm({ ...form, markupType: v, markupValue: "0" })} /></div>
              <div className="space-y-2"><label htmlFor="markup-value" className="text-sm font-medium">Markup {form.markupType === "flat" ? "(IDR)" : "(%)"}</label><Input id="markup-value" inputMode="decimal" disabled={form.markupType === "none"} value={form.markupValue} onChange={e => setForm({ ...form, markupValue: e.target.value })} /></div>
              <div className="space-y-2"><label className="text-sm font-medium">Pembulatan harga</label><Select value={form.rounding} onValueChange={v => setForm({ ...form, rounding: v })}><SelectTrigger aria-label="Pembulatan harga"><SelectValue /></SelectTrigger><SelectContent>{ROUNDING.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><label htmlFor="margin-warning" className="text-sm font-medium">Peringatan margin di bawah (%)</label><Input id="margin-warning" inputMode="decimal" placeholder="Kosong = nonaktif" value={form.lowMarginWarnPct} onChange={e => setForm({ ...form, lowMarginWarnPct: e.target.value })} /></div>
            </fieldset>
            {owner && <div className="border-t border-line pt-4 space-y-3"><label htmlFor="sample-cost" className="text-sm font-medium">Preview dari HPP contoh (IDR)</label><Input id="sample-cost" className="max-w-xs" inputMode="decimal" value={sample} onChange={e => setSample(e.target.value)} />
              <div aria-live="polite">{checking && <p className="text-sm text-ink-soft">Menghitung preview…</p>}{previewError && <p role="alert" className="text-sm text-rust">{previewError}</p>}{preview?.map((r, i) => <div key={i} className="flex flex-wrap gap-x-8 gap-y-2"><div><p className="text-xs text-ink-soft">Harga hasil aturan</p><p className="text-xl font-semibold tabular-nums">{money(r.effectivePrice)}</p></div><div className="text-sm text-ink-soft"><p>Estimasi laba: {r.grossProfit === null ? "—" : money(r.grossProfit)}</p><p>Margin: {marginDisplay(r.grossMarginPct)} sebelum biaya/diskon</p></div></div>)}</div>
            </div>}
            <Button type="submit" disabled={!owner || !dirty || checking || !preview || !!previewError}>Simpan default</Button>
          </form></CardContent></Card>
        <Card id="category-rules"><CardHeader><CardTitle as="h2">Category Rules</CardTitle><CardDescription>Aturan kategori menggantikan default global. Harga SKU manual tetap dipertahankan.</CardDescription></CardHeader><CardContent>
          <DataTable nested data={query.data.categories} keyExtractor={c => c.id} columns={[
            { key: "name", header: "Kategori", render: c => <div>{c.name}<p className="text-xs text-ink-soft">{c.group === "GAME_TOPUP" ? "Game Top Up" : "Premium Apps"} · {c.skuCount} SKU Digiflazz</p></div> },
            { key: "rule", header: "Aturan", render: c => <div className="space-y-1"><Badge variant="secondary">{c.markupType ? "Override" : "Inherited"}</Badge><p className="text-sm tabular-nums">{c.markupType === "percent" ? `${c.markupValue}%` : c.markupType === "flat" ? money(c.markupValue!) : "Default global"}</p></div> },
            { key: "actions", header: "", render: c => owner && c.group === "GAME_TOPUP" ? <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => { setEditCategory(c); setCategoryType(c.markupType ?? "percent"); setCategoryValue(c.markupValue ?? "0"); setCategoryError(null); }}>Edit<span className="sr-only"> {c.name}</span></Button>{c.markupType && <Button variant="ghost" size="sm" onClick={() => setRemove(c)}>Hapus<span className="sr-only"> aturan {c.name}</span></Button>}</div> : <span className="text-xs text-ink-soft">{c.group !== "GAME_TOPUP" ? "Harga manual" : "Baca saja"}</span> },
          ]} />
        </CardContent></Card>
        <Card id="apply-pricing"><CardHeader><CardTitle as="h2">Terapkan harga sekarang</CardTitle><CardDescription>Lihat dampaknya sebelum memperbarui SKU otomatis. SKU manual dan riwayat pesanan tetap dipertahankan.</CardDescription></CardHeader><CardContent className="space-y-4">
          <Select value={scope} onValueChange={v => { setScope(v); setImpact(null); }} disabled={!owner}><SelectTrigger className="sm:max-w-sm" aria-label="Cakupan harga"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Semua SKU otomatis</SelectItem>{query.data.categories.filter(c => c.group === "GAME_TOPUP").map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent></Select>
          <Button disabled={!owner || impactLoading || dirty} onClick={() => { setError(null); setImpactLoading(true); void apiPost<Impact>("/api/pricing/reprice/preview", { scope: scope === "all" ? "all" : Number(scope) }).then(setImpact).catch((e: Error) => setError(e.message)).finally(() => setImpactLoading(false)); }}>{impactLoading ? "Memeriksa dampak…" : "Lihat dampak & terapkan"}</Button>
          {dirty && <p className="text-xs text-ink-soft">Simpan perubahan default terlebih dahulu.</p>}
        </CardContent></Card>
        <p className="text-xs leading-relaxed text-ink-soft">Prioritas: harga SKU manual → aturan kategori → default global. Markup dihitung terhadap HPP; margin dihitung terhadap harga jual. Estimasi laba belum memperhitungkan biaya, diskon, atau refund. Premium Apps menggunakan harga manual.</p>
      </div>
    </>}
    <SaveConfirmDialog open={saveOpen} onOpenChange={setSaveOpen} title="Simpan default harga?" description="Harga aktif berubah pada sync berikutnya atau saat Anda menerapkan aturan." onConfirm={saveGlobal} />
    <Dialog open={!!editCategory} onOpenChange={v => { if (!v && !categorySaving) setEditCategory(null); }}><DialogContent><DialogHeader><DialogTitle>Aturan {editCategory?.name}</DialogTitle><DialogDescription>Menggantikan markup global untuk kategori ini.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={e => { e.preventDefault(); void saveCategory(); }}>
      <TypeSelect value={categoryType} label="Jenis markup kategori" allowNone={false} onChange={v => { setCategoryType(v); setCategoryValue("0"); }} /><label htmlFor="category-markup">Markup {categoryType === "flat" ? "(IDR)" : "(%)"}</label><Input id="category-markup" value={categoryValue} onChange={e => setCategoryValue(e.target.value)} inputMode="decimal" />
      {categoryError && <p role="alert" className="text-sm text-rust">{categoryError}</p>}<Button type="submit" disabled={categorySaving || !categoryValue.trim()}>Simpan aturan</Button>
    </form></DialogContent></Dialog>
    <ConfirmDialog open={!!remove} onOpenChange={v => { if (!v) setRemove(null); }} title="Hapus aturan kategori?" description="Kategori kembali mengikuti default global pada sync atau penerapan berikutnya." onConfirm={async () => { if (!remove) return; try { await apiDelete(`/api/pricing/categories/${remove.id}`); await reload(); } catch (e) { setError((e as Error).message); } }} />
    <SaveConfirmDialog open={!!impact} onOpenChange={v => { if (!v) setImpact(null); }} title="Terapkan aturan tersimpan sekarang?" confirmLabel="Terapkan sekarang" description={<span className="block space-y-3"><span className="block">{impact?.changedCount} dari {impact?.eligibleCount} SKU otomatis berubah. Dampak diperiksa ulang saat diterapkan.</span><span className="block space-y-2">{impact?.sample.map(r => <span key={r.denominationId} className="block text-sm"><span>{r.productName} · {r.name}</span><span className="block text-right tabular-nums">{money(r.oldPrice)} → {money(r.newPrice)}</span></span>)}</span></span>} onConfirm={async () => { const result = await apiPost<{ updatedCount: number }>("/api/pricing/reprice/apply", { scope: scope === "all" ? "all" : Number(scope) }); await reload(); return `${result.updatedCount} SKU diperbarui.`; }} />
  </PageLayout>;
}
