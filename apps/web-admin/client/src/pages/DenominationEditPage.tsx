import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiGet, apiPatch } from "../api/client";
import type { AdditionalField, AdditionalFieldDraft } from "../api/types";
import { PricingSummary, type CatalogPricingInfo } from "../components/catalog/PricingSummary";
import { TieredPricingCard } from "../components/catalog/TieredPricingCard";
import { ConfirmDialog } from "../components/shared/ConfirmDialog";
import { DeliveryTypeSection } from "../components/shared/DeliveryTypeSection";
import { DenominationIdentityFields } from "../components/shared/DenominationIdentityFields";
import { PageHeader } from "../components/shared/PageHeader";
import { PageLayout } from "../components/shared/PageLayout";
import { draftsToFields, fieldToDraft, fieldsAreValid } from "../lib/additionalFields";
import { familyOfGroup } from "../lib/catalogFamily";
import { exactFieldsOf } from "../lib/exactFields";

const DENOMINATION_TYPES = [
  { value: "SHARED", label: "Shared" },
  { value: "PRIVATE", label: "Private" },
];

interface EditableDenomination {
  priceOverridden?: boolean;
  id: number;
  name: string;
  type: string;
  durationLabel: string;
  price: string;
  costPrice: string | null;
  resellerPrice: string | null;
  warrantyDays: number;
  description: string | null;
  sortOrder: number;
  deliveryType: string;
  additionalFields: string | null;
  autoDeliverySource: string | null;
  supplierSku: string | null;
  nicknameCheckGameCode: string | null;
  providerInputMapping?: string | null;
  /** Compact-button quantity (Task 8/14), e.g. 86 "Diamonds" — null until set. */
  qtyValue: number | null;
  qtyUnit: string | null;
}

/** Parses a denomination's stored additionalFields JSON into editable
 * drafts; returns [] on null/blank/invalid, same fallback shape as
 * @app/core/deliveryFields's parseAdditionalFields (not reused directly —
 * this client mirrors server-side shapes rather than depending on @app/core,
 * see api/types.ts's AdditionalField doc comment). */
function parseStoredAdditionalFields(json: string | null): AdditionalFieldDraft[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as AdditionalField[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(fieldToDraft);
  } catch {
    return [];
  }
}

interface ProductDetailForEdit {
  product: {
    id: number;
    name: string;
    /** `group` decides which Telegram button the denomination text lands on (Game Top Up vs Premium Apps). */
    category: { id: number; name: string; group?: string | null } | null;
    denominations: EditableDenomination[];
  };
  statsByDenom: Record<number, { pricing?: CatalogPricingInfo }>;
}

interface SiblingProduct {
  id: number;
  name: string;
  category: { id: number; name: string } | null;
}

interface CatalogListData {
  products: SiblingProduct[];
}

interface PriceFields {
  price: string;
  costPrice: string;
  resellerPrice: string;
}
const PRICE_FIELDS = ["price", "costPrice", "resellerPrice"] as const;

function isValidPrice(value: string): boolean {
  if (value.trim() === "") return false;
  return !Number.isNaN(Number(value.trim()));
}

