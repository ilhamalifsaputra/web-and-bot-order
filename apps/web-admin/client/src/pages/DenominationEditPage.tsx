import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { PageLayout } from "../components/shared/PageLayout";
import { PageHeader } from "../components/shared/PageHeader";
import { DeliveryTypeSection } from "../components/shared/DeliveryTypeSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { apiGet, apiPatch, apiPost, apiDelete } from "../api/client";
import { draftsToFields, fieldToDraft, fieldsAreValid } from "../lib/additionalFields";
import type { AdditionalField, AdditionalFieldDraft } from "../api/types";

const DENOMINATION_TYPES = [
  { value: "SHARED", label: "Shared" },
  { value: "PRIVATE", label: "Private" },
];

interface EditableDenomination {
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

interface BulkPricingRule {
  minQuantity: number;
  discountPercent: string;
}

interface ProductDetailForEdit {
  product: {
    id: number;
    name: string;
    category: { id: number; name: string } | null;
    denominations: EditableDenomination[];
  };
  statsByDenom: Record<number, { rule: BulkPricingRule | null }>;
}

interface SiblingProduct {
  id: number;
  name: string;
  category: { id: number; name: string } | null;
}

interface CatalogListData {
  products: SiblingProduct[];
}

function isValidPrice(value: string): boolean {
  if (value.trim() === "") return false;
  return !Number.isNaN(Number(value.trim()));
}

export function DenominationEditPage() {
  const { productId, denomId } = useParams<{ productId: string; denomId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data, isError } = useQuery<ProductDetailForEdit>({
    queryKey: ["catalog", productId],
    queryFn: async () => apiGet<ProductDetailForEdit>(`/api/catalog/${productId}`),
    enabled: !!productId,
  });
  const denomination = data?.product.denominations.find((d) => d.id === Number(denomId));

  const { data: catalogList } = useQuery<CatalogListData>({
    queryKey: ["catalog"],
    queryFn: async () => apiGet<CatalogListData>("/api/catalog"),
  });
  const siblingProducts = (catalogList?.products ?? []).filter(
    (p) => p.category?.id === data?.product.category?.id,
  );

  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [durationLabel, setDurationLabel] = useState("");
  const [price, setPrice] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [resellerPrice, setResellerPrice] = useState("");
  const [warrantyDays, setWarrantyDays] = useState("");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState("");
  const [moveToProductId, setMoveToProductId] = useState<string | null>(null);
  const [deliveryType, setDeliveryType] = useState("auto");
  const [additionalFields, setAdditionalFields] = useState<AdditionalFieldDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [bulkMinQuantity, setBulkMinQuantity] = useState("");
  const [bulkDiscountPercent, setBulkDiscountPercent] = useState("");
  const [bulkError, setBulkError] = useState<string | null>(null);
  const existingRule = data?.statsByDenom?.[Number(denomId)]?.rule ?? null;

  useEffect(() => {
    if (loaded || !denomination) return;
    setName(denomination.name);
    setType(denomination.type);
    setDurationLabel(denomination.durationLabel);
    setPrice(denomination.price);
    setCostPrice(denomination.costPrice ?? "");
    setResellerPrice(denomination.resellerPrice ?? "");
    setWarrantyDays(denomination.warrantyDays ? String(denomination.warrantyDays) : "");
    setDescription(denomination.description ?? "");
    setSortOrder(String(denomination.sortOrder ?? 0));
    setMoveToProductId(productId ?? null);
    setDeliveryType(denomination.deliveryType || "auto");
    setAdditionalFields(parseStoredAdditionalFields(denomination.additionalFields));
    if (existingRule) {
      setBulkMinQuantity(String(existingRule.minQuantity));
      setBulkDiscountPercent(existingRule.discountPercent);
    }
    setLoaded(true);
  }, [denomination, loaded, existingRule]);

  const save = useMutation({
    mutationFn: () =>
      apiPatch<{ id: number; name: string }>(`/api/catalog/denominations/${denomId}`, {
        name: name.trim(),
        type,
        durationLabel: durationLabel.trim(),
        price: price.trim(),
        ...(costPrice.trim() ? { costPrice: costPrice.trim() } : {}),
        ...(resellerPrice.trim() ? { resellerPrice: resellerPrice.trim() } : {}),
        ...(warrantyDays.trim() ? { warrantyDays: Number(warrantyDays.trim()) } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(sortOrder.trim() ? { sortOrder: Number(sortOrder.trim()) } : {}),
        ...(moveToProductId && moveToProductId !== productId ? { productId: Number(moveToProductId) } : {}),
        deliveryType,
        ...(deliveryType === "manual_with_info"
          ? { additionalFields: draftsToFields(additionalFields) }
          : {}),
      }),
    onMutate: () => setError(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["catalog", productId] });
      const destinationProductId = moveToProductId && moveToProductId !== productId ? moveToProductId : productId;
      navigate(`/catalog/${destinationProductId}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const saveBulkPricing = useMutation({
    mutationFn: () =>
      apiPost(`/api/catalog/denominations/${denomId}/bulk-pricing`, {
        minQuantity: Number(bulkMinQuantity.trim()),
        discountPercent: bulkDiscountPercent.trim(),
      }),
    onMutate: () => setBulkError(null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["catalog", productId] }),
    onError: (e: Error) => setBulkError(e.message),
  });

  const removeBulkPricing = useMutation({
    mutationFn: () => apiDelete(`/api/catalog/denominations/${denomId}/bulk-pricing`),
    onMutate: () => setBulkError(null),
    onSuccess: () => {
      setBulkMinQuantity("");
      setBulkDiscountPercent("");
      void qc.invalidateQueries({ queryKey: ["catalog", productId] });
    },
    onError: (e: Error) => setBulkError(e.message),
  });

  const canSaveBulkPricing =
    Number.isInteger(Number(bulkMinQuantity.trim())) &&
    Number(bulkMinQuantity.trim()) >= 1 &&
    bulkDiscountPercent.trim() !== "" &&
    !Number.isNaN(Number(bulkDiscountPercent.trim()));

  const canSubmit =
    name.trim().length > 0 &&
    type !== null &&
    durationLabel.trim().length > 0 &&
    isValidPrice(price) &&
    (deliveryType !== "manual_with_info" || fieldsAreValid(additionalFields));

  if (isError) return <PageLayout title="Edit Denomination"><p className="text-sm text-rust">Failed to load denomination.</p></PageLayout>;
  if (!loaded) return <PageLayout title="Edit Denomination"><p>Loading…</p></PageLayout>;

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
        <div>
          <label className="text-sm font-medium text-ink">
            Name <span className="text-rust">*</span>
          </label>
          <Input className="mt-1" placeholder="e.g. Netflix Premium" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">
            Duration Label <span className="text-rust">*</span>
          </label>
          <Input className="mt-1" placeholder="e.g. 1 Month" value={durationLabel} onChange={(e) => setDurationLabel(e.target.value)} />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">
            Account Type <span className="text-rust">*</span>
          </label>
          <Select value={type ?? ""} onValueChange={(v) => setType(v)}>
            <SelectTrigger className="mt-1" aria-label="Account Type">
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
            <SelectContent>
              {DENOMINATION_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-ink-soft">
            Shared = one account used by multiple buyers at once. Private = a dedicated account for a
            single buyer.
          </p>
        </div>

        <DeliveryTypeSection
          deliveryType={deliveryType}
          onDeliveryTypeChange={setDeliveryType}
          additionalFields={additionalFields}
          onAdditionalFieldsChange={setAdditionalFields}
        />

        <div>
          <label className="text-sm font-medium text-ink">
            Price <span className="text-rust">*</span>
          </label>
          <Input className="mt-1" placeholder="e.g. 15000" value={price} onChange={(e) => setPrice(e.target.value)} />
          <p className="mt-1 text-xs text-ink-soft">Shown to customers.</p>
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Cost Price</label>
          <Input className="mt-1" placeholder="Optional" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} />
          <p className="mt-1 text-xs text-ink-soft">
            What you pay your supplier. For margin reports only — buyers never see this.
          </p>
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Reseller Price</label>
          <Input className="mt-1" placeholder="Optional" value={resellerPrice} onChange={(e) => setResellerPrice(e.target.value)} />
          <p className="mt-1 text-xs text-ink-soft">Charged instead of Price to reseller-role customers.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-ink">Warranty Days</label>
          <Input className="mt-1 w-32" placeholder="Optional" value={warrantyDays} onChange={(e) => setWarrantyDays(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm font-medium text-ink">Sort Order</label>
          <Input
            className="mt-1 w-32"
            placeholder="0"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-soft">Lower numbers show first in the product detail list.</p>
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Move to Product</label>
          <Select value={moveToProductId ?? ""} onValueChange={(v) => setMoveToProductId(v)}>
            <SelectTrigger className="mt-1">
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
          <label className="text-sm font-medium text-ink">Description</label>
          <Textarea className="mt-1" rows={3} placeholder="Optional" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        {error && <p className="text-sm text-rust">{error}</p>}

        <Button disabled={!canSubmit || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save Changes"}
        </Button>

        <div className="mt-4 border-t border-line pt-4">
          <h2 className="text-sm font-medium text-ink">Bulk Pricing</h2>
          <p className="mt-1 text-xs text-ink-soft">
            Give a quantity discount when a customer buys this denomination in bulk.
          </p>

          <div className="mt-3 flex items-end gap-3">
            <div>
              <label className="block text-sm font-medium text-ink">Min Quantity</label>
              <Input
                className="mt-1 w-28"
                placeholder="e.g. 5"
                value={bulkMinQuantity}
                onChange={(e) => setBulkMinQuantity(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink">Discount %</label>
              <Input
                className="mt-1 w-28"
                placeholder="e.g. 10"
                value={bulkDiscountPercent}
                onChange={(e) => setBulkDiscountPercent(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              disabled={!canSaveBulkPricing || saveBulkPricing.isPending}
              onClick={() => saveBulkPricing.mutate()}
            >
              {saveBulkPricing.isPending ? "Saving…" : existingRule ? "Update" : "Save"}
            </Button>
            {existingRule && (
              <Button
                variant="ghost"
                disabled={removeBulkPricing.isPending}
                onClick={() => removeBulkPricing.mutate()}
              >
                Remove
              </Button>
            )}
          </div>
          {bulkError && <p className="mt-2 text-sm text-rust">{bulkError}</p>}
        </div>
      </div>
    </PageLayout>
  );
}
