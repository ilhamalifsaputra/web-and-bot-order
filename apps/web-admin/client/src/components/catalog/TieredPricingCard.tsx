import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LinesSkeleton } from "../shared/LoadingRegion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Decimal from "decimal.js";
import { AlertTriangle, Plus, Save, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { apiGet, apiPut } from "../../api/client";
import { describeError } from "../../lib/errorMessages";
import {
  blankDraft,
  draftsFromTiers,
  simulate,
  tierPayload,
  tiersOfDrafts,
  tierUnitPrice,
  validateDrafts,
  type TierDraft,
  type TierRowErrors,
  type TierState,
} from "../../lib/tierDraft";
import { analyzeTiers, type PricingTier, type TierDiscountType } from "../../lib/tierPricing";
import { SettingsToggle } from "../shared/SettingsToggle";
import { formatCurrencyDisplay } from "../shared/CurrencyAmount.helpers";

/**
 * Volume ("tiered") pricing for one SKU: the on/off toggle, the tier rows, a purchase simulator and the
 * non-blocking warnings. Shared by both product families, so only the unit noun changes: Game Top Up counts
 * items, Premium Apps count packages (never a game term on a Premium SKU).
 */
export interface TieredPricingCardProps {
  denominationId: number;
  /** The product detail query (`["catalog", productId]`) carries a tier summary, so a save refreshes it. */
  productId: string | undefined;
  isGame: boolean;
}

const tierQueryKey = (denominationId: number) => ["catalog", "denomination", denominationId, "pricing-tiers"] as const;

const rp = (value: Decimal.Value) => formatCurrencyDisplay(new Decimal(value).toString(), "IDR");

function typeOptions(unit: string): { value: TierDiscountType; label: string }[] {
  return [
    { value: "PERCENTAGE", label: "Diskon persen (%)" },
    { value: "FIXED_AMOUNT_OFF_PER_UNIT", label: `Potongan per ${unit} (Rp)` },
    { value: "FIXED_UNIT_PRICE", label: `Harga tetap per ${unit} (Rp)` },
  ];
}

function valueLabel(type: TierDiscountType, unit: string): string {
  if (type === "PERCENTAGE") return "Diskon (%)";
  if (type === "FIXED_AMOUNT_OFF_PER_UNIT") return `Potongan per ${unit} (Rp)`;
  return `Harga per ${unit} (Rp)`;
}

export function TieredPricingCard({ denominationId, productId, isGame }: TieredPricingCardProps) {
  const { data, isError } = useQuery<TierState>({
    queryKey: tierQueryKey(denominationId),
    queryFn: () => apiGet<TierState>(`/api/catalog/denominations/${denominationId}/pricing-tiers`),
  });
  return (
    <Card aria-labelledby={`tiered-pricing-${denominationId}`}>
      <CardHeader>
        <CardTitle as="h2" id={`tiered-pricing-${denominationId}`}>Harga Bertingkat</CardTitle>
        <CardDescription>Harga per {isGame ? "item" : "paket"} turun otomatis saat pembeli membeli lebih banyak.</CardDescription>
      </CardHeader>
      <CardContent>
        {isError && <p className="text-sm text-rust">Gagal memuat harga bertingkat.</p>}
        {!isError && !data && <LinesSkeleton label="Memuat harga bertingkat" lines={3} />}
        {data && <TieredPricingEditor initial={data} denominationId={denominationId} productId={productId} unit={isGame ? "item" : "paket"} />}
      </CardContent>
    </Card>
  );
}

function TieredPricingEditor({ initial, denominationId, productId, unit }: {
  initial: TierState;
  denominationId: number;
  productId: string | undefined;
  unit: string;
}) {
  const qc = useQueryClient();
  const fieldId = useId();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [drafts, setDrafts] = useState<TierDraft[]>(() => draftsFromTiers(initial.tiers));
  const [saved, setSaved] = useState(() => JSON.stringify(tierPayload(initial.enabled, draftsFromTiers(initial.tiers))));
  const [justSaved, setJustSaved] = useState(false);
  const base = new Decimal(initial.base_unit_price);
  const cost = initial.cost_price === null ? null : new Decimal(initial.cost_price);

  const errors = validateDrafts(drafts);
  const valid = Object.keys(errors).length === 0;
  const tiers = valid ? tiersOfDrafts(drafts) : [];
  const payload = tierPayload(enabled, drafts);
  const dirty = JSON.stringify(payload) !== saved;

  const save = useMutation({
    mutationFn: () => apiPut<TierState>(`/api/catalog/denominations/${denominationId}/pricing-tiers`, payload),
    onSuccess: (state) => {
      const next = draftsFromTiers(state.tiers);
      qc.setQueryData(tierQueryKey(denominationId), state);
      // The product page's denomination stats show the tier summary and the legacy bulk rule.
      void qc.invalidateQueries({ queryKey: ["catalog", productId] });
      setDrafts(next);
      setEnabled(state.enabled);
      setSaved(JSON.stringify(tierPayload(state.enabled, next)));
      setJustSaved(true);
      toast.success("Harga bertingkat disimpan.");
    },
  });

  const edit = (key: string, patch: Partial<TierDraft>) => {
    setJustSaved(false);
    setDrafts((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingsToggle
        id={`${fieldId}-enabled`}
        label="Aktifkan harga bertingkat"
        description={enabled ? "Tier di bawah dipakai saat checkout." : "Tier disimpan tetapi belum dipakai; semua pembeli membayar harga dasar."}
        checked={enabled}
        onCheckedChange={(v) => { setJustSaved(false); setEnabled(v); }}
      />

      <div className="flex flex-col gap-3">
        <Card variant="nested" size="sm">
          <CardContent className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">Harga dasar</p>
              <p className="text-xs text-ink-soft">Mulai 1 {unit}, tanpa tier</p>
            </div>
            <p className="font-mono text-sm tabular-nums">{rp(base)} / {unit}</p>
          </CardContent>
        </Card>
        {drafts.map((d, index) => (
          <TierRow
            key={d.key}
            draft={d}
            position={index + 1}
            errors={errors[d.key]}
            base={base}
            unit={unit}
            onChange={(patch) => edit(d.key, patch)}
            onRemove={() => { setJustSaved(false); setDrafts((rows) => rows.filter((r) => r.key !== d.key)); }}
          />
        ))}
        <Button type="button" variant="outline" className="self-start" onClick={() => { setJustSaved(false); setDrafts((rows) => [...rows, blankDraft(rows)]); }}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Tambah tier
        </Button>
      </div>

      {valid && <TierWarnings base={base} cost={cost} tiers={tiers} unit={unit} />}
      <TierSimulator base={base} tiers={tiers} enabled={enabled} valid={valid} unit={unit} />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" pending={save.isPending} disabled={!valid || !dirty} onClick={() => save.mutate()}>
          <Save className="h-4 w-4" aria-hidden="true" />
          {save.isPending ? "Menyimpan…" : "Simpan harga bertingkat"}
        </Button>
        {!valid && <p className="text-sm text-rust">Perbaiki tier yang ditandai sebelum menyimpan.</p>}
        {save.isError && <p role="alert" className="text-sm text-rust">{describeError(save.error)}</p>}
        {justSaved && !dirty && <p role="status" className="text-xs text-ink-soft">Semua perubahan tersimpan.</p>}
      </div>
    </div>
  );
}

function TierRow({ draft, position, errors, base, unit, onChange, onRemove }: {
  draft: TierDraft;
  position: number;
  errors: TierRowErrors | undefined;
  base: Decimal;
  unit: string;
  onChange: (patch: Partial<TierDraft>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const tier: PricingTier | null = errors ? null : tiersOfDrafts([draft])[0]!;
  const unitPrice = tier ? tierUnitPrice(base, tier) : null;
  return (
    <Card variant="nested" size="sm" aria-label={`Tier ${position}`}>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-min`} className="block text-sm font-medium text-ink">Mulai dari ({unit})</label>
            <Input id={`${id}-min`} className="mt-1" inputMode="numeric" value={draft.minQuantity} aria-invalid={errors?.minQuantity ? true : undefined} onChange={(e) => onChange({ minQuantity: e.target.value })} />
            {errors?.minQuantity && <p className="mt-1 text-sm text-rust">{errors.minQuantity}</p>}
          </div>
          <div>
            <label htmlFor={`${id}-type`} className="block text-sm font-medium text-ink">Metode diskon</label>
            <Select value={draft.discountType} onValueChange={(v) => onChange({ discountType: v as TierDiscountType })}>
              <SelectTrigger id={`${id}-type`} className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {typeOptions(unit).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label htmlFor={`${id}-value`} className="block text-sm font-medium text-ink">{valueLabel(draft.discountType, unit)}</label>
            <Input id={`${id}-value`} className="mt-1" inputMode="decimal" value={draft.value} aria-invalid={errors?.value ? true : undefined} onChange={(e) => onChange({ value: e.target.value })} />
            {errors?.value && <p className="mt-1 text-sm text-rust">{errors.value}</p>}
          </div>
          <div>
            <p className="text-sm font-medium text-ink">Harga akhir per {unit}</p>
            <p className="mt-1 font-mono text-sm tabular-nums" data-testid="tier-unit-price">{unitPrice ? rp(unitPrice) : "—"}</p>
            {unitPrice && <TierSavingsHint base={base} unitPrice={unitPrice} unit={unit} />}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Switch id={`${id}-enabled`} checked={draft.isEnabled} onCheckedChange={(v) => onChange({ isEnabled: v })} />
            <label htmlFor={`${id}-enabled`} className="text-sm text-ink">Tier aktif</label>
          </div>
          <Button type="button" variant="ghost" size="sm" className="text-rust" aria-label={`Hapus tier ${position}`} onClick={onRemove}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Hapus
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TierSavingsHint({ base, unitPrice, unit }: { base: Decimal; unitPrice: Decimal; unit: string }) {
  if (!unitPrice.lessThan(base)) {
    return <p className="mt-1 text-xs text-ink-soft">Tidak lebih murah dari harga dasar, jadi tier ini tidak memberi diskon.</p>;
  }
  return <p className="mt-1 text-xs text-ink-soft">Hemat {rp(base.minus(unitPrice))} per {unit}</p>;
}

function TierWarnings({ base, cost, tiers, unit }: { base: Decimal; cost: Decimal | null; tiers: PricingTier[]; unit: string }) {
  const analysis = analyzeTiers({ effectiveUnit: base, costPrice: cost, tiers });
  const minOf = new Map(tiers.map((t) => [t.id, t.minQuantity]));
  return (
    <>
      {analysis.nonMonotonic.map((w) => (
        <Alert key={`nm-${w.fromQuantity}`} role="status" className="border-amberx/40 bg-amberx-tint text-ink">
          <AlertTriangle className="text-amberx" aria-hidden="true" />
          <AlertTitle>Total turun saat jumlah naik</AlertTitle>
          <AlertDescription className="text-ink">
            {w.fromQuantity} {unit} = {rp(w.fromTotal)}, tetapi {w.toQuantity} {unit} = {rp(w.toTotal)}. Pembeli membayar lebih murah dengan membeli lebih banyak. Tetap bisa disimpan.
          </AlertDescription>
        </Alert>
      ))}
      {analysis.belowCost.map((w) => (
        <Alert key={`bc-${w.tierId}`} role="status" className="border-amberx/40 bg-amberx-tint text-ink">
          <AlertTriangle className="text-amberx" aria-hidden="true" />
          <AlertTitle>Di bawah HPP</AlertTitle>
          <AlertDescription className="text-ink">
            Tier mulai {minOf.get(w.tierId)} {unit}: harga per {unit} {rp(w.finalUnit)} di bawah HPP {cost ? rp(cost) : ""}. Tetap bisa disimpan.
          </AlertDescription>
        </Alert>
      ))}
    </>
  );
}

function TierSimulator({ base, tiers, enabled, valid, unit }: { base: Decimal; tiers: PricingTier[]; enabled: boolean; valid: boolean; unit: string }) {
  const id = useId();
  const [quantity, setQuantity] = useState("5");
  const qty = /^\d{1,6}$/.test(quantity.trim()) && Number(quantity.trim()) >= 1 ? Number(quantity.trim()) : null;
  const result = qty !== null && valid ? simulate(base, qty, tiers, enabled) : null;
  return (
    <Card variant="nested" size="sm" aria-label="Simulasi pembelian">
      <CardContent className="flex flex-col gap-3">
        <div>
          <label htmlFor={`${id}-qty`} className="block text-sm font-medium text-ink">Simulasi: jumlah {unit}</label>
          <Input id={`${id}-qty`} className="mt-1 w-32" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          {qty === null && <p className="mt-1 text-sm text-rust">Isi jumlah bilangan bulat, paling sedikit 1.</p>}
          {!enabled && <p className="mt-1 text-xs text-ink-soft">Harga bertingkat nonaktif, jadi simulasi memakai harga dasar.</p>}
        </div>
        {result && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-soft">Tier diterapkan</dt>
            <dd className="text-right" data-testid="sim-tier">{result.appliedTier ? `Mulai ${result.appliedTier.minQuantity} ${unit}` : "Harga dasar"}</dd>
            <dt className="text-ink-soft">Harga per {unit}</dt>
            <dd className="text-right font-mono tabular-nums" data-testid="sim-unit">{rp(result.finalUnitPrice)}</dd>
            <dt className="text-ink-soft">Total</dt>
            <dd className="text-right font-mono tabular-nums" data-testid="sim-total">{rp(result.finalSubtotal)}</dd>
            <dt className="text-ink-soft">Hemat</dt>
            <dd className="text-right font-mono tabular-nums" data-testid="sim-savings">{rp(result.totalDiscount)}</dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