function DenominationEditForm({ data }: { data: ProductDetailForEdit }) {
  const fieldId = useId();
  const { productId, denomId } = useParams<{ productId: string; denomId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const denomination = data?.product.denominations.find((d) => d.id === Number(denomId));
  const isGame = familyOfGroup(data?.product.category?.group) === "GAME_TOPUP";
  const pricing = data?.statsByDenom?.[Number(denomId)]?.pricing;
  const [autoConfirm, setAutoConfirm] = useState(false);

  const { data: catalogList } = useQuery<CatalogListData>({
    queryKey: ["catalog"],
    queryFn: async () => apiGet<CatalogListData>("/api/catalog"),
  });
  const siblingProducts = (catalogList?.products ?? []).filter(
    (p) => p.category?.id === data?.product.category?.id,
  );

  const { pricingMode, setPricingMode, name, setName, type, setType, durationLabel, setDurationLabel, price, setPrice, costPrice, setCostPrice, resellerPrice, setResellerPrice, warrantyDays, setWarrantyDays, description, setDescription, sortOrder, setSortOrder, moveToProductId, setMoveToProductId, deliveryType, setDeliveryType, additionalFields, setAdditionalFields, autoDeliverySource, setAutoDeliverySource, supplierSku, setSupplierSku, nicknameCheckGameCode, setNicknameCheckGameCode, providerInputMapping, setProviderInputMapping, qtyValue, setQtyValue, qtyUnit, setQtyUnit, error, setError, pricePrefill, initialPricingMode } = useDenominationDraft({ denomination: denomination!, pricing, productId });

  // Compact-button quantity (Task 8/14), e.g. 86 "Diamonds" — independent of
  // every other field on this form.

  // The server's own decimal strings this form was pre-filled with, so a save
  // can name the untouched ones in `exact_fields` (lib/exactFields.ts) and a
  // stored 100.123 is never re-read by shape as 100123.

  const save = useMutation({
    mutationFn: () =>
      apiPatch<{ id: number; name: string }>(`/api/catalog/denominations/${denomId}`, {
        name: name.trim(),
        type,
        durationLabel: durationLabel.trim(),
        ...(isGame && autoDeliverySource === "digiflazz" && deliveryType === "manual_with_info" &&
          // Compared with what this form LOADED, never with the live query data: a background
          // refetch after a sync must not turn an unrelated save into a pricing change (review I3).
          (pricingMode !== initialPricingMode || price !== pricePrefill.price || costPrice !== pricePrefill.costPrice)
          ? { pricingMode } : {}),
        price: price.trim(),
        ...(costPrice.trim() ? { costPrice: costPrice.trim() } : {}),
        ...(resellerPrice.trim() ? { resellerPrice: resellerPrice.trim() } : {}),
        exact_fields: [
          ...exactFieldsOf(
            { price: price.trim(), costPrice: costPrice.trim(), resellerPrice: resellerPrice.trim() },
            pricePrefill,
            PRICE_FIELDS,
          ),
          // Re-review N5: a cost that was EMPTY when the form loaded and is still
          // empty is untouched, not cleared; naming it (with no costPrice sent)
          // lets the server keep a cost the sync filled since. A cost the admin
          // blanked had a prefill, so it is not named and is still cleared.
          ...(pricePrefill.costPrice === "" && costPrice.trim() === "" ? ["costPrice"] : []),
        ],
        ...(warrantyDays.trim() ? { warrantyDays: Number(warrantyDays.trim()) } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(sortOrder.trim() ? { sortOrder: Number(sortOrder.trim()) } : {}),
        ...(moveToProductId && moveToProductId !== productId ? { productId: Number(moveToProductId) } : {}),
        deliveryType,
        ...(deliveryType === "manual_with_info" || (deliveryType === "auto" && additionalFields.length > 0)
          ? { additionalFields: draftsToFields(additionalFields) }
          : {}),
        ...(deliveryType === "manual_with_info" && autoDeliverySource
          ? { autoDeliverySource, supplierSku: supplierSku.trim() }
          : {}),
        nicknameCheckGameCode: isGame ? (nicknameCheckGameCode.trim() || null) : denomination?.nicknameCheckGameCode ?? null,
        providerInputMapping: isGame ? (providerInputMapping.trim() || null) : denomination?.providerInputMapping ?? null,
        qtyValue: isGame ? (qtyValue.trim() ? Number(qtyValue.trim()) : null) : denomination?.qtyValue ?? null,
        qtyUnit: isGame ? (qtyUnit.trim() || null) : denomination?.qtyUnit ?? null,
      }),
    onMutate: () => setError(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["catalog", productId] });
      const destinationProductId = moveToProductId && moveToProductId !== productId ? moveToProductId : productId;
      navigate(`/catalog/${destinationProductId}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const { canSubmit } = denominationSubmission({ name, type, durationLabel, price, deliveryType, additionalFields, autoDeliverySource, supplierSku });

  return (
    <PageLayout title="Edit Denomination">
      <PageHeader
        title="Edit Denomination"
        breadcrumb={[
          { label: "Catalog", href: "/catalog" },
          // F-007: was the hardcoded literal "Product" — now the real
          // product name (already loaded via the `["catalog", productId]`
          // query above), falling back to the product id while loading.
          { label: data?.product.name ?? `Product #${productId}`, href: `/catalog/${productId}` },
        ]}
      />

      <div className="max-w-lg flex flex-col gap-4">
        <DenominationIdentityFields fieldId={fieldId} isGame={isGame} productName={data?.product.name} name={name} setName={setName} durationLabel={durationLabel} setDurationLabel={setDurationLabel} qtyValue={qtyValue} setQtyValue={setQtyValue} qtyUnit={qtyUnit} setQtyUnit={setQtyUnit} type={type} setType={setType} />

        <DeliveryTypeSection
          isGame={isGame}
          deliveryType={deliveryType}
          onDeliveryTypeChange={setDeliveryType}
          additionalFields={additionalFields}
          onAdditionalFieldsChange={setAdditionalFields}
          autoDeliverySource={autoDeliverySource}
          onAutoDeliverySourceChange={setAutoDeliverySource}
          supplierSku={supplierSku}
          onSupplierSkuChange={setSupplierSku}
          nicknameCheckGameCode={nicknameCheckGameCode}
          providerInputMapping={providerInputMapping}
          onProviderInputMappingChange={setProviderInputMapping}
          onNicknameCheckGameCodeChange={setNicknameCheckGameCode}
        />

        {pricing && <PricingSummary pricing={pricing} />}
        <DenominationEditModeHarga isGame={isGame} autoDeliverySource={autoDeliverySource} deliveryType={deliveryType} fieldId={fieldId} pricingMode={pricingMode} setAutoConfirm={setAutoConfirm} setPricingMode={setPricingMode} costPrice={costPrice} />
        <ConfirmDialog open={autoConfirm} onOpenChange={setAutoConfirm} title="Gunakan harga otomatis?" description="Saat disimpan, harga manual akan diganti dengan hasil aturan terbaru dari HPP. Harga ditentukan kembali oleh server." variant="default" onConfirm={() => setPricingMode("auto")} />
        <div>
          <label htmlFor={`${fieldId}-price-idr-7`} className="text-sm font-medium text-ink">
            Price (IDR) <span className="text-rust">*</span>
          </label>
          <Input id={`${fieldId}-price-idr-7`} className="mt-1" placeholder="e.g. 15000" disabled={isGame && autoDeliverySource === "digiflazz" && deliveryType === "manual_with_info" && pricingMode === "auto"} value={price} onChange={(e) => setPrice(e.target.value)} />
          <p className="mt-1 text-xs text-ink-soft">Shown to customers.</p>
        </div>

        <div>
          <label htmlFor={`${fieldId}-cost-price-idr-8`} className="text-sm font-medium text-ink">Cost Price (IDR)</label>
          <Input id={`${fieldId}-cost-price-idr-8`} className="mt-1" placeholder="Optional" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} />
          <p className="mt-1 text-xs text-ink-soft">
            What you pay your supplier. For margin reports only — buyers never see this.
          </p>
        </div>

        <div>
          <label htmlFor={`${fieldId}-reseller-price-idr-9`} className="text-sm font-medium text-ink">Reseller Price (IDR)</label>
          <Input id={`${fieldId}-reseller-price-idr-9`} className="mt-1" placeholder="Optional" value={resellerPrice} onChange={(e) => setResellerPrice(e.target.value)} />
          <p className="mt-1 text-xs text-ink-soft">Charged instead of Price to reseller-role customers.</p>
        </div>

        <div>
          <label htmlFor={`${fieldId}-warranty-days-10`} className="block text-sm font-medium text-ink">Warranty Days</label>
          <Input id={`${fieldId}-warranty-days-10`} className="mt-1 w-32" placeholder="Optional" value={warrantyDays} onChange={(e) => setWarrantyDays(e.target.value)} />
        </div>

        <div>
          <label htmlFor={`${fieldId}-sort-order-11`} className="block text-sm font-medium text-ink">Sort Order</label>
          <Input id={`${fieldId}-sort-order-11`}
            className="mt-1 w-32"
            placeholder="0"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-soft">Lower numbers show first in the product detail list.</p>
        </div>

        <div>
          <label htmlFor={`${fieldId}-move-to-product-12`} className="text-sm font-medium text-ink">Move to Product</label>
          <Select value={moveToProductId ?? ""} onValueChange={(v) => setMoveToProductId(v)}>
            <SelectTrigger id={`${fieldId}-move-to-product-12`} className="mt-1">
              <SelectValue placeholder="Select product" />
            </SelectTrigger>
            <SelectContent>
              {siblingProducts.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-ink-soft">
            Only products in the same category can be selected.
          </p>
        </div>

        <div>
          <label htmlFor={`${fieldId}-description-13`} className="text-sm font-medium text-ink">Description</label>
          <Textarea id={`${fieldId}-description-13`} className="mt-1" rows={3} placeholder="Optional" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        {error && <p className="text-sm text-rust">{error}</p>}

        <Button disabled={!canSubmit || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save Changes"}
        </Button>

        <TieredPricingCard denominationId={Number(denomId)} productId={productId} isGame={isGame} />
      </div>
    </PageLayout>
  );
}

function DenominationEditModeHarga({ isGame, autoDeliverySource, deliveryType, fieldId, pricingMode, setAutoConfirm, setPricingMode, costPrice }: {
  isGame: boolean;
  autoDeliverySource: string | null;
  deliveryType: string;
  fieldId: string;
  pricingMode: "auto" | "manual";
  setAutoConfirm: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setPricingMode: import("react").Dispatch<import("react").SetStateAction<"auto" | "manual">>;
  costPrice: string;
}) {
  return (isGame && autoDeliverySource === "digiflazz" && deliveryType === "manual_with_info" && (
    <div className="space-y-2">
      <label htmlFor={`${fieldId}-mode-harga-6`} className="text-sm font-medium">Mode harga</label>
      <Select value={pricingMode} onValueChange={value => { if (value === "auto" && pricingMode === "manual") setAutoConfirm(true); else setPricingMode(value as "auto" | "manual"); }}>
        <SelectTrigger id={`${fieldId}-mode-harga-6`} aria-label="Mode harga"><SelectValue /></SelectTrigger>
        {/* With no HPP, "auto" cannot be newly chosen, but an automatic SKU still waiting for its
            first HPP keeps it selected and says so (visual review V2). */}
        <SelectContent><SelectItem value="auto" disabled={!costPrice.trim() && pricingMode !== "auto"}>{costPrice.trim() ? "Otomatis" : "Otomatis · menunggu HPP"}</SelectItem><SelectItem value="manual">Manual</SelectItem></SelectContent>
      </Select>
      <p className="text-xs text-ink-soft">Otomatis mengikuti HPP dan aturan kategori/global. Manual melindungi harga saat sync.</p>
    </div>
  ));
}

function denominationSubmission({ name, type, durationLabel, price, deliveryType, additionalFields, autoDeliverySource, supplierSku }: {
  name: string;
  type: string | null;
  durationLabel: string;
  price: string;
  deliveryType: string;
  additionalFields: AdditionalFieldDraft[];
  autoDeliverySource: string | null;
  supplierSku: string;
}) {
  const canSubmit =
    name.trim().length > 0 &&
    type !== null &&
    durationLabel.trim().length > 0 &&
    isValidPrice(price) &&
    ((deliveryType !== "manual_with_info" && additionalFields.length === 0) || fieldsAreValid(additionalFields)) &&
    (autoDeliverySource !== "digiflazz" || supplierSku.trim().length > 0);
  return { canSubmit };
}

function useDenominationDraft({ denomination, pricing, productId }: {
  denomination: EditableDenomination;
  pricing: CatalogPricingInfo | undefined;
  productId: string | undefined;
}) {
  // Keep the exact stored values from the first loaded render for untouched money fields.
  const [initial] = useState(() => ({ denomination, productId, pricing }));
  const [initialPricingMode] = useState<"auto" | "manual">(() => initial.pricing?.automaticAvailable && !initial.denomination.priceOverridden ? "auto" : "manual");
  const [pricingMode, setPricingMode] = useState<"auto" | "manual">(initialPricingMode);
  const [name, setName] = useState(() => (initial.denomination.name));
  const [type, setType] = useState<string | null>(() => (initial.denomination.type));
  const [durationLabel, setDurationLabel] = useState(() => (initial.denomination.durationLabel));
  const [price, setPrice] = useState(() => (initial.denomination.price));
  const [costPrice, setCostPrice] = useState(() => (initial.denomination.costPrice ?? ""));
  const [resellerPrice, setResellerPrice] = useState(() => (initial.denomination.resellerPrice ?? ""));
  const [warrantyDays, setWarrantyDays] = useState(() => (initial.denomination.warrantyDays ? String(initial.denomination.warrantyDays) : ""));
  const [description, setDescription] = useState(() => (initial.denomination.description ?? ""));
  const [sortOrder, setSortOrder] = useState(() => (String(initial.denomination.sortOrder ?? 0)));
  const [moveToProductId, setMoveToProductId] = useState<string | null>(() => (initial.productId ?? null));
  const [deliveryType, setDeliveryType] = useState(() => (initial.denomination.deliveryType || "auto"));
  const [additionalFields, setAdditionalFields] = useState<AdditionalFieldDraft[]>(() => (parseStoredAdditionalFields(initial.denomination.additionalFields)));
  const [autoDeliverySource, setAutoDeliverySource] = useState<string | null>(() => (initial.denomination.autoDeliverySource ?? null));
  const [supplierSku, setSupplierSku] = useState(() => (initial.denomination.supplierSku ?? ""));
  const [nicknameCheckGameCode, setNicknameCheckGameCode] = useState(() => (initial.denomination.nicknameCheckGameCode ?? ""));
  const [providerInputMapping, setProviderInputMapping] = useState(() => (initial.denomination.providerInputMapping ?? ""));
  const [qtyValue, setQtyValue] = useState(() => (initial.denomination.qtyValue != null ? String(initial.denomination.qtyValue) : ""));
  const [qtyUnit, setQtyUnit] = useState(() => (initial.denomination.qtyUnit ?? ""));
  const [error, setError] = useState<string | null>(null);
  const pricePrefill: PriceFields = { price: initial.denomination.price, costPrice: initial.denomination.costPrice ?? "", resellerPrice: initial.denomination.resellerPrice ?? "" };
  return { name, setName, type, setType, durationLabel, setDurationLabel, price, setPrice, costPrice, setCostPrice, resellerPrice, setResellerPrice, warrantyDays, setWarrantyDays, description, setDescription, sortOrder, setSortOrder, moveToProductId, setMoveToProductId, deliveryType, setDeliveryType, additionalFields, setAdditionalFields, autoDeliverySource, setAutoDeliverySource, supplierSku, setSupplierSku, nicknameCheckGameCode, setNicknameCheckGameCode, providerInputMapping, setProviderInputMapping, qtyValue, setQtyValue, qtyUnit, setQtyUnit, error, setError, pricePrefill, pricingMode, setPricingMode, initialPricingMode };
}

export function DenominationEditPage() {
  const { productId, denomId } = useParams<{ productId: string; denomId: string }>();
  const { data, isError } = useQuery<ProductDetailForEdit>({
    queryKey: ["catalog", productId],
    queryFn: async () => apiGet<ProductDetailForEdit>(`/api/catalog/${productId}`),
    enabled: !!productId,
  });
  if (isError) return <PageLayout title="Edit Denomination"><p className="text-sm text-rust">Failed to load denomination.</p></PageLayout>;
  if (!data?.product.denominations.some(d => d.id === Number(denomId))) return <PageLayout title="Edit Denomination"><p>Loading…</p></PageLayout>;
  return <DenominationEditForm key={denomId} data={data} />;
}
